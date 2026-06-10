// ─────────────────────────────────────────────────────────────────────────────
// Gess AI search engine — Rust port of the bitboard search in gess-engine.ts.
//
// This is a *faithful* re-implementation of the TypeScript search hot path:
// bitboards, move generation (genMoves), make/unmake, incremental evaluation,
// and iterative-deepening negamax with alpha-beta. Iteration order, the stable
// sort key, the eval formula, the mate-distance scoring and the random
// tie-break all match the TS engine exactly, so it produces identical results.
//
// ABI: hand-written and numeric (no wasm-bindgen) so the same .wasm loads
// identically in a browser worker and in the Node verification harness. The
// caller writes the board into the BOARD buffer (400 bytes, row-major, one byte
// per cell: 0 = empty, 1 = white, 2 = black), calls an exported function, and
// reads results back from the OUT buffer (i32 words). Two host functions are
// imported from "env": now() (ms wall-clock, for the deadline) and random()
// (uniform [0,1), for tie-breaking) — matching Date.now() / Math.random().
// ─────────────────────────────────────────────────────────────────────────────

use core::sync::atomic::{AtomicU64, AtomicU32, AtomicBool, Ordering};

#[link(wasm_import_module = "env")]
extern "C" {
    fn now() -> f64;
    fn random() -> f64;
}

// ─── Threading ───────────────────────────────────────────────────────────────
// Parallel search is Lazy SMP: up to MAX_THREADS workers each run the iterative-
// deepening negamax on the same root over ONE shared linear memory, sharing the
// transposition table. Each worker is identified by a thread id (0 = the "main"
// worker that owns the result; 1.. = helpers that only warm the TT) and uses its
// own slice of the per-thread scratch arrays below, so nothing but the TT (and
// the read-only board) is actually shared between them.
const MAX_THREADS: usize = 16;
// Per-thread move scratch ("bump arena"). The search hot path is allocation-free
// — helpers must never touch the global allocator, whose state lives in the same
// shared memory and is exercised only by the main worker's driver code. A single
// node never approaches this; the deepest root→leaf path's summed move count is
// the real high-water mark, comfortably under 32768.
const ARENA_MOVES: usize = 1 << 15;
// Per-thread shadow stack. Each helper relocates __stack_pointer into its own
// region (the default stack belongs to the main worker). 512 KiB ≫ the ~30 KiB
// the bounded-depth recursion actually uses.
const STACK_BYTES: usize = 512 * 1024;

// ─── Constants (mirror gess-engine.ts) ──────────────────────────────────────
const SIZE: i32 = 20;
const MIN: i32 = 1;
const MAX: i32 = 18;
// A ring CENTRE can only sit in rows 2..17: its 3×3 needs 8 stone neighbours, but
// rows 1/18 would require neighbours in the border rows 0/19, which are always empty
// (stones landing there are removed). So row_ring_mask is provably 0 at rows 1/18 —
// ring scans skip them. (Stone scans still use MIN..MAX; stones do live in rows 1/18.)
const RING_LO: i32 = MIN + 1; // 2
const RING_HI: i32 = MAX - 1; // 17
const WIN_SCORE: i32 = 1_000_000;
const MAX_DEPTH: i32 = 64;
const PLAY_MASK: u32 = 0x7FFFE; // columns 1..18

// Stand-in for ±Infinity. All real scores are within ±WIN_SCORE (1e6), far
// inside 2e9, so comparisons and negation behave exactly like the JS doubles.
const NEG_INF: i32 = -2_000_000_000;

// [dr, dc] for each of the 8 footprint positions relative to center, same order
// as DIRS in the TS engine (this order, with the stable sort, fixes move order).
const DIRS: [(i32, i32); 8] = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1), (1, 0), (1, 1),
];

// COL3[c] = mask of columns {c-1, c, c+1} clamped to [0,19].
const COL3: [u32; 20] = {
    let mut t = [0u32; 20];
    let mut c = 0usize;
    while c < 20 {
        let mut m = 1u32 << c;
        if c > 0 { m |= 1u32 << (c - 1); }
        if c < 19 { m |= 1u32 << (c + 1); }
        t[c] = m;
        c += 1;
    }
    t
};

// ─── I/O buffers (static, addresses exposed to the host) ─────────────────────
static mut BOARD: [i8; 400] = [0; 400];
static mut OUT: [i32; 65536] = [0; 65536];

#[no_mangle]
pub extern "C" fn board_ptr() -> i32 {
    core::ptr::addr_of!(BOARD) as i32
}

#[no_mangle]
pub extern "C" fn out_ptr() -> i32 {
    core::ptr::addr_of!(OUT) as i32
}

#[inline]
fn out_set(i: usize, v: i32) {
    unsafe {
        let p = core::ptr::addr_of_mut!(OUT) as *mut i32;
        *p.add(i) = v;
    }
}

fn read_board() -> ([u32; 20], [u32; 20]) {
    let mut w = [0u32; 20];
    let mut b = [0u32; 20];
    let base = core::ptr::addr_of!(BOARD) as *const i8;
    for r in 0..20usize {
        for c in 0..20usize {
            let v = unsafe { *base.add(r * 20 + c) };
            if v == 1 { w[r] |= 1u32 << c; }
            else if v == 2 { b[r] |= 1u32 << c; }
        }
    }
    (w, b)
}

// ─── Ring / stone / depth primitives ─────────────────────────────────────────
// r is always in MIN..=MAX here, so r-1 and r+1 are in 0..=19.
#[inline]
fn row_ring_mask_w(w: &[u32; 20], b: &[u32; 20], r: usize) -> u32 {
    let wu = w[r - 1];
    let wm = w[r];
    let wd = w[r + 1];
    let empty = !(w[r] | b[r]);
    (wu & (wu << 1) & (wu >> 1))
        & ((wm << 1) & (wm >> 1))
        & (wd & (wd << 1) & (wd >> 1))
        & empty
        & PLAY_MASK
}

#[inline]
fn row_ring_mask_b(w: &[u32; 20], b: &[u32; 20], r: usize) -> u32 {
    let bu = b[r - 1];
    let bm = b[r];
    let bd = b[r + 1];
    let empty = !(w[r] | b[r]);
    (bu & (bu << 1) & (bu >> 1))
        & ((bm << 1) & (bm >> 1))
        & (bd & (bd << 1) & (bd >> 1))
        & empty
        & PLAY_MASK
}

// Weighted ring count for one row, in tenths of a ring. A ring counts 1.0 (=10)
// normally, but only 0.7 (=7) when another ring shares its row two files to the
// left — midpoint at column c-2. In bit terms `m & (m << 2)` selects each ring
// that has a ring two columns lower, so the total is 10·(rings) − 3·(such rings).
#[inline]
fn ring_weight(m: u32) -> i32 {
    10 * m.count_ones() as i32 - 3 * (m & (m << 2)).count_ones() as i32
}

#[inline]
fn row_ring_w(w: &[u32; 20], b: &[u32; 20], r: usize) -> i32 {
    ring_weight(row_ring_mask_w(w, b, r))
}

#[inline]
fn row_ring_b(w: &[u32; 20], b: &[u32; 20], r: usize) -> i32 {
    ring_weight(row_ring_mask_b(w, b, r))
}

// Cheap ring-safety heuristic — see gess-engine.ts (ringSafety) for the rationale.
// pW = black stones in the 5×5 box around white's ring centres, pB = white
// stones around black's. A static nudge kept well below a stone (tune via this).
const RING_SAFETY_K: i32 = 10;

fn ring_pressure(w: &[u32; 20], b: &[u32; 20]) -> (i32, i32) {
    let mut pw = 0;
    let mut pb = 0;
    let mut r = RING_LO;
    while r <= RING_HI {
        let ri = r as usize;
        let mw = row_ring_mask_w(w, b, ri);
        if mw != 0 {
            let band = mw | (mw << 1) | (mw >> 1) | (mw << 2) | (mw >> 2);
            let mut rr = r - 2;
            while rr <= r + 2 {
                if rr >= 0 && rr < SIZE { pw += (b[rr as usize] & band).count_ones() as i32; }
                rr += 1;
            }
        }
        let mb = row_ring_mask_b(w, b, ri);
        if mb != 0 {
            let band = mb | (mb << 1) | (mb >> 1) | (mb << 2) | (mb >> 2);
            let mut rr = r - 2;
            while rr <= r + 2 {
                if rr >= 0 && rr < SIZE { pb += (w[rr as usize] & band).count_ones() as i32; }
                rr += 1;
            }
        }
        r += 1;
    }
    (pw, pb)
}

#[inline]
fn ring_safety(w: &[u32; 20], b: &[u32; 20], white: bool) -> i32 {
    let (pw, pb) = ring_pressure(w, b);
    RING_SAFETY_K * (if white { pb - pw } else { pw - pb })
}

/// Fused leaf evaluation: the full static eval + ring_safety in a single pass,
/// computing each row's ring masks ONCE (the separate `eval_of(&analyze_fill())
/// + ring_safety()` computes them twice — once for the counts, once for the
/// pressure bands). Byte-identical to that expression; used at the search leaves
/// where it dominates the per-node cost.
fn eval_and_safety(w: &[u32; 20], b: &[u32; 20], white: bool) -> i32 {
    let (mut wr, mut br, mut ws, mut bs) = (0i32, 0i32, 0i32, 0i32);
    let (mut pw, mut pb) = (0i32, 0i32);
    let mut r = MIN;
    while r <= MAX {
        let ri = r as usize;
        let mw = row_ring_mask_w(w, b, ri);
        let mb = row_ring_mask_b(w, b, ri);
        wr += ring_weight(mw);
        br += ring_weight(mb);
        ws += (w[ri] & PLAY_MASK).count_ones() as i32;
        bs += (b[ri] & PLAY_MASK).count_ones() as i32;
        if mw != 0 {
            let band = mw | (mw << 1) | (mw >> 1) | (mw << 2) | (mw >> 2);
            let mut rr = r - 2;
            while rr <= r + 2 {
                if rr >= 0 && rr < SIZE { pw += (b[rr as usize] & band).count_ones() as i32; }
                rr += 1;
            }
        }
        if mb != 0 {
            let band = mb | (mb << 1) | (mb >> 1) | (mb << 2) | (mb >> 2);
            let mut rr = r - 2;
            while rr <= r + 2 {
                if rr >= 0 && rr < SIZE { pb += (w[rr as usize] & band).count_ones() as i32; }
                rr += 1;
            }
        }
        r += 1;
    }
    let counts = Counts { wr, br, ws, bs, wdeep: white_deepest(w), bdeep: black_deepest(b) };
    eval_of(&counts, white) + RING_SAFETY_K * (if white { pb - pw } else { pw - pb })
}

