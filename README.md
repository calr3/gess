# GessGame

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.13.

## Rules

The rules are those of the training environment, pgx's `gess` env **v1**
(`pgx/_src/games/gess.py`); tdgauntlet's Gess follows the same version. In
particular, after 20 consecutive moves without a capture (any stone leaving the
board, your own included) the game is decided on stones on the board: more stones
wins, and only an exact tie is a draw.

The app has three implementations of the rules — the game (`gess-engine.ts`), the
neural search's (`gess-flat.ts`) and the negamax engine (`wasm-engine/src/lib.rs`)
— and `verify/pgx-conformance.ts` checks all three against positions dumped from
pgx: every legal move, and each move's resulting position and result. The
fixtures are tdgauntlet's `conformance/gess.jsonl.gz` (copied to
`verify/pgx-gess.jsonl.gz`) and `verify/pgx-gess-quiet.jsonl.gz` from
`verify/dump_pgx_quiet.py` (games that reach the 20-move limit with unequal
stones, which tdgauntlet's has none of). Regenerate both if pgx's rules change:

```bash
node_modules/.bin/esbuild verify/pgx-conformance.ts --bundle --platform=node --format=esm \
  --outfile=node_modules/.cache/pgx-conformance.mjs && ~/node22/bin/node node_modules/.cache/pgx-conformance.mjs
```

It needs the negamax engine built (`wasm-engine/build.sh`, nightly Rust with
`rust-src`). `verify/quiet-rule.mjs` has unit checks of the 20-move rule, and
`verify/quiet-rule-browser.py` plays it out in the UI.

## Neural engine

Alongside the Rust/WASM negamax search, the app can play with the AlphaZero-style
network trained in the pgx repo. The network scores all 400 squares at once, so a
move is two decisions — the piece to move, then its destination.

- "AI · Neural (policy)" plays the network's top legal choice at each step, with
  no search: instant, but the weakest.
- "AI · Neural (2s / 5s / 15s / 60s)" run an AlphaZero-style tree search (PUCT)
  guided by the network for that long (`src/app/services/gess-mcts.ts`). The
  network evaluations are batched — many leaves per call, spread by a virtual
  loss — and the next batch is selected while the GPU works on the current one.
  The tree is kept between moves and reused. A move that wins on the spot is
  played without searching.

It runs through `onnxruntime-web` in the AI worker, using WebGPU when the browser
has a hardware GPU and WebAssembly otherwise (the runtime files are copied from
`node_modules` by the build and served from `/ort`). The model is loaded when the
page opens; on WebGPU the worker then times a few batch sizes and uses the
smallest one close to the best throughput. The browser console logs the choice
and, after each search, its evaluations per second.

The deployed model is pgx's `checkpoints/gess_20260926190427/000024.ckpt` (E14
in pgx's `GESS_EXPERIMENTS.md`: E13, the full-size run under the v1 rules,
fine-tuned for 24 iterations with pgx gess v2's observation). v2 adds two planes
to the network's input: the count of moves without a capture over 20, and the same
signed by who has more stones. So the network sees how close the 20-move ending
is and who it favours, and the search passes each position's count to the
encoder (`gess-nn-obs.ts`). E14 beat E13 by about 180 Elo per game in a 400-game
tdgauntlet match. It replaced E13, which replaced E10 (a 1.2 h pilot trained
under the old draw rule). `verify/nn-reference.json` holds its outputs on
positions from pgx.

The model file is not in git. Build it from a training checkpoint with
`examples/alphazero/export_onnx.py` in the pgx repo and copy the result to
`public/models/gess-policy.onnx`. See `verify/README-nn.md` for the parity
checks that confirm the encoder and exported model still match training, and
for the search's own checks.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
