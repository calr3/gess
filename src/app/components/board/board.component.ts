import {
  AfterViewChecked, ChangeDetectorRef, Component, ElementRef,
  OnDestroy, OnInit, ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { GessService } from '../../services/gess.service';
import { NO_CAPTURE_DRAW_LIMIT } from '../../services/gess-engine';
import { Board, GameState, MoveRecord, Player, Position } from '../../models/game.model';

interface Arrow { x1: number; y1: number; x2: number; y2: number; }

// 'human', one of the negamax difficulty levels (each just a search time
// budget), or 'neural': the trained network playing its policy directly.
type Controller = 'human' | 'easy' | 'normal' | 'hard' | 'ultra' | 'neural';
type AiLevel = Exclude<Controller, 'human'>;

// Per-AI think-time budget (ms).
const AI_CONFIG: Record<AiLevel, number> = {
  easy:   500,
  normal: 2000,
  hard:   15000,
  ultra:  60000,
  // The network answers in milliseconds; this only paces the thinking bar.
  neural: 1000,
};

function isAi(c: Controller): c is AiLevel { return c !== 'human'; }

@Component({
  selector: 'app-board',
  standalone: true,
  imports: [],
  templateUrl: './board.component.html',
  styleUrl: './board.component.scss',
})
export class BoardComponent implements OnInit, OnDestroy, AfterViewChecked {
  state!: GameState;

  @ViewChild('movesList') private movesList?: ElementRef<HTMLElement>;
  @ViewChild('boardGrid') private boardGrid?: ElementRef<HTMLElement>;
  private lastMoveCount = 0;

  // Highlight driven by hovering a row in the move record.
  moveFP = new Set<string>();          // footprint cells of both source & target
  moveFromCell: string | null = null;  // source centre "r,c"
  moveToCell: string | null = null;    // target centre "r,c"
  moveArrow: Arrow | null = null;      // arrow endpoints in board-grid pixel space
  private hoveringRecord = false;      // true while hovering a move-record row
  private highlightedMove: MoveRecord | null = null; // move currently highlighted

  // Who controls each colour
  whiteController: Controller = 'normal';
  blackController: Controller = 'human';

  // Pre-computed sets for O(1) template lookups
  selectedFP = new Set<string>();         // cells in the selected 3×3 footprint
  validMoveCells = new Set<string>();     // centres of valid move destinations
  hoveredFP = new Set<string>();          // footprint preview (select-footprint phase)
  hoveredDestFP = new Set<string>();      // destination footprint preview (select-destination)
  clickable = new Set<string>();          // cells that respond to a click
  moveableFootprints = new Set<string>(); // footprint centres that have ≥1 valid move

  // Ring interior highlighting
  whiteRingCells = new Set<string>();
  blackRingCells = new Set<string>();

  // Row/column of the cell currently under the cursor, so the matching edge
  // labels can be highlighted. Null when the cursor is off the board.
  hoverRow: number | null = null;
  hoverCol: number | null = null;

  // AI "thinking…" progress bar: a 0..1 fraction smoothed at 30 FPS towards the
  // search time budget. Shown only while a search is in flight.
  aiThinking = false;
  aiProgress = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private thinkStart = 0;
  private thinkBudgetMs = 0;

  previewBoard: Board | null = null;

  // Type-to-move entry: a move written as two squares, e.g. "h6 i7".
  moveInput = '';
  moveInputError = '';
  copied = false; // brief "Copied!" feedback after copying the move history
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  // Live preview of the move being typed into the move-entry input, drawn with
  // the same footprint/arrow visualisation as a real move but in purple. The
  // source footprint appears once a valid first square is entered; the full
  // move (both footprints + arrow) once a legal destination is added.
  typedFP = new Set<string>();
  typedFromCell: string | null = null;
  typedToCell: string | null = null;
  typedArrow: Arrow | null = null;

  get displayBoard(): Board { return this.previewBoard ?? this.state.board; }

  /** The no-capture draw limit, surfaced for the "How to play" text. */
  readonly drawLimit = NO_CAPTURE_DRAW_LIMIT;

  /**
   * Turns left before a forced no-capture draw, or null while the game is over
   * (a win/loss/draw is already decided) — the template only surfaces it once
   * it has dropped to 5 or fewer.
   */
  get turnsToDraw(): number | null {
    if (!this.state || this.state.winner) return null;
    return Math.max(0, NO_CAPTURE_DRAW_LIMIT - this.state.noCaptureStreak);
  }

  // The board is a 20×20 grid: the inner 18×18 (indices 1‑18) is the playing
  // area; indices 0 and 19 are the off-board border ring, rendered as a subdued
  // margin so a piece can be moved partially off the edge onto it.
  readonly rows = Array.from({ length: 20 }, (_, i) => i);
  readonly cols = Array.from({ length: 20 }, (_, i) => i);
  // Labels follow Gess's 20×20 coordinates: the border ring is row 1/20 and
  // column a/t, so the inner 18×18 playing area (indices 1‑18) is rows 2‑19
  // and columns b‑s.
  private readonly colLetters = 'abcdefghijklmnopqrst';

  // Row/column iteration order. The board is always drawn from black's view.
  get displayRows(): number[] { return this.rows; }
  get displayCols(): number[] { return this.cols; }

  /**
   * The move log grouped into rows of (black, white), the way a chess score
   * sheet pairs the two players' plies. Black always moves first in Gess, so
   * each row holds turn number n = i/2 + 1 with black = move 2i and white =
   * move 2i+1. The number is shared across the pair (chess numbering: "1." is
   * both players' first move), and white may be absent on the final row.
   */
  get movePairs(): { num: number; black: MoveRecord; white?: MoveRecord }[] {
    const moves = this.state?.moves ?? [];
    const pairs: { num: number; black: MoveRecord; white?: MoveRecord }[] = [];
    for (let i = 0; i < moves.length; i += 2) {
      pairs.push({ num: i / 2 + 1, black: moves[i], white: moves[i + 1] });
    }
    return pairs;
  }

  private sub!: Subscription;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private gess: GessService, private cdr: ChangeDetectorRef) {}

  ngOnInit(): void {
    this.sub = this.gess.gameState$.subscribe(state => {
      this.state = state;
      this.rebuildHighlights();
      // Unless the user is inspecting a specific move, recap the latest move.
      if (!this.hoveringRecord) this.showLastMove();
      // The search has resolved (or never started) → tear down the progress bar.
      if (!this.gess.isThinking) this.stopThinkingProgress();
      this.scheduleAi();
      // Zoneless app: explicitly notify the scheduler so async (timer-driven)
      // state changes — e.g. AI moves — are reflected in the view.
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    if (this.aiTimer) clearTimeout(this.aiTimer);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.stopThinkingProgress();
  }

  ngAfterViewChecked(): void {
    // Keep the latest move in view as the record grows.
    const count = this.state?.moves.length ?? 0;
    if (count !== this.lastMoveCount && this.movesList) {
      this.lastMoveCount = count;
      const el = this.movesList.nativeElement;
      el.scrollTop = el.scrollHeight;
    }
  }

  // ─── Event handlers ────────────────────────────────────────────────────────

  onCellClick(r: number, c: number): void {
    if (this.isAiTurn()) return; // ignore human clicks during AI's turn
    this.gess.selectCell(r, c);
  }

  onMouseEnter(r: number, c: number): void {
    // Track the hovered square for edge-label highlighting — independent of
    // whose turn it is, so the coordinates light up even during the AI's turn.
    this.hoverRow = r;
    this.hoverCol = c;

    if (this.state.winner || this.isAiTurn()) return;

    if (this.state.phase === 'select-footprint') {
      this.clearDestPreview();
      this.hoveredFP = this.moveableFootprints.has(`${r},${c}`)
        ? this.fp3x3(r, c) : new Set();
      return;
    }

    this.hoveredFP.clear();
    if (this.validMoveCells.has(`${r},${c}`) && this.state.selectedCenter) {
      this.hoveredDestFP = this.fp3x3(r, c);
      this.previewBoard = this.gess.computePreview(
        this.state.board, this.state.selectedCenter,
        { row: r, col: c }, this.state.currentPlayer,
      );
      this.rebuildRingCells();
    } else {
      this.clearDestPreview();
    }
  }

  onMouseLeave(): void {
    this.hoveredFP.clear();
    this.clearDestPreview();
    this.hoverRow = null;
    this.hoverCol = null;
  }

  // ─── Type-to-move entry ──────────────────────────────────────────────────────

  /** Parse the two squares written in the move-entry input. Returns the matched
   *  source/destination positions (either may be null if not yet a valid square). */
  private parseMoveInput(): { from: Position | null; to: Position | null } {
    const pairs = [...this.moveInput.toLowerCase().matchAll(/([a-t])\s*(\d{1,2})/g)];
    const parse = (m: RegExpMatchArray | undefined): Position | null => {
      if (!m) return null;
      const col = this.colLetters.indexOf(m[1]);
      const row = 20 - parseInt(m[2], 10); // row label L → grid index 20−L
      return col >= 0 && col <= 19 && row >= 0 && row <= 19 ? { row, col } : null;
    };
    return { from: parse(pairs[0]), to: parse(pairs[1]) };
  }

  /** Handle each keystroke in the move-entry input: store the text, clear any
   *  stale error, and refresh the live (purple) move preview. */
  onMoveInput(value: string): void {
    this.moveInput = value;
    this.moveInputError = '';
    this.updateTypedPreview();
  }

  /**
   * Refresh the typed-move preview from the current input. Shows the source
   * footprint once the first square is a legal piece to move, then the whole
   * move (both footprints + arrow) once the second is a legal destination.
   * Anything that isn't (yet) a legal partial move leaves the preview cleared.
   */
  private updateTypedPreview(): void {
    this.clearTypedPreview();
    if (!this.state || this.state.winner || this.isAiTurn()) return;

    const { from, to } = this.parseMoveInput();
    const { board, currentPlayer } = this.state;
    if (!from || !this.gess.isValidFootprintCenter(from.row, from.col, board, currentPlayer)) return;

    // First valid square — highlight the source footprint.
    this.typedFromCell = `${from.row},${from.col}`;
    this.addFootprint(this.typedFP, from);

    if (!to) return;
    const legal = this.gess.getValidMoves(board, from, currentPlayer);
    if (!legal.some(m => m.row === to.row && m.col === to.col)) return;

    // Second valid square — add the destination footprint and the arrow.
    this.typedToCell = `${to.row},${to.col}`;
    this.addFootprint(this.typedFP, to);
    this.typedArrow = this.arrowBetween(from, to);
  }

  private clearTypedPreview(): void {
    this.typedFP.clear();
    this.typedFromCell = null;
    this.typedToCell = null;
    this.typedArrow = null;
  }

  /** Add the on-board cells of the 3×3 footprint centred on `ctr` to `set`. */
  private addFootprint(set: Set<string>, ctr: Position): void {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const r = ctr.row + dr, c = ctr.col + dc;
        if (r >= 1 && r <= 18 && c >= 1 && c <= 18) set.add(`${r},${c}`);
      }
  }

  /**
   * Play a move entered as text: two squares — source then destination — in the
   * board's a–t / 1–20 coordinates. The squares may be written with or without a
   * space ("h6 i7", "h 6 i 7", "h6i7"). The move is run through the same
   * validation and commit path as clicking, so an illegal entry is rejected with
   * a message and leaves the board untouched.
   */
  submitMoveInput(): void {
    const matches = [...this.moveInput.toLowerCase().matchAll(/([a-t])\s*(\d{1,2})/g)];
    if (matches.length !== 2) {
      this.moveInputError = 'Enter two squares, e.g. "h6 i7".';
      return;
    }
    const { from, to } = this.parseMoveInput();
    if (!from || !to) {
      this.moveInputError = 'Square out of range (columns a–t, rows 1–20).';
      return;
    }
    if (this.state.winner) { this.moveInputError = 'The game is over.'; return; }
    if (this.isAiTurn()) { this.moveInputError = "It's the AI's turn."; return; }

    const { board, currentPlayer } = this.state;
    if (!this.gess.isValidFootprintCenter(from.row, from.col, board, currentPlayer)) {
      this.moveInputError = `${this.sq(from)} isn't one of your pieces.`;
      return;
    }
    const legal = this.gess.getValidMoves(board, from, currentPlayer);
    if (!legal.some(m => m.row === to.row && m.col === to.col)) {
      this.moveInputError = `${this.sq(from)}–${this.sq(to)} isn't a legal move.`;
      return;
    }

    // Valid — drive the normal click path. Cancel any half-made selection first
    // so the first selectCell is read as a footprint pick, not a destination.
    this.gess.cancelSelection();
    this.gess.selectCell(from.row, from.col);
    this.gess.selectCell(to.row, to.col);
    this.moveInput = '';
    this.moveInputError = '';
    this.clearTypedPreview();
  }

  /** Position → coordinate notation, e.g. {row:14,col:7} → "h6". */
  private sq(p: Position): string { return `${this.colLetters[p.col]}${20 - p.row}`; }

  /** The move history as a plain-text table, one numbered pair per line with the
   *  columns space-padded so they align (right-aligned number, then black, then
   *  white). White is omitted on a final unanswered move. e.g.
   *   " 1.  h6-i7    h15-i14"
   *   " 2.  i7-j8    i14-j13"
   *   "10.  a1-b2    c3-d4". */
  moveHistoryText(): string {
    const pairs = this.movePairs;
    if (pairs.length === 0) return '';
    const numW = Math.max(...pairs.map(p => `${p.num}.`.length));
    const blackW = Math.max(...pairs.map(p => p.black.notation.length));
    return pairs
      .map(p => {
        const num = `${p.num}.`.padStart(numW);
        // Pad black to the column width only when a white move follows it, so the
        // final unanswered move carries no trailing spaces.
        const black = p.white ? p.black.notation.padEnd(blackW) : p.black.notation;
        const white = p.white ? `  ${p.white.notation}` : '';
        return `${num}  ${black}${white}`;
      })
      .join('\n');
  }

  /** Copy the move history to the clipboard, with brief "Copied!" feedback. */
  async copyMoveHistory(): Promise<void> {
    const text = this.moveHistoryText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts where the async Clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    this.copied = true;
    this.cdr.markForCheck(); // runs after an await: zoneless CD must be told explicitly
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
    this.copiedTimer = setTimeout(() => { this.copied = false; this.cdr.markForCheck(); }, 1500);
  }

  // ─── Move-record hover highlight ─────────────────────────────────────────────

  onMoveEnter(move: MoveRecord): void {
    this.hoveringRecord = true;
    this.highlightMove(move);
    // Show the whole board as it stood just after this move (with the arrow).
    const idx = this.state.moves.indexOf(move);
    this.previewBoard = idx >= 0 ? this.gess.boardAfterMove(this.state.moves, idx) : null;
    this.rebuildRingCells();
    this.cdr.markForCheck();
  }

  onMoveLeave(): void {
    this.hoveringRecord = false;
    // Drop the historical board and revert to recapping the most recent move.
    this.previewBoard = null;
    this.rebuildRingCells();
    this.showLastMove();
    this.cdr.markForCheck();
  }

  /**
   * Double-click a recorded move to snap the game back to just after it and
   * continue from there. History is truncated; play resumes under the current
   * controller (AI/Human) settings — so if it's then an AI's turn, the state
   * emission re-runs scheduleAi and the AI moves.
   */
  revertToMove(move: MoveRecord): void {
    // Don't wind the game back mid-search — the AI is computing on the live
    // position and a jump would be confusing. (Hovering to preview still works.)
    if (this.gess.isThinking) return;
    const idx = this.state.moves.indexOf(move);
    if (idx < 0) return;
    this.hoveringRecord = false;
    this.previewBoard = null;
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    this.gess.revertToMove(idx);
  }

  /** Highlight the latest move (the default when not hovering the record). */
  private showLastMove(): void {
    const moves = this.state?.moves;
    if (moves && moves.length > 0) this.highlightMove(moves[moves.length - 1]);
    else this.clearMoveHighlight();
  }

  /** Highlight a move's source/target footprints and the arrow between them. */
  private highlightMove(move: MoveRecord): void {
    this.highlightedMove = move;
    this.moveFromCell = `${move.from.row},${move.from.col}`;
    this.moveToCell = `${move.to.row},${move.to.col}`;

    // Footprint cells around both centres (on-board cells only — we don't draw
    // squares off the edge, matching the rest of the board).
    this.moveFP = new Set<string>();
    this.addFootprint(this.moveFP, move.from);
    this.addFootprint(this.moveFP, move.to);

    this.moveArrow = this.arrowBetween(move.from, move.to);
  }

  private clearMoveHighlight(): void {
    this.highlightedMove = null;
    this.moveFP.clear();
    this.moveFromCell = null;
    this.moveToCell = null;
    this.moveArrow = null;
  }

  /**
   * Arrow endpoints (centre-to-centre) in the board-grid's pixel coordinate
   * space. Computed from the cell size rather than live DOM rects, so it stays
   * correct without depending on re-render timing.
   */
  private arrowBetween(from: Position, to: Position): Arrow | null {
    const grid = this.boardGrid?.nativeElement;
    if (!grid) return null;
    const cell = grid.clientWidth / 20; // px per cell
    const centre = (p: Position) => ({
      x: p.col * cell + cell / 2,
      y: p.row * cell + cell / 2,
    });
    const a = centre(from), b = centre(to);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // ─── Controller selectors ──────────────────────────────────────────────────

  /**
   * True while the current player's controller dropdown should be locked: an AI
   * search is in flight for them, so switching who controls that move now would
   * leave the resolving search to apply (or strand) a move. The *other* player's
   * dropdown stays editable — their turn hasn't started.
   */
  isControllerLocked(player: Player): boolean {
    return this.gess.isThinking && this.state?.currentPlayer === player;
  }

  setController(player: Player, event: Event): void {
    // Guard the case the change still fires while locked (e.g. via keyboard):
    // ignore it and keep the dropdown showing the unchanged controller.
    if (this.isControllerLocked(player)) {
      (event.target as HTMLSelectElement).value =
        player === 'white' ? this.whiteController : this.blackController;
      return;
    }

    const value = (event.target as HTMLSelectElement).value as Controller;
    if (player === 'white') this.whiteController = value;
    else this.blackController = value;

    // If the current player was handed to the AI mid-selection, cancel the
    // in-progress selection so the AI isn't left stuck in select-destination.
    // (The resulting state emission re-runs scheduleAi via the subscription.)
    if (isAi(value) && this.state && !this.state.winner &&
        this.state.currentPlayer === player && this.state.phase === 'select-destination') {
      this.gess.cancelSelection();
    } else {
      this.scheduleAi();
    }
  }

  // ─── Template helpers ──────────────────────────────────────────────────────

  // Labels are shown only for the playing area (rows 2‑19, columns b‑s); the
  // border ring (indices 0 and 19) is an unlabelled off-board margin.
  rowLabel(r: number): string { return r < 1 || r > 18 ? '' : String(20 - r); }

  colLabel(c: number): string { return c < 1 || c > 18 ? '' : this.colLetters[c]; }

  isOffBoard(r: number, c: number): boolean {
    return r < 1 || r > 18 || c < 1 || c > 18;
  }

  resetGame(): void {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    this.gess.resetGame();
    this.hoveredFP.clear();
    this.clearDestPreview();
    this.moveInput = '';
    this.moveInputError = '';
    this.clearTypedPreview();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private isAiTurn(): boolean {
    if (!this.state || this.state.winner || this.state.phase === 'select-destination') return false;
    return isAi(this.controllerFor(this.state.currentPlayer));
  }

  private controllerFor(player: Player): Controller {
    return player === 'white' ? this.whiteController : this.blackController;
  }

  private scheduleAi(): void {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    if (!this.state || this.state.winner) return;
    if (this.gess.isThinking) return; // a search is already in flight for this turn
    const ctrl = this.controllerFor(this.state.currentPlayer);
    if (!isAi(ctrl)) return;
    if (this.state.phase !== 'select-footprint') return;
    const budgetMs = AI_CONFIG[ctrl];
    // Brief pause so the UI settles before the AI starts computing
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      this.startThinkingProgress(budgetMs);
      this.gess.executeAiMove(budgetMs, ctrl === 'neural' ? 'neural' : 'wasm');
    }, 400);
  }

  /** Begin the 30 FPS "thinking…" progress animation toward `budgetMs`. */
  private startThinkingProgress(budgetMs: number): void {
    this.stopThinkingProgress();
    this.aiThinking = true;
    this.aiProgress = 0;
    this.thinkStart = Date.now();
    this.thinkBudgetMs = budgetMs;
    this.progressTimer = setInterval(() => {
      const elapsed = Date.now() - this.thinkStart;
      // Cap just shy of full: the bar completes when the move actually arrives,
      // not merely when the nominal budget elapses (the search may run slightly
      // over while finishing its current iterative-deepening iteration).
      this.aiProgress = Math.min(elapsed / this.thinkBudgetMs, 0.99);
      this.cdr.markForCheck();
    }, 1000 / 30);
  }

  private stopThinkingProgress(): void {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
    this.aiThinking = false;
    this.aiProgress = 0;
  }

  private clearDestPreview(): void {
    this.hoveredDestFP.clear();
    this.previewBoard = null;
    this.rebuildRingCells();
  }

  private rebuildRingCells(): void {
    const b = this.displayBoard;
    this.whiteRingCells = this.gess.getEnclosedCells(b, 'white');
    this.blackRingCells = this.gess.getEnclosedCells(b, 'black');
  }

  private rebuildHighlights(): void {
    this.hoveredFP.clear();
    this.clearDestPreview();

    this.selectedFP.clear();
    if (this.state.selectedCenter) {
      const { row, col } = this.state.selectedCenter;
      this.selectedFP = this.fp3x3(row, col);
    }

    this.validMoveCells.clear();
    for (const m of this.state.validMoves)
      this.validMoveCells.add(`${m.row},${m.col}`);

    this.moveableFootprints.clear();
    if (!this.state.winner && !this.isAiTurn()) {
      const { board, currentPlayer } = this.state;
      // Centres span the whole 20×20 grid (0..19), including the border ring, so
      // a piece may be centred just off the playing area.
      for (let r = 0; r <= 19; r++)
        for (let c = 0; c <= 19; c++)
          if (this.gess.isValidFootprintCenter(r, c, board, currentPlayer) &&
              this.gess.getValidMoves(board, { row: r, col: c }, currentPlayer).length > 0)
            this.moveableFootprints.add(`${r},${c}`);
    }

    this.clickable.clear();
    if (!this.state.winner && !this.isAiTurn()) {
      if (this.state.phase === 'select-footprint') {
        this.clickable = new Set(this.moveableFootprints);
      } else {
        for (const m of this.state.validMoves)
          this.clickable.add(`${m.row},${m.col}`);
      }
    }
  }

  private fp3x3(row: number, col: number): Set<string> {
    const s = new Set<string>();
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        s.add(`${row + dr},${col + dc}`);
    return s;
  }
}
