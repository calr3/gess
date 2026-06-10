// Targeted check of the weighted ring count (tenths of a ring): a ring counts
// 10, but only 7 when another ring shares its row two files to the left. Drives
// the real WASM analyze() export on crafted positions, and cross-checks the TS
// reference (engine.mjs debugAnalyze). Random harness positions almost never put
// two rings exactly two files apart, so this exercises the discount directly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(WASM_PATH), {
  env: { memory, now: () => Date.now(), random: () => Math.random() },
});
const wasm = instance.exports;
const BOARD_PTR = wasm.board_ptr(), OUT_PTR = wasm.out_ptr();

function wasmAnalyze(board) {
  const flat = new Int8Array(400);
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) {
    const v = board[r][c]; flat[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0;
  }
  new Int8Array(memory.buffer, BOARD_PTR, 400).set(flat);
  wasm.analyze();
  const o = new Int32Array(memory.buffer, OUT_PTR, 8);
  return { wR: o[0], bR: o[1] };
}

const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));
// Place a ring centred at (cr,cc): 8 surrounding stones, empty centre.
function ring(board, cr, cc, p) {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
    if (dr || dc) board[cr + dr][cc + dc] = p;
}

const cases = [
  ['1 ring',                       b => ring(b, 9, 5, 'white'),                                          { wR: 10, bR: 0 }],
  ['2 rings, same row, 2 apart',   b => { ring(b, 9, 5, 'white'); ring(b, 9, 7, 'white'); },             { wR: 17, bR: 0 }],
  ['3 rings, same row, 2 apart',   b => { ring(b, 9, 5, 'white'); ring(b, 9, 7, 'white'); ring(b, 9, 9, 'white'); }, { wR: 24, bR: 0 }],
  ['2 rings, same row, far apart', b => { ring(b, 9, 5, 'white'); ring(b, 9, 12, 'white'); },            { wR: 20, bR: 0 }],
  ['2 rings, 2 apart, diff rows',  b => { ring(b, 9, 5, 'white'); ring(b, 12, 7, 'white'); },            { wR: 20, bR: 0 }],
  ['2 black rings, same row, 2 apart', b => { ring(b, 9, 5, 'black'); ring(b, 9, 7, 'black'); },         { wR: 0, bR: 17 }],
];

let pass = true;
for (const [name, build, exp] of cases) {
  const b = blank(); build(b);
  const w = wasmAnalyze(b);
  const t = Engine.debugAnalyze(b);            // TS reference (now also weighted)
  const ok = w.wR === exp.wR && w.bR === exp.bR && t.wR === exp.wR && t.bR === exp.bR;
  pass &&= ok;
  console.log(`${ok ? '✅' : '❌'} ${name.padEnd(34)} wasm wR=${w.wR} bR=${w.bR} | ts wR=${t.wR} bR=${t.bR} | expected wR=${exp.wR} bR=${exp.bR}`);
}
console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(pass ? 0 : 1);
