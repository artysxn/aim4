#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# scripts/sim-train-caller.py
# The hivemind's head (SIM-PLAN 9.25 stages 1 and 4): IGL JSONL in, JSON out.
#
# This is the CALLER's trainer and it is deliberately not the bot trainer. The
# bot sees ~40,000 samples per match at 8 Hz; the caller sees a handful of
# decisions per round. Feeding the caller a tick loop would teach it the shape
# of a tick loop, so the dataset is one row per freeze / contact / man-count
# change and the net is small enough that a JS forward pass is two loops.
#
# Two heads, and it matters that they are two:
#
#   WIN   P(this side wins | picture, call). Stage 1's value head, the thing
#         `comparePlans` ranks tapes with. Trained on EVERY row, both
#         outcomes — 9.25 is explicit that a winners-only set makes every
#         execute look like 100%, and `sim-extract-caller.mjs --from demos`
#         exists to supply the losing half.
#
#   CALL  P(call | picture, side). Stage 4's prior: "what the winning side did
#         at freeze". Trained on FREEZE rows of WINNING sides only, because
#         that is what the label means — a losing side's opening call is not
#         an example of what to open with, though it is a perfectly good
#         example of a call that lost, which is what the win head is for.
#
# The call is an INPUT to the win head and the OUTPUT of the call head, so
# they cannot share a trunk without the call leaking into its own prediction.
# Two small nets, one file.
#
# The number to beat is printed for both, and for the win head it is not the
# base rate. It is the TABULAR head: the (side, call) win rate that 18.4's
# ExperienceIndex would have stored anyway. A net that cannot beat a lookup
# table has not earned the right to replace one, and on a 50/50 dataset that
# is easy to miss, because beating 50% looks like success and is not.
#
# Same export discipline as every other trainer here: JSON weights, JS forward
# pass (shared/sim/callerNet.js), no Python in the product. Do not fold this
# into the bot model — 9.25: "Same GPU box, different loss, different file."
#
# Run with the project venv:
#   .venv-sim/bin/python scripts/sim-train-caller.py <igl.jsonl>
#   .venv-sim/bin/python scripts/sim-train-caller.py igl.jsonl --epochs 300
#   .venv-sim/bin/python scripts/sim-train-caller.py igl.jsonl --out models/igl-paracord-lite-1.json
# -----------------------------------------------------------------------------

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

CALLER_NET_VERSION = 1

# The picture, as the head reads it. This list is the contract with
# shared/sim/callerNet.js: same names, same order, or the JS forward pass is
# evaluating a different function than the one that was fitted.
FEATURES = [
    "side_ct",       # 1 for CT, 0 for T
    "alive",         # /5
    "enemyAlive",    # /5
    "manAdv",        # (alive - enemyAlive) / 5
    "clock",         # /115
    "secondsLeft",   # /115
    "planted",
    "bombSecondsLeft",  # /40, and 1 when nothing is planted
    "hasKit",
    "rel_none",
    "rel_front",
    "rel_site",
    "rel_behind",
    "econ0", "econ1", "econ2", "econ3", "econ4", "econ5",
    "isFreeze",
]

REL_INDEX = {None: 0, "front": 1, "site": 2, "behind": 3}


