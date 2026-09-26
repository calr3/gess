// ─────────────────────────────────────────────────────────────────────────────
// Loader + thin JS wrapper for the Rust/WASM AI search engine.
//
// The engine is base64-embedded (gess-wasm.generated.ts) and instantiated once.
// It exposes a numeric ABI over linear memory: the caller writes the board into
// the BOARD buffer and reads results from the OUT buffer (see wasm-engine/src/
// lib.rs). Two host functions are imported as env.now / env.random, matching the
// Date.now() / Math.random() the TS engine used.
//
// This wrapper presents the same shape getBestMove did (from/to/depth) and
// reproduces the per-search console diagnostics from the OUT buffer.
// ─────────────────────────────────────────────────────────────────────────────

import { Board, Player, Position } from '../models/game.model';
import { GESS_WASM_BASE64 } from './gess-wasm.generated';

export interface AiMove {
  from: Position;
  to: Position;
  depth: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  board_ptr(): number;
  out_ptr(): number;
  // tid = which thread's scratch slice (0 = this, the main worker); bumpGen = 1
  // to start a fresh TT generation (standalone), 0 in parallel mode where
  // begin_search() already did so before the helpers launched.
  best_move(white: number, timeBudgetMs: number, ttEnabled: number, tid: number, bumpGen: number): number;
  begin_search(): void;
  stop_search(): void;
  // The position's count of consecutive moves without a capture (the search sees
  // the game decided on stones when it reaches QUIET_MOVE_LIMIT). Set before
  // begin_search(), like the board; helpers read it too.
  set_quiet_moves(n: number): void;
}

// Use the transposition table in production. Flip to 0 to disable it cheaply
// (the search then takes the verified TT-off path) — useful for A/B comparison.
const USE_TT = 1;

const SIZE = 20;
const SEARCH_DEBUG = true;
const DEBUG_COLS = 'abcdefghijklmnopqrst';

// Shared linear memory is pre-sized below its max so dlmalloc can grow it (in
// place — shared growth doesn't detach views). 512–1024 pages = 32–64 MiB.
const MEM_INITIAL = 512;
const MEM_MAXIMUM = 1024;
// Cap helper workers regardless of core count: Lazy SMP's returns flatten out and
// each worker reserves its own arena + stack in the shared memory budget.
const MAX_THREADS = 16;

interface Engine {
  ex: WasmExports;
  memory: WebAssembly.Memory;
  helpers: Worker[]; // warm pool, already instantiated over `memory`
}

let enginePromise: Promise<Engine> | null = null;

// Lazy-SMP helper worker, inlined as a Blob so it needs no bundler/dev-server
// support (nested module-worker URLs aren't served by the dev server) and no
// separate file. It's a self-contained classic worker: it receives the compiled
// module + shared memory, relocates its shadow stack to its own region, and runs
// search_helper() to warm the shared TT. blob: URLs are same-origin, so they
// load fine under COOP/COEP.
const HELPER_WORKER_SRC = `
let ex = null, tid = 0;
onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.init) {
      tid = m.tid;
      const env = { memory: m.memory, now: () => Date.now(), random: () => Math.random() };
      const inst = await WebAssembly.instantiate(m.module, { env });
      ex = inst.exports;
      ex.__stack_pointer.value = ex.thread_stack_top(tid); // private shadow stack
      postMessage({ ready: true });
    } else if (m.go && ex) {
      ex.search_helper(m.white, m.budget, tid);
      postMessage({ done: true });
    }
  } catch (err) {
    postMessage({ error: 'helper ' + tid + ': ' + (err && err.message ? err.message : String(err)) });
  }
};
`;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Helper-thread count: hardware threads, clamped to [1, MAX_THREADS]. */
function threadCount(): number {
  const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
  return Math.max(1, Math.min(n, MAX_THREADS));
}

/**
 * Compile the engine, instantiate the main worker's instance over a shared
 * memory, and spin up a warm pool of helper workers that share that memory (and
 * thus the transposition table) for Lazy-SMP parallel search.
 *
 * The threaded build imports a *shared* memory, so it requires cross-origin
 * isolation (COOP/COEP) — see angular.json (dev) and the deployment note. When
 * that isn't available SharedArrayBuffer is missing and we can't construct the
 * memory; instantiation throws, which surfaces as a clear failure rather than
 * silently degrading.
 */