fn white_deepest(w: &[u32; 20]) -> i32 {
    let mut r = MAX;
    while r >= MIN {
        if w[r as usize] & PLAY_MASK != 0 { return r - 1; }
        r -= 1;
    }
    0
}

fn black_deepest(b: &[u32; 20]) -> i32 {
    let mut r = MIN;
    while r <= MAX {
        if b[r as usize] & PLAY_MASK != 0 { return MAX - r; }
        r += 1;
    }
    0
}

#[derive(Clone, Copy)]
struct Counts {
    wr: i32, br: i32, ws: i32, bs: i32, wdeep: i32, bdeep: i32,
}

#[inline]
fn eval_of(a: &Counts, white: bool) -> i32 {
    let (myr, opr) = if white { (a.wr, a.br) } else { (a.br, a.wr) };
    let (mys, ops) = if white { (a.ws, a.bs) } else { (a.bs, a.ws) };
    let (myd, opd) = if white { (a.wdeep, a.bdeep) } else { (a.bdeep, a.wdeep) };
    // Ring counts are in tenths of a ring (see ring_weight), so the ring term is
    // ×7×100/10 = ×70; stone and deepest terms are unchanged.
    100 * (mys - ops) + 70 * (myr - opr) + (myd - opd)
}

// ─── Transposition table (Zobrist, lockless, shared across threads) ──────────
// A fail-soft TT keyed by a 64-bit Zobrist hash of (stones, side-to-move). It is
// shared by every Lazy-SMP worker over the one linear memory, so access must be
// race-free *and* value-correct without a lock on the hot path.
//
// Lockless scheme (Hyatt's XOR trick): each slot is two atomic 64-bit words —
//   TT_DATA = packed(val:32, depth:8, flag:2, gen:16)
//   TT_LOCK = key XOR TT_DATA
// A probe recomputes key = TT_LOCK ^ TT_DATA; if it doesn't match the wanted key
// the pair was either a different position or torn by a concurrent writer — in
// both cases we treat it as a miss and re-search, which is always correct. So a
// data race can only ever cost a re-computation, never a wrong value. Relaxed
// ordering suffices (only the self-consistency of the pair matters).
//
// Soundness (unchanged from the single-thread TT):
//  • Mate-range values are never stored (they depend on ply).
//  • A generation counter invalidates the whole table per top-level search
//    without clearing it. The generation is set once by the main worker in
//    begin_search() before any helper starts, so it is constant during a search.
//  • Move ordering is NOT taken from the TT, so the only effect is to cut
//    subtrees — a correct TT preserves the exact minimax value, and the verified
//    TT-off path stays the source of truth.
const TT_BITS: usize = 19;
const TT_SIZE: usize = 1 << TT_BITS;
const TT_MASK: u64 = (TT_SIZE as u64) - 1;
const TF_EXACT: u8 = 0;
const TF_LOWER: u8 = 1;
const TF_UPPER: u8 = 2;

static TT_DATA: [AtomicU64; TT_SIZE] = [const { AtomicU64::new(0) }; TT_SIZE];
static TT_LOCK: [AtomicU64; TT_SIZE] = [const { AtomicU64::new(0) }; TT_SIZE];
// Best move per slot, packed (from_r|from_c<<5|to_r<<10|to_c<<15), for move
// ordering — tried first at a node to sharpen alpha-beta cutoffs (this, shared
// across threads, is what makes Lazy SMP actually speed the search up). NOT part
// of the XOR-validated pair: a torn/aliased read just yields a move that isn't in
// this node's generated list, so it's ignored — it can never be played illegally.
// 0 = none (from==to never happens for a real move, so 0 is a safe sentinel).
static TT_MOVE: [AtomicU32; TT_SIZE] = [const { AtomicU32::new(0) }; TT_SIZE];
static CUR_GEN: AtomicU32 = AtomicU32::new(0);

// Set by every worker's negamax when the main worker calls stop_search() (e.g. a
// forced mate was found before the deadline), so helpers unwind promptly.
static STOP: AtomicU32 = AtomicU32::new(0);

static mut ZOB_W: [u64; 400] = [0; 400];
static mut ZOB_B: [u64; 400] = [0; 400];
static mut ZOB_SIDE: u64 = 0;
static ZINIT: AtomicBool = AtomicBool::new(false);