def featurize(row):
    """One picture as the fitted feature vector. Mirrors callerNet.js exactly."""
    p = row.get("picture") or {}
    f = np.zeros(len(FEATURES), dtype=np.float64)
    alive = float(p.get("alive", 5) or 0)
    enemy = float(p.get("enemyAlive", 5) or 0)
    planted = bool(p.get("planted"))
    f[0] = 1.0 if p.get("side") == "CT" else 0.0
    f[1] = alive / 5.0
    f[2] = enemy / 5.0
    f[3] = (alive - enemy) / 5.0
    f[4] = float(p.get("clock", 0) or 0) / 115.0
    f[5] = float(p.get("secondsLeft", 115) or 0) / 115.0
    f[6] = 1.0 if planted else 0.0
    # An unplanted round has no bomb clock. Writing the full 40 rather than 0
    # keeps the feature monotone in "time the CT still has", which is what it
    # means on the rows where it means anything.
    f[7] = (float(p.get("bombSecondsLeft", 40) or 0) / 40.0) if planted else 1.0
    f[8] = 1.0 if p.get("hasKit") else 0.0
    f[9 + REL_INDEX.get(p.get("contactRel"), 0)] = 1.0
    econ = row.get("econ")
    if isinstance(econ, (int, float)) and 0 <= int(econ) <= 5:
        f[13 + int(econ)] = 1.0
    f[19] = 1.0 if row.get("event") == "freeze" else 0.0
    return f


def load_dataset(path):
    with open(path) as fh:
        lines = [ln for ln in fh.read().splitlines() if ln.strip()]
    if not lines:
        sys.exit(f"{path} is empty")
    meta = json.loads(lines[0])
    if meta.get("type") != "meta" or meta.get("kind") != "igl":
        sys.exit(f"{path} is not a caller dataset (run scripts/sim-extract-caller.mjs)")
    rows = [json.loads(ln) for ln in lines[1:]]
    if not rows:
        sys.exit(f"{path} has a header and no rows")

    # 9.25 stage 3: the split travels WITH the data. Re-splitting here by row
    # would leak two rounds of one match across the boundary and report a
    # number no unseen match reproduces, which is the exact mistake the
    # extractor writes `split` into every row to prevent.
    if not all("split" in r for r in rows):
        sys.exit("rows carry no `split`; re-extract, do not re-split here")
    return meta, rows


def build_vocab(rows):
    """The calls this map actually has, and which side owns each."""
    sides = {}
    counts = Counter()
    for r in rows:
        call = r.get("call") or "default"
        side = r.get("side")
        key = f"{side}:{call}"
        sides[key] = (side, call)
        counts[key] += 1
    # Sorted so a re-run produces the same indices and two models are
    # comparable head-to-head rather than only against themselves.
    keys = sorted(sides.keys())
    return keys, {k: i for i, k in enumerate(keys)}, counts


def onehot(n, idx):
    v = np.zeros(n, dtype=np.float64)
    v[idx] = 1.0
    return v


class MLP:
    """One hidden tanh layer. Small on purpose: the JS side is two loops."""

    def __init__(self, d_in, hidden, d_out, rng, softmax=False):
        self.W0 = rng.normal(0, 1 / np.sqrt(d_in), (hidden, d_in))
        self.b0 = np.zeros(hidden)
        self.W1 = rng.normal(0, 1 / np.sqrt(hidden), (d_out, hidden))
        self.b1 = np.zeros(d_out)
        self.softmax = softmax
        self.vW0 = np.zeros_like(self.W0)
        self.vb0 = np.zeros_like(self.b0)
        self.vW1 = np.zeros_like(self.W1)
        self.vb1 = np.zeros_like(self.b1)

    def forward(self, X):
        H = np.tanh(X @ self.W0.T + self.b0)
        Z = H @ self.W1.T + self.b1
        if self.softmax:
            Z = Z - Z.max(axis=1, keepdims=True)
            E = np.exp(Z)
            return H, E / E.sum(axis=1, keepdims=True)
        return H, 1.0 / (1.0 + np.exp(-Z))

    def step(self, X, G, lr, momentum, l2):
        """G is dLoss/dZ, already divided by the batch size."""
        H, _ = self.forward(X)
        gW1 = G.T @ H + l2 * self.W1
        gb1 = G.sum(axis=0)
        GH = (G @ self.W1) * (1 - H * H)
        gW0 = GH.T @ X + l2 * self.W0
        gb0 = GH.sum(axis=0)
        self.vW1 = momentum * self.vW1 - lr * gW1
        self.vb1 = momentum * self.vb1 - lr * gb1
        self.vW0 = momentum * self.vW0 - lr * gW0
        self.vb0 = momentum * self.vb0 - lr * gb0
        self.W1 += self.vW1
        self.b1 += self.vb1
        self.W0 += self.vW0
        self.b0 += self.vb0

    def export(self):
        rw = lambda M: [[round(float(x), 6) for x in row] for row in M]
        rv = lambda v: [round(float(x), 6) for x in v]
        return [
            {"W": rw(self.W0), "b": rv(self.b0)},
            {"W": rw(self.W1), "b": rv(self.b1)},
        ]


