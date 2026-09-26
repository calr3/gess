// ─────────────────────────────────────────────────────────────────────────────
// Gess rules on a flat board, for the neural tree search.
//
// The same rules as gess-engine, but on an Int8Array of 400 cells (index =
// row * 20 + col; 0 empty, 1 black, 2 white) and without the string-keyed sets,
// so the search can generate moves and store thousands of positions cheaply.
// verify/flat-rules-parity.ts checks it against gess-engine on random games,
// and verify/pgx-conformance.ts against pgx (the training environment).
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Player } from '../models/game.model';
import { MAX, MIN, QUIET_MOVE_LIMIT, SIZE } from './gess-engine';

export type FlatBoard = Int8Array;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const CELLS = SIZE * SIZE;

const DIRS: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0,  -1],          [0,  1],
  [1,  -1], [1,  0], [1,  1],
];

export function stoneOf(player: Player): number {
  return player === 'black' ? BLACK : WHITE;
}

export function toFlat(board: Board): FlatBoard {
  const b = new Int8Array(CELLS);
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      const cell = board[r][c];
      if (cell) b[r * SIZE + c] = stoneOf(cell);
    }
  return b;
}

export function fromFlat(b: FlatBoard): Board {
  const board: Board = [];
  for (let r = 0; r < SIZE; r++) {
    const row: Board[number] = [];
    for (let c = 0; c < SIZE; c++) {
      const v = b[r * SIZE + c];
      row.push(v === BLACK ? 'black' : v === WHITE ? 'white' : null);
    }
    board.push(row);
  }
  return board;
}

/** gess-engine's isValidFootprintCenter. */
export function isFootprintCentre(b: FlatBoard, row: number, col: number, me: number): boolean {
  const opp = 3 - me;
  let hasOwn = false;
  for (let dr = -1; dr <= 1; dr++) {
    const r = row + dr;
    if (r < 0 || r >= SIZE) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const c = col + dc;
      if (c < 0 || c >= SIZE) continue;
      const v = b[r * SIZE + c];
      if (v === opp) return false;
      if (v === me && (dr !== 0 || dc !== 0)) hasOwn = true;
    }
  }
  return hasOwn;
}

/**
 * gess-engine's getValidMoves: the destination centres (as cell indices) for
 * the piece centred at (row, col), appended to `out`. With `firstOnly`, stops
 * after finding one — enough to know whether the piece can move at all.
 */
export function destinations(
  b: FlatBoard, row: number, col: number, me: number, out: number[], firstOnly = false,
): number[] {
  const maxSteps = b[row * SIZE + col] === me ? SIZE : 3;
  for (const [dr, dc] of DIRS) {
    const fr = row + dr, fc = col + dc;
    if (fr < 0 || fr >= SIZE || fc < 0 || fc >= SIZE) continue;
    if (b[fr * SIZE + fc] !== me) continue;

    for (let step = 1; step <= maxSteps; step++) {
      const nr = row + dr * step;
      const nc = col + dc * step;
      if (nr < MIN - 1 || nr > MAX + 1 || nc < MIN - 1 || nc > MAX + 1) break;

      // Any stone in the new footprint outside the original one stops the
      // slide here (the piece still lands, displacing it).
      let hitsAny = false;
      for (let ddr = -1; ddr <= 1 && !hitsAny; ddr++) {
        const sr = nr + ddr;
        if (sr < MIN || sr > MAX) continue;
        for (let ddc = -1; ddc <= 1; ddc++) {
          const sc = nc + ddc;
          if (sc < MIN || sc > MAX) continue;
          if (Math.abs(sr - row) <= 1 && Math.abs(sc - col) <= 1) continue; // original footprint
          if (b[sr * SIZE + sc] !== EMPTY) { hitsAny = true; break; }
        }
      }

      out.push(nr * SIZE + nc);
      if (firstOnly) return out;
      if (hitsAny) break;
    }
  }
  return out;
}

/** gess-engine's applyMove, returning a new board. */
export function applyMove(b: FlatBoard, from: number, to: number, me: number): FlatBoard {
  const nb = b.slice();
  const fr = Math.floor(from / SIZE), fc = from % SIZE;
  const tr = Math.floor(to / SIZE), tc = to % SIZE;
  const dr = Math.sign(tr - fr), dc = Math.sign(tc - fc);
  const steps = Math.max(Math.abs(tr - fr), Math.abs(tc - fc));

  // Lift the piece's own stones (as a 3×3 bit mask), clearing the footprint.
  let lifted = 0;
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = fr + ddr, c = fc + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
      if (nb[r * SIZE + c] === me) { lifted |= 1 << ((ddr + 1) * 3 + ddc + 1); nb[r * SIZE + c] = EMPTY; }
    }

  // Clear everything under the piece's path (only the landing square can hold stones).
  for (let step = 1; step <= steps; step++) {
    const cr = fr + dr * step, cc = fc + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++)
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) nb[r * SIZE + c] = EMPTY;
      }
  }

  // Put the stones down; any landing off the playing area are removed.
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++) {
      if (!(lifted & (1 << ((ddr + 1) * 3 + ddc + 1)))) continue;
      const r = tr + ddr, c = tc + ddc;
      if (r >= MIN && r <= MAX && c >= MIN && c <= MAX) nb[r * SIZE + c] = me;
    }
  return nb;
}

export function hasRing(b: FlatBoard, me: number): boolean {
  for (let r = MIN; r <= MAX; r++)
    outer: for (let c = MIN; c <= MAX; c++) {
      if (b[r * SIZE + c] !== EMPTY) continue;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if ((dr !== 0 || dc !== 0) && b[(r + dr) * SIZE + c + dc] !== me) continue outer;
      return true;
    }
  return false;
}

export function stoneCount(b: FlatBoard, stone?: number): number {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (stone === undefined ? b[i] !== EMPTY : b[i] === stone) n++;
  return n;
}

/**
 * The result of `mover` having just produced `after` from `before` with the
 * quiet-move count `streak` beforehand, as gess-engine's resolveOutcome decides
 * it: 1 mover wins, -1 mover loses, 0 draw, null if play goes on. At the quiet-
 * move limit the game is decided on stones. Also returns the new count.
 */
export function outcomeAfterMove(
  before: FlatBoard, after: FlatBoard, mover: number, streak: number,
): { result: 1 | 0 | -1 | null; streak: number } {
  const newStreak = stoneCount(after) < stoneCount(before) ? 0 : streak + 1;
  const moverRing = hasRing(after, mover);
  const oppRing = hasRing(after, 3 - mover);
  if (!moverRing) return { result: -1, streak: newStreak }; // includes both losing their rings
  if (!oppRing) return { result: 1, streak: newStreak };
  if (newStreak >= QUIET_MOVE_LIMIT) {
    const lead = stoneCount(after, mover) - stoneCount(after, 3 - mover);
    return { result: lead > 0 ? 1 : lead < 0 ? -1 : 0, streak: newStreak };
  }
  return { result: null, streak: newStreak };
}