#[inline]
fn pack_entry(val: i32, depth: i32, flag: u8, gen: u32) -> u64 {
    (val as u32 as u64)
        | (((depth as u64) & 0xFF) << 32)
        | (((flag as u64) & 0x3) << 40)
        | (((gen as u64) & 0xFFFF) << 42)
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn ensure_zobrist() {
    if ZINIT.load(Ordering::Acquire) { return; }
    unsafe {
        let mut s: u64 = 0x1234_5678_9ABC_DEF0;
        let zw = core::ptr::addr_of_mut!(ZOB_W) as *mut u64;
        for i in 0..400 { *zw.add(i) = splitmix64(&mut s); }
        let zb = core::ptr::addr_of_mut!(ZOB_B) as *mut u64;
        for i in 0..400 { *zb.add(i) = splitmix64(&mut s); }
        ZOB_SIDE = splitmix64(&mut s);
    }
    ZINIT.store(true, Ordering::Release);
}

/// Start a new search: bump the generation so all prior entries read as empty.
/// On a 16-bit wrap the table is cleared (rare — once per 65535 searches).
fn tt_new_search() {
    let g = CUR_GEN.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    if (g & 0xFFFF) == 0 {
        for i in 0..TT_SIZE {
            TT_DATA[i].store(0, Ordering::Relaxed);
            TT_LOCK[i].store(0, Ordering::Relaxed);
            TT_MOVE[i].store(0, Ordering::Relaxed);
        }
        CUR_GEN.store(1, Ordering::Relaxed);
    }
}

// Zobrist accessors for the incremental hash maintained on the search edges.
#[inline]
fn zob_cell(white: bool, idx: usize) -> u64 {
    unsafe {
        let base = if white { core::ptr::addr_of!(ZOB_W) } else { core::ptr::addr_of!(ZOB_B) } as *const u64;
        *base.add(idx)
    }
}
#[inline]
fn zob_side() -> u64 { unsafe { ZOB_SIDE } }

// Counts nodes where the incrementally-maintained hash disagreed with a fresh
// compute_hash — must stay 0. Only touched when an engine has hash_check set
// (the hash_check_run verification export); the production search never pays it.
static HASH_MISMATCH: AtomicU32 = AtomicU32::new(0);

// Witness-ring fast path for the per-node has_ring terminal check: each engine
// caches one known ring centre per colour and re-validates it in O(1), scanning
// only when it's gone. Default on; flip off (set_ring_track) for the full-scan A/B.
// RING_MISMATCH counts nodes where witness has_ring disagreed with a fresh scan
// (the ring_check_run verification export); must stay 0.
static RING_TRACK: AtomicBool = AtomicBool::new(true);
static RING_MISMATCH: AtomicU32 = AtomicU32::new(0);

fn compute_hash(w: &[u32; 20], b: &[u32; 20], white: bool) -> u64 {
    let mut h = 0u64;
    unsafe {
        let zw = core::ptr::addr_of!(ZOB_W) as *const u64;
        let zb = core::ptr::addr_of!(ZOB_B) as *const u64;
        for r in 0..20usize {
            let mut m = w[r];
            while m != 0 { let c = m.trailing_zeros() as usize; h ^= *zw.add(r * 20 + c); m &= m - 1; }
            let mut m = b[r];
            while m != 0 { let c = m.trailing_zeros() as usize; h ^= *zb.add(r * 20 + c); m &= m - 1; }
        }
        if white { h ^= ZOB_SIDE; }
    }
    h
}

// Probe result: the stored bound (for a possible cutoff when stored_depth is
// sufficient) plus the stored best move (for ordering, useful at any depth).
struct TtHit { val: i32, flag: u8, depth: i32, mv: u32 }

#[inline]
fn tt_probe(key: u64) -> Option<TtHit> {
    let idx = (key & TT_MASK) as usize;
    let data = TT_DATA[idx].load(Ordering::Relaxed);
    let lock = TT_LOCK[idx].load(Ordering::Relaxed);
    if (lock ^ data) != key { return None; }                 // empty, alias, or torn pair
    let gen = ((data >> 42) & 0xFFFF) as u32;
    if gen != (CUR_GEN.load(Ordering::Relaxed) & 0xFFFF) { return None; }
    Some(TtHit {
        val: data as u32 as i32,
        flag: ((data >> 40) & 0x3) as u8,
        depth: ((data >> 32) & 0xFF) as i32,
        mv: TT_MOVE[idx].load(Ordering::Relaxed),
    })
}

#[inline]
fn tt_store(key: u64, depth: i32, val: i32, flag: u8, mv: u32) {
    let idx = (key & TT_MASK) as usize;
    let gen = CUR_GEN.load(Ordering::Relaxed);
    let data = pack_entry(val, depth, flag, gen);
    TT_DATA[idx].store(data, Ordering::Relaxed);
    TT_LOCK[idx].store(key ^ data, Ordering::Relaxed);
    TT_MOVE[idx].store(mv, Ordering::Relaxed);
}

#[derive(Clone, Copy, PartialEq)]
struct Move {
    from_r: i32, from_c: i32, to_r: i32, to_c: i32,
    outcome: i32, // 1 = mover wins, -1 = mover loses own last ring, 0 = continue
    key: i32,     // static eval from the mover's perspective
}

#[derive(Clone, Copy)]
struct UndoFrame {
    r: [usize; 6], w: [u32; 6], b: [u32; 6], n: usize,
}

// Sized for the deepest make/unmake nesting the search needs: negamax stays within
// MAX_DEPTH, plus a small margin for the eager path's transient per-move make.
const UNDO_CAP: usize = MAX_DEPTH as usize + 8;

// ─── Per-thread scratch (BSS, fixed addresses) ───────────────────────────────
// Indexed by thread id (0 = main, 1.. = helpers). Move is all-i32 so the zeroed
// initial value is valid (and keeps these in BSS — no data-segment bloat). The
// search hot path bump-allocates moves here instead of on the heap, so helper
// threads never touch the global allocator (whose state is in the same shared
// memory and is used only by the main worker's driver code).
static mut MOVE_ARENA: [[Move; ARENA_MOVES]; MAX_THREADS] =
    [[Move { from_r: 0, from_c: 0, to_r: 0, to_c: 0, outcome: 0, key: 0 }; ARENA_MOVES]; MAX_THREADS];

// Private shadow stacks for helper workers (the main worker keeps the linker's
// default stack). thread_stack_top() hands a helper the top of its region so it
// can point __stack_pointer there before searching.
static mut THREAD_STACK: [[u8; STACK_BYTES]; MAX_THREADS] = [[0u8; STACK_BYTES]; MAX_THREADS];

#[inline]
fn arena_ptr(tid: usize) -> *mut Move {
    unsafe { (core::ptr::addr_of_mut!(MOVE_ARENA) as *mut Move).add(tid * ARENA_MOVES) }
}

// Move ordering: higher outcome first, then higher key first (both descending).
#[inline]
fn move_before(a: &Move, b: &Move) -> bool {
    a.outcome > b.outcome || (a.outcome == b.outcome && a.key > b.key)
}

// Pack a move's four 0..19 coordinates into 20 bits for the TT (0 = "no move").
#[inline]
fn pack_mv(m: &Move) -> u32 {
    (m.from_r as u32) | ((m.from_c as u32) << 5) | ((m.to_r as u32) << 10) | ((m.to_c as u32) << 15)
}

// Early-exit ring presence (the lazy search only needs "any ring?" to detect a
// win/loss outcome, not the full count — so this returns on the first one found).
#[inline]
fn has_ring_w(w: &[u32; 20], b: &[u32; 20]) -> bool {
    let mut r = RING_LO; while r <= RING_HI { if row_ring_mask_w(w, b, r as usize) != 0 { return true; } r += 1; }
    false
}
#[inline]
fn has_ring_b(w: &[u32; 20], b: &[u32; 20]) -> bool {
    // Scan bottom-up: black's rings sit in its home rows (13-18), so start there.
    let mut r = RING_HI; while r >= RING_LO { if row_ring_mask_b(w, b, r as usize) != 0 { return true; } r -= 1; }
    false
}

// Move `target` (packed) to slot `front` within the arena block, if present at or
// after `front` (so earlier-promoted moves are left alone). Returns the next free
// front slot. A target not in the list (stale TT/killer) leaves the order intact.
#[inline]
unsafe fn promote(base: *mut Move, mstart: usize, mcount: usize, front: usize, target: u32) -> usize {
    if target == 0 { return front; }
    let mut i = front;
    while i < mcount {
        if pack_mv(&*base.add(mstart + i)) == target {
            if i != front { core::ptr::swap(base.add(mstart + front), base.add(mstart + i)); }
            return front + 1;
        }
        i += 1;
    }
    front
}

// Allocation-free *stable* sort (bottom-up merge sort) of `n` moves at `a`, using
// `tmp` (capacity ≥ n) as scratch. std's slice::sort_by allocates, which the
// helper threads must not do; this preserves the TS engine's stable order (equal
// elements keep their insertion order) so results stay byte-identical.
unsafe fn stable_sort_moves(a: *mut Move, n: usize, tmp: *mut Move) {
    if n < 2 { return; }
    let mut src = a;
    let mut dst = tmp;
    let mut width = 1usize;
    while width < n {
        let mut i = 0usize;
        while i < n {
            let l = i;
            let m = core::cmp::min(i + width, n);
            let r = core::cmp::min(i + 2 * width, n);
            let (mut p, mut q, mut k) = (l, m, l);
            while p < m && q < r {
                let xp = *src.add(p);
                let xq = *src.add(q);
                if move_before(&xq, &xp) { *dst.add(k) = xq; q += 1; } // ties → left (stable)
                else { *dst.add(k) = xp; p += 1; }
                k += 1;
            }
            while p < m { *dst.add(k) = *src.add(p); p += 1; k += 1; }
            while q < r { *dst.add(k) = *src.add(q); q += 1; k += 1; }
            i += 2 * width;
        }
        core::mem::swap(&mut src, &mut dst);
        width *= 2;
    }
    if src != a {
        for i in 0..n { *a.add(i) = *src.add(i); }
    }
}

/// Top (high address, 16-byte aligned) of helper `tid`'s private shadow stack.
#[no_mangle]
pub extern "C" fn thread_stack_top(tid: i32) -> i32 {
    let base = core::ptr::addr_of_mut!(THREAD_STACK) as usize + (tid as usize) * STACK_BYTES;
    ((base + STACK_BYTES) & !15usize) as i32
}

struct Engine {
    w: [u32; 20],
    b: [u32; 20],
    p_ring_w: [i32; 20],
    p_ring_b: [i32; 20],
    p_stone_w: [i32; 20],
    p_stone_b: [i32; 20],
    undo: [UndoFrame; UNDO_CAP],
    undo_len: usize,
    tid: usize,        // thread id → which MOVE_ARENA slice this engine uses
    arena_top: usize,  // bump pointer into MOVE_ARENA[tid]
    hash: u64,         // incremental Zobrist of stones only (side added at probe)
    hash_check: bool,  // verification: compare incremental vs fresh hash per node
    ring_track: bool,  // use the witness-ring fast path for has_ring (read once from RING_TRACK)
    ring_check: bool,  // verification: compare witness has_ring vs fresh scan per node
    wit_w: i32,        // cached white ring centre (r*20+c) or -1; a lazily-validated hint
    wit_b: i32,        // cached black ring centre
    nodes: u32,        // node counter, for throttling the wall-clock check
    killers: [[u32; 2]; KILLER_PLIES], // two killer moves per ply (lazy search)
    timed_out: bool,
    tt_enabled: bool,
}

const KILLER_PLIES: usize = (MAX_DEPTH + 2) as usize;

// Read the wall clock only once every this many nodes — `now()` is a WASM→JS
// boundary crossing, too costly to do at every node. A power of two so the test
// is a cheap mask. The shared STOP flag is still checked every node (a plain
// relaxed load), so helper cancellation stays prompt; only the engine's own
// deadline can overshoot, by at most one window of nodes.
const CLOCK_CHECK_MASK: u32 = 0xFF; // every 256 nodes

impl Engine {
    fn new(w: [u32; 20], b: [u32; 20], tt_enabled: bool, tid: usize) -> Self {
        Engine {
            w, b,
            ring_track: RING_TRACK.load(Ordering::Relaxed),
            ring_check: false,
            wit_w: -1, wit_b: -1, // lazily found on first has_ring_wit call
            p_ring_w: [0; 20], p_ring_b: [0; 20],
            p_stone_w: [0; 20], p_stone_b: [0; 20],
            undo: [UndoFrame { r: [0; 6], w: [0; 6], b: [0; 6], n: 0 }; UNDO_CAP],
            undo_len: 0,
            tid,
            arena_top: 0,
            // Stone-only Zobrist of the root board; the search keeps it current
            // incrementally (compute_hash(.., false) omits the side term).
            hash: compute_hash(&w, &b, false),
            hash_check: false,
            nodes: 0,
            killers: [[0u32; 2]; KILLER_PLIES],
            timed_out: false,
            tt_enabled,
        }
    }

    /// Full ring/stone/deepest analysis; also caches per-row counts in scratch.
    fn analyze_fill(&mut self) -> Counts {
        let (mut wr, mut br, mut ws, mut bs) = (0, 0, 0, 0);
        let mut r = MIN;
        while r <= MAX {
            let ri = r as usize;
            let rw = row_ring_w(&self.w, &self.b, ri);
            let rb = row_ring_b(&self.w, &self.b, ri);
            let sw = (self.w[ri] & PLAY_MASK).count_ones() as i32;
            let sb = (self.b[ri] & PLAY_MASK).count_ones() as i32;
            self.p_ring_w[ri] = rw;
            self.p_ring_b[ri] = rb;
            self.p_stone_w[ri] = sw;
            self.p_stone_b[ri] = sb;
            wr += rw; br += rb; ws += sw; bs += sb;
            r += 1;
        }
        Counts { wr, br, ws, bs, wdeep: white_deepest(&self.w), bdeep: black_deepest(&self.b) }
    }

    /// has_ring via a cached "witness" ring when tracking is on: keep one known ring
    /// centre per colour and just re-validate it (O(1)); only when it's gone do we
    /// scan for another — which is exactly the move that might have ended the game.
    /// A pure cache (always validated before trust), so it needs NO make/unmake
    /// maintenance and is correct regardless of staleness. Can't give ring COUNTS,
    /// so it serves the terminal check only; the eval still scans.
    #[inline]
    fn has_ring_wit(&mut self, white: bool) -> bool {
        let wit = if white { self.wit_w } else { self.wit_b };
        if wit >= 0 {
            let r = (wit / 20) as usize;
            let c = (wit % 20) as u32;
            let m = if white { row_ring_mask_w(&self.w, &self.b, r) } else { row_ring_mask_b(&self.w, &self.b, r) };
            if m & (1u32 << c) != 0 { return true; } // witness still a ring → done
        }
        // Witness gone (or none yet): scan for any ring and adopt it. Scan from each
        // colour's home end — white top-down, black bottom-up — so the common case
        // (a ring in its home rows) is found in a row or two.
        if white {
            let mut r = RING_LO;
            while r <= RING_HI {
                let m = row_ring_mask_w(&self.w, &self.b, r as usize);
                if m != 0 { self.wit_w = r * 20 + m.trailing_zeros() as i32; return true; }
                r += 1;
            }
            self.wit_w = -1;
        } else {
            let mut r = RING_HI;
            while r >= RING_LO {
                let m = row_ring_mask_b(&self.w, &self.b, r as usize);
                if m != 0 { self.wit_b = r * 20 + m.trailing_zeros() as i32; return true; }
                r -= 1;
            }
            self.wit_b = -1;
        }
        false
    }

    #[inline]
    fn has_ring_inc(&mut self, white: bool, inc: bool) -> bool {
        if inc {
            self.has_ring_wit(white)
        } else if white {
            has_ring_w(&self.w, &self.b)
        } else {
            has_ring_b(&self.w, &self.b)
        }
    }

    /// Leaf/terminal eval — always the full scan (the witness gives presence, not
    /// the ring counts the eval needs).
    #[inline]
    fn eval_leaf(&self, white: bool, _inc: bool) -> i32 {
        eval_and_safety(&self.w, &self.b, white)
    }

    /// Verification: the witness-based has_ring must equal the full scan, both colours.
    fn verify_rings(&mut self) {
        let w_full = has_ring_w(&self.w, &self.b);
        let b_full = has_ring_b(&self.w, &self.b);
        let w_wit = self.has_ring_wit(true);
        let b_wit = self.has_ring_wit(false);
        if w_wit != w_full || b_wit != b_full {
            RING_MISMATCH.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Apply a move. When `track`, also returns the stone-hash delta (XOR of the
    /// Zobrist keys of every cell whose occupancy changed) so the caller can keep
    /// the incremental hash current across a real search edge; `gen_moves`' scratch
    /// makes pass `track=false` and ignore it (they never probe the TT). XOR is its
    /// own inverse, so unmake needs no hash work — the caller re-XORs the delta.
    fn make_move(&mut self, from_r: i32, from_c: i32, to_r: i32, to_c: i32, white: bool, track: bool) -> u64 {
        let mut delta = 0u64;
        // Save the rows this move can change (origin & destination footprint rows).
        let mut frame = UndoFrame { r: [0; 6], w: [0; 6], b: [0; 6], n: 0 };
        let mut n = 0usize;
        let mut r = from_r - 1;
        while r <= from_r + 1 {
            if r >= 0 && r < SIZE {
                let ri = r as usize;
                frame.r[n] = ri; frame.w[n] = self.w[ri]; frame.b[n] = self.b[ri]; n += 1;
            }
            r += 1;
        }
        let mut r = to_r - 1;
        while r <= to_r + 1 {
            if r >= 0 && r < SIZE && !(r >= from_r - 1 && r <= from_r + 1) {
                let ri = r as usize;
                frame.r[n] = ri; frame.w[n] = self.w[ri]; frame.b[n] = self.b[ri]; n += 1;
            }
            r += 1;
        }
        frame.n = n;
        self.undo[self.undo_len] = frame;
        self.undo_len += 1;

        // Capture the moving piece's own-stone pattern (3×3) before clearing it.
        let mut pat = 0u32;
        let mut ddr = -1;
        while ddr <= 1 {
            let rr = from_r + ddr;
            if rr >= 0 && rr < SIZE {
                let mut ddc = -1;
                while ddc <= 1 {
                    let cc = from_c + ddc;
                    if cc >= 0 && cc < SIZE {
                        let own_row = if white { self.w[rr as usize] } else { self.b[rr as usize] };
                        if own_row & (1u32 << cc) != 0 {
                            pat |= 1u32 << ((ddr + 1) * 3 + (ddc + 1));
                            // Origin own stone removed (re-placed at the destination below).
                            if track { delta ^= zob_cell(white, (rr * SIZE + cc) as usize); }
                        }
                    }
                    ddc += 1;
                }
            }
            ddr += 1;
        }

        // Clear the origin footprint's own stones.
        let ocm = COL3[from_c as usize];
        let mut rr = from_r - 1;
        while rr <= from_r + 1 {
            if rr >= 0 && rr < SIZE {
                if white { self.w[rr as usize] &= !ocm; } else { self.b[rr as usize] &= !ocm; }
            }
            rr += 1;
        }

        // Clear the destination footprint (captures, both colours). Read occupancy
        // first (after the origin clear, so overlapping origin stones aren't
        // double-counted) to XOR the removed stones out of the hash.
        let dcm = COL3[to_c as usize];
        let mut r = to_r - 1;
        while r <= to_r + 1 {
            if r >= 0 && r < SIZE {
                let ri = r as usize;
                if track {
                    let mut m = self.w[ri] & dcm;
                    while m != 0 { let c = m.trailing_zeros() as usize; delta ^= zob_cell(true, ri * 20 + c); m &= m - 1; }
                    let mut m = self.b[ri] & dcm;
                    while m != 0 { let c = m.trailing_zeros() as usize; delta ^= zob_cell(false, ri * 20 + c); m &= m - 1; }
                }
                self.w[ri] &= !dcm; self.b[ri] &= !dcm;
            }
            r += 1;
        }

        // Place the piece's stones at the destination; those on the border ring
        // (outside rows/cols 1..18) are removed.
        let mut ddr = -1;
        while ddr <= 1 {
            let mut ddc = -1;
            while ddc <= 1 {
                if pat & (1u32 << ((ddr + 1) * 3 + (ddc + 1))) != 0 {
                    let rr = to_r + ddr;
                    let cc = to_c + ddc;
                    if rr >= MIN && rr <= MAX && cc >= MIN && cc <= MAX {
                        if white { self.w[rr as usize] |= 1u32 << cc; }
                        else { self.b[rr as usize] |= 1u32 << cc; }
                        // Piece stone placed at the destination (off-board cells fall away).
                        if track { delta ^= zob_cell(white, (rr * SIZE + cc) as usize); }
                    }
                }
                ddc += 1;
            }
            ddr += 1;
        }
        // Witness has_ring needs no make/unmake maintenance (it self-validates).
        delta
    }

    fn unmake_move(&mut self) {
        self.undo_len -= 1;
        let frame = self.undo[self.undo_len];
        for i in 0..frame.n {
            let ri = frame.r[i];
            self.w[ri] = frame.w[i];
            self.b[ri] = frame.b[i];
        }
    }

    /// All legal moves for the mover with outcome and eval, sorted best-first
    /// (wins, then by score, then losses). Uses make/unmake + incremental eval.
    /// Writes the moves into this thread's arena slice at the current bump
    /// pointer, advances the bump pointer past them, and returns (start, count);
    /// the caller restores the bump pointer when done with the node.
    fn gen_moves(&mut self, white: bool, lazy: bool) -> (usize, usize) {
        // Parent snapshot used for all move-generation reads (unchanged across
        // children because each make is paired with an unmake before the next).
        let pw = self.w;
        let pb = self.b;
        let (own, opp) = if white { (pw, pb) } else { (pb, pw) };

        // Guard-padded per-row occupancy, computed once for the whole node (index =
        // board row + 1, so occ_g[0]/[21] are off-board zeros). The slide's footprint
        // reads then need no per-step bounds checks, and — since many rows are empty —
        // a destination footprint that lands on empty board is detected with a single
        // OR+AND and skips the per-row hit/capture scan entirely.
        let mut occ_g = [0u32; 22];
        let mut opp_g = [0u32; 22];
        {
            let mut i = 0usize;
            while i < SIZE as usize {
                occ_g[i + 1] = pw[i] | pb[i];
                opp_g[i + 1] = opp[i];
                i += 1;
            }
        }

        // Parent counts + per-row cache (one full analysis for the whole node) —
        // only the eager path uses it (incremental eval). Lazy defers all eval, so
        // computing it there would be pure waste.
        let p = if lazy {
            Counts { wr: 0, br: 0, ws: 0, bs: 0, wdeep: 0, bdeep: 0 }
        } else {
            self.analyze_fill()
        };

        let base = arena_ptr(self.tid);
        let start = self.arena_top;
        let mut count = 0usize;

        for r in 0..SIZE {
            // Footprint-centre enumeration via bitboards. A centre c is legal iff its
            // 3×3 (rows r-1..r+1) holds ≥1 own stone and no opponent stone. Per the
            // vertical OR of the three rows, "any stone within the 3-wide window at c"
            // is m | (m<<1) | (m>>1), so all legal centres fall out as one mask and we
            // iterate only its set bits — same (r, c-ascending) order as the old
            // 400-cell scan, and the window matches COL3 exactly at the edges.
            let opp_up = if r >= 1 { opp[(r - 1) as usize] } else { 0 };
            let opp_dn = if r < SIZE - 1 { opp[(r + 1) as usize] } else { 0 };
            let own_up = if r >= 1 { own[(r - 1) as usize] } else { 0 };
            let own_dn = if r < SIZE - 1 { own[(r + 1) as usize] } else { 0 };
            let opprow = opp_up | opp[r as usize] | opp_dn;
            let ownrow = own_up | own[r as usize] | own_dn;
            let opp_block = opprow | (opprow << 1) | (opprow >> 1);
            let own_pres = ownrow | (ownrow << 1) | (ownrow >> 1);
            let mut centres = own_pres & !opp_block & 0xF_FFFF; // bits 0..19 (drop <<1 spill)
            while centres != 0 {
                let c = centres.trailing_zeros() as i32;
                centres &= centres - 1; // pop the centre we're about to process
                let cm = COL3[c as usize];

                let max_steps = if own[r as usize] & (1u32 << c) != 0 { SIZE } else { 3 };
                let mut visited = [0u32; 20]; // dest dedup, fresh per origin centre

                for (dr, dc) in DIRS {
                    let sr = r + dr;
                    let sc = c + dc;
                    if sr < 0 || sr >= SIZE || sc < 0 || sc >= SIZE { continue; }
                    if own[sr as usize] & (1u32 << sc) == 0 { continue; }

                    let mut step = 1;
                    while step <= max_steps {
                        let nr = r + dr * step;
                        let nc = c + dc * step;
                        if nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE { break; }

                        // Destination footprint (rows nr-1..nr+1, the COL3[nc] window).
                        // `hits` = occupied cells that block the slide (the origin
                        // footprint is transparent, so its window is masked out); `caps`
                        // = opponent stones captured there (the cheap MVV ordering key).
                        // Fast path: if the whole band is empty (common — most rows are),
                        // skip the per-row scan. Folding hit+capture into one pass mirrors
                        // the eval fusion; richer keys were measured net-negative.
                        let ncm = COL3[nc as usize];
                        let ni = (nr + 1) as usize; // guard-padded index of centre row nr
                        let hits;
                        let caps;
                        if (occ_g[ni - 1] | occ_g[ni] | occ_g[ni + 1]) & ncm == 0 {
                            hits = 0;
                            caps = 0;
                        } else {
                            let mut h = 0u32;
                            let mut cp = 0i32;
                            let mut row = nr - 1;
                            while row <= nr + 1 {
                                let gi = (row + 1) as usize; // guard-padded: no bounds check
                                let mut o = occ_g[gi] & ncm;
                                if row >= r - 1 && row <= r + 1 { o &= !cm; }
                                h |= o;
                                cp += (opp_g[gi] & ncm).count_ones() as i32;
                                row += 1;
                            }
                            hits = h;
                            caps = cp;
                        }

                        if visited[nr as usize] & (1u32 << nc) == 0 {
                            visited[nr as usize] |= 1u32 << nc;

                            if lazy {
                            unsafe { *base.add(start + count) = Move { from_r: r, from_c: c, to_r: nr, to_c: nc, outcome: 0, key: caps }; }
                            count += 1;
                            } else {
                            // Incremental eval over the affected band r±2 ∪ nr±2.
                            let a0 = if r - 2 < MIN { MIN } else { r - 2 };
                            let a1 = if r + 2 > MAX { MAX } else { r + 2 };
                            let b0 = if nr - 2 < MIN { MIN } else { nr - 2 };
                            let b1 = if nr + 2 > MAX { MAX } else { nr + 2 };
                            let mut band = [0i32; 16];
                            let mut bn = 0usize;
                            if b0 > a1 + 1 || a0 > b1 + 1 {
                                let mut rc = a0; while rc <= a1 { band[bn] = rc; bn += 1; rc += 1; }
                                let mut rc = b0; while rc <= b1 { band[bn] = rc; bn += 1; rc += 1; }
                            } else {
                                let lo = if a0 < b0 { a0 } else { b0 };
                                let hi = if a1 > b1 { a1 } else { b1 };
                                let mut rc = lo; while rc <= hi { band[bn] = rc; bn += 1; rc += 1; }
                            }

                            self.make_move(r, c, nr, nc, white, false);
                            let (mut dwr, mut dbr, mut dws, mut dbs) = (0, 0, 0, 0);
                            for i in 0..bn {
                                let rc = band[i] as usize;
                                dwr += row_ring_w(&self.w, &self.b, rc) - self.p_ring_w[rc];
                                dbr += row_ring_b(&self.w, &self.b, rc) - self.p_ring_b[rc];
                                dws += (self.w[rc] & PLAY_MASK).count_ones() as i32 - self.p_stone_w[rc];
                                dbs += (self.b[rc] & PLAY_MASK).count_ones() as i32 - self.p_stone_b[rc];
                            }
                            let cwr = p.wr + dwr;
                            let cbr = p.br + dbr;
                            let cws = p.ws + dws;
                            let cbs = p.bs + dbs;
                            let cwdeep = white_deepest(&self.w);
                            let cbdeep = black_deepest(&self.b);
                            let safety = ring_safety(&self.w, &self.b, white); // on the child board
                            self.unmake_move();

                            let (myr, opr) = if white { (cwr, cbr) } else { (cbr, cwr) };
                            let (mys, ops) = if white { (cws, cbs) } else { (cbs, cws) };
                            let (myd, opd) = if white { (cwdeep, cbdeep) } else { (cbdeep, cwdeep) };
                            let outcome = if myr == 0 { -1 } else if opr == 0 { 1 } else { 0 };
                            let key = 100 * (mys - ops) + 70 * (myr - opr) + (myd - opd) + safety;
                            unsafe { *base.add(start + count) = Move { from_r: r, from_c: c, to_r: nr, to_c: nc, outcome, key }; }
                            count += 1;
                            }
                        }

                        if hits != 0 { break; } // first intersection: land here, stop sliding
                        step += 1;
                    }
                }
            }
        }

        // Stable sort: outcome desc, then key desc (ties keep insertion order).
        // tmp scratch sits just past the moves; it is transient (arena_top does
        // not include it), so child nodes reuse that space.
        unsafe { stable_sort_moves(base.add(start), count, base.add(start + count)); }
        self.arena_top = start + count;
        (start, count)
    }

    /// Negamax with alpha-beta on the shared bitboard (make/unmake). Value from
    /// the mover's perspective. `deadline` is wall-clock ms; pass INFINITY to
    /// disable the time check entirely (deterministic, for verification).
    fn negamax(&mut self, white: bool, depth: i32, mut alpha: i32, beta: i32, ply: i32, deadline: f64) -> i32 {
        // Time / stop check. Skipped entirely when deadline is infinite (the
        // deterministic verification path), so neither STOP nor the clock can
        // perturb it. STOP is read every node (cheap, keeps cancellation prompt);
        // the wall clock only every CLOCK_CHECK_MASK+1 nodes (the boundary cross
        // is the costly part).
        if deadline.is_finite() {
            if STOP.load(Ordering::Relaxed) != 0 {
                self.timed_out = true;
                return 0;
            }
            self.nodes = self.nodes.wrapping_add(1);
            if self.nodes & CLOCK_CHECK_MASK == 0 && unsafe { now() } >= deadline {
                self.timed_out = true;
                return 0;
            }
        }

        if self.ring_check { self.verify_rings(); }

        // Transposition-table probe (textbook fail-soft: cut only on a sufficient
        // bound). On a hit we also keep the stored best move to try first below —
        // reordering preserves the minimax value but sharpens the cutoffs.
        let mut key = 0u64;
        let mut tt_move = 0u32;
        if self.tt_enabled {
            // Incremental hash + side-to-move term (kept current on search edges).
            key = self.hash ^ if white { zob_side() } else { 0 };
            if self.hash_check && key != compute_hash(&self.w, &self.b, white) {
                HASH_MISMATCH.fetch_add(1, Ordering::Relaxed);
            }
            if let Some(h) = tt_probe(key) {
                if h.depth >= depth {
                    if h.flag == TF_EXACT { return h.val; }
                    if h.flag == TF_LOWER && h.val >= beta { return h.val; }
                    if h.flag == TF_UPPER && h.val <= alpha { return h.val; }
                }
                tt_move = h.mv;
            }
        }
        let alpha_orig = alpha;

        let save_top = self.arena_top;
        let (mstart, mcount) = self.gen_moves(white, false);
        if mcount == 0 {
            self.arena_top = save_top;
            return eval_and_safety(&self.w, &self.b, white);
        }

        let base = arena_ptr(self.tid);
        // Move ordering: bring the TT move to the front (legality is guaranteed by
        // matching against the freshly generated list, so a stale/raced move is
        // simply not found). Tried first → more / earlier beta cut-offs.
        if tt_move != 0 {
            for i in 0..mcount {
                if pack_mv(unsafe { &*base.add(mstart + i) }) == tt_move {
                    if i != 0 { unsafe { core::ptr::swap(base.add(mstart), base.add(mstart + i)); } }
                    break;
                }
            }
        }

        let mut best = NEG_INF;
        let mut best_mv = 0u32;
        for i in 0..mcount {
            let mv = unsafe { *base.add(mstart + i) }; // copy out before recursing
            let score;
            if mv.outcome == 1 {
                score = WIN_SCORE - (ply + 1);
            } else if mv.outcome == -1 {
                score = -(WIN_SCORE - (ply + 1));
            } else if depth == 1 {
                score = mv.key;
            } else {
                let d = self.make_move(mv.from_r, mv.from_c, mv.to_r, mv.to_c, white, self.tt_enabled);
                self.hash ^= d;
                let s = -self.negamax(!white, depth - 1, -beta, -alpha, ply + 1, deadline);
                self.unmake_move();
                self.hash ^= d;
                if self.timed_out { self.arena_top = save_top; return 0; }
                score = s;
            }

            if score > best { best = score; best_mv = pack_mv(&mv); }
            if best > alpha { alpha = best; }
            if alpha >= beta { break; } // beta cut-off
        }
        self.arena_top = save_top;

        // Store value + best move — but never cache mate-range values (ply-dependent).
        if self.tt_enabled && (best.abs() < WIN_SCORE - MAX_DEPTH) {
            let flag = if best <= alpha_orig { TF_UPPER } else if best >= beta { TF_LOWER } else { TF_EXACT };
            tt_store(key, depth, best, flag, best_mv);
        }
        best
    }

    /// Lazy variant for the TT-on (production) path. Moves are generated cheaply
    /// (capture-ordered, no eval), ordered by TT move then killers, and each
    /// move's outcome/eval is computed only when actually visited — so we never
    /// pay the full per-move eval (incl. the ring_safety/deepest full scans) for
    /// moves alpha-beta prunes, nor at all for interior nodes. The minimax value
    /// is unchanged (ordering doesn't affect it; the leaf eval is the same full
    /// key), so `bestScore == oracle` still holds.
    fn negamax_lazy(&mut self, white: bool, depth: i32, mut alpha: i32, beta: i32, ply: i32, deadline: f64, can_null: bool) -> i32 {
        self.nodes = self.nodes.wrapping_add(1); // counted on every path (also drives the clock throttle)
        if deadline.is_finite() {
            if STOP.load(Ordering::Relaxed) != 0 { self.timed_out = true; return 0; }
            if self.nodes & CLOCK_CHECK_MASK == 0 && unsafe { now() } >= deadline {
                self.timed_out = true;
                return 0;
            }
        }

        let key = self.hash ^ if white { zob_side() } else { 0 };
        if self.hash_check && key != compute_hash(&self.w, &self.b, white) {
            HASH_MISMATCH.fetch_add(1, Ordering::Relaxed);
        }
        if self.ring_check { self.verify_rings(); }
        // Use the maintained ring masks/totals for has_ring + leaf eval iff tracking
        // is on (make/unmake keep them current); else fall back to full scans.
        let inc = self.ring_track;
        let mut tt_move = 0u32;
        if let Some(h) = tt_probe(key) {
            if h.depth >= depth {
                if h.flag == TF_EXACT { return h.val; }
                if h.flag == TF_LOWER && h.val >= beta { return h.val; }
                if h.flag == TF_UPPER && h.val <= alpha { return h.val; }
            }
            tt_move = h.mv;
        }
        let alpha_orig = alpha;

        // Null-move pruning: if allowed here, deep enough, and beta is a real (non-mate)
        // bound, let the side to move "pass" and search the opponent at reduced depth
        // with a null window. If even that fails high, this node is far above beta, so
        // prune. The board/hash are unchanged by a pass — only the side flips, which the
        // child's key computation already handles. Skipped when the mover has no ring
        // (near-lost: passing would mislead) as a cheap guard against Gess's rare
        // zugzwang, and disabled wholesale via NULLMOVE (off during exact verification).
        if can_null
            && NULLMOVE.load(Ordering::Relaxed)
            && depth >= 3
            && beta.abs() < WIN_SCORE - MAX_DEPTH
            && self.has_ring_inc(white, inc)
        {
            let red = if depth >= 6 { 3 } else { 2 };
            let nd = (depth - 1 - red).max(1);
            let s = -self.negamax_lazy(!white, nd, -beta, -beta + 1, ply + 1, deadline, false);
            if self.timed_out { return 0; }
            if s >= beta { return s; }
        }

        let save_top = self.arena_top;
        let (mstart, mcount) = self.gen_moves(white, true);
        if mcount == 0 {
            self.arena_top = save_top;
            return self.eval_leaf(white, inc);
        }

        let base = arena_ptr(self.tid);
        // Ordering: TT move, then the two killers for this ply, ahead of the
        // capture-sorted remainder. (Stale entries simply aren't found.)
        let mut front = unsafe { promote(base, mstart, mcount, 0, tt_move) };
        front = unsafe { promote(base, mstart, mcount, front, self.killers[ply as usize][0]) };
        let _ = unsafe { promote(base, mstart, mcount, front, self.killers[ply as usize][1]) };

        // The incremental hash is only needed for children we recurse into.
        let track = depth > 1;
        let mut best = NEG_INF;
        let mut best_mv = 0u32;
        for i in 0..mcount {
            let mv = unsafe { *base.add(mstart + i) };
            let d = self.make_move(mv.from_r, mv.from_c, mv.to_r, mv.to_c, white, track);
            self.hash ^= d;
            // Outcome from ring presence (early-exit), same precedence as the eager
            // path: mover with no ring loses; else opponent with no ring → win.
            let my_has = self.has_ring_inc(white, inc);
            let op_has = self.has_ring_inc(!white, inc);
            let mut score;
            if !my_has {
                score = -(WIN_SCORE - (ply + 1));
            } else if !op_has {
                score = WIN_SCORE - (ply + 1);
            } else if depth == 1 {
                score = self.eval_leaf(white, inc);
            } else {
                // Late move reduction: a late, quiet move (key 0 = no capture) is unlikely
                // to be best given the ordering, so search it shallower first and only pay
                // for a full-depth re-search if it unexpectedly beats alpha. The first few
                // moves (TT move + killers + the strongest captures) and all captures are
                // searched at full depth. Speculative — gated by LMR (off in verification).
                let reduce = LMR.load(Ordering::Relaxed) && depth >= 3 && i >= 3 && mv.key == 0;
                if reduce {
                    let red = if i >= 6 { 2 } else { 1 };
                    let nd = (depth - 1 - red).max(1);
                    score = -self.negamax_lazy(!white, nd, -beta, -alpha, ply + 1, deadline, true);
                    if score > alpha && nd < depth - 1 {
                        score = -self.negamax_lazy(!white, depth - 1, -beta, -alpha, ply + 1, deadline, true);
                    }
                } else {
                    score = -self.negamax_lazy(!white, depth - 1, -beta, -alpha, ply + 1, deadline, true);
                }
            }
            self.unmake_move();
            self.hash ^= d;
            if self.timed_out { self.arena_top = save_top; return 0; }

            if score > best { best = score; best_mv = pack_mv(&mv); }
            if best > alpha { alpha = best; }
            if alpha >= beta {
                // Remember a quiet (non-capturing) cutting move as a killer.
                if mv.key == 0 {
                    let p = pack_mv(&mv);
                    let k = &mut self.killers[ply as usize];
                    if k[0] != p { k[1] = k[0]; k[0] = p; }
                }
                break;
            }
        }
        self.arena_top = save_top;

        if best.abs() < WIN_SCORE - MAX_DEPTH {
            let flag = if best <= alpha_orig { TF_UPPER } else if best >= beta { TF_LOWER } else { TF_EXACT };
            tt_store(key, depth, best, flag, best_mv);
        }
        best
    }

    /// Dispatch to the lazy (TT-on, production) or eager (TT-off, byte-identical
    /// verification) search. Drivers call this; each variant then recurses into
    /// itself. FORCE_EAGER lets a benchmark route TT-on through the eager path too
    /// (for A/B), without rebuilding.
    #[inline]
    fn search(&mut self, white: bool, depth: i32, alpha: i32, beta: i32, ply: i32, deadline: f64) -> i32 {
        if self.tt_enabled && !FORCE_EAGER.load(Ordering::Relaxed) {
            self.negamax_lazy(white, depth, alpha, beta, ply, deadline, true)
        } else {
            self.negamax(white, depth, alpha, beta, ply, deadline)
        }
    }
}

// Benchmark switch: when set, search() uses the eager path even with the TT on,
// so the lazy vs eager move-gen can be compared on one build. Never set in prod.
static FORCE_EAGER: AtomicBool = AtomicBool::new(false);

#[no_mangle]
pub extern "C" fn set_force_eager(v: i32) {
    FORCE_EAGER.store(v != 0, Ordering::Relaxed);
}

// Null-move pruning toggle. ON by default (production). The exact-search
// verification (the harness) turns it OFF so the lazy path stays byte-exact; it
// also gives a clean same-build A/B for measuring the node reduction.
static NULLMOVE: AtomicBool = AtomicBool::new(true);

#[no_mangle]
pub extern "C" fn set_nullmove(v: i32) {
    NULLMOVE.store(v != 0, Ordering::Relaxed);
}

// Late-move-reduction toggle, same treatment as NULLMOVE: ON by default, turned
// OFF for exact verification, and a same-build A/B knob.
static LMR: AtomicBool = AtomicBool::new(true);

#[no_mangle]
pub extern "C" fn set_lmr(v: i32) {
    LMR.store(v != 0, Ordering::Relaxed);
}

// ─── Exported entry points ───────────────────────────────────────────────────

/// Generate the root moves and copy them into a Vec, freeing the arena (resetting
/// the bump pointer to 0) so the recursive search can use it from the bottom.
/// Only the driver functions — all of which run on the main worker — call this,
/// so the Vec allocation never races with a helper.
fn collect_root(eng: &mut Engine, white: bool) -> Vec<Move> {
    let (start, count) = eng.gen_moves(white, false);
    let base = arena_ptr(eng.tid);
    let mut v = Vec::with_capacity(count);
    for i in 0..count { v.push(unsafe { *base.add(start + i) }); }
    eng.arena_top = 0;
    v
}

/// Verification: full board analysis → OUT[0..8] = wR,bR,wS,bS,wDeep,bDeep,pW,pB.
#[no_mangle]
pub extern "C" fn analyze() -> i32 {
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, false, 0);
    let a = eng.analyze_fill();
    let (pw, pb) = ring_pressure(&eng.w, &eng.b);
    out_set(0, a.wr); out_set(1, a.br); out_set(2, a.ws);
    out_set(3, a.bs); out_set(4, a.wdeep); out_set(5, a.bdeep);
    out_set(6, pw); out_set(7, pb);
    0
}

/// Verification: generated root moves (sorted) → OUT[0] = count, then 6 i32 per
/// move: fromR, fromC, toR, toC, outcome, key. Returns the count.
#[no_mangle]
pub extern "C" fn gen_root(white_i: i32) -> i32 {
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, false, 0);
    let (start, count) = eng.gen_moves(white_i != 0, false);
    let base = arena_ptr(0);
    out_set(0, count as i32);
    let mut k = 1;
    for i in 0..count {
        let m = unsafe { *base.add(start + i) };
        out_set(k, m.from_r); out_set(k + 1, m.from_c);
        out_set(k + 2, m.to_r); out_set(k + 3, m.to_c);
        out_set(k + 4, m.outcome); out_set(k + 5, m.key);
        k += 6;
    }
    count as i32
}

/// Verification: deterministic phase-1 alpha-beta at a fixed depth (no random
/// pick, no root reordering, no time limit). Mirrors getBestMove's phase 1.
/// With tt_enabled the transposition table is used (bestScore is unchanged; the
/// per-move fail-soft scores may differ since cut subtrees return bounds).
/// OUT[0] = bestScore, OUT[1] = count, then 5 i32 per move: fromR, fromC, toR,
/// toC, score (in generated order). Returns the count.
#[no_mangle]
pub extern "C" fn search_root(white_i: i32, depth: i32, tt_enabled_i: i32) -> i32 {
    let white = white_i != 0;
    let tt = tt_enabled_i != 0;
    if tt { ensure_zobrist(); tt_new_search(); }
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, tt, 0);
    let root = collect_root(&mut eng, white);

    let mut alpha = NEG_INF;
    let mut scored: Vec<(Move, i32)> = Vec::with_capacity(root.len());
    for ch in &root {
        let score;
        if ch.outcome == 1 {
            score = WIN_SCORE - 1;
        } else if ch.outcome == -1 {
            score = -(WIN_SCORE - 1);
        } else if depth == 1 {
            score = ch.key;
        } else {
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, tt);
            eng.hash ^= d;
            let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
            eng.unmake_move();
            eng.hash ^= d;
            score = s;
        }
        scored.push((*ch, score));
        if score > alpha { alpha = score; }
    }

    out_set(0, alpha);
    out_set(1, scored.len() as i32);
    let mut k = 2;
    for (m, s) in &scored {
        out_set(k, m.from_r); out_set(k + 1, m.from_c);
        out_set(k + 2, m.to_r); out_set(k + 3, m.to_c);
        out_set(k + 4, *s);
        k += 5;
    }
    scored.len() as i32
}