function loadEngine(): Promise<Engine> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const env = { now: () => Date.now(), random: () => Math.random() };
    const module = await WebAssembly.compile(base64ToBytes(GESS_WASM_BASE64));
    const memory = new WebAssembly.Memory({ initial: MEM_INITIAL, maximum: MEM_MAXIMUM, shared: true });
    const instance = await WebAssembly.instantiate(module, { env: { memory, ...env } });
    const ex = instance.exports as unknown as WasmExports;

    // Spawn helpers one at a time, waiting for each "ready": their instantiation
    // runs on the (shared) default stack before they relocate it, so overlapping
    // two instantiations could corrupt that stack. Serialising avoids it; the
    // cost is paid once, on first search.
    const helpers: Worker[] = [];
    if (typeof Worker !== 'undefined') {
      const blobUrl = URL.createObjectURL(
        new Blob([HELPER_WORKER_SRC], { type: 'application/javascript' }),
      );
      for (let tid = 1; tid < threadCount(); tid++) {
        const w = new Worker(blobUrl);
        await new Promise<void>((resolve, reject) => {
          const onMsg = (ev: MessageEvent) => {
            if (ev.data?.ready) { cleanup(); resolve(); }
            else if (ev.data?.error) { cleanup(); reject(new Error(ev.data.error)); }
          };
          const onErr = (ev: ErrorEvent) => {
            cleanup();
            reject(new Error(`helper ${tid} worker error: "${ev.message}" @ ${ev.filename}:${ev.lineno}:${ev.colno}`));
          };
          const cleanup = () => { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); };
          w.addEventListener('message', onMsg);
          w.addEventListener('error', onErr);
          w.postMessage({ init: true, module, memory, tid });
        });
        helpers.push(w);
      }
    }
    return { ex, memory, helpers };
  })();
  return enginePromise;
}

/** Run one helper's search_helper() to completion (it stops at the deadline or
 *  when the main worker calls stop_search()). */
function runHelper(w: Worker, white: number, budget: number): Promise<void> {
  return new Promise<void>(resolve => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.done) { w.removeEventListener('message', onMsg); resolve(); }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ go: true, white, budget });
  });
}

/** Cell[][] → flat bytes (0 empty, 1 white, 2 black), row-major. */
function toFlat(board: Board): Uint8Array {
  const flat = new Uint8Array(SIZE * SIZE);
  for (let r = 0; r < SIZE; r++) {
    const row = board[r];
    for (let c = 0; c < SIZE; c++) {
      const v = row[c];
      flat[r * SIZE + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
    }
  }
  return flat;
}

/**
 * Chooses a move via the WASM negamax search (parallel Lazy SMP + shared TT).
 * `quietMoves` is the game's count of consecutive moves without a capture.
 * Returns the chosen move and the deepest completed depth, or null if there are
 * no legal moves.
 */
export async function getBestMove(
  board: Board, player: Player, timeBudgetMs: number, quietMoves = 0,
): Promise<AiMove | null> {
  const { ex, memory, helpers } = await loadEngine();
  const white = player === 'white' ? 1 : 0;

  // Write the board (re-acquire the view: a previous call may have grown memory).
  new Uint8Array(memory.buffer, ex.board_ptr(), SIZE * SIZE).set(toFlat(board));
  ex.set_quiet_moves(quietMoves);

  let found: number;
  if (helpers.length > 0) {
    // Parallel: begin_search() seeds the Zobrist keys + a fresh TT generation and
    // clears STOP, THEN the helpers launch (sharing that generation), THEN the
    // main worker searches without bumping the generation. When it returns,
    // stop_search() unwinds the helpers and we wait for them before reusing the
    // shared memory for the next search.
    ex.begin_search();
    const done = helpers.map(w => runHelper(w, white, timeBudgetMs));
    found = ex.best_move(white, timeBudgetMs, USE_TT, 0, 0);
    ex.stop_search();
    await Promise.all(done);
  } else {
    // No workers available: standalone search (bump the TT generation itself).
    found = ex.best_move(white, timeBudgetMs, USE_TT, 0, 1);
  }
  if (!found) return null;

  // The search allocates, which may grow (and detach) memory, so read the OUT
  // buffer through a fresh view taken after the call returns.
  const out = new Int32Array(memory.buffer, ex.out_ptr(), 65536);
  const fromR = out[1], fromC = out[2], toR = out[3], toC = out[4];
  const depth = out[5];

  if (SEARCH_DEBUG) logDebug(player, out);

  return { from: { row: fromR, col: fromC }, to: { row: toR, col: toC }, depth };
}

// ─── Diagnostics (reconstructed from the OUT buffer) ─────────────────────────

function moveLabel(fr: number, fc: number, tr: number, tc: number): string {
  const sq = (r: number, c: number) => `${DEBUG_COLS[c]}${SIZE - r}`;
  return `${sq(fr, fc)}-${sq(tr, tc)}`;
}

function formatTable(
  rows: Record<string, string | number>[],
  cols: { key: string; label: string; right?: boolean }[],
): string {
  const w = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key]).length)));
  const line = (cells: string[]) =>
    cells.map((s, i) => (cols[i].right ? s.padStart(w[i]) : s.padEnd(w[i]))).join('  ');
  const lines = [line(cols.map(c => c.label)), w.map(n => '─'.repeat(n)).join('  ')];
  for (const r of rows) lines.push(line(cols.map(c => String(r[c.key]))));
  return lines.join('\n');
}

