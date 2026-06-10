// Lazy-SMP speedup benchmark. For each position, runs the production best_move()
// at a fixed time budget twice — once standalone, once with N-1 helper workers
// warming the shared TT — and compares the search depth reached (deeper = the
// parallel search did more useful work in the same wall-clock time).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const HELPER = join(__dirname, 'parallel-helper.mjs');

const POSITIONS = Number(process.argv[2] ?? 12);
const THREADS = Number(process.argv[3] ?? 4);
const BUDGET = Number(process.argv[4] ?? 1000);

function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(7);
const randInt = n => Math.floor(rng() * n);
function ringEndgame() {
  const board = Array.from({ length: 20 }, () => new Array(20).fill(null));
  const placeRing = (p) => { for (let t = 0; t < 30; t++) { const cr = 2 + randInt(15), cc = 2 + randInt(15); let clear = true; for (let dr = -1; dr <= 1 && clear; dr++) for (let dc = -1; dc <= 1; dc++) if (board[cr + dr][cc + dc] !== null) { clear = false; break; } if (!clear) continue; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) board[cr + dr][cc + dc] = p; return; } };
  for (const p of ['white', 'black']) { placeRing(p); if (rng() < 0.5) placeRing(p); }
  const loose = 2 + randInt(6);
  for (let i = 0; i < loose; i++) { const r = 1 + randInt(18), c = 1 + randInt(18); if (board[r][c] === null) board[r][c] = rng() < 0.5 ? 'white' : 'black'; }
  return board;
}
// Midgame positions: play a handful of random legal plies from the start, so
// branching stays high and a search at this budget does sustained work (where
// Lazy SMP's shared-TT pruning actually pays off — unlike tiny endgames).
function midgame() {
  let board = Engine.makeBoard();
  let player = 'black';
  const plies = 8 + randInt(14);
  for (let i = 0; i < plies; i++) {
    if (!Engine.hasRing(board, 'white') || !Engine.hasRing(board, 'black')) break;
    const moves = [];
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
      if (!Engine.isValidFootprintCenter(r, c, board, player)) continue;
      for (const to of Engine.getValidMoves(board, { row: r, col: c }, player)) moves.push({ from: { row: r, col: c }, to });
    }
    if (!moves.length) break;
    const m = moves[randInt(moves.length)];
    board = Engine.applyMove(board, m.from, m.to, player);
    player = player === 'black' ? 'white' : 'black';
  }
  return board;
}
function toFlat(board) { const flat = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } return flat; }

const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const main = (await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } })).instance.exports;
const writeBoard = (b) => new Int8Array(memory.buffer, main.board_ptr(), 400).set(toFlat(b));
const outDepth = () => new Int32Array(memory.buffer, main.out_ptr(), 16)[5];

const helpers = [];
for (let tid = 1; tid < THREADS; tid++) {
  const w = new Worker(HELPER, { workerData: { wasmBytes, memory, tid } });
  await once(w, 'message');
  helpers.push(w);
}

const positions = Array.from({ length: POSITIONS }, midgame);
let sumSingle = 0, sumPar = 0, deeper = 0, n = 0;

for (const board of positions) {
  for (const player of ['white', 'black']) {
    const white = player === 'white' ? 1 : 0;
    writeBoard(board);

    // Standalone (1 thread): best_move bumps its own generation.
    main.best_move(white, BUDGET, 1, 0, 1);
    const dSingle = outDepth();

    // Parallel: begin_search, launch helpers, search without bumping, then stop.
    writeBoard(board);
    main.begin_search();
    const dones = helpers.map(w => { const p = once(w, 'message'); w.postMessage({ go: true, white, budget: BUDGET }); return p; });
    main.best_move(white, BUDGET, 1, 0, 0);
    const dPar = outDepth();
    main.stop_search();
    await Promise.all(dones);

    sumSingle += dSingle; sumPar += dPar; n++;
    if (dPar > dSingle) deeper++;
    process.stdout.write(`  ${player.padEnd(5)} single d=${dSingle}  parallel(${THREADS}t) d=${dPar}  ${dPar > dSingle ? '↑' : dPar < dSingle ? '↓' : '='}\n`);
  }
}

console.log(`\nBudget ${BUDGET}ms, ${THREADS} threads, ${n} searches:`);
console.log(`  avg depth — single: ${(sumSingle / n).toFixed(2)}   parallel: ${(sumPar / n).toFixed(2)}`);
console.log(`  parallel reached deeper in ${deeper}/${n} searches`);
for (const w of helpers) w.postMessage({ exit: true });
process.exit(0);
