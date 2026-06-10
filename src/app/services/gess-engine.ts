// ─────────────────────────────────────────────────────────────────────────────
// Pure Gess engine — framework-free game logic and AI search.
//
// Shared by GessService (game/move logic) and the AI Web Worker (the search).
// Everything here is a pure function of its arguments, so it can run on either
// the main thread or a worker thread interchangeably. No Angular imports.
// ─────────────────────────────────────────────────────────────────────────────

import { Board, Cell, Player, Position } from '../models/game.model';

// Gess is played on a 20×20 grid. The playing area is the inner 18×18
// (indices 1‑18); the outermost ring (indices 0 and 19) is the invisible
// "border" — any stone that lands there at the end of a move is removed.
export const SIZE = 20;
export const MIN = 1;   // first playing-area index
export const MAX = 18;  // last playing-area index

// [dr, dc] for each of the 8 footprint positions relative to center
const DIRS: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0,  -1],          [0,  1],
  [1,  -1], [1,  0], [1,  1],
];

// ─── AI search parameters ──────────────────────────────────────────────────
export const WIN_SCORE = 1_000_000;   // magnitude of a forced win/loss (≫ any static eval)
export const TIME_BUDGET_MS = 10_000; // iterative-deepening wall-clock budget per move
const MAX_DEPTH = 64;                 // safety cap on iterative deepening

// Thrown to unwind the search when the time budget is exhausted.
const SEARCH_TIMEOUT = Symbol('search-timeout');

/** Result of an AI search: the chosen move plus the deepest depth completed. */
export interface AiMove {
  from: Position;
  to: Position;
  depth: number;
}

// ─── Move logic ──────────────────────────────────────────────────────────────

/**
 * Returns true iff the 3×3 centered at (row,col) is a legal footprint for player.
 * The centre may be anywhere on the 20×20 grid — including the border ring
 * (indices 0 and 19) — so a piece can be centred just off the playing area, with
 * the rest of its footprint hanging into the empty margin (cells outside 0..19).
 */
export function isValidFootprintCenter(row: number, col: number, board: Board, player: Player): boolean {
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return false;
  const opp: Player = player === 'white' ? 'black' : 'white';
  let hasOwn = false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr, c = col + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin is empty
      const cell = board[r][c];
      if (cell === opp) return false;
      if (cell === player) hasOwn = true;
    }
  }
  return hasOwn;
}

/** Returns all legal destination centers for a footprint centered at `center`. */
export function getValidMoves(board: Board, center: Position, player: Player): Position[] {
  const { row, col } = center;
  // Centre stone → unlimited range; otherwise max 3 squares
  const maxSteps = board[row][col] === player ? SIZE : 3;
  const results: Position[] = [];
  const seen = new Set<string>();

  // The original 3×3 footprint is treated as empty: the piece moves away from here.
  const origin = new Set<string>();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++)
      origin.add(`${row + ddr},${col + ddc}`);

  for (const [dr, dc] of DIRS) {
    // The footprint cell in this direction must hold the player's stone. For a
    // border-centred piece that cell can be off-board (margin) → no stone.
    const fr = row + dr, fc = col + dc;
    if (fr < 0 || fr >= SIZE || fc < 0 || fc >= SIZE) continue;
    if (board[fr][fc] !== player) continue;

    for (let step = 1; step <= maxSteps; step++) {
      const nr = row + dr * step;
      const nc = col + dc * step;
      // A piece may move partially — but not entirely — off the board. The
      // centre may move one square past the playing area (onto the border
      // ring), leaving a single rank/file on the board; moving the centre any
      // further would carry the whole footprint off.
      if (nr < MIN - 1 || nr > MAX + 1 || nc < MIN - 1 || nc > MAX + 1) break;

      // Scan the new footprint for any stone not belonging to the original piece.
      // Any such stone — own or opponent — stops further sliding; the piece may
      // still land here, displacing whatever is there (including own stones).
      // Cells off the playing area (the border and beyond) are always empty.
      let hitsAny = false;
      outer:
      for (let ddr = -1; ddr <= 1; ddr++) {
        for (let ddc = -1; ddc <= 1; ddc++) {
          const sr = nr + ddr, sc = nc + ddc;
          if (origin.has(`${sr},${sc}`)) continue; // transparent: original footprint
          if (sr < MIN || sr > MAX || sc < MIN || sc > MAX) continue; // off-board: empty
          if (board[sr][sc] !== null) { hitsAny = true; break outer; }
        }
      }

      const key = `${nr},${nc}`;
      if (!seen.has(key)) { seen.add(key); results.push({ row: nr, col: nc }); }

      if (hitsAny) break; // first intersection: land here (displacing stones), stop sliding
    }
  }
  return results;
}

