"""Dump extra Gess positions from pgx for verify/pgx-conformance.ts: games that
reach the 20-move quiet limit with unequal stones.

tdgauntlet's fixture (pgx-gess.jsonl.gz) reaches the limit only in games with no
captures at all, so both sides still have 43 stones and every result there is a
tie - which a draw rule and pgx v1's stone count agree on. These games first
take stones (so one side is ahead), then play only quiet moves, so the positions
near the limit are decided on stones: wins for either side, and some ties.

Run in the pgx repo's environment (it imports pgx), from anywhere:

    JAX_PLATFORMS=cpu python verify/dump_pgx_quiet.py

Writes verify/pgx-gess-quiet.jsonl.gz in the same format as tdgauntlet's
conformance/gess.jsonl.gz (see dump_gess.py there), keeping only the positions
from 17 quiet moves on. Regenerate whenever pgx's Gess rules change.
"""

import gzip
import json
import os
import random
import subprocess
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")

import jax  # noqa: E402
import jax.numpy as jnp  # noqa: E402
import numpy as np  # noqa: E402
import pgx  # noqa: E402
from pgx._src.games.gess import Game  # noqa: E402

GAME = Game()
OUT = Path(__file__).resolve().parent / "pgx-gess-quiet.jsonl.gz"

_mask = jax.jit(jax.vmap(GAME.legal_action_mask))
_step = jax.jit(jax.vmap(GAME.step))
_terminal = jax.jit(jax.vmap(GAME.is_terminal))
_rewards = jax.jit(jax.vmap(GAME.rewards))


def _bucket(n):
    size = 1
    while size < n:
        size *= 2
    return size


def _take(batch, idx):
    n = len(idx)
    padded = np.concatenate([idx, np.full(_bucket(n) - n, idx[0] if n else 0)])
    return jax.tree_util.tree_map(lambda x: x[padded], batch)


def _stack(state):
    return jax.tree_util.tree_map(lambda x: jnp.asarray(x)[None], state)


def _row(batch, i):
    return jax.tree_util.tree_map(lambda x: x[i], batch)


def _pad(values):
    return jnp.asarray(np.pad(values, (0, _bucket(len(values)) - len(values))))


def complete_moves(state):
    """Every complete move from a stage-0 state, and the successors in the same order."""
    one = _stack(state)
    sources = np.flatnonzero(np.asarray(_mask(one)[0]))
    if len(sources) == 0:
        return [], one
    s1 = _step(_take(one, np.zeros(len(sources), dtype=np.int64)), _pad(sources))
    dest_masks = np.asarray(_mask(s1))[: len(sources)]
    pairs = [(i, int(d)) for i in range(len(sources)) for d in np.flatnonzero(dest_masks[i])]
    if not pairs:
        return [], one
    rows = np.array([i for i, _ in pairs])
    dests = np.array([d for _, d in pairs])
    s2 = _step(_take(s1, rows), _pad(dests))
    return [(int(sources[i]), d) for i, d in pairs], s2


# The same wire format, digest and result codes as tdgauntlet's dump_gess.py.
def wire(state, moves_played):
    return {
        "board": "".join(".BW"[int(c)] for c in np.asarray(state.board)),
        "to_move": int(state.color),
        "moves": moves_played,
        "quiet_moves": int(state.no_capture_turns),
    }


def digest(w):
    text = f"{w['board']}|{w['to_move']}|{w['moves']}|{w['quiet_moves']}"
    h = 0x811C9DC5
    for b in text.encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def outcome_code(terminal, rewards):
    if not terminal:
        return "-"
    if float(rewards[0]) == float(rewards[1]):
        return "d"
    return str(int(np.argmax(rewards)))


def play(game, seed):
    """Take stones for a few moves (keeping your own ring), then play quietly to the limit."""
    rng = random.Random(seed)
    grabbing = rng.randint(1, 6)
    state = GAME.init()
    records = []
    for played in range(200):
        moves, succ = complete_moves(state)
        one = _stack(state)
        terminal = bool(_terminal(one)[0])
        record = {
            "game": game,
            "policy": "grab-then-quiet",
            "state": wire(state, played),
            "outcome": outcome_code(terminal, np.asarray(_rewards(one)[0])),
        }
        if terminal or not moves:
            records.append(record)
            break
        n = len(moves)
        term = np.asarray(_terminal(succ))[:n]
        rew = np.asarray(_rewards(succ))[:n]
        order = sorted(range(n), key=lambda i: moves[i])
        record["moves"] = [list(moves[i]) for i in order]
        record["successors"] = [digest(wire(_row(succ, i), played + 1)) for i in order]
        record["successor_outcomes"] = "".join(outcome_code(bool(term[i]), rew[i]) for i in order)
        records.append(record)

        before = int((np.asarray(state.board) != 0).sum())
        taken = before - (np.asarray(succ.board)[:n] != 0).sum(axis=1)
        winners = np.asarray(succ.winner)[:n]
        # Never end the game on rings: those results are covered elsewhere.
        safe = [i for i in range(n) if winners[i] < 0]
        if not safe:
            break
        if played < grabbing:
            takers = [i for i in safe if taken[i] > 0]
            pick = rng.choice(takers or safe)
        else:
            calm = [i for i in safe if taken[i] == 0]
            pick = rng.choice(calm or safe)
        state = _row(succ, pick)
    return records


def main():
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=Path(pgx.__file__).parent, capture_output=True, text=True
    ).stdout.strip()
    meta = {"kind": "meta", "pgx_env_version": pgx.make("gess").version, "pgx_commit": commit,
            "policy": "grab-then-quiet", "min_quiet_kept": 17}
    kept = []
    for g in range(16):
        records = play(g, 9000 + g)
        end = records[-1]
        b = end["state"]["board"]
        print(f"game {g}: {len(records)} positions, ended {end['outcome']!r} at quiet "
              f"{end['state']['quiet_moves']}, black {b.count('B')} white {b.count('W')}", flush=True)
        kept += [r for r in records if r["state"]["quiet_moves"] >= 17]
    with gzip.open(OUT, "wt") as f:
        for r in [meta] + kept:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    print(f"wrote {len(kept)} positions to {OUT}")


if __name__ == "__main__":
    main()
