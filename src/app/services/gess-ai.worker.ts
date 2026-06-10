/// <reference lib="webworker" />
// AI search worker. Runs the (potentially multi-second) negamax search off the
// main thread so the UI stays responsive while the AI is thinking. Receives a
// board + player + time budget, replies with the chosen move.
//
// The search itself is the Rust engine compiled to WebAssembly (gess-wasm),
// which is instantiated once on first use. It is a verified, behaviour-identical
// replacement for the former TypeScript search in gess-engine.

import { getBestMove } from './gess-wasm';
import type { Board, Player } from '../models/game.model';

export interface AiRequest {
  board: Board;
  player: Player;
  timeBudgetMs: number;
}

// `postMessage` is typed via the default DOM lib here; cast to the worker's
// single-argument form so we don't need the conflicting webworker lib globals.
const reply = postMessage as unknown as (message: unknown) => void;

addEventListener('message', async (event: MessageEvent<AiRequest>) => {
  const { board, player, timeBudgetMs } = event.data;
  try {
    reply(await getBestMove(board, player, timeBudgetMs));
  } catch (err) {
    // Don't leave the UI hanging on "thinking…" — log and reply null.
    console.error('[Gess AI] search failed:', err);
    reply(null);
  }
});