/// Final move selection when a deeper iteration is cut short by the clock. `scored`
/// holds the partial scores from the aborted iteration — a move's score is exact if
/// it raised alpha, an upper bound if it failed low. We simply play the
/// highest-scoring move: the best the deeper search found before time ran out, even
/// if it's a proven loss (in which case it's the longest-delaying one). We
/// deliberately do NOT steer away from known-loss moves toward not-yet-refuted
/// alternatives — those are UNSEARCHED and often turn out worse, so trading a
/// known long defence for an unverified move tends to LOSE FASTER, not survive. The
/// highest score is the better estimate. Ties go to the earliest move in root
/// (deeper-best-first) order; falls back to `prev_best` (the last completed depth's
/// pick) if the clock hit before any move was scored.
fn choose_on_abort(prev_best: Move, scored: &[(Move, i32, bool)]) -> Move {
    let mut best: Option<(Move, i32)> = None;
    for &(mv, s, _) in scored {
        if best.map_or(true, |(_, bs)| s > bs) { best = Some((mv, s)); }
    }
    best.map_or(prev_best, |(mv, _)| mv)
}

/// From–to square notation for a move, e.g. "q2-p2" — column letter a–t then the
/// row label (SIZE-row), matching the TS formatter. Used only to give per-depth
/// best-move *ties* a deterministic, human-meaningful order (alphabetical on this
/// string), independent of the random tie-break used to pick the played move.
fn move_notation(m: &Move) -> String {
    const COL: &[u8; 20] = b"abcdefghijklmnopqrst";
    format!(
        "{}{}-{}{}",
        COL[m.from_c as usize] as char, SIZE - m.from_r,
        COL[m.to_c as usize] as char, SIZE - m.to_r,
    )
}

