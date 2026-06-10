// Investigate the reported blunder: black's 28. f3-e4 losing instantly to
// white's g8-g6. Replays the game through the (exact) TS move logic to get the
// position before black's move 28, classifies every legal black move by whether
// it loses immediately (white mate-in-1), and runs both the exact TS oracle and
// the production WASM engine on the position.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');

const COLS = 'abcdefghijklmnopqrst';
const sq = (r, c) => `${COLS[c]}${20 - r}`;
const toRC = (s) => ({ col: COLS.indexOf(s[0]), row: 20 - parseInt(s.slice(1), 10) });

// ── The game (black, white) per numbered turn; suffixes are capture markers. ──
const GAME = [
  ['d2-e2', 'd17-e17'], ['s6-p9', 'j15-g12'], ['r3-r13', 'p18-p15'], ['i8-i6', 's18-p18'],
  ['r13-r14', 'i18-i6'], ['m7-k7', 'h6-i7'], ['l4-m4', 'i6-j5'], ['d4-e4', 'j6-n6'],
  ['j2-j3', 'j9-i8'], ['j3-j6', 'o6-l6'], ['m3-n3', 'l6-l5'], ['j7-j6', 'l5-k4'],
  ['n3-l3', 'h8-h7'], ['q4-o4', 'h18-g19'], ['n9-o10', 'e18-k12'], ['e7-g7', 'k12-g12'],
  ['g3-i3', 'g12-n5'], ['r14-r17', 'n5-m4'], ['i6-l6', 'n4-m4'], ['r16-q17', 'm4-m3'],
  ['m7-m4', 'l18-i18'], ['q18-p18', 'm16-n17'], ['m4-m3', 'n19-o18'], ['p10-p13', 'n14-o15'],
  ['r18-q18', 'b19-b16'], ['l1-o4', 'c15-c12'], ['i3-f3', 'b12-f8'],
  // move 28: black f3-e4 (the move under investigation), white g8-g6 (#)
];

function parseMove(s) {
  const [from, to] = s.split('-');
  return { from: toRC(from), to: toRC(to) };
}

// ── Replay, validating each ply against the engine's own move generator. ──────
let board = E.makeBoard();
let ply = 0;
const warnings = [];
function applyPly(player, mvStr) {
  ply++;
  const { from, to } = parseMove(mvStr);
  const okCenter = E.isValidFootprintCenter(from.row, from.col, board, player);
  const legal = okCenter && E.getValidMoves(board, from, player).some(m => m.row === to.row && m.col === to.col);
  if (!legal) warnings.push(`ply ${ply} (${player} ${mvStr}): not a legal move in replay (center ok=${okCenter})`);
  board = E.applyMove(board, from, to, player);
}

for (const [b, w] of GAME) { applyPly('black', b); applyPly('white', w); }

// Now `board` is the position before black's move 28.
const P = board;
console.log('Replayed', ply, 'plies. Warnings:', warnings.length);
for (const w of warnings) console.log('  ⚠', w);

const bR = E.countRings(P, 'black'), wR = E.countRings(P, 'white');
const bS = E.countStones(P, 'black'), wS = E.countStones(P, 'white');
console.log(`\nPosition before black's move 28:`);
console.log(`  black: ${bR} ring(s), ${bS} stones`);
console.log(`  white: ${wR} ring(s), ${wS} stones`);
console.log('  board (B=black W=white):');
console.log(P.map(row => '   ' + row.map(c => c === 'black' ? 'B' : c === 'white' ? 'W' : '.').join('')).join('\n'));

// ── Verify the reported finish: f3-e4 then white g8-g6 should leave black 0 rings.
const m28 = parseMove('f3-e4');
const afterBlack28 = E.applyMove(P, m28.from, m28.to, 'black');
console.log(`\nAfter black f3-e4: black rings = ${E.countRings(afterBlack28, 'black')}, white rings = ${E.countRings(afterBlack28, 'white')}`);
const wMate = parseMove('g8-g6');
const afterWhite = E.applyMove(afterBlack28, wMate.from, wMate.to, 'white');
console.log(`After white g8-g6:  black rings = ${E.countRings(afterWhite, 'black')}  (0 ⇒ white wins, matches "#")`);

