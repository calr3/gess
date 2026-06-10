// Quick speed comparison: TS reference search vs Rust/WASM, fixed depth, same
// positions. Measures the deterministic phase-1 search (search_root) so both do
// identical work. Reports wall time and the WASM speedup.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {
  env: { now: () => Date.now(), random: () => Math.random() },
});
const w = instance.exports;

function toFlat(board) {
  const f = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++)
    f[r * 20 + c] = board[r][c] === 'white' ? 1 : board[r][c] === 'black' ? 2 : 0;
  return f;
}
function wasmSearch(board, player, depth) {
  new Int8Array(w.memory.buffer, w.board_ptr(), 400).set(toFlat(board));
  w.search_root(player === 'white' ? 1 : 0, depth);
  return new Int32Array(w.memory.buffer, w.out_ptr(), 1)[0];
}

function bench(label, board, player, depth) {
  // warm up
  Engine.debugSearchRoot(board, player, depth);
  wasmSearch(board, player, depth);

  let t = Date.now();
  const tsScore = Engine.debugSearchRoot(board, player, depth).bestScore;
  const tsMs = Date.now() - t;

  t = Date.now();
  const wScore = wasmSearch(board, player, depth);
  const wMs = Date.now() - t;

  const ok = tsScore === wScore ? '✓' : `✗ (ts=${tsScore} wasm=${wScore})`;
  console.log(
    `${label.padEnd(22)} depth ${depth}  TS ${String(tsMs).padStart(6)}ms   ` +
    `WASM ${String(wMs).padStart(6)}ms   speedup ${(tsMs / Math.max(wMs, 1)).toFixed(1)}x   ${ok}`,
  );
}

const initial = Engine.makeBoard();
bench('initial', initial, 'black', 2);
bench('initial', initial, 'black', 3);

// A mid-game position from a short random playout.
let b = Engine.makeBoard();
let pl = 'black';
const rng = (() => { let a = 7; return () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
for (let i = 0; i < 8; i++) {
  const moves = [];
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++)
    if (Engine.isValidFootprintCenter(r, c, b, pl))
      for (const to of Engine.getValidMoves(b, { row: r, col: c }, pl)) moves.push({ from: { row: r, col: c }, to });
  const m = moves[Math.floor(rng() * moves.length)];
  b = Engine.applyMove(b, m.from, m.to, pl);
  pl = pl === 'black' ? 'white' : 'black';
}
bench('midgame', b, pl, 2);
bench('midgame', b, pl, 3);
