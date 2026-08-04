# Round win predictor: accuracy plan

Where the round model stands, what is proven to be wrong with it, and the ordered
list of changes expected to move it. Written 2026-08-05. Companion code lives in
`src/replays/rounds/` and `scripts/train-round-model.mjs` / `scripts/lib/roundCorpus.mjs`.

## 1. Where we are

Fitted on 612 rounds / 50,304 snapshots from 30 demos (Nuke excluded, no painted
vision). Validation is held out by demo. Best model was generation 25 of 100;
everything after that overfitted, and the export correctly selects on held-out loss.

| Measure | Value | Coin flip |
|---|---|---|
| Validation log loss | 0.4407 | 0.6931 |
| Exam 1, early to mid | 0.5092 / +3.59 per round | 0 |
| Exam 2, mid to late | 0.3921 / +5.04 per round | 0 |
| Exam 3, 10s before end | 0.2021 / +7.35 per round | 0 |

Calibration overall is 0.0pt off across all rounds, no 5% bin worse than 3.3pt.

Worst buckets on held-out demos, which is where the accuracy is hiding:

| Bucket | Rounds | Off by |
|---|---|---|
| planted | 20 | 7.5pt |
| man_t_up | 29 | 6.2pt |
| eco_t | 20 | 6.0pt |
| phase_early / man_even | 47 / 62 | 4-6pt |

## 2. Root causes found so far

**A. (BUG, fix already applied) Post-plant rounds were being censored.**
`decidedSideAt` in `coach/winProbability.js` treated "all Ts dead" as a decided
round even with the bomb planted. Extraction therefore skipped every moment of
the shape "bomb ticking, Ts dead or dying, CTs racing the clock". The corpus
contained literally zero snapshots with `planted && tAlive === 0`. This is
exactly the situation the model was weakest in (`planted` bucket, `noDefuseW`
fitted to a meaningless -0.09). Fixed: a plant now keeps the round alive until
defused, exploded, or the CTs are wiped.

**B. The model knew the bomb timer but not the bomb geometry.**
"9.9 seconds left, no kit, nearest CT across the map" was invisible: time and
kit were features, distance was not, so the model could not represent that the
defuse physically cannot happen. Also invisible: who is standing in the site,
who holds the approach zones, and whether the specific CT who must retake can
win the specific fight waiting for them.

**C. Data volume is the ceiling for the tail buckets.**
20 planted rounds held out is not enough to calibrate a plant model, whatever
the features. Both models (duel and round) have now shown the same shape:
optimizer converges in under 30 generations, mutation finds nothing, remaining
error concentrates in thin buckets.

## 3. The plan, in order

### Phase 1: bomb and zone features (WIRED AND MEASURED, 2026-08-04)

All four wiring steps below are done. 35 parameters, spec `6c4767ef`. The corpus
was re-extracted at `FEATURE_VERSION` 2 over 42 demos: **937 rounds / 83,173
snapshots**, up from 612 / 50,304. `planted && tAlive === 0` now has 1,069
snapshots, up from literally zero, and 4,471 snapshots carry `defuseImpossible`.

Measured against a control run on the **same corpus, same seed, same 10
generations**, with the seven new weights pinned to zero. The published v1 table
in section 1 is not a fair comparison for this: it was fitted on a smaller
corpus with a different holdout split, and it excluded the post-plant moments
that bug A was censoring, which are the hard ones.

| | control (v1 features) | Phase 1 | |
|---|---|---|---|
| Validation log loss | 0.4570 | **0.4462** | -0.0108 |
| Validation brier | 0.1536 | **0.1499** | -0.0037 |
| Exam 1, early to mid | 0.5621 | **0.5539** | -0.0082 |
| Exam 2, mid to late | 0.4525 | **0.4393** | -0.0132 |
| Exam 3, 10s before end | 0.1877 | **0.1739** | -0.0138 |
| `planted` bucket loss | 0.294 | **0.275** | -0.019 |
| `planted` bucket calibration | 5.5pt | 5.6pt | +0.1pt |

Against the success criteria: Exam 3 under 0.20 met (0.1739), Exams 1-2 not
worse met, `planted` under 5pt **not** met at 5.6pt. Note what that pair of
`planted` rows says: the new features made the post-plant prediction sharper
(loss down 0.019) without moving the systematic bias at all. That bias is
exactly what Phase 2 exists for, and this is the evidence that Phase 2 is the
right next step rather than more bomb features.

Caveat on the run: 10 generations is not converged. Every single generation was
the new best on held-out loss and it was still falling at gen 10, where v1's
best was gen 25 of 100. Both sides of the table are underfit by the same amount,
so the comparison holds, but the absolute numbers will improve on a longer run.

What the fitted values say, provisionally:

- `bombDistW` 1.54 against a max of 2. The distance race is the strongest of the
  new terms and is pushing toward its bound; widen it on the next run.
- `approachDistW` 0.91, free-signed and fitted strongly positive. A T side still
  far from the site it is converging on is a real CT advantage, pre-plant.
