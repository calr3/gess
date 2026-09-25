// Checks the neural tree search (gess-mcts) with the real network, run on the
// CPU through onnxruntime-web's WebAssembly backend:
//
//   1. From positions where the mover has a move that wins on the spot, the
//      tree search alone finds a winning move in most of them. (A wrong sign
//      anywhere in the backup shows up here as the search steering away from
//      wins.) 1b: with the immediate-win shortcut on, it always plays one.
//   2. From positions where some moves lose on the spot (breaking the mover's
//      own last ring), it never plays one.
//   3. Tree reuse: searching the position after the chosen move and a reply
//      starts from the kept subtree.
//
//   node_modules/.bin/esbuild verify/mcts-check.ts --bundle --platform=node --format=esm \
//     --external:onnxruntime-web --outfile=node_modules/.cache/mcts-check.mjs \
//     && ~/node22/bin/node node_modules/.cache/mcts-check.mjs
//
// Needs public/models/gess-policy.onnx (see verify/README-nn.md).

import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import * as Engine from '../src/app/services/gess-engine';
import * as Flat from '../src/app/services/gess-flat';
import { Evaluator, Mcts } from '../src/app/services/gess-mcts';
import { OBS_PLANES, OBS_SIZE } from '../src/app/services/gess-nn-obs';

const BUDGET_MS = Number(process.env.BUDGET_MS ?? 1500);
const BATCH = 8;

const session = await ort.InferenceSession.create(
  readFileSync(new URL('../../public/models/gess-policy.onnx', import.meta.url)),
  { executionProviders: ['wasm'] },
);
const evaluate: Evaluator = async (obs, count) => {
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', obs, [count, OBS_SIZE, OBS_SIZE, OBS_PLANES]),
  });
  const tensors = session.outputNames.map(n => out[n]);
  return {
    logits: tensors.find(t => t.size === count * 400)!.data as Float32Array,
    values: tensors.find(t => t.size === count)!.data as Float32Array,
  };
};

let seed = 777;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);

interface Move { from: number; to: number; result: number | null }

function allMoves(b: Flat.FlatBoard, me: number, streak: number): Move[] {
  const moves: Move[] = [];
  for (let r = 0; r < 20; r++)
    for (let c = 0; c < 20; c++) {
      if (!Flat.isFootprintCentre(b, r, c, me)) continue;
      for (const to of Flat.destinations(b, r, c, me, [])) {
        const after = Flat.applyMove(b, r * 20 + c, to, me);
        moves.push({ from: r * 20 + c, to, result: Flat.outcomeAfterMove(b, after, me, streak).result });
      }
    }
  return moves;
}

/** Random positions (random but non-suicidal play) that satisfy `want`. */
function findPositions(count: number, want: (moves: Move[]) => boolean) {
  const found: { board: Flat.FlatBoard; me: number; streak: number; moves: Move[] }[] = [];
  while (found.length < count) {
    let board = Flat.toFlat(Engine.makeBoard());
    let me = Flat.BLACK, streak = 0;
    for (let ply = 0; ply < 120; ply++) {
      const moves = allMoves(board, me, streak);
      if (ply > 6 && want(moves)) { found.push({ board, me, streak, moves }); break; }
      const safe = moves.filter(m => m.result === null);
      if (!safe.length) break;
      const m = safe[Math.floor(rand() * safe.length)];
      const after = Flat.applyMove(board, m.from, m.to, me);
      streak = Flat.outcomeAfterMove(board, after, me, streak).streak;
      board = after;
      me = 3 - me;
    }
  }
  return found;
}

const sq = (i: number) => `${'abcdefghijklmnopqrst'[i % 20]}${20 - Math.floor(i / 20)}`;
let failures = 0;

console.log(`budget ${BUDGET_MS} ms, batch ${BATCH}`);
console.log('1. wins on the spot, found by the tree search alone');
// Some wins are too rare (1 move in hundreds) for a short CPU search to reach,
// so only finding none of them fails; a sign error would find none.
const winPositions = findPositions(6, ms => ms.some(m => m.result === 1));
let found = 0;
for (const p of winPositions) {
  const wins = p.moves.filter(m => m.result === 1).length;
  const r = (await new Mcts(evaluate).search(p.board, p.me, p.streak,
    { budgetMs: BUDGET_MS, batchSize: BATCH, takeImmediateWins: false }))!;
  const played = p.moves.find(m => m.from === r.from && m.to === r.to)!;
  if (played.result === 1) found++;
  console.log(`  ${played.result === 1 ? 'won ' : 'miss'} ${sq(r.from)}-${sq(r.to)} (${wins}/${p.moves.length} moves win) ` +
    `value ${r.value.toFixed(2)}, ${r.evaluations} evals in ${r.elapsedMs.toFixed(0)} ms`);
}
if (found < winPositions.length / 2) { failures++; console.log(`  FAIL: found only ${found}`); }

console.log('1b. wins on the spot, with the shortcut');
for (const p of winPositions) {
  const r = (await new Mcts(evaluate).search(p.board, p.me, p.streak, { budgetMs: BUDGET_MS, batchSize: BATCH }))!;
  const played = p.moves.find(m => m.from === r.from && m.to === r.to)!;
  if (played.result !== 1) { failures++; console.log(`  FAIL ${sq(r.from)}-${sq(r.to)}`); }
}
console.log('  done');

console.log('2. avoids losing on the spot');
for (const p of findPositions(6, ms => {
  const losing = ms.filter(m => m.result === -1).length;
  return losing > ms.length * 0.2 && !ms.some(m => m.result === 1);
})) {
  const losing = p.moves.filter(m => m.result === -1).length;
  const r = (await new Mcts(evaluate).search(p.board, p.me, p.streak, { budgetMs: BUDGET_MS, batchSize: BATCH }))!;
  const played = p.moves.find(m => m.from === r.from && m.to === r.to)!;
  const ok = played.result !== -1;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${sq(r.from)}-${sq(r.to)} (${losing}/${p.moves.length} moves lose) ` +
    `value ${r.value.toFixed(2)}, ${r.evaluations} evals`);
}

console.log('3. tree reuse');
{
  const mcts = new Mcts(evaluate);
  let board = Flat.toFlat(Engine.makeBoard());
  let me = Flat.BLACK, streak = 0;
  for (let ply = 0; ply < 4; ply++) {
    const r = (await mcts.search(board, me, streak, { budgetMs: BUDGET_MS, batchSize: BATCH }))!;
    const reused = r.rootVisits - r.evaluations;
    console.log(`  ply ${ply}: ${sq(r.from)}-${sq(r.to)}, root visits ${r.rootVisits} (${reused} carried over)`);
    if (ply > 0 && reused <= 0) { failures++; console.log('  FAIL: nothing reused'); }
    const after = Flat.applyMove(board, r.from, r.to, me);
    streak = Flat.outcomeAfterMove(board, after, me, streak).streak;
    board = after;
    me = 3 - me;
  }
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
