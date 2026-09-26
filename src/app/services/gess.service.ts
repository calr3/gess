import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Board, GameResult, GameState, MoveRecord, Player, Position } from '../models/game.model';
import * as Engine from './gess-engine';
import { SIZE, TIME_BUDGET_MS } from './gess-engine';
import { AiMove, getBestMove as wasmGetBestMove } from './gess-wasm';
import type { AiEngine, AiRequest } from './gess-ai.worker';

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Full 20×20 coordinate labels: columns a–t, rows 1–20 (top row is 20). The
// 18×18 playing area is columns b–s, rows 2–19; the border ring is a/t, 1/20.
const COL_LETTERS = 'abcdefghijklmnopqrst';

/** Notation for a footprint centre, e.g. {row:13,col:3} → "c7". */
function squareNotation(p: Position): string {
  return `${COL_LETTERS[p.col]}${SIZE - p.row}`;
}

@Injectable({ providedIn: 'root' })
export class GessService implements OnDestroy {
  private sub$ = new BehaviorSubject<GameState>(this.buildInitial());
  readonly gameState$ = this.sub$.asObservable();

  /** Deepest iteration the last AI search fully completed (diagnostic). */
  lastSearchDepth = 0;

  // The AI search runs in a Web Worker so it never blocks the UI thread, even
  // with a multi-second time budget. Falls back to a synchronous search if the
  // environment has no Worker support.
  private worker: Worker | null = null;
  private aiRequestId = 0;
  private aiBusy = false;

  /** True while an AI move is being computed (so callers don't start another). */
  get isThinking(): boolean { return this.aiBusy; }

  constructor() {
    this.createWorker();
  }

  ngOnDestroy(): void {
    this.worker?.terminate();
  }