- `defuseSlackW` 1.19 with tau 9.5, carrying the defuse-feasibility signal.
- `defuseImpossibleW` -0.11 and `noDefuseW` exactly 0. Both collapsed: the
  continuous slack term absorbed the whole signal, so the two hard binary flags
  are redundant. Consider dropping `noDefuseW` outright.
- `bombDuelW` 0.00, sat at its floor. The duel model's verdict on the bomb fight
  added nothing over the distance race. `bombDuelEdge` may be dead weight.
- `kitW` 1.44, up from an init of 0.7. The kit matters much more than v1 thought,
  which is a direct consequence of bug A no longer censoring the rounds where a
  kit decides things.

Params are NOT exported: `roundModelParams.js` still holds the v1 values and a
stale `specHash`. `fromNamed` falls back to init for the eight new names, so
nothing is broken, but the shipped model is still v1 until a converged run is
exported.

#### Original plan for this phase

New module `src/replays/rounds/bombRace.js` (done) computes, per snapshot:

- `ctBombDist` / `tBombDist` / `bombDistDiff`: nearest alive player on each
  side to the bomb (planted position after a plant, the T side's nearest site
  before one).
- `ctInSite` / `tInSite`: bodies standing inside the live bombsite polygon,
  from the painted `bombSites` on all six maps.
- `keyZoneNet`: painted key zones around the live site, scored +1 CT / -1 T by
  body count, averaged. "Which zones are in whose possession."
- `defuseSlack` / `defuseImpossible`: bomb seconds left minus (travel time at
  200u/s + defuse time with/without kit). The hard "cannot win that" fact,
  valid for any number of CTs alive.
- `bombDuelEdge` (in `roundFeatures.js`, done): the duel model's verdict on the
  fight between the nearest CT and nearest T to the bomb. "Compare player
  distance to the bomb and the expected duel winrate if they take the fight."

Wired:

1. `roundParamSpec.js`: add ~8 parameters, all bucketed to `planted` or
   phase buckets so blame steering can reach them:
   `bombDistW`, `siteOccW`, `keyZoneW`, `bombDuelW`, `defuseSlackW`,
   `defuseImpossibleW` (bounds wide, min strongly negative), plus a pre-plant
   `approachDistW`.
2. `roundModel.js`: terms. `defuseImpossibleW` fires only when
   `planted && defuseImpossible`; `defuseSlack` enters through a saturating
   `tanh(slack / tau)` so seconds near the boundary matter most; site
   occupancy and key zones as plain differences; `bombDuelW * bombDuelEdge`
   gated on planted.
3. `roundCorpus.mjs`: encode the new fields, bump `FEATURE_VERSION` to 2.
4. Re-extract (~20s), retrain 30 generations (~40s), compare all three exams
   against the v1 numbers above. Success: `planted` bucket under 5pt,
   Exam 3 loss below 0.20, Exams 1-2 not worse.

### Phase 2: calibration layer (BUILT, MEASURED, REFUSED, 2026-08-04)

Built as specified in `src/replays/rounds/roundCalibration.js`, fitted by Newton
on the two parameters per phase, wired into the trainer behind the ship-gate
below. **The gate refuses it, and the premise underneath it turns out to be
wrong.** The trainer now prints this every run:

```
    early  a=1.1138  b=0.0002
    mid    a=0.9979  b=-0.0905
    late   a=1.0013  b=0.0056
    held-out loss 0.4483 raw -> 0.4493 calibrated (+0.0011)
    ceiling if fitted on the held-out rows themselves: 0.4412 (-0.0071)
```

The stated premise was that the model "is additive in log-odds and cannot bend
its own output curve per regime". Measured in-sample, that is not what is
happening. The raw model on **training** rows is off by 0.7pt early, 1.0pt mid,
0.2pt late. It bends its curve fine. The 4-6pt figure in section 1 is measured
on held-out demos and is a **generalization gap, not a curve-shape problem**, so
fitting the curve on training data has nothing to find: it fits a≈1, b≈0.

The ceiling line is the same fit made against the validation rows themselves.
Unshippable by construction, but it bounds the whole idea: a *perfect* per-phase
calibration is worth 0.0071 here. And its shape gives the game away. Fitted on
held-out it wants b = +0.18 / +0.23 / +0.29, a near-uniform positive shift
across all three phases, which is not a per-phase curve at all. It is
re-centering the global CT prior onto the holdout's base rate. Those demos
simply had more CT rounds than the training demos did, and no amount of fitting
on training data can know that in advance.

What is real in that ceiling fit is `a` = 0.78 / 0.83 on mid and late: the model
is genuinely overconfident out-of-sample, which is ordinary overfitting. That is
estimable, but only from out-of-fold predictions, which means refitting the
model K times over demo-level folds. That is a Phase 4-scale investment and it
should be spent on demos first.

Kept rather than deleted, because the fit is correct, it costs nothing when it
declines, and the ceiling line is a genuinely useful per-run diagnostic. If the
corpus grows enough that the holdout base rate stops wandering, this turns on by
itself.

#### Original plan for this phase

