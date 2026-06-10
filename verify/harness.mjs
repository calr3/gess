// Differential test harness: compares the Rust/WASM AI engine against the
// reference TypeScript engine over a wide variety of positions and depths.
//
// For each (position, player) it checks three deterministic surfaces that
// together exercise the whole search hot path:
//   1. analyze      — rings / stones / deepest counts
//   2. gen_root     — generated root moves (sorted), with outcome + key
//   3. search_root  — fixed-depth phase-1 alpha-beta best score + per-move scores
//
// Positions come from: the initial position, randomised self-play games (using
// the TS move logic), random stone scatters (incl. border-ring stress), and a
// few hand-crafted ring / near-win / border-centre cases.
//
// Usage: node verify/harness.mjs [games] [scatters] [maxDepth]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(
  __dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm',
);

const GAMES = Number(process.argv[2] ?? 60);
const SCATTERS = Number(process.argv[3] ?? 400);
const HARD_CAP = Number(process.argv[4] ?? 6);

// Scale search depth to the branching factor so node counts stay bounded: deep
// searches on cheap (low-branching) positions, shallow on high-branching ones.
// This exercises deep alpha-beta where it's affordable and broad coverage
// everywhere — without an un-tabled negamax exploding on opening-type positions.
function depthForBranch(n) {
  const d = n <= 10 ? 5 : n <= 30 ? 4 : n <= 80 ? 3 : 2;
  return Math.min(d, HARD_CAP);
}

// ─── Deterministic PRNG (mulberry32) so runs are reproducible ────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.argv[6] ?? 0xC0FFEE);
const rng = mulberry32(SEED);
const randInt = n => Math.floor(rng() * n);

// ─── WASM loader ─────────────────────────────────────────────────────────────
// The threaded build imports a *shared* memory (env.memory) rather than
// exporting one. dlmalloc acquires its heap via memory.grow, so initial must be
// below maximum (else the first allocation fails). Growing a *shared* memory
// happens in place and does not detach existing views. 1024 pages = 64 MiB max,
// matching --max-memory in build.sh.
const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
});
const wasm = instance.exports;
wasm.set_nullmove(0); // verify the EXACT search; null-move (speculative) is checked separately
wasm.set_lmr(0);      // likewise LMR — speculative, verified separately
const BOARD_PTR = wasm.board_ptr();
const OUT_PTR = wasm.out_ptr();

// Pre-sized, non-growing shared memory: a single view stays valid for the whole
// run (no detachment), but re-acquiring per call is cheap and future-proof.
function writeBoard(flat) {
  const view = new Int8Array(memory.buffer, BOARD_PTR, 400);
  view.set(flat);
}
function out(n) {
  return new Int32Array(memory.buffer, OUT_PTR, n);
}

// Cell[][] → flat Int8Array(400): 0 empty, 1 white, 2 black.
function toFlat(board) {
  const flat = new Int8Array(400);
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      const v = board[r][c];
      flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
    }
  return flat;
}

// ─── WASM call wrappers ──────────────────────────────────────────────────────
function wasmAnalyze(board) {
  writeBoard(toFlat(board));
  wasm.analyze();
  const o = out(8);
  return { wR: o[0], bR: o[1], wS: o[2], bS: o[3], wDeep: o[4], bDeep: o[5], pW: o[6], pB: o[7] };
}
function wasmGenRoot(board, player) {
  writeBoard(toFlat(board));
  const n = wasm.gen_root(player === 'white' ? 1 : 0);
  const o = out(1 + n * 6);
  const moves = [];
  for (let i = 0, k = 1; i < n; i++, k += 6)
    moves.push({ fromR: o[k], fromC: o[k + 1], toR: o[k + 2], toC: o[k + 3], outcome: o[k + 4], key: o[k + 5] });
  return moves;
}
function wasmSearchRoot(board, player, depth, tt = 0) {
  writeBoard(toFlat(board));
  const n = wasm.search_root(player === 'white' ? 1 : 0, depth, tt);
  const o = out(2 + n * 5);
  const bestScore = o[0];
  const moves = [];
  for (let i = 0, k = 2; i < n; i++, k += 5)
    moves.push({ fromR: o[k], fromC: o[k + 1], toR: o[k + 2], toC: o[k + 3], score: o[k + 4] });
  return { bestScore, moves };
}
function wasmSearchToDepth(board, player, maxDepth, tt) {
  writeBoard(toFlat(board));
  return wasm.search_to_depth(player === 'white' ? 1 : 0, maxDepth, tt);
}

