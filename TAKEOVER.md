# TAKEOVER — 2026-08-15 (Mac session → next workstation)

Start here. Read this, then `HANDOFF-2026-08-15.md` for the deeper history of
the tape-following work (this file supersedes it where they disagree).

## Operator rules (carry these forward)

- **Never commit or push without explicit approval in the message that asks
  for it.** He commits himself. Everything below is uncommitted.
- He runs long jobs himself. Progress output on anything long-running is
  mandatory.
- Do not open browser tabs.
- Site copy rules live in `CLAUDE.md` (no em dashes, no marketing filler).

## Machine split — read before trusting any number

| | Mac (this session) | Windows data machine |
|---|---|---|
| v2 playbook corpus (9.8 GB, 65,778 tapes) | **absent** | `server/data/replays/sim/playbook/` |
| Demos (3,122 `.aim4replay`) | absent | `D:/Dev/trainingdemos/` |
| v1 shipped tapes (`simdata/playbook`, 212 MB) | present, committed | present |
| Bakes (navcache/angles/knowledge, 7 maps) | present | present |

The v1 tapes carry **no coordinates**, so `npm run sim:tape` reads follow
0.0% on any machine without the v2 corpus — that is the data, not a
regression. Use `npm run sim:tape-synth` there instead (see Tools).

## What landed this session (all uncommitted)

Five fixes and one side quest. Full rationale in `HANDOFF-2026-08-15.md`;
this is the index.

### 1. Knife-out root cause — the committed-path stomp (was the IN FLIGHT item)

`shared/sim/desireBot.js`. desireBot has two `translator.setIntent` sites: the
full-decide one (patched through `patchLineup(patchTrace(patchLooseBomb()))`)
and the committed-option one (`runner.active && !runner.mayReplace`), which
re-sent the option's intent through `patchLooseBomb` **only**. Options commit
for seconds and the committed path re-sends every 125 ms decide pass, so a
trace intent and its knife ask survived one pass and were stomped for the
length of every commitment. Fix: identical patch chain on both sites.

Measured A/B (`sim:tape-synth`, same seed): pre-contact `intent.knife` and
`knifeOut` 0.1% → 16.7% at the time of the fix, and they MATCH each other,
meaning the engine grants every ask. With the fixture holes also closed
(below) the current reading is 84.6%.

Side effect worth knowing: the old `tapeStats` numbers were biased — counters
only ran on full decides, so "follow 56%" was measured over ~3% of passes.

### 2. Off-tape reasons are now measurable (answered handoff step 3)

`caller.offTapeReason(slot, seconds)` names why a slot is not following
(`retired | mode | role | local | end | noTrace | noCaller`); `isOnTape` is
now a null-check over it. desireBot counts reasons split at first blood
(`offReasonsPre/Post` in `tapeStats`), and `sim-tape-fidelity.mjs` prints the
split under each row.

Finding: after fix 1, pre-contact off-tape decisions are **zero** in the
synthetic probe. The clock-lag fall-off (`markLocal` at TAPE_ERROR_UNITS=180 /
TAPE_LAG_SECONDS=10, desireBot ~2525) fires 2-6 times per 4-round match —
harmless today, but it judges wall-clock lag, which the pursuit model
deliberately allows. Watch it on real tapes.

### 3. tapeEnd is path-aware; a re-call cannot join a spent tape (#17 groundwork)

Two defects found by reading the miner against the follower:

- `tapeEndSeconds` was waypoint/utility-only, but the miner writes waypoints
  only on anchor CHANGE while the path runs to the recording's end. Any tape
  ending in a hold (every defensive tape, every pre-execute wait) had a
  tapeEnd far short of its path, and `isOnTape` cut the team off ('end')
  while `traceAt` still had answers. Now maxes in the fine path:
  `pathEndSeconds` when hydrated, plus a new `pathSeconds` stamp on light
  sidecar entries.
