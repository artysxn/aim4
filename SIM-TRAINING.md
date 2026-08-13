# Training sim bots

How to train a model, where it lands, and how to make the site play it. The
design behind all of this is SIM-PLAN.md sections 9.2, 9.2b and 9.9; this file
is the operator's half.

The rule that shapes everything below: **gradients only ever run on a machine
you own.** The website has no GPU and never trains. It loads a JSON file of
weights and runs a hand-rolled forward pass, so the product has no Python and no
native ML dependency at runtime.

## Where models live

Two directories, and the local one always wins:

| Path | What it is |
|---|---|
| `AIM4_REPLAY_DIR/sim/models/<name>.json` | trained here, on this machine, right now |
| `simdata/models/<name>.json` | committed to the repo, ships with every deploy |

That override is the whole local loop: train on your PC, the file lands in the
local directory, and the next match uses it. No deploy, no restart. Shipping a
model to the live site is a separate, deliberate act: copy it into
`simdata/models/` and commit.

`bc0` ships today: the generation-0 behavior clone, 71.7% validation accuracy
against a 27.6% majority-class floor, and it beats the scripted baseline in 90%
of paired matches.

## Training from your PC (the script)

One command runs the whole thing: collect a dataset from self-play, train,
evaluate against the baseline, install the result.

```bash
npm run sim:pipeline
```

Useful flags (all optional):

```bash
npm run sim:pipeline -- --map INF --matches 12 --rounds 12 --epochs 80 --name bc1
```

- `--matches` / `--rounds` how much self-play to collect. 6 x 12 is about 16k
  samples and 80 seconds.
- `--epochs`, `--embed-dim` the trainer's knobs. Embedding dim 0 turns the
  per-player mimic embedding off.
- `--name` what to install as. Use a new name to keep `bc0` intact.
- `--dataset <path>` train on a dataset you already have (implies skipping
  collection).
- `--skip collect,eval` run only the stages you want.
- `--dry-run` print the plan and the resolved Python, run nothing.

The stages are also available on their own: `npm run sim:collect`,
`npm run sim:train`, `npm run sim:eval`.

Python: the pipeline finds it before it does anything expensive, checking
`AIM4_PYTHON`, then `.venv-sim/`, then `python3` and `python` on PATH. It needs
numpy and nothing else. If none of them work it says so up front rather than
after a 90-second collection.

## Training from the panel (the UI)

The /sim page has a **Jobs** tab: host status, a job list with live progress,
and a stop button. Collection and training are started from there and run as
child processes, so a run started in a browser survives the tab closing.

Heavy jobs are off by default. Turn them on for the host you want to train on:

```bash
AIM4_SIM_WORKERS=1 npm run host
```

With it unset, the panel still runs matches (seconds of one core) and refuses
collection and training with an explanation. That default is deliberate: the
production box parses demos for the site, and a training grind must never be
the reason an upload sits in a queue. Sim work also yields to demo parsing
automatically, and every job carries a wall-clock budget it is killed at.

## Making the site play a model

1. Train it (either path above). It lands in `AIM4_REPLAY_DIR/sim/models/`.
2. Check it on the Run tab: the brain dropdowns list every registered model with
   its validation accuracy. A model that fails to load is listed as broken with
   the reason rather than hidden.
3. To ship it: copy the file to `simdata/models/<name>.json` and commit. The
   Dockerfile copies `simdata/`, so the deployed backend gets it.

## Training on demo data

The 3,500-demo library is the knowledge source, not self-play. Order is
SIM-PLAN 9.3b: bake per-contract tables from the whole set, extract BC through
the knowledge tracker (what the player knew, not god-view), train the
role-conditioned net, and leave the experience index off until that G0 is
honest. Banana on Inferno is every Inferno T Banana track in the 3,500, not a
global soup.

Run extract and train from the local sim lab (`npm run sim:lab` or
`tools/sim-lab.bat`), not from production. Self-play collect is still available
for plumbing tests; it is not generation 0 play.

The trainer file format does not change: JSONL in, JSON weights out. The
extract has to stop zeroing belief and start labelling spacing, utility,
reactions, and short option chains, or the bigger net has nothing to learn.

What already works with your own library: point `AIM4_REPLAY_DIR` at it, and
the /sim Export tab packages demos out of it for local use.
