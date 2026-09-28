// ─────────────────────────────────────────────────────────────────────────────
// The first-run tutorial's steps: pieces, moves, captures and rings, each on a
// small window of the board holding only the stones needed to make the point.
// The Android app has the same steps (gess-android core/.../Tutorial.kt).
//
// A step's stones are laid out in a 7×9 window placed in the middle of a real
// board, so what the tutorial shows — the piece, where it can go, the position
// after its move, captures, rings — comes from the game's own rules
// (gess-engine); verify/tutorial-check.ts checks the steps show what they say.
// ─────────────────────────────────────────────────────────────────────────────

import type { Board, Cell, Player, Position } from '../models/game.model';
import { applyMove, getEnclosedCells, getValidMoves, SIZE } from '../services/gess-engine';

export const TUTORIAL_ROWS = 7;
export const TUTORIAL_COLS = 9;
// Where the window sits on the 20×20 board (well inside the playing area).
const ROW0 = 6;
const COL0 = 5;

export interface TutorialStep {
  title: string;
  text: string;
  /** The window: rows of 'b' (black), 'w' (white), '.' (empty); absent for a text-only step. */
  rows?: string[];
  /** The piece to highlight, as [row, col] in the window. */
  piece?: [number, number];
  /** Show where the piece can move. */
  dots?: boolean;
  /** A move to play out: the piece's destination, [row, col] in the window. */
  move?: [number, number];
}

/** The steps; `click` is "Click" or "Tap". */
export function tutorialSteps(click: string): TutorialStep[] {
  const piece = ['.........', '.........', '.........', '....b....', '.....b...', '.........', '.........'];
  return [
    {
      title: 'Pieces',
      text: "You don't move single stones but pieces: any 3×3 block that holds some of your stones and " +
        "none of your opponent's. The gold square is a piece with two black stones.",
      rows: piece, piece: [4, 4],
    },
    {
      title: 'Which way it moves',
      text: 'The stones around the edge of a piece are its directions: this one can go north (its top ' +
        "stone) or east (its right-hand stone). A corner stone would let it go diagonally. The " +
        'green dots are where it can land.',
      rows: piece, piece: [4, 4], dots: true,
    },
    {
      title: 'Moving',
      text: 'The whole 3×3 moves together, carrying its stones. Without a stone in its centre, a piece ' +
        'moves up to 3 squares.',
      rows: piece, piece: [4, 4], move: [1, 4],
    },
    {
      title: 'The centre stone',
      text: 'With a stone in its centre, a piece can move as far as it likes. (A centre stone on its ' +
        "own isn't a piece: it needs a stone around it to give it a direction.)",
      rows: ['.........', '.........', '.........', '.bb......', '.........', '.........', '.........'],
      piece: [3, 1], dots: true,
    },
    {
      title: 'Stopping and capturing',
      text: 'A piece stops as soon as its 3×3 runs into another stone, and every stone under it where ' +
        'it lands is captured: here both white stones, though no black stone lands on them. ' +
        'Your own stones would be captured too.',
      rows: ['.........', '.........', '.....w...', '.bb......', '.....w...', '.........', '.........'],
      piece: [3, 1], dots: true, move: [3, 4],
    },
    {
      title: 'Rings',
      text: 'A ring is 8 of your stones around an empty centre, marked with ♚. Each side starts with ' +
        'one, and you can build more.',
      rows: ['.........', '.........', '...bbb...', '...b.b...', '...bbb...', '.........', '.........'],
    },
    {
      title: 'Winning',
      text: "Break all of your opponent's rings to win: here White's piece smashes into Black's only " +
        'ring. And if you ever have no ring left — even after your own move — you lose.',
      rows: ['.........', '.........', '....bbb..', '.ww.b.b..', '....bbb..', '.........', '.........'],
      piece: [3, 1], move: [3, 3],
    },
    {
      title: 'Good to know',
      text: 'Stones that land on the outermost line of the board are removed. After 20 moves in a row ' +
        'without a capture, the game ends and whoever has more stones wins.\n\n' +
        `Black moves first. ${click} a piece to pick it up, then ${click.toLowerCase()} where it goes. ` +
        'You can see this again from the Tutorial button.',
    },
  ];
}

/** A window square on the 20×20 board. */
export function toBoard([r, c]: [number, number]): Position {
  return { row: ROW0 + r, col: COL0 + c };
}

/** A board square in the window, or null if it's outside. */
export function toWindow(p: Position): [number, number] | null {
  const r = p.row - ROW0, c = p.col - COL0;
  return r >= 0 && r < TUTORIAL_ROWS && c >= 0 && c < TUTORIAL_COLS ? [r, c] : null;
}

/** What a step shows, worked out by the rules. Squares are [row, col] in the window. */
export interface StepView {
  board: Board;
  mover: Player;
  destinations: [number, number][];
  after: Board | null;
  captured: [number, number][];
}

function near(a: Position, b: Position): boolean {
  return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
}

export function stepView(step: TutorialStep): StepView {
  const board: Board = Array.from({ length: SIZE }, () => new Array<Cell>(SIZE).fill(null));
  (step.rows ?? []).forEach((line, r) =>
    [...line].forEach((ch, c) => {
      const p = toBoard([r, c]);
      board[p.row][p.col] = ch === 'b' ? 'black' : ch === 'w' ? 'white' : null;
    }));

  const from = step.piece ? toBoard(step.piece) : null;
  let mover: Player = 'black';
  if (from) {
    outer: for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const cell = board[from.row + dr][from.col + dc];
        if (cell) { mover = cell; break outer; }
      }
  }
  const destinations = from
    ? getValidMoves(board, from, mover).map(toWindow).filter((p): p is [number, number] => p !== null)
    : [];

  let after: Board | null = null;
  const captured: [number, number][] = [];
  if (from && step.move) {
    const to = toBoard(step.move);
    after = applyMove(board, from, to, mover);
    // Every stone under the piece where it lands, other than its own.
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        const p = { row: r, col: c };
        if (near(p, to) && board[r][c] && !(near(p, from) && board[r][c] === mover)) {
          const w = toWindow(p);
          if (w) captured.push(w);
        }
      }
  }
  return { board, mover, destinations, after, captured };
}

/** The window squares of each side's ring centres on `board`. */
export function ringCentres(board: Board, player: Player): [number, number][] {
  return [...getEnclosedCells(board, player)]
    .map(k => { const [row, col] = k.split(',').map(Number); return toWindow({ row, col }); })
    .filter((p): p is [number, number] => p !== null);
}