/// Production search: iterative-deepening negamax with alpha-beta, mate-distance
/// scoring, random tie-break and a wall-clock budget. Mirrors getBestMove.
///
/// OUT layout (i32 words):
///   [0] found (1/0)
///   [1..5] fromR, fromC, toR, toC of the chosen move
///   [5] bestDepth
///   [6] bestScore
///   [7] totalMs
///   [8] nRoot (number of root moves)
///   [9] nDepth (completed depths)
///   then nDepth triples: depth, ms, cumMs
///   then a marker count nScored, then 6 i32 per scored move:
///        fromR, fromC, toR, toC, score, exactFlag  (best-first by score)
/// Returns found (1/0).
/// `tid` selects this (main) worker's scratch slice — 0 in every current caller.
/// `bump_gen` controls whether to start a fresh TT generation: pass 1 for a
/// standalone search; pass 0 in parallel mode, where the main worker calls
/// begin_search() once before launching the helpers so they share one generation.
#[no_mangle]
pub extern "C" fn best_move(
    white_i: i32, time_budget_ms: f64, tt_enabled_i: i32, tid: i32, bump_gen_i: i32,
) -> i32 {
    let white = white_i != 0;
    let tt = tt_enabled_i != 0;
    if tt && bump_gen_i != 0 { ensure_zobrist(); tt_new_search(); }
    STOP.store(0, Ordering::Relaxed); // main owns the run; clear any stale stop flag
    let (w, b) = read_board();
    let deadline = unsafe { now() } + time_budget_ms;
    let t_search = unsafe { now() };

    let mut eng = Engine::new(w, b, tt, tid as usize);
    let mut root = collect_root(&mut eng, white);
    if root.is_empty() {
        out_set(0, 0);
        return 0;
    }

    let mut best = root[0];
    let mut best_depth = 0;
    let mut depth_timings: Vec<(i32, i32, i32)> = Vec::new();
    // Per completed depth: the best move (ties broken alphabetically by notation)
    // and its score — purely for the diagnostics table.
    let mut depth_best: Vec<(Move, i32)> = Vec::new();
    let mut last_scored: Vec<(Move, i32, bool)> = Vec::new();
    // Partial scores from the *next*, uncompleted depth — the iteration the clock
    // aborted. Shown alongside the final move list and used as its sort key.
    let mut next_scored: Vec<(Move, i32, bool)> = Vec::new();
    let mut last_best = 0i32;

    let mut depth = 1;
    while depth <= MAX_DEPTH {
        let t_depth = unsafe { now() };
        eng.timed_out = false;

        // Phase 1 — alpha-beta over the root moves to find the exact best score.
        let mut alpha = NEG_INF;
        let mut scored: Vec<(Move, i32, bool)> = Vec::with_capacity(root.len());
        let mut aborted = false;
        for ch in &root {
            let score;
            let exact;
            if ch.outcome == 1 {
                score = WIN_SCORE - 1; exact = true;
            } else if ch.outcome == -1 {
                score = -(WIN_SCORE - 1); exact = true;
            } else if depth == 1 {
                score = ch.key; exact = true;
            } else {
                let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, tt);
                eng.hash ^= d;
                let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, deadline);
                eng.unmake_move();
                eng.hash ^= d;
                if eng.timed_out { aborted = true; break; }
                score = s; exact = false;
            }
            scored.push((*ch, score, exact));
            if score > alpha { alpha = score; }
        }
        if aborted { best = choose_on_abort(best, &scored); next_scored = scored; break; }
        let mut best_score = alpha;

        // Phase 2 — re-search each move tied at best_score with a FULL window to
        // pin down its EXACT value. Phase 1 searches each root move with the narrow
        // window (NEG_INF, -alpha), so a move that fails low only gets a loose
        // UPPER BOUND: a move that is actually lost can come back merely TYING
        // best_score (in a lost position the real best is itself negative). Such a
        // move would then be played by the tie-break, or — surviving the prune on
        // its loose score — be picked from the root by choose_on_abort on a later
        // abort. (This is exactly how f3-e4, a mate-in-2, tied l7-i7 at -17: the
        // lazy MVV ordering sorts the ring-breaking refutation late, so white's
        // reply node cuts off on a louder move and never proves the loss under the
        // narrow window.) A full-window PV re-search exposes the true value; we
        // rewrite the score so genuine co-best moves are kept while disguised losses
        // drop out of the candidate pool AND are pruned from the root below. Cheap:
        // only the few moves tied at the top, over a TT already warmed by phase 1.
        let full_beta = -NEG_INF;
        for i in 0..scored.len() {
            if scored[i].1 != best_score || scored[i].2 { continue; }
            let ch = scored[i].0;
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, tt);
            eng.hash ^= d;
            let v = -eng.search(!white, depth - 1, NEG_INF, full_beta, 1, deadline);
            eng.unmake_move();
            eng.hash ^= d;
            if eng.timed_out { aborted = true; break; }
            scored[i].1 = v;     // replace the loose phase-1 bound with the exact value
            scored[i].2 = true;
        }
        // Phase 1 completed here, so `scored` holds a full set of next-depth scores
        // (every move's value at this depth is known) — choose_on_abort then has
        // complete win/loss information to act on.
        if aborted { best = choose_on_abort(best, &scored); next_scored = scored; break; }
        // The genuine best is the max over the refined scores: the real PV move
        // still holds best_score, while any move that only tied it via a loose
        // fail-low bound has now dropped below.
        best_score = scored.iter().map(|s| s.1).max().unwrap();
        let mut candidates: Vec<Move> = Vec::new();
        for (ch, score, _) in &scored {
            if *score == best_score { candidates.push(*ch); }
        }
        if candidates.is_empty() { candidates.push(root[0]); }

        let mut idx = (unsafe { random() } * candidates.len() as f64) as usize;
        if idx >= candidates.len() { idx = candidates.len() - 1; }
        let chosen = candidates[idx];
        best = chosen;
        best_depth = depth;

        depth_timings.push((
            depth,
            (unsafe { now() } - t_depth).round() as i32,
            (unsafe { now() } - t_search).round() as i32,
        ));
        // Best move at this depth for the diagnostics table: among the tied-best
        // moves, the alphabetically-first by notation (deterministic, regardless
        // of the random pick that becomes `chosen`).
        let top = *candidates.iter()
            .min_by(|a, b| move_notation(a).cmp(&move_notation(b)))
            .unwrap();
        depth_best.push((top, best_score));
        last_best = best_score;

        // A forced win/loss won't change with more depth — stop early. `best` holds
        // the chosen move already; in a fully-lost position (best_score itself a loss)
        // that's the longest-delaying loss, since mate-distance scores a later loss
        // higher. Checked before the prune below so the best move always survives it.
        if best_score >= WIN_SCORE - MAX_DEPTH || best_score <= -(WIN_SCORE - MAX_DEPTH) {
            last_scored = scored;
            break;
        }

        // Re-order the root best-first by this depth's scores so the next, deeper
        // iteration searches the most promising moves first (sharper cutoffs; the
        // stable sort keeps ties in order, then the chosen best is pulled to the
        // front to seed alpha). Also DROP any move proven to be a forced loss: a
        // terminal ring-loss can't recover with more depth, so re-searching it at the
        // next (costlier) depth is wasted. `scored[i].1` is an upper bound on the true
        // value, so `<= -(WIN-MAX)` is a genuine loss; the early-out above guarantees
        // best_score is not a loss, so at least the chosen move always remains.
        let mut order: Vec<usize> = (0..root.len()).collect();
        order.sort_by(|&a, &b| scored[b].1.cmp(&scored[a].1));
        root = order.iter()
            .filter(|&&i| scored[i].1 > -(WIN_SCORE - MAX_DEPTH))
            .map(|&i| root[i])
            .collect();
        if let Some(pos) = root.iter().position(|m| *m == chosen) {
            if pos > 0 {
                let c = root.remove(pos);
                root.insert(0, c);
            }
        }
        last_scored = scored;

        if unsafe { now() } >= deadline { break; }
        depth += 1;
    }

    // ── Write the result + diagnostics ──
    let total_ms = (unsafe { now() } - t_search).round() as i32;
    out_set(0, 1);
    out_set(1, best.from_r); out_set(2, best.from_c);
    out_set(3, best.to_r); out_set(4, best.to_c);
    out_set(5, best_depth);
    out_set(6, last_best);
    out_set(7, total_ms);
    out_set(8, root.len() as i32);
    out_set(9, depth_timings.len() as i32);
    let mut k = 10;
    // Per depth: timing triple, then this depth's best move (4 coords) + score.
    for (i, (d, ms, cum)) in depth_timings.iter().enumerate() {
        let (m, sc) = depth_best[i];
        out_set(k, *d); out_set(k + 1, *ms); out_set(k + 2, *cum);
        out_set(k + 3, m.from_r); out_set(k + 4, m.from_c);
        out_set(k + 5, m.to_r); out_set(k + 6, m.to_c);
        out_set(k + 7, sc);
        k += 8;
    }
    out_set(k, last_scored.len() as i32);
    k += 1;
    // Each final-depth move's score at the *next*, uncompleted depth (reached
    // before the clock aborted that iteration), aligned to last_scored. NEG_INF
    // marks a move that wasn't reached at the next depth.
    let next_aligned: Vec<i32> = last_scored.iter().map(|(m, _, _)| {
        next_scored.iter().find(|(nm, _, _)| nm == m).map_or(NEG_INF, |(_, ns, _)| *ns)
    }).collect();
    // Order by the next depth's score (descending; unreached moves sort last),
    // ties broken by this completed depth's score — stable, so equal-on-both
    // keep generated order.
    let mut order: Vec<usize> = (0..last_scored.len()).collect();
    order.sort_by(|&i, &j| {
        next_aligned[j].cmp(&next_aligned[i])
            .then_with(|| last_scored[j].1.cmp(&last_scored[i].1))
    });
    for &i in &order {
        let (m, s, ex) = last_scored[i];
        out_set(k, m.from_r); out_set(k + 1, m.from_c);
        out_set(k + 2, m.to_r); out_set(k + 3, m.to_c);
        out_set(k + 4, s); out_set(k + 5, if ex { 1 } else { 0 });
        out_set(k + 6, next_aligned[i]);
        k += 7;
    }
    1
}

