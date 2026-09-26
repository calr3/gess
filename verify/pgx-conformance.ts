// Checks the app's Gess rules against pgx's (the training environment, env v1),
// using positions dumped from pgx: by tdgauntlet (conformance/dump_gess.py there;
// copied here as pgx-gess.jsonl.gz), and by dump_pgx_quiet.py here (games that
// reach the quiet-move limit with unequal stones). For every position: the complete legal
// moves, and for each move the resulting state (as a digest) and the game result.
// All three rule implementations in the app are checked: gess-engine (the game),
// gess-flat (the neural search) and the Rust negamax engine (its legal moves and
// their results, via gen_root; it needs a build: wasm-engine/build.sh).
//
//   node_modules/.bin/esbuild verify/pgx-conformance.ts --bundle --platform=node --format=esm \
//     --outfile=node_modules/.cache/pgx-conformance.mjs && ~/node22/bin/node node_modules/.cache/pgx-conformance.mjs
//
// To refresh the fixtures after pgx's rules change, regenerate the first in
// tdgauntlet and copy it over, and rerun dump_pgx_quiet.py.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as Engine from '../src/app/services/gess-engine';
import * as Flat from '../src/app/services/gess-flat';
import type { Board, Player } from '../src/app/models/game.model';

interface Wire { board: string; to_move: number; moves: number; quiet_moves: number }
interface Rec {
  kind?: string;
  game: number | string;
  state: Wire;
  outcome: string;
  moves?: [number, number][];
  successors?: string[];
  successor_outcomes?: string;
}

const SIZE = 20;
// tdgauntlet's fixture, plus games that reach the quiet-move limit with unequal
// stones (dump_pgx_quiet.py), which the first has none of.
const lines: Rec[] = [];
for (const name of ['pgx-gess.jsonl.gz', 'pgx-gess-quiet.jsonl.gz']) {
  const recs = gunzipSync(readFileSync(new URL(`../../verify/${name}`, import.meta.url)))
    .toString('utf8').trim().split('\n').map(l => JSON.parse(l) as Rec);
  console.log(`${name}:`, JSON.stringify(recs.shift()));
  lines.push(...recs.map(r => ({ ...r, game: `${name.replace('.jsonl.gz', '')} game ${r.game}` })));
}

