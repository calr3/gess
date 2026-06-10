// Functional test for choose_on_abort: when the clock cuts a deeper iteration
// short, the engine plays the HIGHEST-scoring move it reached at that aborted depth
// — the best estimate the deeper search produced — even if it's a proven loss (in
// which case it's the longest-delaying one). It does NOT steer away from known-loss
// moves toward unsearched alternatives (which often lose faster). So the test
// asserts: the chosen move's aborted-depth `next` score equals the max `next` over
// all reached moves.
//
// We can't force a mid-iteration abort deterministically, so we sweep many small
// time budgets over low-branching ring endgames (which reach mate scores within a
// few plies) and check every call that actually hit the abort path. The OUT buffer
// exposes, per root move, its completed-depth `score` and its aborted-depth `next`
// score (NEG_INF = not reached).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __d = dirname(fileURLToPath(import.meta.url));
const W = join(__d, '..', 'wasm-engine', 'target', 'wasm32-unknown-unknown', 'release', 'gess_engine_wasm.wasm');

const WIN_SCORE = 1_000_000, MAX_DEPTH = 64;
const WIN_T = WIN_SCORE - MAX_DEPTH;   // >= this ⇒ proven win
const NEG_INF = -2_000_000_000;        // "next" sentinel: move not reached at the deeper ply

// Seeded PRNG so the run is reproducible (drives both board gen and wasm random).
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(0xABCD1234);
const randInt = n => Math.floor(rng() * n);

const memory = new WebAssembly.Memory({ initial: 512, maximum: 1024, shared: true });
const { instance } = await WebAssembly.instantiate(readFileSync(W), { env: { memory, now: () => Date.now(), random: () => rng() } });
const x = instance.exports;
const bp = x.board_ptr(), op = x.out_ptr();

const write = (b) => { const f = new Int8Array(400); for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { const v = b[r][c]; f[r * 20 + c] = v === 'white' ? 1 : v === 'black' ? 2 : 0; } new Int8Array(memory.buffer, bp, 400).set(f); };
const blank = () => Array.from({ length: 20 }, () => Array(20).fill(null));

// Low-branching ring endgames: 1-2 rings/side + a few loose stones (mirrors the
// harness generator). Frequent forced captures ⇒ mate scores appear within reach.
function ringEndgame() {
  const b = blank();
  const placeRing = (p) => {
    for (let t = 0; t < 30; t++) {
      const cr = 2 + randInt(15), cc = 2 + randInt(15);
      let clear = true;
      for (let dr = -1; dr <= 1 && clear; dr++) for (let dc = -1; dc <= 1; dc++) if (b[cr + dr][cc + dc] !== null) { clear = false; break; }
      if (!clear) continue;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) b[cr + dr][cc + dc] = p;
      return;
    }
  };
  for (const p of ['white', 'black']) { placeRing(p); if (rng() < 0.5) placeRing(p); }
  const loose = 2 + randInt(8);
  for (let i = 0; i < loose; i++) { const r = 1 + randInt(18), c = 1 + randInt(18); if (b[r][c] === null) b[r][c] = rng() < 0.5 ? 'white' : 'black'; }
  return b;
}

function readResult() {
  const o = new Int32Array(memory.buffer, op, 65536);
  const chosen = { fr: o[1], fc: o[2], tr: o[3], tc: o[4] };
  const bestDepth = o[5], bestScore = o[6], nDepth = o[9];
  let k = 10 + nDepth * 8;
  const nScored = o[k]; k += 1;
  const moves = [];
  for (let i = 0; i < nScored; i++, k += 7) {
    moves.push({ fr: o[k], fc: o[k + 1], tr: o[k + 2], tc: o[k + 3], score: o[k + 4], exact: o[k + 5] === 1, next: o[k + 6] });
  }
  return { chosen, bestDepth, bestScore, moves };
}

const isWin = s => s !== NEG_INF && s >= WIN_T;
const isLoss = s => s !== NEG_INF && s <= -WIN_T;     // a real (non-sentinel) loss score
// A move is "known lost" if the deeper ply refuted it (next<=-WIN_T) OR — when it
// wasn't reached deeper — the COMPLETED ply already proved it a loss (score<=-WIN_T,
// which is why it was filtered out of `root` and never re-searched). Anything else
// is a legitimate not-known-lost alternative the engine could have played.
const knownLost = m => (m.next !== NEG_INF ? m.next <= -WIN_T : m.score <= -WIN_T);
const sameMove = (a, m) => a.fr === m.fr && a.fc === m.fc && a.tr === m.tr && a.tc === m.tc;

let calls = 0, aborts = 0, winCases = 0, lossCases = 0, violations = 0;
const examples = [];

const POSITIONS = Array.from({ length: 60 }, ringEndgame);
const BUDGETS = Array.from({ length: 45 }, (_, i) => i + 1); // 1..45 ms

for (const board of POSITIONS) {
  for (const white of [0, 1]) {
    for (const budget of BUDGETS) {
      write(board);
      const found = x.best_move(white, budget, 1, 0, 1);
      calls++;
      if (!found) continue;
      const r = readResult();
      // Abort path taken ⇔ a deeper iteration produced partial `next` scores.
      const reached = r.moves.filter(m => m.next !== NEG_INF);
      if (reached.length === 0) continue;
      aborts++;

      const chosenEntry = r.moves.find(m => sameMove(r.chosen, m));
      const chosenNext = chosenEntry ? chosenEntry.next : NEG_INF;

      // New behaviour: choose_on_abort plays the HIGHEST-scoring reached move —
      // the best the aborted deeper search found — even when it's a proven loss
      // (then it's the longest-delaying one). So the chosen move's deeper score
      // must equal the max over reached moves.
      const maxNext = Math.max(...reached.map(m => m.next));
      if (chosenNext !== maxNext) {
        violations++;
        if (examples.length < 6) examples.push(`chosen next=${chosenNext} but max reached next=${maxNext}`);
      }
      if (isWin(maxNext)) winCases++;    // a proven win is the max ⇒ still played
      if (isLoss(maxNext)) lossCases++;  // all reached lost ⇒ longest-delaying now played
    }
  }
}

console.log(`calls ${calls}, abort-path ${aborts}, proven-win-as-max ${winCases}, all-loss-max ${lossCases}`);
console.log(`violations (chosen != highest-scored reached move): ${violations}`);
if (examples.length) { console.log('examples:'); for (const e of examples) console.log('  ' + e); }
const ok = violations === 0;
console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(ok ? 0 : 1);
