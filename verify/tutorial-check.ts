// Checks that the tutorial's pictures show what its text says, by the game's
// own rules (the Android app's TutorialTest checks its copy of the steps the
// same way).
//
//   node_modules/.bin/esbuild verify/tutorial-check.ts --bundle --platform=node --format=esm \
//     --outfile=node_modules/.cache/tutorial-check.mjs && ~/node22/bin/node node_modules/.cache/tutorial-check.mjs

import { countRings, isValidFootprintCenter } from '../src/app/services/gess-engine';
import { ringCentres, stepView, toBoard, TUTORIAL_COLS, TUTORIAL_ROWS, tutorialSteps } from '../src/app/tutorial/tutorial-steps';

const steps = new Map(tutorialSteps('Click').map(s => [s.title, s]));
let failures = 0;
function check(ok: boolean, what: string) {
  if (!ok) { failures++; console.log(`FAIL ${what}`); }
}
const key = (ps: [number, number][]) => ps.map(p => p.join(',')).sort().join(' ');
const view = (title: string) => stepView(steps.get(title)!);

for (const s of steps.values()) {
  if (!s.rows) continue;
  check(s.rows.length === TUTORIAL_ROWS && s.rows.every(r => r.length === TUTORIAL_COLS), `${s.title}: 7×9 window`);
  const v = stepView(s);
  if (s.piece) {
    const p = toBoard(s.piece);
    check(isValidFootprintCenter(p.row, p.col, v.board, v.mover), `${s.title}: a legal piece`);
  }
  if (s.move) check(v.destinations.some(d => d[0] === s.move![0] && d[1] === s.move![1]), `${s.title}: a legal move`);
}

check(key(view('Which way it moves').destinations) === key([[3, 4], [2, 4], [1, 4], [4, 5], [4, 6], [4, 7]]),
  'directions: north and east, up to 3');

const moving = view('Moving').after!;
const at = (b: typeof moving, r: number, c: number) => { const p = toBoard([r, c]); return b[p.row][p.col]; };
check(at(moving, 0, 4) === 'black' && at(moving, 1, 5) === 'black', 'moving carries both stones');

const centre = view('The centre stone');
check(centre.destinations.length > 3 && centre.destinations.every(d => d[0] === 3), 'centre stone: unlimited range, east');

const stop = view('Stopping and capturing');
check(key(stop.destinations) === key([[3, 2], [3, 3], [3, 4]]), 'stops at the first contact');
check(key(stop.captured) === key([[2, 5], [4, 5]]), 'captures both white stones');

check(key(ringCentres(view('Rings').board, 'black')) === key([[3, 4]]), 'the ring is found');
const win = view('Winning');
check(win.mover === 'white', 'winning: white moves');
check(countRings(win.board, 'black') === 1 && countRings(win.after!, 'black') === 0, "winning: black's ring is broken");
check(win.captured.length === 3, 'winning: three stones captured');

console.log(failures ? `${failures} tutorial check(s) failed` : `OK: the tutorial's ${steps.size} steps show what they say`);
process.exit(failures ? 1 : 0);