/** Returns the board that results from moving the footprint at `from` to `to`. */
export function applyMove(board: Board, from: Position, to: Position, player: Player): Board {
  const b: Cell[][] = board.map(r => [...r]);
  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));

  // Record which relative positions held player stones, then clear the footprint
  const relStones: [number, number][] = [];
  for (let ddr = -1; ddr <= 1; ddr++) {
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin
      if (b[r][c] === player) { relStones.push([ddr, ddc]); b[r][c] = null; }
    }
  }

  // Slide step by step, displacing any stone (own or opponent) at the landing footprint.
  // Intermediate steps are guaranteed empty by getValidMoves; only the final step may have stones.
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && b[r][c] !== null)
          b[r][c] = null;
      }
    }
  }

  // Place stones at destination. Stones that land on the border ring (the
  // invisible outermost row/column, indices 0 and 19) are removed — the rest stay.
  for (const [ddr, ddc] of relStones) {
    const r = to.row + ddr, c = to.col + ddc;
    if (r >= MIN && r <= MAX && c >= MIN && c <= MAX) b[r][c] = player;
  }

  return b;
}

/**
 * Counts the stones captured by moving the footprint at `from` to `to`: stones
 * displaced where the piece lands, split into opponent (`opp`) and the mover's
 * own (`self`). The moving piece's own stones (lifted from the origin) are not
 * captures, and neither are its stones that fall off the board edge — only
 * stones standing at the destination that get displaced count.
 */
export function countCaptures(
  board: Board, from: Position, to: Position, player: Player,
): { opp: number; self: number } {
  const opponent: Player = player === 'white' ? 'black' : 'white';

  // The moving piece's own stones, by absolute origin coordinate — these travel
  // with the piece, so they are never "captured".
  const lifted = new Set<string>();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin
      if (board[r][c] === player) lifted.add(`${r},${c}`);
    }

  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));

  let opp = 0, self = 0;
  const counted = new Set<string>();
  // Intermediate steps are guaranteed empty by getValidMoves, so in practice
  // only the destination footprint contributes; the path scan is just robust.
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
        const key = `${r},${c}`;
        if (lifted.has(key) || counted.has(key)) continue;
        const cell = board[r][c];
        if (cell === opponent) { opp++; counted.add(key); }
        else if (cell === player) { self++; counted.add(key); }
      }
    }
  }
  return { opp, self };
}

// ─── Ring detection ────────────────────────────────────────────────────────
// A ring is a 3×3 footprint whose centre cell is empty and all 8 surrounding
// cells contain the player's own stone.

export function hasRing(board: Board, player: Player): boolean {
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) return true;
  return false;
}

export function countRings(board: Board, player: Player): number {
  let count = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) count++;
  return count;
}

/** Number of stones `player` has on the board. */
export function countStones(board: Board, player: Player): number {
  let n = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (board[r][c] === player) n++;
  return n;
}

// ─── No-capture draw rule ────────────────────────────────────────────────────
// If neither side captures a stone for this many consecutive turns (each
// player's move counts as one turn), the game is drawn — a "no progress" rule.
export const NO_CAPTURE_DRAW_LIMIT = 20;

/** The total number of stones on the board (both colours). */
export function totalStones(board: Board): number {
  return countStones(board, 'white') + countStones(board, 'black');
}

/**
 * Did a move remove any stone from the board? True iff the post-move board has
 * fewer total stones than the pre-move board. This counts every kind of removal
 * — capturing an opponent stone, displacing one of your own at the destination,
 * or pushing one of your own off the board edge (a self-capture) — so any of
 * them resets the no-capture streak.
 */
export function wasCapture(before: Board, after: Board): boolean {
  return totalStones(after) < totalStones(before);
}

/** Outcome of the position after a move, from the mover's point of view. */
export type Outcome = 'mover-wins' | 'mover-loses' | 'both-lose' | 'draw' | 'ongoing';

/**
 * Decide the game outcome after the mover has played, given the post-move ring
 * counts and the resulting no-capture streak (the count of consecutive turns,
 * including this one, that ended without a capture).
 *
 * Win/loss by ring count takes STRICT PRECEDENCE over the no-capture draw: a
 * move that empties a side's rings on the very turn the draw limit is reached is
 * decisive, not a draw. So the ring checks are evaluated before the streak.
 *   - mover has no rings, opponent has none → both lost; the mover moved last,
 *     so the mover loses (`both-lose`);
 *   - mover has no rings → mover destroyed their own last ring → `mover-loses`;
 *   - opponent has no rings → `mover-wins`;
 *   - otherwise, streak ≥ limit → `draw`; else `ongoing`.
 */
export function resolveOutcome(
  moverRings: number, oppRings: number, noCaptureStreak: number,
): Outcome {
  if (moverRings === 0 && oppRings === 0) return 'both-lose';
  if (moverRings === 0) return 'mover-loses';
  if (oppRings === 0) return 'mover-wins';
  if (noCaptureStreak >= NO_CAPTURE_DRAW_LIMIT) return 'draw';
  return 'ongoing';
}