// ─── Position generators ─────────────────────────────────────────────────────
function boardStr(board) {
  return board.map(row =>
    row.map(c => (c === 'white' ? 'W' : c === 'black' ? 'B' : '.')).join('')).join('\n');
}

// Enumerate all legal (from,to) moves for a player using the TS move logic.
function legalMoves(board, player) {
  const moves = [];
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      if (!Engine.isValidFootprintCenter(r, c, board, player)) continue;
      for (const to of Engine.getValidMoves(board, { row: r, col: c }, player))
        moves.push({ from: { row: r, col: c }, to });
    }
  return moves;
}

// Play a random game, yielding the board before each move (both players).
function* selfPlayPositions(maxPlies) {
  let board = Engine.makeBoard();
  let player = 'black';
  for (let ply = 0; ply < maxPlies; ply++) {
    if (!Engine.hasRing(board, 'white') || !Engine.hasRing(board, 'black')) break;
    const moves = legalMoves(board, player);
    if (moves.length === 0) break;
    yield { board, player };
    const m = moves[randInt(moves.length)];
    board = Engine.applyMove(board, m.from, m.to, player);
    player = player === 'black' ? 'white' : 'black';
  }
}

// Random scatter: place stones with a given density; sometimes include the
// border ring (rows/cols 0 and 19) to stress off-playing-area handling.
function scatterBoard(density, includeBorder) {
  const board = Array.from({ length: 20 }, () => new Array(20).fill(null));
  const lo = includeBorder ? 0 : 1;
  const hi = includeBorder ? 19 : 18;
  for (let r = lo; r <= hi; r++)
    for (let c = lo; c <= hi; c++) {
      const x = rng();
      if (x < density) board[r][c] = x < density / 2 ? 'white' : 'black';
    }
  return board;
}

// Hand-crafted positions: explicit rings, near-wins, border-centred pieces.
function craftedPositions() {
  const out = [];
  const blank = () => Array.from({ length: 20 }, () => new Array(20).fill(null));
  const ring = (board, cr, cc, p) => {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if (dr || dc) board[cr + dr][cc + dc] = p;
  };

  // Two isolated rings.
  let b = blank(); ring(b, 5, 5, 'white'); ring(b, 14, 14, 'black');
  out.push(b);

  // White ring with a black piece adjacent that can break it.
  b = blank(); ring(b, 9, 9, 'white');
  b[9][6] = 'black'; b[9][7] = 'black'; b[10][6] = 'black'; b[10][7] = 'black';
  out.push(b);

  // Pieces hugging the border so footprint centres sit on the ring.
  b = blank();
  b[1][1] = 'white'; b[1][2] = 'white'; b[2][1] = 'white';
  b[18][18] = 'black'; b[18][17] = 'black'; b[17][18] = 'black';
  b[1][18] = 'white'; b[18][1] = 'black';
  out.push(b);

  // Two rings each, plus loose stones.
  b = blank(); ring(b, 4, 4, 'white'); ring(b, 4, 15, 'white');
  ring(b, 15, 4, 'black'); ring(b, 15, 15, 'black');
  b[9][9] = 'white'; b[10][10] = 'black'; b[9][10] = 'white'; b[10][9] = 'black';
  out.push(b);

  // Dense centre clump (lots of intersecting moves).
  b = blank();
  for (let r = 7; r <= 12; r++)
    for (let c = 7; c <= 12; c++) b[r][c] = (r + c) % 2 ? 'white' : 'black';
  out.push(b);

  return out;
}