/** tdgauntlet's digest: FNV-1a (32-bit) of "board|to_move|moves|quiet_moves". */
function digest(w: Wire): string {
  const text = `${w.board}|${w.to_move}|${w.moves}|${w.quiet_moves}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const parseBoard = (s: string): Board => {
  const board: Board = [];
  for (let r = 0; r < SIZE; r++) {
    const row: Board[number] = [];
    for (let c = 0; c < SIZE; c++) {
      const ch = s[r * SIZE + c];
      row.push(ch === 'B' ? 'black' : ch === 'W' ? 'white' : null);
    }
    board.push(row);
  }
  return board;
};
const boardString = (b: Board) => b.map(row => row.map(v => (v === 'black' ? 'B' : v === 'white' ? 'W' : '.')).join('')).join('');
const flatString = (b: Flat.FlatBoard) => Array.from(b, v => '.BW'[v]).join('');

/** Result code as the fixture writes it: '-' ongoing, '0' black won, '1' white won, 'd' drawn. */
function code(result: 1 | 0 | -1 | null, mover: Player): string {
  if (result === null) return '-';
  if (result === 0) return 'd';
  const winner = result === 1 ? mover : mover === 'black' ? 'white' : 'black';
  return winner === 'black' ? '0' : '1';
}

/** The game's rules (gess-engine), as GessService applies them after a move. */
function engineOutcome(before: Board, after: Board, mover: Player, quiet: number): { result: 1 | 0 | -1 | null; quiet: number } {
  const opp: Player = mover === 'black' ? 'white' : 'black';
  const newQuiet = Engine.wasCapture(before, after) ? 0 : quiet + 1;
  const outcome = Engine.resolveOutcome(Engine.countRings(after, mover), Engine.countRings(after, opp), newQuiet,
    Engine.countStones(after, mover), Engine.countStones(after, opp));
  const result = Engine.outcomeResult(outcome);
  return { result, quiet: newQuiet };
}

// The Rust negamax engine, as built by wasm-engine/build.sh.
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const wasm = (await WebAssembly.instantiate(
  readFileSync(new URL('../../wasm-engine/target/wasm32-unknown-unknown/release/gess_engine_wasm.wasm', import.meta.url)),
  { env: { memory, now: () => Date.now(), random: () => Math.random() } },
)).instance.exports as unknown as {
  board_ptr(): number; out_ptr(): number; gen_root(white: number): number; set_quiet_moves(n: number): void;
};
// gen_root's outcome codes (OUT_* in lib.rs): 2 win, 1 draw, 0 play on, -1 loss.
const RUST_OUTCOME: Record<number, 1 | 0 | -1 | null> = { 2: 1, 1: 0, 0: null, [-1]: -1 };

/** The Rust engine's legal moves at `board` and each one's result code. */
function rustMoves(board: string, player: Player, quiet: number): Map<string, string> {
  // The engine's board bytes: 0 empty, 1 white, 2 black.
  const bytes = new Uint8Array(400);
  for (let i = 0; i < 400; i++) bytes[i] = board[i] === 'W' ? 1 : board[i] === 'B' ? 2 : 0;
  new Uint8Array(memory.buffer, wasm.board_ptr(), 400).set(bytes);
  wasm.set_quiet_moves(quiet);
  const n = wasm.gen_root(player === 'white' ? 1 : 0);
  const out = new Int32Array(memory.buffer, wasm.out_ptr(), 1 + 6 * n);
  const moves = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const [fr, fc, tr, tc, outcome] = out.subarray(1 + 6 * i, 7 + 6 * i);
    moves.set(`${fr * SIZE + fc}-${tr * SIZE + tc}`, code(RUST_OUTCOME[outcome], player));
  }
  return moves;
}

const failures = new Map<string, { count: number; example: string }>();
function fail(kind: string, example: string) {
  const f = failures.get(kind);
  if (f) f.count++;
  else failures.set(kind, { count: 1, example });
}

let positions = 0, successors = 0;
for (const rec of lines) {
  if (!rec.moves) continue; // a finished game: nothing to move
  positions++;
  const w = rec.state;
  const player: Player = w.to_move === 0 ? 'black' : 'white';
  const board = parseBoard(w.board);
  const flat = Flat.toFlat(board);
  const me = Flat.stoneOf(player);
  const where = `${rec.game} move ${w.moves}`;

  // Complete legal moves, sorted like the fixture.
  const engineMoves: [number, number][] = [];
  const flatMoves: [number, number][] = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (Engine.isValidFootprintCenter(r, c, board, player))
        for (const d of Engine.getValidMoves(board, { row: r, col: c }, player)) engineMoves.push([r * SIZE + c, d.row * SIZE + d.col]);
      if (Flat.isFootprintCentre(flat, r, c, me))
        for (const d of Flat.destinations(flat, r, c, me, [])) flatMoves.push([r * SIZE + c, d]);
    }
  const sort = (m: [number, number][]) => m.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(m => m.join('-')).join(',');
  const expected = sort(rec.moves);
  if (sort(engineMoves) !== expected) fail('engine: legal moves', where);
  if (sort(flatMoves) !== expected) fail('flat: legal moves', where);
  const rust = rustMoves(w.board, player, w.quiet_moves);
  if ([...rust.keys()].sort().join() !== rec.moves.map(m => m.join('-')).sort().join()) fail('rust: legal moves', where);

  rec.moves.forEach(([from, to], i) => {
    successors++;
    const f = { row: Math.floor(from / SIZE), col: from % SIZE };
    const t = { row: Math.floor(to / SIZE), col: to % SIZE };
    const wantDigest = rec.successors![i];
    const wantCode = rec.successor_outcomes![i];

    // gess-engine
    const after = Engine.applyMove(board, f, t, player);
    const eo = engineOutcome(board, after, player, w.quiet_moves);
    const ew: Wire = { board: boardString(after), to_move: 1 - w.to_move, moves: w.moves + 1, quiet_moves: eo.quiet };
    if (digest(ew) !== wantDigest) fail('engine: resulting state', `${where}, ${from}->${to}`);
    const ec = code(eo.result, player);
    if (ec !== wantCode) fail(`engine: result (pgx '${wantCode}', app '${ec}')`, `${where}, ${from}->${to}, quiet ${w.quiet_moves}`);

    // gess-flat
    const fAfter = Flat.applyMove(flat, from, to, me);
    const fo = Flat.outcomeAfterMove(flat, fAfter, me, w.quiet_moves);
    const fw: Wire = { board: flatString(fAfter), to_move: 1 - w.to_move, moves: w.moves + 1, quiet_moves: fo.streak };
    if (digest(fw) !== wantDigest) fail('flat: resulting state', `${where}, ${from}->${to}`);
    const fc = code(fo.result, player);
    if (fc !== wantCode) fail(`flat: result (pgx '${wantCode}', app '${fc}')`, `${where}, ${from}->${to}, quiet ${w.quiet_moves}`);

    // Rust negamax
    const rc = rust.get(`${from}-${to}`);
    if (rc !== undefined && rc !== wantCode) fail(`rust: result (pgx '${wantCode}', app '${rc}')`, `${where}, ${from}->${to}, quiet ${w.quiet_moves}`);
  });
}

console.log(`${positions} positions, ${successors} moves checked`);
if (!failures.size) {
  console.log('OK: the app matches pgx');
} else {
  for (const [kind, f] of failures) console.log(`MISMATCH ${kind}: ${f.count}× (e.g. ${f.example})`);
  process.exit(1);
}
