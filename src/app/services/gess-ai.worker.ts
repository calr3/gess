/// <reference lib="webworker" />
// AI search worker. Runs the (potentially multi-second) negamax search off the
// main thread so the UI stays responsive while the AI is thinking. Receives a
// board + player + time budget, replies with the chosen move.
//
// The search itself is the Rust engine compiled to WebAssembly (gess-wasm),
// which is instantiated once on first use. It is the sole AI engine; the former
// TypeScript search has been removed (gess-engine now holds only game logic).

import { getBestMove } from './gess-wasm';
import { getBestMove as neuralBestMove, preload as preloadNeural, searchBestMove } from './gess-nn';
import { randomMove } from './gess-random';
import type { Board, Player } from '../models/game.model';

/** Which engine plays the move: the Rust/WASM negamax search, the trained
 *  neural network on its own (policy only, no search), the network guiding a
 *  tree search for the time budget, or random moves that don't lose outright. */
export type AiEngine = 'wasm' | 'neural' | 'neural-mcts' | 'random';

export interface AiRequest {
  board: Board;
  player: Player;
  timeBudgetMs: number;
  engine?: AiEngine;
  /** Consecutive moves without a capture so far: the searches need it to see the
   *  game being decided on stones at QUIET_MOVE_LIMIT. */
  noCaptureStreak?: number;
}

// `postMessage` is typed via the default DOM lib here; cast to the worker's
// single-argument form so we don't need the conflicting webworker lib globals.
const reply = postMessage as unknown as (message: unknown) => void;

// The worker is created at page load, so fetch the network now rather than on
// the first neural move.
preloadNeural();

addEventListener('message', async (event: MessageEvent<AiRequest>) => {
  const { board, player, timeBudgetMs, engine, noCaptureStreak = 0 } = event.data;
  try {
    reply(
      engine === 'random' ? randomMove(board, player, noCaptureStreak)
        : engine === 'neural' ? await neuralBestMove(board, player)
        : engine === 'neural-mcts' ? await searchBestMove(board, player, noCaptureStreak, timeBudgetMs)
        : await getBestMove(board, player, timeBudgetMs, noCaptureStreak),
    );
  } catch (err) {
    // Don't leave the UI hanging on "thinking…" — log and reply null.
    console.error('[Gess AI] search failed:', err);
    reply(null);
  }
});
