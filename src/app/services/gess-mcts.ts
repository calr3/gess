// ─────────────────────────────────────────────────────────────────────────────
// Neural tree search: AlphaZero-style MCTS (PUCT) guided by the trained network.
//
// A Gess move is two network decisions — the piece, then where it goes — so the
// tree alternates between "pick a piece" nodes and "pick a destination" nodes,
// with the same player to move in both halves; values change sign only when the
// turn passes, as in training.
//
// The network is the expensive part, so evaluations go to it in batches (on the
// GPU when there is one): each round descends the tree many times, using a
// virtual loss to spread the descents over different leaves, and sends all the
// leaves off in one call. While the network works on one batch the next is
// being selected, so the GPU is not left waiting on the tree.
//
// The search is anytime: it runs batches until the time budget is spent. The
// tree is kept between moves, and reused if the next position is in it.
// ─────────────────────────────────────────────────────────────────────────────

import * as Flat from './gess-flat';
import { OBS_LENGTH, writeObservation } from './gess-nn-obs';

const ACTIONS = 400;

/** Evaluates `count` observations laid out back to back in `obs`. */
export type Evaluator = (obs: Float32Array, count: number) => Promise<{
  /** count × 400 raw policy scores. */
  logits: Float32Array;
  /** count values, each for the side to move in that position, in [-1, 1]. */
  values: Float32Array;
}>;

export interface SearchOptions {
  /** Wall-clock budget for the search, in ms. */
  budgetMs: number;
  /** Leaves per network call. The evaluator always receives this many
   *  observations (padded), so the network sees one input shape. */
  batchSize: number;
  /** Stop growing the tree past this many nodes (memory guard). */
  maxNodes?: number;
  /** Play a move that wins on the spot without searching (default true). */
  takeImmediateWins?: boolean;
}

export interface SearchResult {
  from: number;
  to: number;
  /** Network evaluations made in this search. */
  evaluations: number;
  /** Visits at the root, including any carried over from the previous search. */
  rootVisits: number;
  /** The chosen move's value for the mover, from the search. */
  value: number;
  elapsedMs: number;
}

// PUCT exploration, AlphaZero's schedule: c grows slowly with the parent's visits.
const C_BASE = 19652;
const C_INIT = 1.25;
// Unvisited moves start at the node's own value less this (first-play urgency).
const FPU_REDUCTION = 0.2;
// A descent in flight counts as this many losses on its path.
const VIRTUAL_LOSS = 1;

class Node {
  /** Legal actions (cell indices) and their policy priors, set on expansion. */
  actions: Int16Array | null = null;
  priors: Float32Array | null = null;
  children: (Node | undefined)[] = [];
  /** Per action: visits (including virtual) and summed value, for this node's mover. */
  visits: Float32Array | null = null;
  valueSum: Float32Array | null = null;
  totalVisits = 0;
  /** The network's value for this position (for this node's mover). */
  nnValue = 0;
  /** Awaiting a network evaluation. */
  pending = false;

  constructor(
    /** Shared between a "pick a piece" node and its "pick a destination" children. */
    readonly board: Flat.FlatBoard,
    /** Stone value of the player to move. */
    readonly me: number,
    /** The picked-up piece's cell, or -1 while choosing one. */
    readonly source: number,
    /** Consecutive captureless turns before this position. */
    readonly streak: number,
    /** Game over: the result for `me` (1 win, 0 draw, -1 loss); else null. */
    public terminal: number | null,
  ) {}

  get expanded(): boolean {
    return this.actions !== null;
  }
}

/** Legal actions at a node: pieces that can move, or the picked piece's destinations. */
function legalActions(node: Node): number[] {
  const out: number[] = [];
  if (node.source >= 0) {
    return Flat.destinations(node.board, Math.floor(node.source / 20), node.source % 20, node.me, out);
  }
  const probe: number[] = [];
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      if (!Flat.isFootprintCentre(node.board, r, c, node.me)) continue;
      probe.length = 0;
      if (Flat.destinations(node.board, r, c, node.me, probe, true).length) out.push(r * 20 + c);
    }
  return out;
}

function childOf(node: Node, action: number): Node {
  if (node.source < 0) {
    return new Node(node.board, node.me, action, node.streak, null);
  }
  const board = Flat.applyMove(node.board, node.source, action, node.me);
  const { result, streak } = Flat.outcomeAfterMove(node.board, board, node.me, node.streak);
  // The next node belongs to the opponent, so the mover's result flips.
  return new Node(board, 3 - node.me, -1, streak, result === null ? null : -result);
}

