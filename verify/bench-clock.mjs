// Throughput probe for the wall-clock throttle: total nodes searched in a fixed
// time budget across a fixed set of positions. Run it against builds with the
// throttle on vs off (CLOCK_CHECK_MASK = 0x3FF vs 0) to see the per-node win.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as Engine from './engine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');
const BUDGET = Number(process.argv[2] ?? 800);

function mulberry32(s){let a=s>>>0;return()=>{a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const rng = mulberry32(123); const ri = n => Math.floor(rng() * n);
function endgame(){const b=Array.from({length:20},()=>new Array(20).fill(null));const ring=(p)=>{for(let t=0;t<30;t++){const r=2+ri(15),c=2+ri(15);let ok=1;for(let dr=-1;dr<=1&&ok;dr++)for(let dc=-1;dc<=1;dc++)if(b[r+dr][c+dc]){ok=0;break;}if(!ok)continue;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++)if(dr||dc)b[r+dr][c+dc]=p;return;}};for(const p of['white','black']){ring(p);if(rng()<0.5)ring(p);}const n=3+ri(8);for(let i=0;i<n;i++){const r=1+ri(18),c=1+ri(18);if(!b[r][c])b[r][c]=rng()<0.5?'white':'black';}return b;}
const toFlat = b => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r*20+c] = v==='white'?1:v==='black'?2:0; } return f; };

const wasmBytes = readFileSync(WASM_PATH);
const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const ex = (await WebAssembly.instantiate(wasmBytes, { env: { memory, now: () => Date.now(), random: () => Math.random() } })).instance.exports;
const write = b => new Int8Array(memory.buffer, ex.board_ptr(), 400).set(toFlat(b));

const positions = Array.from({ length: 8 }, endgame);
// warm up
for (const b of positions) { write(b); ex.bench_timed(1, 200); }

let total = 0, t0 = performance.now();
for (const b of positions) {
  for (const white of [1, 0]) {
    write(b);
    total += ex.bench_timed(white, BUDGET) >>> 0;
  }
}
const secs = (performance.now() - t0) / 1000;
console.log(`budget ${BUDGET}ms × ${positions.length * 2} searches: ${total.toLocaleString()} nodes total, ${Math.round(total / secs).toLocaleString()} nodes/s`);
