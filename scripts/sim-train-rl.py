#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# scripts/sim-train-rl.py
# Numpy PPO fine-tune of a BC policy JSON.
#
# SIM-PLAN 9.4: training happens here (Python, iteration is cheap), inference
# stays in shared/sim/policy.js, and the artefact is the SAME JSON schema
# loadPolicy already reads — v, obsVersion, vocab, activation: tanh, layers,
# optional embed. No pytorch, no new pip deps. The BC trainer is numpy and
# this file is numpy; a generation that cannot load in the bot is not a
# generation.
#
# The leash is KL(π ‖ π_BC), coefficient 0.05 to 0.2, "annealed but never to
# zero". This spine does not anneal: --kl-coef defaults to 0.1 and is floored
# at 0.05 whenever --init is set, because a leash that disappears is how a
# clone forgets it was a clone. PPO clip 0.2, entropy 0.005, γ from the
# dataset meta (9.4's 0.999).
#
# No critic in the JSONL yet, so advantages are Monte Carlo returns from
# `reward` + `done`, computed per side so interleaved T/CT samples do not
# bootstrap through each other, then normalized. SIM-PLAN 9.10: if a sample
# carries ownReward and teamReward they are mixed at --tau (default 0.3);
# otherwise `reward` is used as-is.
#
# A spine that runs, not a research trainer. Under ~400 lines on purpose.
#
#   .venv-sim/bin/python scripts/sim-train-rl.py rl.jsonl --init simdata/models/bc0.json
#   .venv-sim/bin/python scripts/sim-train-rl.py rl.jsonl --init bc0.json --epochs 8 --out rl1.json
# -----------------------------------------------------------------------------

import argparse
import json
import sys
from pathlib import Path

import numpy as np

POLICY_VERSION = 2
CLIP = 0.2
KL_FLOOR = 0.05


def load_dataset(path):
    with open(path) as f:
        lines = [line for line in f.read().splitlines() if line.strip()]
    meta = json.loads(lines[0])
    if meta.get("type") != "meta" or meta.get("kind") != "rl":
        sys.exit(f"unrecognized RL dataset header in {path}")
    rows = [json.loads(line) for line in lines[1:]]
    if not rows:
        sys.exit(f"no samples in {path}")
    X = np.array([r["obs"] for r in rows], dtype=np.float64)
    vocab = list(meta["vocab"])
    index = {label: i for i, label in enumerate(vocab)}
    y = np.array([index[r["label"]] for r in rows], dtype=np.int64)
    if X.shape[1] != meta["obsSize"]:
        sys.exit(f"dataset says obsSize {meta['obsSize']}, rows carry {X.shape[1]}")
    sides = [r.get("side", "T") for r in rows]
    players = [r.get("player") for r in rows]
    dones = np.array([1.0 if r.get("done") else 0.0 for r in rows], dtype=np.float64)
    wins = np.array([float(r["win"]) if "win" in r else np.nan for r in rows], dtype=np.float64)
    return meta, rows, X, y, vocab, sides, players, dones, wins


def mix_rewards(rows, tau):
    out = np.empty(len(rows), dtype=np.float64)
    for i, r in enumerate(rows):
        if "ownReward" in r and "teamReward" in r:
            out[i] = (1.0 - tau) * r["ownReward"] + tau * r["teamReward"]
        else:
            out[i] = r["reward"]
    return out


def discounted_returns(rewards, dones, gamma):
    n = len(rewards)
    G = np.zeros(n, dtype=np.float64)
    acc = 0.0
    for t in range(n - 1, -1, -1):
        acc = rewards[t] + gamma * acc * (1.0 - dones[t])
        G[t] = acc
    return G


def returns_by_side(rewards, dones, sides, gamma):
    G = np.zeros(len(rewards), dtype=np.float64)
    for side in ("T", "CT"):
        idx = [i for i, s in enumerate(sides) if s == side]
        if not idx:
            continue
        g = discounted_returns(rewards[idx], dones[idx], gamma)
        G[idx] = g
    return G


def load_init(path):
    with open(path) as f:
        model = json.load(f)
    layers = model.get("layers") or []
    if len(layers) < 2:
        sys.exit(f"--init {path} has no two-layer MLP")
    W0 = np.array(layers[0]["W"], dtype=np.float64)
    b0 = np.array(layers[0]["b"], dtype=np.float64)
    W1 = np.array(layers[1]["W"], dtype=np.float64)
    b1 = np.array(layers[1]["b"], dtype=np.float64)
    return model, W0, b0, W1, b1


def table_rows(spec, keys):
    dim = int(spec["dim"])
    default = np.array(spec["default"], dtype=np.float64)
    table = spec.get("keys") or spec.get("maps") or spec.get("contracts") or spec.get("players") or {}
    E = np.zeros((len(keys), dim), dtype=np.float64)
    for i, key in enumerate(keys):
        row = table.get(str(key or ""))
        E[i] = np.array(row, dtype=np.float64) if row is not None else default
    return E


