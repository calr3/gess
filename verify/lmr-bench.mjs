// Same-build A/B for LMR (on top of null-move): toggle set_nullmove(0/1) and compare
// fixed-depth node count (deterministic = ordering/prune quality) and min wall
// time across a range of positions. Same binary → controls for codegen.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __d = dirname(fileURLToPath(import.meta.url));
const W = join(__d, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(W), { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const bp = x.board_ptr();
const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, bp, 400).set(f); };
const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
const ring = (b, cr, cc, p) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) b[cr + dr][cc + dc] = p; };

function mid() { const b = blank(); ring(b, 13, 6, 'black'); ring(b, 14, 13, 'black'); ring(b, 6, 6, 'white'); ring(b, 5, 13, 'white'); for (const [r, c] of [[10, 4], [10, 9], [11, 15], [9, 11], [13, 10]]) b[r][c] = 'black'; for (const [r, c] of [[9, 5], [8, 10], [10, 14], [7, 8], [6, 11]]) b[r][c] = 'white'; return b; }
function sparse() { const b = blank(); ring(b, 4, 4, 'white'); ring(b, 7, 12, 'white'); ring(b, 15, 5, 'black'); ring(b, 12, 14, 'black'); for (const [r, c] of [[3, 9], [6, 7], [9, 4], [8, 16]]) b[r][c] = 'white'; for (const [r, c] of [[16, 10], [13, 8], [11, 5], [14, 16]]) b[r][c] = 'black'; return b; }
function endgame() { const b = blank(); ring(b, 10, 4, 'black'); ring(b, 9, 15, 'white'); for (const [r, c] of [[12, 7], [8, 6], [14, 12]]) b[r][c] = 'black'; for (const [r, c] of [[7, 12], [11, 13], [6, 9]]) b[r][c] = 'white'; return b; }

const POSITIONS = [['opening', Engine.makeBoard(), 4, 3], ['midgame', mid(), 5, 3], ['sparse', sparse(), 5, 3], ['endgame', endgame(), 6, 2]];

function bench(board, depth, reps, nm, lmr) {
  x.set_nullmove(nm); x.set_lmr(lmr);
  write(board); x.bench_fixed(0, 2); // warm
  let best = Infinity, nodes = 0;
  for (let i = 0; i < reps; i++) { write(board); const t = Date.now(); nodes = x.bench_fixed(0, depth); best = Math.min(best, Date.now() - t); }
  return { nodes, ms: best };
}

let tn0 = 0, tn1 = 0, tm0 = 0, tm1 = 0;
for (const [name, board, depth, reps] of POSITIONS) {
  const off = bench(board, depth, reps, 1, 0);
  const on = bench(board, depth, reps, 1, 1);
  tn0 += off.nodes; tn1 += on.nodes; tm0 += off.ms; tm1 += on.ms;
  const dn = ((on.nodes / off.nodes - 1) * 100).toFixed(1);
  const dm = ((on.ms / off.ms - 1) * 100).toFixed(1);
  console.log(`${name.padEnd(8)} d${depth}: off ${off.nodes} nodes/${off.ms}ms  →  on ${on.nodes} nodes/${on.ms}ms  (nodes ${dn}%, time ${dm}%)`);
}
console.log(`TOTAL: off ${tn0} nodes/${tm0}ms  →  on ${tn1} nodes/${tm1}ms  (nodes ${((tn1/tn0-1)*100).toFixed(1)}%, time ${((tm1/tm0-1)*100).toFixed(1)}%)`);
