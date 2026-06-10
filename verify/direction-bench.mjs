// Fixed-depth A/B bench across a RANGE of positions (not just the opening), to
// evaluate a move-ordering change. Node count at fixed depth is deterministic and
// is the clean ordering-quality metric (fewer = better ordering = faster); min
// wall-time is the throughput check. bench_fixed runs the lazy (production) path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __d = dirname(fileURLToPath(import.meta.url));
const W = join(__d, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(W), { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const bp = x.board_ptr(), op = x.out_ptr();
const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, bp, 400).set(f); };
const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
const ring = (b, cr, cc, p) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) b[cr + dr][cc + dc] = p; };

// A spread of positions, each with a ring per side (non-terminal) and moves in
// every direction. (Random self-play is useless here — it loses a ring in ~2
// plies — so these are hand-built.)
function mid() {
  const b = blank();
  ring(b, 13, 6, 'black'); ring(b, 14, 13, 'black');
  ring(b, 6, 6, 'white'); ring(b, 5, 13, 'white');
  for (const [r, c] of [[10, 4], [10, 9], [11, 15], [9, 11], [13, 10]]) b[r][c] = 'black';
  for (const [r, c] of [[9, 5], [8, 10], [10, 14], [7, 8], [6, 11]]) b[r][c] = 'white';
  return b;
}
function sparse() {
  const b = blank();
  ring(b, 4, 4, 'white'); ring(b, 7, 12, 'white');
  ring(b, 15, 5, 'black'); ring(b, 12, 14, 'black');
  for (const [r, c] of [[3, 9], [6, 7], [9, 4], [8, 16]]) b[r][c] = 'white';
  for (const [r, c] of [[16, 10], [13, 8], [11, 5], [14, 16]]) b[r][c] = 'black';
  return b;
}
function endgame() {
  const b = blank();
  ring(b, 10, 4, 'black'); ring(b, 9, 15, 'white');
  for (const [r, c] of [[12, 7], [8, 6], [14, 12]]) b[r][c] = 'black';
  for (const [r, c] of [[7, 12], [11, 13], [6, 9]]) b[r][c] = 'white';
  return b;
}

// [name, board, whiteToMove (0=black), depth, reps]
const POSITIONS = [
  ['opening', Engine.makeBoard(), 0, 4, 3],
  ['midgame', mid(), 0, 5, 3],
  ['sparse',  sparse(), 0, 5, 3],
  ['endgame', endgame(), 0, 6, 2],
];

let totNodes = 0, totMs = 0;
for (const [name, board, wtm, depth, reps] of POSITIONS) {
  write(board); x.analyze(); const a = new Int32Array(memory.buffer, op, 8);
  const stones = board.flat().filter(Boolean).length;
  write(board); x.bench_fixed(wtm, 2); // warm
  let best = Infinity, nodes = 0;
  for (let i = 0; i < reps; i++) { write(board); const t = Date.now(); nodes = x.bench_fixed(wtm, depth); best = Math.min(best, Date.now() - t); }
  totNodes += nodes; totMs += best;
  console.log(`${name.padEnd(8)} d${depth} stones=${stones} rings(t) w=${a[0]} b=${a[1]}: ${nodes} nodes, min ${best}ms`);
}
console.log(`TOTAL: ${totNodes} nodes, ${totMs}ms`);
