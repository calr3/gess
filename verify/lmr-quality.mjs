// Move-quality check for null-move + LMR together: across many positions/depths,
// does the speculative search (both ON) pick the same root move as the EXACT
// search (both OFF) — and if not, is the pick actually worse by exact scores?
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

function searchRoot(board, depth, spec) {
  x.set_nullmove(spec); x.set_lmr(spec);
  write(board);
  const n = x.search_root(0, depth, 1);
  const o = new Int32Array(memory.buffer, op, 2 + n * 5);
  const scores = new Map();
  for (let i = 0, k = 2; i < n; i++, k += 5) scores.set(`${o[k]},${o[k + 1]},${o[k + 2]},${o[k + 3]}`, o[k + 4]);
  return { bestScore: o[0], n, bestKey: `${o[2]},${o[3]},${o[4]},${o[5]}`, scores };
}

let rng = 0x1234567 >>> 0;
const rnd = () => { rng = (Math.imul(rng ^ (rng >>> 15), 1 | rng) + 0x6d2b79f5) | 0; return ((rng >>> 0) % 1000) / 1000; };
function randPos() {
  const b = blank(); const spots = [];
  const far = (r, c) => spots.every(([R, C]) => Math.abs(R - r) + Math.abs(C - c) >= 4);
  let t = 0; while (spots.length < 4 && t++ < 200) { const r = 3 + Math.floor(rnd() * 14), c = 3 + Math.floor(rnd() * 14); if (far(r, c)) spots.push([r, c]); }
  ring(b, ...spots[0], 'white'); ring(b, ...spots[1], 'white'); ring(b, ...spots[2], 'black'); ring(b, ...spots[3], 'black');
  for (let i = 0; i < 6; i++) { const r = 2 + Math.floor(rnd() * 16), c = 2 + Math.floor(rnd() * 16); if (!b[r][c]) b[r][c] = i % 2 ? 'white' : 'black'; }
  return b;
}
function mid() { const b = blank(); ring(b, 13, 6, 'black'); ring(b, 14, 13, 'black'); ring(b, 6, 6, 'white'); ring(b, 5, 13, 'white'); for (const [r, c] of [[10, 4], [10, 9], [11, 15], [9, 11], [13, 10]]) b[r][c] = 'black'; for (const [r, c] of [[9, 5], [8, 10], [10, 14], [7, 8], [6, 11]]) b[r][c] = 'white'; return b; }
function sparse() { const b = blank(); ring(b, 4, 4, 'white'); ring(b, 7, 12, 'white'); ring(b, 15, 5, 'black'); ring(b, 12, 14, 'black'); for (const [r, c] of [[3, 9], [6, 7], [9, 4], [8, 16]]) b[r][c] = 'white'; for (const [r, c] of [[16, 10], [13, 8], [11, 5], [14, 16]]) b[r][c] = 'black'; return b; }
function endgame() { const b = blank(); ring(b, 10, 4, 'black'); ring(b, 9, 15, 'white'); for (const [r, c] of [[12, 7], [8, 6], [14, 12]]) b[r][c] = 'black'; for (const [r, c] of [[7, 12], [11, 13], [6, 9]]) b[r][c] = 'white'; return b; }

// (name, board, depths)
const SUITE = [['opening', Engine.makeBoard(), [3, 4]]];
for (let i = 0; i < 12; i++) SUITE.push([`rand${i}`, randPos(), [3, 4]]);
SUITE.push(['midgame', mid(), [5]], ['sparse', sparse(), [5]], ['endgame', endgame(), [6]]);

let total = 0, match = 0, worst = 0, costly = 0;
for (const [name, board, depths] of SUITE) {
  write(board); x.analyze(); const a = new Int32Array(memory.buffer, op, 8);
  if (a[0] === 0 || a[1] === 0) continue;
  for (const depth of depths) {
    const ex = searchRoot(board, depth, 0), sp = searchRoot(board, depth, 1);
    if (ex.n === 0) continue;
    total++;
    if (ex.bestKey === sp.bestKey) { match++; continue; }
    const exOfSp = ex.scores.get(sp.bestKey);
    const gap = (exOfSp === undefined) ? 0 : ex.bestScore - exOfSp;
    if (gap > 0) { costly++; worst = Math.max(worst, gap); console.log(`  ${name} d${depth}: differs, exact gap=${gap} (exactBest=${ex.bestScore}, specPickExact=${exOfSp})`); }
  }
}
console.log(`\npositions×depths: ${total} | same move: ${match} (${(100 * match / total).toFixed(0)}%) | costly diffs: ${costly} | worst exact gap: ${worst}`);
console.log(worst === 0 ? 'RESULT: PASS (null+LMR never picked a move the exact search scored worse)' : `RESULT: review — worst gap ${worst} (stone≈100, ring≈700)`);
