// ─────────────────────────────────────────────────────────────────────────────
// Observation encoding for the neural engine.
//
// Turns a board (plus whose turn it is and which piece, if any, has been picked
// up) into the 18×18×4 tensor the trained network expects. The layout must match
// the training environment (pgx `gess`) exactly:
//
//   plane 0 – the mover's stones
//   plane 1 – the opponent's stones
//   plane 2 – the 3×3 footprint of the selected piece (all zero before one is
//             selected)
//   plane 3 – constant 1 once a piece is selected, else 0
//
// Only the 18×18 playing area (indices 1..18 of the 20×20 grid) is encoded; the
// border ring is always empty. Values are laid out row-major with the channel
// last, i.e. index = ((row * 18) + col) * 4 + plane.
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Player, Position } from '../models/game.model';

// The playing area of the 20×20 grid (mirrors MIN/MAX in gess-engine; kept
// local so this encoder can also run outside the Angular build, e.g. in the
// parity check under verify/).
const PLAY_MIN = 1;
const PLAY_MAX = 18;

export const OBS_SIZE = 18;
export const OBS_PLANES = 4;
export const OBS_LENGTH = OBS_SIZE * OBS_SIZE * OBS_PLANES;

/** The action index (0..399) the network uses for a square of the 20×20 grid. */
export function actionIndex(row: number, col: number): number {
  return row * 20 + col;
}

/** The 20×20 square an action index refers to. */
export function actionSquare(action: number): Position {
  return { row: Math.floor(action / 20), col: action % 20 };
}

/**
 * Build the network input for the position as seen by `player`.
 *
 * `selectedCenter` is the centre of the piece picked up in the first half of a
 * move, or null when the player is still choosing one.
 */
export function buildObservation(
  board: Board,
  player: Player,
  selectedCenter: Position | null,
): Float32Array {
  const obs = new Float32Array(OBS_LENGTH);
  const opponent: Player = player === 'white' ? 'black' : 'white';
  const stage = selectedCenter ? 1 : 0;

  for (let row = PLAY_MIN; row <= PLAY_MAX; row++) {
    for (let col = PLAY_MIN; col <= PLAY_MAX; col++) {
      const cell = board[row][col];
      const base = ((row - PLAY_MIN) * OBS_SIZE + (col - PLAY_MIN)) * OBS_PLANES;
      if (cell === player) obs[base] = 1;
      else if (cell === opponent) obs[base + 1] = 1;
      if (
        selectedCenter &&
        Math.abs(row - selectedCenter.row) <= 1 &&
        Math.abs(col - selectedCenter.col) <= 1
      ) {
        obs[base + 2] = 1;
      }
      obs[base + 3] = stage;
    }
  }
  return obs;
}