- `scoreMatches` (playbook.js) scored re-call candidates by opening shape
  only, so a re-call could join a tape whose whole reach was already over at
  the join clock. Now skips those (same 10 s grace as the follower's gate).

**`META_VERSION` 1 → 2 in `server/sim/playbookStore.js`.** Existing sidecars
on the data machine rebuild themselves on first open (seconds per file, it is
the same scan that built them). Expect that pause on the first run there.

### 4. Multiple CTs could defuse at once (operator bug report)

- `shared/sim/engine.js` `beginDefuse`: refuses while any living body holds
  the wire; frees when the channel breaks. Regression test in
  `engine.test.js`.
- `shared/sim/desireBot.js`: the engine fix alone would have piled every CT
  onto the bomb waiting for the wire, because every living CT pushed the
  forced `defuse` candidate. The ready-retake branch now designates ONE
  defuser (kit holder preferred, then nearest) and gives the rest forced
  `crossfire_hold` posts that can see the bomb (`R.defuseCover`, built like
  the T afterplant posts). Re-designates automatically if the defuser dies.

### 5. Small ones

- `shared/sim/translator.js`: latent `body.focusVisible` (field does not
  exist) → `body.focus === null`.
- `scripts/sim-extract-bc.mjs`: sticky `p.dead` dropout bug (2.4% of
  player-rounds) fixed with the miner's grace pattern. **The re-extract
  itself still needs the data machine.**
- New `server/sim/playbookStore.test.js` (light stamps + byte-exact
  hydration), wired into the npm test chain.

### 6. Side quest: the 3D replica plan

`CS3D-PLAN.md` and `CS3D-ASSETS.md` (both new). See "3D side quest" below.

## Verification status

- **All `shared/sim/*.test.js` and `server/sim/*.test.js` green** as of the
  last change. That is the bar; run it after anything.
- `npm run sim:tape-synth` is deterministic run-to-run (verified).
- `npm run sim:tape -- --maps INF --matches 1 --rounds 8` runs clean (~14 s).
- `node scripts/sim-extract-bc.mjs --rounds 2` smoke-tested: 20 tracks, 99%
  label coverage, 2.2 s.

Full battery:

```bash
for t in shared/sim/*.test.js server/sim/*.test.js; do node "$t" || echo "FAIL $t"; done
```

## Tools you will want

```bash
npm run sim:tape-synth                              # portable follow/knife probe
npm run sim:tape -- --maps INF --matches 2 --rounds 16   # real corpus, fast check
npm run sim:tape -- --maps INF,DD2,MIR --compare         # v1 vs v2, ~5 min
```

`scripts/sim-synth-tape.mjs` is new and is the important one for portability:
it builds a synthetic v2 playbook from real nav-graph routes, so follow/knife
fidelity is measurable on a machine with no corpus. A probe like this lived
in a session scratchpad twice and was destroyed by a workstation switch both
times — it is in the repo now, do not move it back out.

## Next steps, in order

1. **On the data machine, re-run the real numbers.** `sim:tape` with the
   reason split now says directly how much post-contact tape death is finite
   tapes ('end') vs re-calls that found nothing ('mode') vs plant
   ('retired'). Expect pre-contact speed ~190+ u/s and pre-contact error
   moving toward 300-400u (natural floor ~320u = 1.5 s lookahead × 215 u/s).
   First open rebuilds sidecars (META_VERSION 2).
2. **Full fidelity run, all 7 maps, `--compare`.** Report the v1 vs v2 table.
3. **BC re-extract + retrain** on the fixed corpus (old tasks #8/#18). The
   extractor fix is in; the aim head gets its first real yaw supervision
   because v1 waypoints carried zero view angles. Biggest model-quality
   lever outstanding.
4. **Task #18, knowledge-fed arbiter** ("fixes avoid taking positions").
   **Blocked on the operator** — I only have the one-line title, and he was
   asked to brief it. Ask before designing.
5. **Task #17, chaos/re-call** (post-contact tape death). Groundwork above is
   done; the real-corpus reason split tells you where the rest is.

## Open questions for the operator

1. **Task #18 brief** (see above).
2. **Defuse mindgames.** He described: fake defuses to bait Ts, Ts
   discounting defuse sounds as fakes, double-tap defuse as a stress tell.
   I did NOT implement any of it — it is belief/WHY-layer design, not a bug
   fix. The mechanics already exist (defuse start emits `SOUND.DEFUSE`,
   move/damage cancels, tap-cancel-tap is expressible); what is missing is
   cognition: a T belief that treats a defuse sound as evidence with a
   liar's prior (kit vs bare changes the wait-out math), and a CT model of
   whether the bluff can even reach anyone. Natural home: §19 belief
   evidence + §21 WHY layer + 18.8 opponent tendency. He may want it specced
   as a SIM-PLAN section the way §21 was.
3. **Knife off-tape?** Should knife ride off-tape pre-contact movement
   (advance/rotate while `!contactMade`), not just trace intents? Deliberately
   not done: CT holds want the gun up, so it needs care.
4. **v2 corpus in git?** Still undecided — a curated subset for prod was
   raised in the previous handoff and never settled. Prod still runs v1.

## 3D side quest (new, planning only — no code)

`CS3D-PLAN.md`: a playable 3D CS replica, for viewing demos in 3D first and
training bots in 3D later. Key decisions already made with him:

- **Three.js on the WebGL2 backend.** He asked whether raw WebGL/WebGPU would
  be better; the answer is that those are the layers *below* Three, not
  alternatives to it, and aim4 already ships Three 0.169. Map scale is an
  importer problem (chunking, culling, instancing, KTX2), not a renderer-API
  problem. WebGPU stays a later backend swap behind the same scene code.
- **Demo playback is milestone 1, before any physics.** `tickFormat.js`
  already stores x/y/z/yaw/pitch per player per tick, so 3D playback is pure
  rendering over data we ship. It also validates the whole asset pipeline
  against 3,122 demos of ground truth before movement code exists.
- **One brain, two bodies.** `engine3d` implements the 2D engine's API
  surface; desireBot/caller/tapes never learn they are in 3D.
- **Assets stay local forever.** Extracted from his own install into
  `server/data/cs3d/raw/` (already gitignored), never served, never bundled.

`CS3D-ASSETS.md` is the extraction checklist he is working through right now
(maps: world glTF + vphys collision + entity dump + radar, per map, INF
first; two character models; 33 weapon worldmodels matching
`shared/sim/weapons.js`; grenades, c4, kit; viewmodels optional; sounds
optional). **He is extracting now — when a drop lands, build the importer
against `maps/INF/` first: transform + chunking + BVH bake + `meta.json`,
then the anchor-overlay check (CS3D-PLAN step 3D-0) before anything else.**

Still unanswered from CS3D-PLAN §12: the reference replica's repo **and
license** (decides port-vs-oracle for its movement/animation code), CS2-era
vs CS:GO-era assets, confirm INF first, and whether the 3D viewer needs
non-operator users soon.

## Files touched this session

```
M  shared/sim/desireBot.js     patch chain on committed path; off-tape reason
                               counters; one-defuser + cover posts; R.defuseCover
M  shared/sim/engine.js        beginDefuse single-wire refusal
M  shared/sim/engine.test.js   + defuse contention block
M  shared/sim/caller.js        offTapeReason(); isOnTape via it
M  shared/sim/playbook.js      tapeEndSeconds path-aware; scoreMatches join filter
M  shared/sim/playbook.test.js + join-filter block; behind-late fixture reach
M  shared/sim/translator.js    focusVisible -> focus === null
M  server/sim/playbookStore.js pathSeconds stamp; META_VERSION 2
M  scripts/sim-extract-bc.mjs  dropout grace
M  scripts/sim-tape-fidelity.mjs  prints off-tape reason split
M  package.json                + playbookStore.test.js, + sim:tape-synth
M  HANDOFF-2026-08-15.md       updated throughout
A  server/sim/playbookStore.test.js
A  scripts/sim-synth-tape.mjs
A  CS3D-PLAN.md
A  CS3D-ASSETS.md
A  TAKEOVER.md                 this file
```

Earlier uncommitted work from the previous session is described in
`HANDOFF-2026-08-15.md` and was committed as the "Project Navajo" commits;
verify with `git status` on arrival, since that was a different machine.
