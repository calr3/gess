# Writes verify/nn-reference.json: positions from the training environment (pgx
# gess) with the observation pgx builds for each and the network's output on it,
# for nn-obs-parity.ts and nn-move-parity.ts.
#
# Run from the pgx repo's environment, on the CPU, with the checkpoint that was
# exported to public/models/gess-policy.onnx:
#
#   JAX_PLATFORMS=cpu python verify/dump_nn_reference.py \
#       ~/calr3gh/pgx/checkpoints/<run>/<step>.ckpt
#
# The positions come from a seeded game (continued past each finish) whose moves
# are sampled from the network's own policy, so they look like real play: quiet
# stretches, captures, one side ahead. One position is kept per combination of
# stage, quiet clock (in bands of five) and who is ahead on stones, so the
# observation's clock planes are exercised at every value they take in practice.

import argparse
import json
import os
import pickle
import sys
from pathlib import Path

import jax
import jax.numpy as jnp
import numpy as np

PGX = Path(os.environ.get("PGX_DIR", Path.home() / "calr3gh/pgx"))
sys.path.insert(0, str(PGX / "examples/alphazero"))

import pgx  # noqa: E402
from config import Config  # noqa: E402
from network import make_forward  # noqa: E402

OUT = Path(__file__).with_name("nn-reference.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--steps", type=int, default=1200, help="actions to play")
    ap.add_argument("--max-cases", type=int, default=40)
    args = ap.parse_args()

    sys.modules["__main__"].Config = Config  # older checkpoints pickled it there
    with open(args.checkpoint, "rb") as f:
        ckpt = pickle.load(f)
    cfg = Config(**ckpt["config"].__dict__)
    params, state = ckpt["model"]
    env = pgx.make("gess")
    forward = make_forward(env.num_actions, cfg)

    @jax.jit
    def evaluate(obs):
        (logits, value), _ = forward.apply(params, state, obs[None], is_eval=True)
        return logits[0], value[0]

    step = jax.jit(env.step)
    key = jax.random.PRNGKey(args.seed)
    s = env.init(key)
    cases, seen = [], set()
    for _ in range(args.steps):
        x = s._x
        logits, value = evaluate(s.observation)
        board = np.asarray(x.board).reshape(20, 20)
        own = int((board == int(x.color) + 1).sum())
        opp = int((board == 2 - int(x.color)).sum())
        clock = int(x.no_capture_turns)
        bucket = (int(x.stage), min(clock // 5, 3), int(np.sign(own - opp)))
        if bucket not in seen and len(cases) < args.max_cases:
            seen.add(bucket)
            src = int(x.source)
            cases.append({
                "board": ["".join(".bw"[v] for v in row) for row in board.tolist()],
                "player": "black" if int(x.color) == 0 else "white",
                "stage": int(x.stage),
                "source": [src // 20, src % 20] if int(x.stage) == 1 else None,
                "streak": clock,
                "obs": [round(float(v), 5) for v in np.asarray(s.observation).ravel()],
                "logits": [round(float(v), 5) for v in np.asarray(logits)],
                "value": round(float(value), 5),
                "legal": np.flatnonzero(np.asarray(s.legal_action_mask)).tolist(),
            })
        key, k = jax.random.split(key)
        masked = jnp.where(s.legal_action_mask, logits, -jnp.inf)
        s = step(s, jax.random.categorical(k, masked))
        if bool(s.terminated | s.truncated):
            key, k = jax.random.split(key)
            s = env.init(k)

    cases.sort(key=lambda c: (c["streak"], c["stage"]))
    OUT.write_text(json.dumps(cases))
    print(f"wrote {len(cases)} positions to {OUT} (pgx gess {env.version}, "
          f"clocks {sorted({c['streak'] for c in cases})})")


if __name__ == "__main__":
    main()
