// ─────────────────────────────────────────────────────────────────────────────
// Pure Gess game logic — framework-free move/ring/quiet-move rules.
//
// Used by GessService and the board component for move legality, captures, ring
// detection, and the quiet-move rule. Everything here is a pure function of its
// arguments. No Angular imports. The negamax AI lives in the Rust→WASM engine
// (gess-wasm), and the neural search in gess-mcts (on gess-flat's copy of these
// rules).
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Cell, Player, Position } from '../models/game.model';

// Gess is played on a 20×20 grid. The playing area is the inner 18×18
// (indices 1‑18); the outermost ring (indices 0 and 19) is the invisible
// "border" — any stone that lands there at the end of a move is removed.
export const SIZE = 20;
export const MIN = 1;   // first playing-area index
export const MAX = 18;  // last playing-area index

// [dr, dc] for each of the 8 footprint positions relative to center
const DIRS: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0,  -1],          [0,  1],
  [1,  -1], [1,  0], [1,  1],
];

// Default per-move wall-clock budget handed to the WASM search by GessService.
export const TIME_BUDGET_MS = 10_000;

// ─── Move logic ──────────────────────────────────────────────────────────────

/**
 * Returns true iff the 3×3 centered at (row,col) is a legal footprint for player:
 * none of the opponent's stones anywhere in it, and at least one of the player's
 * among the eight cells around the centre (a lone centre stone can't move, so it
 * isn't a piece — as in pgx). The centre may be anywhere on the 20×20 grid —
 * including the border ring (indices 0 and 19) — so a piece can be centred just
 * off the playing area, with the rest of its footprint hanging into the empty
 * margin (cells outside 0..19).
 */
export function isValidFootprintCenter(row: number, col: number, board: Board, player: Player): boolean {
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return false;
  const opp: Player = player === 'white' ? 'black' : 'white';
  let hasOwn = false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr, c = col + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin is empty
      const cell = board[r][c];
      if (cell === opp) return false;
      if (cell === player && (dr !== 0 || dc !== 0)) hasOwn = true;
    }
  }
  return hasOwn;
}

/** Returns all legal destination centers for a footprint centered at `center`. */
export function getValidMoves(board: Board, center: Position, player: Player): Position[] {
  const { row, col } = center;
  // Centre stone → unlimited range; otherwise max 3 squares
  const maxSteps = board[row][col] === player ? SIZE : 3;
  const results: Position[] = [];
  const seen = new Set<string>();

  // The original 3×3 footprint is treated as empty: the piece moves away from here.
  const origin = new Set<string>();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++)
      origin.add(`${row + ddr},${col + ddc}`);

  for (const [dr, dc] of DIRS) {
    // The footprint cell in this direction must hold the player's stone. For a
    // border-centred piece that cell can be off-board (margin) → no stone.
    const fr = row + dr, fc = col + dc;
    if (fr < 0 || fr >= SIZE || fc < 0 || fc >= SIZE) continue;
    if (board[fr][fc] !== player) continue;

    for (let step = 1; step <= maxSteps; step++) {
      const nr = row + dr * step;
      const nc = col + dc * step;
      // A piece may move partially — but not entirely — off the board. The
      // centre may move one square past the playing area (onto the border
      // ring), leaving a single rank/file on the board; moving the centre any
      // further would carry the whole footprint off.
      if (nr < MIN - 1 || nr > MAX + 1 || nc < MIN - 1 || nc > MAX + 1) break;

      // Scan the new footprint for any stone not belonging to the original piece.
      // Any such stone — own or opponent — stops further sliding; the piece may
      // still land here, displacing whatever is there (including own stones).
      // Cells off the playing area (the border and beyond) are always empty.
      let hitsAny = false;
      outer:
      for (let ddr = -1; ddr <= 1; ddr++) {
        for (let ddc = -1; ddc <= 1; ddc++) {
          const sr = nr + ddr, sc = nc + ddc;
          if (origin.has(`${sr},${sc}`)) continue; // transparent: original footprint
          if (sr < MIN || sr > MAX || sc < MIN || sc > MAX) continue; // off-board: empty
          if (board[sr][sc] !== null) { hitsAny = true; break outer; }
        }
      }

      const key = `${nr},${nc}`;
      if (!seen.has(key)) { seen.add(key); results.push({ row: nr, col: nc }); }

      if (hitsAny) break; // first intersection: land here (displacing stones), stop sliding
    }
  }
  return results;
}

