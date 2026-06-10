// Decisive test: best_move on the move-28 position with the EAGER path (tt=0) vs
// the LAZY+TT path (tt=1), across the repro budget window. If eager never plays
// f3-e4/f3-e3 (because it scores them as proven losses at depth 2 and prunes
// them) while lazy does, the bug is the lazy/TT path's loose fail-low scoring,
// not the abort selection or the reductions.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const COLS = 'abcdefghijklmnopqrst';
const sq = (r, c) => `${COLS[c]}${20 - r}`;
const toRC = s => ({ col: COLS.indexOf(s[0]), row: 20 - parseInt(s.slice(1), 10) });
const pm = s => { const [f, t] = s.split('-'); return { from: toRC(f), to: toRC(t) }; };
const GAME = [
  ['d2-e2','d17-e17'],['s6-p9','j15-g12'],['r3-r13','p18-p15'],['i8-i6','s18-p18'],
  ['r13-r14','i18-i6'],['m7-k7','h6-i7'],['l4-m4','i6-j5'],['d4-e4','j6-n6'],
  ['j2-j3','j9-i8'],['j3-j6','o6-l6'],['m3-n3','l6-l5'],['j7-j6','l5-k4'],
  ['n3-l3','h8-h7'],['q4-o4','h18-g19'],['n9-o10','e18-k12'],['e7-g7','k12-g12'],
  ['g3-i3','g12-n5'],['r14-r17','n5-m4'],['i6-l6','n4-m4'],['r16-q17','m4-m3'],
  ['m7-m4','l18-i18'],['q18-p18','m16-n17'],['m4-m3','n19-o18'],['p10-p13','n14-o15'],
  ['r18-q18','b19-b16'],['l1-o4','c15-c12'],['i3-f3','b12-f8'],
];
let board = E.makeBoard();
for (const [b, w] of GAME) { let m = pm(b); board = E.applyMove(board, m.from, m.to, 'black'); m = pm(w); board = E.applyMove(board, m.from, m.to, 'white'); }
const flat = new Int8Array(400);
for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = board[r][c]; flat[r*20+c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; }

const bytes = readFileSync(WASM);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
x.set_nullmove(1); x.set_lmr(1); // production defaults

function run(tt, budget) {
  new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);
  x.best_move(0, budget, tt, 0, 1);
  const o = new Int32Array(memory.buffer, x.out_ptr(), 32);
  return { mv: `${sq(o[1], o[2])}-${sq(o[3], o[4])}`, depth: o[5], score: o[6], nRoot: o[8] };
}

for (const tt of [0, 1]) {
  const label = tt ? 'LAZY+TT (tt=1, production)' : 'EAGER (tt=0)';
  const counts = {}; let blunders = 0, n = 0;
  const depths = new Set(), roots = new Set();
  for (let budget = 2500; budget <= 6000; budget += 250) {
    for (let rep = 0; rep < 2; rep++) {
      const r = run(tt, budget);
      counts[r.mv] = (counts[r.mv] || 0) + 1; n++;
      depths.add(r.depth); roots.add(r.nRoot);
      if (r.mv.startsWith('f3-') || r.mv.startsWith('f4-')) blunders++;
    }
  }
  console.log(`\n${label}`);
  console.log('  picks:', counts);
  console.log('  depths reached:', [...depths].sort((a,b)=>a-b), '| final nRoot values:', [...roots].sort((a,b)=>a-b));
  console.log(`  ring-hanging blunders (f3-*/f4-*): ${blunders}/${n}`);
}
