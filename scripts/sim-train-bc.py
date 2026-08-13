#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# scripts/sim-train-bc.py
# The BC trainer: JSONL dataset in, JSON weights out.
#
# SIM-PLAN 9.3's split, honored exactly: training happens here in Python where
# iteration is cheap, inference happens in shared/sim/policy.js where the bots
# run, and the artifact between them is a JSON file that carries its versions.
# The forward pass on the JS side is a two-line loop, so the architecture here
# stays inside what that loop can express: dense layers, tanh, softmax head.
#
# Generation 0 is a small MLP cloning the scripted desire arbiter. It does not
# need to be clever; it needs the PIPELINE to be real, so that when pro-labeled
# datasets arrive the only change is the input file.
#
# Run with the project venv:
#   .venv-sim/bin/python scripts/sim-train-bc.py <dataset.jsonl> [--out model.json]
#   .venv-sim/bin/python scripts/sim-train-bc.py --epochs 80 --hidden 64
# -----------------------------------------------------------------------------

import argparse
import json
import sys
from pathlib import Path

import numpy as np

POLICY_VERSION = 1


def load_dataset(path):
    with open(path) as f:
        lines = [line for line in f.read().splitlines() if line.strip()]
    meta = json.loads(lines[0])
    if meta.get("type") != "meta" or meta.get("v") != 1:
        sys.exit(f"unrecognized dataset header in {path}")
    rows = [json.loads(line) for line in lines[1:]]
    X = np.array([r["obs"] for r in rows], dtype=np.float64)
    vocab = list(meta["vocab"])
    index = {label: i for i, label in enumerate(vocab)}
    y = np.array([index[r["label"]] for r in rows], dtype=np.int64)
    if X.shape[1] != meta["obsSize"]:
        sys.exit(f"dataset says obsSize {meta['obsSize']}, rows carry {X.shape[1]}")
    return meta, X, y, vocab


def train(X, y, n_out, hidden, epochs, lr, seed, log):
    rng = np.random.default_rng(seed)
    n, d = X.shape

    # Shuffle once, hold out a fifth: the number that matters is validation
    # accuracy, and reporting train accuracy would be grading one's own exam.
    order = rng.permutation(n)
    X, y = X[order], y[order]
    cut = max(1, int(n * 0.8))
    Xt, yt, Xv, yv = X[:cut], y[:cut], X[cut:], y[cut:]

    W0 = rng.normal(0, 1 / np.sqrt(d), (hidden, d))
    b0 = np.zeros(hidden)
    W1 = rng.normal(0, 1 / np.sqrt(hidden), (n_out, hidden))
    b1 = np.zeros(n_out)

    # Class weights: the teacher holds far more than it swings, and an
    # unweighted fit collapses onto "hold everything". Inverse-frequency,
    # capped so rare labels do not dominate either.
    counts = np.bincount(yt, minlength=n_out).astype(np.float64)
    weights = np.where(counts > 0, len(yt) / (np.maximum(counts, 1) * n_out), 0.0)
    weights = np.minimum(weights, 8.0)

    def forward(Xb):
        H = np.tanh(Xb @ W0.T + b0)
        Z = H @ W1.T + b1
        Z -= Z.max(axis=1, keepdims=True)
        E = np.exp(Z)
        P = E / E.sum(axis=1, keepdims=True)
        return H, P

    def accuracy(Xb, yb):
        _, P = forward(Xb)
        return float((P.argmax(axis=1) == yb).mean()) if len(yb) else 0.0

    batch = 256
    for epoch in range(epochs):
        perm = rng.permutation(len(Xt))
        for start in range(0, len(Xt), batch):
            idx = perm[start : start + batch]
            Xb, yb = Xt[idx], yt[idx]
            H, P = forward(Xb)
            G = P.copy()
            G[np.arange(len(yb)), yb] -= 1.0
            G *= weights[yb][:, None] / len(yb)

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
            print(f"  epoch {epoch + 1:3d}  train {accuracy(Xt, yt):.3f}  val {accuracy(Xv, yv):.3f}")

    return (W0, b0, W1, b1), accuracy(Xt, yt), accuracy(Xv, yv), len(Xv)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--out", default=None)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--lr", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    meta, X, y, vocab = load_dataset(args.dataset)
    print(f"{len(X)} samples, {X.shape[1]} floats, {len(vocab)} options, teacher {meta.get('teacher')}")

    (W0, b0, W1, b1), train_acc, val_acc, n_val = train(
        X, y, len(vocab), args.hidden, args.epochs, args.lr, args.seed, not args.quiet
    )
    majority = float(np.bincount(y, minlength=len(vocab)).max() / len(y))
    print(f"val accuracy {val_acc:.3f} on {n_val} held out (majority-class floor {majority:.3f})")

    model = {
        "v": POLICY_VERSION,
        "obsVersion": meta["obsVersion"],
        "vocab": vocab,
        "activation": "tanh",
        "teacher": meta.get("teacher"),
        "dataset": Path(args.dataset).name,
        "valAccuracy": round(val_acc, 4),
        "layers": [
            {"W": [[round(float(w), 6) for w in row] for row in W0], "b": [round(float(v), 6) for v in b0]},
            {"W": [[round(float(w), 6) for w in row] for row in W1], "b": [round(float(v), 6) for v in b1]},
        ],
    }
    out = args.out or str(Path(args.dataset).parent.parent / "models" / "bc0.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(model, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