/// Iterative-deepening phase-1 search to a fixed depth (no time limit, no random
/// pick), sharing the transposition table across depths — the realistic path the
/// engine uses to "reach N plies". Returns the final depth's bestScore (also in
/// OUT[0]). Used for the TT benchmark and as a verification surface: the result
/// must equal search_root(max_depth) for the same position.
#[no_mangle]
pub extern "C" fn search_to_depth(white_i: i32, max_depth: i32, tt_enabled_i: i32) -> i32 {
    let white = white_i != 0;
    let tt = tt_enabled_i != 0;
    if tt { ensure_zobrist(); tt_new_search(); }
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, tt, 0);
    let root = collect_root(&mut eng, white);

    let mut final_best = NEG_INF;
    let mut depth = 1;
    while depth <= max_depth {
        let mut alpha = NEG_INF;
        for ch in &root {
            let score;
            if ch.outcome == 1 {
                score = WIN_SCORE - 1;
            } else if ch.outcome == -1 {
                score = -(WIN_SCORE - 1);
            } else if depth == 1 {
                score = ch.key;
            } else {
                let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, tt);
                eng.hash ^= d;
                let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
                eng.unmake_move();
                eng.hash ^= d;
                score = s;
            }
            if score > alpha { alpha = score; }
        }
        final_best = alpha;
        depth += 1;
    }
    out_set(0, final_best);
    final_best
}

