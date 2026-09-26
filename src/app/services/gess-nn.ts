// ─────────────────────────────────────────────────────────────────────────────
// Neural engine: the AlphaZero-style policy/value network trained in the pgx
// repo, exported to ONNX and run here with onnxruntime-web (WebGPU where the
// browser supports it, WebAssembly otherwise).
//
// The network scores all 400 squares of the 20×20 grid at once. A Gess move is
// two of those choices: first the centre of the piece to move, then its
// destination. It plays in two ways:
//   - getBestMove: raw policy play, no search. Two forward passes, the best
//     legal square each time; instant, but the weakest.
//   - searchBestMove: MCTS guided by the network for a time budget (gess-mcts),
//     with the evaluations batched onto the GPU.
// ─────────────────────────────────────────────────────────────────────────────

import * as ort from 'onnxruntime-web';

import type { AiMove } from './gess-wasm';
import type { Board, Player, Position } from '../models/game.model';
import { getValidMoves, isValidFootprintCenter, SIZE } from './gess-engine';
import { actionSquare, buildObservation, OBS_LENGTH, OBS_PLANES, OBS_SIZE } from './gess-nn-obs';
import { stoneOf, toFlat } from './gess-flat';
import { Evaluator, Mcts } from './gess-mcts';

// Resolved against this bundle's own URL (the build output sits next to
// models/ and ort/), so they work in the worker and under any base href.
const MODEL_URL = new URL('models/gess-policy.onnx', import.meta.url).href;

// Serve onnxruntime's WebAssembly binaries from our own origin (copied into
// public/ort) rather than a CDN, so the app works offline. This must be an
// absolute URL: onnxruntime import()s from it, and a bare 'ort/' is treated as
// a module specifier and fails to resolve.
ort.env.wasm.wasmPaths = new URL('ort/', import.meta.url).href;

// On the CPU, batching barely helps throughput but makes the search coarser.
const WASM_BATCH = 8;
// WebGPU batch sizes to try, and the time one batch may take at most: larger
// batches keep the GPU busier, but a round must stay short next to a 2 s budget.
const GPU_BATCHES = [16, 32, 64, 128];
const MAX_ROUND_MS = 150;
// Below this many evaluations per second the "GPU" is no better than the CPU
// (e.g. a software WebGPU adapter), so use WASM instead.
const MIN_GPU_RATE = 60;

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let backendUsed = '';
// Leaves per network call in the tree search, picked by tuneBatch() for WebGPU.
let searchBatch = WASM_BATCH;

/** Which onnxruntime backend ended up being used ('webgpu' or 'wasm'). */
export function neuralBackend(): string {
  return backendUsed;
}

async function session(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const model = new Uint8Array(await (await fetch(MODEL_URL)).arrayBuffer());
      // WebGPU is much faster but not everywhere yet; fall back to WASM.
      for (const provider of ['webgpu', 'wasm']) {
        if (provider === 'webgpu' && !(await hasRealGpu())) continue;
        try {
          const s = await ort.InferenceSession.create(model, {
            executionProviders: [provider],
          });
          if (provider === 'webgpu' && !(await tuneBatch(s))) {
            await s.release();
            continue;
          }
          backendUsed = provider;
          console.log(`[Gess NN] model loaded on ${provider}, search batch ${searchBatch}`);
          return s;
        } catch (err) {
          console.warn(`[Gess NN] ${provider} unavailable:`, err);
        }
      }
      throw new Error('no usable onnxruntime backend');
    })();
    // Don't cache a failure (e.g. a dropped download): let the next use retry.
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

// On machines with two GPUs, use the discrete one.
ort.env.webgpu.powerPreference = 'high-performance';

/** Whether WebGPU has a hardware adapter (not a software fallback like SwiftShader). */
async function hasRealGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<any> } }).gpu;
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) return false;
  if (adapter.info?.isFallbackAdapter) {
    console.warn('[Gess NN] only a software WebGPU adapter; using WASM');
    return false;
  }
  return true;
}

/**
 * Time the network at a few batch sizes on WebGPU (which also compiles its
 * shaders for them before the first real search) and settle on the smallest
 * batch within 15% of the best throughput. False if the GPU is too slow to use.
 */
async function tuneBatch(s: ort.InferenceSession): Promise<boolean> {
  const rates: [number, number][] = [];
  for (const batch of GPU_BATCHES) {
    const input = new ort.Tensor('float32', new Float32Array(batch * OBS_LENGTH), [batch, OBS_SIZE, OBS_SIZE, OBS_PLANES]);
    await s.run({ [s.inputNames[0]]: input }); // warm-up: compiles shaders for this shape
    const t0 = performance.now();
    const runs = 2;
    for (let i = 0; i < runs; i++) await s.run({ [s.inputNames[0]]: input });
    const ms = (performance.now() - t0) / runs;
    rates.push([batch, (batch * 1000) / ms]);
    if (ms > MAX_ROUND_MS || (batch * 1000) / ms < MIN_GPU_RATE) break;
  }
  console.log('[Gess NN] WebGPU evaluations/s by batch:', rates.map(([b, r]) => `${b}: ${r.toFixed(0)}`).join(', '));
  const best = Math.max(...rates.map(([, r]) => r));
  if (best < MIN_GPU_RATE) {
    console.warn(`[Gess NN] WebGPU too slow (${best.toFixed(0)} evals/s); using WASM`);
    return false;
  }
  searchBatch = rates.find(([, r]) => r >= 0.85 * best)![0];
  return true;
}