/** Returns the set of ring-centre cells for `player` (one cell per ring). */
export function getEnclosedCells(board: Board, player: Player): Set<string> {
  const centres = new Set<string>();
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) centres.add(`${r},${c}`);
  return centres;
}

/** True iff (row, col) is the centre of a ring: empty centre, all 8 neighbours owned by player. */
function isRingCenter(board: Board, row: number, col: number, player: Player): boolean {
  if (board[row][col] !== null) return false; // centre must be empty
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if ((dr !== 0 || dc !== 0) && board[row + dr][col + dc] !== player) return false;
  return true;
}

// ─── Initial position ────────────────────────────────────────────────────────

export function makeBoard(): Board {
  const board: Board = Array.from({ length: SIZE }, () => new Array<Cell>(SIZE).fill(null));

  // Standard Gess starting position — 43 stones per player, 1 ring each.
  // Coordinates are in the 20×20 grid: the 18×18 playing area is indices 1‑18.
  // White occupies playing rows 1,2,3,6 (labels 19,18,17,14); black is the
  // vertical mirror at rows 18,17,16,13 (i.e. row 19 − whiteRow).
  const whiteCols: [number, number[]][] = [
    [1, [2,4,6,7,8,9,10,11,12,13,15,17]],          // label 18 — 12 stones
    [2, [1,2,3,5,7,8,9,10,12,14,16,17,18]],         // label 17 — 13 stones
    [3, [2,4,6,7,8,9,10,11,12,13,15,17]],           // label 16 — 12 stones
    [6, [2,5,8,11,14,17]],                          // label 13 —  6 stones
  ];

  for (const [r, cols] of whiteCols) {
    for (const c of cols) {
      board[r][c]      = 'white';
      board[19 - r][c] = 'black'; // black is the vertical mirror
    }
  }

  return board;
}

// ─── AI search ───────────────────────────────────────────────────────────────

// ── Bitboard representation ──────────────────────────────────────────────────
// The search runs on bitboards: two Int32Arrays of 20 row masks, where bit c of
// row r marks a stone at column c. The 20×20 grid uses bits 0..19; the playing
// area is rows/cols 1..18 and the border ring is 0 and 19. This is far cheaper
// than the Cell[][] form in the hot move-generation / evaluation loop. The
// Cell[][] functions above remain the UI/game representation (used once per real
// move) and serve as the correctness oracle for the bitboard code.

const PLAY_MASK = 0x7FFFE; // columns 1..18

// COL3[c] = mask of columns {c-1, c, c+1} clamped to [0,19].
const COL3: number[] = (() => {
  const t = new Array<number>(SIZE);
  for (let c = 0; c < SIZE; c++) {
    let m = 1 << c;
    if (c > 0) m |= 1 << (c - 1);
    if (c < SIZE - 1) m |= 1 << (c + 1);
    t[c] = m;
  }
  return t;
})();

interface BB { w: Int32Array; b: Int32Array; }

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

function bbFromBoard(board: Board): BB {
  const w = new Int32Array(SIZE), b = new Int32Array(SIZE);
  for (let r = 0; r < SIZE; r++) {
    const row = board[r];
    for (let c = 0; c < SIZE; c++) {
      const cell = row[c];
      if (cell === 'white') w[r] |= 1 << c;
      else if (cell === 'black') b[r] |= 1 << c;
    }
  }
  return { w, b };
}

interface BbCounts {
  wR: number; bR: number; wS: number; bS: number;
  // "Deepest" advancement toward the opponent's back row. White advances toward
  // higher rows (depth = row − 1), black toward lower rows (depth = 18 − row);
  // both measured from the player's own back edge of the playing area.
  wDeep: number; bDeep: number;
}

// Number of `player` ring centres in row r (empty centre, 8 like-coloured
// neighbours): row above/below need cols c-1,c,c+1; same row needs c-1,c+1.
function rowRingMaskW(w: Int32Array, b: Int32Array, r: number): number {
  const wu = w[r - 1], wm = w[r], wd = w[r + 1], empty = ~(w[r] | b[r]);
  return (wu & (wu << 1) & (wu >>> 1)) & ((wm << 1) & (wm >>> 1)) &
    (wd & (wd << 1) & (wd >>> 1)) & empty & PLAY_MASK;
}
function rowRingMaskB(w: Int32Array, b: Int32Array, r: number): number {
  const bu = b[r - 1], bm = b[r], bd = b[r + 1], empty = ~(w[r] | b[r]);
  return (bu & (bu << 1) & (bu >>> 1)) & ((bm << 1) & (bm >>> 1)) &
    (bd & (bd << 1) & (bd >>> 1)) & empty & PLAY_MASK;
}
// Weighted ring count for one row, in tenths of a ring: 1.0 (=10) per ring, but
// only 0.7 (=7) when another ring shares its row two files to the left (midpoint
// at column c-2). `m & (m << 2)` selects each ring that has a ring two columns
// lower, so the total is 10·(rings) − 3·(such rings).
function ringWeight(m: number): number {
  return 10 * popcount(m) - 3 * popcount(m & (m << 2));
}
function rowRingW(w: Int32Array, b: Int32Array, r: number): number {
  return ringWeight(rowRingMaskW(w, b, r));
}
function rowRingB(w: Int32Array, b: Int32Array, r: number): number {
  return ringWeight(rowRingMaskB(w, b, r));
}

