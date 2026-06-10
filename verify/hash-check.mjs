// Directly verifies the incremental Zobrist hash: hash_check_run() walks a
// fixed-depth search comparing the incrementally-maintained hash to a fresh
// compute_hash at every node, returning the mismatch count (must be 0).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');

function mulberry32(s){let a=s>>>0;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rng = mulberry32(0x5EED);
const ri = n => Math.floor(rng() * n);

function scatter(density) {
  const b = Array.from({ length: 20 }, () => new Array(20).fill(null));
  for (let r = 1; r <= 18; r++) for (let c = 1; c <= 18; c++) { const x = rng(); if (x < density) b[r][c] = x < density / 2 ? 'white' : 'black'; }
  return b;
}
function selfPlay(plies) {
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
const toFlat = b => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } return f; };

const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const ex = (await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } })).instance.exports;
const write = b => new Int8Array(memory.buffer, ex.board_ptr(), 400).set(toFlat(b));

const positions = [];
positions.push(Engine.makeBoard());
for (let i = 0; i < 60; i++) positions.push(selfPlay(6 + ri(24)));
for (let i = 0; i < 40; i++) positions.push(scatter([0.08, 0.15, 0.3][i % 3]));

let checks = 0, mismatches = 0, nodesProxy = 0;
for (const board of positions) {
  for (const player of ['white', 'black']) {
    const white = player === 'white' ? 1 : 0;
    const branch = Engine.debugGenRoot(board, player).length;
    if (branch === 0) continue;
    const depth = branch <= 12 ? 6 : branch <= 40 ? 4 : 3; // keep node counts bounded
    write(board);
    const m = ex.hash_check_run(white, depth);
    checks++;
    if (m !== 0) { mismatches++; if (mismatches <= 3) console.log(`  MISMATCH: player=${player} depth=${depth} branch=${branch} count=${m}`); }
  }
}
console.log(`hash_check_run over ${checks} (position,depth) searches`);
console.log(mismatches === 0
  ? '✅ PASS — incremental hash matched a fresh compute_hash at every node.'
  : `❌ FAIL — ${mismatches} searches had hash mismatches.`);
process.exit(mismatches === 0 ? 0 : 1);
