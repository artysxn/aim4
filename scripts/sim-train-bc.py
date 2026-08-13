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
# Generation 0 is a small MLP cloning the scripted desire arbiter. v3 (default)
# adds SIM-PLAN 9.3b last-query attention over 12 steps of history plus map
# and contract-position embeddings. --temporal 0 writes the old v1/v2 MLP.
#
# P4 adds 9.3's player-mimic embedding, trained jointly (10.3 layer 1): when
# the dataset is v2 — every sample carries a player key — each key gets a
# 16-d vector (--embed-dim, 0 disables) that is concatenated onto the
# observation before the first layer, and the gradient flows back into the
# table through plain numpy scatter-adds. The export gains
# {"embed": {"dim", "default", "players"}} and sets "v": 2; the default row is
# the average of the trained rows and is what policy.js hands unseen players.
# With --embed-dim 0 nothing changes: the code path, the rng stream and the
# output schema are exactly the v1 trainer's, so old invocations on old
# datasets keep producing the same bytes.
#
# Run with the project venv:
#   .venv-sim/bin/python scripts/sim-train-bc.py <dataset.jsonl> [--out model.json]
#   .venv-sim/bin/python scripts/sim-train-bc.py --epochs 80 --hidden 64
#   .venv-sim/bin/python scripts/sim-train-bc.py bc.jsonl --embed-dim 16
# -----------------------------------------------------------------------------

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# The max model version policy.js loads; --embed-dim 0 still writes v1 unless temporal is on.
POLICY_VERSION = 3


def load_dataset(path):
    with open(path) as f:
        lines = [line for line in f.read().splitlines() if line.strip()]
    meta = json.loads(lines[0])
    if meta.get("type") != "meta" or meta.get("v") not in (1, 2, 3):
        sys.exit(f"unrecognized dataset header in {path}")
    rows = [json.loads(line) for line in lines[1:]]
    X = np.array([r["obs"] for r in rows], dtype=np.float64)
    vocab = list(meta["vocab"])
    index = {label: i for i, label in enumerate(vocab)}
    y = np.array([index[r["label"]] for r in rows], dtype=np.int64)
    if X.shape[1] != meta["obsSize"]:
        sys.exit(f"dataset says obsSize {meta['obsSize']}, rows carry {X.shape[1]}")
    # v2: every row names its player. Sorted keys, so the same dataset always
    # produces the same index order and therefore the same trained bytes.
    pkeys, p = [], None
    if meta["v"] >= 2:
        if any("player" not in r for r in rows):
            sys.exit(f"v2 dataset {path} has rows without a player key")
        pkeys = sorted({r["player"] for r in rows})
        kidx = {k: i for i, k in enumerate(pkeys)}
        p = np.array([kidx[r["player"]] for r in rows], dtype=np.int64)
    return meta, X, y, vocab, pkeys, p, rows


