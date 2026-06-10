// (1) Correctness: ring_check_run asserts the incremental ring masks/totals equal
//     a fresh scan at every searched node — must be 0 mismatches over many
//     positions/depths. (2) Overhead: bench_fixed node count is identical with
//     tracking on/off (behaviour-neutral); compare per-node time (min of N).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');

const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(WASM), { env: { memory, now: () => Date.now(), random: () => Math.random() } });
const x = instance.exports;
const BP = x.board_ptr();
const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r*20+c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, BP, 400).set(f); };

function mulberry32(a){return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rng = mulberry32(0xBEEF11);
const ri = n => Math.floor(rng()*n);
const blank = () => Array.from({length:20},()=>Array(20).fill(null));
function ringEndgame(){const b=blank();const place=p=>{for(let t=0;t<30;t++){const cr=2+ri(15),cc=2+ri(15);let ok=true;for(let dr=-1;dr<=1&&ok;dr++)for(let dc=-1;dc<=1;dc++)if(b[cr+dr][cc+dc]!==null){ok=false;break;}if(!ok)continue;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++)if(dr||dc)b[cr+dr][cc+dc]=p;return;}};for(const p of['white','black']){place(p);if(rng()<0.5)place(p);}const loose=2+ri(8);for(let i=0;i<loose;i++){const r=1+ri(18),c=1+ri(18);if(b[r][c]===null)b[r][c]=rng()<0.5?'white':'black';}return b;}

// ── (1) Correctness over a variety of positions/depths ───────────────────────
function depthFor(branch){return branch<=10?5:branch<=40?4:3;}
let checks = 0, mismatches = 0;
const positions = [E.makeBoard(), ...Array.from({length:300}, ringEndgame)];
// Also throw in a few self-play midgame positions.
{ let b = E.makeBoard(), p='black'; for(let i=0;i<120;i++){ const mv=E.debugGenRoot(b,p); if(!mv.length)break; const m=mv[ri(mv.length)]; b=E.applyMove(b,{row:m.fromR,col:m.fromC},{row:m.toR,col:m.toC},p); p=p==='white'?'black':'white'; if(i%8===0) positions.push(b.map(r=>[...r])); } }

for (const board of positions) {
  for (const player of ['white','black']) {
    const branch = E.debugGenRoot(board, player).length;
    if (branch === 0) continue;
    write(board);
    const mm = x.ring_check_run(player==='white'?1:0, depthFor(branch));
    checks++;
    mismatches += mm;
  }
}
console.log(`correctness: ${checks} ring_check_run searches, total node mismatches = ${mismatches}`);

// ── (2) Overhead: identical nodes, compare time (min of N) ───────────────────
function benchMin(board, white, depth, track, n) {
  x.set_ring_track(track);
  let best = Infinity, nodes = 0;
  for (let i=0;i<n;i++){ write(board); const t=performance.now(); nodes = x.bench_fixed(white?1:0, depth); const dt=performance.now()-t; if(dt<best)best=dt; }
  return { ms: best, nodes };
}
// A midgame position from ~24 plies of self-play.
let mid = E.makeBoard(); { let p='black'; for(let i=0;i<24;i++){const mv=E.debugGenRoot(mid,p);if(!mv.length)break;const m=mv[ri(mv.length)];mid=E.applyMove(mid,{row:m.fromR,col:m.fromC},{row:m.toR,col:m.toC},p);p=p==='white'?'black':'white';} }
const N = 8;
console.log('\noverhead (bench_fixed, min of', N, '):');
for (const [name, board, white, depth] of [
  ['opening d4', E.makeBoard(), 0, 4],
  ['midgame d4', mid, 0, 4],
  ['endgame d6', ringEndgame(), 0, 6],
]) {
  const off = benchMin(board, white, depth, 0, N);
  const on  = benchMin(board, white, depth, 1, N);
  const pct = ((on.ms - off.ms) / off.ms * 100).toFixed(1);
  console.log(`  ${name}: nodes off=${off.nodes} on=${on.nodes} ${off.nodes===on.nodes?'(identical)':'MISMATCH!'} | time off=${off.ms.toFixed(1)}ms on=${on.ms.toFixed(1)}ms  Δ=${pct}%`);
}

console.log('\nRESULT:', mismatches === 0 ? 'PASS — incremental rings match full scan' : 'FAIL');
process.exit(mismatches === 0 ? 0 : 1);