function expand(node: Node, actions: number[], logits: Float32Array, offset: number, value: number) {
  const n = actions.length;
  node.actions = Int16Array.from(actions);
  node.priors = new Float32Array(n);
  node.visits = new Float32Array(n);
  node.valueSum = new Float32Array(n);
  node.children = new Array(n);
  node.nnValue = value;
  let max = -Infinity;
  for (let i = 0; i < n; i++) max = Math.max(max, logits[offset + actions[i]]);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += node.priors[i] = Math.exp(logits[offset + actions[i]] - max);
  for (let i = 0; i < n; i++) node.priors[i] /= sum;
}

function selectAction(node: Node): number {
  const visits = node.visits!, valueSum = node.valueSum!, priors = node.priors!;
  const total = node.totalVisits;
  const c = C_INIT + Math.log((1 + total + C_BASE) / C_BASE);
  const scale = c * Math.sqrt(Math.max(total, 1));
  const fpu = node.nnValue - FPU_REDUCTION;
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < priors.length; i++) {
    const n = visits[i];
    const q = n > 0 ? valueSum[i] / n : fpu;
    const score = q + (scale * priors[i]) / (1 + n);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

interface Leaf {
  path: Node[];      // root .. parent of the leaf
  edges: number[];   // action index taken at each node in `path`
  node: Node;
  actions: number[];
}

/** Undo the virtual losses on a path, turning them into a real result `v` for `leaf.me`. */
function backup(path: Node[], edges: number[], leaf: Node, v: number | null): void {
  let value = v ?? 0;
  let valueMe = leaf.me;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i], a = edges[i];
    if (node.me !== valueMe) { value = -value; valueMe = node.me; }
    if (v === null) {
      // Abandoned descent: remove the virtual visit entirely.
      node.visits![a] -= 1;
      node.valueSum![a] += VIRTUAL_LOSS;
      node.totalVisits -= 1;
    } else {
      node.valueSum![a] += VIRTUAL_LOSS + value;
    }
  }
}

export class Mcts {
  private root: Node | null = null;
  private nodes = 0;

  constructor(private readonly evaluate: Evaluator) {}

