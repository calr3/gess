// Honest depth-in-budget benchmark on REPRESENTATIVE positions (opening + real
// midgames), comparing the lazy vs eager move-gen on one build (set_force_eager).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const BUDGET = Number(process.argv[2] ?? 15000);

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
const benchDepth = () => new Int32Array(memory.buffer, ex.out_ptr(), 4)[1];
const bestMoveDepth = () => new Int32Array(memory.buffer, ex.out_ptr(), 8)[5]; // OUT[5] = bestDepth

const positions = [
  ['opening    ', Engine.makeBoard()],
  ['midgame ~12', midgame(12)],
  ['midgame ~24', midgame(24)],
];

for (const [label, board] of positions) {
  const branch = Engine.debugGenRoot(board, 'black').length;
  process.stdout.write(`${label} (black, ${branch} root moves):\n`);
  for (const [mode, force] of [['eager', 1], ['lazy ', 0]]) {
    ex.set_force_eager(force);
    // phase-1-only probe (bench_timed) vs the real production entry (best_move).
    write(board);
    const nodes = ex.bench_timed(0, BUDGET) >>> 0;
    const bd = benchDepth();
    write(board);
    ex.best_move(0, BUDGET, 1, 0, 1);
    const md = bestMoveDepth();
    console.log(`    ${mode}: best_move depth ${md}   (bench_timed phase1-only depth ${bd}, ${nodes.toLocaleString()} nodes)`);
  }
}
