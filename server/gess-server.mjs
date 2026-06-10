// ─────────────────────────────────────────────────────────────────────────────
// Standalone Gess AI engine server.
//
// Loads the *exact* production Rust→WASM search engine (the same binary the
// browser uses) and exposes it over a small JSON/HTTP API so you can query the
// engine from anything on your local network with `curl`, `fetch`, etc.
//
//   GET  /            → plain-text usage
//   GET  /health      → {ok:true}
//   GET  /newgame     → the initial Gess position (handy for testing)
//   POST /bestmove    → {board, player, budgetMs} → the engine's chosen move
//
// No npm dependencies — pure Node built-ins. Parallel Lazy-SMP search: a pool of
// worker_threads share one WebAssembly.Memory (and thus the transposition table)
// with the main thread, exactly like the browser's Web Worker pool. Defaults to
// the machine's core count; override with THREADS=n.
//
// Run:  node server/gess-server.mjs            # binds 0.0.0.0:8088 (LAN-visible)
//       PORT=9000 HOST=127.0.0.1 node server/gess-server.mjs   # localhost only
//       THREADS=8 node server/gess-server.mjs  # force 8 search threads
//
// "Local network only": binding to 0.0.0.0 makes it reachable by other machines
// on your LAN but, behind a typical NAT/router, not from the public internet.
// There is no auth — only run it on a network you trust.
// ─────────────────────────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(
  __dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release',
  'gess_engine_wasm.wasm',
);
const HELPER_PATH = join(__dirname, 'gess-helper.mjs');

const SIZE = 20;
const COLS = 'abcdefghijklmnopqrst';
const PORT = Number(process.env.PORT ?? 8088);
const HOST = process.env.HOST ?? '0.0.0.0';
const USE_TT = 1;            // transposition table on (production path)
const MAX_BUDGET_MS = 120_000;
const MIN_BUDGET_MS = 10;
const MAX_THREADS = 16;      // cap regardless of core count (Lazy-SMP returns flatten)
// Total search threads = main + helpers. Defaults to the machine's parallelism,
// clamped to [1, MAX_THREADS]; override with THREADS=n.
const THREADS = Math.max(1, Math.min(
  Number(process.env.THREADS ?? (os.availableParallelism?.() ?? os.cpus().length)),
  MAX_THREADS,
));

// ─── Load the engine once ────────────────────────────────────────────────────
// The threaded build imports a *shared* memory (env.memory). dlmalloc grows the
// heap via memory.grow, so `initial` must sit below `maximum`. Growing a shared
// memory happens in place and never detaches views — but we still re-acquire the
// OUT view after each search, since a future build might allocate differently.
const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
});
const wasm = instance.exports;
// Leave null-move + LMR at their production defaults (ON) for full strength.
const BOARD_PTR = wasm.board_ptr();
const OUT_PTR = wasm.out_ptr();

// ─── Lazy-SMP helper pool ────────────────────────────────────────────────────
// THREADS-1 helper workers, each instantiated over the SAME shared memory and
// thus the same transposition table. Spawned serially (await each "ready"): a
// helper instantiates on the shared default stack before relocating its own, so
// overlapping two instantiations could corrupt that stack. Cost is paid once.
async function spawnHelpers(n) {
  const pool = [];
  for (let tid = 1; tid < n; tid++) {
    const w = new Worker(HELPER_PATH, { workerData: { wasmBytes, memory, tid } });
    const [msg] = await once(w, 'message');   // "ready"
    if (!msg?.ready) throw new Error(`helper ${tid} failed to start: ${JSON.stringify(msg)}`);
    w.unref();   // don't keep the process alive on the helpers alone
    pool.push(w);
  }
  return pool;
}
const helpers = await spawnHelpers(THREADS);

// One search at a time: the engine has a single board buffer, OUT buffer and
// shared TT, and the browser never runs two searches concurrently. Concurrent
// HTTP requests are serialised through this promise chain.
let searchTail = Promise.resolve();
function runExclusive(task) {
  const result = searchTail.then(task);
  searchTail = result.then(() => {}, () => {});   // never reject the chain itself
  return result;
}

// ─── Board helpers ───────────────────────────────────────────────────────────

/** The standard Gess opening position as a flat Uint8Array(400): 0/1/2. */
function initialFlat() {
  const flat = new Uint8Array(SIZE * SIZE);
  // Mirror of the app's makeBoard(): white on the top rows, black mirrored.
  const whiteRows = [
    [1, [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17]],
    [2, [1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 16, 17, 18]],
    [3, [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17]],
    [6, [2, 5, 8, 11, 14, 17]],
  ];
  for (const [r, cols] of whiteRows) {
    for (const c of cols) {
      flat[r * SIZE + c] = 1;            // white
      flat[(19 - r) * SIZE + c] = 2;     // black (mirrored)
    }
  }
  return flat;
}

