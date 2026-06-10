// Transposition-table benchmark: time to search to 3 plies, TT-off vs TT-on,
// over 50 random positions. Reports average and 90th-percentile times, plus the
// speedup. Uses the iterative-deepening path (search_to_depth) — the realistic
// way the engine reaches a depth, and where TT reuse across depths pays off.
// Also cross-checks that TT-on and TT-off reach the same bestScore (sanity).
//
// Usage: node verify/bench-tt.mjs [count] [depth] [seed]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {
  env: { now: () => Date.now(), random: () => Math.random() },
});
const w = instance.exports;
const BOARD_PTR = w.board_ptr();

const COUNT = Number(process.argv[2] ?? 50);
const DEPTH = Number(process.argv[3] ?? 3);
const SEED = Number(process.argv[4] ?? 12345);
const CROSSCHECK = process.argv[5] !== 'nocheck';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(SEED);
const randInt = n => Math.floor(rng() * n);

function toFlat(board) {
  const f = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++)
    f[r * 20 + c] = board[r][c] === 'white' ? 1 : board[r][c] === 'black' ? 2 : 0;
  return f;
}
function searchToDepth(board, player, depth, tt) {
  new Int8Array(w.memory.buffer, BOARD_PTR, 400).set(toFlat(board));
  return w.search_to_depth(player === 'white' ? 1 : 0, depth, tt);
}

// Build a varied set of real mid-game positions via short random self-play.
function legalMoves(board, player) {
  const moves = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++)
    if (Engine.isValidFootprintCenter(r, c, board, player))
      for (const to of Engine.getValidMoves(board, { row: r, col: c }, player)) moves.push({ from: { row: r, col: c }, to });
  return moves;
}
function randomPosition() {
  let board = Engine.makeBoard();
  let pl = 'black';
  const plies = 2 + randInt(14); // 2..15 plies in
  for (let i = 0; i < plies; i++) {
    if (!Engine.hasRing(board, 'white') || !Engine.hasRing(board, 'black')) break;
    const moves = legalMoves(board, pl);
    if (moves.length === 0) break;
    const m = moves[randInt(moves.length)];
    board = Engine.applyMove(board, m.from, m.to, pl);
    pl = pl === 'black' ? 'white' : 'black';
  }
  return { board, player: pl };
}

const positions = [];
for (let i = 0; i < COUNT; i++) positions.push(randomPosition());

function timeIt(tt) {
  const times = [];
  let mismatch = 0;
  for (const { board, player } of positions) {
    // warm (compile/JIT + zobrist init) once per position is unnecessary; just measure.
    const t = performance.now();
    const score = searchToDepth(board, player, DEPTH, tt);
    times.push(performance.now() - t);
    // cross-check against TT-off oracle (the WASM TT-off result == TS already verified)
    if (tt && CROSSCHECK) {
      const ref = searchToDepth(board, player, DEPTH, 0);
      if (ref !== score) mismatch++;
    }
  }
  return { times, mismatch };
}

const stats = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  const p90 = s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
  return { avg, p90, max: s[s.length - 1] };
};

// Warm up the module (JIT) before timing.
searchToDepth(positions[0].board, positions[0].player, DEPTH, 0);
searchToDepth(positions[0].board, positions[0].player, DEPTH, 1);

const off = timeIt(0);
const on = timeIt(1);
const so = stats(off.times), sn = stats(on.times);

console.log(`Search to ${DEPTH} plies over ${COUNT} random positions (seed ${SEED}):\n`);
console.log(`              avg (ms)    p90 (ms)    max (ms)`);
console.log(`  TT off   ${so.avg.toFixed(1).padStart(9)}  ${so.p90.toFixed(1).padStart(10)}  ${so.max.toFixed(1).padStart(10)}`);
console.log(`  TT on    ${sn.avg.toFixed(1).padStart(9)}  ${sn.p90.toFixed(1).padStart(10)}  ${sn.max.toFixed(1).padStart(10)}`);
console.log(`\n  speedup   avg ${(so.avg / sn.avg).toFixed(2)}x   p90 ${(so.p90 / sn.p90).toFixed(2)}x`);
console.log(`  bestScore mismatches (TT on vs off): ${on.mismatch} / ${COUNT}`);
