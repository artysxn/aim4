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

### Phase 1: bomb and zone features (in progress, code written)

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

Remaining to wire:

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

### Phase 2: calibration layer

The model is additive in log-odds and cannot bend its own output curve per
regime. A cheap fix known to work on small models: fit a two-parameter Platt
scale (`p' = sigmoid(a * logit + b)`) per phase (early/mid/late) on training
data after the main fit. Three phases x 2 params, fitted in seconds, applied at
predict time. Expected to claw back most of the 4-6pt phase_early bias without
touching the features. Ship only if it improves held-out loss.

### Phase 3: travel time honesty

`bombRace` uses straight-line distance / 200u/s. Straight lines cross walls, so
travel is systematically underestimated on maps with detours (B tunnels on DD2,
Anubis mid). The walkable mask already exists (`getRadarLos`); a coarse BFS
distance field from each bombsite, baked once per map at extraction time, turns
distance into actual path length. Medium effort, clearly correct. Do after
Phase 1 proves the distance features carry weight at all.

### Phase 4: data

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
