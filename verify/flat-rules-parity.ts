// Checks the flat-board rules the neural search uses (gess-flat) against the
// app's game logic (gess-engine): plays random games and, at every position,
// compares the movable pieces, every piece's destinations, the board after the
// move played, the game result, and the network input (before and after
// picking up the piece played).
//
//   node_modules/.bin/esbuild verify/flat-rules-parity.ts --bundle --platform=node \
//     --format=esm --outfile=/tmp/flat-rules-parity.mjs && ~/node22/bin/node /tmp/flat-rules-parity.mjs

import * as Engine from '../src/app/services/gess-engine';
import * as Flat from '../src/app/services/gess-flat';
import { buildObservation, OBS_LENGTH, writeObservation } from '../src/app/services/gess-nn-obs';
import type { Board, Player } from '../src/app/models/game.model';

const GAMES = 300;
const SIZE = Engine.SIZE;

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);

function fail(msg: string): never {
  throw new Error(msg);
}

const obsBuf = new Float32Array(OBS_LENGTH * 3).fill(7);
let positions = 0, results = { win: 0, loss: 0, draw: 0, cap: 0 };
for (let g = 0; g < GAMES; g++) {
  let board: Board = Engine.makeBoard();
  let player: Player = 'black';
  let streak = 0;
  for (let ply = 0; ply < 400; ply++) {
    positions++;
    const flat = Flat.toFlat(board);
    const me = Flat.stoneOf(player);
    if (Flat.fromFlat(flat).some((row, r) => row.some((v, c) => v !== board[r][c]))) fail('round trip');

    // Every square: footprint legality and the destination list.
    const movable: number[] = [];
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++) {
        const a = Engine.isValidFootprintCenter(r, c, board, player);
        const b = Flat.isFootprintCentre(flat, r, c, me);
        if (a !== b) fail(`footprint ${r},${c}: engine ${a}, flat ${b}`);
        if (!a) continue;
        const ea = Engine.getValidMoves(board, { row: r, col: c }, player)
          .map(p => p.row * SIZE + p.col).sort((x, y) => x - y);
        const fa = Flat.destinations(flat, r, c, me, []).sort((x, y) => x - y);
        if (ea.join() !== fa.join()) fail(`dests ${r},${c}: engine [${ea}] flat [${fa}]`);
        if ((Flat.destinations(flat, r, c, me, [], true).length > 0) !== (ea.length > 0)) fail('firstOnly');
        if (ea.length) movable.push(r * SIZE + c);
      }
    if (!movable.length) break;

    // Play a random move, both ways. Random moves mostly break the mover's own
    // ring at once, so prefer ones that don't; and in some games prefer quiet
    // moves, to reach the no-capture draw.
    const quiet = g % 3 === 0;
    const pick = () => {
      const from = movable[Math.floor(rand() * movable.length)];
      const dests = Flat.destinations(flat, Math.floor(from / SIZE), from % SIZE, me, []);
      return { from, to: dests[Math.floor(rand() * dests.length)] };
    };
    let { from, to } = pick();
    for (let tries = 0; tries < 60; tries++) {
      const after = Flat.applyMove(flat, from, to, me);
      const o = Flat.outcomeAfterMove(flat, after, me, streak);
      const ok = o.result !== -1 && (!quiet || o.streak > 0 || tries > 40);
      if (ok || rand() < 0.02) break;
      ({ from, to } = pick());
    }
    const f = { row: Math.floor(from / SIZE), col: from % SIZE };
    const t = { row: Math.floor(to / SIZE), col: to % SIZE };
    for (const [sel, src] of [[null, -1], [f, from]] as const) {
      const expected = buildObservation(board, player, sel);
      writeObservation(flat, me, src, obsBuf, OBS_LENGTH); // mid-buffer, over stale data
      for (let i = 0; i < OBS_LENGTH; i++)
        if (obsBuf[OBS_LENGTH + i] !== expected[i]) fail(`observation (source ${src}) index ${i}`);
    }
    const next = Engine.applyMove(board, f, t, player);
    const nextFlat = Flat.applyMove(flat, from, to, me);
    const back = Flat.fromFlat(nextFlat);
    if (back.some((row, r) => row.some((v, c) => v !== next[r][c]))) fail(`applyMove ${from}->${to}`);

    // Game result, as the app decides it.
    const opp: Player = player === 'white' ? 'black' : 'white';
    const newStreak = Engine.wasCapture(board, next) ? 0 : streak + 1;
    const outcome = Engine.resolveOutcome(Engine.countRings(next, player), Engine.countRings(next, opp), newStreak);
    const expected = outcome === 'ongoing' ? null : outcome === 'mover-wins' ? 1 : outcome === 'draw' ? 0 : -1;
    const got = Flat.outcomeAfterMove(flat, nextFlat, me, streak);
    if (got.result !== expected || got.streak !== newStreak) {
      fail(`outcome: engine ${outcome}/${newStreak}, flat ${got.result}/${got.streak}`);
    }
    if (newStreak === 0) results.cap++;
    board = next;
    player = opp;
    streak = newStreak;
    if (expected !== null) {
      results[expected === 1 ? 'win' : expected === 0 ? 'draw' : 'loss']++;
      break;
    }
  }
}
console.log(`OK: ${GAMES} games, ${positions} positions match`, results);
