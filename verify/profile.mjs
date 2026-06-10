// Profiling driver: runs the single-threaded, deterministic fixed-depth search
// (bench_fixed) on the opening position so V8's sampling profiler can attribute
// self-time to individual WASM functions. Usage: node [--prof] profile.mjs [depth] [reps]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(WASM_PATH), {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
});
const wasm = instance.exports;
const BOARD_PTR = wasm.board_ptr(), OUT_PTR = wasm.out_ptr();

function writeBoard(board) {
  const flat = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
    const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
  }
  new Int8Array(memory.buffer, BOARD_PTR, 400).set(flat);
}

const depth = Number(process.argv[2] ?? 4);
const reps = Number(process.argv[3] ?? 3);
const mode = process.argv[4] ?? 'opening';        // 'opening' | 'sparse'

let board, whiteToMove;
if (mode === 'sparse') {
  // Crafted sparse endgame: 2 rings + a few loose stones per side, far apart and
  // non-terminal. Most of the board is empty, so most footprint centres are
  // invalid — the case where bitboard centre enumeration (#2) should pay off.
  board = Engine.makeBoard().map(row => row.map(() => null));
  const ring = (cr, cc, p) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) board[cr + dr][cc + dc] = p; };
  ring(4, 4, 'white'); ring(7, 12, 'white');
  ring(15, 5, 'black'); ring(12, 14, 'black');
  for (const [r, c] of [[3, 9], [6, 7], [9, 4], [8, 16]]) board[r][c] = 'white';
  for (const [r, c] of [[16, 10], [13, 8], [11, 5], [14, 16]]) board[r][c] = 'black';
  whiteToMove = 0; // black to move
} else {
  board = Engine.makeBoard();
  whiteToMove = 0;
}
const stones = board.flat().filter(Boolean).length;

writeBoard(board); wasm.bench_fixed(whiteToMove, 2);   // warm the JIT / TT machinery
let best = Infinity, nodes = 0;
for (let i = 0; i < reps; i++) {
  writeBoard(board);
  const t = Date.now();
  nodes = wasm.bench_fixed(whiteToMove, depth);
  best = Math.min(best, Date.now() - t);
}
console.log(`${mode} depth=${depth} stones=${stones}: min ${best}ms/rep (of ${reps}), ${nodes} nodes, ${(nodes / (best / 1000) / 1e6).toFixed(3)}M nodes/s`);