const CHAR_TO_CELL = {
  '.': 0, '-': 0, ' ': 0, '_': 0, '0': 0,
  w: 1, W: 1, '1': 1,
  b: 2, B: 2, '2': 2,
};

/**
 * Accept several friendly board encodings and normalise to Uint8Array(400):
 *   • "start"                          → the opening position
 *   • 20 strings of length 20          → chars . / w / b   (row 0 = top)
 *   • 400 ints (row-major)             → 0 empty, 1 white, 2 black
 *   • 20×20 ints                       → same, nested
 * Throws a descriptive Error on anything malformed.
 */
function parseBoard(board) {
  if (board === 'start' || board === undefined || board === null) return initialFlat();

  const flat = new Uint8Array(SIZE * SIZE);

  // 20 strings.
  if (Array.isArray(board) && board.length === SIZE && typeof board[0] === 'string') {
    for (let r = 0; r < SIZE; r++) {
      const row = board[r];
      if (typeof row !== 'string' || row.length !== SIZE) {
        throw new Error(`board row ${r} must be a ${SIZE}-char string (got ${JSON.stringify(row)})`);
      }
      for (let c = 0; c < SIZE; c++) {
        const v = CHAR_TO_CELL[row[c]];
        if (v === undefined) throw new Error(`board[${r}][${c}]: unknown cell '${row[c]}' (use . w b)`);
        flat[r * SIZE + c] = v;
      }
    }
    return flat;
  }

  // 400 flat ints.
  if (Array.isArray(board) && board.length === SIZE * SIZE && typeof board[0] === 'number') {
    for (let i = 0; i < SIZE * SIZE; i++) flat[i] = checkCell(board[i], i);
    return flat;
  }

  // 20×20 nested ints.
  if (Array.isArray(board) && board.length === SIZE && Array.isArray(board[0])) {
    for (let r = 0; r < SIZE; r++) {
      if (board[r].length !== SIZE) throw new Error(`board row ${r} must have ${SIZE} cells`);
      for (let c = 0; c < SIZE; c++) flat[r * SIZE + c] = checkCell(board[r][c], r * SIZE + c);
    }
    return flat;
  }

  throw new Error('board must be "start", 20 strings, 400 ints, or 20×20 ints');
}

function checkCell(v, i) {
  if (v !== 0 && v !== 1 && v !== 2) throw new Error(`cell ${i}: must be 0, 1 or 2 (got ${v})`);
  return v;
}

function flatToStrings(flat) {
  const rows = [];
  for (let r = 0; r < SIZE; r++) {
    let s = '';
    for (let c = 0; c < SIZE; c++) s += '.wb'[flat[r * SIZE + c]];
    rows.push(s);
  }
  return rows;
}

const square = (r, c) => `${COLS[c]}${SIZE - r}`;
const moveNotation = (fr, fc, tr, tc) => `${square(fr, fc)}-${square(tr, tc)}`;

// ─── The search ────────────────────────────────────────────────────────────

