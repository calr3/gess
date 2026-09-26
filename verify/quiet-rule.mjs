// Unit tests for the quiet-move rule (pgx gess v1).
//
// Rule: if QUIET_MOVE_LIMIT (20) consecutive moves pass without a capture —
// where a "capture" is any move that removes a stone from the board, the
// opponent's OR your own (a self-capture, or stones carried off the edge) — the
// game ends and is decided on stones: more stones wins, and only an exact tie is
// a draw.
//
// The interesting edge is the move on which the count reaches the limit: if that
// same move also empties a side's rings, the result on rings stands and takes
// precedence. resolveOutcome encodes that by checking rings before the count;
// these tests pin that down as a pure decision, on real boards driven through the
// game logic, and in the negamax engine's search (built by wasm-engine/build.sh).
//
// A note that falls out of building the fixtures: a WIN on rings is necessarily
// a CAPTURING move. You cannot empty the opponent's rings without removing their
// stones (a footprint that reaches a ring bulldozes it), so a winning move always
// resets the count. A LOSS, by contrast, is reachable with zero captures:
// relocate your own last ring's stones onto empty cells and the ring is gone
// while the stone count is unchanged. So the collision between the limit and a
// ring result is real for the loss case, which is the fixture built below.
//
//   ~/node22/bin/node --experimental-strip-types verify/quiet-rule.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __d = dirname(fileURLToPath(import.meta.url));
const E = await import(join(__d, '..', 'src', 'app', 'services', 'gess-engine.ts'));
const { applyMove, countRings, countStones, wasCapture, totalStones, resolveOutcome, QUIET_MOVE_LIMIT: LIM } = E;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, got, want) { check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
// Place a ring: empty centre + 8 stones of `p` around (cr,cc).
function ring(b, p, cr, cc) {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
    if (dr || dc) b[cr + dr][cc + dc] = p;
}
// The outcome after `mover` produced `after`, with `quiet` captureless moves.
const outcome = (after, mover, quiet) => {
  const opp = mover === 'black' ? 'white' : 'black';
  return resolveOutcome(countRings(after, mover), countRings(after, opp), quiet,
    countStones(after, mover), countStones(after, opp));
};

// ── 1. resolveOutcome: rings first, then stones at the limit ─────────────────
console.log('resolveOutcome at the quiet-move limit:');
eq('below the limit, both have rings → ongoing', resolveOutcome(2, 3, LIM - 1, 30, 20), 'ongoing');
eq('AT the limit, more stones → mover wins on stones', resolveOutcome(2, 3, LIM, 30, 29), 'mover-wins-on-stones');
eq('AT the limit, fewer stones → mover loses on stones', resolveOutcome(2, 3, LIM, 29, 30), 'mover-loses-on-stones');
eq('AT the limit, level on stones → draw', resolveOutcome(2, 3, LIM, 30, 30), 'draw');
eq('past the limit is the same', resolveOutcome(1, 1, LIM + 5, 10, 12), 'mover-loses-on-stones');
eq('WIN on rings at the limit beats stones', resolveOutcome(3, 0, LIM, 5, 40), 'mover-wins');
eq('LOSS on rings at the limit beats stones', resolveOutcome(0, 3, LIM, 40, 5), 'mover-loses');
eq('both rings gone at the limit → both-lose', resolveOutcome(0, 0, LIM, 40, 5), 'both-lose');
eq('win regardless of count (count 0)', resolveOutcome(3, 0, 0, 1, 1), 'mover-wins');
eq('loss regardless of count (count 0)', resolveOutcome(0, 3, 0, 1, 1), 'mover-loses');

// ── 2. LOSS on rings exactly on the limit move ────────────────────────────────
// Black has one ring (centre 5,5) and more stones; White has one (centre 15,5).
// Black plays a captureless move that relocates three of its own ring stones,
// destroying its last ring. The count reaches the limit on this very move and
// Black is ahead on stones — but losing the ring decides it.
console.log('\nLOSS on rings on the limit move:');
{
  const b = blank();
  ring(b, 'black', 5, 5);
  ring(b, 'white', 15, 5);
  b[10][15] = 'black'; b[10][17] = 'black'; // Black ahead on stones, 10–8
  const before = b.map(r => [...r]);
  // Footprint centred on the ring corner (4,4) lifts black (4,4),(4,5),(5,4)
  // and slides up-left to (2,2); corridor and landing cells are all empty.
  const after = applyMove(before, { row: 4, col: 4 }, { row: 2, col: 2 }, 'black');

  check('move captured nothing', wasCapture(before, after) === false,
    `stones ${totalStones(before)}→${totalStones(after)}`);
  eq('black lost its last ring', countRings(after, 'black'), 0);
  eq('white ring intact', countRings(after, 'white'), 1);
  eq('black is ahead on stones', countStones(after, 'black') > countStones(after, 'white'), true);
  eq('outcome is the loss on rings', outcome(after, 'black', LIM), 'mover-loses');
}

// ── 3. A neutral quiet move at the limit is decided on stones ─────────────────
console.log('\nNeutral quiet move at the limit → decided on stones:');
for (const [extra, want, label] of [
  [0, 'draw', 'level'],
  [1, 'mover-wins-on-stones', 'black one stone ahead'],
  [-1, 'mover-loses-on-stones', 'black one stone behind'],
]) {
  const b = blank();
  ring(b, 'black', 5, 5);
  ring(b, 'white', 15, 5);
  b[10][10] = 'black'; b[3][15] = 'white'; // a lone stone each, empty 3×3 around them
  if (extra > 0) b[16][16] = 'black';
  if (extra < 0) b[16][16] = 'white';
  const before = b.map(r => [...r]);
  const after = applyMove(before, { row: 10, col: 10 }, { row: 10, col: 12 }, 'black');
  check(`${label}: move captured nothing`, wasCapture(before, after) === false);
  eq(`${label}: outcome`, outcome(after, 'black', LIM), want);
}

// ── 4. WIN on rings captures, so it resets the count ──────────────────────────
console.log('\nWIN on rings at the limit (a winning move always captures):');
{
  const b = blank();
  ring(b, 'black', 5, 15); // Black keeps a ring elsewhere
  ring(b, 'white', 5, 5);  // White's last ring
  b[5][2] = 'black';       // lone Black stone, will slide right onto (5,5)
  const before = b.map(r => [...r]);
  const after = applyMove(before, { row: 5, col: 2 }, { row: 5, col: 5 }, 'black');

  check('the winning move captured', wasCapture(before, after) === true,
    `stones ${totalStones(before)}→${totalStones(after)}`);
  eq('white has no rings left', countRings(after, 'white'), 0);
  eq('outcome is a win (the capture reset the count)', outcome(after, 'black', 0), 'mover-wins');
  eq('…and would be even at the limit', outcome(after, 'black', LIM), 'mover-wins');
}

// ── 5. The count: captures reset it, captureless moves grow it ────────────────
// Mirrors GessService.trailingNoCaptureStreak: the count is the length of the
// trailing run of captureless moves, so any capture (including a self-capture)
// zeroes it.
console.log('\nCount accounting (trailing captureless run):');
{
  const trailing = (caps) => { let n = 0; for (let i = caps.length - 1; i >= 0 && !caps[i]; i--) n++; return n; };
  eq('all captureless → full length', trailing([false, false, false, false]), 4);
  eq('a capture mid-history is not counted', trailing([false, true, false, false]), 2);
  eq('most recent move captured → 0', trailing([false, false, true]), 0);
  eq('empty history → 0', trailing([]), 0);
  eq('20 quiet moves reach the limit', trailing(Array(20).fill(false)), LIM);
}

// ── 6. The negamax engine plays to the rule ───────────────────────────────────
// One move from the limit (19 quiet moves), with rings safe on both sides:
// ahead on stones, any quiet move wins, and the search should see a forced win;
// behind, every quiet move loses, so it must capture (or lose).
console.log('\nNegamax one move from the limit:');
{
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
  const { instance } = await WebAssembly.instantiate(
    readFileSync(join(__d, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm')),
    { env: { memory, now: () => Date.now(), random: () => Math.random() } });
  const x = instance.exports;
  const WIN = 1_000_000, MAXD = 64;
  const search = (b, quiet) => {
    const bytes = new Uint8Array(400); // engine bytes: 1 white, 2 black
    for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++)
      bytes[r * 20 + c] = b[r][c] === 'white' ? 1 : b[r][c] === 'black' ? 2 : 0;
    new Uint8Array(memory.buffer, x.board_ptr(), 400).set(bytes);
    x.set_quiet_moves(quiet);
    x.best_move(0, 500, 1, 0, 1); // black, TT on, standalone
    const o = new Int32Array(memory.buffer, x.out_ptr(), 10);
    return { from: { row: o[1], col: o[2] }, to: { row: o[3], col: o[4] }, score: o[6] };
  };
  // Black's ring and a lone black stone that can take a lone white stone; white
  // has its ring far away.
  const position = (blackExtra, whiteExtra) => {
    const b = blank();
    ring(b, 'black', 15, 5);
    ring(b, 'white', 4, 14);
    b[10][4] = 'black'; b[10][7] = 'white';                 // black can capture this stone
    for (let i = 0; i < blackExtra; i++) b[17][12 + 2 * i] = 'black';
    for (let i = 0; i < whiteExtra; i++) b[2][2 + 2 * i] = 'white';
    return b;
  };
  {
    const b = position(3, 0); // black 12, white 10
    const r = search(b, LIM - 1);
    const after = applyMove(b, r.from, r.to, 'black');
    check('ahead: search sees the win on stones', r.score >= WIN - MAXD, `score ${r.score}`);
    eq('ahead: the move played wins', outcome(after, 'black', wasCapture(b, after) ? 0 : LIM), 'mover-wins-on-stones');
  }
  {
    const b = position(0, 3); // black 9, white 12
    const r = search(b, LIM - 1);
    const after = applyMove(b, r.from, r.to, 'black');
    check('behind: the move played captures', wasCapture(b, after), `played ${JSON.stringify(r)}`);
    check('behind: search does not see a loss', r.score > -(WIN - MAXD), `score ${r.score}`);
  }
  {
    const b = position(3, 0);
    const r = search(b, 0); // far from the limit: no forced result
    check('far from the limit: no forced result', Math.abs(r.score) < WIN - MAXD, `score ${r.score}`);
  }
}

console.log(`\n${failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