// ─── Parallel (Lazy SMP) coordination ────────────────────────────────────────
// The main worker calls begin_search() once (initialising the Zobrist keys, a
// fresh TT generation, and clearing STOP) BEFORE launching the helper workers,
// then runs best_move(.., bump_gen = 0). Each helper, on its own private shadow
// stack, runs search_helper() to pound on the shared TT. When the main worker's
// search ends it calls stop_search() and the helpers unwind.

/// Initialise a parallel search. Must be called by the main worker, and must
/// complete before any helper starts (the Release pairs with the Acquire load in
/// search_helper, so the helpers observe the Zobrist keys and the generation).
#[no_mangle]
pub extern "C" fn begin_search() {
    ensure_zobrist();
    tt_new_search();
    STOP.store(0, Ordering::Release);
}

/// Signal all workers to stop (called by the main worker once its search ends).
#[no_mangle]
pub extern "C" fn stop_search() {
    STOP.store(1, Ordering::Release);
}

/// Verification only: a deterministic fixed-depth search over the SHARED TT that
/// does NOT bump the generation (begin_search already did). Run on the main
/// worker while helpers concurrently pound the same table, its bestScore must
/// still equal the oracle's depth-`max_depth` value — proving the lockless TT
/// never lets a concurrent write corrupt the minimax result. INFINITY deadline →
/// the time/STOP check is skipped, so the value is order-independent.
#[no_mangle]
pub extern "C" fn search_fixed_shared(white_i: i32, max_depth: i32, tid: i32) -> i32 {
    let white = white_i != 0;
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, true, tid as usize);
    let root = collect_root(&mut eng, white);
    let mut final_best = NEG_INF;
    let mut depth = 1;
    while depth <= max_depth {
        let mut alpha = NEG_INF;
        for ch in &root {
            let score;
            if ch.outcome == 1 { score = WIN_SCORE - 1; }
            else if ch.outcome == -1 { score = -(WIN_SCORE - 1); }
            else if depth == 1 { score = ch.key; }
            else {
                let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
                eng.hash ^= d;
                let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
                eng.unmake_move();
                eng.hash ^= d;
                score = s;
            }
            if score > alpha { alpha = score; }
        }
        final_best = alpha;
        depth += 1;
    }
    out_set(0, final_best);
    final_best
}

