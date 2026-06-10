# Gess AI Engine Server

A small, dependency-free Node HTTP server that wraps the Gess search engine
(Rust→WebAssembly, parallel Lazy-SMP) and exposes it over JSON. Give it a board
and whose turn it is; it returns the move the engine would play.

## Running it

From this directory's parent (`gess-game/`):

```bash
node server/gess-server.mjs
```

This binds `0.0.0.0:8088` (reachable from your LAN), uses all available CPU cores
for the search, and prints its address and thread count on startup. Open it at
`http://localhost:8088`. Stop with Ctrl-C.

No build or `npm install` needed — it uses only Node built-ins and reuses the
already-compiled WASM binary in `../wasm-engine/target/`.

### Options (environment variables)

```bash
# localhost only, custom port
PORT=9000 HOST=127.0.0.1 node server/gess-server.mjs

# force a specific search-thread count (default = CPU core count, capped at 16)
THREADS=8 node server/gess-server.mjs
```

| Var | Default | Meaning |
|---|---|---|
| `HOST` | `0.0.0.0` | interface to bind (`127.0.0.1` = localhost only) |
| `PORT` | `8088` | TCP port |
| `THREADS` | core count (≤16) | total search threads (1 main + helpers) |

> No authentication — only run it on a network you trust.

## Quick check

```bash
curl -s localhost:8088/health
curl -s -X POST localhost:8088/bestmove \
     -H 'content-type: application/json' \
     -d '{"board":"start","player":"black","budgetMs":2000}'
```

## API reference

See [`API.md`](./API.md) for the full endpoint reference, board encodings,
coordinate system, and a ready-to-use Python client.