The model is additive in log-odds and cannot bend its own output curve per
regime. A cheap fix known to work on small models: fit a two-parameter Platt
scale (`p' = sigmoid(a * logit + b)`) per phase (early/mid/late) on training
data after the main fit. Three phases x 2 params, fitted in seconds, applied at
predict time. Expected to claw back most of the 4-6pt phase_early bias without
touching the features. Ship only if it improves held-out loss.

### Phase 3: travel time honesty (DONE, 2026-08-04)

`src/replays/zones/pathDistance.js`: a Dijkstra sweep out from the target across
the walkable radar mask, coarsened to a 256x256 lattice (4 radar pixels, ~20
world units a cell), eight-connected with chamfer weights of 1 and root two.
Cached per map and target cell, so a round's plant is swept once and shared by
every snapshot in it, and the two bombsite centres are swept once for the whole
extraction. A sweep costs 6-22ms. `bombRace.js` uses it for every distance and
falls back to the straight line when a point is off the lattice.

How wrong the straight lines were, measured site to site:

| Map | straight | on foot | | hidden travel |
|---|---|---|---|---|
| INF | 2965 | 3919 | 1.32x | +4.8s |
| ANC | 2613 | 3330 | 1.27x | +3.6s |
| ANU | 2846 | 3275 | 1.15x | +2.1s |
| CCH | 2916 | 3159 | 1.08x | +1.2s |
| MIR | 2827 | 3038 | 1.07x | +1.1s |
| DD2 | 2528 | 2703 | 1.07x | +0.9s |

The plan guessed DD2 and Anubis as the worst offenders. It is Inferno and
Ancient, and by a wide margin. Consequence in the corpus: the share of post-plant
snapshots where a defuse is physically impossible goes from 29.7% to **32.5%**.
Straight lines were telling the model a defuse could be started in 412 moments
where it could not.

`APPROACH_SPEED` stays at 200 u/s. It was quietly doing two jobs, standing in
for the detour as well as for the rifle and the corners; now it only does the
second, and its comment says so.

Measured against a control run on the v2 cache, same seed, same 5 generations:

| | v2, straight lines | v3, on foot | |
|---|---|---|---|
| Validation log loss | 0.4490 | **0.4483** | -0.0007 |
| Exam 1 | 0.5579 | 0.5578 | -0.0001 |
| Exam 2 | 0.4420 | 0.4418 | -0.0002 |
| Exam 3 | 0.1769 | **0.1746** | -0.0023 |
| `planted` bucket loss | 0.279 | **0.276** | -0.003 |

Correct, cheap, and small. The gain is real and lands where it should, on the
last ten seconds and after a plant, but it is a tenth of what Phase 1's features
were worth. Worth keeping because it is strictly more honest and costs nothing
at predict time; not worth having expected more from. The straight line was
biased, but it was biased fairly evenly across both sides of a retake, and the
model had already absorbed most of that into `bombDistW`.

#### Original plan for this phase

`bombRace` uses straight-line distance / 200u/s. Straight lines cross walls, so
travel is systematically underestimated on maps with detours (B tunnels on DD2,
Anubis mid). The walkable mask already exists (`getRadarLos`); a coarse BFS
distance field from each bombsite, baked once per map at extraction time, turns
distance into actual path length. Medium effort, clearly correct. Do after
Phase 1 proves the distance features carry weight at all.

### Phase 4: data

**Now the only thing left that moves the number.** Phases 1-3 are spent: Phase 1
bought -0.011 held-out loss, Phase 3 bought -0.0007, and Phase 2 measured its
own ceiling at -0.0071 and could not reach it because the limit was demo
variance rather than model shape. Every remaining error the diagnostics can see
is thin-bucket noise or a generalization gap, and both of those are demos.

The recurring bottleneck. Concrete asks, in value order:

1. More demos. 30 to 60 roughly halves the noise floor on every thin bucket;
   the parse pipeline is drag-and-drop (`npm run parse-demo`).
2. Cache is 1 demo on CCH (22 rounds carried the whole map prior). Any Cache
   demos disproportionately help `map_CCH`.
3. Nuke stays excluded until its vision layers are painted; that is a
   painting task, not a code task.

### Phase 5: things deliberately not planned

- GPU training: measured, wrong shape, CPU threads already give 10x.
- Deeper model (interactions, trees, nets): 27 -> 35 parameters on 612 rounds
  is already near the data limit; add capacity only after Phase 4.
- Training on the exam score: stays banned, it rewards overclaiming; log loss
  selects, exams report.

## 4. Verification, every phase

- `npm test` (roundModel.test.js guards sign directions and plant gating; add
  cases for the new terms, especially defuseImpossible forcing P(CT) low even
  at 5v0 with 9.9s left and no kit).
- Retrain with fixed seed, read the three exams per generation; export selects
  on held-out loss, best-generation number is printed and must be trusted over
  the final generation.
- Calibration probe (scratchpad probe-round-calib.mjs): overall bin error and
  the three exam tables, all rounds and held-out.
- `npm run build` before committing anything (repo convention).
