# GessGame

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.13.

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
