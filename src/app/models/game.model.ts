export type Player = 'white' | 'black';
export type Cell = Player | null;
export type Board = Cell[][];

export interface Position {
  row: number;
  col: number;
}

export type GamePhase = 'select-footprint' | 'select-destination';

/** Game result once play has ended: a winning player, or a draw. */
export type GameResult = Player | 'draw';

/** One entry in the move record: who moved, the [from]-[to] centre notation,
 *  and the footprint centres (for highlighting the move on the board).
 *  `captured` is true when the move removed any stone from the board (an
 *  opponent stone, an own stone displaced at the destination, or an own stone
 *  pushed off the edge) — i.e. it broke the no-capture streak. */
export interface MoveRecord {
  player: Player;
  notation: string;
  from: Position;
  to: Position;
  captured: boolean;
}

export interface GameState {
  board: Board;
  currentPlayer: Player;
  phase: GamePhase;
  selectedCenter: Position | null;
  validMoves: Position[];
  /** Set once the game has ended: the winning player, or `'draw'`. Null while
   *  play continues. Any truthy value means the game is over. */
  winner: GameResult | null;
  message: string;
  whiteRings: number;
  blackRings: number;
  whiteStones: number;
  blackStones: number;
  moves: MoveRecord[];
  /** Consecutive turns (each player's move counts as one) ending without a
   *  capture. Reaching NO_CAPTURE_DRAW_LIMIT ends the game in a draw. */
  noCaptureStreak: number;
}