  /**
   * Search the position and return the best move. `board` is flat (gess-flat),
   * `me` the mover's stone value, `streak` the captureless-turn count so far.
   */
  async search(
    board: Flat.FlatBoard, me: number, streak: number, opts: SearchOptions,
  ): Promise<SearchResult | null> {
    const start = performance.now();
    const deadline = start + opts.budgetMs;
    const maxNodes = opts.maxNodes ?? 400_000;
    const batch = opts.batchSize;

    // A move that wins on the spot can't be bettered; the search may not find
    // it in time if the network doesn't rate it (1 move in hundreds).
    const win = opts.takeImmediateWins === false ? null : immediateWin(board, me, streak);
    if (win) {
      this.root = null;
      return { ...win, evaluations: 0, rootVisits: 0, value: 1, elapsedMs: performance.now() - start };
    }

    const root = this.adoptRoot(board, me, streak);
    const buffers = [new Float32Array(batch * OBS_LENGTH), new Float32Array(batch * OBS_LENGTH)];
    let evaluations = 0;
    let round = 0;
    let lastRoundMs = 0;

    // Select up to `batch` leaves. Game-over leaves are backed up at once.
    const select = (): Leaf[] => {
      const leaves: Leaf[] = [];
      // Descents that end without a leaf to evaluate (a finished game, or a
      // leaf already in this or the in-flight batch) count towards a cap, so a
      // tree that is fully explored or solved can't spin here.
      let wasted = 0;
      while (leaves.length < batch && wasted < 4 * batch && this.nodes < maxNodes) {
        const path: Node[] = [], edges: number[] = [];
        let node = root;
        while (node.expanded && node.terminal === null) {
          const a = selectAction(node);
          node.visits![a] += 1;
          node.valueSum![a] -= VIRTUAL_LOSS;
          node.totalVisits += 1;
          path.push(node);
          edges.push(a);
          let child = node.children[a];
          if (!child) {
            child = node.children[a] = childOf(node, node.actions![a]);
            this.nodes++;
          }
          node = child;
        }
        if (node.terminal !== null) {
          backup(path, edges, node, node.terminal);
          if (!path.length) break; // the root itself is over
          wasted++;
          continue;
        }
        if (node.pending) {
          backup(path, edges, node, null);
          wasted++;
          continue;
        }
        const actions = legalActions(node);
        if (!actions.length) {
          // Nothing can move: treat it as lost for the player to move.
          node.terminal = -1;
          backup(path, edges, node, -1);
          if (!path.length) break;
          wasted++;
          continue;
        }
        node.pending = true;
        leaves.push({ path, edges, node, actions });
        if (!node.expanded && node === root) break; // nothing else to do until the root is in
      }
      return leaves;
    };

    const submit = (leaves: Leaf[]) => {
      const buf = buffers[round++ % 2];
      leaves.forEach((l, i) => writeObservation(l.node.board, l.node.me, l.node.source, buf, i * OBS_LENGTH));
      evaluations += leaves.length;
      return this.evaluate(buf, batch);
    };

    const absorb = (leaves: Leaf[], out: { logits: Float32Array; values: Float32Array }) => {
      leaves.forEach((l, i) => {
        l.node.pending = false;
        expand(l.node, l.actions, out.logits, i * ACTIONS, out.values[i]);
        backup(l.path, l.edges, l.node, out.values[i]);
      });
    };

    // Pipeline: while one batch is on the network, select the next. A round is
    // started only if it should finish within the budget.
    let current = select();
    let inFlight = current.length ? submit(current) : null;
    while (inFlight) {
      const t0 = performance.now();
      // Selected now, this batch is submitted in ~1 round and done in ~2.
      let next = root.expanded && deadline - t0 > 2 * lastRoundMs ? select() : [];
      const out = await inFlight;
      absorb(current, out);
      lastRoundMs = performance.now() - t0;
      // Nothing selected in parallel (first round, or every descent ran into a
      // leaf still being evaluated): select now, if there's time for a round.
      if (!next.length && performance.now() + lastRoundMs < deadline) next = select();
      current = next;
      inFlight = current.length ? submit(current) : null;
    }

    if (root.terminal !== null || !root.expanded) return null;

    // The move: the most-visited piece, then its most-visited destination.
    const from = mostVisited(root);
    let fromNode = root.children[from];
    if (!fromNode) fromNode = root.children[from] = childOf(root, root.actions![from]);
    if (!fromNode.expanded) {
      // Too little time to look at it: one evaluation for the destinations.
      const actions = legalActions(fromNode);
      const buf = buffers[0];
      writeObservation(fromNode.board, fromNode.me, fromNode.source, buf, 0);
      absorb([{ path: [], edges: [], node: fromNode, actions }], await this.evaluate(buf, batch));
      evaluations++;
    }
    const to = mostVisited(fromNode);
    const n = fromNode.visits![to];
    const value = n > 0 ? fromNode.valueSum![to] / n : fromNode.nnValue;

    this.root = root;
    return {
      from: root.actions![from],
      to: fromNode.actions![to],
      evaluations,
      rootVisits: root.totalVisits,
      value,
      elapsedMs: performance.now() - start,
    };
  }

  /** The previous tree's node for this position, if there is one; else a fresh root. */
  private adoptRoot(board: Flat.FlatBoard, me: number, streak: number): Node {
    const matches = (n: Node) =>
      n.source < 0 && n.me === me && n.streak === streak && n.terminal === null &&
      n.board.every((v, i) => v === board[i]);
    // The position is usually a full move or two (up to 4 tree levels) below
    // the last root: our move, then the opponent's reply.
    let level: Node[] = this.root ? [this.root] : [];
    for (let depth = 0; depth <= 4 && level.length; depth++) {
      const found = level.find(matches);
      if (found) {
        this.nodes = countNodes(found);
        return found;
      }
      level = level.flatMap(n => n.children.filter((c): c is Node => !!c));
    }
    this.nodes = 1;
    return new Node(board.slice(), me, -1, streak, null);
  }
}

function immediateWin(board: Flat.FlatBoard, me: number, streak: number): { from: number; to: number } | null {
  const dests: number[] = [];
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      if (!Flat.isFootprintCentre(board, r, c, me)) continue;
      dests.length = 0;
      for (const to of Flat.destinations(board, r, c, me, dests)) {
        const after = Flat.applyMove(board, r * 20 + c, to, me);
        if (Flat.outcomeAfterMove(board, after, me, streak).result === 1) return { from: r * 20 + c, to };
      }
    }
  return null;
}

function mostVisited(node: Node): number {
  const visits = node.visits!, priors = node.priors!;
  let best = 0;
  for (let i = 1; i < visits.length; i++) {
    if (visits[i] > visits[best] || (visits[i] === visits[best] && priors[i] > priors[best])) best = i;
  }
  return best;
}

function countNodes(root: Node): number {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    n++;
    for (const c of node.children) if (c) stack.push(c);
  }
  return n;
}