// ── Ring-safety heuristic ────────────────────────────────────────────────────
// A cheap static term: enemy stones pressing the 5×5 box around each ring centre
// (which, since a ring's inner 3×3 holds only the owner's stones, counts exactly
// the enemy stones on the ring's outer boundary). It penalises having your own
// rings under pressure and rewards pressuring the opponent's. This is a static
// nudge only — actual ring captures are resolved by the search (worth ±WIN_SCORE);
// this just biases leaf evaluations past the search horizon toward safer rings.
// Kept well below a stone (100) so it never overrides material; tune via RING_SAFETY_K.
const RING_SAFETY_K = 10;

/** Enemy pressure on each side's rings: pW = black stones in the 5×5 box around
 *  white's ring centres, pB = white stones around black's. */
function ringPressure(w: Int32Array, b: Int32Array): { pW: number; pB: number } {
  let pW = 0, pB = 0;
  for (let r = MIN; r <= MAX; r++) {
    const mw = rowRingMaskW(w, b, r);
    if (mw) {
      const band = mw | (mw << 1) | (mw >>> 1) | (mw << 2) | (mw >>> 2);
      for (let rr = r - 2; rr <= r + 2; rr++)
        if (rr >= 0 && rr < SIZE) pW += popcount(b[rr] & band);
    }
    const mb = rowRingMaskB(w, b, r);
    if (mb) {
      const band = mb | (mb << 1) | (mb >>> 1) | (mb << 2) | (mb >>> 2);
      for (let rr = r - 2; rr <= r + 2; rr++)
        if (rr >= 0 && rr < SIZE) pB += popcount(w[rr] & band);
    }
  }
  return { pW, pB };
}

/** Ring-safety term from the mover's perspective (reward pressuring the
 *  opponent's rings, penalise pressure on your own). */
function ringSafety(w: Int32Array, b: Int32Array, white: boolean): number {
  const { pW, pB } = ringPressure(w, b);
  return RING_SAFETY_K * (white ? pB - pW : pW - pB);
}

// Deepest advancement (edge scan): white's frontmost is near MAX, black's near
// MIN, so these scans are short in practice and always exact.
function whiteDeepest(w: Int32Array): number {
  for (let r = MAX; r >= MIN; r--) if (w[r] & PLAY_MASK) return r - 1;
  return 0;
}
function blackDeepest(b: Int32Array): number {
  for (let r = MIN; r <= MAX; r++) if (b[r] & PLAY_MASK) return MAX - r;
  return 0;
}

// Per-row counts of the *parent* position, filled once per genMoves call so each
// child's eval can be updated over only the rows its move changed.
const pRowRingW = new Int32Array(SIZE);
const pRowRingB = new Int32Array(SIZE);
const pRowStoneW = new Int32Array(SIZE);
const pRowStoneB = new Int32Array(SIZE);

/** Full ring/stone/deepest analysis; also caches per-row counts in the scratch. */
function analyzeFill(w: Int32Array, b: Int32Array): BbCounts {
  let wR = 0, bR = 0, wS = 0, bS = 0;
  for (let r = MIN; r <= MAX; r++) {
    const rw = rowRingW(w, b, r), rb = rowRingB(w, b, r);
    const sw = popcount(w[r] & PLAY_MASK), sb = popcount(b[r] & PLAY_MASK);
    pRowRingW[r] = rw; pRowRingB[r] = rb; pRowStoneW[r] = sw; pRowStoneB[r] = sb;
    wR += rw; bR += rb; wS += sw; bS += sb;
  }
  return { wR, bR, wS, bS, wDeep: whiteDeepest(w), bDeep: blackDeepest(b) };
}

/**
 * Static evaluation from the mover's perspective:
 *   100·[(myRings − oppRings)·7 + (myStones − oppStones)] + (myDeepest − oppDeepest)
 * The ×100 keeps ring/stone balance dominant; the depth term is a small tie-break
 * that rewards advancing a stone toward the opponent's back row.
 */
function evalOf(a: BbCounts, white: boolean): number {
  const myR = white ? a.wR : a.bR, opR = white ? a.bR : a.wR;
  const myS = white ? a.wS : a.bS, opS = white ? a.bS : a.wS;
  const myD = white ? a.wDeep : a.bDeep, opD = white ? a.bDeep : a.wDeep;
  // Ring counts are in tenths of a ring (see ringWeight), so the ring term is
  // ×7×100/10 = ×70; stone and deepest terms are unchanged.
  return 100 * (myS - opS) + 70 * (myR - opR) + (myD - opD);
}

