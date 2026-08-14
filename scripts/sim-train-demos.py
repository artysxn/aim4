#!/usr/bin/env python3
# -----------------------------------------------------------------------------
# scripts/sim-train-demos.py
# The GPU trainer for SIM-PLAN 9.3b's demo network: JSONL samples in, one JSON
# weights file out.
#
# The split of scripts/sim-train-bc.py is kept exactly: training happens here in
# Python where a 4090 is available, inference happens in shared/sim/policyNet.js
# where the bots run, and the only thing that crosses the boundary is a JSON
# file that carries its own versions. Nothing about the product depends on
# Python at runtime.
#
# What is different from sim-train-bc.py, and why:
#
#   HISTORY IS RECONSTRUCTED, NOT STORED. A sample carries one observation and
#   a `seq:{round, slot, i}`. Writing the 12-step window onto every line would
#   have cost about 320 GB for the corpus, so the extractor writes the step
#   index instead and THIS file rebuilds the causal window. See build_history().
#
#   MULTI-HEAD. One torso feeds six behaviour heads (option, moveTo, gait,
#   peek, aim, utility) plus three auxiliary heads (aimOffset, refrag, spacing)
#   that exist only to shape the torso and are dropped at export.
#
#   THE CALL IS A CONDITIONER. map / contract / call / player each get their own
#   jointly-trained embedding table. The call table is the point of the whole
#   exercise: it is what lets an operator command "B rush" at runtime and get
#   different behaviour out of the same weights.
#
#   NOTHING IS HELD IN RAM TWICE. Shards are streamed once into float16 memmaps
#   in a cache directory, so a 5 GB corpus never has to fit in memory.
#
# Usage:
#   python scripts/sim-train-demos.py                       # whole dataset
#   python scripts/sim-train-demos.py --limit 40000 --epochs 6
#   python scripts/sim-train-demos.py --device cpu --out /tmp/tiny.json
# -----------------------------------------------------------------------------

import argparse
import array
import contextlib
import hashlib
import json
import math
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError:  # pragma: no cover - the operator installs from requirements-sim.txt
    sys.exit("torch is not importable; see requirements-sim.txt")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DATASET = REPO / "server" / "data" / "replays" / "sim" / "datasets" / "demos"
DEFAULT_OUT = REPO / "server" / "data" / "replays" / "sim" / "models" / "demo-g0.json"

# Bumped when the exported schema changes. policyNet.js refuses anything else.
POLICYNET_VERSION = 1
# Bumped when the CACHE layout changes, so a stale cache is rebuilt not reused.
CACHE_VERSION = 4
# Keep in sync with shared/sim/demoContracts.js DEMO_DATASET_VERSION.
DATASET_VERSION = 2

# Fixed-order label vocabularies. Order is part of the export; these mirror
# shared/sim/demoContracts.js so a relabelled dataset cannot silently reindex.
PEEK_STYLES = ["none", "hold", "jiggle", "shoulder", "wide", "repeek"]
AIM_BUCKETS = ["on", "near", "off", "away"]
GAITS = ["stand", "walk", "run"]
UTILITY = ["none", "smokegrenade", "flashbang", "hegrenade", "molotov", "incgrenade", "decoy"]

# moveTo has an open vocabulary (anchor ids, 63 of them in one shard and more
# per map), so it is built from the data, capped, and the tail bucketed.
MOVE_NONE = "__none__"
MOVE_OTHER = "__other__"

HISTORY_STEPS = 12
HISTORY_HZ = 4

# The heads trained from `y`. (name, vocab, loss weight)
CLASS_HEADS = ["option", "moveTo", "gait", "peek", "aim", "utility"]
HEAD_LOSS_WEIGHT = {
    "option": 1.0,
    "moveTo": 1.0,
    "gait": 0.5,
    "peek": 1.0,
    "aim": 1.0,
    "utility": 1.0,
    # Auxiliary: shape the torso, never exported.
    "aimOffset": 0.2,
    "refrag": 0.5,
    "spacing": 0.2,
}

# Inverse-frequency class weights are capped here, matching sim-train-bc.py.
CLASS_WEIGHT_CAP = 8.0


# ---------------------------------------------------------------------------
# streaming ingest
# ---------------------------------------------------------------------------


def write_atomic(path, text):
    """Temp file then rename, so a poller never reads a half-written file."""
    path = Path(path)
    tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


class Vocab:
    """String -> dense id, assigned in first-seen order, plus counts."""

    def __init__(self):
        self.ids = {}
        self.keys = []
        self.counts = []

    def add(self, key):
        i = self.ids.get(key)
        if i is None:
            i = len(self.keys)
            self.ids[key] = i
            self.keys.append(key)
            self.counts.append(0)
        self.counts[i] += 1
        return i


def cache_signature(shards, limit):
    h = hashlib.sha1()
    h.update(f"v{CACHE_VERSION}|limit={limit}|T={HISTORY_STEPS}".encode())
    for p in shards:
        st = p.stat()
        h.update(f"|{p.name}:{st.st_size}:{int(st.st_mtime)}".encode())
    return h.hexdigest()[:16]


