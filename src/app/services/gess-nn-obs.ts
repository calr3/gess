// ─────────────────────────────────────────────────────────────────────────────
// Observation encoding for the neural engine.
//
// Turns a board (plus whose turn it is, which piece, if any, has been picked up,
// and the count of moves without a capture) into the 18×18×6 tensor the trained
// network expects. The layout must match the training environment (pgx `gess`
// v2) exactly:
//
//   plane 0 – the mover's stones
//   plane 1 – the opponent's stones
//   plane 2 – the 3×3 footprint of the selected piece (all zero before one is
//             selected)
//   plane 3 – constant 1 once a piece is selected, else 0
//   plane 4 – constant: moves without a capture so far / 20 (the quiet clock)
//   plane 5 – constant: plane 4 signed by who has more stones on the board
//             (+ the mover, − the opponent, 0 when level)
//
// Only the 18×18 playing area (indices 1..18 of the 20×20 grid) is encoded; the
// border ring is always empty. Values are laid out row-major with the channel
// last, i.e. index = ((row * 18) + col) * 6 + plane.
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Player, Position } from '../models/game.model';

// The playing area of the 20×20 grid (mirrors MIN/MAX in gess-engine; kept
// local so this encoder can also run outside the Angular build, e.g. in the
// parity check under verify/).
const PLAY_MIN = 1;
const PLAY_MAX = 18;

export const OBS_SIZE = 18;
export const OBS_PLANES = 6;
// Moves without a capture after which the game is decided on stones (mirrors
// QUIET_MOVE_LIMIT in gess-engine).
const QUIET_LIMIT = 20;
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
 * move, or null when the player is still choosing one. `streak` is the number
 * of moves without a capture so far.
 */
export function buildObservation(
  board: Board,
  player: Player,
  selectedCenter: Position | null,
  streak: number,
): Float32Array {
  const obs = new Float32Array(OBS_LENGTH);
  const opponent: Player = player === 'white' ? 'black' : 'white';
  const stage = selectedCenter ? 1 : 0;
  let lead = 0;

  for (let row = PLAY_MIN; row <= PLAY_MAX; row++) {
    for (let col = PLAY_MIN; col <= PLAY_MAX; col++) {
      const cell = board[row][col];
      const base = ((row - PLAY_MIN) * OBS_SIZE + (col - PLAY_MIN)) * OBS_PLANES;
      if (cell === player) { obs[base] = 1; lead++; }
      else if (cell === opponent) { obs[base + 1] = 1; lead--; }
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
  writeClock(obs, 0, streak, lead);
  return obs;
}

/** Planes 4 and 5: the quiet clock, and the clock signed by who is ahead. */
function writeClock(out: Float32Array, offset: number, streak: number, lead: number): void {
  const clock = Math.fround(streak / QUIET_LIMIT);
  const signed = Math.sign(lead) * clock;
  for (let i = offset; i < offset + OBS_LENGTH; i += OBS_PLANES) {
    out[i + 4] = clock;
    out[i + 5] = signed;
  }
}

/**
 * buildObservation for a flat board (see gess-flat): `me` is the mover's stone
 * value, `source` the selected piece's cell index, or -1, and `streak` the moves
 * without a capture so far. Writes the observation into `out` at `offset`, for
 * filling a batch in place.
 */
export function writeObservation(
  board: Int8Array,
  me: number,
  source: number,
  streak: number,
  out: Float32Array,
  offset: number,
): void {
  const opp = 3 - me;
  const stage = source >= 0 ? 1 : 0;
  const sr = source >= 0 ? Math.floor(source / 20) : -10;
  const sc = source >= 0 ? source % 20 : -10;
  out.fill(0, offset, offset + OBS_LENGTH);
  let lead = 0;
  for (let row = PLAY_MIN; row <= PLAY_MAX; row++) {
    for (let col = PLAY_MIN; col <= PLAY_MAX; col++) {
      const cell = board[row * 20 + col];
      const base = offset + ((row - PLAY_MIN) * OBS_SIZE + (col - PLAY_MIN)) * OBS_PLANES;
      if (cell === me) { out[base] = 1; lead++; }
      else if (cell === opp) { out[base + 1] = 1; lead--; }
      if (Math.abs(row - sr) <= 1 && Math.abs(col - sc) <= 1) out[base + 2] = 1;
      out[base + 3] = stage;
    }
  }
  writeClock(out, offset, streak, lead);
}
