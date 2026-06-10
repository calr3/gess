// Reproduce the move-28 blunder: sweep time budgets to catch a run where depth 8
// aborts after refuting only the first root move, so choose_on_abort prefers an
// unsearched (but actually losing) tied alternative like f3-e4.
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

const SURVIVE_SCORE = -(1_000_000 - 64);   // > this == not a proven loss
let bugCount = 0, total = 0;
const counts = {};
for (let budget = 800; budget <= 7000; budget += 150) {
  for (let rep = 0; rep < 3; rep++) {
    new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);
    x.best_move(0, budget, 1, 0, 1);
    const o = new Int32Array(memory.buffer, x.out_ptr(), 32);
    const mv = `${sq(o[1], o[2])}-${sq(o[3], o[4])}`;
    const depth = o[5], lastBest = o[6];
    counts[mv] = (counts[mv] || 0) + 1;
    total++;
    // The blunder signature: a move that hangs the ring fast (f3-e4 / f3-e3),
    // i.e. NOT one of the longest-defence moves (l7-i7 / l2-i5).
    const isBlunder = mv === 'f3-e4' || mv === 'f3-e3' || mv === 'f4-e4';
    if (isBlunder) {
      bugCount++;
      console.log(`  >>> BLUNDER reproduced: budget=${budget}ms rep=${rep} -> ${mv} depth=${depth} lastBest=${lastBest}`);
    }
  }
}
console.log(`\nchosen-move distribution over ${total} runs:`, counts);
console.log(`blunder picks (f3-*/f4-*): ${bugCount}/${total}`);