def stream_shards(shards, limit, cache_dir, log=print):
    """
    One pass over the JSONL. Observations go straight to a float16 file on disk
    (never all in RAM); everything else is a compact int array.

    Returns a dict of numpy arrays plus the vocabularies.
    """
    obs_path = cache_dir / "obs.f16"
    obs_file = open(obs_path, "wb")

    maps, calls, contracts, players, rounds, moves = Vocab(), Vocab(), Vocab(), Vocab(), Vocab(), Vocab()
    col = {k: array.array("i") for k in ("map", "call", "contract", "player", "round", "slot", "step",
                                         "option", "moveTo", "gait", "peek", "aim", "utility", "refrag")}
    weights = array.array("f")
    aim_offsets = array.array("f")
    spacings = array.array("f")

    option_vocab = None
    obs_size = None
    obs_version = None
    dataset_v = None
    # label -> id dicts, so the inner loop never does a linear scan per sample
    opt_ix = {}
    gait_ix = {k: i for i, k in enumerate(GAITS)}
    peek_ix = {k: i for i, k in enumerate(PEEK_STYLES)}
    aim_ix = {k: i for i, k in enumerate(AIM_BUCKETS)}
    util_ix = {k: i for i, k in enumerate(UTILITY)}

    chunk = []
    CHUNK = 8192
    n = 0
    torn = 0
    t0 = time.time()

    def flush():
        if not chunk:
            return
        np.asarray(chunk, dtype=np.float16).tofile(obs_file)
        chunk.clear()

    for shard in shards:
        with open(shard, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    # The extractor appends to the newest shard while this runs,
                    # so the last line of a live shard can be half-written. One
                    # torn line per shard is the tail of a concurrent write and
                    # is skipped; more than that is a corrupt file and is fatal.
                    torn += 1
                    if torn > len(shards):
                        sys.exit(f"{shard.name}: {torn} unparseable lines, this is not a torn tail")
                    log(f"  skipped a torn line at the end of {shard.name} (extractor still writing)")
                    continue
                if rec.get("type") == "meta":
                    if option_vocab is None:
                        option_vocab = list(rec["vocab"])
                        opt_ix = {k: i for i, k in enumerate(option_vocab)}
                        obs_size = int(rec["obsSize"])
                        obs_version = int(rec["obsVersion"])
                        dataset_v = int(rec["v"])
                        if dataset_v != DATASET_VERSION:
                            sys.exit(
                                f"dataset v{dataset_v} is not v{DATASET_VERSION}; "
                                "re-extract with scripts/sim-extract-demos.mjs"
                            )
                        if int(rec.get("historySteps", HISTORY_STEPS)) != HISTORY_STEPS:
                            sys.exit(
                                f"dataset says historySteps {rec.get('historySteps')}, "
                                f"this trainer builds {HISTORY_STEPS}"
                            )
                    else:
                        if list(rec["vocab"]) != option_vocab:
                            sys.exit(f"{shard.name} carries a different option vocabulary")
                        if int(rec["obsSize"]) != obs_size or int(rec["obsVersion"]) != obs_version:
                            sys.exit(f"{shard.name} carries a different observation contract")
                    continue

                obs = rec["obs"]
                if len(obs) != obs_size:
                    sys.exit(f"{shard.name} line {n + 2}: obs is {len(obs)} floats, meta says {obs_size}")
                chunk.append(obs)
                if len(chunk) >= CHUNK:
                    flush()

                c = rec["cond"]
                y = rec["y"]
                s = rec["seq"]
                col["map"].append(maps.add(str(c.get("map") or "")))
                col["call"].append(calls.add(str(c.get("call") or "default")))
                col["contract"].append(contracts.add(str(c.get("contract") or "any")))
                col["player"].append(players.add(str(c.get("player") or "")))
                col["round"].append(rounds.add(str(s["round"])))
                col["slot"].append(int(s["slot"]))
                col["step"].append(int(s["i"]))

                # -1 means "this sample carries no label for this head": the
                # loss skips it rather than inventing a class for it.
                col["option"].append(opt_ix.get(y.get("option"), -1))
                mv = y.get("moveTo")
                col["moveTo"].append(moves.add(MOVE_NONE if mv is None else str(mv)))
                col["gait"].append(gait_ix.get(y.get("gait"), -1))
                col["peek"].append(peek_ix.get(y.get("peek"), -1))
                col["aim"].append(aim_ix.get(y.get("aim"), -1))
                col["utility"].append(util_ix.get(y.get("utility"), -1))
                col["refrag"].append(1 if y.get("refrag") else 0)
                aim_offsets.append(float(y.get("aimOffset") or 0.0))
                spacings.append(float(y.get("spacingDx") or 0.0))
                spacings.append(float(y.get("spacingDy") or 0.0))
                weights.append(float(rec.get("w", 1.0)))

                n += 1
                if n % 200000 == 0:
                    log(f"  read {n:,} samples ({n / max(1e-6, time.time() - t0):,.0f}/s)")
                if limit and n >= limit:
                    break
        if limit and n >= limit:
            break

    flush()
    obs_file.close()
    if not n:
        sys.exit("no samples read")

    out = {k: np.frombuffer(v, dtype=np.int32).copy() for k, v in col.items()}
    out["w"] = np.frombuffer(weights, dtype=np.float32).copy()
    out["aimOffset"] = np.frombuffer(aim_offsets, dtype=np.float32).copy()
    out["spacing"] = np.frombuffer(spacings, dtype=np.float32).copy().reshape(-1, 2)
    out["n"] = n
    out["obsSize"] = obs_size
    out["obsVersion"] = obs_version
    out["datasetVersion"] = dataset_v
    out["optionVocab"] = option_vocab
    out["vocabs"] = {"map": maps, "call": calls, "contract": contracts, "player": players, "moveTo": moves}
    out["rounds"] = rounds
    log(f"  read {n:,} samples in {time.time() - t0:,.1f}s -> {obs_path.name} "
        f"({obs_path.stat().st_size / 1e6:,.0f} MB float16)")
    return out


def cap_move_vocab(move_ids, moves, cap, log=print):
    """
    Keep the `cap` most frequent anchors, bucket the tail into __other__.

    Anchors are Zipfian: a handful of positions carry most of the mass and the
    tail is one-round curiosities. Training a head over all of them spends
    capacity on noise, so the tail becomes one class the net can actually learn
    ("somewhere unusual") rather than 400 classes it cannot.
    """
    counts = np.asarray(moves.counts, dtype=np.int64)
    order = np.argsort(-counts, kind="stable")
    keep = [moves.keys[i] for i in order[: max(1, cap - 1)]]
    if MOVE_NONE not in keep:
        keep.insert(0, MOVE_NONE)
    vocab = list(dict.fromkeys(keep))
    if len(moves.keys) > len(vocab):
        vocab.append(MOVE_OTHER)
    index = {k: i for i, k in enumerate(vocab)}
    other = index.get(MOVE_OTHER, index[MOVE_NONE])
    remap = np.full(len(moves.keys), other, dtype=np.int32)
    for i, key in enumerate(moves.keys):
        if key in index:
            remap[i] = index[key]
    dropped = int(len(moves.keys) - len(vocab))
    if dropped > 0:
        log(f"  moveTo: {len(moves.keys)} anchors -> {len(vocab)} classes ({dropped} bucketed into {MOVE_OTHER})")
    return remap[move_ids], vocab


def build_history(round_ids, slots, steps, T=HISTORY_STEPS):
    """
    THE load-bearing function. Rebuild each sample's causal window from `seq`.

    Samples for one (round, slot) are emitted in order at HISTORY_HZ, so the
    window for the sample at step i is the samples at steps i-(T-1) .. i of the
    SAME (round, slot). Two properties the naive "take the previous T-1 rows"
    version gets wrong, and both occur in the real data:

      * the start of a round has no past, and must be ZERO-padded, not padded
        with a copy of the present (a bot that sees a flat 3-second history is
        being told nothing happened, which is exactly the truth at t=0);
      * `i` has gaps where the extractor dropped a step (10 of 215 groups in
        shard-0000), so a missing step must become a zero frame rather than
        silently sliding an older observation into a slot it does not belong in.

    Implementation: (round, slot) and i pack into one strictly increasing key,
    so the lookup for "the sample at step i-o" is a searchsorted, vectorized
    over the whole dataset, once, at cache-build time.

    Returns int32 (n, T) of row indices, oldest first, with -1 meaning "pad".
    The last column is always the sample's own row.
    """
    steps = steps.astype(np.int64)
    if steps.min() < 0:
        raise ValueError("seq.i is negative")
    span = int(steps.max()) + 1
    shift = max(20, int(span).bit_length() + 1)
    if slots.max() >= 64:
        raise ValueError("seq.slot exceeds 64")
    gid = round_ids.astype(np.int64) * 64 + slots.astype(np.int64)
    key = (gid << shift) | steps

    order = np.argsort(key, kind="stable")
    sorted_key = key[order]
    if np.any(np.diff(sorted_key) == 0):
        raise ValueError("duplicate (round, slot, i) in the dataset")

    n = len(key)
    hist = np.full((n, T), -1, dtype=np.int32)
    hist[:, T - 1] = np.arange(n, dtype=np.int32)
    for back in range(1, T):
        want = key - back  # same group, `back` steps earlier
        pos = np.searchsorted(sorted_key, want)
        pos = np.clip(pos, 0, n - 1)
        hit = sorted_key[pos] == want
        # A step that would have run off the front of the group cannot match:
        # the packed key of the previous group is separated by 2**shift.
        idx = order[pos]
        hist[hit, T - 1 - back] = idx[hit].astype(np.int32)
    return hist


def prepare(shards, limit, cache_dir, move_cap, log=print):
    """Stream, cap the anchor vocabulary, build the windows. Cached on disk."""
    sig = cache_signature(shards, limit)
    cdir = cache_dir / f"demos-{sig}"
    meta_path = cdir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if meta.get("moveCap") == move_cap and meta.get("cacheVersion") == CACHE_VERSION:
            log(f"cache hit: {cdir}")
            arrays = np.load(cdir / "cols.npz")
            obs = np.memmap(cdir / "obs.f16", dtype=np.float16, mode="r",
                            shape=(meta["n"], meta["obsSize"]))
            hist = np.memmap(cdir / "hist.i32", dtype=np.int32, mode="r", shape=(meta["n"], HISTORY_STEPS))
            return meta, obs, hist, {k: arrays[k] for k in arrays.files}
    cdir.mkdir(parents=True, exist_ok=True)
    log(f"streaming {len(shards)} shard(s) -> {cdir}")
    raw = stream_shards(shards, limit, cdir, log=log)
    n, obs_size = raw["n"], raw["obsSize"]

    move_y, move_vocab = cap_move_vocab(raw["moveTo"], raw["vocabs"]["moveTo"], move_cap, log=log)
    log("  rebuilding 12-step causal windows from seq ...")
    t0 = time.time()
    hist = build_history(raw["round"], raw["slot"], raw["step"])
    pads = int((hist < 0).sum())
    log(f"  windows built in {time.time() - t0:,.1f}s "
        f"({pads:,} of {hist.size:,} slots zero-padded, {100 * pads / hist.size:.1f}%)")
    hmm = np.memmap(cdir / "hist.i32", dtype=np.int32, mode="w+", shape=(n, HISTORY_STEPS))
    hmm[:] = hist
    hmm.flush()
    del hmm

    cols = {
        "map": raw["map"], "call": raw["call"], "contract": raw["contract"], "player": raw["player"],
        "round": raw["round"], "option": raw["option"], "moveTo": move_y, "gait": raw["gait"],
        "peek": raw["peek"], "aim": raw["aim"], "utility": raw["utility"],
        "refrag": raw["refrag"], "w": raw["w"], "aimOffset": raw["aimOffset"],
        "spacing": raw["spacing"],
    }
    np.savez(cdir / "cols.npz", **cols)
    meta = {
        "cacheVersion": CACHE_VERSION,
        "n": n,
        "obsSize": obs_size,
        "obsVersion": raw["obsVersion"],
        "datasetVersion": raw["datasetVersion"],
        "moveCap": move_cap,
        "vocab": {
            "option": raw["optionVocab"],
            "moveTo": move_vocab,
            "gait": GAITS,
            "peek": PEEK_STYLES,
            "aim": AIM_BUCKETS,
            "utility": UTILITY,
        },
        "cond": {k: raw["vocabs"][k].keys for k in ("map", "call", "contract", "player")},
        "rounds": len(raw["rounds"].keys),
    }
    write_atomic(meta_path, json.dumps(meta))
    obs = np.memmap(cdir / "obs.f16", dtype=np.float16, mode="r", shape=(n, obs_size))
    hist = np.memmap(cdir / "hist.i32", dtype=np.int32, mode="r", shape=(n, HISTORY_STEPS))
    return meta, obs, hist, cols


# ---------------------------------------------------------------------------
# the network
# ---------------------------------------------------------------------------


class CausalBlock(nn.Module):
    """
    One pre-norm causal transformer block, written out by hand rather than with
    nn.TransformerEncoderLayer, because shared/sim/policyNet.js has to reproduce
    it exactly with plain loops. Every tensor here has an obvious JS mirror.
    """

    def __init__(self, d_model, heads, ff):
        super().__init__()
        self.h = heads
        self.dh = d_model // heads
        self.ln1 = nn.LayerNorm(d_model)
        self.wq = nn.Linear(d_model, d_model)
        self.wk = nn.Linear(d_model, d_model)
        self.wv = nn.Linear(d_model, d_model)
        self.wo = nn.Linear(d_model, d_model)
        self.ln2 = nn.LayerNorm(d_model)
        self.fc1 = nn.Linear(d_model, ff)
        self.fc2 = nn.Linear(ff, d_model)

    def forward(self, x, mask):
        B, T, D = x.shape
        h = self.ln1(x)
        q = self.wq(h).view(B, T, self.h, self.dh).transpose(1, 2)
        k = self.wk(h).view(B, T, self.h, self.dh).transpose(1, 2)
        v = self.wv(h).view(B, T, self.h, self.dh).transpose(1, 2)
        att = (q @ k.transpose(-2, -1)) / math.sqrt(self.dh)
        att = att.masked_fill(mask, float("-inf"))
        att = att.softmax(dim=-1)
        ctx = (att @ v).transpose(1, 2).contiguous().view(B, T, D)
        x = x + self.wo(ctx)
        x = x + self.fc2(torch.tanh(self.fc1(self.ln2(x))))
        return x


class PolicyNet(nn.Module):
    """
    9.3b's network.

      history (T, obs) -> inProj -> +pos -> 2 causal blocks -> last step (d_model)
      map/contract/call/player embeddings ---------------------------/ concat
      -> dense 512 tanh -> dense 512 tanh -> six behaviour heads + two aux heads

    Only the last step of the temporal stack feeds the torso: the question the
    heads answer is "what do I do NOW", and the earlier steps are there to be
    attended to, not to be predicted from.
    """

    def __init__(self, obs_size, vocab, cond_sizes, d_model=128, heads=4, ff=512,
                 blocks=2, width=512, dims=(8, 16, 16, 16), T=HISTORY_STEPS):
        super().__init__()
        self.T = T
        self.obs_size = obs_size
        map_d, contract_d, call_d, player_d = dims
        self.in_proj = nn.Linear(obs_size, d_model)
        self.pos = nn.Parameter(torch.zeros(T, d_model))
        nn.init.normal_(self.pos, std=0.02)
        self.blocks = nn.ModuleList([CausalBlock(d_model, heads, ff) for _ in range(blocks)])
        self.ln_out = nn.LayerNorm(d_model)

        # +1 row per table: the last row is the DEFAULT, the row an unseen key
        # rides at inference. It is trained (every sample nudges it a little via
        # the dropout below), so it is the average behaviour rather than zeros.
        self.emb_map = nn.Embedding(cond_sizes["map"] + 1, map_d)
        self.emb_contract = nn.Embedding(cond_sizes["contract"] + 1, contract_d)
        self.emb_call = nn.Embedding(cond_sizes["call"] + 1, call_d)
        self.emb_player = nn.Embedding(cond_sizes["player"] + 1, player_d)
        for e in (self.emb_map, self.emb_contract, self.emb_call, self.emb_player):
            nn.init.normal_(e.weight, std=0.05)

        cond_w = map_d + contract_d + call_d + player_d
        self.torso = nn.ModuleList([nn.Linear(d_model + cond_w, width), nn.Linear(width, width)])
        self.heads = nn.ModuleDict({k: nn.Linear(width, len(vocab[k])) for k in CLASS_HEADS})
        self.aim_offset = nn.Linear(width, 1)
        self.refrag = nn.Linear(width, 2)
        self.spacing = nn.Linear(width, 2)
        self.register_buffer("mask", torch.triu(torch.ones(T, T, dtype=torch.bool), diagonal=1))

    def trunk(self, hist, cond):
        x = self.in_proj(hist) + self.pos
        for blk in self.blocks:
            x = blk(x, self.mask)
        z = self.ln_out(x[:, -1, :])
        e = torch.cat([
            z,
            self.emb_map(cond["map"]),
            self.emb_contract(cond["contract"]),
            self.emb_call(cond["call"]),
            self.emb_player(cond["player"]),
        ], dim=1)
        for lin in self.torso:
            e = torch.tanh(lin(e))
        return e

    def forward(self, hist, cond):
        e = self.trunk(hist, cond)
        out = {k: self.heads[k](e) for k in CLASS_HEADS}
        out["aimOffset"] = self.aim_offset(e).squeeze(1)
        out["refrag"] = self.refrag(e)
        out["spacing"] = self.spacing(e)
        return out


def param_report(model):
    rows = []
    groups = {
        "temporal.inProj": ["in_proj"],
        "temporal.pos": ["pos"],
        "temporal.blocks": ["blocks"],
        "temporal.lnOut": ["ln_out"],
        "embed.map": ["emb_map"],
        "embed.contract": ["emb_contract"],
        "embed.call": ["emb_call"],
        "embed.player": ["emb_player"],
        "torso": ["torso"],
        "heads": ["heads"],
        "aux (not exported)": ["aim_offset", "refrag", "spacing"],
    }
    for label, prefixes in groups.items():
        total = sum(p.numel() for name, p in model.named_parameters()
                    if any(name == pre or name.startswith(pre + ".") for pre in prefixes))
        rows.append((label, total))
    return rows


# ---------------------------------------------------------------------------
# training
# ---------------------------------------------------------------------------


def class_weights(y, n_classes):
    """Inverse frequency, capped at 8 — the same discipline as sim-train-bc.py."""
    valid = y >= 0
    counts = np.bincount(y[valid], minlength=n_classes).astype(np.float64)
    total = max(1, int(valid.sum()))
    w = np.where(counts > 0, total / (np.maximum(counts, 1) * n_classes), 0.0)
    return np.minimum(w, CLASS_WEIGHT_CAP).astype(np.float32)


class Progress:
    """
    The sim lab polls progress.json; the operator watches stdout. Both get the
    same numbers. Written atomically every `every` seconds so a poller cannot
    catch a half-written file.
    """

    def __init__(self, path, epochs, total_steps, device, every=5.0):
        self.path = Path(path)
        self.epochs = epochs
        self.total_steps = max(1, total_steps)
        self.device = device
        self.every = every
        self.start = time.time()
        self.last = 0.0
        self.step = 0
        self.epoch = 0
        self.losses = {}
        self.accuracies = {}
        self.samples = 0
        self.rate = 0.0

    def tick(self, step, epoch, samples, force=False):
        self.step, self.epoch, self.samples = step, epoch, samples
        now = time.time()
        if not force and now - self.last < self.every:
            return
        self.last = now
        elapsed = now - self.start
        self.rate = samples / max(1e-6, elapsed)
        done = self.step / self.total_steps
        eta = (elapsed / done - elapsed) if done > 0 else 0.0
        body = {
            "phase": "train-demos",
            "epoch": self.epoch,
            "epochs": self.epochs,
            "percent": round(100.0 * done, 4),
            "samplesPerSecond": round(self.rate, 2),
            "losses": {k: round(float(v), 5) for k, v in self.losses.items()},
            "accuracies": {k: round(float(v), 5) for k, v in self.accuracies.items()},
            "etaSeconds": int(max(0, eta)),
            "device": self.device,
            "elapsedSeconds": int(elapsed),
            "gpuMemoryMB": int(torch.cuda.max_memory_allocated() / 1e6) if self.device == "cuda" else 0,
            "samples": int(samples),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        }
        write_atomic(self.path, json.dumps(body, indent=2))


def fmt_secs(s):
    s = int(s)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


def gather_batch(idx, obs, hist, cols, obs_size, device):
    """
    Gather one batch. `hist` holds row indices with -1 for pad, so the gather
    points every pad at row 0 and zeroes it afterwards: the zero-padding of
    build_history(), realized without a branch in the hot loop.

    Two paths, and the fast one is why this run is minutes instead of hours.
    When the observation table is resident on the GPU, only the row INDICES
    cross PCIe (batch x 12 int64, about 3 MB) and the 68-float-wide gather
    happens on-device. The CPU path gathers batch x 12 x 68 floats out of a
    multi-gigabyte array with one thread, which measured at 0.3% GPU
    utilization: the 4090 spent its life waiting on one core to shuffle rows.
    """
    rows = np.asarray(hist[idx], dtype=np.int64)  # (B, T)
    pad = rows < 0
    rows = np.where(pad, 0, rows)

    if isinstance(obs, torch.Tensor):
        dev = obs.device
        rows_t = torch.from_numpy(rows).to(dev, non_blocking=True)
        flat = obs.index_select(0, rows_t.reshape(-1)).view(rows.shape[0], rows.shape[1], obs_size).float()
        flat[torch.from_numpy(pad).to(dev, non_blocking=True)] = 0.0
    else:
        host = np.asarray(obs[rows.reshape(-1)], dtype=np.float32).reshape(rows.shape[0], rows.shape[1], obs_size)
        host[pad] = 0.0
        flat = torch.from_numpy(host).to(device, non_blocking=True)

    cond = {k: torch.from_numpy(np.asarray(cols[k][idx], dtype=np.int64)).to(device, non_blocking=True)
            for k in ("map", "call", "contract", "player")}
    return flat, cond


def make_resident(obs, device, reserve_gb=6.0):
    """
    Put the observation table in VRAM when it fits, with headroom left for the
    model, its activations and the optimizer.

    Returns the tensor, or the original array when it will not fit: a run that
    silently OOMs at epoch 3 is worse than one that is honestly slower.
    """
    if device != "cuda" or not torch.cuda.is_available():
        return obs, False
    need = obs.nbytes / 1e9
    free = torch.cuda.get_device_properties(0).total_memory / 1e9
    if need > max(0.0, free - reserve_gb):
        print(f"  observation table {need:.1f} GB does not fit in {free:.0f} GB VRAM with "
              f"{reserve_gb:.0f} GB reserved: keeping it in host memory")
        return obs, False
    t = torch.from_numpy(np.ascontiguousarray(obs)).to("cuda")
    print(f"  observation table resident on the GPU ({need:.1f} GB, {free - need - reserve_gb:.1f} GB spare)")
    return t, True


def main():
    ap = argparse.ArgumentParser(description="GPU trainer for the SIM-PLAN 9.3b demo policy")
    ap.add_argument("dataset", nargs="?", default=str(DEFAULT_DATASET),
                    help="dataset directory (with manifest.json) or a single .jsonl")
    ap.add_argument("--out", default=None)
    ap.add_argument("--name", default=None,
                    help="model id, e.g. paracord-1. Sets the output filename and "
                         "stamps the id into the artifact so the registry can name it.")
    ap.add_argument("--limit", type=int, default=0, help="train on the first N samples only")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=4096,
                    help="measured sweet spot on a 4090: 4.4x the throughput of 1024 at nearly "
                         "the same accuracy. Larger is faster and worse, because a bigger batch "
                         "buys fewer gradient steps per epoch and this model is launch-bound, "
                         "not compute-bound")
    ap.add_argument("--vram-reserve", type=float, default=6.0,
                    help="GB left free for the model, activations and the optimizer")
    ap.add_argument("--lr", type=float, default=3e-4,
                    help="scaled linearly with --batch from a 1024 baseline unless --no-lr-scale")
    ap.add_argument("--no-lr-scale", action="store_true")
    ap.add_argument("--weight-decay", type=float, default=0.01)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    ap.add_argument("--amp", type=int, default=1, help="1 = bf16 autocast on cuda")
    ap.add_argument("--d-model", type=int, default=128)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--ff", type=int, default=512)
    ap.add_argument("--blocks", type=int, default=2)
    ap.add_argument("--width", type=int, default=512, help="torso width")
    ap.add_argument("--map-dim", type=int, default=8)
    ap.add_argument("--contract-dim", type=int, default=16)
    ap.add_argument("--call-dim", type=int, default=16)
    ap.add_argument("--player-dim", type=int, default=16)
    ap.add_argument("--move-cap", type=int, default=128, help="moveTo classes before the tail is bucketed")
    ap.add_argument("--cond-dropout", type=float, default=0.05,
                    help="probability a conditioner is replaced by its default row, so the "
                         "default row is trained and unseen keys degrade instead of exploding")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--cache", default=str(Path(tempfile.gettempdir()) / "sim-train-demos-cache"))
    ap.add_argument("--parity", default=None, help="write a JSON parity probe for policyNet.js")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    log = (lambda *a: None) if args.quiet else print

    ds = Path(args.dataset)
    if ds.is_dir():
        manifest = json.loads((ds / "manifest.json").read_text())
        shards = [ds / s["file"] for s in manifest["shards"]]
        shards = [p for p in shards if p.exists()]
        if not shards:
            shards = sorted(ds.glob("shard-*.jsonl"))
    else:
        shards = [ds]
    if not shards:
        sys.exit(f"no shards under {ds}")

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        sys.exit("--device cuda but torch.cuda.is_available() is False")
    log(f"device {device}" + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else ""))

    meta, obs, hist, cols = prepare(shards, args.limit, Path(args.cache), args.move_cap, log=log)
    n, obs_size = meta["n"], meta["obsSize"]
    obs, resident = make_resident(obs, device, reserve_gb=args.vram_reserve)
    vocab = meta["vocab"]
    cond_keys = meta["cond"]
    log(f"{n:,} samples, {obs_size} floats, obsVersion {meta['obsVersion']}, {meta['rounds']} rounds")
    log("  vocab: " + ", ".join(f"{k}={len(v)}" for k, v in vocab.items()))
    log("  cond:  " + ", ".join(f"{k}={len(v)}" for k, v in cond_keys.items()))

    # Split by ROUND, not by sample. Adjacent samples share eleven twelfths of
    # their history, so a random split would put near-copies of a training
    # sample in validation and report an accuracy that means nothing.
    rng = np.random.default_rng(args.seed)
    n_rounds = int(cols["round"].max()) + 1
    round_perm = rng.permutation(n_rounds)
    val_rounds = set(round_perm[: max(1, int(n_rounds * args.val_frac))].tolist())
    is_val = np.fromiter((r in val_rounds for r in cols["round"]), dtype=bool, count=n)
    tr_idx = np.flatnonzero(~is_val)
    va_idx = np.flatnonzero(is_val)
    if not len(va_idx) or not len(tr_idx):
        tr_idx, va_idx = np.arange(int(n * 0.8)), np.arange(int(n * 0.8), n)
    log(f"  split by round: {len(tr_idx):,} train / {len(va_idx):,} val "
        f"({len(val_rounds)} of {n_rounds} rounds held out)")

    cw = {k: torch.from_numpy(class_weights(cols[k][tr_idx], len(vocab[k]))).to(device)
          for k in CLASS_HEADS}
    cw["refrag"] = torch.from_numpy(class_weights(cols["refrag"][tr_idx], 2)).to(device)

    torch.manual_seed(args.seed)
    cond_sizes = {k: len(v) for k, v in cond_keys.items()}
    model = PolicyNet(
        obs_size, vocab, cond_sizes,
        d_model=args.d_model, heads=args.heads, ff=args.ff, blocks=args.blocks,
        width=args.width, dims=(args.map_dim, args.contract_dim, args.call_dim, args.player_dim),
    ).to(device)

    rows = param_report(model)
    total = sum(p.numel() for p in model.parameters())
    exported = total - sum(t for label, t in rows if "not exported" in label)
    log("architecture:")
    for label, t in rows:
        log(f"  {label:<24} {t:>10,}")
    log(f"  {'TOTAL':<24} {total:>10,}  ({exported:,} exported)")

    # A bigger batch takes proportionally fewer steps, so the LR has to rise
    # or an epoch travels a fraction of the distance. SQUARE ROOT, not linear:
    # linear scaling is the SGD rule, and applying it to AdamW here pushed the
    # rate to 4.8e-3 and cost accuracy at matched epochs. Adam already
    # normalizes by gradient magnitude, so it wants the gentler curve.
    lr = args.lr if args.no_lr_scale else args.lr * math.sqrt(args.batch / 1024.0)
    if lr != args.lr:
        log(f"  lr {args.lr:g} scaled to {lr:g} for batch {args.batch}")
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=args.weight_decay)
    steps_per_epoch = max(1, math.ceil(len(tr_idx) / args.batch))
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch, pct_start=0.15
    )
    use_amp = bool(args.amp) and device == "cuda"
    # nullcontext, never enable_grad: this context is also entered inside the
    # no_grad evaluation, and enable_grad there would quietly build a graph.
    amp_ctx = (lambda: torch.autocast("cuda", dtype=torch.bfloat16)) if use_amp else contextlib.nullcontext

    # --name is the normal way in; --out stays for one-off paths. A named run
    # lands as `<name>.json` beside the other models, which is what the
    # registry lists and what the lab loads.
    if args.out:
        out_path = Path(args.out)
    elif args.name:
        out_path = DEFAULT_OUT.parent / f"{args.name}.json"
    else:
        out_path = DEFAULT_OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Progress is per-model, not per-directory: training the players and the
    # IGL on the same box must not have one run overwrite the other's ETA.
    prog = Progress(
        out_path.parent / f"{out_path.stem}.progress.json",
        args.epochs,
        args.epochs * steps_per_epoch,
        device,
    )

    stopping = {"flag": False}

    def on_sigint(signum, frame):
        if stopping["flag"]:
            sys.exit(1)
        stopping["flag"] = True
        print("\nSIGINT: finishing this epoch, then saving the model. Ctrl-C again to abort.")

    signal.signal(signal.SIGINT, on_sigint)

    y_dev = {k: torch.from_numpy(cols[k].astype(np.int64)).to(device) for k in CLASS_HEADS}
    y_dev["refrag"] = torch.from_numpy(cols["refrag"].astype(np.int64)).to(device)
    y_off = torch.from_numpy(cols["aimOffset"].astype(np.float32) / 180.0).to(device)
    y_sp = torch.from_numpy(cols["spacing"].astype(np.float32) / 2000.0).to(device)
    w_dev = torch.from_numpy(cols["w"].astype(np.float32)).to(device)

    def losses_for(out, batch_idx_t, train=True):
        per = {}
        for k in CLASS_HEADS:
            y = y_dev[k][batch_idx_t]
            ok = y >= 0
            if not bool(ok.any()):
                continue
            ce = F.cross_entropy(out[k][ok].float(), y[ok], reduction="none")
            sw = w_dev[batch_idx_t][ok] * cw[k][y[ok]]
            per[k] = (ce * sw).sum() / sw.sum().clamp_min(1e-6)
        y = y_dev["refrag"][batch_idx_t]
        ce = F.cross_entropy(out["refrag"].float(), y, reduction="none")
        sw = w_dev[batch_idx_t] * cw["refrag"][y]
        per["refrag"] = (ce * sw).sum() / sw.sum().clamp_min(1e-6)
        per["aimOffset"] = F.smooth_l1_loss(out["aimOffset"].float(), y_off[batch_idx_t])
        per["spacing"] = F.smooth_l1_loss(out["spacing"].float(), y_sp[batch_idx_t])
        return per

    @torch.no_grad()
    def evaluate(idx, cap=200000):
        model.eval()
        use = idx if len(idx) <= cap else idx[np.linspace(0, len(idx) - 1, cap).astype(np.int64)]
        agg_loss = {k: 0.0 for k in list(CLASS_HEADS) + ["refrag", "aimOffset", "spacing"]}
        hits = {k: 0 for k in CLASS_HEADS}
        seen = {k: 0 for k in CLASS_HEADS}
        nb = 0
        for s in range(0, len(use), args.batch):
            b = use[s: s + args.batch]
            h, cond = gather_batch(b, obs, hist, cols, obs_size, device)
            bt = torch.from_numpy(b.astype(np.int64)).to(device)
            with amp_ctx():
                out = model(h, cond)
            per = losses_for(out, bt, train=False)
            for k, v in per.items():
                agg_loss[k] += float(v)
            nb += 1
            for k in CLASS_HEADS:
                y = y_dev[k][bt]
                ok = y >= 0
                if bool(ok.any()):
                    hits[k] += int((out[k][ok].argmax(1) == y[ok]).sum())
                    seen[k] += int(ok.sum())
        model.train()
        return ({k: v / max(1, nb) for k, v in agg_loss.items()},
                {k: hits[k] / max(1, seen[k]) for k in CLASS_HEADS})

    log(f"training {args.epochs} epochs, batch {args.batch}, "
        f"{steps_per_epoch:,} steps/epoch, amp={'bf16' if use_amp else 'off'}")
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t_start = time.time()
    seen_samples = 0
    step = 0
    best = None
    train_rate = 0.0

    for epoch in range(1, args.epochs + 1):
        perm = rng.permutation(len(tr_idx))
        ep_loss = {}
        ep_t0 = time.time()
        ep_samples = 0
        for s in range(0, len(perm), args.batch):
            b = tr_idx[perm[s: s + args.batch]]
            h, cond = gather_batch(b, obs, hist, cols, obs_size, device)
            if args.cond_dropout > 0:
                for key, size in (("map", cond_sizes["map"]), ("contract", cond_sizes["contract"]),
                                  ("call", cond_sizes["call"]), ("player", cond_sizes["player"])):
                    drop = torch.rand(len(b), device=device) < args.cond_dropout
                    cond[key] = torch.where(drop, torch.full_like(cond[key], size), cond[key])
            bt = torch.from_numpy(b.astype(np.int64)).to(device)
            with amp_ctx():
                out = model(h, cond)
            per = losses_for(out, bt)
            loss = sum(HEAD_LOSS_WEIGHT[k] * v for k, v in per.items())
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            seen_samples += len(b)
            ep_samples += len(b)
            for k, v in per.items():
                ep_loss[k] = ep_loss.get(k, 0.0) + float(v)
            prog.tick(step, epoch, seen_samples)
        nb = max(1, math.ceil(len(perm) / args.batch))
        train_loss = {k: v / nb for k, v in ep_loss.items()}
        train_rate = ep_samples / max(1e-6, time.time() - ep_t0)
        val_loss, val_acc = evaluate(va_idx)
        prog.losses = {f"train.{k}": v for k, v in train_loss.items()}
        prog.losses.update({f"val.{k}": v for k, v in val_loss.items()})
        prog.accuracies = val_acc
        prog.tick(step, epoch, seen_samples, force=True)

        elapsed = time.time() - t_start
        eta = elapsed / epoch * (args.epochs - epoch)
        gpu = torch.cuda.max_memory_allocated() / 1e6 if device == "cuda" else 0
        log(f"epoch {epoch:3d}/{args.epochs}  "
            f"{train_rate:,.0f} samp/s  gpu {gpu:,.0f}MB  {fmt_secs(elapsed)} elapsed  eta {fmt_secs(eta)}")
        log("   loss  " + "  ".join(
            f"{k}={train_loss.get(k, 0):.3f}/{val_loss.get(k, 0):.3f}"
            for k in list(CLASS_HEADS) + ["refrag", "aimOffset", "spacing"]))
        log("   val   " + "  ".join(f"{k}={val_acc[k]:.3f}" for k in CLASS_HEADS))
        best = (val_loss, val_acc)
        if stopping["flag"]:
            log("stopped early on SIGINT; saving what has been learned.")
            break

    total_elapsed = time.time() - t_start
    val_loss, val_acc = best if best else evaluate(va_idx)

    # ---- export -----------------------------------------------------------
    model.eval().to("cpu")
    export = build_export(model, meta, args, val_acc, val_loss, {
        "samples": n, "trainSamples": int(len(tr_idx)), "valSamples": int(len(va_idx)),
        "epochs": epoch, "device": device, "samplesPerSecond": round(train_rate, 1),
        "elapsedSeconds": round(total_elapsed, 1),
        "parameters": total, "exportedParameters": exported,
    })
    write_atomic(out_path, json.dumps(export))
    size_mb = out_path.stat().st_size / 1e6
    log(f"wrote {out_path} ({size_mb:,.1f} MB)")
    log(f"val accuracy: " + "  ".join(f"{k}={val_acc[k]:.3f}" for k in CLASS_HEADS))

    if args.parity:
        write_parity(model, meta, obs, hist, cols, va_idx if len(va_idx) else tr_idx, Path(args.parity), obs_size)
        log(f"wrote parity probe {args.parity}")


