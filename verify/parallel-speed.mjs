// Cleaner Lazy-SMP speedup metric: wall-clock time for the main worker to
// complete a FIXED-depth search, with vs without helper workers warming the
// shared TT. Same work target both ways, so the time ratio is the speedup.
// Depth is picked per position so the single-thread time is ~0.5–3s (deep enough
// that shared-TT pruning matters).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const HELPER = join(__dirname, 'parallel-helper.mjs');

const POSITIONS = Number(process.argv[2] ?? 8);
const THREADS = Number(process.argv[3] ?? 2);

function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(99);
const randInt = n => Math.floor(rng() * n);
function ringEndgame() {
  const board = Array.from({ length: 20 }, () => new Array(20).fill(null));
  const placeRing = (p) => { for (let t = 0; t < 30; t++) { const cr = 2 + randInt(15), cc = 2 + randInt(15); let clear = true; for (let dr = -1; dr <= 1 && clear; dr++) for (let dc = -1; dc <= 1; dc++) if (board[cr + dr][cc + dc] !== null) { clear = false; break; } if (!clear) continue; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) board[cr + dr][cc + dc] = p; return; } };
  for (const p of ['white', 'black']) { placeRing(p); if (rng() < 0.5) placeRing(p); }
  const loose = 3 + randInt(8);
  for (let i = 0; i < loose; i++) { const r = 1 + randInt(18), c = 1 + randInt(18); if (board[r][c] === null) board[r][c] = rng() < 0.5 ? 'white' : 'black'; }
  return board;
}
function toFlat(board) { const flat = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } return flat; }

const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const main = (await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } })).instance.exports;
const writeBoard = (b) => new Int8Array(memory.buffer, main.board_ptr(), 400).set(toFlat(b));

const helpers = [];
for (let tid = 1; tid < THREADS; tid++) { const w = new Worker(HELPER, { workerData: { wasmBytes, memory, tid } }); await once(w, 'message'); helpers.push(w); }

function timeSingle(white, depth) {
  writeBoard0(); main.begin_search();
  const t = performance.now();
  main.search_fixed_shared(white, depth, 0);
  return performance.now() - t;
}
let curBoard = null;
function writeBoard0() { writeBoard(curBoard); }

async function timeParallel(white, depth) {
  writeBoard0(); main.begin_search();
  const dones = helpers.map(w => { const p = once(w, 'message'); w.postMessage({ go: true, white, budget: 30000 }); return p; });
  const t = performance.now();
  main.search_fixed_shared(white, depth, 0);
  const dt = performance.now() - t;
  main.stop_search();
  await Promise.all(dones);
  return dt;
}

// Pick a depth whose single-thread time is in a useful band.
function pickDepth(white) {
  for (let d = 4; d <= 12; d++) { if (timeSingle(white, d) > 400) return d; }
  return 12;
}

const positions = Array.from({ length: POSITIONS }, ringEndgame);
let sumS = 0, sumP = 0, count = 0;
for (const board of positions) {
  curBoard = board;
  for (const player of ['white', 'black']) {
    const white = player === 'white' ? 1 : 0;
    const depth = pickDepth(white);
    if (depth > 11) continue;
    // best of 2 to cut noise
    const s = Math.min(timeSingle(white, depth), timeSingle(white, depth));
    const p = Math.min(await timeParallel(white, depth), await timeParallel(white, depth));
    sumS += s; sumP += p; count++;
    console.log(`  ${player.padEnd(5)} depth ${depth}: single ${s.toFixed(0)}ms  parallel(${THREADS}t) ${p.toFixed(0)}ms  speedup ${(s / p).toFixed(2)}x`);
  }
}
console.log(`\n${THREADS} threads, ${count} searches — total single ${sumS.toFixed(0)}ms vs parallel ${sumP.toFixed(0)}ms → ${(sumS / sumP).toFixed(2)}x overall`);
for (const w of helpers) w.postMessage({ exit: true });
process.exit(0);
