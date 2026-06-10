// Why does production score f3-e4 as ~-17 instead of the exact mate-in-2 loss?
// Probe each root move's fixed-depth phase-1 score under the exact search vs. the
// speculative reductions (null-move, LMR) to find which one hides white's g8-g6
// refutation of f3-e4.
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
const write = () => new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);

// search_root(white,depth,tt): OUT[0]=bestScore, OUT[1]=n, then 5 i32/move.
function scoreOf(target, depth, tt, nm, lmr) {
  x.set_nullmove(nm); x.set_lmr(lmr);
  write();
  x.search_root(0 /*black*/, depth, tt);
  const o = new Int32Array(memory.buffer, x.out_ptr(), 65536);
  const best = o[0], n = o[1];
  let k = 2, found = null;
  for (let i = 0; i < n; i++, k += 5) {
    if (`${sq(o[k], o[k+1])}-${sq(o[k+2], o[k+3])}` === target) found = o[k+4];
  }
  return { best, score: found };
}

for (const mv of ['f3-e4', 'l7-i7']) {
  console.log(`\n=== ${mv} score by depth ===`);
  console.log('depth | exact(tt0) | tt1 null+lmr | null-only | lmr-only | none(tt1)');
  for (let d = 2; d <= 7; d++) {
    const exact = scoreOf(mv, d, 0, 0, 0).score;
    const prod  = scoreOf(mv, d, 1, 1, 1).score;
    const nullO = scoreOf(mv, d, 1, 1, 0).score;
    const lmrO  = scoreOf(mv, d, 1, 0, 1).score;
    const none  = scoreOf(mv, d, 1, 0, 0).score;
    const f = v => String(v).padStart(10);
    console.log(`  d${d}  |${f(exact)} |${f(prod).padStart(13)} |${f(nullO)} |${f(lmrO)} |${f(none)}`);
  }
}