/**
 * Start downloading the model and creating the session in the background, so
 * the first neural move doesn't wait for the ~29 MB download (or, on WebGPU,
 * for the batch-size tuning and shader compilation).
 */
export function preload(): void {
  session().catch(err => console.warn('[Gess NN] preload failed:', err));
}

export interface NeuralEvaluation {
  /** Raw score per square of the 20×20 grid (index = row * 20 + col). */
  logits: Float32Array;
  /** The network's value for the side to move, in [-1, 1]. */
  value: number;
}

/** Run the network on one position; `streak` is the moves without a capture so far. */
export async function evaluate(
  board: Board,
  player: Player,
  selectedCenter: Position | null,
  streak: number,
): Promise<NeuralEvaluation> {
  const s = await session();
  const obs = buildObservation(board, player, selectedCenter, streak);
  const input = new ort.Tensor('float32', obs, [1, OBS_SIZE, OBS_SIZE, OBS_PLANES]);
  const outputs = await s.run({ [s.inputNames[0]]: input });
  const tensors = s.outputNames.map(name => outputs[name]);
  const policy = tensors.find(t => t.size === SIZE * SIZE)!;
  const value = tensors.find(t => t.size === 1)!;
  return {
    logits: policy.data as Float32Array,
    value: (value.data as Float32Array)[0],
  };
}

function bestSquare(logits: Float32Array, legal: Position[]): Position {
  let best = legal[0];
  let bestScore = -Infinity;
  for (const square of legal) {
    const score = logits[square.row * SIZE + square.col];
    if (score > bestScore) {
      bestScore = score;
      best = square;
    }
  }
  return best;
}

/**
 * Choose a move with the network alone (no search).
 *
 * Returns the same shape as the WASM engine's `getBestMove` so the two are
 * interchangeable; `depth` is 0 because nothing is searched.
 */
export async function getBestMove(board: Board, player: Player, streak: number): Promise<AiMove | null> {
  const sources: Position[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (isValidFootprintCenter(row, col, board, player)) {
        // A piece with no legal destination is not a playable choice.
        if (getValidMoves(board, { row, col }, player).length > 0) sources.push({ row, col });
      }
    }
  }
  if (sources.length === 0) return null;

  const first = await evaluate(board, player, null, streak);
  const from = bestSquare(first.logits, sources);

  const destinations = getValidMoves(board, from, player);
  if (destinations.length === 0) return null;
  const second = await evaluate(board, player, from, streak);
  const to = bestSquare(second.logits, destinations);

  console.log(
    `[Gess NN] ${backendUsed}: value ${first.value.toFixed(3)}, ` +
      `move ${from.row},${from.col} -> ${to.row},${to.col} ` +
      `(${sources.length} pieces, ${destinations.length} destinations)`,
  );
  return { from, to, depth: 0 };
}

/** Run the network on `count` observations laid out back to back in `obs`. */
const evaluateBatch: Evaluator = async (obs, count) => {
  const s = await session();
  const outputs = await s.run({
    [s.inputNames[0]]: new ort.Tensor('float32', obs, [count, OBS_SIZE, OBS_SIZE, OBS_PLANES]),
  });
  const tensors = s.outputNames.map(name => outputs[name]);
  return {
    logits: tensors.find(t => t.size === count * SIZE * SIZE)!.data as Float32Array,
    values: tensors.find(t => t.size === count)!.data as Float32Array,
  };
};

// One search tree for the page, kept between moves so the part of it the game
// goes on into is reused.
const mcts = new Mcts(evaluateBatch);

/**
 * Choose a move by searching with the network for `budgetMs` (not counting the
 * one-off model load). `noCaptureStreak` is the game's count of moves without a capture,
 * which tells the search when the game will be decided on stones.
 */
export async function searchBestMove(
  board: Board, player: Player, noCaptureStreak: number, budgetMs: number,
): Promise<AiMove | null> {
  await session();
  const result = await mcts.search(toFlat(board), stoneOf(player), noCaptureStreak, {
    budgetMs,
    batchSize: searchBatch,
  });
  if (!result) return null;
  const square = (i: number): Position => ({ row: Math.floor(i / SIZE), col: i % SIZE });
  const rate = result.evaluations / Math.max(result.elapsedMs / 1000, 1e-3);
  console.log(
    `[Gess NN] search on ${backendUsed}: ${result.evaluations} evaluations in ` +
      `${result.elapsedMs.toFixed(0)} ms (${rate.toFixed(0)}/s, batch ${searchBatch}), ` +
      `root visits ${result.rootVisits}, value ${result.value.toFixed(3)}`,
  );
  return { from: square(result.from), to: square(result.to), depth: 0 };
}

/** Exposed for tests/debugging: which action index a square corresponds to. */
export { actionSquare };
