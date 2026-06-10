// Sanity perf check after the phase-2 full-window re-search fix: confirm the
// opening still reaches its expected depth at standard budgets (memory baseline:
// opening hits depth 5 at 2s with null-move + LMR). Reports depth + time. The
// fix's extra work is a full-window re-search of the few moves tied at best_score,
// over a TT already warmed by phase 1 — expected to be cheap.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const COLS = 'abcdefghijklmnopqrst';
const sq = (r, c) => `${COLS[c]}${20 - r}`;

const bytes = readFileSync(WASM);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
x.set_nullmove(1); x.set_lmr(1);

function flatOf(board) {
  const f = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = board[r][c]; f[r*20+c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; }
  return f;
}
function bm(flat, white, budget) {
  new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);
  x.best_move(white, budget, 1, 0, 1);
  const o = new Int32Array(memory.buffer, x.out_ptr(), 16);
  return { mv: `${sq(o[1],o[2])}-${sq(o[3],o[4])}`, depth: o[5], score: o[6], ms: o[7], nRoot: o[8] };
}

const opening = flatOf(E.makeBoard());
console.log('Opening position, black to move:');
for (const budget of [500, 2000, 15000]) {
  const r = bm(opening, 0, budget);
  console.log(`  budget ${String(budget).padStart(5)}ms -> ${r.mv.padEnd(8)} depth ${r.depth}  (${r.ms}ms, nRoot ${r.nRoot})`);
}
console.log('\n(memory baseline: opening reaches depth 5 at 2s with null-move + LMR)');