/** Returns the board that results from moving the footprint at `from` to `to`. */
export function applyMove(board: Board, from: Position, to: Position, player: Player): Board {
  const b: Cell[][] = board.map(r => [...r]);
  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));

  // Record which relative positions held player stones, then clear the footprint
  const relStones: [number, number][] = [];
  for (let ddr = -1; ddr <= 1; ddr++) {
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin
      if (b[r][c] === player) { relStones.push([ddr, ddc]); b[r][c] = null; }
    }
  }

  // Slide step by step, displacing any stone (own or opponent) at the landing footprint.
  // Intermediate steps are guaranteed empty by getValidMoves; only the final step may have stones.
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && b[r][c] !== null)
          b[r][c] = null;
      }
    }
  }

  // Place stones at destination. Stones that land on the border ring (the
  // invisible outermost row/column, indices 0 and 19) are removed — the rest stay.
  for (const [ddr, ddc] of relStones) {
    const r = to.row + ddr, c = to.col + ddc;
    if (r >= MIN && r <= MAX && c >= MIN && c <= MAX) b[r][c] = player;
  }

  return b;
}

/**
 * Counts the stones captured by moving the footprint at `from` to `to`: stones
 * displaced where the piece lands, split into opponent (`opp`) and the mover's
 * own (`self`). The moving piece's own stones (lifted from the origin) are not
 * captures, and neither are its stones that fall off the board edge — only
 * stones standing at the destination that get displaced count.
 */
export function countCaptures(
  board: Board, from: Position, to: Position, player: Player,
): { opp: number; self: number } {
  const opponent: Player = player === 'white' ? 'black' : 'white';

  // The moving piece's own stones, by absolute origin coordinate — these travel
  // with the piece, so they are never "captured".
  const lifted = new Set<string>();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue; // off-board margin
      if (board[r][c] === player) lifted.add(`${r},${c}`);
    }

  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));

  let opp = 0, self = 0;
  const counted = new Set<string>();
  // Intermediate steps are guaranteed empty by getValidMoves, so in practice
  // only the destination footprint contributes; the path scan is just robust.
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
        const key = `${r},${c}`;
        if (lifted.has(key) || counted.has(key)) continue;
        const cell = board[r][c];
        if (cell === opponent) { opp++; counted.add(key); }
        else if (cell === player) { self++; counted.add(key); }
      }
    }
  }
  return { opp, self };
}

// ─── Ring detection ────────────────────────────────────────────────────────
// A ring is a 3×3 footprint whose centre cell is empty and all 8 surrounding
// cells contain the player's own stone.

export function hasRing(board: Board, player: Player): boolean {
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) return true;
  return false;
}

export function countRings(board: Board, player: Player): number {
  let count = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) count++;
  return count;
}

/** Number of stones `player` has on the board. */
export function countStones(board: Board, player: Player): number {
  let n = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (board[r][c] === player) n++;
  return n;
}

// ─── Quiet-move rule ─────────────────────────────────────────────────────────
// If neither side captures a stone for this many consecutive moves (each
// player's move counts as one), the game ends and is decided on the stones left
// on the board: more stones wins, and only an exact tie is a draw. These are the
// rules of the training environment (pgx gess v1); verify/pgx-conformance.ts
// checks the app against it.
export const QUIET_MOVE_LIMIT = 20;

/** The total number of stones on the board (both colours). */
export function totalStones(board: Board): number {
  return countStones(board, 'white') + countStones(board, 'black');
}

/**
 * Did a move remove any stone from the board? True iff the post-move board has
 * fewer total stones than the pre-move board. This counts every kind of removal
 * — capturing an opponent stone, displacing one of your own at the destination,
 * or pushing one of your own off the board edge (a self-capture) — so any of
 * them resets the no-capture streak.
 */
