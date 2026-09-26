// Checks that the TypeScript observation encoder matches the one the network
// was trained with. `nn-reference.json` holds positions exported from the
// training environment (pgx gess) together with the observation it produced.
//
//   ~/node22/bin/node --experimental-strip-types verify/nn-obs-parity.ts
//
// Regenerate the reference with verify/dump_nn_reference.py.

import { readFileSync } from 'node:fs';
import { buildObservation, OBS_LENGTH } from '../src/app/services/gess-nn-obs.ts';
import type { Board, Cell, Player } from '../src/app/models/game.model.ts';

interface Case {
  board: string[];
  player: Player;
  stage: number;
  source: [number, number] | null;
  streak: number;
  obs: number[];
  logits: number[];
  value: number;
  legal: number[];
}

const cases: Case[] = JSON.parse(
  readFileSync(new URL('./nn-reference.json', import.meta.url), 'utf8'),
);

function parseBoard(rows: string[]): Board {
  return rows.map((row) =>
    [...row].map((ch): Cell => (ch === 'w' ? 'white' : ch === 'b' ? 'black' : null)),
  );
}

let worst = 0;
for (const [i, c] of cases.entries()) {
  const selected = c.source ? { row: c.source[0], col: c.source[1] } : null;
  const obs = buildObservation(parseBoard(c.board), c.player, selected, c.streak);
  if (obs.length !== OBS_LENGTH || c.obs.length !== OBS_LENGTH) {
    throw new Error(`case ${i}: length ${obs.length} vs ${c.obs.length}`);
  }
  let diff = 0;
  // pgx's observation is float32; the JSON holds it as decimals (0.05 for the
  // float32 nearest 0.05), so compare at float32 precision.
  for (let j = 0; j < OBS_LENGTH; j++) diff = Math.max(diff, Math.abs(obs[j] - Math.fround(c.obs[j])));
  if (diff > 0) {
    const at = [...c.obs].findIndex((v, j) => Math.abs(Math.fround(v) - obs[j]) > 0);
    throw new Error(
      `case ${i} (${c.player}, stage ${c.stage}): first mismatch at index ${at}, ` +
        `plane ${at % 6}, expected ${c.obs[at]}, got ${obs[at]}`,
    );
  }
  worst = Math.max(worst, diff);
}
console.log(
  `observation parity OK: ${cases.length} positions ` +
    `(stages ${[...new Set(cases.map((c) => c.stage))].sort().join(', ')}), max diff ${worst}`,
);
