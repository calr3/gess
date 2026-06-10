// Clean A/B for the mask-fusion: a FIXED-depth search runs an identical node
// count regardless (the eval is byte-identical), so node count is constant and
// the only variable is per-node time. Report node count + min wall time over N
// runs (min cuts scheduler noise). Run on each build and compare the min times.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const DEPTH = Number(process.argv[2] ?? 4);
const RUNS = Number(process.argv[3] ?? 7);

function mulberry32(s){let a=s>>>0;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rng = mulberry32(2024); const ri = n => Math.floor(rng() * n);
function midgame(plies) {
  let board = Engine.makeBoard(); let player = 'black';
  for (let i = 0; i < plies; i++) {
    if (!Engine.hasRing(board, 'white') || !Engine.hasRing(board, 'black')) break;
    const moves = [];
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { if (!Engine.isValidFootprintCenter(r, c, board, player)) continue; for (const to of Engine.getValidMoves(board, { row: r, col: c }, player)) moves.push({ from: { row: r, col: c }, to }); }
    if (!moves.length) break;
    const m = moves[ri(moves.length)];
    board = Engine.applyMove(board, m.from, m.to, player);
    player = player === 'black' ? 'white' : 'black';
  }
  return board;
}
const toFlat = b => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r*20+c] = v==='white'?1:v==='black'?2:0; } return f; };

const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const ex = (await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } })).instance.exports;
const write = b => new Int8Array(memory.buffer, ex.board_ptr(), 400).set(toFlat(b));

for (const [label, board] of [['midgame ~10', midgame(10)], ['midgame ~16', midgame(16)]]) {
  write(board); const nodes = ex.bench_fixed(0, DEPTH) >>> 0; // warm
  let min = Infinity, sum = 0;
  for (let i = 0; i < RUNS; i++) { write(board); const t = performance.now(); ex.bench_fixed(0, DEPTH); const dt = performance.now() - t; min = Math.min(min, dt); sum += dt; }
  console.log(`${label}: depth ${DEPTH}, ${nodes.toLocaleString()} nodes  →  min ${min.toFixed(1)}ms  (avg ${(sum/RUNS).toFixed(1)}ms)  ${Math.round(nodes/(min/1000)).toLocaleString()} nodes/s`);
}
