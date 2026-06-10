// Verify the root-level proven-loss pruning in best_move:
//  (1) some moves are forced losses, others aren't → losses get dropped from the
//      root (final root size < full legal count) and a non-loss move is chosen;
//  (2) every move loses → it still returns a move, with a mate-loss score (the
//      longest-delaying loss). best_move's OUT[8] is the (post-prune) root size.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(WASM_PATH), {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
});
const wasm = instance.exports;
const BOARD_PTR = wasm.board_ptr(), OUT_PTR = wasm.out_ptr();
const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, BOARD_PTR, 400).set(f); };
const out = (n) => new Int32Array(memory.buffer, OUT_PTR, n);
const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
const ring = (b, cr, cc, p) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) b[cr + dr][cc + dc] = p; };

const WIN = 1000000, MAXD = 64, THRESH = -(WIN - MAXD); // mate-loss range: score <= THRESH

function run(name, board, budget = 800) {
  write(board);
  const N = wasm.gen_root(0); // full legal black move count
  write(board);
  wasm.best_move(0, budget, 1, 0, 1); // black, tt on, tid 0, standalone (bump gen)
  const o = out(10);
  console.log(`${name}\n  found=${o[0]} depth=${o[5]} score=${o[6]} | genRoot=${N} finalRoot=${o[8]} pruned=${N - o[8]}`);
  return { found: o[0], depth: o[5], score: o[6], N, nRoot: o[8] };
}

// (1) Black: one ring (10,10) + loose stones; White: one ring far at (10,17) + loose,
//     out of black's 1-move reach (no black stone has a centre stone → ≤3 range).
//     Footprints that take part of black's lone ring destroy it → forced losses.
let b = blank();
ring(b, 10, 10, 'black');
for (const [r, c] of [[5, 5], [5, 7], [15, 4], [15, 6]]) b[r][c] = 'black';
ring(b, 10, 17, 'white');
for (const [r, c] of [[3, 12], [16, 12]]) b[r][c] = 'white';
const r1 = run('(1) partial: black 1 ring + loose, white ring out of reach', b);

// (2) Black has NO ring (scattered, can't form one in a move); White has a ring.
let b2 = blank();
for (const [r, c] of [[5, 5], [5, 7], [7, 9], [12, 4], [14, 14]]) b2[r][c] = 'black';
ring(b2, 10, 10, 'white');
const r2 = run('(2) all-loss: black has no ring', b2);

let pass = true;
const chk = (c, m) => { if (!c) { pass = false; console.log('  FAIL: ' + m); } };
chk(r1.found === 1 && r1.score > THRESH, '(1) should choose a non-loss move');
chk(r1.nRoot < r1.N, '(1) proven-loss moves should be pruned from the root');
chk(r2.found === 1 && r2.score <= THRESH, '(2) all-loss: should return a move with a mate-loss score');
console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(pass ? 0 : 1);