interface Move {
  fromR: number; fromC: number; toR: number; toC: number;
  outcome: number; // 1 = mover wins, −1 = mover loses own last ring, 0 = continue
  key: number;     // static eval from the mover's perspective
}

// ── Make / unmake ────────────────────────────────────────────────────────────
// The search mutates a single bitboard in place and undoes moves afterwards,
// avoiding a board copy per child. A move only ever changes the origin and
// destination 3×3 footprints (intermediate path cells are empty by move-gen
// invariant), so unmake just restores those ≤6 rows. The undo records live in
// preallocated, recursion-indexed buffers (no per-move allocation).
const UNDO_FRAMES = MAX_DEPTH + 8;
const UNDO_CAP = 6; // rows a move can touch: origin (3) + destination (3)
const undoRow = new Int32Array(UNDO_FRAMES * UNDO_CAP);
const undoW = new Int32Array(UNDO_FRAMES * UNDO_CAP);
const undoB = new Int32Array(UNDO_FRAMES * UNDO_CAP);
const undoN = new Int32Array(UNDO_FRAMES);
let undoSp = 0;

function makeMove(
  w: Int32Array, b: Int32Array, fromR: number, fromC: number, toR: number, toC: number, white: boolean,
): void {
  // Save the rows this move can change (origin & destination footprint rows).
  const base = undoSp * UNDO_CAP;
  let n = 0;
  for (let r = fromR - 1; r <= fromR + 1; r++) {
    if (r < 0 || r >= SIZE) continue;
    undoRow[base + n] = r; undoW[base + n] = w[r]; undoB[base + n] = b[r]; n++;
  }
  for (let r = toR - 1; r <= toR + 1; r++) {
    if (r < 0 || r >= SIZE || (r >= fromR - 1 && r <= fromR + 1)) continue; // not already saved
    undoRow[base + n] = r; undoW[base + n] = w[r]; undoB[base + n] = b[r]; n++;
  }
  undoN[undoSp] = n; undoSp++;

  const own = white ? w : b;
  // Capture the moving piece's own-stone pattern (3×3) before clearing it.
  // (A border-centred piece has footprint cells off-board — skip those.)
  let pat = 0;
  for (let ddr = -1; ddr <= 1; ddr++) {
    const rr = fromR + ddr;
    if (rr < 0 || rr >= SIZE) continue;
    for (let ddc = -1; ddc <= 1; ddc++) {
      const cc = fromC + ddc;
      if (cc < 0 || cc >= SIZE) continue;
      if (own[rr] & (1 << cc)) pat |= 1 << ((ddr + 1) * 3 + (ddc + 1));
    }
  }

  // Clear the origin footprint's own stones.
  const ocm = COL3[fromC];
  for (let rr = fromR - 1; rr <= fromR + 1; rr++) {
    if (rr < 0 || rr >= SIZE) continue;
    own[rr] &= ~ocm;
  }

  // Clear the destination footprint (captures, both colours). Intermediate path
  // cells are empty, so only the destination footprint needs clearing.
  const dcm = COL3[toC];
  for (let r = toR - 1; r <= toR + 1; r++) {
    if (r < 0 || r >= SIZE) continue;
    w[r] &= ~dcm; b[r] &= ~dcm;
  }

  // Place the piece's stones at the destination; those on the border ring
  // (outside rows/cols 1..18) are removed.
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++)
      if (pat & (1 << ((ddr + 1) * 3 + (ddc + 1)))) {
        const rr = toR + ddr, cc = toC + ddc;
        if (rr >= MIN && rr <= MAX && cc >= MIN && cc <= MAX) own[rr] |= 1 << cc;
      }
}

function unmakeMove(w: Int32Array, b: Int32Array): void {
  undoSp--;
  const base = undoSp * UNDO_CAP;
  const n = undoN[undoSp];
  for (let i = 0; i < n; i++) {
    const r = undoRow[base + i];
    w[r] = undoW[base + i];
    b[r] = undoB[base + i];
  }
}

// Rows of the band whose counts a move can change (filled per child).
const bandRows = new Int32Array(16);

/** All legal moves for the mover with outcome and eval, sorted best-first
 *  (wins, then by score, then losses). Uses make/unmake and incremental eval. */