def train_binary(net, Xt, yt, Xv, yv, epochs, lr, batch, momentum, l2, rng, log, label):
    best = None
    for epoch in range(1, epochs + 1):
        perm = rng.permutation(len(Xt))
        for start in range(0, len(Xt), batch):
            idx = perm[start : start + batch]
            Xb, yb = Xt[idx], yt[idx]
            _, P = net.forward(Xb)
            net.step(Xb, ((P.ravel() - yb) / len(yb))[:, None], lr, momentum, l2)
        if epoch % max(1, epochs // 10) == 0 or epoch == epochs:
            tr = binary_scores(net, Xt, yt)
            va = binary_scores(net, Xv, yv)
            if best is None or va["logloss"] < best["logloss"]:
                best = va
            if log:
                print(
                    f"  {label} epoch {epoch:4d}  "
                    f"train logloss {tr['logloss']:.4f} acc {tr['acc']:.3f}  |  "
                    f"val logloss {va['logloss']:.4f} acc {va['acc']:.3f}"
                )
    return best or binary_scores(net, Xv, yv)


def binary_scores(net, X, y):
    if not len(y):
        return {"logloss": 0.0, "acc": 0.0, "brier": 0.0, "n": 0}
    _, P = net.forward(X)
    p = np.clip(P.ravel(), 1e-7, 1 - 1e-7)
    return {
        "logloss": float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()),
        "acc": float(((p >= 0.5) == (y >= 0.5)).mean()),
        "brier": float(((p - y) ** 2).mean()),
        "n": int(len(y)),
    }


