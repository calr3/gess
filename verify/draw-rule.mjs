// Unit tests for the no-capture draw rule.
//
// Rule: if NO_CAPTURE_DRAW_LIMIT (20) consecutive turns pass without a capture
// — where a "capture" is any move that removes a stone from the board, the
// opponent's OR your own (a self-capture) — the game is a draw.
//
// The interesting edge is the move on which the streak would reach the limit:
// if that same move also empties a side's rings, the win/loss is decisive and
// takes precedence over the draw. resolveOutcome encodes that by checking ring
// counts before the streak; these tests pin down that precedence both as a pure
// decision and on real boards driven through the actual engine (applyMove /
// countRings / wasCapture from the shared oracle).
//
// A note that falls out of building the fixtures: a WIN is necessarily a
// CAPTURING move. You cannot empty the opponent's rings without removing their
// stones (a footprint that reaches a ring bulldozes it), so a winning move
// always resets the streak — the draw can never actually be "averted" by a win,
// only by the precedence rule in the hypothetical. A LOSS, by contrast, is
// genuinely reachable with zero captures: relocate your own last ring's stones
// onto empty cells and the ring is gone while the stone count is unchanged. So
// the captureless-draw-vs-decisive collision is real for the loss case, which
// is exactly the fixture we build below.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __d = dirname(fileURLToPath(import.meta.url));
const E = await import(join(__d, 'engine.mjs'));
const { applyMove, countRings, wasCapture, totalStones, resolveOutcome, NO_CAPTURE_DRAW_LIMIT: LIM } = E;

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

// ── 1. resolveOutcome: ring result strictly precedes the draw ────────────────
// These are the precedence assertions the rule hinges on: at the exact streak
// limit, a decisive ring result wins out; only an otherwise-ongoing position
// becomes a draw.
console.log('resolveOutcome precedence at the draw boundary:');
eq('streak below limit, both have rings → ongoing', resolveOutcome(2, 3, LIM - 1), 'ongoing');
eq('streak AT limit, both have rings → draw', resolveOutcome(2, 3, LIM), 'draw');
eq('streak past limit, both have rings → draw', resolveOutcome(1, 1, LIM + 5), 'draw');
eq('WIN on the limit move overrides the draw', resolveOutcome(3, 0, LIM), 'mover-wins');
eq('LOSS on the limit move overrides the draw', resolveOutcome(0, 3, LIM), 'mover-loses');
eq('mutual ring loss on the limit move → both-lose (not draw)', resolveOutcome(0, 0, LIM), 'both-lose');
// And the decisive results do not depend on the streak at all.
eq('win regardless of streak (streak 0)', resolveOutcome(3, 0, 0), 'mover-wins');
eq('loss regardless of streak (streak 0)', resolveOutcome(0, 3, 0), 'mover-loses');

// ── 2. Integration — LOSS exactly on the captureless draw-trigger move ────────
// Black has one ring (centre 5,5); White has one (centre 15,5). Black plays a
// captureless move that relocates three of its own ring stones onto empty cells,
// destroying its last ring. With the streak now at the limit, the position
// would be a draw on ring-count grounds alone — but the self-destruction makes
// it a LOSS for Black, and the loss must win.
console.log('\nLOSS on the captureless draw-trigger move:');
{
  const b = blank();
  ring(b, 'black', 5, 5);
  ring(b, 'white', 15, 5);
  const before = b.map(r => [...r]);
  // Footprint centred on the ring corner (4,4) lifts black (4,4),(4,5),(5,4)
  // and slides up-left to (2,2); corridor and landing cells are all empty.
  const after = applyMove(before, { row: 4, col: 4 }, { row: 2, col: 2 }, 'black');

  check('move captured nothing', wasCapture(before, after) === false,
    `stones ${totalStones(before)}→${totalStones(after)}`);
  eq('black lost its last ring', countRings(after, 'black'), 0);
  eq('white ring intact', countRings(after, 'white'), 1);

  // The streak reaches the limit on this very move (it captured nothing).
  const streak = LIM; // 19 captureless turns preceded it, this is the 20th
  const outcome = resolveOutcome(countRings(after, 'black'), countRings(after, 'white'), streak);
  eq('outcome is the loss, not a draw', outcome, 'mover-loses');
}

// ── 3. Integration — neutral captureless move IS a draw at the limit ──────────
// Same position but Black instead slides a lone stone to an empty square,
// touching no ring. Both sides keep a ring, so reaching the limit is a draw.
console.log('\nNeutral captureless move at the limit → draw:');
{
  const b = blank();
  ring(b, 'black', 5, 5);
  ring(b, 'white', 15, 5);
  b[10][10] = 'black'; // a lone stone, empty 3×3 around it
  const before = b.map(r => [...r]);
  const after = applyMove(before, { row: 10, col: 10 }, { row: 10, col: 12 }, 'black');

  check('move captured nothing', wasCapture(before, after) === false,
    `stones ${totalStones(before)}→${totalStones(after)}`);
  eq('both sides still have a ring', countRings(after, 'black') === 1 && countRings(after, 'white') === 1, true);
  eq('outcome is a draw', resolveOutcome(countRings(after, 'black'), countRings(after, 'white'), LIM), 'draw');
}

// ── 4. Integration — WIN at the boundary captures, so it resets the streak ────
// Black captures White's last ring by sliding a lone stone onto its centre; the
// footprint removes the eight surrounding White stones. The capture resets the
// streak to 0, so a draw is never even in question — and the result is a win.
console.log('\nWIN at the boundary (a winning move always captures):');
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
  eq('black still has its ring', countRings(after, 'black'), 1);

  // A capture resets the streak: even if it had been 19, it is now 0.
  const streakAfter = 0;
  eq('outcome is a win (capture reset the streak)',
    resolveOutcome(countRings(after, 'black'), countRings(after, 'white'), streakAfter), 'mover-wins');
  // And even at the hypothetical limit the win still beats the draw.
  eq('win beats draw even if the streak were at the limit',
    resolveOutcome(countRings(after, 'black'), countRings(after, 'white'), LIM), 'mover-wins');
}

// ── 5. The streak counter: captures reset it, captureless moves grow it ───────
// Mirrors GessService.trailingNoCaptureStreak: the streak is the length of the
// trailing run of captureless moves, so any capture (including a self-capture)
// zeroes it.
console.log('\nStreak accounting (trailing captureless run):');
{
  const trailing = (caps) => { let n = 0; for (let i = caps.length - 1; i >= 0 && !caps[i]; i--) n++; return n; };
  eq('all captureless → full length', trailing([false, false, false, false]), 4);
  eq('a capture mid-history is not counted', trailing([false, true, false, false]), 2);
  eq('most recent move captured → streak 0', trailing([false, false, true]), 0);
  eq('empty history → 0', trailing([]), 0);
  // End-to-end: 19 captureless moves then the captureless loss move ⇒ streak hits
  // the limit on a decisive move; resolveOutcome returns the loss.
  const caps = Array(20).fill(false); // 20th move also captureless (the loss)
  const streak = trailing(caps);
  eq('19 quiet moves + captureless loss reaches the limit', streak, LIM);
  eq('…and resolves as a loss, not a draw', resolveOutcome(0, 1, streak), 'mover-loses');
}

console.log(`\n${failed === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