function genMoves(w: Int32Array, b: Int32Array, white: boolean): Move[] {
  const own = white ? w : b;
  const opp = white ? b : w;
  const items: Move[] = [];
  const visited = new Int32Array(SIZE); // dest dedup per from-centre

  // Parent counts + per-row cache (one full analysis for the whole node).
  const p = analyzeFill(w, b);

  // Footprint centres may sit anywhere on the 20×20 grid, including the border
  // ring (0 and 19); off-board rows read as 0 (empty) on the typed arrays.
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cm = COL3[c]; // origin footprint columns (clamped at the edges)
      if ((opp[r - 1] | opp[r] | opp[r + 1]) & cm) continue;       // opponent in footprint
      if (!((own[r - 1] | own[r] | own[r + 1]) & cm)) continue;    // no own stone

      const maxSteps = (own[r] & (1 << c)) ? SIZE : 3; // centre stone → unlimited
      visited.fill(0);

      for (const [dr, dc] of DIRS) {
        const sr = r + dr, sc = c + dc; // footprint cell in this direction
        if (sr < 0 || sr >= SIZE || sc < 0 || sc >= SIZE) continue; // off-board → no stone
        if (!(own[sr] & (1 << sc))) continue;                       // need a stone there

        for (let step = 1; step <= maxSteps; step++) {
          const nr = r + dr * step, nc = c + dc * step;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;

          // hitsAny: an occupied cell in the new footprint that is not part of
          // the (transparent) origin footprint. Off-board cells are empty.
          const ncm = COL3[nc];
          let hits = 0;
          for (let row = nr - 1; row <= nr + 1; row++) {
            if (row < 0 || row >= SIZE) continue;
            let o = (w[row] | b[row]) & ncm;
            if (row >= r - 1 && row <= r + 1) o &= ~cm; // origin cells transparent
            hits |= o;
          }

          if (!(visited[nr] & (1 << nc))) {
            visited[nr] |= 1 << nc;

            // ── Incremental eval ──────────────────────────────────────────────
            // A move only changes the origin (rows r±1) and destination (rows
            // nr±1) footprints. Ring centres flip only within ±1 of a changed
            // row, so the affected band is rows r±2 ∪ nr±2 (clamped to the
            // playing area). Update ring/stone totals over just those rows.
            const a0 = r - 2 < MIN ? MIN : r - 2, a1 = r + 2 > MAX ? MAX : r + 2;
            const b0 = nr - 2 < MIN ? MIN : nr - 2, b1 = nr + 2 > MAX ? MAX : nr + 2;
            let n = 0;
            if (b0 > a1 + 1 || a0 > b1 + 1) {            // disjoint origin/dest bands
              for (let rc = a0; rc <= a1; rc++) bandRows[n++] = rc;
              for (let rc = b0; rc <= b1; rc++) bandRows[n++] = rc;
            } else {                                     // overlapping/adjacent → merge
              const lo = a0 < b0 ? a0 : b0, hi = a1 > b1 ? a1 : b1;
              for (let rc = lo; rc <= hi; rc++) bandRows[n++] = rc;
            }

            makeMove(w, b, r, c, nr, nc, white);
            let dwR = 0, dbR = 0, dwS = 0, dbS = 0;
            for (let i = 0; i < n; i++) {
              const rc = bandRows[i];
              dwR += rowRingW(w, b, rc) - pRowRingW[rc];
              dbR += rowRingB(w, b, rc) - pRowRingB[rc];
              dwS += popcount(w[rc] & PLAY_MASK) - pRowStoneW[rc];
              dbS += popcount(b[rc] & PLAY_MASK) - pRowStoneB[rc];
            }
            const cwR = p.wR + dwR, cbR = p.bR + dbR, cwS = p.wS + dwS, cbS = p.bS + dbS;
            const cwDeep = whiteDeepest(w), cbDeep = blackDeepest(b);
            const safety = ringSafety(w, b, white); // on the child board
            unmakeMove(w, b);

            const myR = white ? cwR : cbR, opR = white ? cbR : cwR;
            const myS = white ? cwS : cbS, opS = white ? cbS : cwS;
            const myD = white ? cwDeep : cbDeep, opD = white ? cbDeep : cwDeep;
            const outcome = myR === 0 ? -1 : opR === 0 ? 1 : 0;
            const key = 100 * (myS - opS) + 70 * (myR - opR) + (myD - opD) + safety;
            items.push({ fromR: r, fromC: c, toR: nr, toC: nc, outcome, key });
          }

          if (hits !== 0) break; // first intersection: land here, stop sliding
        }
      }
    }
  }

  items.sort((x, y) => (y.outcome - x.outcome) || (y.key - x.key));
  return items;
}

// Log search diagnostics (timings + per-move evaluations) to the console.
const SEARCH_DEBUG = true;
const DEBUG_COLS = 'abcdefghijklmnopqrst';

/** Human-readable move label, e.g. "q6-r7" (same notation as the move record). */
function moveLabel(ch: Move): string {
  const sq = (r: number, c: number) => `${DEBUG_COLS[c]}${SIZE - r}`;
  return `${sq(ch.fromR, ch.fromC)}-${sq(ch.toR, ch.toC)}`;
}

/** Render rows as an aligned plain-text table (so it prints fully in any console). */
function formatTable(
  rows: Record<string, string | number>[],
  cols: { key: string; label: string; right?: boolean }[],
): string {
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key]).length)));
  const line = (cells: string[]) =>
    cells.map((s, i) => (cols[i].right ? s.padStart(w[i]) : s.padEnd(w[i]))).join('  ');
  const out = [line(cols.map(c => c.label)), w.map(n => '─'.repeat(n)).join('  ')];
  for (const r of rows) out.push(line(cols.map(c => String(r[c.key]))));
  return out.join('\n');
}