def rw(t):
    return [[round(float(x), 6) for x in row] for row in t.detach().numpy()]


def rv(t):
    return [round(float(x), 6) for x in t.detach().numpy().reshape(-1)]


def embed_table(emb, keys, name):
    """
    Export one conditioner table. The LAST row is the default: unseen keys ride
    it at inference rather than throwing, which is what keeps a bot alive when
    the operator names a call the corpus never contained.
    """
    W = emb.weight.detach().numpy()
    if len(keys) + 1 != W.shape[0]:
        raise SystemExit(f"{name} embedding has {W.shape[0]} rows for {len(keys)} keys")
    return {
        "dim": int(W.shape[1]),
        "default": [round(float(x), 6) for x in W[-1]],
        "keys": {k: [round(float(x), 6) for x in W[i]] for i, k in enumerate(keys)},
    }


def build_export(model, meta, args, val_acc, val_loss, stats):
    blocks = []
    for blk in model.blocks:
        blocks.append({
            "ln1": {"g": rv(blk.ln1.weight), "b": rv(blk.ln1.bias)},
            "wq": {"W": rw(blk.wq.weight), "b": rv(blk.wq.bias)},
            "wk": {"W": rw(blk.wk.weight), "b": rv(blk.wk.bias)},
            "wv": {"W": rw(blk.wv.weight), "b": rv(blk.wv.bias)},
            "wo": {"W": rw(blk.wo.weight), "b": rv(blk.wo.bias)},
            "ln2": {"g": rv(blk.ln2.weight), "b": rv(blk.ln2.bias)},
            "fc1": {"W": rw(blk.fc1.weight), "b": rv(blk.fc1.bias)},
            "fc2": {"W": rw(blk.fc2.weight), "b": rv(blk.fc2.bias)},
        })
    return {
        "v": POLICYNET_VERSION,
        "kind": "policyNet",
        # The id travels inside the artifact as well as in its filename, so a
        # model that gets copied into simdata/ still knows what it is.
        "id": args.name or "demo-g0",
        "obsVersion": meta["obsVersion"],
        "obsSize": meta["obsSize"],
        "datasetVersion": meta["datasetVersion"],
        "history": {"steps": HISTORY_STEPS, "hz": HISTORY_HZ, "pad": "zero"},
        "vocab": meta["vocab"],
        "embed": {
            "map": embed_table(model.emb_map, meta["cond"]["map"], "map"),
            "contract": embed_table(model.emb_contract, meta["cond"]["contract"], "contract"),
            "call": embed_table(model.emb_call, meta["cond"]["call"], "call"),
            "player": embed_table(model.emb_player, meta["cond"]["player"], "player"),
        },
        "temporal": {
            "dModel": args.d_model,
            "heads": args.heads,
            "ff": args.ff,
            "inProj": {"W": rw(model.in_proj.weight), "b": rv(model.in_proj.bias)},
            "pos": rw(model.pos),
            "blocks": blocks,
            "lnOut": {"g": rv(model.ln_out.weight), "b": rv(model.ln_out.bias)},
        },
        "torso": {
            "activation": "tanh",
            "layers": [{"W": rw(l.weight), "b": rv(l.bias)} for l in model.torso],
        },
        # Auxiliary heads (aimOffset, refrag, spacing) are deliberately absent: they
        # exist to shape the torso during training and mean nothing at runtime.
        "heads": {k: {"W": rw(model.heads[k].weight), "b": rv(model.heads[k].bias)} for k in CLASS_HEADS},
        "trained": {
            **stats,
            "valAccuracy": {k: round(float(v), 4) for k, v in val_acc.items()},
            "valLoss": {k: round(float(v), 4) for k, v in val_loss.items()},
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }


@torch.no_grad()
def write_parity(model, meta, obs, hist, cols, idx, path, obs_size):
    """
    A handful of real samples with the torch answer attached, so node can prove
    shared/sim/policyNet.js reproduces this trainer rather than merely loading
    its file. Cheap to write, and the only thing that catches a transposed
    weight or a layer-norm epsilon mismatch.
    """
    picks = idx[np.linspace(0, len(idx) - 1, min(6, len(idx))).astype(np.int64)]
    cases = []
    for i in picks:
        rows = np.asarray(hist[i], dtype=np.int64)
        pad = rows < 0
        frames = np.asarray(obs[np.where(pad, 0, rows)], dtype=np.float32)
        frames[pad] = 0.0
        h = torch.from_numpy(frames[None])
        cond = {k: torch.tensor([int(cols[k][i])]) for k in ("map", "call", "contract", "player")}
        out = model(h, cond)
        cases.append({
            "obs": [round(float(x), 6) for x in frames[-1]],
            "history": [[round(float(x), 6) for x in f] for f in frames[:-1]],
            "cond": {k: meta["cond"][k][int(cols[k][i])] for k in ("map", "call", "contract", "player")},
            "probs": {k: [round(float(x), 6) for x in out[k][0].softmax(0)] for k in CLASS_HEADS},
        })
    write_atomic(path, json.dumps({"obsSize": obs_size, "cases": cases}))


if __name__ == "__main__":
    main()