def train(X, y, n_out, hidden, epochs, lr, seed, log, p=None, embed_dim=0, n_players=0):
    rng = np.random.default_rng(seed)
    n, d = X.shape

    # Shuffle once, hold out a fifth: the number that matters is validation
    # accuracy, and reporting train accuracy would be grading one's own exam.
    order = rng.permutation(n)
    X, y = X[order], y[order]
    if embed_dim:
        p = p[order]
    cut = max(1, int(n * 0.8))
    Xt, yt, Xv, yv = X[:cut], y[:cut], X[cut:], y[cut:]
    pt, pv = (p[:cut], p[cut:]) if embed_dim else (None, None)

    # With embeddings the first layer reads obs + embed; when disabled, every
    # draw below matches the v1 trainer exactly (no extra rng consumption).
    din = d + embed_dim
    W0 = rng.normal(0, 1 / np.sqrt(din), (hidden, din))
    b0 = np.zeros(hidden)
    W1 = rng.normal(0, 1 / np.sqrt(hidden), (n_out, hidden))
    b1 = np.zeros(n_out)
    EMB = rng.normal(0, 1 / np.sqrt(embed_dim), (n_players, embed_dim)) if embed_dim else None

    # Class weights: the teacher holds far more than it swings, and an
    # unweighted fit collapses onto "hold everything". Inverse-frequency,
    # capped so rare labels do not dominate either.
    counts = np.bincount(yt, minlength=n_out).astype(np.float64)
    weights = np.where(counts > 0, len(yt) / (np.maximum(counts, 1) * n_out), 0.0)
    weights = np.minimum(weights, 8.0)

    def forward(Xb, pb=None):
        Xf = np.concatenate([Xb, EMB[pb]], axis=1) if embed_dim else Xb
        H = np.tanh(Xf @ W0.T + b0)
        Z = H @ W1.T + b1
        Z -= Z.max(axis=1, keepdims=True)
        E = np.exp(Z)
        P = E / E.sum(axis=1, keepdims=True)
        return Xf, H, P

    def accuracy(Xb, yb, pb=None):
        _, _, P = forward(Xb, pb)
        return float((P.argmax(axis=1) == yb).mean()) if len(yb) else 0.0

    batch = 256
    for epoch in range(epochs):
        perm = rng.permutation(len(Xt))
        for start in range(0, len(Xt), batch):
            idx = perm[start : start + batch]
            Xb, yb = Xt[idx], yt[idx]
            pb = pt[idx] if embed_dim else None
            Xf, H, P = forward(Xb, pb)
            G = P.copy()
            G[np.arange(len(yb)), yb] -= 1.0
            G *= weights[yb][:, None] / len(yb)

            gW1 = G.T @ H
            gb1 = G.sum(axis=0)
            GH = (G @ W1) * (1 - H * H)
            gW0 = GH.T @ Xf
            gb0 = GH.sum(axis=0)
            if embed_dim:
                # The embedding columns of the input gradient, scattered back
                # onto each sample's row (add.at handles repeats in a batch).
                # Read W0 BEFORE it steps, like every other gradient here.
                gX = GH @ W0[:, d:]
                gEMB = np.zeros_like(EMB)
                np.add.at(gEMB, pb, gX)
                EMB -= lr * gEMB

            W1 -= lr * gW1
            b1 -= lr * gb1
            W0 -= lr * gW0
            b0 -= lr * gb0
        if log and (epoch + 1) % 10 == 0:
            print(
                f"  epoch {epoch + 1:3d}  train {accuracy(Xt, yt, pt):.3f}  val {accuracy(Xv, yv, pv):.3f}"
            )

    return (W0, b0, W1, b1, EMB), accuracy(Xt, yt, pt), accuracy(Xv, yv, pv), len(Xv)


def stack_history(rows, T, d):
    n = len(rows)
    H = np.zeros((n, T, d), dtype=np.float64)
    for i, r in enumerate(rows):
        obs = np.asarray(r["obs"], dtype=np.float64)
        past = [
            np.asarray(p, dtype=np.float64)
            for p in (r.get("hist") or [])
            if hasattr(p, "__len__") and len(p) == d
        ][-(T - 1) :]
        frames = list(past)
        while len(frames) < T - 1:
            frames.insert(0, obs.copy())
        frames.append(obs)
        H[i] = np.stack(frames)
    return H


def keys_of(rows, field):
    return sorted({str(r.get(field) or "") for r in rows if str(r.get(field) or "")})


def index_or_default(keys, value):
    try:
        return keys.index(str(value or ""))
    except ValueError:
        return -1