// ── Classify EVERY legal black move: does it lose immediately to a white mate-in-1?
const root = E.debugGenRoot(P, 'black');     // engine's own root move list
console.log(`\nBlack has ${root.length} legal root moves. Classifying by immediate outcome…`);

const survivors = [], losers = [], winners = [];
for (const m of root) {
  const from = { row: m.fromR, col: m.fromC }, to = { row: m.toR, col: m.toC };
  const label = `${sq(m.fromR, m.fromC)}-${sq(m.toR, m.toC)}`;
  if (m.outcome === 1) { winners.push(label); continue; }            // black wins outright
  if (m.outcome === -1) { losers.push(label + ' (suicides own last ring)'); continue; }
  const nb = E.applyMove(P, from, to, 'black');
  // White mate-in-1 if any white reply leaves black with 0 rings.
  const wMoves = E.debugGenRoot(nb, 'white');
  const mated = wMoves.some(wm => wm.outcome === 1);
  (mated ? losers : survivors).push(label);
}
console.log(`  immediate WINS for black: ${winners.length}`, winners.slice(0, 10));
console.log(`  LOSE to a white mate-in-1: ${losers.length}`);
console.log(`  SURVIVE the next ply (no white mate-in-1): ${survivors.length}`);
console.log('   survivors (first 25):', survivors.slice(0, 25));

const f3e4Class =
  winners.includes('f3-e4') ? 'WIN' :
  survivors.includes('f3-e4') ? 'SURVIVES' :
  (losers.find(l => l.startsWith('f3-e4')) ? 'LOSES-to-mate-in-1' : 'NOT-IN-ROOT');
console.log(`\n>>> f3-e4 classification: ${f3e4Class}`);

// ── Exact TS oracle: per-move scores at increasing depth. ─────────────────────
function oracleReport(depth) {
  const { bestScore, moves } = E.debugSearchRoot(P, 'black', depth);
  const named = moves.map(m => ({ mv: `${sq(m.fromR, m.fromC)}-${sq(m.toR, m.toC)}`, score: m.score }));
  named.sort((a, b) => b.score - a.score);
  const f = named.find(m => m.mv === 'f3-e4');
  console.log(`\n[TS oracle d${depth}] bestScore=${bestScore}  f3-e4 score=${f ? f.score : 'n/a'}`);
  console.log('  top 6:', named.slice(0, 6).map(m => `${m.mv}=${m.score}`).join('  '));
  console.log('  bottom 3:', named.slice(-3).map(m => `${m.mv}=${m.score}`).join('  '));
}
for (const d of [1, 2, 3]) oracleReport(d);

// ── Production WASM engine: what does it actually pick now? ────────────────────
const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const wasm = instance.exports;
const BOARD_PTR = wasm.board_ptr(), OUT_PTR = wasm.out_ptr();
function writeBoard(b) {
  const flat = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
    const v = b[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
  }
  new Int8Array(memory.buffer, BOARD_PTR, 400).set(flat);
}
function wasmBest(budgetMs) {
  writeBoard(P);
  const found = wasm.best_move(0 /*black*/, budgetMs, 1 /*TT*/, 0, 1 /*bumpGen*/);
  if (!found) return null;
  const out = new Int32Array(memory.buffer, OUT_PTR, 64);
  return { mv: `${sq(out[1], out[2])}-${sq(out[3], out[4])}`, depth: out[5], score: out[6], ms: out[7], root: out[8] };
}
for (const budget of [2000, 15000]) {
  const r = wasmBest(budget);
  console.log(`\n[WASM best_move ${budget}ms] -> ${r.mv}  depth=${r.depth} score=${r.score} (${r.ms}ms, ${r.root} root moves)`);
}
