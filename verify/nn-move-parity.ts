// End-to-end check of the neural engine's plumbing, without a browser:
// builds the observation with the app's encoder, runs the exported ONNX model
// through onnxruntime-web's WebAssembly backend (which also works in Node), and
// compares against the scores the training environment produced for the same
// positions.
//
//   ~/node22/bin/node --experimental-strip-types verify/nn-move-parity.ts

import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-web';
import { buildObservation, OBS_PLANES, OBS_SIZE } from '../src/app/services/gess-nn-obs.ts';
import type { Board, Cell, Player } from '../src/app/models/game.model.ts';

interface Case {
  board: string[]; player: Player; stage: number; source: [number, number] | null; streak: number;
  obs: number[]; logits: number[]; value: number; legal: number[];
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL('./nn-reference.json', import.meta.url), 'utf8'),
);
const modelPath = new URL('../public/models/gess-policy.onnx', import.meta.url);
const session = await ort.InferenceSession.create(readFileSync(modelPath), {
  executionProviders: ['wasm'],
});

const parseBoard = (rows: string[]): Board =>
  rows.map(row => [...row].map((ch): Cell => (ch === 'w' ? 'white' : ch === 'b' ? 'black' : null)));

const bestLegal = (scores: ArrayLike<number>, legal: number[]) =>
  legal.reduce((best, a) => (scores[a] > scores[best] ? a : best), legal[0]);

let worstLogit = 0, worstValue = 0, agree = 0;
for (const c of cases) {
  const selected = c.source ? { row: c.source[0], col: c.source[1] } : null;
  const obs = buildObservation(parseBoard(c.board), c.player, selected, c.streak);
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', obs, [1, OBS_SIZE, OBS_SIZE, OBS_PLANES]),
  });
  const tensors = session.outputNames.map(n => out[n]);
  const logits = tensors.find(t => t.size === 400)!.data as Float32Array;
  const value = (tensors.find(t => t.size === 1)!.data as Float32Array)[0];

  for (let i = 0; i < 400; i++) worstLogit = Math.max(worstLogit, Math.abs(logits[i] - c.logits[i]));
  worstValue = Math.max(worstValue, Math.abs(value - c.value));
  if (bestLegal(logits, c.legal) === bestLegal(c.logits, c.legal)) agree++;
}
const scale = Math.max(...cases.flatMap(c => c.logits.map(Math.abs)));
console.log(
  `move parity: ${cases.length} positions | max score diff ${worstLogit.toFixed(4)} ` +
    `(scale ${scale.toFixed(1)}) | max value diff ${worstValue.toExponential(2)} | ` +
    `same chosen square ${agree}/${cases.length}`,
);