def train_v3(H, y, maps, contracts, p, n_out, hidden, epochs, lr, seed, log, embed_dim, map_dim, contract_dim, d_model):
    rng = np.random.default_rng(seed)
    n, T, din = H.shape
    order = rng.permutation(n)
    H, y = H[order], y[order]
    maps, contracts = maps[order], contracts[order]
    if embed_dim:
        p = p[order]
    cut = max(1, int(n * 0.8))
    Ht, Hv = H[:cut], H[cut:]
    yt, yv = y[:cut], y[cut:]
    mt, mv = maps[:cut], maps[cut:]
    ct, cv = contracts[:cut], contracts[cut:]
    pt, pv = (p[:cut], p[cut:]) if embed_dim else (None, None)

    Win = rng.normal(0, 1 / np.sqrt(din), (d_model, din))
    bin_ = np.zeros(d_model)
    Wo = rng.normal(0, 1 / np.sqrt(d_model), (d_model, d_model))
    bo = np.zeros(d_model)
    n_players = int(p.max()) + 1 if embed_dim else 0
    EMB = rng.normal(0, 1 / np.sqrt(embed_dim), (n_players, embed_dim)) if embed_dim else None
    n_maps = int(maps.max()) + 1 if map_dim and maps.size and maps.max() >= 0 else 0
    n_con = int(contracts.max()) + 1 if contract_dim and contracts.size and contracts.max() >= 0 else 0
    EM = rng.normal(0, 1 / np.sqrt(map_dim), (max(n_maps, 1), map_dim)) if map_dim else None
    EC = rng.normal(0, 1 / np.sqrt(contract_dim), (max(n_con, 1), contract_dim)) if contract_dim else None
    EMd = np.zeros(map_dim) if map_dim else None
    ECd = np.zeros(contract_dim) if contract_dim else None

    cond = d_model + embed_dim + map_dim + contract_dim
    W0 = rng.normal(0, 1 / np.sqrt(cond), (hidden, cond))
    b0 = np.zeros(hidden)
    W1 = rng.normal(0, 1 / np.sqrt(hidden), (n_out, hidden))
    b1 = np.zeros(n_out)

    counts = np.bincount(yt, minlength=n_out).astype(np.float64)
    weights = np.where(counts > 0, len(yt) / (np.maximum(counts, 1) * n_out), 0.0)
    weights = np.minimum(weights, 8.0)
    scale = 1.0 / np.sqrt(d_model)

    def cond_rows(pb, mb, cb):
        parts = []
        if embed_dim:
            parts.append(EMB[pb])
        if map_dim:
            rows = np.repeat(EMd[None, :], len(mb), axis=0)
            ok = mb >= 0
            if n_maps:
                rows[ok] = EM[np.clip(mb[ok], 0, n_maps - 1)]
            parts.append(rows)
        if contract_dim:
            rows = np.repeat(ECd[None, :], len(cb), axis=0)
            ok = cb >= 0
            if n_con:
                rows[ok] = EC[np.clip(cb[ok], 0, n_con - 1)]
            parts.append(rows)
        return parts

    def temporal(Hb):
        preZ = Hb @ Win.T + bin_
        Z = np.tanh(preZ)
        q = Z[:, -1, :]
        scores = (Z * q[:, None, :]).sum(axis=2) * scale
        scores = scores - scores.max(axis=1, keepdims=True)
        exp = np.exp(scores)
        a = exp / exp.sum(axis=1, keepdims=True)
        ctx = (a[:, :, None] * Z).sum(axis=1)
        preU = ctx @ Wo.T + bo
        u = np.tanh(preU)
        return Z, a, q, ctx, preU, u, preZ

    def forward(Hb, pb, mb, cb):
        Z, a, q, ctx, preU, u, preZ = temporal(Hb)
        parts = [u, *cond_rows(pb, mb, cb)]
        Xf = np.concatenate(parts, axis=1)
        hid = np.tanh(Xf @ W0.T + b0)
        Zout = hid @ W1.T + b1
        Zout = Zout - Zout.max(axis=1, keepdims=True)
        P = np.exp(Zout)
        P = P / P.sum(axis=1, keepdims=True)
        return P, hid, Xf, u, Z, a, q, ctx, preZ

    def accuracy(Hb, yb, pb, mb, cb):
        P, *_ = forward(Hb, pb, mb, cb)
        return float((P.argmax(axis=1) == yb).mean()) if len(yb) else 0.0

    batch = 64
    for epoch in range(epochs):
        perm = rng.permutation(len(yt))
        for start in range(0, len(yt), batch):
            idx = perm[start : start + batch]
            Hb, yb = Ht[idx], yt[idx]
            pb = pt[idx] if embed_dim else None
            mb, cb = mt[idx], ct[idx]
            P, hid, Xf, u, Z, a, q, ctx, preZ = forward(Hb, pb, mb, cb)
            G = P.copy()
            G[np.arange(len(yb)), yb] -= 1.0
            G *= weights[yb][:, None] / len(yb)

            gW1 = G.T @ hid
            gb1 = G.sum(axis=0)
            GH = (G @ W1) * (1 - hid * hid)
            gW0 = GH.T @ Xf
            gb0 = GH.sum(axis=0)
            gXf = GH @ W0

            col = 0
            dU = gXf[:, col : col + d_model]
            col += d_model
            if embed_dim:
                gX = gXf[:, col : col + embed_dim]
                gEMB = np.zeros_like(EMB)
                np.add.at(gEMB, pb, gX)
                EMB -= lr * gEMB
                col += embed_dim
            if map_dim:
                gM = gXf[:, col : col + map_dim]
                ok = mb >= 0
                if n_maps and ok.any():
                    gEM = np.zeros_like(EM)
                    np.add.at(gEM, np.clip(mb[ok], 0, n_maps - 1), gM[ok])
                    EM -= lr * gEM
                EMd -= lr * gM.mean(axis=0)
                col += map_dim
            if contract_dim:
                gC = gXf[:, col : col + contract_dim]
                ok = cb >= 0
                if n_con and ok.any():
                    gEC = np.zeros_like(EC)
                    np.add.at(gEC, np.clip(cb[ok], 0, n_con - 1), gC[ok])
                    EC -= lr * gEC
                ECd -= lr * gC.mean(axis=0)

            dpreU = dU * (1 - u * u)
            gWo = dpreU.T @ ctx
            gbo = dpreU.sum(axis=0)
            dctx = dpreU @ Wo
            dA = (dctx[:, None, :] * Z).sum(axis=2)
            dZ = a[:, :, None] * dctx[:, None, :]
            s = (dA * a).sum(axis=1, keepdims=True)
            dScores = a * (dA - s)
            dZ = dZ + dScores[:, :, None] * (q[:, None, :] * scale)
            dZ[:, -1, :] += (dScores[:, :, None] * Z * scale).sum(axis=1)
            dpreZ = dZ * (1 - Z * Z)
            gWin = np.einsum("btd,btn->dn", dpreZ, Hb)
            gbin = dpreZ.sum(axis=(0, 1))

            W1 -= lr * gW1
            b1 -= lr * gb1
            W0 -= lr * gW0
            b0 -= lr * gb0
            Wo -= lr * gWo
            bo -= lr * gbo
            Win -= lr * gWin
            bin_ -= lr * gbin
        if log and (epoch + 1) % 10 == 0:
            print(
                f"  epoch {epoch + 1:3d}  train {accuracy(Ht, yt, pt, mt, ct):.3f}  val {accuracy(Hv, yv, pv, mv, cv):.3f}"
            )

    pack = {
        "Win": Win,
        "bin": bin_,
        "Wo": Wo,
        "bo": bo,
        "W0": W0,
        "b0": b0,
        "W1": W1,
        "b1": b1,
        "EMB": EMB,
        "EM": EM,
        "EC": EC,
        "EMd": EMd,
        "ECd": ECd,
    }
    return pack, accuracy(Ht, yt, pt, mt, ct), accuracy(Hv, yv, pv, mv, cv), len(Hv)


