// src/app/services/gess-engine.ts
var SIZE = 20;
var MIN = 1;
var MAX = 18;
var DIRS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1]
];
var WIN_SCORE = 1e6;
var TIME_BUDGET_MS = 1e4;
var MAX_DEPTH = 64;
var SEARCH_TIMEOUT = /* @__PURE__ */ Symbol("search-timeout");
function isValidFootprintCenter(row, col, board, player) {
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return false;
  const opp = player === "white" ? "black" : "white";
  let hasOwn = false;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr, c = col + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
      const cell = board[r][c];
      if (cell === opp) return false;
      if (cell === player) hasOwn = true;
    }
  }
  return hasOwn;
}
function getValidMoves(board, center, player) {
  const { row, col } = center;
  const maxSteps = board[row][col] === player ? SIZE : 3;
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const origin = /* @__PURE__ */ new Set();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++)
      origin.add(`${row + ddr},${col + ddc}`);
  for (const [dr, dc] of DIRS) {
    const fr = row + dr, fc = col + dc;
    if (fr < 0 || fr >= SIZE || fc < 0 || fc >= SIZE) continue;
    if (board[fr][fc] !== player) continue;
    for (let step = 1; step <= maxSteps; step++) {
      const nr = row + dr * step;
      const nc = col + dc * step;
      if (nr < MIN - 1 || nr > MAX + 1 || nc < MIN - 1 || nc > MAX + 1) break;
      let hitsAny = false;
      outer:
        for (let ddr = -1; ddr <= 1; ddr++) {
          for (let ddc = -1; ddc <= 1; ddc++) {
            const sr = nr + ddr, sc = nc + ddc;
            if (origin.has(`${sr},${sc}`)) continue;
            if (sr < MIN || sr > MAX || sc < MIN || sc > MAX) continue;
            if (board[sr][sc] !== null) {
              hitsAny = true;
              break outer;
            }
          }
        }
      const key = `${nr},${nc}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ row: nr, col: nc });
      }
      if (hitsAny) break;
    }
  }
  return results;
}
function applyMove(board, from, to, player) {
  const b = board.map((r) => [...r]);
  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
  const relStones = [];
  for (let ddr = -1; ddr <= 1; ddr++) {
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
      if (b[r][c] === player) {
        relStones.push([ddr, ddc]);
        b[r][c] = null;
      }
    }
  }
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && b[r][c] !== null)
          b[r][c] = null;
      }
    }
  }
  for (const [ddr, ddc] of relStones) {
    const r = to.row + ddr, c = to.col + ddc;
    if (r >= MIN && r <= MAX && c >= MIN && c <= MAX) b[r][c] = player;
  }
  return b;
}
function countCaptures(board, from, to, player) {
  const opponent = player === "white" ? "black" : "white";
  const lifted = /* @__PURE__ */ new Set();
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++) {
      const r = from.row + ddr, c = from.col + ddc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
      if (board[r][c] === player) lifted.add(`${r},${c}`);
    }
  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
  let opp = 0, self = 0;
  const counted = /* @__PURE__ */ new Set();
  for (let step = 1; step <= steps; step++) {
    const cr = from.row + dr * step, cc = from.col + dc * step;
    for (let ddr = -1; ddr <= 1; ddr++) {
      for (let ddc = -1; ddc <= 1; ddc++) {
        const r = cr + ddr, c = cc + ddc;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
        const key = `${r},${c}`;
        if (lifted.has(key) || counted.has(key)) continue;
        const cell = board[r][c];
        if (cell === opponent) {
          opp++;
          counted.add(key);
        } else if (cell === player) {
          self++;
          counted.add(key);
        }
      }
    }
  }
  return { opp, self };
}
function hasRing(board, player) {
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) return true;
  return false;
}
function countRings(board, player) {
  let count = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) count++;
  return count;
}
function countStones(board, player) {
  let n = 0;
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (board[r][c] === player) n++;
  return n;
}
var NO_CAPTURE_DRAW_LIMIT = 20;
function totalStones(board) {
  return countStones(board, "white") + countStones(board, "black");
}
function wasCapture(before, after) {
  return totalStones(after) < totalStones(before);
}
function resolveOutcome(moverRings, oppRings, noCaptureStreak) {
  if (moverRings === 0 && oppRings === 0) return "both-lose";
  if (moverRings === 0) return "mover-loses";
  if (oppRings === 0) return "mover-wins";
  if (noCaptureStreak >= NO_CAPTURE_DRAW_LIMIT) return "draw";
  return "ongoing";
}
function getEnclosedCells(board, player) {
  const centres = /* @__PURE__ */ new Set();
  for (let r = MIN; r <= MAX; r++)
    for (let c = MIN; c <= MAX; c++)
      if (isRingCenter(board, r, c, player)) centres.add(`${r},${c}`);
  return centres;
}
function isRingCenter(board, row, col, player) {
  if (board[row][col] !== null) return false;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++)
      if ((dr !== 0 || dc !== 0) && board[row + dr][col + dc] !== player) return false;
  return true;
}
function makeBoard() {
  const board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  const whiteCols = [
    [1, [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17]],
    // label 18 — 12 stones
    [2, [1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 16, 17, 18]],
    // label 17 — 13 stones
    [3, [2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17]],
    // label 16 — 12 stones
    [6, [2, 5, 8, 11, 14, 17]]
    // label 13 —  6 stones
  ];
  for (const [r, cols] of whiteCols) {
    for (const c of cols) {
      board[r][c] = "white";
      board[19 - r][c] = "black";
    }
  }
  return board;
}
var PLAY_MASK = 524286;
var COL3 = (() => {
  const t = new Array(SIZE);
  for (let c = 0; c < SIZE; c++) {
    let m = 1 << c;
    if (c > 0) m |= 1 << c - 1;
    if (c < SIZE - 1) m |= 1 << c + 1;
    t[c] = m;
  }
  return t;
})();
function popcount(x) {
  x = x - (x >>> 1 & 1431655765);
  x = (x & 858993459) + (x >>> 2 & 858993459);
  x = x + (x >>> 4) & 252645135;
  return x * 16843009 >>> 24;
}
function bbFromBoard(board) {
  const w = new Int32Array(SIZE), b = new Int32Array(SIZE);
  for (let r = 0; r < SIZE; r++) {
    const row = board[r];
    for (let c = 0; c < SIZE; c++) {
      const cell = row[c];
      if (cell === "white") w[r] |= 1 << c;
      else if (cell === "black") b[r] |= 1 << c;
    }
  }
  return { w, b };
}
function rowRingMaskW(w, b, r) {
  const wu = w[r - 1], wm = w[r], wd = w[r + 1], empty = ~(w[r] | b[r]);
  return wu & wu << 1 & wu >>> 1 & (wm << 1 & wm >>> 1) & (wd & wd << 1 & wd >>> 1) & empty & PLAY_MASK;
}
function rowRingMaskB(w, b, r) {
  const bu = b[r - 1], bm = b[r], bd = b[r + 1], empty = ~(w[r] | b[r]);
  return bu & bu << 1 & bu >>> 1 & (bm << 1 & bm >>> 1) & (bd & bd << 1 & bd >>> 1) & empty & PLAY_MASK;
}
function ringWeight(m) {
  return 10 * popcount(m) - 3 * popcount(m & (m << 2));
}
function rowRingW(w, b, r) {
  return ringWeight(rowRingMaskW(w, b, r));
}
function rowRingB(w, b, r) {
  return ringWeight(rowRingMaskB(w, b, r));
}
var RING_SAFETY_K = 10;
function ringPressure(w, b) {
  let pW = 0, pB = 0;
  for (let r = MIN; r <= MAX; r++) {
    const mw = rowRingMaskW(w, b, r);
    if (mw) {
      const band = mw | mw << 1 | mw >>> 1 | mw << 2 | mw >>> 2;
      for (let rr = r - 2; rr <= r + 2; rr++)
        if (rr >= 0 && rr < SIZE) pW += popcount(b[rr] & band);
    }
    const mb = rowRingMaskB(w, b, r);
    if (mb) {
      const band = mb | mb << 1 | mb >>> 1 | mb << 2 | mb >>> 2;
      for (let rr = r - 2; rr <= r + 2; rr++)
        if (rr >= 0 && rr < SIZE) pB += popcount(w[rr] & band);
    }
  }
  return { pW, pB };
}
function ringSafety(w, b, white) {
  const { pW, pB } = ringPressure(w, b);
  return RING_SAFETY_K * (white ? pB - pW : pW - pB);
}
function whiteDeepest(w) {
  for (let r = MAX; r >= MIN; r--) if (w[r] & PLAY_MASK) return r - 1;
  return 0;
}
function blackDeepest(b) {
  for (let r = MIN; r <= MAX; r++) if (b[r] & PLAY_MASK) return MAX - r;
  return 0;
}
var pRowRingW = new Int32Array(SIZE);
var pRowRingB = new Int32Array(SIZE);
var pRowStoneW = new Int32Array(SIZE);
var pRowStoneB = new Int32Array(SIZE);
function analyzeFill(w, b) {
  let wR = 0, bR = 0, wS = 0, bS = 0;
  for (let r = MIN; r <= MAX; r++) {
    const rw = rowRingW(w, b, r), rb = rowRingB(w, b, r);
    const sw = popcount(w[r] & PLAY_MASK), sb = popcount(b[r] & PLAY_MASK);
    pRowRingW[r] = rw;
    pRowRingB[r] = rb;
    pRowStoneW[r] = sw;
    pRowStoneB[r] = sb;
    wR += rw;
    bR += rb;
    wS += sw;
    bS += sb;
  }
  return { wR, bR, wS, bS, wDeep: whiteDeepest(w), bDeep: blackDeepest(b) };
}
function evalOf(a, white) {
  const myR = white ? a.wR : a.bR, opR = white ? a.bR : a.wR;
  const myS = white ? a.wS : a.bS, opS = white ? a.bS : a.wS;
  const myD = white ? a.wDeep : a.bDeep, opD = white ? a.bDeep : a.wDeep;
  return 100 * (myS - opS) + 70 * (myR - opR) + (myD - opD);
}
var UNDO_FRAMES = MAX_DEPTH + 8;
var UNDO_CAP = 6;
var undoRow = new Int32Array(UNDO_FRAMES * UNDO_CAP);
var undoW = new Int32Array(UNDO_FRAMES * UNDO_CAP);
var undoB = new Int32Array(UNDO_FRAMES * UNDO_CAP);
var undoN = new Int32Array(UNDO_FRAMES);
var undoSp = 0;
function makeMove(w, b, fromR, fromC, toR, toC, white) {
  const base = undoSp * UNDO_CAP;
  let n = 0;
  for (let r = fromR - 1; r <= fromR + 1; r++) {
    if (r < 0 || r >= SIZE) continue;
    undoRow[base + n] = r;
    undoW[base + n] = w[r];
    undoB[base + n] = b[r];
    n++;
  }
  for (let r = toR - 1; r <= toR + 1; r++) {
    if (r < 0 || r >= SIZE || r >= fromR - 1 && r <= fromR + 1) continue;
    undoRow[base + n] = r;
    undoW[base + n] = w[r];
    undoB[base + n] = b[r];
    n++;
  }
  undoN[undoSp] = n;
  undoSp++;
  const own = white ? w : b;
  let pat = 0;
  for (let ddr = -1; ddr <= 1; ddr++) {
    const rr = fromR + ddr;
    if (rr < 0 || rr >= SIZE) continue;
    for (let ddc = -1; ddc <= 1; ddc++) {
      const cc = fromC + ddc;
      if (cc < 0 || cc >= SIZE) continue;
      if (own[rr] & 1 << cc) pat |= 1 << (ddr + 1) * 3 + (ddc + 1);
    }
  }
  const ocm = COL3[fromC];
  for (let rr = fromR - 1; rr <= fromR + 1; rr++) {
    if (rr < 0 || rr >= SIZE) continue;
    own[rr] &= ~ocm;
  }
  const dcm = COL3[toC];
  for (let r = toR - 1; r <= toR + 1; r++) {
    if (r < 0 || r >= SIZE) continue;
    w[r] &= ~dcm;
    b[r] &= ~dcm;
  }
  for (let ddr = -1; ddr <= 1; ddr++)
    for (let ddc = -1; ddc <= 1; ddc++)
      if (pat & 1 << (ddr + 1) * 3 + (ddc + 1)) {
        const rr = toR + ddr, cc = toC + ddc;
        if (rr >= MIN && rr <= MAX && cc >= MIN && cc <= MAX) own[rr] |= 1 << cc;
      }
}
function unmakeMove(w, b) {
  undoSp--;
  const base = undoSp * UNDO_CAP;
  const n = undoN[undoSp];
  for (let i = 0; i < n; i++) {
    const r = undoRow[base + i];
    w[r] = undoW[base + i];
    b[r] = undoB[base + i];
  }
}
var bandRows = new Int32Array(16);
function genMoves(w, b, white) {
  const own = white ? w : b;
  const opp = white ? b : w;
  const items = [];
  const visited = new Int32Array(SIZE);
  const p = analyzeFill(w, b);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cm = COL3[c];
      if ((opp[r - 1] | opp[r] | opp[r + 1]) & cm) continue;
      if (!((own[r - 1] | own[r] | own[r + 1]) & cm)) continue;
      const maxSteps = own[r] & 1 << c ? SIZE : 3;
      visited.fill(0);
      for (const [dr, dc] of DIRS) {
        const sr = r + dr, sc = c + dc;
        if (sr < 0 || sr >= SIZE || sc < 0 || sc >= SIZE) continue;
        if (!(own[sr] & 1 << sc)) continue;
        for (let step = 1; step <= maxSteps; step++) {
          const nr = r + dr * step, nc = c + dc * step;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;
          const ncm = COL3[nc];
          let hits = 0;
          for (let row = nr - 1; row <= nr + 1; row++) {
            if (row < 0 || row >= SIZE) continue;
            let o = (w[row] | b[row]) & ncm;
            if (row >= r - 1 && row <= r + 1) o &= ~cm;
            hits |= o;
          }
          if (!(visited[nr] & 1 << nc)) {
            visited[nr] |= 1 << nc;
            const a0 = r - 2 < MIN ? MIN : r - 2, a1 = r + 2 > MAX ? MAX : r + 2;
            const b0 = nr - 2 < MIN ? MIN : nr - 2, b1 = nr + 2 > MAX ? MAX : nr + 2;
            let n = 0;
            if (b0 > a1 + 1 || a0 > b1 + 1) {
              for (let rc = a0; rc <= a1; rc++) bandRows[n++] = rc;
              for (let rc = b0; rc <= b1; rc++) bandRows[n++] = rc;
            } else {
              const lo = a0 < b0 ? a0 : b0, hi = a1 > b1 ? a1 : b1;
              for (let rc = lo; rc <= hi; rc++) bandRows[n++] = rc;
            }
            makeMove(w, b, r, c, nr, nc, white);
            let dwR = 0, dbR = 0, dwS = 0, dbS = 0;
            for (let i = 0; i < n; i++) {
              const rc = bandRows[i];
              dwR += rowRingW(w, b, rc) - pRowRingW[rc];
              dbR += rowRingB(w, b, rc) - pRowRingB[rc];
              dwS += popcount(w[rc] & PLAY_MASK) - pRowStoneW[rc];
              dbS += popcount(b[rc] & PLAY_MASK) - pRowStoneB[rc];
            }
            const cwR = p.wR + dwR, cbR = p.bR + dbR, cwS = p.wS + dwS, cbS = p.bS + dbS;
            const cwDeep = whiteDeepest(w), cbDeep = blackDeepest(b);
            const safety = ringSafety(w, b, white);
            unmakeMove(w, b);
            const myR = white ? cwR : cbR, opR = white ? cbR : cwR;
            const myS = white ? cwS : cbS, opS = white ? cbS : cwS;
            const myD = white ? cwDeep : cbDeep, opD = white ? cbDeep : cwDeep;
            const outcome = myR === 0 ? -1 : opR === 0 ? 1 : 0;
            const key = 100 * (myS - opS) + 70 * (myR - opR) + (myD - opD) + safety;
            items.push({ fromR: r, fromC: c, toR: nr, toC: nc, outcome, key });
          }
          if (hits !== 0) break;
        }
      }
    }
  }
  items.sort((x, y) => y.outcome - x.outcome || y.key - x.key);
  return items;
}
var SEARCH_DEBUG = true;
var DEBUG_COLS = "abcdefghijklmnopqrst";
function moveLabel(ch) {
  const sq = (r, c) => `${DEBUG_COLS[c]}${SIZE - r}`;
  return `${sq(ch.fromR, ch.fromC)}-${sq(ch.toR, ch.toC)}`;
}
function formatTable(rows, cols) {
  const w = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key]).length)));
  const line = (cells) => cells.map((s, i) => cols[i].right ? s.padStart(w[i]) : s.padEnd(w[i])).join("  ");
  const out = [line(cols.map((c) => c.label)), w.map((n) => "\u2500".repeat(n)).join("  ")];
  for (const r of rows) out.push(line(cols.map((c) => String(r[c.key]))));
  return out.join("\n");
}
function getBestMove(board, player, timeBudgetMs) {
  const white = player === "white";
  const deadline = Date.now() + timeBudgetMs;
  const { w, b } = bbFromBoard(board);
  undoSp = 0;
  const rootChildren = genMoves(w, b, white);
  if (rootChildren.length === 0) return null;
  let bestMove = rootChildren[0];
  let bestDepth = 0;
  const tSearch = performance.now();
  const depthTimings = [];
  let lastScored = [];
  let lastBestScore = 0;
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const tDepth = performance.now();
    try {
      let alpha = -Infinity;
      const scored = [];
      for (const ch of rootChildren) {
        let score;
        let exact = true;
        if (ch.outcome === 1) score = WIN_SCORE - 1;
        else if (ch.outcome === -1) score = -(WIN_SCORE - 1);
        else if (depth === 1) score = ch.key;
        else {
          makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
          score = -negamax(w, b, !white, depth - 1, -Infinity, -alpha, 1, deadline);
          unmakeMove(w, b);
          exact = false;
        }
        scored.push({ ch, score, exact });
        if (score > alpha) alpha = score;
      }
      const bestScore = alpha;
      const candidates = [];
      for (const { ch, score, exact } of scored) {
        if (score !== bestScore) continue;
        if (exact) {
          candidates.push(ch);
          continue;
        }
        makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
        const v = -negamax(w, b, !white, depth - 1, -bestScore, -bestScore + 1, 1, deadline);
        unmakeMove(w, b);
        if (v >= bestScore) candidates.push(ch);
      }
      if (candidates.length === 0) candidates.push(rootChildren[0]);
      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      bestMove = chosen;
      bestDepth = depth;
      depthTimings.push({
        depth,
        ms: Math.round(performance.now() - tDepth),
        cumulativeMs: Math.round(performance.now() - tSearch)
      });
      lastScored = scored;
      lastBestScore = bestScore;
      const i = rootChildren.indexOf(chosen);
      if (i > 0) {
        rootChildren.splice(i, 1);
        rootChildren.unshift(chosen);
      }
      if (bestScore >= WIN_SCORE - MAX_DEPTH || bestScore <= -(WIN_SCORE - MAX_DEPTH)) break;
    } catch (e) {
      if (e === SEARCH_TIMEOUT) break;
      throw e;
    }
    if (Date.now() >= deadline) break;
  }
  if (SEARCH_DEBUG && lastScored.length) {
    const totalMs = Math.round(performance.now() - tSearch);
    const moveRows = lastScored.slice().sort((a, b2) => b2.score - a.score).slice(0, 20).map((s, i) => ({
      "#": i + 1,
      move: moveLabel(s.ch),
      score: s.score + 0,
      // normalise -0 → 0
      type: s.exact ? "exact" : s.score === lastBestScore ? "exact (pv)" : "\u2264 bound",
      staticEval: s.ch.key,
      chosen: s.ch === bestMove ? "\u2605" : ""
    }));
    console.log(
      `[Gess AI] ${player}: best depth ${bestDepth}, ${rootChildren.length} root moves, ${totalMs}ms total

Time per depth:
` + formatTable(depthTimings, [
        { key: "depth", label: "depth", right: true },
        { key: "ms", label: "ms", right: true },
        { key: "cumulativeMs", label: "cum ms", right: true }
      ]) + `

Top ${moveRows.length} moves at depth ${bestDepth}:
` + formatTable(moveRows, [
        { key: "#", label: "#", right: true },
        { key: "move", label: "move" },
        { key: "score", label: "score", right: true },
        { key: "type", label: "type" },
        { key: "staticEval", label: "static", right: true },
        { key: "chosen", label: "" }
      ])
    );
  }
  return {
    from: { row: bestMove.fromR, col: bestMove.fromC },
    to: { row: bestMove.toR, col: bestMove.toC },
    depth: bestDepth
  };
}
function negamax(w, b, white, depth, alpha, beta, ply, deadline) {
  if (Date.now() >= deadline) throw SEARCH_TIMEOUT;
  const moves = genMoves(w, b, white);
  if (moves.length === 0) return evalOf(analyzeFill(w, b), white) + ringSafety(w, b, white);
  let best = -Infinity;
  for (const mv of moves) {
    let score;
    if (mv.outcome === 1) score = WIN_SCORE - (ply + 1);
    else if (mv.outcome === -1) score = -(WIN_SCORE - (ply + 1));
    else if (depth === 1) score = mv.key;
    else {
      makeMove(w, b, mv.fromR, mv.fromC, mv.toR, mv.toC, white);
      score = -negamax(w, b, !white, depth - 1, -beta, -alpha, ply + 1, deadline);
      unmakeMove(w, b);
    }
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}
function debugAnalyze(board) {
  const { w, b } = bbFromBoard(board);
  const a = analyzeFill(w, b);
  const { pW, pB } = ringPressure(w, b);
  return { wR: a.wR, bR: a.bR, wS: a.wS, bS: a.bS, wDeep: a.wDeep, bDeep: a.bDeep, pW, pB };
}
function debugGenRoot(board, player) {
  const white = player === "white";
  const { w, b } = bbFromBoard(board);
  undoSp = 0;
  return genMoves(w, b, white).map((m) => ({
    fromR: m.fromR,
    fromC: m.fromC,
    toR: m.toR,
    toC: m.toC,
    outcome: m.outcome,
    key: m.key
  }));
}
function debugSearchRoot(board, player, depth) {
  const white = player === "white";
  const { w, b } = bbFromBoard(board);
  undoSp = 0;
  const root = genMoves(w, b, white);
  let alpha = -Infinity;
  const moves = [];
  for (const ch of root) {
    let score;
    if (ch.outcome === 1) score = WIN_SCORE - 1;
    else if (ch.outcome === -1) score = -(WIN_SCORE - 1);
    else if (depth === 1) score = ch.key;
    else {
      makeMove(w, b, ch.fromR, ch.fromC, ch.toR, ch.toC, white);
      score = -negamax(w, b, !white, depth - 1, -Infinity, -alpha, 1, Infinity);
      unmakeMove(w, b);
    }
    moves.push({ fromR: ch.fromR, fromC: ch.fromC, toR: ch.toR, toC: ch.toC, score });
    if (score > alpha) alpha = score;
  }
  return { bestScore: alpha, moves };
}
export {
  MAX,
  MIN,
  NO_CAPTURE_DRAW_LIMIT,
  SIZE,
  TIME_BUDGET_MS,
  WIN_SCORE,
  applyMove,
  countCaptures,
  countRings,
  countStones,
  resolveOutcome,
  totalStones,
  wasCapture,
  debugAnalyze,
  debugGenRoot,
  debugSearchRoot,
  getBestMove,
  getEnclosedCells,
  getValidMoves,
  hasRing,
  isValidFootprintCenter,
  makeBoard
};
