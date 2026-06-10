# Gess AI Engine — HTTP API

A small JSON/HTTP server that wraps the Gess search engine (Rust→WebAssembly,
parallel Lazy-SMP). You give it a board position and whose turn it is; it returns
the move the engine would play. It is a **stateless move oracle** — it does not
track game state or apply moves (see [Limitations](#limitations)).

- **Base URL:** `http://<host>:8088` (default port `8088`; the server prints its
  address on startup). No authentication. Intended for a trusted LAN only.
- **Content type:** request and response bodies are JSON (`application/json`).
- **CORS:** `Access-Control-Allow-Origin: *` is sent, so browser clients work too.

---

## Coordinate system (read this first)

The board is 20×20. Internally a cell is `{row, col}` with **both 0-indexed**:

- `row = 0` is the **TOP** row of the board (White's home side). `row = 19` is the
  bottom (Black's home side).
- `col = 0` is column **`a`**, `col = 19` is column **`t`**.

Human-readable **square notation** is `<column letter><rank>` where
`rank = 20 - row` and `column letter = "abcdefghijklmnopqrst"[col]`.

| `{row, col}` | square |
|---|---|
| `{row: 0,  col: 0}`  | `a20` |
| `{row: 16, col: 3}`  | `d4`  |
| `{row: 19, col: 19}` | `t1`  |

A **move** is reported both ways: structured `from`/`to` and a `notation` string
like `"d4-e4"`. Black moves first.

---

## Endpoints

### `GET /health`
Liveness probe.
```json
{ "ok": true, "engine": "gess-wasm", "threads": 4 }
```
`threads` = total search threads (1 main + helpers).

### `GET /newgame`
The standard Gess opening position — handy for bootstrapping.
```json
{
  "ok": true,
  "board": ["....................", "..w.w.wwwwwwww.w.w..", "..."],  // 20 strings
  "flat":  [0, 0, 0, ...],                                            // 400 ints, row-major
  "toMove": "black"
}
```

### `POST /bestmove`
Ask the engine for a move. **This is the main endpoint.**

**Request body:**
```json
{
  "board":   "start",
  "player":  "black",
  "budgetMs": 2000
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `board` | see below | `"start"` | the position to search |
| `player` | `"white"`/`"black"` (or `"w"`/`"b"`) | `"black"` | side to move |
| `budgetMs` | number | `2000` | think time in ms, clamped to `[10, 120000]` |

**`board` accepts any of these encodings:**

1. The string `"start"` → the opening position.
2. **20 strings**, each 20 chars long, row 0 first (top). Characters:
   `.` `-` `_` (space) `0` = empty, `w` `W` `1` = white, `b` `B` `2` = black.
3. **400 ints**, row-major (`index = row*20 + col`): `0` empty, `1` white, `2` black.
4. **20×20 ints**, nested: `board[row][col]` ∈ `{0,1,2}`.

**Response (a move was found):**
```json
{
  "ok": true,
  "player": "black",
  "budgetMs": 2000,
  "wallMs": 2011,
  "bestMove": {
    "from": { "row": 16, "col": 3 },
    "to":   { "row": 16, "col": 4 },
    "fromSquare": "d4",
    "toSquare":   "e4",
    "notation":   "d4-e4"
  },
  "depth": 5,            // deepest fully-completed search depth
  "score": 595,          // engine eval from the side-to-move's POV (centipawn-ish)
  "ms": 2008,            // engine's own search time
  "rootMoves": 360,      // legal root moves considered
  "depthTimings": [      // per-depth timing of the iterative deepening
    { "depth": 1, "ms": 0, "cumulativeMs": 5, "best": "b6-e9", "score": 3 }
  ],
  "topMoves": [          // up to 20 best moves at the final depth
    { "rank": 1, "move": "d4-e4", "score": 595, "next": 600,
      "type": "exact", "chosen": true }
  ]
}
```

**Response (no legal moves for that side):**
```json
{ "ok": true, "player": "black", "budgetMs": 2000, "wallMs": 1, "bestMove": null }
```

### Errors
Failures return a non-2xx status with `{ "ok": false, "error": "<message>" }`:

| Status | When |
|---|---|
| `400` | bad JSON, unknown `player`, or a malformed `board` (wrong size, bad cell char) |
| `404` | unknown route |
| `500` | unexpected server error |

The `error` string is specific, e.g. `"board[0][0]: unknown cell 'x' (use . w b)"`.

---

## Behavioral notes (important for an automated caller)

- **Non-deterministic move choice.** The parallel search may return *different but
  equally-rated* moves for the *same* request on different calls (shared
  transposition-table ordering races). Don't assert exact-move equality across
  calls; the move is always legal and the `score` is stable.
- **`budgetMs` ≈ wall time.** A 2000 ms budget takes ~2 s. Set your HTTP client
  timeout above `budgetMs` (e.g. `budgetMs/1000 + 5` seconds).
- **One search at a time.** The server serializes concurrent `/bestmove` requests
  internally (single shared engine). Firing many at once is safe but they run
  sequentially, so total latency adds up — don't expect parallel throughput.
- **`score`** is from the moving side's point of view; positive = good for the
  side to move. Large magnitudes (≳ 900000) indicate a forced win/loss.

## Limitations

This server **only chooses a move for a given position**. It does not:
- apply the move to the board (the caller must update its own board), or
- validate full game rules / detect game end, or
- keep any session/game state between requests.

To play a full game you maintain the board yourself, send it for each turn, and
apply the returned `from`→`to` move with your own Gess move logic.

---

## Python client

No third-party packages required (uses the stdlib `urllib`). A `requests` version
is shown after.

```python
"""Minimal client for the Gess AI engine HTTP API."""
import json
import urllib.request
import urllib.error

class GessClient:
    def __init__(self, base_url="http://localhost:8088"):
        self.base_url = base_url.rstrip("/")

    def _get(self, path):
        with urllib.request.urlopen(self.base_url + path, timeout=10) as r:
            return json.load(r)

    def _post(self, path, payload, timeout):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base_url + path, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # 4xx/5xx still carry a JSON {ok:false, error:...} body.
            return json.load(e)

    def health(self):
        return self._get("/health")

    def new_game(self):
        """Returns the opening position: {'board': [20 strings], 'flat': [...], 'toMove': 'black'}."""
        return self._get("/newgame")

    def best_move(self, board="start", player="black", budget_ms=2000):
        """Ask the engine for a move.

        board: "start" | list[str] (20x20 chars .wb) | list[int] (400) | list[list[int]] (20x20)
        Returns the parsed JSON response; on success result['bestMove'] is
        {'from':{'row','col'}, 'to':{...}, 'notation': 'd4-e4', ...} or None.
        """
        payload = {"board": board, "player": player, "budgetMs": budget_ms}
        # Give the HTTP call comfortably more time than the engine's think budget.
        return self._post("/bestmove", payload, timeout=budget_ms / 1000 + 5)


if __name__ == "__main__":
    c = GessClient("http://localhost:8088")
    print("health:", c.health())

    # 1) Easiest: let the server build the opening position.
    res = c.best_move(board="start", player="black", budget_ms=1500)
    mv = res["bestMove"]
    print(f"black plays {mv['notation']}  (depth {res['depth']}, score {res['score']})")

    # 2) Send your own board as 20 strings ('.'=empty 'w'=white 'b'=black, row 0 = top).
    board = c.new_game()["board"]          # start from the opening...
    res = c.best_move(board=board, player="white", budget_ms=1500)
    print("white plays", res["bestMove"]["notation"] if res["bestMove"] else "(no move)")
```

### Same thing with `requests`
```python
import requests

BASE = "http://localhost:8088"

def best_move(board="start", player="black", budget_ms=2000):
    r = requests.post(f"{BASE}/bestmove",
                      json={"board": board, "player": player, "budgetMs": budget_ms},
                      timeout=budget_ms / 1000 + 5)
    return r.json()          # works for both 200 and 4xx (JSON error body)

res = best_move("start", "black", 2000)
print(res["bestMove"]["notation"], res["depth"], res["score"])
```

### Converting between square notation and `{row, col}`
```python
COLS = "abcdefghijklmnopqrst"

def square_to_rc(sq):           # "d4" -> {"row": 16, "col": 3}
    col = COLS.index(sq[0])
    row = 20 - int(sq[1:])
    return {"row": row, "col": col}

def rc_to_square(row, col):     # 16, 3 -> "d4"
    return f"{COLS[col]}{20 - row}"
```

### curl quick test
```bash
curl -s localhost:8088/health
curl -s localhost:8088/newgame
curl -s -X POST localhost:8088/bestmove \
     -H 'content-type: application/json' \
     -d '{"board":"start","player":"black","budgetMs":2000}'
```