def rw(arr):
    return [[round(float(w), 6) for w in row] for row in arr]


def rv(arr):
    return [round(float(v), 6) for v in arr]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--out", default=None)
    ap.add_argument("--hidden", type=int, default=None)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--lr", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument(
        "--embed-dim",
        type=int,
        default=None,
        help="player embedding width; 0 disables (v1 output); default 16 on v2 datasets",
    )
    ap.add_argument("--temporal", type=int, default=1, help="1 = last-query history (v3); 0 = MLP")
    ap.add_argument("--history", type=int, default=12)
    ap.add_argument("--d-model", type=int, default=64)
    ap.add_argument("--map-dim", type=int, default=8)
    ap.add_argument("--contract-dim", type=int, default=16)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    meta, X, y, vocab, pkeys, p, rows = load_dataset(args.dataset)
    embed_dim = args.embed_dim if args.embed_dim is not None else (16 if pkeys else 0)
    if embed_dim < 0:
        sys.exit(f"--embed-dim {embed_dim} makes no sense; 0 disables the embedding")
    if embed_dim and not pkeys:
        sys.exit("--embed-dim needs a v2 dataset that carries player keys")
    temporal = bool(args.temporal)
    hidden = args.hidden if args.hidden is not None else (256 if temporal else 64)
    print(f"{len(X)} samples, {X.shape[1]} floats, {len(vocab)} options, teacher {meta.get('teacher')}")
    if embed_dim:
        print(f"joint player embedding: {embed_dim}-d over {len(pkeys)} keys")
    if temporal:
        print(f"v3 last-query history: T={args.history} dModel={args.d_model} hidden={hidden}")

    pack = None
    map_keys = []
    con_keys = []
    if temporal:
        map_keys = keys_of(rows, "map")
        con_keys = keys_of(rows, "contract")
        maps = np.array([index_or_default(map_keys, r.get("map")) for r in rows], dtype=np.int64)
        cons = np.array([index_or_default(con_keys, r.get("contract")) for r in rows], dtype=np.int64)
        Hh = stack_history(rows, args.history, X.shape[1])
        pack, train_acc, val_acc, n_val = train_v3(
            Hh, y, maps, cons, p, len(vocab), hidden, args.epochs, args.lr, args.seed,
            not args.quiet, embed_dim, args.map_dim, args.contract_dim, args.d_model,
        )
        W0, b0, W1, b1, EMB = pack["W0"], pack["b0"], pack["W1"], pack["b1"], pack["EMB"]
    else:
        (W0, b0, W1, b1, EMB), train_acc, val_acc, n_val = train(
            X, y, len(vocab), hidden, args.epochs, args.lr, args.seed, not args.quiet,
            p=p, embed_dim=embed_dim, n_players=len(pkeys),
        )

    majority = float(np.bincount(y, minlength=len(vocab)).max() / len(y))
    print(f"val accuracy {val_acc:.3f} on {n_val} held out (majority-class floor {majority:.3f})")

    model = {
        "v": 3 if temporal else (2 if embed_dim else 1),
        "obsVersion": meta["obsVersion"],
        "vocab": vocab,
        "activation": "tanh",
        "teacher": meta.get("teacher"),
        "dataset": Path(args.dataset).name,
        "valAccuracy": round(val_acc, 4),
    }
    if temporal:
        model["v"] = 3
        model["temporal"] = {
            "steps": args.history,
            "dModel": args.d_model,
            "inProj": {"W": rw(pack["Win"]), "b": rv(pack["bin"])},
            "attnOut": {"W": rw(pack["Wo"]), "b": rv(pack["bo"])},
        }
    else:
        model["v"] = 2 if embed_dim else 1
    if embed_dim or (temporal and (args.map_dim or args.contract_dim)):
        model["embed"] = {}
        if embed_dim:
            model["embed"]["dim"] = embed_dim
            model["embed"]["default"] = rv(EMB.mean(axis=0))
            model["embed"]["players"] = {k: rv(EMB[i]) for i, k in enumerate(pkeys)}
        if temporal and args.map_dim:
            model["embed"]["map"] = {
                "dim": args.map_dim,
                "default": rv(pack["EMd"]),
                "keys": {k: rv(pack["EM"][i]) for i, k in enumerate(map_keys)},
            }
        if temporal and args.contract_dim:
            model["embed"]["contract"] = {
                "dim": args.contract_dim,
                "default": rv(pack["ECd"]),
                "keys": {k: rv(pack["EC"][i]) for i, k in enumerate(con_keys)},
            }
        if not model["embed"]:
            del model["embed"]
    model["layers"] = [
        {"W": rw(W0), "b": rv(b0)},
        {"W": rw(W1), "b": rv(b1)},
    ]
    out = args.out or str(Path(args.dataset).parent.parent / "models" / "bc0.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(model, f)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