async function chooseMove(flat, white, budgetMs) {
  // Write the board into the engine's input buffer.
  new Uint8Array(memory.buffer, BOARD_PTR, SIZE * SIZE).set(flat);

  let found;
  if (helpers.length > 0) {
    // Parallel Lazy SMP: begin_search() seeds Zobrist + a fresh TT generation and
    // clears STOP, THEN helpers launch (sharing that generation), THEN main
    // searches without bumping the generation (bumpGen=0). On return, stop_search()
    // unwinds the helpers; await them before the shared memory is reused.
    wasm.begin_search();
    const dones = helpers.map((w) => {
      const p = once(w, 'message');
      w.postMessage({ go: true, white, budget: budgetMs });
      return p;
    });
    found = wasm.best_move(white, budgetMs, USE_TT, 0, 0);
    wasm.stop_search();
    await Promise.all(dones);
  } else {
    // Single-threaded standalone search: bumpGen=1 starts a fresh TT generation.
    found = wasm.best_move(white, budgetMs, USE_TT, 0, 1);
  }
  if (!found) return { bestMove: null };

  // Re-acquire the OUT view after the call (search may have grown the heap).
  const out = new Int32Array(memory.buffer, OUT_PTR, 65536);
  const fromR = out[1], fromC = out[2], toR = out[3], toC = out[4];
  const depth = out[5], score = out[6], totalMs = out[7];
  const nRoot = out[8], nDepth = out[9];

  let k = 10;
  const depthTimings = [];
  for (let i = 0; i < nDepth; i++, k += 8) {
    depthTimings.push({
      depth: out[k], ms: out[k + 1], cumulativeMs: out[k + 2],
      best: moveNotation(out[k + 3], out[k + 4], out[k + 5], out[k + 6]),
      score: out[k + 7],
    });
  }

  const nScored = out[k]; k += 1;
  const UNSCORED = -2_000_000_000;
  const chosen = moveNotation(fromR, fromC, toR, toC);
  const topMoves = [];
  for (let i = 0; i < nScored; i++, k += 7) {
    if (i < 20) {
      const score_i = out[k + 4], exact = out[k + 5] === 1, next = out[k + 6];
      const label = moveNotation(out[k], out[k + 1], out[k + 2], out[k + 3]);
      topMoves.push({
        rank: i + 1, move: label, score: score_i,
        next: next === UNSCORED ? null : next,
        type: exact ? 'exact' : (score_i === score ? 'exact(pv)' : 'bound'),
        chosen: label === chosen,
      });
    }
  }

  return {
    bestMove: {
      from: { row: fromR, col: fromC }, to: { row: toR, col: toC },
      fromSquare: square(fromR, fromC), toSquare: square(toR, toC),
      notation: chosen,
    },
    depth, score, ms: totalMs, rootMoves: nRoot,
    depthTimings, topMoves,
  };
}

// ─── HTTP plumbing ─────────────────────────────────────────────────────────

const USAGE = `Gess AI engine server

  GET  /health    liveness probe
  GET  /newgame   the initial Gess position (board strings + flat ints)
  POST /bestmove  ask the engine for a move

POST /bestmove  (Content-Type: application/json)
  {
    "board":   "start"  | [20 strings] | [400 ints] | [20x20 ints],
    "player":  "black" | "white"  (or "b"/"w"),
    "budgetMs": 2000     (think time; ${MIN_BUDGET_MS}..${MAX_BUDGET_MS})
  }
  Board encoding: '.'=empty 'w'=white 'b'=black, or ints 0/1/2. Row 0 is the
  TOP of the board (white's home rows). Coordinates: columns a..t, rows 1..20.

Examples:
  curl localhost:${PORT}/newgame
  curl -X POST localhost:${PORT}/bestmove -H 'content-type: application/json' \\
       -d '{"board":"start","player":"black","budgetMs":2000}'
`;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }

    if (req.method === 'GET' && (path === '/' || path === '/help')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(USAGE);
    }

    if (req.method === 'GET' && path === '/health') {
      return sendJson(res, 200, { ok: true, engine: 'gess-wasm', threads: THREADS });
    }

    if (req.method === 'GET' && path === '/newgame') {
      const flat = initialFlat();
      return sendJson(res, 200, {
        ok: true,
        board: flatToStrings(flat),
        flat: Array.from(flat),
        toMove: 'black',   // black moves first in Gess
      });
    }

    if (req.method === 'POST' && path === '/bestmove') {
      const raw = await readBody(req);
      let payload;
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }

      let flat, white, budgetMs;
      try {
        flat = parseBoard(payload.board);
        const p = String(payload.player ?? 'black').toLowerCase();
        if (p === 'white' || p === 'w') white = 1;
        else if (p === 'black' || p === 'b') white = 0;
        else throw new Error('player must be "white" or "black"');
        budgetMs = Math.max(MIN_BUDGET_MS, Math.min(MAX_BUDGET_MS, Number(payload.budgetMs ?? 2000)));
        if (!Number.isFinite(budgetMs)) throw new Error('budgetMs must be a number');
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message });
      }

      const t0 = Date.now();
      const result = await runExclusive(() => chooseMove(flat, white, budgetMs));
      return sendJson(res, 200, {
        ok: true,
        player: white ? 'white' : 'black',
        budgetMs,
        wallMs: Date.now() - t0,
        ...result,
      });
    }

    return sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Gess engine server listening on http://${HOST}:${PORT}`);
  console.log(`  WASM:    ${WASM_PATH}`);
  console.log(`  Threads: ${THREADS} (1 main + ${helpers.length} helper${helpers.length === 1 ? '' : 's'}, Lazy SMP)`);
  console.log(`  Try:     curl -s localhost:${PORT}/newgame`);
});

// Tidy shutdown: terminate the helper pool so the process can exit promptly.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const w of helpers) w.postMessage({ exit: true });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
