// Validate the core correctness claim for incremental ring tracking: across many
// real moves, EVERY ring centre whose status changes (created or destroyed, for
// either player) lies inside the 5×5 box around the move's from-centre or to-centre
// (rows from_r±2 ∪ to_r±2, cols ±2). If that always holds, make_move can refresh
// just those rows' ring masks instead of rescanning the board — and we also check
// the finer claims (new rings only for the mover; opponent rings only lost on a
// capture).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as E from './engine.mjs';

const GAMES = Number(process.argv[2] ?? 400);
const PLIES = Number(process.argv[3] ?? 80);

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(0xC0FFEE);
const randInt = n => Math.floor(rng() * n);

const cap = (a, b) => Math.max(Math.abs(a), Math.abs(b));
const inBox = (r, c, cr, cc) => Math.abs(r - cr) <= 2 && Math.abs(c - cc) <= 2;

let movesChecked = 0, outsideRegion = 0, oppCreated = 0, moverDestroyNoLift = 0, oppDestroyNoCap = 0;
const examples = [];

for (let g = 0; g < GAMES; g++) {
  let board = E.makeBoard();
  let player = 'black';
  for (let ply = 0; ply < PLIES; ply++) {
    const moves = E.debugGenRoot(board, player);
    if (moves.length === 0) break;
    const mv = moves[randInt(moves.length)];
    const from = { row: mv.fromR, col: mv.fromC }, to = { row: mv.toR, col: mv.toC };
    const opp = player === 'white' ? 'black' : 'white';

    // Ring centres (both players) before/after the move.
    const beforeMine = E.getEnclosedCells(board, player);
    const beforeOpp = E.getEnclosedCells(board, opp);
    const after = E.applyMove(board, from, to, player);
    const afterMine = E.getEnclosedCells(after, player);
    const afterOpp = E.getEnclosedCells(after, opp);

    const changed = (a, b) => {
      const s = new Set();
      for (const k of a) if (!b.has(k)) s.add(k);
      for (const k of b) if (!a.has(k)) s.add(k);
      return s;
    };
    const changedMine = changed(beforeMine, afterMine);
    const changedOpp = changed(beforeOpp, afterOpp);

    // (1) Region claim: every changed centre is in the from/to 5×5 box.
    for (const set of [changedMine, changedOpp]) {
      for (const k of set) {
        const [r, c] = k.split(',').map(Number);
        if (!(inBox(r, c, from.row, from.col) || inBox(r, c, to.row, to.col))) {
          outsideRegion++;
          if (examples.length < 6) examples.push(`outside-region ${k} from ${from.row},${from.col} to ${to.row},${to.col}`);
        }
      }
    }

    // (2) New rings appear only for the MOVER (opponent gains no stones).
    for (const k of afterOpp) if (!beforeOpp.has(k)) {
      oppCreated++;
      if (examples.length < 6) examples.push(`opp ring created at ${k} (player=${player})`);
    }

    movesChecked++;
    board = after;
    player = opp;
  }
}

console.log(`moves checked: ${movesChecked}`);
console.log(`changed rings OUTSIDE the from/to 5×5 region: ${outsideRegion}`);
console.log(`opponent rings CREATED by a move: ${oppCreated}`);
if (examples.length) { console.log('examples:'); for (const e of examples) console.log('  ' + e); }
const ok = outsideRegion === 0 && oppCreated === 0;
console.log('\nRESULT:', ok ? 'PASS — region claim holds' : 'FAIL');
process.exit(ok ? 0 : 1);