/// Helper-worker search: iterative-deepening negamax on the root, purely to warm
/// the shared TT (its result is discarded — the main worker owns the move). Each
/// helper rotates the root move order by its thread id so the workers diverge and
/// fill the table broadly. Allocation-free, so it never touches the shared heap.
#[no_mangle]
pub extern "C" fn search_helper(white_i: i32, time_budget_ms: f64, tid: i32) -> i32 {
    // Acquire-load pairs with begin_search()'s Release store: makes the Zobrist
    // keys and the current generation written by the main worker visible here.
    STOP.load(Ordering::Acquire);
    let white = white_i != 0;
    let tid = tid as usize;
    let deadline = unsafe { now() } + time_budget_ms;
    let (w, b) = read_board();

    let mut eng = Engine::new(w, b, true, tid);
    // Root moves stay parked at the bottom of the arena for the whole search; the
    // recursion bumps above them (arena_top is left at rcount, never reset to 0).
    let (rstart, rcount) = eng.gen_moves(white, false);
    if rcount == 0 { return 0; }
    let base = arena_ptr(tid);
    let rot = tid % rcount;

    let mut depth = 1;
    while depth <= MAX_DEPTH {
        eng.timed_out = false;
        let mut alpha = NEG_INF;
        for j in 0..rcount {
            if unsafe { now() } >= deadline || STOP.load(Ordering::Relaxed) != 0 { return 0; }
            let ch = unsafe { *base.add(rstart + (j + rot) % rcount) };
            if ch.outcome == 1 || ch.outcome == -1 { continue; } // terminal: nothing to deepen
            if depth > 1 {
                let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
                eng.hash ^= d;
                let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, deadline);
                eng.unmake_move();
                eng.hash ^= d;
                if eng.timed_out { return 0; }
                if s > alpha { alpha = s; }
            } else if ch.key > alpha {
                alpha = ch.key;
            }
        }
        depth += 1;
    }
    0
}

/// Verification only: run a deterministic fixed-depth search with per-node hash
/// self-checking on, and return the number of nodes where the incrementally
/// maintained Zobrist hash disagreed with a fresh recompute. Must be 0.
#[no_mangle]
pub extern "C" fn hash_check_run(white_i: i32, max_depth: i32) -> i32 {
    ensure_zobrist();
    tt_new_search();
    HASH_MISMATCH.store(0, Ordering::Relaxed);
    let white = white_i != 0;
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, true, 0);
    eng.hash_check = true;
    let root = collect_root(&mut eng, white);
    let mut depth = 1;
    while depth <= max_depth {
        let mut alpha = NEG_INF;
        for ch in &root {
            if ch.outcome == 1 || ch.outcome == -1 { continue; }
            if depth == 1 { if ch.key > alpha { alpha = ch.key; } continue; }
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
            eng.hash ^= d;
            let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
            eng.unmake_move();
            eng.hash ^= d;
            if s > alpha { alpha = s; }
        }
        depth += 1;
    }
    let m = HASH_MISMATCH.load(Ordering::Relaxed) as i32;
    out_set(0, m);
    m
}

/// Toggle incremental ring tracking in make/unmake (default on). Off routes the
/// hot path back to no ring maintenance, for A/B measuring the tracking cost.
#[no_mangle]
pub extern "C" fn set_ring_track(v: i32) { RING_TRACK.store(v != 0, Ordering::Relaxed); }

/// Verification only: run a deterministic fixed-depth search with per-node ring
/// self-checking on (incremental masks/totals vs a fresh scan), returning the
/// number of nodes where they disagreed. Must be 0.
#[no_mangle]
pub extern "C" fn ring_check_run(white_i: i32, max_depth: i32) -> i32 {
    ensure_zobrist();
    tt_new_search();
    RING_MISMATCH.store(0, Ordering::Relaxed);
    RING_TRACK.store(true, Ordering::Relaxed); // self-check is meaningless without maintenance
    let white = white_i != 0;
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, true, 0);
    eng.ring_check = true;
    let root = collect_root(&mut eng, white);
    let mut depth = 1;
    while depth <= max_depth {
        let mut alpha = NEG_INF;
        for ch in &root {
            if ch.outcome == 1 || ch.outcome == -1 { continue; }
            if depth == 1 { if ch.key > alpha { alpha = ch.key; } continue; }
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
            eng.hash ^= d;
            let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
            eng.unmake_move();
            eng.hash ^= d;
            if s > alpha { alpha = s; }
        }
        depth += 1;
    }
    let m = RING_MISMATCH.load(Ordering::Relaxed) as i32;
    out_set(0, m);
    m
}

/// Benchmark only: run a finite-deadline iterative-deepening search (TT on, the
/// production-style timed path that actually calls now()) and return the total
/// node count. More nodes in a fixed budget ⇒ faster per node — used to measure
/// the wall-clock throttle.
#[no_mangle]
pub extern "C" fn bench_timed(white_i: i32, budget_ms: f64) -> i32 {
    ensure_zobrist();
    tt_new_search();
    STOP.store(0, Ordering::Relaxed);
    let white = white_i != 0;
    let deadline = unsafe { now() } + budget_ms;
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, true, 0);
    let root = collect_root(&mut eng, white);
    if root.is_empty() { return 0; }
    let mut depth = 1;
    let mut completed = 0;
    while depth <= MAX_DEPTH {
        eng.timed_out = false;
        let mut alpha = NEG_INF;
        let mut aborted = false;
        for ch in &root {
            if ch.outcome == 1 || ch.outcome == -1 { continue; }
            if depth == 1 { if ch.key > alpha { alpha = ch.key; } continue; }
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
            eng.hash ^= d;
            let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, deadline);
            eng.unmake_move();
            eng.hash ^= d;
            if eng.timed_out { aborted = true; break; }
            if s > alpha { alpha = s; }
        }
        if aborted { break; }
        completed = depth;
        if unsafe { now() } >= deadline { break; }
        depth += 1;
    }
    out_set(1, completed); // depth fully completed within the budget
    eng.nodes as i32
}

/// Benchmark only: fixed-depth iterative-deepening search (lazy, no time limit),
/// returning the total node count. Deterministic (no time limit) and exact, so
/// it's the clean way to A/B a change's node count or per-node time at a fixed
/// depth (the eval is byte-identical, so the node count is invariant).
#[no_mangle]
pub extern "C" fn bench_fixed(white_i: i32, max_depth: i32) -> i32 {
    ensure_zobrist();
    tt_new_search();
    STOP.store(0, Ordering::Relaxed);
    let white = white_i != 0;
    let (w, b) = read_board();
    let mut eng = Engine::new(w, b, true, 0);
    let root = collect_root(&mut eng, white);
    let mut depth = 1;
    while depth <= max_depth {
        let mut alpha = NEG_INF;
        for ch in &root {
            if ch.outcome == 1 || ch.outcome == -1 { continue; }
            if depth == 1 { if ch.key > alpha { alpha = ch.key; } continue; }
            let d = eng.make_move(ch.from_r, ch.from_c, ch.to_r, ch.to_c, white, true);
            eng.hash ^= d;
            let s = -eng.search(!white, depth - 1, NEG_INF, -alpha, 1, f64::INFINITY);
            eng.unmake_move();
            eng.hash ^= d;
            if s > alpha { alpha = s; }
        }
        depth += 1;
    }
    eng.nodes as i32
}
