// ─────────────────────────────────────────────────────────────────────────────
// Random engine: plays a uniformly random legal move, except that it avoids
// moves that lose on the spot (destroying its own last ring) unless every move
// does.
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Player, Position } from '../models/game.model';
import type { AiMove } from './gess-wasm';
import * as Flat from './gess-flat';

export function randomMove(board: Board, player: Player, noCaptureStreak = 0): AiMove | null {
  const b = Flat.toFlat(board);
  const me = Flat.stoneOf(player);
  const safe: [number, number][] = [];
  const losing: [number, number][] = [];
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      if (!Flat.isFootprintCentre(b, r, c, me)) continue;
      const from = r * 20 + c;
      for (const to of Flat.destinations(b, r, c, me, [])) {
        const after = Flat.applyMove(b, from, to, me);
        const { result } = Flat.outcomeAfterMove(b, after, me, noCaptureStreak);
        (result === -1 ? losing : safe).push([from, to]);
      }
    }
  const moves = safe.length ? safe : losing;
  if (!moves.length) return null;
  const [from, to] = moves[Math.floor(Math.random() * moves.length)];
  const square = (i: number): Position => ({ row: Math.floor(i / 20), col: i % 20 });
  return { from: square(from), to: square(to), depth: 0 };
}