export function wasCapture(before: Board, after: Board): boolean {
  return totalStones(after) < totalStones(before);
}

/** Outcome of the position after a move, from the mover's point of view. */
export type Outcome =
  | 'mover-wins' | 'mover-loses' | 'both-lose'                    // on rings
  | 'mover-wins-on-stones' | 'mover-loses-on-stones' | 'draw'     // at the quiet-move limit
  | 'ongoing';

/** Whether an outcome is a win for the mover, a loss, or a draw (null: play on). */
export function outcomeResult(outcome: Outcome): 1 | 0 | -1 | null {
  switch (outcome) {
    case 'mover-wins': case 'mover-wins-on-stones': return 1;
    case 'mover-loses': case 'mover-loses-on-stones': case 'both-lose': return -1;
    case 'draw': return 0;
    default: return null;
  }
}

/**
 * Decide the game outcome after the mover has played, given the post-move ring
 * and stone counts and the resulting quiet-move count (consecutive moves,
 * including this one, that ended without a capture).
 *
 * Rings take STRICT PRECEDENCE over the quiet-move limit: a move that empties a
 * side's rings on the very move the limit is reached is decided on rings.
 *   - mover has no rings, opponent has none → both lost; the mover moved last,
 *     so the mover loses (`both-lose`);
 *   - mover has no rings → mover destroyed their own last ring → `mover-loses`;
 *   - opponent has no rings → `mover-wins`;
 *   - otherwise, at the limit → decided on stones (`mover-wins-on-stones`,
 *     `mover-loses-on-stones`, or `draw` on an exact tie); else `ongoing`.
 */
export function resolveOutcome(
  moverRings: number, oppRings: number, quietMoves: number,
  moverStones: number, oppStones: number,
): Outcome {
  if (moverRings === 0 && oppRings === 0) return 'both-lose';
  if (moverRings === 0) return 'mover-loses';
  if (oppRings === 0) return 'mover-wins';
  if (quietMoves >= QUIET_MOVE_LIMIT) {
    if (moverStones > oppStones) return 'mover-wins-on-stones';
    if (moverStones < oppStones) return 'mover-loses-on-stones';
    return 'draw';
  }
  return 'ongoing';
}

/** Returns the set of ring-centre cells for `player` (one cell per ring). */
export function getEnclosedCells(board: Board, player: Player): Set<string> {
  const centres = new Set<string>();
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) centres.add(`${r},${c}`);
  return centres;
}

/** True iff (row, col) is the centre of a ring: empty centre, all 8 neighbours owned by player. */
function isRingCenter(board: Board, row: number, col: number, player: Player): boolean {
  if (board[row][col] !== null) return false; // centre must be empty
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if ((dr !== 0 || dc !== 0) && board[row + dr][col + dc] !== player) return false;
  return true;
}

// ─── Initial position ────────────────────────────────────────────────────────

export function makeBoard(): Board {
  const board: Board = Array.from({ length: SIZE }, () => new Array<Cell>(SIZE).fill(null));

  // Standard Gess starting position — 43 stones per player, 1 ring each.
  // Coordinates are in the 20×20 grid: the 18×18 playing area is indices 1‑18.
  // White occupies playing rows 1,2,3,6 (labels 19,18,17,14); black is the
  // vertical mirror at rows 18,17,16,13 (i.e. row 19 − whiteRow).
  const whiteCols: [number, number[]][] = [
    [1, [2,4,6,7,8,9,10,11,12,13,15,17]],          // label 18 — 12 stones
    [2, [1,2,3,5,7,8,9,10,12,14,16,17,18]],         // label 17 — 13 stones
    [3, [2,4,6,7,8,9,10,11,12,13,15,17]],           // label 16 — 12 stones
    [6, [2,5,8,11,14,17]],                          // label 13 —  6 stones
  ];

  for (const [r, cols] of whiteCols) {
    for (const c of cols) {
      board[r][c]      = 'white';
      board[19 - r][c] = 'black'; // black is the vertical mirror
    }
  }

  return board;
}
