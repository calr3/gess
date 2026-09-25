// ─────────────────────────────────────────────────────────────────────────────
// Neural engine: the AlphaZero-style policy/value network trained in the pgx
// repo, exported to ONNX and run here with onnxruntime-web (WebGPU where the
// browser supports it, WebAssembly otherwise).
//
// The network scores all 400 squares of the 20×20 grid at once. A Gess move is
// two of those choices, so a move takes two forward passes: first the centre of
// the piece to move, then its destination. Illegal squares are masked out and
// the best legal one is played — this is raw policy play, with no search, so it
// answers instantly but is weaker than the network with MCTS behind it.
// ─────────────────────────────────────────────────────────────────────────────

import * as ort from 'onnxruntime-web';

import type { AiMove } from './gess-wasm';
import type { Board, Player, Position } from '../models/game.model';
import { getValidMoves, isValidFootprintCenter, SIZE } from './gess-engine';
import { actionSquare, buildObservation, OBS_PLANES, OBS_SIZE } from './gess-nn-obs';

// Resolved against this bundle's own URL (the build output sits next to
// models/ and ort/), so they work in the worker and under any base href.
const MODEL_URL = new URL('models/gess-policy.onnx', import.meta.url).href;

// Serve onnxruntime's WebAssembly binaries from our own origin (copied into
// public/ort) rather than a CDN, so the app works offline. This must be an
// absolute URL: onnxruntime import()s from it, and a bare 'ort/' is treated as
// a module specifier and fails to resolve.
ort.env.wasm.wasmPaths = new URL('ort/', import.meta.url).href;

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let backendUsed = '';

/** Which onnxruntime backend ended up being used ('webgpu' or 'wasm'). */
export function neuralBackend(): string {
  return backendUsed;
}

async function session(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // WebGPU is much faster but not everywhere yet; fall back to WASM.
      for (const provider of ['webgpu', 'wasm']) {
        try {
          const s = await ort.InferenceSession.create(MODEL_URL, {
            executionProviders: [provider],
          });
          backendUsed = provider;
          console.log(`[Gess NN] model loaded on ${provider}`);
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

/**
 * Start downloading the model and creating the session in the background, so
 * the first neural move doesn't wait for the ~29 MB download.
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

/** Run the network on one position. */
export async function evaluate(
  board: Board,
  player: Player,
  selectedCenter: Position | null,
): Promise<NeuralEvaluation> {
  const s = await session();
  const obs = buildObservation(board, player, selectedCenter);
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
export async function getBestMove(board: Board, player: Player): Promise<AiMove | null> {
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

  const first = await evaluate(board, player, null);
  const from = bestSquare(first.logits, sources);

  const destinations = getValidMoves(board, from, player);
  if (destinations.length === 0) return null;
  const second = await evaluate(board, player, from);
  const to = bestSquare(second.logits, destinations);

  console.log(
    `[Gess NN] ${backendUsed}: value ${first.value.toFixed(3)}, ` +
      `move ${from.row},${from.col} -> ${to.row},${to.col} ` +
      `(${sources.length} pieces, ${destinations.length} destinations)`,
  );
  return { from, to, depth: 0 };
}

/** Exposed for tests/debugging: which action index a square corresponds to. */
export { actionSquare };
