# Neural engine checks

`nn-reference.json` holds positions exported from the training environment
(the pgx repo) with, for each one: the board, whose turn it is, the selected
piece (if any), the observation tensor the trained network was fed, its output
scores and value, and the legal actions.

Regenerate it after retraining, from the pgx repo, with the checkpoint you
exported to ONNX (see `examples/alphazero/export_onnx.py` there):

```python
# examples/alphazero, with the checkpoint's config and params loaded as `cfg`/`params`
# writes board rows, player, stage, source, obs, logits, value and legal actions
# for a handful of positions sampled from a random game.
```

Checks (run with Node 22; `~/node22/bin/node` on this machine):

```bash
node --experimental-strip-types verify/nn-obs-parity.ts   # encoder matches training
node --experimental-strip-types verify/nn-move-parity.ts  # ONNX model matches, same move chosen
```

The second needs `public/models/gess-policy.onnx` in place (it is git-ignored;
build it from a checkpoint with the pgx export script).

The tree search has two more (bundled with esbuild, since they import the app's
modules):

```bash
# the search's flat-board rules and encoder match gess-engine / buildObservation
node_modules/.bin/esbuild verify/flat-rules-parity.ts --bundle --platform=node \
  --format=esm --outfile=/tmp/flat-rules-parity.mjs && ~/node22/bin/node /tmp/flat-rules-parity.mjs

# the search finds wins, avoids losing moves and reuses its tree (CPU, ~1 min)
node_modules/.bin/esbuild verify/mcts-check.ts --bundle --platform=node --format=esm \
  --external:onnxruntime-web --outfile=node_modules/.cache/mcts-check.mjs \
  && ~/node22/bin/node node_modules/.cache/mcts-check.mjs
```
