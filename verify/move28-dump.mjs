// Dump best_move's full OUT buffer on the move-28 position (black, 15s) to show
// the exact move pool the engine ends with: per-depth best+score, the final root
// size (nRoot), and the terminal scored list the random pick draws from.
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

// Replay to the position before black's move 28 (same as investigate-move28.mjs).
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
for (const [b, w] of GAME) {
  let m = pm(b); board = E.applyMove(board, m.from, m.to, 'black');
  m = pm(w); board = E.applyMove(board, m.from, m.to, 'white');
}

const bytes = readFileSync(WASM);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const flat = new Int8Array(400);
for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
  const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
}
new Int8Array(memory.buffer, x.board_ptr(), 400).set(flat);
x.best_move(0, 15000, 1, 0, 1);
const o = new Int32Array(memory.buffer, x.out_ptr(), 65536);

const chosen = `${sq(o[1], o[2])}-${sq(o[3], o[4])}`;
console.log(`chosen=${chosen}  depth=${o[5]}  score=${o[6]}  totalMs=${o[7]}  nRoot(final)=${o[8]}  nDepth=${o[9]}`);
let k = 10;
console.log('\nper completed depth (depth: bestMove score):');
for (let i = 0; i < o[9]; i++, k += 8) {
  console.log(`  d${o[k]}: ${sq(o[k+3],o[k+4])}-${sq(o[k+5],o[k+6])}  score=${o[k+7]}  (${o[k+1]}ms)`);
}
const nScored = o[k]; k += 1;
const LOSS = -(1_000_000 - 64);
console.log(`\nterminal scored move pool (${nScored} moves — what the random tie-break draws from):`);
for (let i = 0; i < nScored; i++, k += 7) {
  const mv = `${sq(o[k],o[k+1])}-${sq(o[k+2],o[k+3])}`;
  const score = o[k+4], exact = o[k+5] === 1;
  console.log(`  ${mv.padEnd(8)} score=${String(score).padStart(8)} ${exact ? 'exact' : 'bound'} ${score <= LOSS ? '  <-- proven loss' : ''}${mv === chosen ? '  <== CHOSEN' : ''}`);
}
console.log(`\nf3-e4 present in terminal pool? ${[...Array(nScored)].some((_, i) => `${sq(o[11+o[9]*8+1+i*7],o[11+o[9]*8+1+i*7+1])}-${sq(o[11+o[9]*8+1+i*7+2],o[11+o[9]*8+1+i*7+3])}` === 'f3-e4')}`);