  private createWorker(): void {
    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./gess-ai.worker', import.meta.url), { type: 'module' });
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  selectCell(row: number, col: number): void {
    const s = this.sub$.value;
    if (s.winner) return;
    if (s.phase === 'select-footprint') this.pickFootprint(row, col, s);
    else this.pickDestination(row, col, s);
  }

  /** Cancel an in-progress selection, reverting to the footprint-selection phase. */
  cancelSelection(): void {
    const s = this.sub$.value;
    if (s.winner || s.phase !== 'select-destination') return;
    this.sub$.next({
      ...s, phase: 'select-footprint', selectedCenter: null, validMoves: [],
      message: `${cap(s.currentPlayer)}'s turn — click a piece to select it`,
    });
  }

  resetGame(): void {
    // Invalidate any in-flight AI response and cancel its (possibly multi-second)
    // search by recreating the worker, so the new game isn't blocked behind it.
    this.aiRequestId++;
    this.aiBusy = false;
    this.worker?.terminate();
    this.createWorker();
    this.sub$.next(this.buildInitial());
  }

  /** The board as it stood just after move `index` (0-based) of the given list,
   *  reconstructed by replaying the recorded moves from the initial position. */
  boardAfterMove(moves: MoveRecord[], index: number): Board {
    let board = Engine.makeBoard();
    for (let i = 0; i <= index && i < moves.length; i++) {
      const m = moves[i];
      board = Engine.applyMove(board, m.from, m.to, m.player);
    }
    return board;
  }

  /**
   * Snap the game back to just after move `index` (0-based) and continue from
   * there: the move history is truncated and the board rebuilt, with the turn
   * passing to whoever was to move next. Any in-flight AI search is cancelled
   * (worker recreated, like resetGame) so a stale result can't apply to the
   * reverted position. Controller assignments live in the component and are left
   * untouched, so play resumes under the current AI/Human settings.
   */
  revertToMove(index: number): void {
    const moves = this.sub$.value.moves;
    if (index < 0 || index >= moves.length) return;

    this.aiRequestId++;
    this.aiBusy = false;
    this.worker?.terminate();
    this.createWorker();

    const kept = moves.slice(0, index + 1);
    let board = Engine.makeBoard();
    for (const m of kept) board = Engine.applyMove(board, m.from, m.to, m.player);

    this.sub$.next(this.stateAfterMove(board, kept[kept.length - 1].player, kept));
  }

  isValidFootprintCenter(row: number, col: number, board: Board, player: Player): boolean {
    return Engine.isValidFootprintCenter(row, col, board, player);
  }

  getValidMoves(board: Board, center: Position, player: Player): Position[] {
    return Engine.getValidMoves(board, center, player);
  }

  /** Returns the board state that would result from moving the selected footprint to `to`. */
  computePreview(board: Board, from: Position, to: Position, player: Player): Board {
    return Engine.applyMove(board, from, to, player);
  }

  hasRing(board: Board, player: Player): boolean {
    return Engine.hasRing(board, player);
  }

  countRings(board: Board, player: Player): number {
    return Engine.countRings(board, player);
  }

  getEnclosedCells(board: Board, player: Player): Set<string> {
    return Engine.getEnclosedCells(board, player);
  }

  // ─── AI turn ─────────────────────────────────────────────────────────────────

  /**
   * Run the AI's turn. Emits a "thinking…" state immediately, then hands the
   * search to the Web Worker so the UI thread stays responsive while the AI
   * computes. When the worker replies, the chosen footprint is highlighted for
   * 700 ms before the move is applied.
   */
  executeAiMove(timeBudgetMs: number = TIME_BUDGET_MS, engine: AiEngine = 'wasm'): void {
    // Guard against re-entry: emitting the "thinking…" state below keeps the
    // phase at select-footprint, which would otherwise let the caller schedule
    // another search while this one is still running — duplicating the move.
    if (this.aiBusy) return;
    const s = this.sub$.value;
    if (s.winner || s.phase !== 'select-footprint') return;
    const player = s.currentPlayer;

    const requestId = ++this.aiRequestId;
    this.aiBusy = true;

    // Let the human see that the AI is thinking (the worker now does the work).
    this.sub$.next({ ...s, message: `${cap(player)} (AI) is thinking…` });

    this.requestAiMove(s.board, player, timeBudgetMs, engine, s.noCaptureStreak).then(best => {
      // Drop the result if the game moved on (reset, new turn, etc.) meanwhile.
      // A superseded request leaves aiBusy alone — a newer request now owns it.
      if (requestId !== this.aiRequestId) return;
      this.aiBusy = false;
      if (!best) return;

      const cur = this.sub$.value;
      if (cur.winner || cur.phase !== 'select-footprint' || cur.currentPlayer !== player) return;

      // Phase 1 — highlight the chosen footprint so the human can see it.
      this.sub$.next({
        ...cur,
        phase: 'select-destination',
        selectedCenter: best.from,
        validMoves: Engine.getValidMoves(cur.board, best.from, player),
        message: `${cap(player)} (AI) is moving…`,
      });

      // Phase 2 — apply the move after a short delay.
      setTimeout(() => {
        const curr = this.sub$.value;
        if (curr.winner || curr.phase !== 'select-destination') return;
        this.commitMove(curr, best.from, best.to);
      }, 700);
    });
  }

  /** Resolve the AI's chosen move, off-thread via the worker when available. */
  private requestAiMove(
    board: Board, player: Player, timeBudgetMs: number, engine: AiEngine = 'wasm',
    noCaptureStreak = 0,
  ): Promise<AiMove | null> {
    const worker = this.worker;
    if (!worker) {
      if (engine === 'random') {
        return import('./gess-random').then(r => r.randomMove(board, player, noCaptureStreak));
      }
      if (engine === 'neural' || engine === 'neural-mcts') {
        // Same fallback as below: run it on the calling thread.
        return import('./gess-nn').then(nn =>
          engine === 'neural'
            ? nn.getBestMove(board, player)
            : nn.searchBestMove(board, player, noCaptureStreak, timeBudgetMs));
      }
      // No worker: run the same WASM engine directly on the calling thread. It
      // blocks the UI for the search, but keeps the game playable where Web
      // Workers are unavailable (e.g. SSR or constrained test environments).
      return wasmGetBestMove(board, player, timeBudgetMs, noCaptureStreak).then(r => {
        if (r) this.lastSearchDepth = r.depth;
        return r;
      });
    }
    return new Promise<AiMove | null>(resolve => {
      const onMessage = (ev: MessageEvent<AiMove | null>) => {
        worker.removeEventListener('message', onMessage);
        const result = ev.data;
        if (result) this.lastSearchDepth = result.depth;
        resolve(result);
      };
      worker.addEventListener('message', onMessage);
      const request: AiRequest = { board, player, timeBudgetMs, engine, noCaptureStreak };
      worker.postMessage(request);
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildInitial(): GameState {
    const board = Engine.makeBoard();
    return {
      board,
      currentPlayer: 'black',
      phase: 'select-footprint',
      selectedCenter: null,
      validMoves: [],
      winner: null,
      message: "Black's turn — click a piece to select it",
      whiteRings: Engine.countRings(board, 'white'),
      blackRings: Engine.countRings(board, 'black'),
      whiteStones: Engine.countStones(board, 'white'),
      blackStones: Engine.countStones(board, 'black'),
      moves: [],
      noCaptureStreak: 0,
    };
  }

  private pickFootprint(row: number, col: number, s: GameState): void {
    if (!Engine.isValidFootprintCenter(row, col, s.board, s.currentPlayer)) return;
    const validMoves = Engine.getValidMoves(s.board, { row, col }, s.currentPlayer);
    if (validMoves.length === 0) return;
    this.sub$.next({
      ...s,
      phase: 'select-destination',
      selectedCenter: { row, col },
      validMoves,
      message: `${cap(s.currentPlayer)}: select a destination (click the selection again to cancel)`,
    });
  }

  private pickDestination(row: number, col: number, s: GameState): void {
    const { selectedCenter, validMoves, currentPlayer } = s;

    // Any click that is not a valid destination cancels the selection.
    if (!validMoves.some(m => m.row === row && m.col === col)) {
      this.sub$.next({
        ...s, phase: 'select-footprint', selectedCenter: null, validMoves: [],
        message: `${cap(currentPlayer)}'s turn — click a piece to select it`,
      });
      return;
    }

    this.commitMove(s, selectedCenter!, { row, col });
  }

  /**
   * Apply a move and emit the resulting state, including win/loss detection.
   * A player can win or lose on their own turn:
   *   - lose your last ring → you lose;
   *   - both lose their last ring on one move → the mover loses;
   *   - opponent loses their last ring → you win.
   */
  private commitMove(s: GameState, from: Position, to: Position): void {
    const currentPlayer = s.currentPlayer;
    const newBoard = Engine.applyMove(s.board, from, to, currentPlayer);
    const opp: Player = currentPlayer === 'black' ? 'white' : 'black';
    const oppRingsBefore = Engine.countRings(s.board, opp);
    const oppRingsAfter = Engine.countRings(newBoard, opp);

    // Build the notation. Capture suffix: " " then an "x" per opponent stone
    // and an "o" per own stone displaced at the destination (opponent first),
    // e.g. "b19-c19 xxo". Then a ring marker if this move broke an opponent
    // ring: "#" if it was their final ring, otherwise "+".
    const caps = Engine.countCaptures(s.board, from, to, currentPlayer);
    let notation = `${squareNotation(from)}-${squareNotation(to)}`;
    if (caps.opp > 0 || caps.self > 0) {
      notation += ` ${'x'.repeat(caps.opp)}${'o'.repeat(caps.self)}`;
    }
    if (oppRingsAfter < oppRingsBefore) {
      notation += oppRingsAfter === 0 ? '#' : '+';
    }

    // A move "captures" if it removed any stone from the board — an opponent
    // stone, an own stone displaced at the destination, or an own stone pushed
    // off the edge. Any of these resets the no-capture streak.
    const captured = Engine.wasCapture(s.board, newBoard);

    const record: MoveRecord = { player: currentPlayer, notation, from, to, captured };
    this.sub$.next(this.stateAfterMove(newBoard, currentPlayer, [...s.moves, record]));
  }

  /**
   * Build the game state that results once `mover` has produced `board`, with
   * `moves` as the (already-updated) record. Centralises win/turn/count logic so
   * commitMove and revertToMove stay consistent. A player can win or lose on
   * their own turn: lose your last ring → you lose; both lose their last ring on
   * one move → the mover loses; opponent loses their last ring → you win.
   * Failing all of those, QUIET_MOVE_LIMIT consecutive captureless moves end
   * the game, decided on stones (a tie is a draw) — but a result on rings on that
   * very move takes precedence (resolveOutcome checks rings before the count).
   */
  private stateAfterMove(board: Board, mover: Player, moves: MoveRecord[]): GameState {
    const opp: Player = mover === 'black' ? 'white' : 'black';
    const whiteRings = Engine.countRings(board, 'white');
    const blackRings = Engine.countRings(board, 'black');
    const moverRings = mover === 'white' ? whiteRings : blackRings;
    const oppRings = opp === 'white' ? whiteRings : blackRings;

    // The streak is recomputed from the move record (not carried incrementally),
    // so it stays correct after revertToMove truncates the history: count the
    // trailing run of captureless moves.
    const noCaptureStreak = this.trailingNoCaptureStreak(moves);

    const moverStones = Engine.countStones(board, mover);
    const oppStones = Engine.countStones(board, opp);
    const quiet = `after ${Engine.QUIET_MOVE_LIMIT} moves without a capture`;

    const outcome = Engine.resolveOutcome(moverRings, oppRings, noCaptureStreak, moverStones, oppStones);
    let winner: GameResult | null = null;
    let message: string;
    switch (outcome) {
      case 'both-lose':
        winner = opp;
        message = `${cap(opp)} wins! Both players lost their last ring, but ${cap(mover)} moved last.`;
        break;
      case 'mover-loses':
        winner = opp;
        message = `${cap(opp)} wins! ${cap(mover)} destroyed their own last ring.`;
        break;
      case 'mover-wins':
        winner = mover;
        message = `${cap(mover)} wins! All of ${cap(opp)}'s rings are gone.`;
        break;
      case 'mover-wins-on-stones':
        winner = mover;
        message = `${cap(mover)} wins on stones, ${moverStones}–${oppStones}, ${quiet}.`;
        break;
      case 'mover-loses-on-stones':
        winner = opp;
        message = `${cap(opp)} wins on stones, ${oppStones}–${moverStones}, ${quiet}.`;
        break;
      case 'draw':
        winner = 'draw';
        message = `Draw — level on stones, ${moverStones}–${oppStones}, ${quiet}.`;
        break;
      default:
        message = `${cap(opp)}'s turn — click a piece to select it`;
    }

    return {
      board,
      currentPlayer: winner && winner !== 'draw' ? mover : opp,
      phase: 'select-footprint',
      selectedCenter: null,
      validMoves: [],
      winner,
      message,
      whiteRings,
      blackRings,
      whiteStones: Engine.countStones(board, 'white'),
      blackStones: Engine.countStones(board, 'black'),
      moves,
      noCaptureStreak,
    };
  }

  /** Number of moves at the tail of `moves` that ended without a capture. */
  private trailingNoCaptureStreak(moves: MoveRecord[]): number {
    let n = 0;
    for (let i = moves.length - 1; i >= 0 && !moves[i].captured; i--) n++;
    return n;
  }
}
