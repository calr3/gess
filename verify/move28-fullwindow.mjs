// Confirm the fix direction: the lazy+TT search DOES find white's g8-g6 mate
// after black f3-e4 when given a FULL window (as the first root move in
// search_root gets: alpha=NEG_INF ⇒ window (NEG_INF, +INF)). If white's bestScore
// is a proven win at shallow depth, then a full-window (PV) re-search of f3-e4
// would resolve it to the true mate and exclude it from the tied-best set.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const COLS = 'abcdefghijklmnopqrst';
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
// Apply black's f3-e4; now white to move and should have the g8-g6 ring kill.
const m28 = pm('f3-e4');
board = E.applyMove(board, m28.from, m28.to, 'black');
console.log('after f3-e4: black rings =', E.countRings(board, 'black'), 'white rings =', E.countRings(board, 'white'));
const flat = new Int8Array(400);
for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = board[r][c]; flat[r*20+c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; }

const bytes = readFileSync(WASM);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const WIN_T = 1_000_000 - 64;

for (const [nm, lmr] of [[1,1],[0,0]]) {
  x.set_nullmove(nm); x.set_lmr(lmr);
  console.log(`\nwhite-to-move search (null=${nm} lmr=${lmr}); bestScore >= ${WIN_T} ⇒ white has a proven mate:`);
  for (let d = 1; d <= 5; d++) {
    for (const tt of [1, 0]) {
      new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);
      x.search_root(1 /*white*/, d, tt);
      const o = new Int32Array(memory.buffer, x.out_ptr(), 4);
      const best = o[0];
      console.log(`  d${d} tt=${tt}: white bestScore=${best}${best >= WIN_T ? '  <-- PROVEN WIN (finds g8-g6)' : ''}`);
    }
  }
}