def embed_matrix(embed, players):
    if not embed or not embed.get("dim"):
        return None
    return table_rows({ "dim": embed["dim"], "default": embed["default"], "keys": embed.get("players") or {} }, players)


def encode_v3(H, temporal):
    Win = np.array(temporal["inProj"]["W"], dtype=np.float64)
    bin_ = np.array(temporal["inProj"]["b"], dtype=np.float64)
    Wo = np.array(temporal["attnOut"]["W"], dtype=np.float64)
    bo = np.array(temporal["attnOut"]["b"], dtype=np.float64)
    Z = np.tanh(H @ Win.T + bin_)
    q = Z[:, -1, :]
    scale = 1.0 / np.sqrt(q.shape[1])
    scores = (Z * q[:, None, :]).sum(axis=2) * scale
    scores = scores - scores.max(axis=1, keepdims=True)
    a = np.exp(scores)
    a = a / a.sum(axis=1, keepdims=True)
    ctx = (a[:, :, None] * Z).sum(axis=1)
    return np.tanh(ctx @ Wo.T + bo)


def stack_obs_history(rows, T, d):
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


def softmax(Z):
    Z = Z - Z.max(axis=1, keepdims=True)
    E = np.exp(Z)
    return E / E.sum(axis=1, keepdims=True)


def forward(X, W0, b0, W1, b1):
    H = np.tanh(X @ W0.T + b0)
    Z = H @ W1.T + b1
    P = softmax(Z)
    return H, Z, P