def train_softmax(net, Xt, yt, Xv, yv, k, epochs, lr, batch, momentum, l2, rng, log, label):
    Yt = np.zeros((len(yt), k))
    Yt[np.arange(len(yt)), yt] = 1.0
    best = None
    for epoch in range(1, epochs + 1):
        perm = rng.permutation(len(Xt))
        for start in range(0, len(Xt), batch):
            idx = perm[start : start + batch]
            Xb, Yb = Xt[idx], Yt[idx]
            _, P = net.forward(Xb)
            net.step(Xb, (P - Yb) / len(idx), lr, momentum, l2)
        if epoch % max(1, epochs // 10) == 0 or epoch == epochs:
            tr = softmax_scores(net, Xt, yt)
            va = softmax_scores(net, Xv, yv)
            if best is None or va["logloss"] < best["logloss"]:
                best = va
            if log:
                print(
                    f"  {label} epoch {epoch:4d}  "
                    f"train logloss {tr['logloss']:.4f} acc {tr['acc']:.3f}  |  "
                    f"val logloss {va['logloss']:.4f} acc {va['acc']:.3f}"
                )
    return best or softmax_scores(net, Xv, yv)


def softmax_scores(net, X, y):
    if not len(y):
        return {"logloss": 0.0, "acc": 0.0, "n": 0}
    _, P = net.forward(X)
    p = np.clip(P, 1e-7, 1.0)
    return {
        "logloss": float(-np.log(p[np.arange(len(y)), y]).mean()),
        "acc": float((P.argmax(axis=1) == y).mean()),
        "n": int(len(y)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--out")
    ap.add_argument("--hidden", type=int, default=48, help="win head width")
    ap.add_argument("--hidden-call", type=int, default=32)
    ap.add_argument("--epochs", type=int, default=200)
    ap.add_argument("--epochs-call", type=int, default=400)
    ap.add_argument("--lr", type=float, default=0.08)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--momentum", type=float, default=0.9)
    ap.add_argument("--l2", type=float, default=1e-5)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--name", help="model id, e.g. igl-paracord-lite-1")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    log = not args.quiet

    meta, rows = load_dataset(args.dataset)
    keys, key_index, counts = build_vocab(rows)
    k = len(keys)
    rng = np.random.default_rng(args.seed)

    print(
        f"{len(rows):,} rows, {k} (side, call) pairs, map {meta.get('map')}, "
        f"from {meta.get('from')}, {meta.get('wins')}W/{meta.get('losses')}L"
    )

    # ---- win head: every row, both outcomes -------------------------------
    F = np.array([featurize(r) for r in rows])
    C = np.array([onehot(k, key_index[f"{r.get('side')}:{r.get('call') or 'default'}"]) for r in rows])
    Xw = np.hstack([F, C])
    yw = np.array([1.0 if r.get("won") else 0.0 for r in rows])
    is_val = np.array([r.get("split") == "val" for r in rows])

    if yw[~is_val].mean() in (0.0, 1.0):
        sys.exit("every training row has the same outcome; this set cannot teach a value head")

    win = MLP(Xw.shape[1], args.hidden, 1, rng)
    print(f"\nwin head: {Xw.shape[1]} in -> {args.hidden} -> 1, {(~is_val).sum():,} train / {is_val.sum():,} val")
    win_val = train_binary(
        win, Xw[~is_val], yw[~is_val], Xw[is_val], yw[is_val],
        args.epochs, args.lr, args.batch, args.momentum, args.l2, rng, log, "win",
    )

    # The two floors. The base rate is the trivial one; the tabular head is
    # the one that matters, because it is what the system already has.
    base_p = float(yw[~is_val].mean())
    yv = yw[is_val]
    base_ll = float(-(yv * np.log(base_p) + (1 - yv) * np.log(1 - base_p)).mean()) if len(yv) else 0.0

    table = {}
    for i, r in enumerate(rows):
        if is_val[i]:
            continue
        key = f"{r.get('side')}:{r.get('call') or 'default'}"
        w, n = table.get(key, (0, 0))
        table[key] = (w + (1 if r.get("won") else 0), n + 1)
    tab_p = np.array([
        (table.get(f"{r.get('side')}:{r.get('call') or 'default'}", (0, 0))[0] + base_p * 4)
        / (table.get(f"{r.get('side')}:{r.get('call') or 'default'}", (0, 0))[1] + 4)
        for i, r in enumerate(rows) if is_val[i]
    ])
    tab_p = np.clip(tab_p, 1e-7, 1 - 1e-7)
    tab_ll = float(-(yv * np.log(tab_p) + (1 - yv) * np.log(1 - tab_p)).mean()) if len(yv) else 0.0
    tab_acc = float(((tab_p >= 0.5) == (yv >= 0.5)).mean()) if len(yv) else 0.0

    print(
        f"  val logloss {win_val['logloss']:.4f}  acc {win_val['acc']:.3f}  "
        f"brier {win_val['brier']:.4f}  on {win_val['n']:,} rows"
    )
    print(f"  floors: base rate {base_ll:.4f}  |  (side, call) table {tab_ll:.4f} (acc {tab_acc:.3f})")
    if win_val["logloss"] >= tab_ll:
        print("  WARNING: the net does not beat the lookup table it is meant to replace")

    # ---- call head: winning sides, at freeze, per 9.25 stage 4 ------------
    call_rows = [r for r in rows if r.get("event") == "freeze" and r.get("won") is True]
    call_val = {"logloss": 0.0, "acc": 0.0, "n": 0}
    call_base_acc = 0.0
    call = MLP(len(FEATURES), args.hidden_call, k, rng, softmax=True)
    if len(call_rows) >= 50:
        Xc = np.array([featurize(r) for r in call_rows])
        yc = np.array([key_index[f"{r.get('side')}:{r.get('call') or 'default'}"] for r in call_rows])
        cv = np.array([r.get("split") == "val" for r in call_rows])
        print(
            f"\ncall head: {len(FEATURES)} in -> {args.hidden_call} -> {k}, "
            f"{(~cv).sum():,} train / {cv.sum():,} val (winning freezes only)"
        )
        call_val = train_softmax(
            call, Xc[~cv], yc[~cv], Xc[cv], yc[cv], k,
            args.epochs_call, args.lr, args.batch, args.momentum, args.l2, rng, log, "call",
        )
        # The floor: always name that side's most common winning call.
        by_side = {}
        for r, v in zip(call_rows, cv):
            if v:
                continue
            by_side.setdefault(r.get("side"), Counter())[f"{r.get('side')}:{r.get('call') or 'default'}"] += 1
        top = {s: c.most_common(1)[0][0] for s, c in by_side.items()}
        held = [r for r, v in zip(call_rows, cv) if v]
        if held:
            call_base_acc = float(
                np.mean([
                    1.0 if top.get(r.get("side")) == f"{r.get('side')}:{r.get('call') or 'default'}" else 0.0
                    for r in held
                ])
            )
        print(f"  val logloss {call_val['logloss']:.4f}  acc {call_val['acc']:.3f} on {call_val['n']:,}")
        print(f"  floor: most common winning call per side {call_base_acc:.3f}")
        if call_val["acc"] <= call_base_acc:
            print("  WARNING: the call head does not beat naming the same call every round")
    else:
        print(f"\ncall head: skipped, only {len(call_rows)} winning freeze rows")

    model = {
        "v": CALLER_NET_VERSION,
        "kind": "caller",
        "lineage": "hivemind",
        "name": args.name or Path(args.out or "caller").stem,
        "map": meta.get("map"),
        "iglVersion": meta.get("iglVersion"),
        "roundLibraryVersion": meta.get("roundLibraryVersion") or None,
        "features": FEATURES,
        "calls": [{"side": keys[i].split(":", 1)[0], "call": keys[i].split(":", 1)[1]} for i in range(k)],
        # Support travels with the weights: the JS head discounts a call the
        # net barely saw, exactly as the Wilson bound discounts a thin cell.
        "support": {keys[i]: int(counts[keys[i]]) for i in range(k)},
        "win": {"activation": "tanh", "output": "sigmoid", "layers": win.export()},
        "call": (
            {"activation": "tanh", "output": "softmax", "layers": call.export()}
            if len(call_rows) >= 50
            else None
        ),
        "dataset": Path(args.dataset).name,
        "trained": {
            "rows": len(rows),
            "trainRows": int((~is_val).sum()),
            "valRows": int(is_val.sum()),
            "epochs": args.epochs,
            "valAccuracy": {"win": round(win_val["acc"], 4), "call": round(call_val["acc"], 4)},
            "valLogloss": {"win": round(win_val["logloss"], 5), "call": round(call_val["logloss"], 5)},
            "valBrier": {"win": round(win_val["brier"], 5)},
            "floors": {
                "baseRate": round(base_ll, 5),
                "table": round(tab_ll, 5),
                "tableAccuracy": round(tab_acc, 4),
                "callMajority": round(call_base_acc, 4),
            },
            "holdout": meta.get("holdout", {}).get("by", "match"),
        },
    }

    out = args.out or str(Path(args.dataset).parent.parent / "models" / "igl-caller.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as fh:
        json.dump(model, fh)
    print(f"\nwrote {out} ({Path(out).stat().st_size / 1000:.0f} kB)")


if __name__ == "__main__":
    main()
