// Move-quality check for null-move pruning: across many positions/depths, does
// null-move's chosen root move agree with the EXACT search — and when it differs,
// is the pick actually worse (by the exact search's own per-move scores)?
// search_root is the deterministic fixed-depth phase-1 (no random, no reorder).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __d = dirname(fileURLToPath(import.meta.url));
const W = join(__d, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(W), { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const bp = x.board_ptr(), op = x.out_ptr();
const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, bp, 400).set(f); };
const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
const ring = (b, cr, cc, p) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) b[cr + dr][cc + dc] = p; };

// search_root → { best:{move,score}, scores: Map(moveKey→score) }, deterministic.
function searchRoot(board, depth, nm) {
  x.set_nullmove(nm);
  write(board);
  const n = x.search_root(0, depth, 1); // black, tt on
  const o = new Int32Array(memory.buffer, op, 2 + n * 5);
  const scores = new Map();
  for (let i = 0, k = 2; i < n; i++, k += 5) scores.set(`${o[k]},${o[k + 1]},${o[k + 2]},${o[k + 3]}`, o[k + 4]);
  // search_root returns moves best-first; moves[0] is the chosen move.
  const bk = `${o[2]},${o[3]},${o[4]},${o[5]}`;
  return { bestScore: o[0], n, bestKey: bk, scores };
}

let rng = 0x1234567 >>> 0;
const rnd = () => { rng = (Math.imul(rng ^ (rng >>> 15), 1 | rng) + 0x6d2b79f5) | 0; return ((rng >>> 0) % 1000) / 1000; };
function randPos() {
  const b = blank();
  const spots = [];
  const far = (r, c) => spots.every(([R, C]) => Math.abs(R - r) + Math.abs(C - c) >= 4);
  let tries = 0;
  while (spots.length < 4 && tries++ < 200) { const r = 3 + Math.floor(rnd() * 14), c = 3 + Math.floor(rnd() * 14); if (far(r, c)) spots.push([r, c]); }
  ring(b, ...spots[0], 'white'); ring(b, ...spots[1], 'white');
  ring(b, ...spots[2], 'black'); ring(b, ...spots[3], 'black');
  for (let i = 0; i < 6; i++) { const r = 2 + Math.floor(rnd() * 16), c = 2 + Math.floor(rnd() * 16); if (!b[r][c]) b[r][c] = i % 2 ? 'white' : 'black'; }
  return b;
}

const crafted = [
  ['opening', Engine.makeBoard()],
];
for (let i = 0; i < 12; i++) crafted.push([`rand${i}`, randPos()]);

let total = 0, match = 0, worstBlunder = 0, blunders = 0;
for (const [name, board] of crafted) {
  // skip degenerate (a side already ringless)
  write(board); x.analyze(); const a = new Int32Array(memory.buffer, op, 8);
  if (a[0] === 0 || a[1] === 0) continue;
  for (const depth of [3, 4]) {
    const ex = searchRoot(board, depth, 0); // exact
    const nm = searchRoot(board, depth, 1); // null-move
    if (ex.n === 0) continue;
    total++;
    const same = ex.bestKey === nm.bestKey;
    if (same) { match++; continue; }
    // null picked a different move — its value by the EXACT search:
    const exScoreOfNullPick = ex.scores.get(nm.bestKey);
    const gap = (exScoreOfNullPick === undefined) ? 0 : ex.bestScore - exScoreOfNullPick;
    if (gap > 0) { blunders++; worstBlunder = Math.max(worstBlunder, gap); console.log(`  ${name} d${depth}: null pick differs, exact gap = ${gap} (exactBest=${ex.bestScore}, nullPickExact=${exScoreOfNullPick})`); }
  }
}
console.log(`\npositions×depths: ${total} | same move: ${match} (${(100 * match / total).toFixed(0)}%) | costly differences: ${blunders} | worst exact-score gap: ${worstBlunder}`);
console.log(worstBlunder === 0 ? 'RESULT: PASS (null-move never picked a move the exact search scored worse)' : `RESULT: review — worst gap ${worstBlunder} (a stone ≈ 100, ring ≈ 700)`);