// Ring endgames: 1-2 rings per side at random spots plus a few loose stones.
// Low branching → deep search, with genuine ring-capture dynamics that exercise
// the win/loss outcome scoring and mate-distance preference.
function ringEndgame() {
  const board = Array.from({ length: 20 }, () => new Array(20).fill(null));
  const placeRing = (p) => {
    for (let tries = 0; tries < 30; tries++) {
      const cr = 2 + randInt(15), cc = 2 + randInt(15);
      let clear = true;
      for (let dr = -1; dr <= 1 && clear; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (board[cr + dr][cc + dc] !== null) { clear = false; break; }
      if (!clear) continue;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if (dr || dc) board[cr + dr][cc + dc] = p;
      return;
    }
  };
  for (const p of ['white', 'black']) {
    placeRing(p);
    if (rng() < 0.5) placeRing(p);
  }
  // A handful of loose stones.
  const loose = 2 + randInt(8);
  for (let i = 0; i < loose; i++) {
    const r = 1 + randInt(18), c = 1 + randInt(18);
    if (board[r][c] === null) board[r][c] = rng() < 0.5 ? 'white' : 'black';
  }
  return board;
}

// ─── Comparison ──────────────────────────────────────────────────────────────
let checks = 0;
let mismatches = 0;
const firstMismatch = [];

function fail(kind, board, player, detail) {
  mismatches++;
  if (firstMismatch.length < 3) {
    firstMismatch.push({ kind, player, detail, board: boardStr(board) });
  }
}

function eqAnalyze(board) {
  checks++;
  const a = Engine.debugAnalyze(board);
  const w = wasmAnalyze(board);
  for (const k of ['wR', 'bR', 'wS', 'bS', 'wDeep', 'bDeep', 'pW', 'pB'])
    if (a[k] !== w[k]) return fail('analyze', board, '-', `${k}: ts=${a[k]} wasm=${w[k]} (full ts=${JSON.stringify(a)} wasm=${JSON.stringify(w)})`);
}

function eqGenRoot(board, player) {
  checks++;
  const a = Engine.debugGenRoot(board, player);
  const w = wasmGenRoot(board, player);
  if (a.length !== w.length) {
    fail('gen_root', board, player, `count ts=${a.length} wasm=${w.length}`);
    return a.length;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = w[i];
    if (x.fromR !== y.fromR || x.fromC !== y.fromC || x.toR !== y.toR || x.toC !== y.toC || x.outcome !== y.outcome || x.key !== y.key) {
      fail('gen_root', board, player, `move[${i}] ts=${JSON.stringify(x)} wasm=${JSON.stringify(y)}`);
      break;
    }
  }
  return a.length; // branching factor, used to pick search depth
}

function eqSearchRoot(board, player, depth) {
  checks++;
  const a = Engine.debugSearchRoot(board, player, depth);
  // TT-off: must be byte-identical to the TS oracle (base engine unchanged).
  const w = wasmSearchRoot(board, player, depth, 0);
  if (a.moves.length !== w.moves.length)
    return fail('search_root', board, player, `depth ${depth} count ts=${a.moves.length} wasm=${w.moves.length}`);
  // No legal moves at the root (a degenerate, game-over position): bestScore is
  // the unused initial sentinel — TS −Infinity vs WASM's finite stand-in. Both
  // correctly found no move; in real play this returns null. Not a divergence.
  if (a.moves.length === 0) return;
  if (a.bestScore !== w.bestScore)
    return fail('search_root', board, player, `depth ${depth} bestScore ts=${a.bestScore} wasm=${w.bestScore}`);
  for (let i = 0; i < a.moves.length; i++) {
    const x = a.moves[i], y = w.moves[i];
    if (x.fromR !== y.fromR || x.fromC !== y.fromC || x.toR !== y.toR || x.toC !== y.toC || x.score !== y.score)
      return fail('search_root', board, player, `depth ${depth} move[${i}] ts=${JSON.stringify(x)} wasm=${JSON.stringify(y)}`);
  }
  // TT-on: a correct TT preserves the exact root value — bestScore must match
  // the oracle (per-move fail-soft scores may differ, so only bestScore is
  // compared). Checked for both the single fixed-depth and the iterative path.
  checks++;
  const wTT = wasmSearchRoot(board, player, depth, 1);
  if (wTT.bestScore !== a.bestScore)
    return fail('search_root(TT)', board, player, `depth ${depth} bestScore ts=${a.bestScore} wasm+tt=${wTT.bestScore}`);
  checks++;
  const itTT = wasmSearchToDepth(board, player, depth, 1);
  if (itTT !== a.bestScore)
    return fail('search_to_depth(TT)', board, player, `depth ${depth} bestScore ts=${a.bestScore} wasm+tt=${itTT}`);
}

let positions = 0;
function progress() {
  if (++positions % 100 === 0)
    process.stderr.write(`  …${positions} positions, ${checks} comparisons\r`);
}

function checkPosition(board) {
  eqAnalyze(board);
  for (const player of ['white', 'black']) {
    const branch = eqGenRoot(board, player);
    const cap = depthForBranch(branch);
    for (let d = 1; d <= cap; d++) eqSearchRoot(board, player, d);
    if (mismatches) return;
  }
  progress();
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();

// Initial position + crafted positions.
checkPosition(Engine.makeBoard());
for (const b of craftedPositions()) {
  if (mismatches) break;
  checkPosition(b);
}

// Self-play games.
for (let g = 0; g < GAMES && !mismatches; g++) {
  for (const { board, player } of selfPlayPositions(60)) {
    if (mismatches) break;
    eqAnalyze(board);
    const branch = eqGenRoot(board, player);
    const cap = depthForBranch(branch);
    for (let d = 1; d <= cap; d++) eqSearchRoot(board, player, d);
    progress();
  }
}

// Random scatters of varying density (some include the border ring).
const densities = [0.05, 0.1, 0.2, 0.35, 0.5];
for (let s = 0; s < SCATTERS && !mismatches; s++) {
  const density = densities[s % densities.length];
  const includeBorder = s % 3 === 0;
  checkPosition(scatterBoard(density, includeBorder));
}

// Ring endgames (deep search + ring-capture dynamics).
const ENDGAMES = Number(process.argv[5] ?? Math.round(SCATTERS / 2));
for (let e = 0; e < ENDGAMES && !mismatches; e++) {
  checkPosition(ringEndgame());
}

// A small set of explicit deep spot-checks (depth 6) on low-branching endgames,
// to exercise deeper alpha-beta window propagation than the scaled cap allows.
for (let e = 0; e < 25 && !mismatches; e++) {
  const board = ringEndgame();
  eqAnalyze(board);
  for (const player of ['white', 'black']) {
    if (eqGenRoot(board, player) <= 12)
      for (let d = 1; d <= 6; d++) eqSearchRoot(board, player, d);
    if (mismatches) break;
  }
  progress();
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nPositions: ${positions}   Comparisons: ${checks}   Time: ${secs}s`);
if (mismatches === 0) {
  console.log('✅ PASS — TS and WASM engines produced identical results on every comparison.');
} else {
  console.log(`❌ FAIL — ${mismatches} mismatch(es). First few:\n`);
  for (const m of firstMismatch) {
    console.log(`── ${m.kind} (player ${m.player}) ──\n${m.detail}\nboard:\n${m.board}\n`);
  }
  process.exit(1);
}
