import { Component, computed, effect, HostListener, OnDestroy, output, signal } from '@angular/core';
import type { Board } from '../models/game.model';
import {
  ringCentres, stepView, toBoard, TUTORIAL_COLS, TUTORIAL_ROWS, tutorialSteps,
} from './tutorial-steps';

/** Squares of the mini-board, in SVG units. */
const CELL = 40;

/**
 * The first-run tutorial (also opened from the Tutorial button): a card over
 * the game showing one step at a time, each on a small window of the board. A
 * step with a move plays it out, over and over.
 */
@Component({
  selector: 'app-tutorial',
  standalone: true,
  templateUrl: './tutorial.component.html',
  styleUrl: './tutorial.component.scss',
})
export class TutorialComponent implements OnDestroy {
  readonly closed = output<void>();

  readonly steps = tutorialSteps('Click');
  readonly index = signal(0);
  readonly step = computed(() => this.steps[this.index()]);
  readonly view = computed(() => stepView(this.step()));
  /** Showing the position after the step's move (the animation's second half). */
  readonly showAfter = signal(false);

  readonly cell = CELL;
  readonly width = TUTORIAL_COLS * CELL;
  readonly height = TUTORIAL_ROWS * CELL;
  readonly rowsIdx = Array.from({ length: TUTORIAL_ROWS }, (_, i) => i);
  readonly colsIdx = Array.from({ length: TUTORIAL_COLS }, (_, i) => i);

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Restart the move animation whenever the step changes.
    effect(() => {
      const hasMove = !!this.view().after;
      this.stopAnimation();
      this.showAfter.set(false);
      if (hasMove) this.animate(false);
    });
  }

  ngOnDestroy(): void {
    this.stopAnimation();
  }

  private animate(after: boolean): void {
    this.timer = setTimeout(() => {
      this.showAfter.set(!after);
      this.animate(!after);
    }, after ? 2000 : 1500);
  }

  private stopAnimation(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────

  get isLast(): boolean { return this.index() === this.steps.length - 1; }

  next(): void {
    if (this.isLast) this.closed.emit();
    else this.index.update(i => i + 1);
  }

  back(): void {
    if (this.index() > 0) this.index.update(i => i - 1);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.closed.emit();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.next(); }
    else if (e.key === 'ArrowLeft') this.back();
  }

  // ─── What the mini-board shows ──────────────────────────────────────────────

  /** The position on show: after the move during the animation's second half. */
  get shown(): Board {
    const v = this.view();
    return (this.showAfter() && v.after) || v.board;
  }

  get moved(): boolean { return this.showAfter() && !!this.view().after; }

  stone(r: number, c: number): string | null {
    const p = toBoard([r, c]);
    return this.shown[p.row][p.col];
  }

  private footprint(centre: [number, number] | undefined): Set<string> {
    const out = new Set<string>();
    if (!centre) return out;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const r = centre[0] + dr, c = centre[1] + dc;
        if (r >= 0 && r < TUTORIAL_ROWS && c >= 0 && c < TUTORIAL_COLS) out.add(`${r},${c}`);
      }
    return out;
  }

  /** Square fill: the piece in gold, or after a move both footprints as the board shows the last move. */
  fill(r: number, c: number): string {
    const s = this.step();
    const key = `${r},${c}`;
    if (this.moved) {
      if (this.footprint(s.piece).has(key) || this.footprint(s.move).has(key)) return '#d9ad48';
    } else if (this.footprint(s.piece).has(key)) {
      return '#dbb337';
    }
    return '#c8a055';
  }

  get pieceCentre(): [number, number] | null {
    return !this.moved && this.step().piece ? this.step().piece! : null;
  }

  get dots(): [number, number][] {
    return !this.moved && this.step().dots ? this.view().destinations : [];
  }

  /** Captured stones' squares, where the piece hasn't landed on them. */
  get captures(): [number, number][] {
    if (!this.moved) return [];
    return this.view().captured.filter(([r, c]) => !this.stone(r, c));
  }

  get rings(): { r: number; c: number; white: boolean }[] {
    const b = this.shown;
    return [
      ...ringCentres(b, 'white').map(([r, c]) => ({ r, c, white: true })),
      ...ringCentres(b, 'black').map(([r, c]) => ({ r, c, white: false })),
    ];
  }

  /** The arrow of the move being shown, in SVG units, stopping short of the destination's centre. */
  get arrow(): { x1: number; y1: number; x2: number; y2: number } | null {
    const s = this.step();
    if (!this.moved || !s.piece || !s.move) return null;
    const cx = (c: number) => (c + 0.5) * CELL;
    const [r1, c1] = s.piece, [r2, c2] = s.move;
    const dx = Math.sign(c2 - c1), dy = Math.sign(r2 - r1);
    return { x1: cx(c1), y1: cx(r1), x2: cx(c2) - dx * CELL * 0.18, y2: cx(r2) - dy * CELL * 0.18 };
  }

  centre(i: number): number { return (i + 0.5) * CELL; }
}