function logDebug(player: Player, out: Int32Array): void {
  const fromR = out[1], fromC = out[2], toR = out[3], toC = out[4];
  const bestDepth = out[5], bestScore = out[6], totalMs = out[7];
  const nRoot = out[8], nDepth = out[9];

  const UNSCORED = -2_000_000_000; // sentinel: move not reached at the next (uncompleted) depth

  let k = 10;
  const depthTimings: Record<string, string | number>[] = [];
  for (let i = 0; i < nDepth; i++, k += 8) {
    depthTimings.push({
      depth: out[k], ms: out[k + 1], cumulativeMs: out[k + 2],
      // Best move at this depth (ties broken alphabetically by notation in WASM).
      best: moveLabel(out[k + 3], out[k + 4], out[k + 5], out[k + 6]),
      bestScore: out[k + 7],
    });
  }

  const nScored = out[k]; k += 1;
  const chosenLabel = moveLabel(fromR, fromC, toR, toC);
  const moveRows: Record<string, string | number>[] = [];
  for (let i = 0; i < nScored; i++, k += 7) {
    if (i < 20) {
      const fr = out[k], fc = out[k + 1], tr = out[k + 2], tc = out[k + 3];
      const score = out[k + 4], exact = out[k + 5] === 1, nextScore = out[k + 6];
      const label = moveLabel(fr, fc, tr, tc);
      moveRows.push({
        '#': i + 1,
        move: label,
        score: score + 0,
        // Tie-break key: this move's score at the next (uncompleted) depth.
        next: nextScore === UNSCORED ? '—' : nextScore + 0,
        type: exact ? 'exact' : (score === bestScore ? 'exact (pv)' : '≤ bound'),
        chosen: label === chosenLabel ? '★' : '',
      });
    }
  }

  console.log(
    `[Gess AI] ${player}: best depth ${bestDepth}, ${nRoot} root moves, ${totalMs}ms total\n\n` +
    'Time per depth:\n' +
    formatTable(depthTimings, [
      { key: 'depth', label: 'depth', right: true },
      { key: 'ms', label: 'ms', right: true },
      { key: 'cumulativeMs', label: 'cum ms', right: true },
      { key: 'best', label: 'best move' },
      { key: 'bestScore', label: 'score', right: true },
    ]) +
    `\n\nTop ${moveRows.length} moves at depth ${bestDepth}:\n` +
    formatTable(moveRows, [
      { key: '#', label: '#', right: true },
      { key: 'move', label: 'move' },
      { key: 'score', label: 'score', right: true },
      { key: 'next', label: 'next', right: true },
      { key: 'type', label: 'type' },
      { key: 'chosen', label: '' },
    ]),
  );
}
