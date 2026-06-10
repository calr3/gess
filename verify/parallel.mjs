// Parallel (Lazy SMP) correctness harness.
//
// Spins up N-1 helper workers that share ONE WebAssembly.Memory (and thus the
// transposition table) with the main thread, then for each position:
//   1. main writes the board and calls begin_search()
//   2. helpers run search_helper() concurrently, hammering the shared TT
//   3. main runs search_fixed_shared(depth) over the SAME table
//   4. assert main's bestScore == the TS oracle's fixed-depth value
//
// A fixed-depth minimax value is order-independent, so the only way a thread can
// change it is by corrupting a TT entry. Running this across many positions, at
// several thread counts, with the workers genuinely racing on the table, is the
// strongest correctness signal available for a non-deterministic parallel search.
//
// Usage: node verify/parallel.mjs [positions] [maxThreads]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const HELPER = join(__dirname, 'parallel-helper.mjs');

const POSITIONS = Number(process.argv[2] ?? 250);
const MAX_THREADS = Number(process.argv[3] ?? 8);

// ─── PRNG + position generators (low-branching ring endgames, where the search
//     reaches real depth and the oracle stays affordable) ──────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(0xBEEF);
const randInt = n => Math.floor(rng() * n);

function ringEndgame() {
  const board = Array.from({ length: 20 }, () => new Array(20).fill(null));
  const placeRing = (p) => {
    for (let t = 0; t < 30; t++) {
      const cr = 2 + randInt(15), cc = 2 + randInt(15);
      let clear = true;
      for (let dr = -1; dr <= 1 && clear; dr++) for (let dc = -1; dc <= 1; dc++)
        if (board[cr + dr][cc + dc] !== null) { clear = false; break; }
      if (!clear) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
        if (dr || dc) board[cr + dr][cc + dc] = p;
      return;
    }
  };
  for (const p of ['white', 'black']) { placeRing(p); if (rng() < 0.5) placeRing(p); }
  const loose = 2 + randInt(6);
  for (let i = 0; i < loose; i++) { const r = 1 + randInt(18), c = 1 + randInt(18); if (board[r][c] === null) board[r][c] = rng() < 0.5 ? 'white' : 'black'; }
  return board;
}

function toFlat(board) {
  const flat = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
    const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
  }
  return flat;
}

// ─── Shared memory + main instance ───────────────────────────────────────────
const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const main = (await WebAssembly.instantiate(wasmBytes, {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
})).instance.exports;
const BOARD_PTR = main.board_ptr();
const OUT_PTR = main.out_ptr();
const writeBoard = (board) => new Int8Array(memory.buffer, BOARD_PTR, 400).set(toFlat(board));

async function spawnHelpers(n) {
  const helpers = [];
  for (let tid = 1; tid < n; tid++) {
    const w = new Worker(HELPER, { workerData: { wasmBytes, memory, tid } });
    await once(w, 'message'); // wait for "ready" — instantiation is serialized
    helpers.push(w);
  }
  return helpers;
}

function depthFor(branch) { return branch <= 8 ? 6 : branch <= 16 ? 5 : branch <= 40 ? 4 : 3; }

// ─── Run ─────────────────────────────────────────────────────────────────────
const positions = Array.from({ length: POSITIONS }, ringEndgame);
let totalChecks = 0;

for (const N of [2, 4, MAX_THREADS]) {
  if (N > MAX_THREADS) continue;
  const helpers = await spawnHelpers(N);
  let checks = 0, mismatches = 0, firstFail = null;
  const t0 = Date.now();

  for (const board of positions) {
    for (const player of ['white', 'black']) {
      const white = player === 'white' ? 1 : 0;
      const branch = Engine.debugGenRoot(board, player).length;
      if (branch === 0) continue;
      const depth = depthFor(branch);
      const oracle = Engine.debugSearchRoot(board, player, depth).bestScore;

      writeBoard(board);
      main.begin_search();
      const dones = helpers.map(w => { const p = once(w, 'message'); w.postMessage({ go: true, white, budget: 1500 }); return p; });
      const got = main.search_fixed_shared(white, depth, 0);
      main.stop_search();
      await Promise.all(dones);

      checks++;
      if (got !== oracle) {
        mismatches++;
        if (!firstFail) firstFail = { player, depth, branch, oracle, got, board };
      }
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  totalChecks += checks;
  console.log(`threads=${N}: ${checks} checks in ${secs}s — ${mismatches === 0 ? '✅ all match oracle' : `❌ ${mismatches} MISMATCH`}`);
  if (firstFail) {
    console.log('  first mismatch:', JSON.stringify({ player: firstFail.player, depth: firstFail.depth, branch: firstFail.branch, oracle: firstFail.oracle, got: firstFail.got }));
    console.log(firstFail.board.map(r => r.map(c => c === 'white' ? 'W' : c === 'black' ? 'B' : '.').join('')).join('\n'));
  }
  for (const w of helpers) { w.postMessage({ exit: true }); }
  if (mismatches) process.exit(1);
}

console.log(`\n✅ PASS — ${totalChecks} parallel checks across thread counts, every shared-TT search matched the oracle.`);
process.exit(0);