def dump_model(path, meta, vocab, W0, b0, W1, b1, init, teacher="ppo"):
    embed = (init or {}).get("embed") if init else None
    model = {
        "v": (init or {}).get("v") or (POLICY_VERSION if embed else 1),
        "obsVersion": meta["obsVersion"],
        "vocab": vocab,
        "activation": "tanh",
        "teacher": teacher,
        "dataset": Path(meta.get("dataset") or "").name or None,
    }
    if embed:
        model["embed"] = embed
    if init and init.get("temporal"):
        model["v"] = 3
        model["temporal"] = init["temporal"]
    model["layers"] = [
        {"W": [[round(float(w), 6) for w in row] for row in W0], "b": [round(float(v), 6) for v in b0]},
        {"W": [[round(float(w), 6) for w in row] for row in W1], "b": [round(float(v), 6) for v in b1]},
    ]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(model, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--out", default=None)
    ap.add_argument("--init", default=None, help="BC policy JSON to fine-tune (required for the KL leash)")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--kl-coef", type=float, default=0.1)
    ap.add_argument("--entropy", type=float, default=0.005)
    ap.add_argument("--tau", type=float, default=0.3)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--aux", action="store_true", help="train a dropped value/win head (9.14)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    meta, rows, Xobs, y, vocab, sides, players, dones, wins = load_dataset(args.dataset)
    gamma = float(meta.get("gamma") or 0.999)
    n_out = len(vocab)
    rewards = mix_rewards(rows, args.tau)
    adv_mc = returns_by_side(rewards, dones, sides, gamma)

    init = None
    embed = None
    if args.init:
        init, W0, b0, W1, b1 = load_init(args.init)
        if list(init.get("vocab") or []) != vocab:
            sys.exit("--init vocab does not match the dataset")
        if init.get("obsVersion") != meta["obsVersion"]:
            sys.exit("--init obsVersion does not match the dataset")
        embed = init.get("embed")
        kl_coef = max(args.kl_coef, KL_FLOOR)
    else:
        rng = np.random.default_rng(args.seed)
        hidden = args.hidden
        din = Xobs.shape[1]
        W0 = rng.normal(0, 1 / np.sqrt(din), (hidden, din))
        b0 = np.zeros(hidden)
        W1 = rng.normal(0, 1 / np.sqrt(hidden), (n_out, hidden))
        b1 = np.zeros(n_out)
        kl_coef = 0.0

    hidden_n = W0.shape[0]
    rng_v = np.random.default_rng(args.seed + 1)
    Wv = rng_v.normal(0, 1 / np.sqrt(hidden_n), hidden_n)
    bv = 0.0
    Waux = rng_v.normal(0, 1 / np.sqrt(hidden_n), hidden_n)
    baux = 0.0
    has_aux = args.aux and np.isfinite(wins).any()

    E = embed_matrix(embed, players)
    if init and init.get("v") == 3 and init.get("temporal"):
        T = int(init["temporal"]["steps"])
        U = encode_v3(stack_obs_history(rows, T, Xobs.shape[1]), init["temporal"])
        extras = [U]
        if E is not None:
            extras.append(E)
        if embed and embed.get("map"):
            extras.append(table_rows(embed["map"], [r.get("map") for r in rows]))
        if embed and embed.get("contract"):
            extras.append(table_rows(embed["contract"], [r.get("contract") for r in rows]))
        X = np.concatenate(extras, axis=1)
    else:
        X = np.concatenate([Xobs, E], axis=1) if E is not None else Xobs
    if W0.shape[1] != X.shape[1]:
        sys.exit(f"first layer reads {W0.shape[1]}, observations carry {X.shape[1]}")
    if W1.shape[0] != n_out:
        sys.exit(f"head emits {W1.shape[0]} logits for a {n_out}-word vocabulary")

    H0, _, _ = forward(X, W0, b0, W1, b1)
    V0 = H0 @ Wv + bv
    adv = adv_mc - V0
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)

    _, _, P_bc = forward(X, W0.copy(), b0.copy(), W1.copy(), b1.copy()) if args.init else (None, None, None)
    logp_old = np.log(P_bc[np.arange(len(y)), y] + 1e-12) if P_bc is not None else None

    n = len(y)
    order = np.arange(n)
    cut = max(1, int(n * 0.8))
    print(f"{n} samples, {Xobs.shape[1]} floats, {n_out} options, teacher ppo")
    if args.init:
        print(f"init {args.init}  kl-coef {kl_coef} (floor {KL_FLOOR})")

    batch = 256
    rng = np.random.default_rng(args.seed)
    last_clip = 0.0
    last_lp = 0.0
    for epoch in range(args.epochs):
        perm = rng.permutation(cut)
        clip_hits = 0
        clip_n = 0
        for start in range(0, cut, batch):
            idx = perm[start : start + batch]
            Xb, yb, Ab = X[idx], y[idx], adv[idx]
            mb = len(yb)
            H, _, P = forward(Xb, W0, b0, W1, b1)
            logP = np.log(P + 1e-12)
            logp_a = logP[np.arange(mb), yb]
            if logp_old is not None:
                ratio = np.exp(logp_a - logp_old[idx])
            else:
                ratio = np.ones(mb)
            surr1 = ratio * Ab
            surr2 = np.clip(ratio, 1.0 - CLIP, 1.0 + CLIP) * Ab
            use_unclipped = surr1 <= surr2
            d_ratio = np.where(use_unclipped, -Ab / mb, 0.0)
            d_logp_a = d_ratio * ratio
            onehot = np.zeros_like(P)
            onehot[np.arange(mb), yb] = 1.0
            dZ = (onehot - P) * d_logp_a[:, None]

            Hent = -(P * logP).sum(axis=1, keepdims=True)
            dZ += (args.entropy / mb) * P * (Hent + logP)

            if P_bc is not None and kl_coef:
                Q = np.clip(P_bc[idx], 1e-12, 1.0)
                logQ = np.log(Q)
                kl = (P * (logP - logQ)).sum(axis=1, keepdims=True)
                dZ += (kl_coef / mb) * P * ((logP - logQ) - kl)

            gW1 = dZ.T @ H
            gb1 = dZ.sum(axis=0)
            dH = (dZ @ W1) * (1 - H * H)
            gW0 = dH.T @ Xb
            gb0 = dH.sum(axis=0)
            W1 -= args.lr * gW1
            b1 -= args.lr * gb1
            W0 -= args.lr * gW0
            b0 -= args.lr * gb0
            # Critic and aux heads stay in Python (9.4 / 9.14): dropped at export.
            Vb = H @ Wv + bv
            Gb = adv_mc[idx]
            dV = (2.0 / mb) * (Vb - Gb)
            Wv -= args.lr * (H.T @ dV)
            bv -= args.lr * float(dV.sum())
            if has_aux:
                yb_win = wins[idx]
                mask = np.isfinite(yb_win)
                if mask.any():
                    pred = H[mask] @ Waux + baux
                    dA = (2.0 / mask.sum()) * (pred - yb_win[mask])
                    Waux -= args.lr * (H[mask].T @ dA)
                    baux -= args.lr * float(dA.sum())
            clip_hits += int(np.sum((ratio < 1.0 - CLIP) | (ratio > 1.0 + CLIP)))
            clip_n += mb

        _, _, Pv = forward(X[cut:], W0, b0, W1, b1)
        last_lp = float(np.log(Pv[np.arange(len(y[cut:])), y[cut:]] + 1e-12).mean()) if n > cut else 0.0
        last_clip = clip_hits / max(1, clip_n)
        if not args.quiet:
            print(f"  epoch {epoch + 1:3d}  val logp {last_lp:.4f}  clipfrac {last_clip:.3f}")

    print(f"val logp {last_lp:.4f} on {n - cut} held out  clipfrac {last_clip:.3f}")
    meta = {**meta, "dataset": Path(args.dataset).name}
    out = args.out or str(Path(args.dataset).parent.parent / "models" / "rl0.json")
    dump_model(out, meta, vocab, W0, b0, W1, b1, init)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
