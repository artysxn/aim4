#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# scripts/sim-train-value.py
# The belief-value head: JSONL dataset in, JSON weights out.
#
# SIM-PLAN 9.14 (auxiliary heads) as 18.6b use 3 spends it. The clone proposes,
# the calibrated value ranks — which is how a generation that is still a clone
# acquires a WHY without waiting for PPO. The target is `pWin_true`, the round
# model's own number on the true state at that tick, not the round's W/L: one
# float per decision instead of one bit per round, in the currency foresight
# already prices in.
#
# Same split as the BC trainer (9.3): training here, inference in JS, a JSON
# artifact carrying its versions between them. The architecture stays inside
# what a two-line JS forward loop can express — dense, tanh, one sigmoid
# output — so 4.3b can score a tape without importing anything.
#
# The number to beat is printed at the end: predicting the dataset mean for
# every sample. A head that cannot beat a constant has learned nothing, and
# on this dataset that is an easy mistake to miss, because most ticks of most
# rounds really are worth about the same.
#
# Run with the project venv:
#   .venv-sim/bin/python scripts/sim-train-value.py <value.jsonl>
#   .venv-sim/bin/python scripts/sim-train-value.py value.jsonl --epochs 120
#   .venv-sim/bin/python scripts/sim-train-value.py value.jsonl --target won
# -----------------------------------------------------------------------------

import argparse
import json
import sys
from pathlib import Path

import numpy as np

VALUE_VERSION = 1


def load_dataset(path):
    with open(path) as f:
        lines = [line for line in f.read().splitlines() if line.strip()]
    meta = json.loads(lines[0])
    if meta.get("type") != "meta" or meta.get("kind") != "value":
        sys.exit(f"{path} is not a value dataset (run scripts/sim-collect-prw.mjs)")
    if meta.get("v") != 1:
        sys.exit(f"unrecognized value dataset version {meta.get('v')} in {path}")
    rows = [json.loads(line) for line in lines[1:]]
    if not rows:
        sys.exit(f"{path} has a header and no samples")
    X = np.array([r["obs"] for r in rows], dtype=np.float64)
    if X.shape[1] != meta["obsSize"]:
        sys.exit(f"dataset says obsSize {meta['obsSize']}, rows carry {X.shape[1]}")
    return meta, X, rows


def train(X, y, hidden, epochs, lr, seed, log):
    rng = np.random.default_rng(seed)
    n, d = X.shape

    # Shuffle once, hold out a fifth. Reporting train error would be grading
    # one's own exam, and this head is easy to overfit: neighbouring ticks of
    # one round are nearly the same sample.
    order = rng.permutation(n)
    X, y = X[order], y[order]
    cut = max(1, int(n * 0.8))
    Xt, yt, Xv, yv = X[:cut], y[:cut], X[cut:], y[cut:]

    W0 = rng.normal(0, 1 / np.sqrt(d), (hidden, d))
    b0 = np.zeros(hidden)
    W1 = rng.normal(0, 1 / np.sqrt(hidden), (1, hidden))
    b1 = np.zeros(1)

    def forward(Xb):
        H = np.tanh(Xb @ W0.T + b0)
        Z = (H @ W1.T + b1).ravel()
        return H, 1.0 / (1.0 + np.exp(-Z))

    def mae(Xb, yb):
        if not len(yb):
            return 0.0
        _, P = forward(Xb)
        return float(np.abs(P - yb).mean())

    batch = 256
    for epoch in range(epochs):
        perm = rng.permutation(len(Xt))
        for start in range(0, len(Xt), batch):
            idx = perm[start : start + batch]
            Xb, yb = Xt[idx], yt[idx]
            H, P = forward(Xb)
            # Cross-entropy against a probability target: the gradient through
            # the sigmoid is the same (P - y), and it does not flatten the way
            # squared error does when the head is confidently wrong.
            G = ((P - yb) / len(yb))[:, None]
            gW1 = G.T @ H
            gb1 = G.sum(axis=0)
            GH = (G @ W1) * (1 - H * H)
            gW0 = GH.T @ Xb
            gb0 = GH.sum(axis=0)
            W1 -= lr * gW1
            b1 -= lr * gb1
            W0 -= lr * gW0
            b0 -= lr * gb0
        if log and (epoch + 1) % 10 == 0:
            print(f"  epoch {epoch + 1:3d}  train mae {mae(Xt, yt):.4f}  val mae {mae(Xv, yv):.4f}")

    return (W0, b0, W1, b1), mae(Xt, yt), mae(Xv, yv), Xv, yv


def rw(M):
    return [[round(float(x), 6) for x in row] for row in M]


def rv(v):
    return [round(float(x), 6) for x in v]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--out")
    ap.add_argument("--hidden", type=int, default=32)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--lr", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument(
        "--target",
        choices=["pWin_true", "won", "pWin_belief"],
        default="pWin_true",
        help="what the head learns; 'won' is the W/L baseline 18.6b argues against",
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    meta, X, rows = load_dataset(args.dataset)
    y = np.array([float(r[args.target]) for r in rows], dtype=np.float64)
    print(
        f"{len(X)} samples, {X.shape[1]} floats, target {args.target}, "
        f"teacher {meta.get('teacher')}"
    )

    (W0, b0, W1, b1), train_mae, val_mae, Xv, yv = train(
        X, y, args.hidden, args.epochs, args.lr, args.seed, not args.quiet
    )

    # The constant baseline, on the same held-out rows.
    base = float(np.abs(yv - y.mean()).mean()) if len(yv) else 0.0
    print(f"val mae {val_mae:.4f} on {len(yv)} held out (constant-mean floor {base:.4f})")
    if val_mae >= base:
        print("  WARNING: the head does not beat predicting the mean")

    model = {
        "v": VALUE_VERSION,
        "kind": "value",
        "target": args.target,
        "obsVersion": meta["obsVersion"],
        "prwVersion": meta.get("prwVersion"),
        "activation": "tanh",
        "output": "sigmoid",
        "teacher": meta.get("teacher"),
        "dataset": Path(args.dataset).name,
        "valMae": round(val_mae, 5),
        "baselineMae": round(base, 5),
        "layers": [
            {"W": rw(W0), "b": rv(b0)},
            {"W": rw(W1), "b": rv(b1)},
        ],
    }
    out = args.out or str(Path(args.dataset).parent.parent / "models" / "value0.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(model, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