/**
 * Chooses a move via iterative-deepening negamax with alpha-beta pruning,
 * using the static evaluation (myRings − oppRings)·7 + (myStones − oppStones),
 * computed on bitboards for speed.
 *
 * Deepening continues until the cumulative search time exceeds `timeBudgetMs`;
 * the result of the last fully-completed depth is kept (a depth aborted
 * mid-search is discarded). Terminal positions — a side losing its last ring —
 * are scored ±WIN_SCORE with a ply penalty, so quicker wins and slower losses
 * are preferred. Because a self-destructing move scores −WIN_SCORE, the AI
 * never destroys its own last ring unless every legal move does (i.e. it is
 * forced). Returns the chosen move and the deepest depth completed, or null if
 * there are no legal moves.
 */
export function getBestMove(board: Board, player: Player, timeBudgetMs: number): AiMove | null {
  const white = player === 'white';
  const deadline = Date.now() + timeBudgetMs;

  const { w, b } = bbFromBoard(board);
  undoSp = 0; // reset the make/unmake stack (a prior search may have timed out)
  const rootChildren = genMoves(w, b, white);
  if (rootChildren.length === 0) return null;

  let bestMove: Move = rootChildren[0];
  let bestDepth = 0;

  // Search diagnostics.
  const tSearch = performance.now();
  const depthTimings: { depth: number; ms: number; cumulativeMs: number }[] = [];
  let lastScored: { ch: Move; score: number; exact: boolean }[] = [];
  let lastBestScore = 0;

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const tDepth = performance.now();
    try {
      // Phase 1 — alpha-beta over the root moves to find the exact best score.
      // Siblings are searched with a narrowing window (real pruning); the final
      // alpha is exact because it is only ever raised by in-window returns.
      let alpha = -Infinity;
      const scored: { ch: Move; score: number; exact: boolean }[] = [];
      for (const ch of rootChildren) {
        let score: number;
        let exact = true;
        if (ch.outcome === 1) score = WIN_SCORE - 1;
        else if (ch.outcome === -1) score = -(WIN_SCORE - 1);
        else if (depth === 1) score = ch.key;
        else {
          makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
          score = -negamax(w, b, !white, depth - 1, -Infinity, -alpha, 1, deadline);
          unmakeMove(w, b);
          exact = false;
        }
        scored.push({ ch, score, exact });
        if (score > alpha) alpha = score;
      }
      const bestScore = alpha;

      // Phase 2 — collect every move whose *exact* value equals bestScore so the
      // tie can be broken uniformly at random. A true best-score move always
      // scores exactly bestScore in phase 1; a searched (inexact) score that
      // lands on bestScore may be a fail-soft artefact, so confirm those with a
      // cheap null-window re-search (which prunes hard).
      const candidates: Move[] = [];
      for (const { ch, score, exact } of scored) {
        if (score !== bestScore) continue;
        if (exact) { candidates.push(ch); continue; }
        makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
        const v = -negamax(w, b, !white, depth - 1, -bestScore, -bestScore + 1, 1, deadline);
        unmakeMove(w, b);
        if (v >= bestScore) candidates.push(ch);
      }
      if (candidates.length === 0) candidates.push(rootChildren[0]); // safety net

      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      bestMove = chosen;
      bestDepth = depth;

      // This depth completed — record its timing and snapshot for diagnostics.
      depthTimings.push({
        depth,
        ms: Math.round(performance.now() - tDepth),
        cumulativeMs: Math.round(performance.now() - tSearch),
      });
      lastScored = scored;
      lastBestScore = bestScore;

      const i = rootChildren.indexOf(chosen);
      if (i > 0) { rootChildren.splice(i, 1); rootChildren.unshift(chosen); }

      // A forced win/loss won't change with more depth — stop early.
      if (bestScore >= WIN_SCORE - MAX_DEPTH || bestScore <= -(WIN_SCORE - MAX_DEPTH)) break;
    } catch (e) {
      if (e === SEARCH_TIMEOUT) break; // discard this depth, keep last completed
      throw e;
    }
    if (Date.now() >= deadline) break;
  }

  if (SEARCH_DEBUG && lastScored.length) {
    const totalMs = Math.round(performance.now() - tSearch);
    // Top 20 moves at the greatest completed depth, best first. With alpha-beta,
    // only the best/PV move(s) are exact; pruned moves show an upper bound.
    const moveRows = lastScored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((s, i) => ({
        '#': i + 1,
        move: moveLabel(s.ch),
        score: s.score + 0, // normalise -0 → 0
        type: s.exact ? 'exact' : (s.score === lastBestScore ? 'exact (pv)' : '≤ bound'),
        staticEval: s.ch.key,
        chosen: s.ch === bestMove ? '★' : '',
      }));

    console.log(
      `[Gess AI] ${player}: best depth ${bestDepth}, ${rootChildren.length} root moves, ${totalMs}ms total\n\n` +
      'Time per depth:\n' +
      formatTable(depthTimings as unknown as Record<string, number>[], [
        { key: 'depth', label: 'depth', right: true },
        { key: 'ms', label: 'ms', right: true },
        { key: 'cumulativeMs', label: 'cum ms', right: true },
      ]) +
      `\n\nTop ${moveRows.length} moves at depth ${bestDepth}:\n` +
      formatTable(moveRows, [
        { key: '#', label: '#', right: true },
        { key: 'move', label: 'move' },
        { key: 'score', label: 'score', right: true },
        { key: 'type', label: 'type' },
        { key: 'staticEval', label: 'static', right: true },
        { key: 'chosen', label: '' },
      ]),
    );
  }

  return {
    from: { row: bestMove.fromR, col: bestMove.fromC },
    to: { row: bestMove.toR, col: bestMove.toC },
    depth: bestDepth,
  };
}

/** Negamax with alpha-beta on the shared bitboard (make/unmake). Value from the
 *  mover's perspective. */
function negamax(
  w: Int32Array, b: Int32Array, white: boolean, depth: number,
  alpha: number, beta: number, ply: number, deadline: number,
): number {
  if (Date.now() >= deadline) throw SEARCH_TIMEOUT;

  const moves = genMoves(w, b, white);
  if (moves.length === 0) return evalOf(analyzeFill(w, b), white) + ringSafety(w, b, white);

  let best = -Infinity;
  for (const mv of moves) {
    let score: number;
    if (mv.outcome === 1) score = WIN_SCORE - (ply + 1);
    else if (mv.outcome === -1) score = -(WIN_SCORE - (ply + 1));
    else if (depth === 1) score = mv.key;
    else {
      makeMove(w, b, mv.fromR, mv.fromC, mv.toR, mv.toC, white);
      score = -negamax(w, b, !white, depth - 1, -beta, -alpha, ply + 1, deadline);
      unmakeMove(w, b);
    }

    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // beta cut-off
  }
  return best;
}

// ─── Verification hooks ──────────────────────────────────────────────────────
// Deterministic mirrors of the search internals, exposed so the Rust/WASM port
// can be diffed against this engine over many positions. They reuse the exact
// same private functions the production search uses, so equivalence here implies
// equivalence of the hot path. None of these are used in normal gameplay.

/** Full board analysis (rings/stones/deepest), mirrors `analyze` in the WASM. */
export function debugAnalyze(board: Board): {
  wR: number; bR: number; wS: number; bS: number; wDeep: number; bDeep: number; pW: number; pB: number;
} {
  const { w, b } = bbFromBoard(board);
  const a = analyzeFill(w, b);
  const { pW, pB } = ringPressure(w, b);
  return { wR: a.wR, bR: a.bR, wS: a.wS, bS: a.bS, wDeep: a.wDeep, bDeep: a.bDeep, pW, pB };
}

/** Generated root moves (sorted, with outcome + key), mirrors `gen_root`. */
export function debugGenRoot(board: Board, player: Player): {
  fromR: number; fromC: number; toR: number; toC: number; outcome: number; key: number;
}[] {
  const white = player === 'white';
  const { w, b } = bbFromBoard(board);
  undoSp = 0;
  return genMoves(w, b, white).map(m => ({
    fromR: m.fromR, fromC: m.fromC, toR: m.toR, toC: m.toC, outcome: m.outcome, key: m.key,
  }));
}

/**
 * Deterministic phase-1 alpha-beta at a fixed depth — no random pick, no root
 * reordering, no time limit. Mirrors `search_root` in the WASM and phase 1 of
 * getBestMove. Returns the exact best score and every root move's score in
 * generated order.
 */
export function debugSearchRoot(board: Board, player: Player, depth: number): {
  bestScore: number;
  moves: { fromR: number; fromC: number; toR: number; toC: number; score: number }[];
} {
  const white = player === 'white';
  const { w, b } = bbFromBoard(board);
  undoSp = 0;
  const root = genMoves(w, b, white);

  let alpha = -Infinity;
  const moves: { fromR: number; fromC: number; toR: number; toC: number; score: number }[] = [];
  for (const ch of root) {
    let score: number;
    if (ch.outcome === 1) score = WIN_SCORE - 1;
    else if (ch.outcome === -1) score = -(WIN_SCORE - 1);
    else if (depth === 1) score = ch.key;
    else {
      makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
      score = -negamax(w, b, !white, depth - 1, -Infinity, -alpha, 1, Infinity);
      unmakeMove(w, b);
    }
    moves.push({ fromR: ch.fromR, fromC: ch.fromC, toR: ch.toR, toC: ch.toC, score });
    if (score > alpha) alpha = score;
  }
  return { bestScore: alpha, moves };
}
