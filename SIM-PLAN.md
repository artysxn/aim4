# AIM4 /sim: Self-Evolving CS2 Bot Simulation

A hidden page at `aim4.io/sim`, visible only to @artysan, that runs full simulated
CS2 rounds and matches between two teams of 5 ML-driven 2D bots on the real map data
the site already has. Bots perceive the world exactly the way the Team POV mode
computes knowledge, move with the exact Source movement integrator the trainer uses,
fight with a humanized pro-capped aim motor (never an aimbot), take round-library
calls as commands, freely pick their spawns, follow a real team's recorded
movement until something happens, then re-plan locally (the bots who were
hit) or as a hivemind (the whole team), and evolve across generations through
imitation learning plus reinforcement learning, with the fitted xK duel model
as training wheels for the reward. Skill is a knob, per bot or for the whole
side, always inside a pro envelope, never an aimbot.

The ML learns **decisions only**. A fixed translator turns decisions into inputs
(the 2D equivalent of pressing W), so the same trained brains port to real CS2
server bots later by swapping the translator, not the model.

Above the round sits a third brain and a memory. The Strategy AI reads an
experience index of every situation the team has ever been in, so a match is 24
rounds against an opponent rather than 24 unrelated rounds, and a lineage is
millions of rounds of accumulated read. Generations are graded on an absolute
scale against the professional population the library already contains, not just
against their own parents, because "tier 1" has to mean something a number can
fail.

**What this is for.** Bots that play like tier-1 professionals without being
professionals, so that real players can practice against them. Bot versus bot is
the training ground, not the destination: the destination is a team loading up
the side they play on Thursday and scrimming against it, with the bots sampling
how those specific players clear angles, peek, and time their utility (10.3).
Every trade-off in this document resolves toward that.

Everything in this plan is grounded in code that exists today. File paths are real.
Where a CS2 constant is quoted from memory it is marked `[verify]`, meaning: check
against current game files or the wiki at implementation time, then freeze it into
`shared/sim/constants.js` and never touch it silently again.

---

## Table of contents

- [0. Requirements traceability](#0-requirements-traceability)
- [1. What exists today and is load-bearing](#1-what-exists-today-and-is-load-bearing)
- [2. Phase 0: the hidden /sim page and access control](#2-phase-0-the-hidden-sim-page-and-access-control)
- [3. Architecture overview](#3-architecture-overview)
- [4. The simulation engine](#4-the-simulation-engine)
- [5. Perception and knowledge: what bots know](#5-perception-and-knowledge-what-bots-know)
- [6. The decision architecture: Playstyle AI, Individual AI, translator](#6-the-decision-architecture-playstyle-ai-individual-ai-translator)
- [7. Observation and action spaces, spelled out](#7-observation-and-action-spaces-spelled-out)
- [8. The aim model: pro-capped, never aimbot](#8-the-aim-model-pro-capped-never-aimbot)
- [9. Training: imitation, reinforcement, generations](#9-training-imitation-reinforcement-generations)
- [10. Commands, following, interrupts, and mimicry](#10-commands-following-interrupts-and-mimicry)
- [11. The /sim page UI](#11-the-sim-page-ui)
- [12. Storage, formats, and APIs](#12-storage-formats-and-apis)
- [13. The 3D port path](#13-the-3d-port-path)
- [14. IFs, BUTs, MAYBEs: risks and edge cases](#14-ifs-buts-maybes-risks-and-edge-cases)
- [15. Build order and acceptance criteria](#15-build-order-and-acceptance-criteria)
- [16. Decisions (resolved)](#16-decisions-resolved)
- [17. Prior art: bots that work in other games](#17-prior-art-bots-that-work-in-other-games)
- [18. Experience: what a team carries between rounds](#18-experience-what-a-team-carries-between-rounds)
- [19. Visualization: the tier-1 faculty](#19-visualization-the-tier-1-faculty)
- [20. The doctrine layer: Counter-Strike 101 as an architecture](#20-the-doctrine-layer-counter-strike-101-as-an-architecture)

---

## 0. Requirements traceability

The brief, mapped to where this plan answers it.

| # | Requirement (from the brief) | Sections |
|---|---|---|
| A | Hidden page `/sim`, only @artysan | 2 |
| B | Real rounds/games, spawn data from the 2D creator | 1.2, 4.2, 4.12 |
| C | One round at a time, LIVE knowledge via Team POV + possession | 5, 11.2 |
| D | 2D sim behaves like real demos: movement speed, velocity, step sound, shot sound | 4.4, 4.7, 4.8 |
| E | ML is decisions only; fixed decision-to-input translator; portable to 3D | 6, 13 |
| F | Hivemind + individuals: Playstyle AI and Individual AI | 6.2, 6.3, 9.6 |
| 1 | Bots take round-library calls as commands and execute them | 10.1 |
| 2 | Follow the plan until something happens; affected bots or the whole team re-plan | 10.2, 10.4 |
| 3 | xK as evolution training wheels; copy real demos for decisions | 9.5, 10.3 |
| 4 | Assigned roles and positions per map | 6.4, 6.19 |
| 5 | Bots modelled on real players; mimic a team's actual movement | 10.3, 10.4 |
| 6 | Game-engine constraints replicated: economy, speeds, halftime, buy time, utility travel | 4.5 to 4.10 |
| 7 | Kill awards 100 / 300 / 600 / 900; bomb money depends on explode vs elim order | 4.5, 4.9 |
| 8 | Bots freely choose among available spawns each round | 4.12 |
| 9 | Skill tunable per bot or for the whole team | 8.4 |

### 0.1 Second pass: off-script behavior

The first pass answered "what happens while the bots are on a plan". Most of the
watchable value is in the other half: what a bot does when the tape is dead, when
it is alone, when it does not know where anyone is. This revision adds that half
and fixes three honesty holes found while writing it.

| # | Requirement (second brief) | Sections |
|---|---|---|
| S1 | Off-script behavior as its own architecture, not "the tape ran out" | 6.6 |
| S2 | PRW and PFW (xK) as the decision currency, not decoration | 6.7 |
| S3 | A surprise factor: smoke walks, molly runs, objectively bad plays | 6.9 |
| S4 | Unawareness and timing advantage as a resource a bot spends | 5.5, 5.6, 6.7 |
| S5 | Navigating and choosing between angles | 6.8, 6.12 |
| S6 | Borrow from bots that work in other games | 17, 6.10, 6.11, 9.10 to 9.15 |
| S7 | Specifically: CS2, Dota 2, StarCraft II, Football Manager, FIFA | 17.1 to 17.5, and the mechanisms they produced in 4.2, 6.8, 6.13 to 6.17 |

Three corrections to the first pass, each of them a bot cheating quietly:

1. **Teammate intent was telepathy.** 7.2 handed every bot its teammates' `task`
   one-hot for free. Real teammates learn intent from a call (delayed, 5.1) or by
   watching where the man went. Fixed in 7.2.
2. **Decisions had no reaction time.** 8.1 caps the crosshair at human speed, and
   then an 8 Hz policy re-decides strategy 125 ms after any event. Mechanically
   human, tactically superhuman. Fixed in 5.7.
3. **The belief could not answer a question.** A reachability ball (5.2) cannot be
   sampled, cannot absorb negative information ("I just cleared banana, so nobody
   is there"), and cannot price a peek. Replaced by a particle filter in 5.5,
   which is what every other feature in this revision reads from.

### 0.2 Third pass: getting good, and staying good

The first two passes describe a bot that acts. They do not describe a bot that
*improves in a way we can prove*. This pass answers four questions that were
open: how a generation is graded on an absolute scale rather than against its
own parents, how evolution is actually run, what a role owes its team, and where
memory across rounds lives.

| # | Requirement (third brief) | Sections |
|---|---|---|
| T1 | CS bots are terrible: take the architecture, not the skill level | 9.23, 17.1, 17.8 |
| T2 | Grade a generation's performance on an absolute scale | 9.16 to 9.19 |
| T3 | Run them, evolve them, turn them into good players | 9.20 to 9.22, 9.24 |
| T4 | Are roles integrated properly? | 6.19 (they were not; role contracts fix it) |
| T5 | Do bots understand cores? | 6.18 |
| T6 | Do bots learn from their own mistakes? | 18.6 |
| T7 | A strategy network that learns across rounds, not inside them | 18.4 |
| T8 | Recognize a situation the team keeps losing, and avoid it | 18.2, 18.3, 18.5 |
| T9 | Experience: 10k rounds at 90% beats 10 rounds at 99% | 18.1, 18.8 |

Two corrections to the previous passes, both of them the same mistake in
different clothes:

1. **Roles were labels, not contracts.** 6.4 hands the policy a role embedding
   and calls it role integration. The roles module (`computeRoles.js`,
   `mapRoleAssign.js`) is a *classifier*: it reads demos and names what a player
   did. Nothing in it tells a bot what an Anchor owes the round. A role that only
   conditions a softmax is decoration; the network is free to learn that the
   Lurk embedding means nothing. 6.19 turns each role into a contract with
   zone rights, a utility budget, a timing window, trade obligations, and death
   permission, and 9.17 grades bots on whether they honored it.
2. **The bot had no memory above the round.** Everything in sections 5 to 8
   resets at freeze. A team could lose the same B execute nine times and walk
   into it a tenth, because nothing in the architecture is allowed to remember
   round 9 during round 10. Section 18 adds the layer that does, and makes it
   explicitly *data* rather than weights, so it accumulates across matches and
   is inherited by future generations.

### 0.3 Fourth pass: the vocabulary that already existed

The pattern finder and the antistrat scan were sitting in the repo, finished and
tuned, describing exactly the things this plan was about to reinvent badly.
`patternDefs.js` is a complete grammar for how a round starts (lanes, formation
notation with the AWP mark, snapshot clocks, six pace types, a fake descriptor
that already talks about cores). `antistratScan.js` is most of an opponent model
(`classifyPace`, `aggTells` at 5 rounds and 80% share, `aggCtSpread`,
`aggResponses`, `pistolLean`). Both are now load-bearing rather than referenced.

| # | Requirement (fourth pass) | Sections |
|---|---|---|
| F1 | Cores are groups of players, and the notation names group sizes | 6.18, 6.20 |
| F2 | Default starts described in the pattern-finder grammar | 6.20 |
| F3 | Two vocabularies: how it starts, and what it becomes | 6.20 |
| F4 | Directives addressed per situation | 6.1 |
| F5 | Contracts keyed by map position | 6.19 |
| F6 | Deception at any scale, not a formation head | 6.21 |
| F7 | Utility as a general tool with a competency ladder and a round economy | 6.22 |
| F8 | In-round knowledge is sight and sound, pooled; post-round is PRW and PFW | 5.1, 5.2, 18.6 |
| F9 | Dead players see what living teammates see | 5.8 |
| F10 | Mimicry down to individual players' habits | 10.3 |
| F11 | God mode with mid-round calls, time control, and savestate branching | 11.5 |
| F12 | Total separation from anything users see | 12.1 |

Three more corrections, in the same family as the previous ones:

1. **The plan was inventing a fake head.** Bodies are conserved, so a formation
   already constrains what deception is possible, and most real fakes are not
   formations at all: one player and two smokes on Inferno B while two walk out
   of apartments is a fake, and no lane count expresses it. Deception is now a
   cost over the enemy's inference, at any scale (6.21).
2. **The plan treated utility as executes.** Lineups were mined, budgeted, and
   thrown at sites. Flashing where the belief says someone is, mollying a rush
   that has not happened yet, and varying throw timings so they cannot be read
   are all more common and none of them were modelled (6.22).
3. **Dead players were going to be given eyes.** The question of what a dead bot
   contributes has an obvious answer that the plan was about to get wrong in one
   direction or the other: he watches his teammates, so he sees what they see.
   No new percepts, more thinking time (5.8).

### 0.4 Fifth pass: visualization

Everything up to here describes a bot that perceives, prices, and acts. It does
not describe the faculty that actually separates a tier-1 carry from a tier-2
weak link: **predicting where the enemy is, and is not, and making the small
movement decisions that counter what you predict.** That faculty has a name in
this project now, it is called visualization, and section 19 is its
architecture.

| # | Requirement (fifth brief) | Sections |
|---|---|---|
| V1 | Individual visualization: predict enemy movement, counter it with how you move and peek | 19.1, 19.3, 19.6 |
| V2 | Team visualization: how many enemies are in each zone, right now, from what we know and do not know | 19.2 |
| V3 | Know where the AWP is, and more importantly where it is not | 19.3 |
| V4 | The counterplay repertoire: ask for a flash, jiggle, shoulder peek, wide swing at velocity | 19.6 |
| V5 | Visualization costs time and attention: when to consider every possibility, when to commit to the most likely one, especially when entrying | 19.4, 19.5 |
| V6 | Enemy economy and round momentum shift what the enemy is likely to do | 19.7 |
| V7 | Lurks take their own timings; a successful lurk re-plans the round and re-routes the bomb | 19.8 |
| V8 | Refragging: when to run at a death you expect, and when to skip every angle but one | 19.9 |
| V9 | Learn executes from the round database, including how to run one when the utility it assumes is missing | 19.10 |
| V10 | Synchronization, and the mechanical texture of peeks | 19.11, 19.6 |

Five corrections, in the same family as every previous pass:

1. **The belief was five independent clouds.** 5.5 runs one particle filter per
   enemy slot. A product of marginals cannot represent a count, a split, or a
   correlation, and "how many are on each side" is most of what a team's read
   actually is. Replaced by a joint filter over layouts (19.2). The claim this
   makes, and it is a falsifiable one: **a tier-2 read is the product of the
   marginals, a tier-1 read is the joint.**
2. **Every interrupt was bad news.** The 10.2 taxonomy classifies deaths,
   blocked paths, and missed windows. Nothing in it notices that the round just
   got *better*, which is the entire payoff of a lurk and the reason a T side
   re-routes a bomb. Fixed by the `opportunity` class (19.8).
3. **Nobody could ask for anything.** Utility was budgeted top-down by role
   contract and thrown by whoever owned it. The most common sentence in
   competitive Counter-Strike, "flash me here", had no representation at all
   (19.6).
4. **Breadth was a compute cap rather than a decision.** Twelve hypotheses and
   top-three option pricing is a budget for the machine. How *wide* to think is
   a tactical choice with a clock price, and the difference between levels is
   mostly about when a player stops thinking and commits (19.4).
5. **Executes were tapes and lineups, so they could only be run, never
   repaired.** A retrieved A execute with one grenade missing had no
   representation except failure. Fixed by mining executes as effects and
   synchronization, with a four-tier repair ladder (19.10).

### 0.5 Sixth pass: the doctrine document

`Counter-Strike 101` (companion doc, written by artysan) is a complete
tactical doctrine for the game: zones and layers, utility purpose and balance,
five levels of communication, keywords and pace, threat levels, antieco, buy
vs buy on both sides, macro, tug of war and conditioning, system and roles,
risk management and 4v5, adaptation, clutch discipline, and a closing chapter
on understanding rather than memorizing. It is not background reading. It is
**the specification for what the Playstyle AI is supposed to be doing**, and
section 20 turns it into state, actions, masks, features, rewards, and grades.

| # | Requirement (sixth brief) | Sections |
|---|---|---|
| D1 | Bots operate on the doctrine's principles | 20, throughout |
| D2 | The hivemind calls rounds according to the document's round theory | 20.3, 20.5, 20.6, 20.9 |
| D3 | The knowledge becomes something a network can represent and master | 20.2, 20.3, 20.4 |
| D4 | Mastery accrues over generations and over rounds of experience | 20.15, and 18 unchanged |
| D5 | Individual brilliance is balanced against the system, and is the late-stage goal rather than the starting point | 20.14 |

Three corrections this pass forces, and the first is the largest single
honesty hole found in six passes:

1. **Negative information was free and telepathic.** 5.5's rule 3 deletes
   particles from cells the *team* can see, instantly, for everyone. That makes
   the single most valuable communication in the game (chapter 3's Level 2, "only
   one short") worth nothing, because the team already knew. Clearing an angle
   now deletes mass from the clearing bot's own view immediately and from the
   team blackboard only through a comm, at the comm delay, and only if the bot
   says it (20.7).
2. **The macro action space was a per-map enum.** The Playstyle AI picks a call
   from `roundLibrary.js`, which is 13 to 21 strings per map that mean nothing
   to a network on a map it has not seen. The doctrine's actual action space is
   map-independent: convert this layer, with this protocol, at this pace, paying
   this much utility. That representation transfers, and the library call becomes
   a *label* on top of it rather than the decision itself (20.3).
3. **Doctrine compliance and individual freedom were never separated.** The plan
   has role contracts (6.19) and it has traits (6.16), and it has no notion of a
   bot *earning* the right to deviate. Doctrine is now the mask and the prior in
   early generations, a price in the middle ones, and a graded expectation at the
   end, with deviation licences issued per bot per situation key out of the
   experience index (20.14).

### 0.6 Seventh pass: where the work runs, and how much data it may touch

Two operational decisions that the first six passes got wrong in the same
direction: they optimized for a simple rule rather than for the thing being
built.

| # | Requirement (seventh brief) | Sections |
|---|---|---|
| O1 | Evolution generations are startable and steerable from the /sim panel, not only from the PC | 9.2, 9.2b |
| O2 | Round simulations run from the panel too | 9.2b, 11 |
| O3 | Both pull from the dataset to tighten improvement and inform decisions | 9.2c |
| O4 | 2,500+ demos: reading all of it is not an option | 9.2c |
| O5 | Stacked maps work from per-height data that already exists | 4.2, 14.6 |

Three corrections:

1. **"Prod never trains" was the wrong rule.** It is simple and it makes the
   product worse: launching a generation should not require sitting at one
   machine. The rule is now "prod never starves", enforced by child processes,
   an opt-in worker cap, declared budgets, and parse jobs preempting sim jobs
   (9.2b). Gradient steps still only happen on a CUDA host, which was always the
   real constraint.
2. **The plan assumed the library could be read.** Nothing said so outright,
   and several features (flow priors, timing tables, baselines, BC extraction)
   quietly implied a full pass over thousands of demos. At 2,500 demos that is
   minutes of CPU on the box that is also parsing. 9.2c makes the rule explicit:
   the sim reads aggregates and individual rounds by id, never the corpus, and
   the working set stops growing with the library.
3. **Nuke was overstated as a hazard.** `lowerZ`, `isLowerLevel`, per-level
   painted positions, and a second radar all already exist. A body's floor is a
   property of its z, one comparison per tick; the bake produces a lattice per
   level; and where players actually change floors is mined from demo z
   transitions rather than painted by hand (4.2). The residual risk is
   calibration, not architecture (14.6).

---

## 1. What exists today and is load-bearing

The single most important architectural fact: **the sim engine will emit rounds in
the exact tick format and meta schema the demo parser writes**, so the entire
existing viewer stack (radar, clock, Team POV, possession paint, duel overlay, xK
badges, macro viewer) plays sim rounds with zero new rendering code. A sim round is
just a round nobody had to play.

### 1.1 Reuse inventory

| Asset | Path | What the sim uses it for |
|---|---|---|
| Spawn points | `server/replays/spawnPoints.js`, `GET /api/replays/spawns?map=` | Round start positions. Demo-sampled world coords `{id, side, x, y, z, seen}`, clustered at 30u. Same data the creator uses. |
| Map calibration | `src/replays/viewer/mapCalibration.js` | `worldToRadar`/`radarToWorld`, per-map posX/posY/scale, `RADAR_SIZE=1024`, `isLowerLevel` (Nuke `lowerZ: -495`). |
| Radar renderer | `src/replays/viewer/radarRenderer.js` | Draws sim frames unmodified. |
| Walkable mask | `src/replays/zones/zoneOverlay.js` (`maskFromRgba`, `getRadarLos`, `isWalkableWorld`) | Where a bot may stand. Radar PNG: alpha ≤ 28 = void, luminance ≥ 28 = floor. |
| Path lattice | `src/replays/zones/pathDistance.js` | 256×256 Dijkstra lattice. Basis for the nav graph and reachability inflation. |
| Wall segments | `src/replays/zones/mapSegments.js`, `ledges.js`, `visionLayers.js` | LOS occluders: base walls, painted vision blocks, elevated/underpass layers, one-way ledges. |
| Vision | `src/replays/duels/visionState.js` (`pairVision`, `VISION_HALF_FOV_DEG=53`, `VISION_MAX_DIST=4200`), `sightRay.js` (`losBlockedBetween`, `SMOKE_RADIUS_UNITS=144`) | The one true "can A see B". Bots and viewer share it, so what the page draws in POV mode and what a bot knew never disagree. |
| Team POV | `src/replays/viewer/teamPov.js` (`createPovVision`, `POV_MEMORY_SECONDS=0.75`, `povZonePaint`) | The template for the knowledge tracker (section 5). |
| Possession | `src/replays/coach/mapControlAdvantage.js` (`possessionSharesAt`), `zoneOverlay.js`, `mapControl.js` | Map-control features for both AIs, filtered to own side like `povZonePaint`. |
| Movement | `src/utils/SourceMovement.js` (`srcFriction`, `srcAccelerate`, `srcAirAccelerate`, `SourceMover1D`) | The integrator. 215/112/73 u/s run/walk/crouch, accel 5.5, friction 5.2, stopspeed 80. |
| Creator engine | `src/replays/creator/creatorEngine.js` | Proof the 2D body works: 128 Hz fixed step, collision disc r=16 vs `bakeLayerMask().testWorld`. Note: creator caps at 220 u/s; the sim uses per-weapon speeds (4.4). |
| Recording format | `src/replays/creator/recordingFormat.js` (`frameFor`) | Template for feeding the renderer from synthetic state; also the stratbook import path (10.1). |
| Tick format | `src/replays/shared/tickFormat.js` | Output format: 16 B/player/tick, fields x,y,z (i16/4), yaw,pitch (i16/100), health, armor, weapon idx, flags (alive, ducking, scoped, defusing, planting, hasBomb, airborne, helmet), flash (u8/20), side. `FLAG_PLANTING` exists but is unwritten today; the sim will write it. |
| Round meta schema | `server/demoparser/schema.js` | Sim rounds carry the same `events` (kills, shots, grenades with `path[]`, bomb, damage), players, econ digits, tick bounds. |
| Round clock | `src/replays/viewer/roundClock.js` (`timingFor`, ROUND 115 s, BOMB 40 s) | Phase display works if the sim writes honest `freezeEndTick`/`plantTick`/`endTick`. |
| Weapon table | `src/replays/shared/weaponTable.js` | price, category, magSize, reloadSeconds, cycleSeconds, oneTapHeadHelmet for every gun. Extended, not replaced (4.5). |
| xK / duel model | `src/replays/duels/duelModel.js` (`predictDuel`), `duelSnapshot.js` (`computeDuelSnapshot`, `duelContext`), `paramSpec.js` (~70 fitted params), `coach/duelMistakes.js` (`expectedKillsAt`) | Reward shaping (9.5) and the re-planning xK gate (10.2). |
| Round-win model | `src/replays/rounds/roundModel.js` (`predictRound`), `roundWinAdapter.js` (`predictRoundCalibrated`) | Potential-based reward shaping and the save/force logic prior. |
| Round library | `src/replays/analytics/roundLibrary.js` (defs per map), `roundFacts.js` (facts API), tags on `row.rl` | The command vocabulary (10.1) AND an executable validator: run a call, then check the library matcher tags the sim round with that call. |
| Default grammar | `src/replays/analytics/patternDefs.js` (`FORMATIONS` lanes per map, `formatFormation`, `AWP_MARK`, `PACE_TYPES`, `FAKE_DESCRIPTOR`, per-map snapshot clocks) | The second half of the call vocabulary: how a round is set up, as lane counts plus a pace type, plus the snapshot clock that anchors the situation key (6.20). |
| Antistrat aggregators | `src/replays/analytics/antistratScan.js` (`classifyPace`, `aggTells` with `TELL_MIN_ROUNDS`/`TELL_MIN_SHARE`, `aggCtSpread`, `aggResponses`, `pistolLean`) | The opponent model's structure and thresholds (6.10), the CT setup prior (9.7), and the self-scan that prices our own predictability (6.9, 6.21). |
| Cores | `src/replays/coach/cores.js` (`findCore`, `coreRadius`, `ALONE_DISTANCE`, `nearestTeammate`) | Live group structure for both teams: trade discipline, lurk as a decision, utility blast value, and shape drift (6.18). |
| Roles | `src/replays/roles/` (`computeRoles`, `mapRoleAssign.js`, `teamPositions.js`) | Role vocabulary per map/side. T: AWPer/Lurk/Pack, CT: AWPer/Anchor/Rotation, with map-specific labels (Inferno T: AWPer, A Lurk, Banana, Ramp, 2nd Mid; exactly the brief's example). |
| Coach rules | `src/replays/coach/` (~35 rule ids in 5 categories) | Negative reward terms and human-likeness evals (9.5, 9.8). |
| Aim metrics | `src/replays/shared/aimMetrics.js` | Calibration targets for the aim motor (8.3): time-to-damage, crosshair offset distributions from real demos. |
| Stats bags | `server/replays/statsIndex.js` (`row.mv` psdt/dt, `row.pos1/2`, `row.du`) | Movement and possession calibration baselines. |
| Model training pattern | `scripts/extract-duel-episodes.mjs`, `train-duel-model.mjs`, `src/replays/models/runtimeParams.js`, champions | The house pattern for extract → train → versioned weights → runtime override. The sim trainer follows it (9). |
| Identity | `server/replays/identity.js` (`whoami`), `site_admins` table, `server/admin/routes.js` 404 pattern | Access control for /sim (2). |
| WS servers | `server/lobby.js` (`MultiplayerServer`, `/ws`), `server/football.js` (`/football`), upgrade router in `server/index.js` | Template for the live sim stream (11.2). |
| Utility constants | `src/replays/viewer/utilityMarkers.js` (smoke 144u/22s, fire 120u/7s), `roundFacts.js` (`SMOKE_SECONDS=18`) | Note the 18 vs 22 s smoke inconsistency in-repo; the sim freezes one value (4.8) and the repo constant should be unified. |
| Demo grenade events | `schema.js` GrenadeEvent: `throwTick`, `detonateTick`, `from`, `at`, `path[]` | The lineup mining source (4.8): real travel times and real trajectories, no physics needed. |
| **The doctrine** | `Counter-Strike 101` (companion doc): zones and layers, utility doctrine, five comm levels, keywords and pace, threat levels, antieco, buy vs buy both sides, macro, tug of war and conditioning, system and roles, risk management and 4v5, adaptation, clutch, understanding over memorizing | The specification for the Playstyle AI (20). Supplies the map-independent macro state and action space (20.2, 20.3), the four ledgers as an observation block (20.4), the protocol library (20.5), the keyword presets (20.6), the comm schema (20.7), the risk rule and the 82% anchor (20.9), and one scorecard axis with one metric per chapter (20.15) |

### 1.2 What does NOT exist and must be built

- A cash economy simulator (only eco/force/full classification exists, `server/demoparser/economy.js`).
- Per-weapon damage, armor penetration, range falloff, tagging, per-weapon move speed, kill awards.
- Plant 3.2 s / defuse 5 s|10 s as timed actions; MR12 match state machine with halftime swap and OT.
- Grenade flight (creator uses a 300 u/s straight line; the sim mines real trajectories instead).
- Flash blindness, HE damage, molotov damage as combat rules.
- Any sound propagation model (nothing exists in the analysis stack).
- A humanized aim motor (trainer bots are RNG hit-chance, not a motor model).
- A nav graph with named positions as nodes (only the Dijkstra lattice exists).
- An angle catalogue: per-spot visible and exposure sets, cover distance, depth, rarity (6.8). The LOS raster can produce all of it; nothing bakes it today.
- A forward belief with negative information (5.5). `teamPov.js` holds a contact for 0.75 s and then forgets; it never reasons about where someone went.
- Any estimate of what the *enemy* knows about us (5.6), and no mined timing tables (first-arrival clocks per zone).
- Everything ML beyond the two small fitted models: policy networks, BC dataset extraction, self-play infra, league, evaluation harness.
- Any notion of a role as an obligation rather than a label (6.19). The roles module classifies what a player did; nothing anywhere states what a role owes.
- Any memory above the round (18). Nothing in the repo, and nothing in the first two passes of this plan, lets a team know in round 10 what happened in round 9.
- A situation vocabulary: the coarse, hashable description of a round state that memory is addressed by (18.2). The ingredients all exist (possession shares, cores, econ inference, round-library tags); the key does not.
- Absolute grading: the pro metric distributions per tier, the scorecard that places a candidate inside them, and the exam battery (9.17 to 9.19). Every metric exists; the population baselines and the comparison do not.
- A late-round tablebase (18.7), and the offline solver that would build one.
- A **joint** belief (19.2). 5.5's per-slot filters cannot answer "how many are
  on B", which is the question the whole T side is actually asking.
- A typed threat field (19.3): nothing anywhere estimates where a *weapon class*
  is, and the AWP read is the highest-value inference in the game.
- Any notion of how much thinking a decision is worth (19.4), or of a team
  splitting the angles it must cover across bodies (19.5).
- A way for one bot to ask another for anything (19.6), and therefore no
  representation of the most common call in competitive CS.
- An `opportunity` interrupt class (19.8). Every interrupt in 10.2 is a failure.
- Executes represented as effects and synchronization rather than as lineups and
  tracks, and any ability to repair one when a precondition fails (19.10).
- The live zone classifier (20.2): safe, risk, buffer, unknown, computed per side
  from the belief and the nav graph. This is the doctrine's core structure and
  nothing in the repo or in the first five passes computes it.
- A map-independent macro action space (20.3). Today the Playstyle AI picks a
  string from a per-map vocabulary, which does not transfer across maps.
- The four ledgers (20.4), the protocol library (20.5), the keyword presets
  (20.6), the five-level comm schema with negative confirmation and ASPs (20.7),
  zone ownership and the overcall protocol (20.8), and the deviation licence that
  lets a bot earn its way out of doctrine (20.14).

---

## 2. Phase 0: the hidden /sim page and access control

### 2.1 Access rule

Only @artysan. **No new env var, no new UUID list.** The site already knows who
he is: `whoami(req)` plus `isSiteAdmin(me.id)` against `site_admins`, the same
gate `/admin` uses (`server/admin/routes.js`, `server/entitlements/service.js`).
Usernames are renameable, so the check is the admin UUID table, not the string
`artysan`.

Guard logic in `server/sim/guard.js`:

1. `me = await whoami(req)`; not signed in → deny.
2. `me.impersonating` → deny (an admin viewing-as someone must not leak the page).
3. `!(await isSiteAdmin(me.id))` → deny.

Every denial answers **404, not 403**, copying admin: the endpoint's existence
is never confirmed to a prober. The client renders the same "Page not found"
view the router shows for unknown paths. The client may also check
`auth.displayName === 'artysan'` for cosmetics (`ingestReminder.js`) but that
is never the boundary.

### 2.2 Files to touch (exact)

| Step | File | Change |
|---|---|---|
| Route | `src/site/site.js` | Add to `ROUTES`: `sim: { title: 'Sim', path: '/sim', shell: 'sim' }` with the same comment style as `admin` (deep-link only, API answers 404). No `data-nav` link anywhere. |
| Controller | `src/site/site.js` | `viewControllers.sim = lazyController(async () => (await import('./simView.js')).initSimView(...))`. Lazy import means the sim UI ships as a separate hashed chunk fetched only on visit. |
| Shell | `index.html` | Add `<section class="view" data-view="sim">` with the same spinner placeholder as the admin section (`.view-pad.view-pad-fill`). |
| View | `src/site/simView.js` (new) | Renders nothing until `GET /api/sim/me` returns 200 (adminView pattern, `src/site/admin/adminView.js` lines 1 to 8). On 404, show the error view content. |
| SPA rewrite | `vercel.json` | Add `{ "source": "/sim", "destination": "/index.html" }` ABOVE the catch-all, which currently sends unknown paths to `/train.html`. Without this, `/sim` opens the aim trainer. |
| Node host | `server/static.js` | Add `'/sim'` to `SITE_VIEW_PATHS`. |
| API | `server/sim/routes.js` (new) | `handleSimRequest(req, res, url)` for `/api/sim/*`, own CORS like admin. First endpoint: `GET /api/sim/me` → `{ ok: true }` or 404. |
| Dispatch | `server/index.js` | `if (url.pathname.startsWith('/api/sim') && (await handleSimRequest(req, res, url))) return;` placed with the other namespace handlers, before the generic JSON body reader and generic OPTIONS reply (same reasoning as `/api/admin`). |
| WS | `server/index.js` upgrade router | Later phase: `/ws/sim` branch, bearer passed as query param or first message, guard checked before any state is sent, close code 4404 on denial. |
| Tests | `server/sim/guard.test.js` (new), appended to the `test` script in `package.json` | Site admin allowed, impersonation denied, anonymous denied, non-admin signed-in denied, all denials are 404-shaped. |

### 2.3 Secrecy checklist

- No sidebar link, no home tile, no sitemap entry, no README mention until release.
- The only strings in the public bundle: the route entry and one fetch to `/api/sim/me`. The heavy UI chunk loads only after a 200.
- Sim matches are stored outside the shared demo library (12.2), so they never appear in Demo Manager, Database, or share links.
- No `/s2/`-style public share for sim content, period, until release.
- Server logs must not print sim match payloads at info level (they encode strategy ideas).
- Model weights live under `AIM4_REPLAY_DIR/sim/`, never in the repo, never in `dist/`.

---

## 3. Architecture overview

Three layers with hard boundaries. The boundaries are the product.

```
+---------------------------------------------------------------+
|  MEMORY (data, not weights: 18)                                |
|  Experience index: every situation this team has been in,      |
|  keyed, counted, scored. Survives the round, the match, and    |
|  the generation. Read by the Strategy AI, never by the engine  |
+---------------------------------------------------------------+
|  BRAINS (learned, evolving)                                    |
|  Strategy AI   (one per team, between rounds, reads memory)    |
|  Playstyle AI  (one per team, ~1 Hz + event-driven)            |
|  Individual AI (one per bot, shared weights, 8 Hz)             |
|  In:  observations built ONLY from the knowledge tracker       |
|  Out: intents and OPTIONS (JSON-schema'd, engine-agnostic)     |
+---------------------------------------------------------------+
|  PRICING (fixed models, not learned: 6.7)                      |
|  foresight: option -> predicted poses -> predictDuel over      |
|  belief hypotheses -> duelLookahead -> dPRW, plus costs        |
|  Feeds the brains as features; arbitrates when budget allows   |
+---------------------------------------------------------------+
|  TRANSLATOR (fixed constants, never learned)                   |
|  intents and option micro-controllers -> per-tick inputs:      |
|  wishdir/walk/duck/jump, aim motor targets, fire/reload,       |
|  throw lineup, plant/defuse                                    |
|  2D build: writes inputs into the sim engine                   |
|  3D build: writes bot commands to a CS2 server plugin          |
+---------------------------------------------------------------+
|  WORLD                                                         |
|  2D build: shared/sim engine (deterministic, 64 Hz)            |
|  3D build: an actual CS2 server                                |
|  Both feed the same knowledge tracker shape upward             |
+---------------------------------------------------------------+
```

Rules that make the port real, enforced from day one:

1. Brains never read engine state directly. They read the knowledge tracker only.
   The training critic may read omniscient state (standard centralized training,
   decentralized execution), but the acting policies never do.
2. Intents are declarative ("advance to node `banana_car`", "throw lineup
   `inf_smoke_coffins_from_car`"), never continuous motor values, never raw angles.
3. The translator owns every game-mechanic constant. If the ML wants to move
   forward, it emits the decision; the translator "presses W" using CS2 movement
   rules in the facing direction, exactly as the brief describes.
4. Memory is read-only for the duration of a round and commits between rounds
   (18.10). A layer that writes to the experience index inside the tick loop
   breaks determinism, and determinism is a gate (9.8).

### 3.1 Proposed file layout

```
shared/sim/                    # pure rules, DOM-free, imported by browser, server, trainer
  constants.js                 # every frozen number: timers, economy, sound, per-weapon sim stats
  weapons.js                   # damage/apen/falloff/tagging/speed, extends weaponTable
  economy.js                   # the cash machine
  movement2d.js                # 2D SourceMovement at 64 Hz + collision slide (circle r=16)
  navGraph.js                  # lattice -> nodes/edges, named positions as anchors
  sound.js                     # emission + audibility + percept records
  grenades.js                  # lineup-mined trajectories + effects (smoke/flash/HE/molly)
  aimMotor.js                  # the humanized pro-capped aim model (section 8)
  knowledge.js                 # per-team belief tracker (Team POV semantics, section 5)
  intents.js                   # DecisionInterface schema, validity masks, versioned
  options.js                   # option set: initiation, micro, termination (6.6)
  desire.js                    # option arbiter: scored desires + motives, Dota style (6.17)
  angles.js                    # baked (spot, yaw) catalogue + spot encounters (6.8)
  shape.js                     # team formation frame, role + focus, backfill (6.13)
  spaceField.js                # control / value / danger / opportunity field (6.14)
  triggers.js                  # anticipation trigger table with lead times (6.15)
  foresight.js                 # price an option in dPRW via predictDuel + duelLookahead (6.7)
  exposure.js                  # what the enemy plausibly knows about me (5.6)
  opponentModel.js             # tendency tracker + EXP3 over calls (6.10)
  cores.js                     # core / lurker read of both teams, live (6.18)
  formation.js                 # lanes, notation, pace classification, snapshot read (6.20)
  deception.js                 # price an action by the false belief it buys (6.21)
  roleContract.js              # what each position owes: zones, budget, window (6.19)
  situation.js                 # situation key + embedding, the memory address (18.2)
  experience.js                # the experience index: retrieval, counts, bounds (18.3)
  review.js                    # post-round self-review, regret log, mistake ledger (18.6)
  tablebase.js                 # enumerated late-round states, exact where possible (18.7)
  translator.js                # intents and options -> per-tick inputs
  spawnAssign.js               # legal spawn permutations, mimic matching, freeze pick
  trackFollow.js               # follow a recorded tick path with CS movement (no teleport)
  interrupts.js                # local vs team interrupt classifier (10.2, 10.4)
  skill.js                     # trait vector, presets, per-bot overrides (6.16, 8.4)
  engine.js                    # round + match state machine, seeded, deterministic
  encode.js                    # engine history -> tickFormat buffer + round meta
  policy/mlp.js                # dependency-free forward pass (MLP + optional GRU)
server/sim/
  guard.js  routes.js          # access + REST
  live.js                      # WS live match server (football.js pattern)
  store.js                     # matches/models/datasets under AIM4_REPLAY_DIR/sim/
  models.js                    # model manifests, generation registry (champions pattern)
  rollout.js                   # headless self-play worker entry
src/site/simView.js            # the page shell (lazy)
src/sim/                       # client UI: setup panel, live viewer glue, inspectors
scripts/
  sim-mine-lineups.mjs         # grenade lineup tables from library demos
  sim-mine-timings.mjs         # per-zone first-arrival distributions, flow priors (5.6)
  sim-extract-bc.mjs           # BC dataset (obs via knowledge tracker replay, labels)
  sim-eval.mjs                 # eval suites, Elo ladder, human-likeness + surprise gates
  sim-scorecard.mjs            # pro percentile scorecard + tier verdict (9.17, 9.18)
  sim-exams.mjs                # the certification scenarios, pass bands from demos (9.19)
  sim-baselines.mjs            # mine the pro metric distributions the scorecard grades against
  sim-tablebase.mjs            # solve late-round states offline (18.7)
tools/simtrainer/              # Python trainer (PyTorch): BC + PPO, exports weights JSON
```

`shared/sim` follows the `src/replays/shared` convention: no DOM, importable by the
browser page, the Node server, and the extraction scripts alike.

---

## 4. The simulation engine

### 4.1 Determinism and tick model

- Fixed 64 Hz tick, integer tick counter, no wall clock anywhere inside the engine.
- One seeded PRNG (xoshiro128** or mulberry32) owned by the engine; every stochastic
  draw (aim error, reaction jitter, hit location) pulls from it. Same seed + same
  intent stream = bit-identical round. This is non-negotiable: it makes bugs
  reproducible, evals fair, and A/B model comparisons clean.
- The engine exposes `stateHash()` (FNV over quantized state) so tests can assert
  two runs diverge nowhere.
- Real-time play is the engine stepped by a pacer; training runs it as fast as the
  CPU allows. Identical code path, no train/serve skew.
- Performance budget: ≥ 50,000 engine ticks/sec/core with 10 bots (≈ 13 minutes of
  game time per wall-clock second, ≈ 780x realtime). A 2-minute round ≈ 7,680 ticks;
  target ≥ 6 rounds/sec/core before inference cost.

### 4.2 World representation per map

Seven maps are calibrated and painted today: ANC, DD2, INF, CCH, MIR, NUK, ANU.
Bots train on **every map that has baked nav and library demos**. There is no
Inferno-only curriculum. Engine work still lands map-by-map as collision paint
is reviewed (you cannot ship a map whose walkable mask is a lie), and Nuke's
two floors stay the hardest bake, but a generation is not admitted until it
has been trained and eval'd across the ready set, not one poster map.

Per map, built once at load and cached:

1. **Walkable mask**: the radar-PNG mask from `zoneOverlay.maskFromRgba`, minus
   painted vision blocks that are physical walls. Caveat: vision blockers are not
   always physical (a smoke paint is not a wall) and the radar mask has holes
   (stairs shading). Mitigation: a one-time per-map review pass in the existing
   zone editor, adding a painted `simCollision` layer where the radar lies; the
   engine unions radar mask + vision blocks + simCollision. Budget one focused hour
   per map.
2. **Nav graph**: derive from the 256×256 `pathDistance.js` lattice: walkable cells
   → nodes at ~64 u spacing, 8-connected edges weighted by distance; snap the
   painted **positions** (`zoneModel.js`) onto their nearest nodes as *named
   anchors*. Named anchors are the vocabulary bots use for movement intents, which
   keeps decisions map-portable and human-readable ("go banana car", not "go
   (-410, 1830)").
3. **LOS**: exactly the existing `losBlockedBetween` against `mapSegments` +
   ledges + elevated/underpass layers. Zero new geometry.
4. **Sites and key zones**: bombsite polygons from the Sites editor
   (`zoneModel.js`), plant spots = site polygon interior nodes.
5. **Z handling, and stacked maps.** `z` is carried per bot (spawns have real
   z; nodes inherit sampled z from demo tracks where available, else 0).
   Stacked maps are not a special case and do not need painted cross-floor
   edges: the calibration already carries the split (`NUK: lowerZ -495`, which
   is CS2's own default-radar AltitudeMin and lower-radar AltitudeMax), the
   painted positions already carry `level`, and `isLowerLevel(map, z)` already
   resolves a body to a floor. So the bake produces **one lattice per level**
   from the two radars (`de_nuke.png`, `de_nuke_lower.png`), a body's active
   lattice follows from its z every tick, and the cells walkable on both levels
   are the places a floor change can happen. Which of those cells players
   actually use, in which direction, and how long the traversal takes is a fact
   the library answers directly: every round carries z per tick, so the x/y
   cells where z crosses `lowerZ` are the real ramps, stairs, and vents. Mine
   them; do not paint them.
6. **Doors** (Inferno banana door, Nuke hut): v1 has no door state; doorways are
   always-open walkable gaps, as the radar mask already shows them. Logged as a
   fidelity gap (14).
7. **The bake steals Valve's analysis pass wholesale.** CS's own nav mesh is the
   best-documented FPS navigation data in existence and it is right there in
   `source-sdk-2013` (`nav_area.h`, `nav_pathfind.h`, Michael Booth, 2003). Its
   generation runs `SAMPLE_WALKABLE_SPACE`, `CREATE_AREAS_FROM_SAMPLES`,
   `FIND_HIDING_SPOTS`, `FIND_ENCOUNTER_SPOTS`, `FIND_SNIPER_SPOTS`,
   `FIND_EARLIEST_OCCUPY_TIMES`, `FIND_LIGHT_INTENSITY`,
   `COMPUTE_MESH_VISIBILITY`. Four of those we should run too, and they are
   detailed in 6.8: hiding spots with cover classification, spot encounters
   (the ordered danger list along a path segment), area-to-area visibility, and
   **earliest occupy time per team**, which is the entire timing game precomputed
   as one float per area per side. Nav areas also carry `m_danger[team]` with a
   decay rate, "allowing bots to avoid areas where they died in the past", and
   attribute flags (`CROUCH`, `JUMP`, `PRECISE`, `WALK`, `RUN`, `STOP`, `AVOID`,
   `DONT_HIDE`) that the zone editor should paint on our edges under the same
   names. The pathfinder is A* with a swappable cost functor and named route
   types (fastest, safest, retreat), which is exactly the shape 6.14 needs.

### 4.3 Player state

Per bot, the engine owns:

```
pos {x,y,z}  vel {x,y}  yaw  stance {stand|crouch}  gait {run|walk}
health 0..100  armor 0..100  helmet bool  flashSeconds
weapons { primary?, secondary?, knife, taser?, grenades[] (typed) }
activeSlot  magAmmo  reserveAmmo  reloadingUntilTick  nextFireTick
tagged (slow factor + expiry)  money  hasDefuser  hasBomb
channel { none | planting(sinceTick) | defusing(sinceTick) | throwing(lineup, sinceTick) }
alive  spawnedAtNode  role  playerRef (mimic identity, optional)
```

Everything maps 1:1 onto the tick format for encoding: ducking, scoped, defusing,
planting, hasBomb, airborne, helmet flags; flash seconds; weapon index into the
round's weapon dictionary.

### 4.4 Movement

- Integrator: the existing `srcFriction`/`srcAccelerate` in a 2D x/y port
  (`movement2d.js`), 64 Hz, constants unchanged: accel 5.5, friction 5.2,
  stopspeed 80. This is requirement D verbatim: same speeds, same velocity ramps
  as the trainer and as real demos.
- Per-weapon max speed table in `shared/sim/constants.js` (units/s) `[verify all]`:
  knife 250, pistols 240 (Deagle 230, R8 220), SMGs 220 to 240 (P90 230), shotguns
  210 to 225, AK/Galil 215, Famas/AUG 220, M4A4/M4A1-S 225, SG553 210, AWP 200
  (scoped 100), SSG08 230, autos 215, Negev/M249 150/195. Walk = 52% of weapon
  speed (repo's 112/215 already matches), crouch = 34% (repo's 73/215 matches).
- Collision: circle radius 16 vs the union mask (the creator's exact disc), with
  wall-slide (project velocity onto the wall tangent) so bots hug corners rather
  than sticking.
- Counter-strafe: the translator uses the `SourceMover1D.seek` braking idea
  generalized to 2D: press the opposite wishdir when `|d| < |v| * 0.16` to stop
  crisply for a shot. Bots therefore stop like players, not like lerps.
- No jumping in v1 except scripted jump-throw lineups (grenade system handles the
  throw; the body plays a 0.75 s airborne flag for the viewer). Falls, boosts,
  ladders-as-slow-edges (speed 100) only where the nav graph has painted them.
- Tagging: taking a hit multiplies current speed by 0.5 `[verify exact curve]`,
  recovering over 0.5 s. Matters enormously for exit frags and running through
  crossfires, so it is in v1.

### 4.5 Weapons and damage

`shared/sim/weapons.js` extends `weaponTable.js` (which stays untouched: the duel
model depends on it) with the fields the sim needs:

```
damage        base body damage per bullet        (AK 36, M4A4 33, AWP 115, Deagle 53) [verify]
armorPen      0..1                               (AK .775, M4 .70, AWP .975)          [verify]
rangeMod      damage *= rangeMod^(dist/500u)     (AK .98, SMG ~.85, pistols .79-.91)  [verify]
headMult      4.0 standard; helmet interacts via armorPen and oneTapHeadHelmet
runSpeed      section 4.4
killAward     one of 100 / 300 / 600 / 900 (table in 4.9); knife 1500, Zeus 0 [verify]
tracerAudible for the sound system
```

Hit resolution per shot (all draws from the seeded PRNG):

1. The aim motor (8) produces an angular error sample for this trigger pull.
2. Ray from muzzle along yaw+error, `losBlockedBetween`-style against walls and
   smokes do not stop bullets (only vision); first enemy circle (r=16) hit within
   weapon range takes the hit. No wallbangs in v1 (14).
3. Hit location: categorical draw P(head/chest/stomach/legs) conditioned on
   distance, target stance, target speed, shooter weapon class, calibrated so
   rifle HS% lands at the pro ~45 to 50% (8.3).
4. Damage = base × headMult? × rangeMod^(dist/500) × armor formula; armor durability
   decrements; helmet strips on head hits `[verify formulas]`.
5. Kill → killAward for the **weapon that got the kill** credited to the
   shooter's money (cap 16000). The four buckets are $100 / $300 / $600 / $900
   (4.9). Team kills pay nothing and subtract $300. Kill/death/assist and
   damage events recorded in meta format.
- Fire cadence, reload, mag sizes come straight from `weaponTable.js`
  (`cycleSeconds`, `reloadSeconds`, `magSize`): the AWP's 1.46 s bolt is already
  the difference between a 95% duel and a coin flip, per that file's own comment.
- Spread/inaccuracy while moving: shots fired above ~34% of weapon speed take a
  large extra error (the trainer's `shotAccuracy.js` cone shape is the reference);
  crouching tightens error by ~0.85. Exact multipliers are aim-motor parameters
  (8.2), not weapon data, because they cap the *human*, not the gun.

### 4.6 Round and match state machine

```
match:  config -> halves(MR12) -> [OT MR3 @ $10,000]* -> result       [verify OT rules]
round:  freeze(15 s) -> live(115 s) -> [planted(40 s)] -> over -> payout -> next
```

- Freeze **15 s**. Configurable later if a FACEIT 12 s mode is wanted; it does
  not matter for training. The viewer's `FREEZE_SECONDS=3` is only its fallback
  for rounds without a real `freezeEndTick`; the sim writes honest tick bounds
  so the clock is right.
- Buy period: freeze + 20 s after live starts (`mp_buytime` 20) `[verify]`, buying
  only within X=1100 u geodesic of own spawn centroid (buy zone approximation).
- Plant: hold 3.2 s inside a site polygon holding the bomb; sets `plantTick`,
  writes `FLAG_PLANTING` during the channel, bomb entity at plant spot. C4 40 s.
- Defuse: 10 s bare, 5 s with kit, channel broken by damage or movement; kit
  ownership on the CT state.
- Win conditions, in the order the engine actually checks them each tick:
  1. All of one side dead → **elimination**, round ends **immediately**. If the
     bomb was planted, it does **not** explode. This is the "killed the rest
     before the bomb went off" case, and it pays the elimination win, not the
     detonation win (4.9).
  2. Bomb timer hits 0 with at least one T having planted → **detonation**. This
     is the "bomb exploded before the rest of the CTs died" case (or CTs were
     still alive). Pays the detonation win.
  3. Defuse channel completes → **defuse**.
  4. Live clock hits 0 with no plant → **time**, CT win.
- Halftime swaps sides, resets money to start money, resets loss streaks
  `[verify halftime streak reset]`. First to 13; 12-12 → **OT on by default:
  MR3, $10,000 start**.
- Round end grace ~5 s where survivors can still act (save runs are real), then
  payout, then next round. Spawns are **chosen by the bots** from the available
  pool, not rolled by the engine (4.12).

### 4.7 Sound

Nothing exists in the analysis stack, so this is new, and it is a first-class
citizen because the brief demands it: stepping and shooting create sound enemies
hear, and silent walking is the counter-play.

Emission events, each `{tick, type, pos, loudness}`:

| Event | Emitted when | Audible radius (u) `[tune]` |
|---|---|---|
| footstep | gait=run and speed > 0.34 × weaponSpeed, every 140 u of travel | 1100 |
| landing | airborne → ground | 1400 |
| gunshot | every trigger pull | 4000 (silenced: 1400) |
| reload | reload start | 500 |
| nade bounce/throw | lineup waypoints | 800 |
| plant / defuse start | channel start | 1200 |
| bomb beeps | planted, accelerating | site-wide, global after 30 s |
| defuse kit loop | defusing | 1200 |

- Walking (shift) and crouching emit nothing. That is the whole tactical point.
- Audibility: receiver hears the event if geodesic path distance (via the nav
  lattice, not euclidean, so sound does not cross solid walls unrealistically) ≤
  radius. The bot who is in range gets the percept **immediately**. Relaying it
  to teammates is a comm, delayed 0.5 to 1.5 s (5.1). CS radar does not share
  footsteps.
- The percept is noisy: direction quantized to 8 sectors, distance to 3 bands
  (close/mid/far), and mapped to the nearest named zone ("steps banana, close").
  Bots learn on the same degraded signal a human gets.
- Every emission is also written into round meta as a debug event stream so the
  UI can visualize rings (11.3).

### 4.8 Utility

The masterstroke available to this codebase: **do not simulate grenade physics,
replay mined trajectories**. Every parsed demo grenade already carries
`throwTick`, `detonateTick`, `from`, `at`, and the full `path[]`.

- `scripts/sim-mine-lineups.mjs` walks the library per map and clusters grenades
  by (type, from-cell 64 u, at-cell 64 u): each cluster becomes a lineup
  `{id, type, from, at, medianTravelTicks, representativePath, thrownCount,
  jumpThrow?}` stored in `AIM4_REPLAY_DIR/sim/lineups/<MAP>.json`. Name it by the
  admin utility spot DB when a detonation matches within 250 u (the same rule the
  analytics use), else by landing zone.
- Runtime throw: translator walks the bot to `from` (±24 u), faces the bearing,
  channels 0.5 s, then the projectile follows `representativePath` with the
  recorded travel time. **Utility travel time is therefore replicated from real
  demos by construction** (requirement 6).
- Ad-hoc reactive throws (molly at feet, pop flash around own corner): straight
  line at 300 u/s (the creator's constant) with a 1.6 s fuse, max 900 u. Marked
  lower-fidelity; fine for reactive utility, never used for set executes.
- Effects:
  - Smoke: r=144 u (`SMOKE_RADIUS_UNITS`), duration **20 s** (freeze one value;
    repo currently disagrees with itself 18 vs 22: unify and note in both files).
    Blocks vision via the existing `blockingSmokesAt` semantics; HE clears bloom
    momentarily (visual only in v1).
  - Molotov/incendiary: r=120 u, 7 s, 40 hp/s standing inside `[verify]`,
    ignition delay 0.3 s; extinguished by smoke overlap.
  - HE: max 98 dmg at center, linear falloff to 0 at 350 u, armor-reduced
    `[verify]`, LOS-checked (walls shield).
  - Flash: for each bot with `losBlockedBetween(bot, detonation)` clear and dist
    < 2000: blind = f(angle between facing and flash bearing, distance): facing
    within 53° → up to 4.9 s, 53 to 90° → up to 2 s, behind → 0.3 s, scaled by
    distance `[verify curve]`. Writes the tick-format flash field, so the viewer
    shows the white halo it already knows how to draw. Blind bots' vision tests
    fail while flashSeconds > threshold, and the aim motor degrades on partials.
- Inventory rules: max 4 grenades, ≤ 2 flashes, ≤ 1 of each other type `[verify]`,
  prices: HE 300, flash 200, smoke 300, molotov 400, incendiary 500, decoy 50
  `[verify]`; decoys are out of v1 (they exist to lie to a knowledge model, which
  is a beautiful v2 feature and a rabbit hole today).

### 4.9 Economy

Full cash machine in `shared/sim/economy.js`, pure and unit-tested, because reward
signals flow through it and a wrong economy poisons training invisibly.

**Kill awards** are per elimination, paid to the killer, keyed on the weapon that
got the kill. Four buckets, plus knife / Zeus as extras `[verify all]`:

| Award | Weapons |
|---|---|
| **$100** | AWP, CZ-75 |
| **$300** | Rifles (AK, M4s, Galil, Famas, AUG, SG), most pistols (Glock, USP, P250, Deagle, Five-SeveN, Tec-9, Dualies, R8, P2000), P90, autosnipers, LMGs, HE |
| **$600** | SMGs except P90: MAC-10, MP9, MP7, MP5-SD, UMP-45, PP-Bizon |
| **$900** | Shotguns: Nova, XM1014, MAG-7, Sawed-Off |
| $1500 | Knife |
| $0 | Zeus |

Team kill: no award, −$300. Assist does not pay. The award is cash in the
killer's pocket this round, capped with everything else at $16,000 at payout.

**Round win cash depends on how the round ended, and plant vs elim order is the
whole point.** The engine's win-condition order in 4.6 is what makes this true
rather than a special case:

| How the round ended | Team win | Notes |
|---|---|---|
| T eliminate all CTs, bomb never planted | $3,250 | plus kill awards already paid |
| T eliminate all CTs **after a plant, before the 40 s timer** | $3,250 | bomb does not explode; planter still has the +$300 plant bonus; kill awards for the closing elims still pay. Hunting the last CT is therefore $3,250 + killAward vs waiting for the boom. |
| Bomb **explodes** (timer hits 0; at least one CT was still alive, or they died on the same tick as the boom after the explode check) | $3,500 | no extra kill awards for players the explosion "finishes"; explosion is not a player kill |
| CT eliminate all T, no plant | $3,250 | |
| CT defuse | $3,500 | defuser +$300 |
| Time expiry, no plant | $3,250 CT | living T get **$0** that round (not even loss bonus) `[verify]` |
| T loss after a plant (they all died, or it was defused) | loss ladder + **$800 each T** | the plant consolation; stacks with the planter's +$300 |

| Other | Value `[verify all]` |
|---|---|
| Start money | $800 (competitive), OT $10,000 |
| Cap | $16,000 |
| Loss bonus ladder | $1,400 / 1,900 / 2,400 / 2,900 / 3,400; a win decrements the streak counter by 1 (CS2 rule), not reset |
| Planter bonus | +$300 to the planter, win or loss, on top of the table above |
| Gear | kevlar 650, +helmet 350, kit 400, taser 200 |

Why the explode-vs-elim split matters for the bots, not just the ledger: after a
plant in a man-up, waiting for the bomb is +$250 team cash and zero risk; hunting
the last CT with an SMG is +$600 to the hunter (−$250 team, net +$350 to that
pocket) and can throw the round if the hunt dies and a defuse lands. The Playstyle
AI's afterplant `hold` vs `hunt` is a real money decision. Golden tests must cover
both orderings with the same plant, same 1 CT alive, differing only in whether
that CT dies at t=39 s or the bomb pops at t=40 s.

The buy decision itself is a *learned* decision (7.4): the economy module only
prices and enforces legality (money, buy period, buy zone, inventory limits).

### 4.10 Engine constraint parity checklist (requirement 6)

| Constraint | How replicated |
|---|---|
| Economy | 4.9, full cash sim |
| Movement speed / velocity | 4.4, the literal Source integrator + per-weapon caps |
| Halftime switching, scores | 4.6, MR12 machine |
| Buy time | 4.6, freeze + 20 s + buy zone |
| Utility travel time | 4.8, mined real trajectories with recorded travel ticks |
| Step/shot sound | 4.7 |
| Timers, plant/defuse | 4.6 |
| Spawns | spawn API pool; bots **choose** among them (4.12) |

### 4.11 Engine output

`shared/sim/encode.js` converts the engine history into:

- a tick buffer via `tickFormat.js` (64 Hz, stride 1, real tickRate header),
- a round meta object matching `server/demoparser/schema.js`: players (bot
  identities), weapons dictionary, kills/shots/damage/grenades/bomb events, econ
  digits computed by the *existing* `economy.js` classifier (so filters read sim
  rounds identically), honest tick bounds.

Acceptance test: load an encoded sim round through `TickTrack` and `timingFor`,
render one frame through `frameFor`-equivalent viewer plumbing, and run the Team
POV `createPovVision().seenAt` on it. All green means the whole site understands
sim output forever after.

### 4.12 Spawn choice (bots pick, the engine does not roll)

In a real match the server assigns spawns. In this sim the bots **freely choose**
which of the available spawn points they take, every round. That is deliberate.

The pool is the same demo-sampled list the 2D creator uses
(`GET /api/replays/spawns?map=`, `{id, side, x, y, z, seen}`). Per side, typically
5 to 12 distinct points after the 30 u cluster. Rules:

- Five living bots, five chosen spawns. A spawn is used by at most one bot.
- The chooser is the Playstyle AI at freeze start (a permutation head, 7.4).
  Individuals do not argue over spawns.
- "Available" means the pool for that side on that map, not a random subset of 5.
  If the pool has 8 T spawns, the team picks any 5. If it has exactly 5, the
  decision is only who stands where.
- Collision: `MIN_SEPARATION` 30 already merged near-duplicates in the pool, so
  two bots cannot pick "the same" spawn by construction.

Why this exists, in order of importance:

1. **Mimicry (10.3).** A recorded Spirit round started from specific freeze
   positions. To copy their movement, our five bots have to start on the five
   pool points closest to those positions. If spawns were random, the first 4
   seconds of every mimic round would be a pathing scramble and the copy would
   be a lie.
2. **Call quality.** "CT AWP peeks banana at 1:45 given a good spawn" is only
   learnable if the policy can *take* that spawn. Spawn-to-call coupling is a
   Playstyle input and a Playstyle action.
3. **Practice.** A real team loading these bots later will want "put your AWP
   on the banana spawn this round." The 2D page should already expose that.

What this is **not**: a claim that official matchmaking lets players pick
spawns. On a practice CS2 server after the 3D port, the plugin will
**`setpos` each bot during freeze** onto the spawn the Playstyle AI (or the
pin UI) chose, from the same pool, one bot per point. That keeps mimicry and
"AWP on banana" intact in 3D. Mid-round `setpos` is forbidden; freeze only.
The DecisionInterface does not change: 2D writes the pose into the engine,
3D calls `setpos` (4.12, 13.3).

Implementation: `shared/sim/spawnAssign.js`.

- `legalPermutations(pool, n=5)` → compact list, or Hungarian matching when
  scoring against target positions (mimic).
- `matchToTracks(pool, freezePositions[5])` → assignment minimizing sum of
  world distances, used when a mimic template is loaded.
- Freeze: bots are placed on the chosen points at `startTick`, standing, money
  already applied, buy legal. The viewer sees them there the way a demo does.

IF the pool is smaller than 5 (broken bake, empty library): fail the round
setup with a visible error, do not duplicate spawns. IF two mimic targets
collapse onto one clustered spawn: the extra bot takes the next-nearest unused
point and the follow error at t=0 is an accepted bias, logged on the match.

---

## 5. Perception and knowledge: what bots know

The brief's rule: the match must use the Team POV and possession features to
determine LIVE what bots know and do not know. Implementation: the knowledge
tracker `shared/sim/knowledge.js` is a lift of the Team POV semantics, run
*forward* inside the engine instead of over a recorded demo.

### 5.1 Percepts (inputs to knowledge, per team)

| Percept | Rule (mirrors existing code) |
|---|---|
| Vision contact | `pairVision`: 53° half-FOV, ≤ 4200 u, `losBlockedBetween` (walls, one-way ledges, elevated/underpass), smokes block, flashed eyes fail. Identical function the viewer uses. |
| Contact hold | 0.75 s memory (`POV_MEMORY_SECONDS`) during which the enemy stays "seen" at live position, then transitions to a *last-known* record (see below: the sim needs real LKP even though the viewer only holds). |
| Sound | 4.7 percepts: type, sector, range band, zone guess. |
| Kill feed | Global and exact, both teams: alive counts are common knowledge (CS shows the feed). Killer identity known; killer *position* only if the death was seen or the victim's team heard the shot. |
| Damage taken | Victim's team learns direction sector + weapon class instantly. |
| Bomb | T side always knows carrier/drop location (CS radar rule); CT learn plant site from the plant sound instantly (it is map-wide information in practice) and bomb position only when seen. |
| Teammate state | Radar-like facts are instant: living teammates' positions, spotted enemies (vision contact by anyone on the side), bomb on T radar. Calls are not. Sound percepts heard by one bot, and Playstyle orders reaching a bot who did not see the event, land after a comm delay drawn uniformly from 0.5 to 1.5 s per message (seeded). That is v1, not a later knob. |
| Economy | Own team exact. Enemy team: inferred (5.3). |

### 5.2 Belief state (per team blackboard + per bot)

Per enemy slot:

```
lastKnown {x,y,tick} | null      confidence decaying with age
seenNow bool                     weaponSeen (class), helmetSeen?, hpSeen? = never (POV rule: droplets carry no HP/name)
reachableSet                     geodesic ball from lastKnown grown at run speed via the path lattice
                                 ("they could be anywhere from banana to CT by now")
```

Team level:

```
controlShares {t, ct, neu}       possessionSharesAt logic filtered to own side (povZonePaint semantics:
                                 enemy-held ground is NOT knowledge, it renders as silence)
heardEvents ring buffer          soundPercepts (last ~6 s)
plan state                       current call, per-bot orders, phase (6)
```

Per bot (individual layer): own facing, own screen contents (which known enemies
are inside my 53° cone), flash state, ammo, channel state.

The reachability inflation is the single most valuable engineered feature: it is
what lets a policy represent "nobody has seen mid for 25 s, so a lurker may
already be behind us" without recurrent memory doing all the work.

### 5.3 Enemy economy inference

Bots must not read the enemy wallet. The belief carries a per-enemy-team economy
estimate updated from observables: previous round result and streak (public),
weapons seen on contacts, drops seen, kill feed weapon icons. Implemented as a tiny
fixed Bayesian tracker over the 6 econ classes (the digits the site already uses),
not learned. Deliberately fixed: it is a rulebook fact, not a playstyle.

### 5.4 Honesty guarantee

A test (`knowledge.test.js`) replays recorded engine rounds and asserts the
knowledge tracker's `seenAt` output equals `teamPov.createPovVision().seenAt` run
over the encoded tick buffer, tick for tick. The page's POV toggle then *provably*
shows exactly what the bots were given. When artysan watches in Team POV mode, he
is watching the actual model input.

### 5.5 The belief is a particle filter, not a ball

The reachability ball in 5.2 is a good picture and a bad data structure. It can
say "they could be anywhere from banana to CT", which is the *question*, and it
cannot answer three things a CS player answers constantly:

- **Negative information.** I have been staring down banana for four seconds. The
  ball still contains banana. A human has already deleted it.
- **Sampling.** "How likely is it that peeking this angle meets someone" needs a
  distribution to draw from, not a set.
- **Priors.** An unseen CT is not uniformly distributed over reachable ground. He
  is standing where CTs stand on this map at this clock, which the library knows.

So `shared/sim/knowledge.js` carries, per team, one particle filter per enemy slot.

```
particle { node, gait, weight, bornTick }
N = 64 per enemy slot, 5 slots, 2 teams = 640 particles per round
update rate 8 Hz, all draws from the engine PRNG (determinism, 4.1)
```

Update rules, in the order they run each step:

1. **Propagate.** Each particle walks the nav graph for 125 ms at a speed drawn
   from a run/walk mix, biased along a per-map **flow prior**: where players of
   that side/role actually move at this clock, mined from the library the same way
   the presence radar and heat images are built (`analytics/presenceRadar.js`,
   `heatImage.js`). An unseen enemy drifts toward where that enemy usually is, not
   into a spherical cloud.
2. **Positive contact.** Anyone on my side sees them: collapse all particles onto
   the observed node, weight 1, `bornTick = now`. This is the existing
   `POV_MEMORY_SECONDS` hold, expressed as a filter that has just been reset.
3. **Negative information.** Kill every particle that sits inside the union of my
   side's currently visible cells (the same `pairVision` + `losBlockedBetween`
   test, evaluated cell-wise off the LOS raster). Clearing an angle deletes it from
   the belief. This one rule is most of what makes bots look like they are playing
   the same game as a human.
4. **Sound.** Reweight by percept likelihood (4.7): a footstep is a soft wide
   reweight over the sector and range band, a gunshot is hard and narrow, a plant
   is a delta on the site. Percepts are the degraded ones from 4.7, never the
   emitter's true position.
5. **Kill feed.** A dead slot's filter is discarded. A kill *by* slot k that we
   witnessed relocates k; a kill by k we only heard reweights k toward the
   victim's last-known position.
6. **Resample** when effective sample size drops below N/2, then renormalize.

What the policy actually reads is never the raw cloud (7.2): it reads the derived
summary. Per enemy: the top three zone modes and their mass, belief entropy in
bits, expected time to contact along each candidate route, and mass inside the
exposure set of each angle I am considering (6.8). Per team: total belief entropy,
which is the "we have lost the round's information" scalar that the Playstyle AI
needs and currently has no way to express.

Cost is trivial (640 particles at 8 Hz is nothing next to the physics), and the
filter is per *team*, not per bot: a bot's personal belief is a view of the team
blackboard, degraded by attention (5.7), which is both cheaper and more correct
than five independent filters that would each have to re-derive teammate vision.

Honesty test extends 5.4: feed the filter the percept stream recorded from a real
demo and the percept stream generated by the engine on the encoded version of the
same round; the summaries must match. The filter may only ever touch percepts.

### 5.6 Exposure: what they know about me

Unawareness is already a fitted, shipped quantity in this codebase. The duel model
has `infoW` and `infoTau`, driven by `visionState.infoAdvantageSeconds`: seconds of
head start one player has on the other in the current engagement, capped at 4, with
one-sided awareness taking the cap. Holding an angle on somebody who does not know
you exist is the largest non-crosshair term in the model. The sim should therefore
treat unawareness as a resource that bots **spend**, not as a side effect.

The catch: `infoAdvantageSeconds` is computed from both players' god-view geometry.
A bot may not read it. It has to *estimate* it from its own side, which is exactly
what a human does ("they have not seen me: I have not fired, I walked, and nobody
had an angle on me since I left spawn").

`shared/sim/exposure.js`, per bot, maintains a self-footprint:

| Evidence I emitted | Effect on P(they know about me) |
|---|---|
| Fired an unsilenced shot | Hard. Any hypothesis within the gunshot radius (4.7) now knows a bearing |
| Ran (footsteps) | Soft, per emission, radius-scoped |
| Was inside a hypothesis' possible LOS with them facing my way | Soft, integrated over time |
| Damaged someone | That slot knows a sector instantly (5.1) |
| Threw utility they can see land | Soft, on the hypotheses that had LOS to the detonation |
| Died | Their whole team knows, and knows where |

From that: `pKnowsMe(h)` and `infoAdvSecsHat(h)` per enemy hypothesis h, computed
with the same cap and the same engagement-grace semantics as the real tracker so
the numbers are interchangeable. `infoAdvSecsHat` is then fed straight into
`pairFeatures` when pricing a hypothetical duel (6.7), which means unawareness is
priced by a term that was fitted on real demos rather than by a coefficient
somebody guessed.

v1 estimator is fixed rules (above), not learned, for the same reason enemy economy
inference is fixed (5.3): it is a rulebook fact. From P5, the true god-view value is
available at training time as a label, so an auxiliary head learns the estimator and
the fixed rules become its prior. Standard centralized training, decentralized
execution: the label exists in training, the actor never sees it.

**Timing advantage** is the map-scale version of the same idea and needs its own
mined table. `scripts/sim-mine-timings.mjs` walks the library and records, per map
and side and call, the distribution of first-arrival clock at every named zone.
A bot can then answer "if I leave now I reach banana at 0:12, and CTs are usually
there at 0:14 with p = 0.6", which is what a timing push *is*. The table feeds two
things: the flow prior in 5.5, and an explicit `timingEdge` feature per candidate
route in 6.7. Without it, "take the timing" is not representable, and bots will
only ever react.

### 5.7 Attention and decision latency

Two caps that stop a human-looking bot from being a superhuman one. Both are
skill-scaled (8.4) and both live in `constants.js`.

**Attention budget.** A bot tracks `k` enemy slots at full fidelity per decision
step; the rest of its personal belief slice decays faster than the team
blackboard's. `k` runs from about 1.5 at `mix` to 3 at `pro` `[calibrate against
the coach 'unchecked-position' and 'utility-unawareness' rates]`. This is the
mechanism that produces "he forgot about the lurker" without anyone authoring
dumbness, and it is the reason the filter lives on the team blackboard while the
bot reads a degraded view of it.

**Decision latency.** Separate from the aim reaction gate in 8.1, and currently
missing entirely. An event may not change a bot's chosen option faster than a draw
from LogNormal(median 350 ms, p90 700 ms) `[calibrate]`, and a *team* replan may
not happen faster than the caller's own decision latency plus the comm delay
(0.5 to 1.5 s, 5.1). Reflex exceptions, and only these, bypass it: taking damage,
a molotov landing on my feet, an enemy appearing inside my crosshair cone. Those
are spinal, and they are exactly the events 10.2 already classifies as local
interrupts.

Together with option commitment (6.6) this is what stops a priced policy from
dithering: the 8 Hz clock is how often a bot *may* decide, not how often it does.

### 5.8 The dead: no new eyes, more thinking time

A dead player in CS spectates teammates. That means he sees what they see, and
the team therefore learns **nothing new** from a death: the percepts a dead bot
receives are a subset of the percepts the living already have. Any design that
lets dead bots feed fresh information into the belief is a cheat, and any design
that cuts them off entirely is also wrong, because a dead player is obviously
still useful to his team.

What death actually changes is **attention**, and the plan already has attention
as a scarce resource (5.7). So:

- A dead bot contributes **no percepts**. Its knowledge is a view of the team
  blackboard, which is what spectating is.
- A dead bot contributes **attention**. It raises the team's effective `k` on
  slots the living are not tracking: the dead have nothing to do but watch the
  radar and the one teammate on their screen. Mechanically, dead bots run the
  belief-maintenance and threat-projection part of the loop without running the
  motor part, and their conclusions reach the living through the normal comm
  delay, as calls rather than as facts.
- A dead bot may **fire team interrupts** (10.2). "They are stacking B, rotate"
  from a dead player is one of the most common real calls in the game, and this
  is exactly the mechanism for it: no new information, better processing of the
  information the team already had.
- Dead bots cost nothing to run and this is not free skill: the attention bonus
  is capped so that a team wiped to one player is not somehow more aware than a
  full team, and the `concentration` trait (6.16) scales how much a dead bot
  actually contributes, because tilted players stop calling.

The nice consequence is that a 5v2 has a genuine, modelled advantage in
*awareness* on both sides, which is a thing every CS player knows and no bot
implementation represents.

---

## 6. The decision architecture: Playstyle AI, Individual AI, translator

### 6.1 The DecisionInterface (the portability artifact)

`shared/sim/intents.js` defines a versioned JSON schema. Everything above it is
learned; everything below it is constants. The schema is the thing that ports to
3D unchanged.

```jsonc
// TeamDirective (Playstyle AI -> per round + on TEAM re-plan events)
{
  "v": 1,
  "call": "a-execute" | "default" | ... ,        // round-library key, per map
  "shape": { "lanes": [3, 1, 1],                 // pattern-finder notation, per map lanes (6.20)
             "awpLane": 0,                       // the ⊕ mark: its own decision
             "pace": "rush"|"pop"|"contact"|"full-exec"|"default"|"slow-default" },
  "tempo": "slow" | "default" | "fast",
  "buy": { "team": "full"|"force"|"half"|"eco",
           "saveThreshold": 2 },
  "spawns": { "bot3": "sp_CT_-410_1830" },       // freeze only; permutation of the pool (4.12)
  "follow": {                                    // 10.3 / 10.4; null = no template
    "source": "mimic" | "call-template" | null,
    "roundRef": "demoFile:roundN" | null,
    "until": "interrupt"
  },
  "orders": [                                    // addressed per situation, not per player (6.1)
    { "to": ["bot3"],                            // one bot, a pair, a core, or all five
      "position": "banana",                      // the map position whose contract applies (6.19)
      "task": "hold"|"execute"|"lurk"|"rotate"|"save"|"follow"|"autonomous",
      "anchor": "banana_car",
      "trackSlot": 2,                            // which mimicked player this bot shadows
      "utilityBudget": ["inf_smoke_coffins_1", "..."] },
    { "to": ["bot1", "bot2", "bot4"],            // a core: one order, three bodies
      "position": "a-pack", "task": "execute", "anchor": "apps", "keepTogether": true }
  ],
  "triggers": [                                  // declarative TEAM re-plan hooks (10.2)
    { "when": "deaths>=2 && phase<40s", "then": "replan" },
    { "when": "site_contact(B)", "then": "rotate(B)" }
  ]
}

// IndividualIntent (Individual AI -> every decision step, 8 Hz)
{
  "v": 1,
  "move":   { "mode": "follow"|"hold"|"advance"|"peek"|"repeek"|"fallback"|"rotate"|"clear",
              "target": "banana_car",
              "gait": "run"|"walk"|"crouchwalk" },
  "combat": { "posture": "free"|"holdAngle"|"avoid"|"commit",
              "preAim": "banana_logs",
              "focus": "e2" | null },
  "utility": { "lineup": "inf_flash_banana_pop" } | null,
  "objective": "none"|"plant"|"defuse"|"pickupBomb"|"dropBomb"|"dropWeapon"|"hunt"|"holdSite",
  "buy": ["kevlarHelmet","ak47","smokegrenade","flashbang"] | null
}
```

Every enum field ships with a validity mask computed by the engine (7.5). The
policy can only pick legal actions; the translator can therefore be simple and
crash-free.

**Orders are a list, not a map, because the addressee is a property of the
situation.** "Both of you hold this together" is one decision, not two, and
splitting it into per-player rows loses the fact that it was one. "You three
take apps as a core" is one order with three bodies and a `keepTogether` clause
that the core reader (6.18) can then verify. A solo lurk is an order with one
body. The scope is chosen by whatever the situation is, which is the only rule
that survives contact with real CS, and it makes the decision log read the way a
call actually sounds.

### 6.2 Playstyle AI (the hivemind)

- One instance per team. Runs at freeze start (pick **spawns**, call, roles, buy
  posture, whether this round is FOLLOW or AUTONOMOUS) and then **only on team
  interrupts** (10.2), plus a slow 5 s heartbeat that is allowed to fire a team
  replan only if a trigger is armed. It does **not** chatter every contact.
- It is not the top of the stack. Above it sits the **Strategy AI** (18.4), which
  runs between rounds, reads the experience index, and hands down a prior over
  calls, a risk posture, an economy plan, a utility budget, and an avoid-set. The
  Playstyle AI consumes those as features and may disagree with them, because the
  layer that can see the round should outrank the layer that can only see the
  match.
- It is the "conjoined mind": it sees the *team* belief (blackboard) and emits the
  TeamDirective. It owns strategy: spawn permutation, call selection, role/task
  assignment, tempo, rotations, save calls, utility budgeting, and the promote-
  to-team decision when too many bots have already broken locally.
- Network: small (attention pooling over 10 entity slots into a 256-wide MLP torso,
  heads per directive field, ~200 k params). Small on purpose: strategic decisions
  are low-frequency and the label supply (one call per round per team) is thin.

### 6.3 Individual AI

- One *shared-weight* policy evaluated per bot at 8 Hz (every 8 engine ticks),
  conditioned on: its role embedding, its order, its personal belief slice, and
  optionally a mimic player embedding (10.3). Shared weights + conditioning is
  what makes 5 bots a team rather than 5 strangers, while still letting each act
  individually: exactly the brief's "conjoined and adaptable".
- Network: MLP torso 2×512 (v1), optional GRU 256 (v2, for memory beyond the
  engineered belief), per-head softmaxes (7.4), ~1 to 2 M params. Architectures
  deliberately constrained to MLP+GRU so inference stays a dependency-free JS
  forward pass (`shared/sim/policy/mlp.js`), matching the house pattern of weights
  as data (`duelModelParams.js`), no ONNX runtime needed.
- Arbitration vs the hivemind: while `task === "follow"`, the Individual's
  movement head is masked to `follow` and the translator shadows the track
  (10.4). Combat stays live. A **local interrupt** (10.2) flips that one bot to
  `autonomous` without asking the hivemind. A **team interrupt** replaces the
  whole directive. The Individual also holds a `discipline` scalar in [0,1]
  (personality / mimic / skill): survival reflexes (getting shot from an unknown
  angle, a molly at the feet) may fire a local interrupt even under high
  discipline; everything else follows the directive. Discipline is data, not
  code, so "loose cannon" and "system player" are the same network.

### 6.4 Roles and positions per map (requirement 4)

- Role vocabulary comes from the existing roles module: cross-map tactical roles
  (T: AWPer/Lurk/Pack; CT: AWPer/Anchor/Rotation) specialized to the painted map
  labels via `mapRoleAssign.js` and displayed with `teamPositions.js` order:
  Inferno T = AWPer, A Lurk, Banana, Ramp, 2nd Mid; Inferno CT = AWPer, A Anchor,
  B Anchor, A Rotation, B Rotation. This matches the brief's role list exactly.
- The Playstyle AI assigns role → bot **and spawn → bot** at freeze (inputs: the
  spawn pool, who owns the AWP, mimic template freeze positions if any, economy).
  Roles condition the Individual policy and select which named anchors and
  lineups are order-legal. Spawn choice is how a "good banana spawn" becomes an
  action rather than luck (4.12).
- The vocabulary is where role integration *starts*, not where it ends. A role
  embedding that only conditions a softmax is a shirt number. What each role owes
  the round, and how compliance is enforced and graded, is 6.19.

### 6.5 The translator (fixed forever)

Pure functions from (intent, engine state) to per-tick inputs. Never learned, no
RNG except the aim motor's seeded draws. Sub-modules:

| Intent | Translation |
|---|---|
| move.follow(track) | `trackFollow.js`: at clock t, desired pose is the recorded sample (x, y, yaw) of `trackSlot`. Wishdir toward that point with CS movement, gait inferred from the recording's speed (run/walk/crouch), counter-strafe when the recording is holding. **Never teleport.** Combat and the aim motor stay live. If geodesic error > 180 u for > 1.5 s, that is a local interrupt (fell off the tape). |
| move.advance(target) | A* over the nav graph, follow waypoints with 2D wishdir into `movement2d`, counter-strafe stop at the last node; gait sets speed cap and step-sound emission. |
| move.peek(target) | Template: pre-aim at `combat.preAim`, swing wide/shoulder per posture at run speed with counter-strafe stop at the peek node, re-clearable. |
| move.hold(anchor) | Micro-position within 48 u of anchor, stance per order, jiggle timers off `discipline`. |
| combat | Target selection among *known* enemies only; hands the aim motor a target track; fire gating: motor says on-target AND cycle ready AND posture allows. |
| utility(lineup) | Path to `from`, face bearing, channel, release; jump-throw flag plays the airborne tick. |
| objective.plant | Path into site polygon, channel 3.2 s, emits sound, writes flags. |
| objective.defuse | Path to bomb, channel 5/10 s, break on damage. |
| buy | Purchases through `economy.js` legality; order matters (armor before rifle when short). |
| spawns (freeze) | 2D: place bots on chosen pool points. 3D: freeze-only `setpos` to those same points. |

In the 3D port, this table is re-implemented as CS2 bot commands (13); the
signatures do not change.

### 6.6 Off-script: the option layer

10.4 says "follow the tape until something happens, then the Individual AI owns
movement". That sentence hides the entire product. On-script play is a playback
feature; off-script play is the bot. And a flat multi-head sampler firing at 8 Hz
is the wrong machine for it: it re-picks `move.target` every 125 ms, so it
dithers at every decision boundary, commits to nothing, produces movement no
human would recognize, and gives the inspector nothing to print but a softmax.

So the Individual AI stops emitting per-step movement and starts emitting
**options**: temporally extended behaviors with an initiation set, a fixed
micro-controller, and a termination condition. This is Sutton's options framework,
and it is also, not coincidentally, the shape of F.E.A.R.'s GOAP actions, Quake
III's goal stack, and a StarCraft bot's squad orders (17). Every game with bots
worth playing against arrived at the same structure.

```jsonc
// Option (shared/sim/options.js), versioned alongside intents.js
{
  "id": "wide_swing",
  "params": { "spot": "banana_car", "yaw": "logs", "gait": "run" },
  "initiation": "<engine-computed mask: reachable, has LOS potential, not channelling>",
  "micro": "<translator controller, fixed, never learned>",
  "terminate": ["contact", "arrived", "damaged", "timeout:1.8s", "orderChanged"],
  "minCommitTicks": 24
}
```

The v1 option set, which is also the vocabulary the inspector prints and the BC
extractor labels:

| Family | Options |
|---|---|
| Hold | `hold_angle(spot,yaw)`, `off_angle_hold(spot,yaw)`, `crossfire_hold(spot,mate)`, `stand_off(enemy)` |
| Peek | `jiggle(spot)`, `shoulder_peek(spot)`, `wide_swing(spot)`, `repeek(spot,delay)`, `punish_window(enemy)` |
| Move | `advance(route,gait)`, `clear(cornerSeq)`, `rotate(site,route)`, `flank(route)`, `lurk(zone)`, `fall_back(cover)`, `take_space(zone)` |
| Support | `trade(mate)`, `refrag(enemySlot)`, `bait(mate)`, `scout(target)`, `utility_setup(lineup)` |
| Objective | `execute_entry(site,slot)`, `plant(spot,cover)`, `defuse(mode)`, `retake(entry,order)`, `save(exitRoute)` |

Rules that make this a boundary rather than a suggestion:

- The Individual AI selects an option when the current one terminates, or at 8 Hz
  once `minCommitTicks` has elapsed, whichever is later, and never faster than
  decision latency allows (5.7). Commitment is the other half of the
  anti-dithering fix.
- **Combat is never inside an option.** The aim motor and the trigger stay live
  through every option including `save` and `plant`. Options own feet, attention,
  and utility; the motor owns the crosshair. Same split as the translator table.
- `follow` (10.4) is just another option whose micro-controller is `trackFollow`.
  A local interrupt is precisely "the follow option's termination fired for a
  reason the plan did not own". The interrupt taxonomy in 10.2 becomes the
  termination table, not a parallel system.
- Options are declarative and engine-agnostic, so they port to 3D under the same
  rule as intents (3): the option is the decision, the micro-controller is the
  constant that gets rewritten per world.

What this buys immediately, before any of the pricing below exists: masks are
natural (an option that cannot start is not in the initiation set), BC labels get
robust (an option has a signature across seconds, which is far easier to read off
a demo than "which anchor is he pointed at right now"), the RL credit horizon
matches the behavior instead of being 20x shorter than it, and the decision log in
11.3 reads as English.

### 6.7 The value stack: PFW, xK, PRW, and foresight

Three currencies already exist in this codebase and the first pass of this plan
used them as decoration (a feature here, a reward term there). Off-script play is
where they have to become the actual decision rule.

| Name | Code | What it is | Right use |
|---|---|---|---|
| **PFW** | `duels/duelModel.js: predictDuel` | This player's win chance in one fight, given crosshairs, weapons, hp, flash, reload, info advantage, and the other guns pointed at them | The atom. Everything else is built from it |
| **xK** | `coach/duelMistakes.js: expectedKillsAt` | Sum of PFW over every fight I am currently in. A clean 1v2 hold reads near 2 | A **feature** and a human-likeness metric. Never an objective |
| **PRW** | `rounds/roundWinAdapter.js: predictRoundCalibrated` | P(my side wins this round), clock and plant and economy included | The **objective** |
| The bridge | `coach/duelLookahead.js: expectedCtOverDuels` | Prices a round state over the joint outcomes of the open fights, averaging prices rather than bodies | Already written, already tested. This is the missing link and it is sitting in the repo |

**The rule: bots maximize PRW. PFW is how PRW is computed through fights. xK is a
readout.** Three consequences worth stating because each one is a bug the first
pass would have shipped:

1. An xK-maximizing bot never enters a site, because entering is always a worse
   fight than holding. CS is not symmetric: the T side has a clock and a bomb, and
   `roundModel.js` already encodes both (`timeW`, `timePow`, `plantW`). Optimizing
   PRW makes the entry correct at 0:40 and incorrect at 1:40, for free.
2. Variance-seeking when behind falls out of the mathematics and does not need a
   hack. Down 1v3, the play that maximizes P(win) is the high-variance one, because
   the low-variance ones all lose. Bots will start doing "stupid" aggressive things
   in lost rounds because those are correct, which is exactly what pros do.
3. The afterplant hold-versus-hunt money decision (4.9) becomes a computation in
   the same currency as everything else, instead of a special case.

**Foresight (`shared/sim/foresight.js`) is how an option gets a price.**

```
price(option) ->
  1. pose trace     translator predicts the option's pose path (x, y, yaw, speed)
                    over 0.5 to 2.0 s. The micro-controllers are fixed, so this is
                    a lookup, not a simulation, and it caches per (spot, yaw, style)
  2. hypotheses     draw M = 12 enemy placements from the particle filter (5.5),
                    stratified by zone mode so rare-but-deadly ones survive
  3. synth duels    build real playerFeatures / pairFeatures records for
                    (my predicted pose, hypothesis) and call predictDuel.
                    infoAdvSecs comes from exposure (5.6); crosshair offset comes
                    from the predicted yaw; smokes and flashes from engine state
  4. round price    feed the resulting duel set to expectedCtOverDuels with our
                    side's evaluate = predictRoundCalibrated (later: the learned
                    belief-value head, 9.14) -> P(win | I take this option)
  5. subtract       costs: exposure to unknown angles (particle mass that can see
                    me but that I cannot see), lost trade coverage (6.12), clock
                    burned, utility spent, hp spent, equipment value at risk
  => dPRW(option)
```

Step 3 is only possible because `duelSnapshot.js` was written as a single shared
entry point that the trainer and the viewer both call. The sim is a third caller
with synthetic states, and it gets exactly the features the model was fitted on.
Any second path here would silently ruin the numbers, which that file's own header
already says.

This is what "incorporate PRW and PFW properly" means concretely: pre-aim, off
angles, wide swings, crossing a smoke, and catching someone unaware are not rules
anybody writes. They are moves that change `crossW`, `infoW`, `spreadW`,
`cycleW`, and `moveW` in a fitted model, and the bot finds them by pricing.

**Budget.** Pricing every option every step is not affordable at 780x realtime.
Two-stage, like a chess engine's move ordering:

- The policy network proposes; foresight prices only its top three options plus
  the incumbent. Everything else is masked out by cost, not by evaluation.
- Angle-level geometry (visible sets, exposure sets, cover distance) is baked
  offline per map (6.8), so runtime foresight is arithmetic over cached bitmaps.
- Foresight is skipped entirely during bulk RL rollouts. Instead its outputs are
  **observation features** (7.2), computed cheaply for the incumbent and top two
  options, so the network learns to internalize the pricing rather than depending
  on it. This matters for the 3D port: a real CS2 server cannot be forked, so the
  policy has to be strong without search (6.11).

**Where the old thresholds go.** 10.2 gates smoke crossing on `xK < 0.1`. That
becomes a fallback for when foresight is budget-skipped. The real comparison is
`dPRW(cross)` against `dPRW(wait)` and `dPRW(reroute)`, which is the difference
between a bot that never crosses a smoke and a bot that crosses one when waiting
loses the round.

### 6.8 Angles: the catalogue, and choosing between them

"Choosing between angles" needs a data structure before it can need a policy.
`shared/sim/angles.js`, baked per map into `navcache/<MAP>.bin` at the same time as
the nav graph (4.2), because it is derived from the same LOS raster.

Enumeration: for each named anchor, candidate stance spots on a 32 u grid within
the anchor radius, crossed with 16 yaw sectors, then deduplicated by a hash of the
visible-cell bitmap so two spots that see the same thing collapse into one entry.
Inferno ends up somewhere near 2,000 surviving (spot, yaw) entries `[measure]`.

Per entry, precomputed once:

| Field | Meaning | Why a bot cares |
|---|---|---|
| `visibleSet` | Cells I can see from here | Feeds foresight and negative information (5.5) |
| `exposureSet` | Cells that can see me | The angles I am giving away |
| `angleCount` | Distinct approach corridors inside `exposureSet` | "I cannot hold both of these" |
| `depth` | Distance to the corner the enemy comes around | Close angle versus far angle, the whole CT anchor question |
| `coverDist` | Geodesic to the nearest cell outside `exposureSet` | How fast I can reset. The AWP's entire life |
| `preAimQuality` | Crosshair offset at first contact for the most likely approach | Directly moves `crossW`, the dominant duel term |
| `rarity` | How rarely a real player stands here, from library occupancy heatmaps | The off-angle score, and the surprise budget (6.9) |
| `utilExposure` | Which mined lineups (4.8) can smoke, flash, or molly this spot | Whether the angle survives contact with utility |

Four more fields, lifted directly from what `nav_analyze` computes for CS's own
bots (4.2), because they solved this in 2003 and the taxonomy still holds:

| Field | CS equivalent | What it gives us |
|---|---|---|
| `cover` | `HidingSpot::IN_COVER` | In a corner with hard cover nearby. The difference between an angle and a grave |
| `sniperQuality` | `GOOD_SNIPER_SPOT` / `IDEAL_SNIPER_SPOT` | "Has at least one decent long corridor" versus "sees very far, or a large area, or both". This is the AWP spot classifier, already defined by someone who shipped it |
| `exposed` | `HidingSpot::EXPOSED` | Out in the open. Sometimes correct (off-angle, 6.9), usually not, and the bot should know which it is choosing |
| `earliestOccupy[side]` | `m_earliestOccupyTime[team]` | Minimum seconds to reach this spot from that side's spawns. Geodesic, computed once at bake |

`earliestOccupy` deserves its own paragraph because it is free and it is the whole
timing game. The difference `earliestOccupy[T] - earliestOccupy[CT]` for a spot is
who wins the race to it from a standing start, per map, as a single number. Add
the current clock and the belief and you get the question a T player actually
asks: "can I be at car before they can be at logs, and do I believe they left on
time". 5.6 proposed mining that from demos; bake it from the geometry instead and
mine the demos only for the *behavioral* prior (when do they actually leave), which
is the part geometry cannot know.

**Spot encounters: how bots clear angles while walking.** The single best idea in
the CS nav mesh, and the reason its bots move better than their aim deserves. For
every path segment between two areas, `ComputeSpotEncounters` precomputes a
`SpotEncounter { from, to, path, spots[] }` where each `SpotOrder { t, spot }`
records the parametric distance along the segment **at which that dangerous spot
first gains line of sight to the path**. A bot walking the segment sweeps its
crosshair through that list in order, so it is always looking at the angle that is
about to open rather than the one it has already passed.

We bake the same thing per nav edge, with our angle entries as the spots and the
LOS raster doing the work. It costs one offline pass and it buys, with no learning
whatsoever: pre-aiming that is correct rather than memorized, clearing order that
matches how humans walk a corridor, a natural definition of "I have cleared this
part of the route" for the particle filter's negative information (5.5), and a
principled way for the translator to spend the crosshair while the option layer
spends the feet. It also gives the surprise layer something to violate: a bot with
low `concentration` (6.13) skips entries in the list, which is exactly what
checking an angle late looks like.

Team-level geometry, computed at placement time rather than baked:

- `crossfireScore(spotA, spotB, corridor)` runs `duelSnapshot.js: watcherSpreadDeg`
  on a hypothetical enemy entering that corridor. Two enemies at a wide spread
  cannot both be faced, which is precisely why `spreadW` is in the duel model; the
  CT setup problem is that same formula read backwards, as "place my five so an
  entering T faces the widest spread we can build". A CT hold is now solvable
  instead of memorized.
- `tradeCover(spotA, spotB)` is whether B can contest A's killer inside the trade
  window (6.12).

Choosing, all in the currency of 6.7: hold spot, peek style, and pre-aim are three
separate decisions with three different price shapes.

- **Hold spot**: maximize E[dPRW] over the particle filter, plus a rarity bonus
  from the surprise budget, minus `coverDist` risk. Anchors with high `angleCount`
  and low `coverDist` are the ones that die, and the model says so without anyone
  writing "do not overpeek".
- **Peek style**: each of `jiggle`, `shoulder_peek`, `wide_swing`, `repeek` has a
  different `exposureCurve(t)`, the number of hypotheses that can see me at each
  moment of the peek, and a different crosshair state on arrival. A jiggle is
  cheap information and a bad fight; a wide swing is an expensive commitment and a
  good fight if pre-aimed. That trade is the fighting-game neutral game (17), and
  it prices out correctly with no special casing.
- **Pre-aim**: the `combat.preAim` head already exists (7.4). What was missing is
  the reason to use it: pre-aiming shifts `offA` at contact, `offA` drives
  `crossW`, `crossW` is the single largest term in the fitted model. Bots pre-aim
  because it is worth roughly the difference between a 40% and a 75% duel, and
  they learn *which* angle to pre-aim from `preAimQuality` plus the belief mass.

`coach/angleHold.js: isHoldingVsPeekIn` is the existing definition of hold versus
peek, and the eval harness should reuse it verbatim so that "our bots hold angles
like pros do" is measured by the same function that judges humans.

### 6.9 The surprise factor: four mechanisms, deliberately kept apart

The ask is bots that sometimes walk through a smoke, run a molotov, or do
something objectively bad. The wrong implementation is one line of `if (rand() <
0.05) doSomethingStupid()`, which produces a bot that is random rather than
surprising, and which fails every human-likeness gate in 9.8. Unpredictability in
a good player has four distinct sources, and they need four distinct mechanisms
because they behave differently under training pressure.

**1. Wrong beliefs. This should carry most of the effect.**

A bot acts on its particle filter, not on the world. Stale mass plus a
2-slot attention budget (5.7) plus a missed footstep percept produces a bot that
walks confidently into a lurker, and every step of that was locally rational. This
is the honest mechanism and it is the one that scales with skill: `mix` bots have
higher belief dropout, slower percept integration, smaller `k`, and heavier trust
in the flow prior (they assume default positions). `pro` bots are wrong less often
and wrong later. Nothing here is injected noise; it is the same policy fed a worse
map of the world.

**2. Risk preference and confidence, fitted per player.**

- The objective is P(round win), so variance-seeking when behind is already free
  (6.7). No hack needed for hero plays in lost rounds.
- `confidenceBias`: the PFW a bot *decides* with is
  `sigmoid(logit(PFW) + b_i)`. This is the single most valuable personality knob
  and the site already measures it. `duels/duelStats.js` computes per player
  **pfw** (average predicted fight winrate of the fights they took) and **pfo**
  (how much they outperform that prediction). A player with a low pfw and a
  positive pfo is someone who takes fights the model dislikes and wins them
  anyway; a player with high pfw and negative pfo is someone who only takes free
  fights and still loses some. Fit `b_i` from the mimicked player's own numbers
  and the bot inherits their appetite for bad fights as a *measured* trait.
- `audacity`: one scalar drawn per bot **per round** at freeze from that bot's
  personality distribution, scaling the risk distortion for the whole round. Per
  round, not per tick, because real players have coherent moods and per-tick noise
  looks like a seizure. This is why the same bot in the same state crosses the
  smoke on round 7 and waits on round 8, which is what makes the sim worth
  watching and what stops the enemy from solving us.
- CVaR-style distortion at the risk-averse end: anchors and save rounds maximize a
  lower quantile of dPRW rather than its mean.

**3. Mixing where mixing pays, which is game theory rather than randomness.**

Raising the entropy coefficient makes a policy worse at everything equally. The
right tool is an adversarial one, borrowed from poker and fighting games (17):
train a **readability critic** that tries to predict our next option from the
*enemy's* observation, and charge the policy `+lambda * log p_read(a | o_enemy)`.
The policy then mixes exactly where being read is expensive (which angle to hold,
which side of the smoke to cross, when to peek) and stays deterministic where it
is not (buying armor, defusing when alone with 8 seconds). This is unexploitability
as a loss term, not as a coin flip.

**4. Priced "bad" plays that are actually correct.**

These need no randomness at all, only honest pricing, and they are the ones that
will make the sim look alive:

- **Smoke crossing.** During transit, `losClear` is false in both directions, so
  the duel model correctly reads the cloud as a coin flip nobody controls. The
  price is the exit pose: who sees the exit, at what crosshair offset, with what
  info advantage (5.6, and crossing a smoke is often an info *gain*, because they
  lose me too). The gain is time, timing, and the angle they are not holding. At
  1:40 the wait is better; at 0:22 in a 3v3 with B smoked it is not, and the bot
  crosses. That is a human "objectively bad" smoke walk that was the least bad
  option available.
- **Molotov running.** 40 hp/s and a tag, so a 0.6 s crossing costs about 24 hp and
  a slow. Price the post-crossing fight at the reduced hp against the seconds
  bought. Correct on a retake with 8 seconds left, never correct on a default.
- **Hero pushes, dry entries, 1v3 aggression.** These come out of the PRW
  objective, the audacity draw, and the clock. Not out of a rule.

Hard constraints on all four: **surprise never comes from the aim motor** (8 is
frozen inside the pro envelope, and 8.3's gates reject any model that finds a way
around it), never from the engine's rules, never from the economy. It comes from
beliefs, preferences, and mixing. Anything else is a bug that will show up as a
failed aim gate or a failed human-likeness gate.

Evaluation, added to 9.8, and deliberately **two-sided**: a bot that never does
anything odd fails as surely as one that always does. `sim-eval.mjs --surprise`
reports off-angle rate (spot rarity distribution), smoke-cross rate, molly-cross
rate, dry-entry rate, first-contact-spot entropy per map and side, and the pfw/pfo
distribution of the fights the bots chose to take, each against the library's own
distribution for the same map and side.

### 6.10 Opponent modeling: the match has to evolve

The reason most game bots feel dead is that round 24 plays exactly like round 1.
Every bot lineage that beat humans solved this: Brood War bots kept
opponent-specific memory across a Bo5, fighting-game players call it conditioning,
poker calls it exploitative deviation from the blueprint (17). Three layers here,
in ascending timescale.

1. **Within a round**: the particle filter (5.5).
2. **Within a match: a tendency tracker.** A decayed frequency model over the
   enemy's observed round shapes: which site, first-contact clock per zone, lurk
   presence, utility signature, buy pattern, save discipline. Built strictly from
   our own knowledge stream (what we saw and heard plus the public kill feed and
   scoreboard), never from engine state. Feeds the Playstyle observation (7.3).
3. **Call selection as an adversarial bandit.** On top of the Playstyle policy's
   call distribution, run **EXP3** over the legal call vocabulary, keyed by (side,
   economy bucket, score situation), as multiplicative weights on the policy's
   logits. EXP3 rather than UCB because the opponent adapts, which makes this an
   adversarial bandit, not a stochastic one. It provably mixes (so it also feeds
   6.9's surprise), it adapts inside 24 rounds, it is about thirty lines, it needs
   no training run, and it is completely explainable in the inspector: "b-rush
   weight fell from 0.31 to 0.08 after two losses".

**The scan and the tracker are both used, and they do different jobs.** The
antistrat aggregators are structured, tuned, and slow; the tendency tracker is
crude, unstructured, and fast. Neither replaces the other.

| Source | Provides | Cadence | Why not the other one |
|---|---|---|---|
| `aggTells` (≥ 5 rounds, ≥ 80% share) | Hard, named habits: "their B player always throws the same smoke at 1:38" | Every round, but only fires once the evidence exists | The tracker would call this at 2 rounds and be wrong |
| `aggCtSpread` | The opponent's CT setup distribution per economy state | Every round | Requires the structure the scan already encodes |
| `aggResponses` (5 s lead, ≥ 4 rounds, ≥ 50% share) | What they do *after* a stimulus: the rotation habit worth exploiting | Every round | This is the highest-value read in the game and it is already written |
| `classifyPace`, `pistolLean` | Their pace mix and pistol tendency | Every round | Definitions must match the ones we play by (6.20) |
| The decayed tendency tracker | Everything, immediately, at low confidence | Continuous | The scan cannot say anything at round 3, and round 3 still needs a prior |

So the model is: the tracker runs from round 1 and carries the uncertainty, the
scan's detections overwrite the tracker's estimate for any pattern that clears
its thresholds, and both are exposed to the policy with their evidence counts
(7.3b) so the network can weigh a 2-round hunch against a 6-round tell. The
thresholds stay at the shipped values, because they were tuned against real teams
and a second set of numbers would make the bots' reads disagree with the site's.

It also gives the /sim page a "what the bots have figured out about you" panel for
nothing, and it is the same code path that prices our own predictability when
pointed at our own rounds (6.21).

**Fakes need a model of their model.** A fake only pays if the enemy's belief
moves, and belief is not observable. But the sim runs *both* teams' knowledge
trackers, so at training time the enemy's true belief summary (their mass per
site, their total entropy) exists as a label. Train an auxiliary head on the
Playstyle net to predict it from our own observation; at execution the head is
used and the truth never is. That is CTDE-legal, and it is the difference between
a bot that calls `fake-a` because the label said so and one that calls it because
it predicts the CT will rotate.

### 6.11 Search at decision time, budgeted and optional

The engine is deterministic, forkable, and fast (4.1). For a small set of
high-stakes, low-frequency decisions, a policy should not be trusted when a
rollout is affordable:

- afterplant hold versus hunt (a money decision, 4.9),
- retake entry order and timing,
- last-man defuse race versus save,
- the 5 second commitment window before an execute.

Recipe, which is depth-limited search in the poker sense rather than full MCTS:
sample the enemy from the particle filter, clone a reduced engine state, run
K = 32 rollouts of 2 to 4 seconds with the current policy driving both sides,
evaluate the leaf with the round model, average per candidate. Vary the *enemy's*
continuation policy across a small set (passive, aggressive, BC anchor) so the
search is not exploiting our own quirks, which is exactly why Libratus carried
multiple continuation strategies.

Rules that keep this from eating the project:

- Hard millisecond cap per decision, and it is off during bulk RL rollouts.
- Search results are logged as **expert-iteration targets** (9.13): the policy is
  distilled onto the search's choices across generations, which is AlphaZero's
  loop at a size this codebase can afford.
- **The policy must be strong without it.** A live CS2 server cannot be forked, so
  in 3D the search either disappears or runs against the 2D engine as an
  approximate model. Search is a training amplifier and an analysis tool, never a
  runtime dependency. This is why 6.7 puts foresight prices into the observation
  vector rather than only into the arbiter.

### 6.12 Team geometry: trades, spacing, crossfires

The plan so far can produce five individually sensible bots who lose to any real
team, because CS is won by trades and the first pass never mentions them.

- **Trade discipline.** Each bot carries a `tradePartner` per phase, assigned by
  the Playstyle AI. Every option's price includes `tradeCover`: whether the
  partner can contest my killer inside the trade window (about 2 s `[mine from the
  library]`). An entry with cover is a different action from the same entry
  without it, and currently they price identically. The reward gets a matching
  term (9.5) and the eval gets a trade-rate band (9.8), both of which already have
  coach-rule counterparts (`no-trade-attempt`, `trade-failure`, `multikill-refrag`).
- **Spacing.** Minimum and maximum geodesic separation per task, from the
  `spacing` coach rule's own thresholds, applied as a price penalty rather than a
  hard leash so bots can stack deliberately when it is right.
- **Crossfires.** 6.8's `crossfireScore` as an explicit Playstyle placement
  objective for CT setups and afterplants. Two bots holding the same angle from
  the same depth is the most common bad bot behavior in every FPS ever shipped,
  and it is trivially detectable with a function this repo already has.
- **Utility with a purpose.** A smoke is an angle-modification action, so price it
  in the same currency: which entries in the pack's `exposureSet` does this
  lineup delete, and what does that do to the pack's dPRW. `sightRay.js` and
  `blockingSmokesAt` already answer the geometry; `coach/coachSmokes.js` already
  has the "was this smoke useful" logic to calibrate against. Flashes price the
  exposure they buy during the entry window. This replaces `utilityBudget` as a
  flat list with utility as a priced resource, which is how a human thinks about
  the fourth smoke.

### 6.13 Team shape: the formation frame, borrowed from football

EA's FC IQ draws a line this plan does not, and it is the right line: **the
formation is how your team behaves when it does not have the ball; roles are how
players move when it does.** Lose possession and everyone returns toward their
formation position; win it and roles pull them out of shape in structured,
asymmetric ways. Football Manager splits the same thing as role plus duty, and FC
IQ as Role plus Focus (one to three focuses per role, so a Playmaker can be set to
Attack or to Roaming and moves completely differently).

CS has exactly this structure and nobody writes it down. The ball is **initiative**:
who currently dictates where the round happens, which is readable from map control
(`possessionSharesAt`), the bomb, and where contact is live. A CT side that has
lost mid has lost the ball and should be collapsing toward shape; a T side that
owns banana and mid has the ball and should be pulling roles forward.

`shared/sim/shape.js`:

- A **shape** is a set of home positions, one per role, each an entry in the angle
  catalogue (6.8), defined per (map, side, call, phase). Shapes are data, baked
  from the library: the modal setup of real teams for that call, which the roles
  module and the occupancy heatmaps already give us.
- The shape **slides and compresses** with the frontier, the way a back four slides
  across the pitch. Anchors are relative to the control boundary and the bomb, not
  absolute: as T take banana, the CT shape shifts back and tightens toward the
  site. Compactness is a constraint, not a suggestion, and it is where 6.12's
  spacing rules live.
- **Home position is the default answer to "what do I do now".** Off-script, with
  nothing to react to, a bot returns toward its home position in the current shape.
  This is a far better idle behavior than "hold your anchor" and it is what stops
  five bots from drifting into the same corridor.
- **Role plus Focus.** Every CS role gets two or three focuses, which is the
  cheapest way to multiply strategic variety without touching the network:
  `Banana{hold, aggressive, info}`, `A Anchor{deep, close, roam}`,
  `AWPer{passive, aggressive, rotational}`, `Lurk{deep, connected}`. Focus is a
  Playstyle output (7.4), it conditions the Individual policy, and it changes the
  home position, the option initiation set, and the risk distortion together.
- **Role familiarity**, again straight from FC IQ, where an AI model assigns
  familiarity from real-world data and unfamiliar players transition into shape
  slower and execute worse. We can fit it honestly: how often has this player
  actually played this role and stood in these spots, from the library. A mimicked
  player put in an unfamiliar role gets slower shape transitions and a wider
  decision temperature. It is also the correct model for a stand-in.
- **Transition is an event.** FC IQ's "when you lose possession, players look to
  return to the formation position, and how quickly depends on familiarity and
  focus" is a rule worth copying verbatim. Losing initiative (a lost duel at the
  frontier, a smoke that cuts control, two deaths) triggers a **shape reset** with
  a per-bot transition speed. That is a much better default than a full team replan
  and it fills the gap between "local interrupt" and "team interrupt" in 10.2.

UI: FC IQ ships an **Activity Map** showing which zones each role will occupy.
Ours is one call to `analytics/heatImage.js` over the chosen shape, drawn in the
setup panel, so artysan can see the team's intended footprint before pressing play
and immediately spot that nobody is covering B.

### 6.14 Space, not the ball

FIFA 17's Active Intelligence System is the single most transferable idea in this
research, and the developers described the change precisely: player intelligence
used to be based on where the ball was and who had it, so runs were made relative
to the ball. Now players evaluate **space**: they look at where the defenders are,
decide "if I get into this space it is dangerous space", and run there. Players
also run off each other, one making a run so another can take the space just
vacated.

Every bot in this plan so far, and every CS bot ever shipped, is ball-chasing:
movement is a reaction to contact, sound, or an order. That is why bots cluster,
why they all rotate at once, and why they never take the map.

`shared/sim/spaceField.js` computes, at 4 Hz, a per-cell field over the nav
lattice:

```
control(c, tau)   P(my side occupies c uncontested at t + tau)
                  from geodesic reach of my living bots vs the particle filter's
                  mass reach for each enemy hypothesis. This is the football
                  pitch-control model, and possessionSharesAt is already half of it
value(c)          tactical worth: site proximity, angle quality from the catalogue,
                  what it cuts (rotations, the bomb path), what it sees
danger(c)         enemy influence, StarCraft style: each hypothesis projects a field
                  of radius (weapon effective range + margin + speed * my option
                  duration), so threat accounts for where they can *get to* while I
                  am busy, not only where they are
opportunity(c)    value(c) * control(c, tau) - danger(c)
```

Three things fall out of having this field that are otherwise separate features:

1. **Off-ball runs.** The option set (6.6) gains the football vocabulary because
   these are real CS behaviors nobody has named: `run_in_behind` (take space behind
   the frontier while they are looking elsewhere, which is a lurk), `drop_deep`
   (fall back to support a teammate under pressure), `show_short` (step out to give
   a teammate a trade angle), `dummy_run` (movement whose value is the attention it
   buys, priced through the enemy-belief head in 6.10), `overlap` (take the space
   the man in front just vacated).
2. **Backfill, which is the rule that fixes bot CS.** When a bot leaves its home
   position, the shape recomputes and the nearest compatible teammate inherits the
   vacated responsibility. "Nobody is watching B" is the defining failure of every
   FPS bot team, and it is one rule and one field away from being solved. FIFA
   solved it by making runs relative to each other rather than to the ball.
3. **Danger-aware routing.** A* over the nav graph with a cost functor, exactly as
   `nav_pathfind.h` does it, and the same three named route types CS uses: fastest,
   safest, retreat. Cost adds `danger(c)` plus the per-match decayed death memory
   (`m_danger`, 4.2). The safest route is not a different algorithm, it is a
   different functor, and the option's price decides which one it wants.

The field is cheap (a lattice pass, not a per-bot pass), it is shared by the team,
and it is exactly the kind of thing a small network cannot learn from scratch but
can use immediately as an input.

### 6.15 Anticipation: price the future, not the present

Football Manager makes this an attribute and puts it near the top of what
separates players: Anticipation is "how quickly a player predicts events and reacts
to the movement of others", and the community's summary of the interaction is
sharper than the manual's: concentration comes first, because a player who is
switched off is surprised by events even when their anticipation is good, and
anticipation comes before positioning, because reading the pass is what lets you be
in the place that intercepts it. EA describe the same faculty as players
"analysing surrounding players and the situation to better understand current
attacking opportunities and to better adapt to create space in the future".

Our foresight (6.7) prices options against the belief **as it is now**. Every
valuable CS decision is about the belief as it **will be**: a rotation started
after the contact is a late rotation, a flank started after they hear you is a
walk into a crossfire, a crossfire built after the entry is furniture.

Two changes:

1. **Foresight propagates before it prices.** Advance the particle filter, the
   teammates, and the clock to the option's *arrival* time, then build the
   hypothetical duels there. An option's price becomes the value of the world it
   creates, not the world it left. This is a small change to `foresight.js` and it
   is the difference between reactive and proactive bots.
2. **Trigger tables**, borrowed from FM's pressing triggers, which are contextual
   rather than constant: the engine raises press probability when the opponent
   receives the ball facing their own goal, takes a heavy touch, has a closed
   passing lane, or lacks support. Ours are the same shape, and each one arms an
   option with a **lead time**:

| Trigger | Lead | Option it arms |
|---|---|---|
| Enemy AWP fired and is cycling (`cycleW` is already a fitted term) | 1.4 s | `punish_window`, `wide_swing` |
| A known enemy is reloading, or just threw utility | 2 s | `punish_window`, `take_space` |
| Two accounted for on one side, the rest unaccounted, and the timing table says the other side is now reachable | 6 to 10 s | `rotate`, `backfill`, `crossfire_hold` |
| Belief mass on my angle has decayed below a floor and my `earliestOccupy` beats theirs | now | `take_space`, `run_in_behind` |
| A teammate is about to lose their duel (their live PFW below a floor) | 1 to 2 s | `trade`, `show_short` |
| Enemy pack is committed to a corridor a smoke can cut | 1 s | `utility_setup` |
| Clock crosses the call's typical commit window (`roundTiming`) | now | `execute_entry`, `fall_back` |

Each trigger is data, is logged with its lead time, and prints in the decision log
as English. And each is gated by the bot's `anticipation` trait (6.16): a low-
anticipation bot fires fewer of them, later, which is precisely what a worse player
looks like and is far better than making them aim worse.

### 6.16 Traits instead of a skill slider

Football Manager does not have a "skill" number. It has around forty attributes,
and the mental ones are wired to specific parts of the decision loop: Anticipation
predicts events, Decisions chooses among options, Concentration keeps that quality
up over ninety minutes, Composure holds it under pressure, Off the Ball governs
movement into useful space, Positioning governs defensive placement, Teamwork
governs adherence to the plan, and hidden attributes like Consistency and Big Match
Temperament govern how much a player varies from himself. The engine also weights
mental attributes more heavily in high-pressure moments late in the match.

CS's own bots do a coarse version of the same thing in `BotProfile.db`
(Booth again): `Skill`, `Aggression`, `ReactionTime`, `AttackDelay`, `Teamwork`,
`AimFocusInitial`, `AimFocusDecay`, `AimFocusOffsetScale`, `AimFocusInterval`,
`Cost`, `Difficulty`, `VoicePitch`, `WeaponPreference`, plus per-state look-angle
spring constants (`LookAngleMaxAccel`, `LookAngleStiffness`, `LookAngleDamping`,
with separate values while attacking). Two details worth stealing outright:
`ReactionTime` and `AttackDelay` are **separate** (noticing and shooting are
different faculties, which is exactly the split between 5.7 and 8.1), and
`Teamwork` is documented as how much the bot sticks to the plan rather than going
solo, which is our `discipline` under a better name.

So 8.2's profile becomes a **trait vector**, each trait wired to exactly one
mechanism, and the `mix` to `pro` seg in 8.4 becomes a preset over that vector
rather than a single lerp:

| Trait | Wired to | Effect of a low value |
|---|---|---|
| `reaction` | Aim reaction gate (8.1) | Slower to start the flick |
| `attackDelay` | Trigger discipline (8.1.4) | Hesitates after acquiring |
| `decisionSpeed` | Decision latency (5.7) | Keeps running at a dead plan |
| `concentration` | Attention budget and its decay over round time (5.7) | Loses track of enemies, skips entries in the spot-encounter list (6.8) |
| `anticipation` | Trigger table lead times, foresight horizon (6.15) | Purely reactive |
| `decisions` | Softmax temperature over priced options (6.9) | Picks the third-best option often |
| `composure` | Trait weighting under pressure: clutch, low hp, late clock | Falls apart in a 1v2 |
| `positioning` | Angle choice quality (6.8) | Stands in exposed spots, holds two angles at once |
| `offBall` | Space evaluation and run selection (6.14) | Never takes free space, never backfills |
| `teamwork` | Shape adherence, trade discipline (6.12, 6.13) | Goes solo, leaves the crossfire |
| `aggression` | Risk distortion baseline (6.9) | Refuses fights it should take |
| `consistency` | Variance of the per-round `audacity` draw (6.9) | Different player every round |
| `familiarity[role]` | Shape transition speed and execution quality (6.13) | Slow to get into position, worse at the role |

Three reasons this is better than one slider. It makes "t2 team" a *shape* rather
than a level, so two teams at the same average can feel completely different. It
lets mimicry fit traits per player from the library (`pfw`/`pfo` for aggression and
confidence, role heatmaps for familiarity, coach rule rates for concentration and
positioning) instead of assigning everyone the same personality. And it keeps the
anti-aimbot wall exactly where it is: only `reaction`, `attackDelay`, and the aim
sigmas touch the motor, and they stay clamped inside the pro envelope (8.2). The
other ten traits cannot make a bot mechanically superhuman no matter how they are
set, which means they can be exposed to the user freely.

### 6.17 Desire scoring: the arbitration layer that works before the ML does

Dota 2's shipped bots are a utility AI and the API is public: every mode
(`mode_laning_generic.lua`, `mode_roam_generic.lua`, `mode_retreat_generic.lua`,
and so on) implements `GetDesire()` returning 0 to 1, the engine evaluates every
mode's desire each frame, the highest becomes the active mode, and only that mode's
`Think()` runs. Team-level desires are separate and evaluated first
(`UpdatePushLaneDesires`, `UpdateDefendLaneDesires`, `UpdateRoamDesire`,
`UpdateRoshanDesire`), returning per-lane numbers that individual bots then read.
Item and ability use runs on its own independent think, so a bot can blink out
while its mode is still "retreat". Two details are worth copying exactly:
`GetDesire()` may return nil to fall back to the engine's built-in calculation,
and desire functions return a **motive** alongside the number.

Map that onto our layers and it fits without deformation: the team desires are the
Playstyle AI, the modes are our options (6.6), the independent ability think is our
always-live aim motor and utility, and the nil fallback is the seam between the
scripted planner and the learned policy.

So the option arbiter has two interchangeable implementations behind one interface:

- **Scripted**: each option computes `desire = f(priced dPRW, trait vector, shape,
  triggers)` in 0 to 1 with a motive string, highest wins, with hysteresis so it
  does not oscillate (Dota's modes have the same problem and solve it with
  thresholds; ours also has `minCommitTicks`). This is a complete, watchable,
  explainable CS bot with **no neural network at all**, available at P3b.
- **Learned**: the policy proposes, foresight prices the top three, and the same
  arbiter picks. Any option whose learned desire is unavailable or unconfident
  falls through to the scripted desire, which is Dota's nil pattern and is the
  cleanest possible hybrid.

The **motive string** is not a debugging afterthought, it is the product. Every
decision in the log reads "wide_swing banana_car: 0.72, motive: their AWP is
cycling and my earliest-occupy beats theirs", which is what makes the /sim page
worth opening and what makes a wrong decision diagnosable in one line instead of a
gradient investigation.

### 6.18 Cores and lurkers: the team's own shape, read live

`coach/cores.js` already computes the one structural fact about a CS team that
matters most and that no other module in the repo exposes: the **core** is the
largest group holding at least 60% of the living side inside one radius that
grows with the group (`coreRadius(n) = 150 + 100 · max(2, n)`, same-level only,
because Nuke ramp is ten radar units from heaven), and anyone alive outside it is
a **lurker**. With no core there are no lurkers, only a spread. That distinction
is exactly the one bots get wrong: five bots spread across the map are not a
team playing lurk, they are a team that has lost its shape and does not know it.

Cores become a first-class term in three places:

| Where | Use |
|---|---|
| Own team, 8 Hz | `findCore(alive)` on true own positions (own team is not a belief). Feeds `myCoreSize`, `amILurking`, `distToCoreCentroid`, `nearestTeammate` into 7.2, and drives the shape module's backfill (6.13) |
| Enemy team, 8 Hz | `findCore` over the **particle filter's** maximum-likelihood enemy layout (5.5), plus the same computation over sampled hypotheses to get `P(they are stacked)`. Not free information: it is a read of a belief, and it is wrong exactly as often as the belief is |
| Post-round | Core trajectory over the round is part of the situation key (18.2), so "we lost to a 4-core B hit while we sat 2-2" is a *retrievable* thing rather than a vibe |

What the bots do with it:

- **Trade discipline** (6.12) stops being a distance threshold and becomes a core
  membership test. `ALONE_DISTANCE = coreRadius(2) = 350 u` is already the repo's
  answer to "is this duel tradeable", so use that constant, not a new one.
- **Lurk is a decision, not a label.** A bot leaves the core when the priced
  value of the space it opens (6.14) plus its timing edge (5.6) exceeds the
  trade value it gives up. That means lurking is *earned* and can be graded: a
  lurker who dies untraded with no space taken and no information gained is a
  bot that broke the core for nothing, and 9.17 counts it.
- **Enemy core reading is what a good CT actually does.** "Four of them are
  together and I have not seen the fifth in 20 seconds" is the single most
  actionable inference in the game, and it is directly `findCore` over the
  belief plus a staleness check. It arms the anticipation triggers (6.15) for
  the lurk timing that follows, and it is a motive string a human can check.
- **Utility pricing.** A grenade that hits an enemy core is worth roughly its
  member count in value terms; the same grenade at a spread is worth one body.
  The utility desire term multiplies by `expectedBodiesInBlast` computed against
  the belief's core estimate rather than against a single hypothesis.

The 60% share and the radius formula are copied, not re-tuned. They were fitted
against real demos for the coach and the analyzer; a second, differently tuned
notion of "together" inside the sim would make the sim's own coach output
disagree with the site's, which is the one thing this plan cannot afford.

### 6.19 Role contracts: what a role owes, not what a role is

The roles module classifies. `computeRoles.js` reads T spatial diversity and CT
pulled-string distance and zone affinity, `mapRoleAssign.js` specializes to
painted labels, `teamPositions.js` orders them for display, and
`tacticalFromCounts` reduces a player's maps to one word. All of it is
descriptive: it names what somebody did. Handing that word to a policy as an
embedding (6.4) and calling roles integrated is the same mistake as handing a
football player a shirt number.

**Contracts are keyed by map position, not by cross-map role name.** Each map has
its own five T and five CT positions, which is what `mapRoleAssign.js` and
`teamPositions.js` already enumerate: Inferno T is AWPer, A Lurk, Banana, Ramp,
2nd Mid; Inferno CT is AWPer, A Anchor, B Anchor, A Rotation, B Rotation. That is
the contract table, ten rows per map, and it is the right key because a contract
is made of zones and timings, both of which are map facts. The cross-map role
name (AWPer, Lurk, Pack, Anchor, Rotation) is a *derived label* used for
conditioning and for cross-map statistics, exactly as `tacticalFromCounts`
derives it today.

A contract is evaluated every tick and has five clauses:

| Clause | Meaning | Read by |
|---|---|---|
| `zones` | Named areas this role may occupy, ranked, with a hard set it may not leave without a directive change | Option initiation mask (6.6), pathing costs |
| `utilBudget` | Which lineups it owns this round and how many, out of the team's total | Utility desire, buy head |
| `window` | The clock interval in which its job exists (an entry's job is 0 to 25 s; a rotation's is after first contact) | Trigger arming (6.15), desire weights |
| `tradeDuty` | Who it is expected to trade and who is expected to trade it, as a directed pair, refreshed on death | Team geometry (6.12), core membership (6.18) |
| `deathPermission` | The dPRW price at which dying is acceptable. An entry may die for 40 u of space; an AWPer holding a retake angle may not die for anything | Foresight thresholds (6.7), risk preference (6.9) |

Consequences that were missing before:

- **Masks, not hints.** The contract's `zones` and `utilBudget` enter the action
  mask (7.5), so a Banana player physically cannot emit "advance to apartments"
  unless the Playstyle AI reassigns it. Roles stop being advisory the moment
  they are enforced by the mask, and the network stops needing to learn what a
  role is, because it can no longer violate one.
- **Reassignment is an action, not an accident.** When the Banana player dies,
  its contract does not evaporate; the Playstyle AI reassigns the zones, budget,
  and trade duties among the living, which is the difference between four bots
  and a team down one. Contract reassignment is a logged directive with a motive.
- **Role fitness is measurable.** For each role, per map and side, mine the pro
  distribution of contract compliance from the library: what fraction of a real
  Anchor's live seconds are inside the anchor zone set, how much utility a real
  Lurk throws, when a real Rotation actually leaves. A bot that plays "Anchor"
  while roaming mid is off-contract, and 9.17 scores it out of tier without ever
  looking at whether it won.
- **Familiarity is a trait, not a lookup.** 6.16 already carries
  `familiarity[role]`. It now means something specific: familiarity scales how
  quickly the bot's desires converge on contract-legal options and how tight its
  timing window is. A low-familiarity AWPer takes the right angle late. This is
  FIFA's role familiarity (17.2) with a mechanism attached. Familiarity is keyed
  by map position, so a player can be a natural Banana and a poor Ramp.
- **The AWP position is deliberately unfinished.** Every other position can be
  written as zones, timings, and duties. The AWPer cannot: it decides from macro
  theory about where a round's value is, which angles are worth one bullet, and
  when to give up map control to keep the rifle alive. That model is specified
  separately and this section is written to accept it as a drop-in: the AWP
  contract's `deathPermission` and `window` clauses become functions supplied by
  that model rather than constants from the table. Nothing else in the plan needs
  to change when it arrives.
- **Cores and contracts interlock.** Contracts define the intended shape; cores
  measure the realized one. When the two disagree for longer than a tolerance,
  that is a team interrupt (10.2) and it is one of the highest-value ones,
  because "we are no longer in the shape we called" is precisely the state that
  a mid-round replan exists to fix.

Roles are still *learned into*, not scripted: the contract restricts the option
space and prices the desires, the policy chooses inside it. The point of the
contract is that a generation cannot get strong by quietly abandoning roles, and
we would never have noticed if it did.

### 6.20 The default grammar: how a round starts, in a notation that already exists

`analytics/patternDefs.js` is a finished grammar for the first forty seconds of a
CS round and the plan was not using it. It contains, as data, per map:

- **Lanes**: named region memberships a player is either in or not. Inferno has
  two (B, A), Mirage three (B/UG, Mid, A), Dust2 three (B, Mid, Long).
- **Formation notation**: lane counts written in notation order, with the
  five-stack short form (`5B`) and per-map lane omission rules, plus `AWP_MARK`
  (`⊕`) on whichever lane the AWP is standing in.
- **A snapshot clock** per map: 1:40 Inferno, 1:46 Mirage, 1:42 Dust2, 1:44
  Ancient, 1:39 Cache, 1:42 Nuke and Anubis.
- **Six pace types** with exact thresholds: rush, pop, contact, full exec,
  default, slow default, each defined by clock, bodies committed, deaths, and
  utility spent.
- **A fake descriptor**, which already speaks the language of cores: "1 player
  (2 if the other 3 hold a core)".

Two vocabularies, and both are used. The **grammar describes how the round is set
up**; the **round-library call describes what the round became**. A round can be
`⊕3-1-1 slow default` in the grammar and `banana control into B` in the library,
and those are two true statements about different things. So the Playstyle AI
emits both: a formation head (lane counts), a pace head (six-way), a fake
descriptor, and the library call, with a consistency term in training rather than
a hard constraint, because the two can legitimately disagree at the margins and a
hard constraint would just teach the network to lie on one of them.

**The snapshot clock is a measurement, not a decision point.** It sits after the
start has been chosen and before the round is chaotic enough that plans stop
predicting anything, which is exactly why it was chosen for analysis and exactly
why it is the right anchor here. It gives the round three eras with different
machinery:

| Era | Clock | What governs |
|---|---|---|
| Setup | Freeze to snapshot | The chosen formation and pace. Shape (6.13), contracts (6.19), and the commitment the team said it would make |
| The read | At snapshot | One measurement: the realized formation, the AWP lane, the pace so far, and both sides' read of each other. This is the situation key's anchor field (18.2) |
| Chaos | Snapshot onward | Options, foresight, interrupts, and everything else in section 6. Plans are now descriptive at best |

Consequences worth naming:

- **The situation key gets a shape field with a name humans use.** "We lost this
  from `2-1-2` against a `B` stack" is a retrievable, sayable fact, and the
  notation collides usefully by construction, which is what memory addresses need
  (18.2).
- **Pace becomes commandable and gradeable.** "Run a pop B" is a legal command
  with a machine-checkable definition, so the call validator (10.1) extends from
  library calls to pace types for free, and a generation that can only play one
  pace fails visibly rather than quietly.
- **The formation distribution is the clearest style readout available.** Whether
  gen 14 produces the mix of `2-2-1`, `3-1-1`, and `5B` that this map's pros
  produce is one histogram, per map, and it belongs in the deep analysis the
  human viewer can open (11.5), not only in a gate.
- **The AWP mark is a tell and should be treated as one.** Which lane the AWP
  starts in is one of the most read-off-able facts in the game. It is a separate
  decision from the formation and it is mixed separately (6.9).
- **Lane counts are the natural language for cores.** A core is a group of
  players; the notation is literally the sizes of those groups per lane. `findCore`
  (6.18) measures the realized grouping, the notation names the intended one, and
  the gap between them is the same signal as shape drift.

### 6.21 Deception: managing what they infer, at any scale

The first draft of this plan wanted a "fake head" bolted to the formation, and
that is wrong in both directions.

It is too strong at the formation scale, because bodies are conserved: you cannot
fake A and go B with four players on A, outside of a pistol or eco oddity with
the bomb going one way alone. The formation itself already constrains what
deception is even available, and a separate head would happily emit illegal
combinations for the mask to clean up.

It is far too weak everywhere else, because most real fakes are not a formation
at all. Inferno's B fake can be one player throwing two smokes while two A
players walk out balcony or apartments. Fakes happen in 3v3s. They happen after
first contact. None of that is expressible as a lane count and none of it should
have to be.

So deception is not a head. It is a **cost function over the enemy's inference**,
which the plan already has the machinery for:

- `exposure.js` (5.6) estimates what the enemy plausibly knows about us.
- The enemy-belief auxiliary head (9.14) predicts what they currently believe.
- The readability critic (6.9) prices how predictable our next move is.

A deceptive act is any action whose value comes from the *difference* between
what the enemy will infer and what is true. That gives one uniform rule:

```
deceptionValue(action) = ΔPRW_from_their_wrong_belief − exposureCost(action)
```

which prices a lone smoke thrown to sound like an execute, a two-man balcony
walk, a decoy, a deliberately loud rotate, and a 3v3 fake with the same
arithmetic, because they are the same thing: spending a resource to move the
enemy's belief away from the truth. Bodies are constrained by the formation
because the formation is the body count; utility and sound are not constrained at
all, which is exactly what the game looks like.

The fake descriptor from `patternDefs` stays, but as a **detector**, not a head:
it labels rounds after the fact, so we can measure how often bots fake, at what
scale, and whether their fakes actually moved the opponent, which is the only
thing that makes a fake different from wasted utility.

### 6.22 Utility is utility

The plan treated grenades as execute lineups with a mining pipeline attached.
That is one use out of many, and by volume it is not even the main one. Utility
is a general tool used against a *belief*, and there is a clear competency
ladder, which doubles as a curriculum and as a grading axis:

| Rung | Competency | What it requires |
|---|---|---|
| 1 | Throw the mined lineup correctly when commanded | Lineups (4.8) |
| 2 | Throw the right lineup for the commanded call | Contracts and budget (6.19) |
| 3 | **Flash at a believed position**, not at a location | The particle filter (5.5): flash where the mass is, not where the callout was |
| 4 | **Molotov against a believed rush**, before it arrives | Anticipation triggers (6.15) and arrival clocks (6.8) |
| 5 | **Smoke under pressure at the right moment**, including to deny, delay, and retreat, not only to execute | Foresight pricing (6.7) |
| 6 | **Vary the timing** so the throws cannot be read | The tell scan on our own rounds (6.9, 6.21) |
| 7 | **Spend against the round's utility economy**, not against the moment | 6.22's second half, below |

Rung 7 is the one that makes the arms race real, and it is the answer to whether
bots should be allowed to out-strategize pros. **Utility is a depletable resource
with a timeline.** A CT side that stops a 1:40 rush with three molotovs and three
HEs has bought the early round with the late round. The T side that notices this
learns to force those throws cheaply and take the site at 0:45 against a team
with nothing left. That is a real, well-known CS dynamic, it is entirely
learnable from round-win outcomes, and it requires exactly two things from the
engine and observation space:

1. Both sides' remaining utility, per type, as a first-class observation
   (believed for the enemy, exact for us) rather than a footnote inside the
   economy block.
2. A reward that only cares about the round, so spending early to win early and
   spending late to win late are priced by the same currency and the trade is
   discovered rather than declared.

This is why strategy is deliberately not banded in 9.18. Left alone in a league
with exploiters, this converges to the meta by itself, and the convergence is the
interesting output. A band would freeze it at whatever pros happened to be doing
in the demo window.

---

## 7. Observation and action spaces, spelled out

### 7.1 Design rules

- Everything derived from the knowledge tracker only (5.4 guarantee).
- All positions encoded twice: normalized world (x/4200, y/4200 relative to map
  center) and as zone one-hot/embedding (the painted zone the point is in), so
  policies transfer patterns across maps.
- All distances geodesic (path lattice), not euclidean, wherever "how far really"
  matters (rotations, reachability, sound).
- Staleness: every belief item carries `age` in seconds, capped and normalized.

### 7.2 Individual observation vector (v1, ~420 floats)

| Block | Size | Contents |
|---|---|---|
| Self | 40 | pos (world+zone emb 8), vel, yaw sin/cos, stance/gait, health/100, armor/100+helmet, flash s, active weapon (class one-hot 8 + price/5000 + mag fraction + reserve + cycle-ready + reloading), money/16000, hasBomb, hasKit, channel one-hot, tagged |
| Teammates | 5×24=120 | alive, rel pos (geodesic dist + direction sector 8), zone emb, health, weapon class, flash, role emb 4, **believed** task one-hot, hasBomb |
| Known enemies | 5×26=130 | exists, seenNow, age, lastKnown rel pos + zone emb, reachable-ball radius, weaponSeen class, threat: xK of the hypothetical duel me-vs-them NOW via `predictDuel` (a feature, not a reward), inMyCone |
| Sounds | 8×6=48 | last 8 team percepts: type one-hot, sector, range band, age |
| Map control | 24 | own-side control share per painted area (povZonePaint semantics), t/ct/neu global shares |
| Plan | 30 | call embedding 8, my role emb 4, my task one-hot, anchor rel pos, tempo, directive age, trigger armed flags |
| Round state | 28 | phase one-hot, clock/115, bomb timer/40 if planted, plant site one-hot, alive counts both, score both/13, round number/24, half, my team side, economy state one-hot own + inferred enemy, loss streaks |
| **Total** | **~420** | |

v2 adds an egocentric 32×32 occupancy/control grid through a tiny conv column,
only if vector features plateau: it complicates the JS forward pass, so it must
pay rent.

**Teammate task is believed, not given.** The first pass handed each bot its
teammates' current `task` for free, which is telepathy: it lets five bots
coordinate perfectly with the comm delay switched off. A teammate's task is known
only when it arrived over the comm channel (0.5 to 1.5 s, 5.1) or when it is
inferable from what I can see them doing (a man walking toward B is taking B).
The block therefore carries the last *received or inferred* task plus its age.
Rounds where the comms fall behind should look slightly disorganized, because they
are.

**Blocks added by the off-script architecture** (v1.1, roughly +150 floats):

| Block | Size | Contents |
|---|---|---|
| Belief | 5×14=70 | Per enemy: top-3 zone modes and mass, belief entropy, expected time to contact along my current route, mass inside my current `exposureSet`, mass inside the top-2 candidate angles' exposure sets, `pKnowsMe` and `infoAdvSecsHat` (5.6) |
| Angle | 24 | Current spot: `angleCount`, `depth`, `coverDist`, `preAimQuality`, `rarity`, `utilExposure` count; plus the same six for the best alternative spot within reach |
| Foresight | 12 | dPRW and its exposure cost for the incumbent option and the policy's top two, plus their commit cost in seconds (6.7). Present even when search is off, because these are cheap arithmetic over cached bitmaps |
| Option state | 10 | Current option one-hot bucket, ticks committed, ticks until timeout, termination flags armed |
| Team geometry | 12 | Trade cover of my current spot, distance to `tradePartner`, spacing violation signal, crossfire score with the nearest teammate |
| Timing | 8 | `timingEdge` per candidate route: my ETA against the enemy's baked `earliestOccupy` for the same spot (6.8), clock pressure, my ETA to the objective |
| Shape | 14 | Offset from my home position in the current shape, shape phase, my role and focus embedding, role familiarity, whether my home position is currently vacated by me, whether a teammate's is unbackfilled (6.13) |
| Space | 18 | Local samples of the opportunity field (6.14): value of my current cell, the best reachable cell within 2 s and its direction, control share trend, danger at my cell and along my current route |
| Triggers | 10 | Which anticipation triggers are armed and their remaining lead time (6.15) |
| Utility economy | 10 | Both sides' remaining utility by type: exact for us, believed for them, plus how much each side has already spent and how early. This is a first-class block, not a line in the economy summary, because the early-versus-late trade in 6.22 is invisible without it |
| Self extras | 6 | `audacity` this round, `confidenceBias`, attention budget `k`, decision-latency clock remaining |

### 7.3 Playstyle observation (~260 floats)

Aggregates of the above per team: 10 entity summaries (5 own with full state, 5
enemy beliefs), control shares per area, economy both sides, score/streak/time,
current call one-hot, utility inventory counts, round-model win probability
`predictRoundCalibrated` as a feature, **spawn pool encoding** (each available
spawn as zone emb + geodesic to key areas, plus which bot is currently assigned),
and how many teammates are still on `follow` vs already locally broken. Spawn
quality is no longer a summary of luck: it is the consequence of the permutation
the policy just picked (4.12). "CT AWP peeks banana at 1:45 given a good spawn"
is learnable because the network can take that spawn.

### 7.3b Playstyle additions from opponent modeling

The tendency tracker's feature vector (6.10): enemy site frequencies by economy
bucket, first-contact clock distribution per zone, lurk rate, utility signature,
save discipline, and how those have shifted over the last five rounds. Plus the
current EXP3 weight vector over the call vocabulary (so the policy can see what
the bandit is already doing to its own logits), the predicted enemy belief summary
from the auxiliary head, and the team's own belief entropy from 5.5.

Plus, from the layer above: the Strategy AI's prior over calls, its risk posture,
its utility budget split, and the avoid-set penalty for each situation key the
candidate calls would lead into (18.4). These arrive as features, not as
overrides, so the Playstyle AI can disagree with the plan when the round in front
of it says otherwise, which is the same freedom a real in-game leader has.

### 7.3c Strategy observation (~90 floats, once per round)

Small on purpose: 24 decision points per match is not a dataset, so this network
generalizes through its features rather than its capacity.

| Block | Size | Contents |
|---|---|---|
| Match state | 14 | Score, side, rounds to half and to match point, streak, both economies and their projections two rounds out, timeout state |
| Opponent model | 24 | The tendency vector (6.10) and its recent drift, the EXP3 weights, the antistrat scan summary |
| Own history | 16 | Our call frequencies this match and their outcomes, contract compliance last round, the mistake ledger's top three active rules, core integrity trend |
| Retrieval | 30 | For each of the top five candidate calls: the index's lower bound, `n`, scope of the best-matching record, recency, and the call-versus-execution attribution split (18.3) |
| Prior | 6 | The library's own base rates for this map, side, and economy state |

The retrieval block is the whole point. It is how weights learn *when to trust a
memory* while the memory itself stays inspectable data (18.4).

### 7.4 Action heads

Individual (all categorical, all masked). The movement heads are replaced by the
option layer (6.6); everything else survives unchanged:

| Head | Arity | Notes |
|---|---|---|
| option | 24 | The option families in 6.6. Masked by the initiation set. Locked while `minCommitTicks` has not elapsed and while decision latency is pending (5.7) |
| option.target | 24 | Candidate set: k-nearest named anchors and their angle entries (6.8) + order anchor + plan waypoints + retreat node; masked by reachability and role legality; ignored during `follow` |
| peek.style | 4 | jiggle / shoulder / wide / repeek. Only unmasked for peek-family options |
| gait | 3 | run/walk/crouchwalk; during follow, inferred from the tape and masked |
| stance | 2 | stand/crouch |
| combat.posture | 4 | free/holdAngle/avoid/commit |
| combat.preAim | 16 | LOS-plausible named spots from current/next node |
| combat.focus | 6 | known-enemy slot or none |
| utility | 1+M | none + legal lineups (inventory ∧ reachable ∧ role budget), M≈24 |
| objective | 8 | none/plant/defuse/pickupBomb/dropBomb/dropWeapon/hunt/holdSite |
| buy | 12 binary | gated to buy period; legality via economy module |

Playstyle heads gain **shape** and **focus** (6.13): a shape head over the baked
formation frames for this call and phase, and a per-bot focus head (2 to 3 options
per role) which is the cheapest strategic variety in the whole design, because it
multiplies the call vocabulary without touching the map, the network size, or the
option set.

Playstyle heads: spawn permutation (Hungarian-scored shortlist of legal 5-picks
from the pool, or a pointer per bot onto unused spawns, freeze only), call
(per-map vocabulary, 13 to 21 + default, masked by side), tempo (3), buy posture
(4), per-bot role assignment (pointer network over 5×5, masked), per-bot
task+anchor (compound head, includes follow/autonomous), rotate-now (per site),
save (bool), promote-to-team-replan (bool, used on the heartbeat when local
breaks have piled up).

### 7.5 Masking is the contract

The engine computes masks; the policy samples inside them; the translator
executes without validation branches. A mask bug is therefore loud (illegal action
crash in dev assert) rather than silent. Masks are also exported into the BC
dataset so imitation never trains on illegal targets.

---

## 8. The aim model: pro-capped, never aimbot

The ML **cannot** output angles. It outputs *who to try to kill and how to stand*.
The aim motor converts that into crosshair motion under hard human constraints.
Skill ceilings are constants in `shared/sim/constants.js`; evolution can select
*fights*, never *mechanics*. That is the anti-aimbot guarantee, structurally.

### 8.1 Motor loop (64 Hz, per bot)

1. **Reaction gate**: when a target first becomes actionable (enters cone with
   clear LOS, or a peek exposes it), start a reaction timer drawn from
   LogNormal(μ, σ) ≈ median 200 ms, p10 150 ms, p90 300 ms `[calibrate]`, +80 ms
   if the contact was un-preaimed (surprise), −40 ms if preAim was within 10° of
   the target (that is what pre-aiming buys, and why the *decision* to pre-aim
   matters more than raw reflexes).
2. **Rotation**: yaw moves toward target with capped angular velocity (peak
   ~600°/s flick `[calibrate]`), critically damped, with signal-dependent noise:
   flick endpoint error ~ N(0, σ_flick(angleΔ, dist)) following a Fitts-style
   speed-accuracy tradeoff.
3. **Tracking**: while on target, tracking error is an Ornstein-Uhlenbeck process
   (humans wobble, they do not hold zero error); strafing targets increase σ.
4. **Trigger**: fire when predicted crosshair error < target angular radius ×
   confidence, respecting `cycleSeconds`, movement inaccuracy (4.5), and burst
   discipline (2 to 5 round bursts at range for rifles; spray transfer allowed
   within 15° with degraded σ).
5. **Recoil**: abstracted into per-burst σ growth (bullets 1 to 5 tight, 6+
   blooming) rather than a literal pattern; pattern-level recoil is 3D detail the
   2D sim cannot honestly represent.

### 8.2 Skill profile (constants, per archetype, mimic, or knob)

`{reactionMedian, reactionSigma, flickSigmaScale, trackSigmaScale, maxTurnRate,
sprayDiscipline, hsBias, triggerConfidence, decisionTemperature, discipline,
decisionLatencyMedian, attentionSlots, beliefDropout, confidenceBias,
audacityMean, audacitySigma, riskQuantile}`: one profile per bot. The last seven
are the off-script half of a personality (5.7, 6.9); `confidenceBias` is fitted
from the mimicked player's own pfw/pfo (`duels/duelStats.js`) rather than typed
in by hand. Sources, in override order: per-bot UI knob (8.4) → mimic
player fit (10.3) → archetype → team knob. Profiles are clamped inside a
**pro envelope**: no parameter may exceed the 95th percentile fitted from
top-tier demos in the library. The envelope is the anti-aimbot wall. Skill knobs
only move *inside* it, toward a weaker amateur floor.

### 8.3 Calibration and enforcement

- Fit targets from the library: time-to-damage after first sight (extractable via
  the vision state + damage events, the same machinery `not-ready` coach rule
  uses), accuracy by distance and weapon (shots vs damage events), HS ratio by
  weapon, `aimMetrics.js` crosshair-offset distributions.
- CI-style eval (`sim-eval.mjs --aim-gates`): run 2,000 scripted 1v1 duels per
  weapon class; assert sim TTD/accuracy/HS distributions sit within the pro band
  (KS distance thresholds). **A model release that fails aim gates is rejected
  automatically**, so no training run can ever sneak super-human mechanics
  through the back door.

### 8.4 Skill knobs: whole team, or per bot

The page (and the match config) exposes skill as a first-class control, because
the long-term product is "load five bots and scrim." A real team will want
"these five play like a T2 side" one night and "the AWPer is elite, the rest
are mix" the next. Training still always runs at the pro envelope; knobs are
for play, eval, and curriculum, not for sneaking past aim gates.

**Two layers, same machinery:**

| Knob | Default | What it scales |
|---|---|---|
| Team skill `S_team` | `average` | All five bots on that side, both aim-motor params (8.2) and decision noise |
| Per-bot `S_i` | inherit team | Overrides that one slot. Role-labelled in the UI (AWPer, Banana, …) |

Named stops, internally a 0..1 lerp from an amateur floor to the pro envelope
`[tune the floor against mix-level demos]`:

`mix` → `t3` → **`average`** → `t2` → `t1` → `pro`

Default for play is **`average`**. Training still always runs at the pro
envelope. The page exposes the full seg; nothing is locked.

What lower skill actually does (all of these, together, never "add random
spread to an aimbot"):

- Aim motor: slower reaction median, fatter flick σ, fatter tracking σ, lower
  max turn rate, worse spray discipline, lower HS bias, more reluctant trigger.
- Decisions: higher softmax temperature on Individual heads (noisier peeks,
  worse pre-aim picks, more running-shot postures). Playstyle temperature
  scales with `S_team` only, so a godlike AWPer on a mix team still gets mix
  calls and mix rotations. That is the point of splitting the knobs.
- Discipline: lower skill → more local interrupts on weak contact (they break
  the execute because they got scared). Higher skill → they trust the tape
  longer, which is also how mimic-follow stays intact against a noisy CT.
- Utility: extra timing jitter on lineup release, more likely to skip a
  budgeted nade. Not "worse nade physics."
- Perception: smaller attention budget `k`, higher belief dropout, slower
  percept integration, heavier trust in the flow prior (5.5, 5.7). A `mix` bot
  is not blind, it is behind. This is the main channel through which lower skill
  produces genuinely bad plays instead of merely slow ones (6.9).
- Decisions, again: longer decision latency (5.7) and longer commitment, so weak
  bots keep running at a plan that died two seconds ago.
- Foresight: fewer particle hypotheses and no search (6.11), so weak bots price
  the world coarsely. Never "the same price plus noise".

What it must not do:

- Raise any motor param above the pro envelope, even if someone types `S=2`.
- Change damage, movement speed, economy, or FOV. Those are the game, not skill.
- Turn off the knowledge tracker. Worse players do not magically see through
  walls; they just react slower to what they do see.

Playstyle vs Individual: a team knob of `t2` with one bot at `pro` is a
supported, first-class config (the "star AWPer" case). A team knob of `pro`
with one bot at `mix` is the "stand-in" case. Eval reports always record the
five effective profiles so a gen12 vs gen12 match at mix is not compared to
one at pro.

Implementation: `shared/sim/skill.js` maps `(S_team, S_i[], mimicFits[])` → five
profiles, then the aim motor and the policy sampler read those profiles. The
UI is two rows: one team seg, then five optional per-role segs that light up
as overrides (11.1).

---

## 9. Training: imitation, reinforcement, generations

### 9.1 Strategy in one paragraph

Behavior-clone both AIs from the demo library first, so generation 0 already moves,
buys, and executes like humans. Generation 0's Playstyle can also be the scripted
follow-until-interrupt planner (10.4), which is already a product. Then improve
by self-play PPO in the deterministic engine with a reward that starts heavily
shaped (xK training wheels, round-win potential, coach penalties) and anneals
toward pure round wins, while a KL leash to the BC policy keeps play human-shaped.
Evolution across "generations" is the league: each generation is a checkpoint
admitted to the opponent pool after passing eval gates. Retrieval and movement
mimic (10.3) cover strategy diversity long before RL discovers it.

### 9.2 Trainer runtime: two hosts, one control surface

Training runs in **Python/PyTorch** under `tools/simtrainer/`. It runs on
**artysan's PC (RTX 4090)** when the PC is on, and it is also **startable and
steerable from the /sim panel itself**, so a generation can be launched, paced,
inspected, and stopped from a browser rather than from a terminal in front of
one machine. The same is true of individual round simulations: the panel runs
them.

That is a change from the first four passes, which said prod never trains, and
it is worth being precise about what did and did not change, because the reason
for the original rule has not gone away:

| | Runs where | Why |
|---|---|---|
| **Gradient steps** | Only on a CUDA host (the 4090, or any box the trainer is pointed at) | The production server has no GPU and putting one there is not the plan |
| **Rollouts** | The 4090 by default; the prod box **may** run a bounded pool when asked | Rollouts are Node stepping the engine. The prod box can do them, it just must not do them at the expense of demo parsing |
| **Round simulations** | Either, on demand, from the panel | One match is cheap (4.1) |
| **The control surface** | Always the panel | Starting a run should not require sitting at the PC |

So the panel gains a job runner, and the constraint moves from "prod never
trains" to **"prod never starves"**: the sim's work is bounded, preemptible,
and always the lowest-priority thing on the box. The guard rails are in 9.2b,
and they are load-bearing rather than decorative, because the failure mode is
a demo library that stops ingesting while nobody notices.

The seam is thin and file-based:

- Node on the PC exports datasets/rollouts as flat binary + JSON manifests
  (library rounds can be copied, or extraction can read a local replay dir).
- Python on the 4090 trains and exports weights as JSON/fp32 blobs + norm stats.
- Copy the `models/<gen>/` folder onto the server (or into `AIM4_REPLAY_DIR/sim/`
  on the PC for local `npm run host`). The website never needs CUDA.
- Node/browser inference is the hand-rolled forward pass (6.3), so **the product
  has zero Python and zero native-ML dependencies at runtime**.

Self-play rollouts are N Node worker processes (`server/sim/rollout.js`)
stepping matches with the current policy and writing trajectories to disk; the
Python trainer watches the directory, updates weights, writes back a new
manifest; workers hot-reload. Simple, robust, resumable, no gRPC. The worker
pool is host-agnostic: the same process runs on the PC and on the prod box, and
the only difference is how many of them there are and what preempts them.

### 9.2b Running it from the panel without starving the site

The panel gains three controls and one contract. The controls are start a
generation, run a match, and stop; the contract is that everything the sim does
on the production box is bounded and yields.

| Rail | Rule |
|---|---|
| **Priority** | Sim workers run at the lowest OS priority available and are the first thing killed under memory pressure. A parse job queued while rollouts are running preempts them |
| **Concurrency** | One live match, and a rollout pool capped at `AIM4_SIM_WORKERS` (default 0 on prod, so the feature is opt-in per deployment rather than on by default) |
| **Event loop** | Never in the API process. Rollouts are child processes, so a runaway generation cannot block a request, which is the same rule 14.29 already made for the parser |
| **Budget** | A run declares a tick budget and a wall-clock ceiling up front and stops at whichever comes first. An unbounded overnight grind is exactly what the prod box must not host |
| **Resumability** | A generation is a directory of trajectory shards plus a manifest, so stopping is always safe and restarting is always cheap. Nothing lives only in memory |
| **Gradients** | Still never on prod. When no CUDA host is attached the panel can gather rollouts and queue them, and it says so rather than pretending to train |

The panel therefore shows two things that did not previously need to exist: a
**job list** (what is running, on which host, how far through its budget) and a
**host status** (is a CUDA trainer attached, how stale are its weights). Without
those, a run started from a browser is a run nobody can find again.

Jobs are `AIM4_REPLAY_DIR/sim/jobs/<id>/`, which keeps them under the same
directory 12.1 already isolates from everything users can see.

### 9.2c Reading a 2,500-demo library without reading it

The library is over 2,500 demos and growing. Nothing in this plan may ever
scan it. Not at decision time, not at round start, not at the beginning of a
generation, and not "just once" at boot, because a full pass over parsed ticks
is minutes of CPU and gigabytes of memory and it will be triggered by something
innocent looking, on the box that is also parsing demos.

The rule is simple and it applies everywhere:

**The simulation never reads demos. It reads aggregates of demos, and it reads
individual rounds only by id, a handful at a time.**

Three tiers, and every consumer in this document belongs to exactly one:

| Tier | What it is | Size | Who reads it |
|---|---|---|---|
| **Index** | The compact per-round row the site already maintains: `row.rl` library tags, econ digits, roles, positions, ratings, movement bags (`server/replays/statsIndex.js`) | Megabytes, always resident | Retrieval filters, the experience index's prior (18.3), scorecard baselines (9.17) |
| **Aggregate** | Derived tables baked once per library version: flow priors and co-occupancy signatures (5.5, 19.2), first-arrival timing tables (5.6), mined lineups (4.8), execute DAGs (19.10), per-tier metric distributions (9.17), AWP spot occupancy (19.3), cross-level transition cells (4.2) | Tens of megabytes, loaded per map | The engine, the belief, foresight, the doctrine layer |
| **Round** | One parsed round's ticks, fetched by id | ~1 MB, transient | Mimicry tapes (10.3 layer 3), the inspector, BC shard extraction |

Consequences that are easy to get wrong and expensive to discover late:

- **Aggregates are incremental, never rebuilt.** Each carries the library
  version and the set of round ids that fed it. A new demo updates the tables it
  touches; nothing recomputes from zero. This is the pattern
  `statsIndex.js` already follows, and the sim's aggregates live beside it under
  `AIM4_REPLAY_DIR/sim/aggregates/` with the same discipline.
- **Sampling is stratified, not "the first N on disk".** A BC shard or an
  evaluation set is drawn by reservoir sampling over
  `(map, side, call, tier, econ bucket)`, so a batch is representative of the
  library rather than of its filesystem order. Alphabetical order is a
  confound: it groups by team.
- **Retrieval is budgeted and by id.** Mimicry asks for k rounds matching a
  filter and gets k round ids from the index, then reads exactly those. It never
  materializes the filter's full result set. The UI already has to show the
  candidate count (14.16); that count comes from the index, not from a fetch.
- **A run declares its data budget.** A generation's manifest records how many
  rounds it read and which aggregates it used, so "we trained on the library" is
  a checkable statement rather than a hope, and two generations can be compared
  knowing whether they saw the same data.
- **Aggregate staleness is visible.** Every aggregate reports its library
  version and round count in the panel. A generation trained against a
  six-month-old flow prior is a legitimate thing to do and an illegitimate thing
  to do by accident.

The extraction jobs that build aggregates are the same job runner as everything
else (9.2b): bounded, resumable, preemptible, and startable from the panel. On
the prod box they are the lowest priority thing running; on the PC they are
whatever is convenient.

**What this buys, and it is the point of the whole section:** the sim's working
set is a few hundred megabytes of tables regardless of whether the library holds
2,500 demos or 25,000. Growth makes the aggregates better and does not make
anything slower, which is the only relationship with a growing dataset worth
having.

### 9.3 Behavior cloning (generation 0)

Dataset extraction, `scripts/sim-extract-bc.mjs`, following the
`extract-duel-episodes.mjs` house pattern:

1. Iterate library rounds (filter: competitive maps in the 7, optional pro-only
   allowlist by team names/standings, exclude synthetic).
2. Replay each round through the **knowledge tracker** (it consumes tick buffers
   the same way `teamPov` does) to build the exact observation vectors 7.2/7.3 at
   8 Hz. This is the crucial honesty trick: bots learn from what the players
   *knew*, not from god-view.
3. Derive Individual labels per player per step:
   - move.mode/target: from the future path: which named anchor the player is
     heading toward over the next 3 s (nav-graph nearest-anchor of the position
     3 s ahead); hold if displacement < 100 u.
   - gait/stance: from speed thresholds and duck flag.
   - combat.posture/focus/preAim: from shots, vision pairs, yaw vs known enemies.
   - utility: from grenade events matched to mined lineups (same clustering key).
   - objective: from plant/defuse/pickup events and flags.
   - buy: from freezetime `loadout`/`equipValue`/`money` snapshots the parser
     already records.
4. Derive Playstyle labels per team-round: call = stored round-library tag
   (`row.rl`, version 7: the library IS the label supply), roles from
   `entry.roles` maps, tempo from first-commit timing (roundTiming), buy posture
   from econ digits, rotate events from area transitions.
5. Write shards: `{obsF32[], maskU8[], labelIdx[], playerRef, mapCode, side}` to
   `AIM4_REPLAY_DIR/sim/datasets/bc-vN/`.

Scale estimate: 10,000 library rounds × 10 players × ~800 steps = 80 M individual
samples; more than enough for a 2 M-param MLP. Train/val split by *match* (never by
round) to prevent leakage.

BC training: cross-entropy per head (masked softmax), per-head loss weights
(movement 1.0, combat 1.0, utility 2.0, buy 0.5: utility is rare and precious),
label smoothing 0.05, Adam 3e-4, batch 4096, 2 to 4 epochs, early stop on val.
Player-mimic embedding (16-d, keyed by SteamID64) trained jointly (10.3).
Metrics: per-head top-1/top-3, calibration, and a behavioral eval: BC bots run 500
no-enemy rounds; the round-library matcher must tag their executed calls correctly
≥ 70% when commanded (10.1 validator).

### 9.4 Reinforcement learning (generations 1+)

- **Algorithm**: MAPPO (PPO with centralized critic, shared Individual policy,
  per-agent advantages). The critic (Python-only, never shipped) sees omniscient
  engine state; actors see only knowledge-tracker obs. The Playstyle policy trains
  in the same PPO graph with SMDP-style returns over its decision points
  (macro-actions between directives).
- **Two-timescale curriculum on the hierarchy**: phases R1/R2 freeze the Playstyle
  as the *scripted retrieval planner* (10.3) and train Individuals only: this
  removes joint non-stationarity when it hurts most. Unfreeze Playstyle in R3.
- **Hyperparameters (starting points)**: γ 0.999 (800-step horizons), GAE λ 0.95,
  clip 0.2, entropy 0.005 → 0.001, lr 1e-4, rollout 128 envs × 512 steps,
  minibatch 16 k, 4 epochs/update, value-loss clip, advantage normalization,
  **KL(π‖π_BC) coefficient 0.05 to 0.2**: the human-likeness leash, annealed but
  never to zero.
- **League** (the generations): opponent pool = {current, past checkpoints
  (uniform + prioritized by recency), BC anchor, scripted planner teams,
  exploiters trained specifically to beat the current main}. Admission to the pool
  = "a generation": must pass eval gates (9.8). This is the AlphaStar-lite recipe
  and it is what prevents strategy collapse (everyone camping) and rock-paper-
  scissors amnesia.
- **Throughput math**: engine at ~6 rounds/sec/core (4.1). On the 4090 PC,
  CPU rollouts + GPU training share one box; size Node workers so they leave
  the GPU fed, not so they starve Windows. A 16-core ceiling of ~1 to 2 M
  rounds/day is the upper bound, not a prod-server claim. Cloud burst is not
  in scope.

### 9.5 Reward design (the xK training wheels, requirement 3)

Team reward, shared by the 5 Individuals (with per-agent shaping components),
computed by the engine:

```
r_t = R_win(terminal ±1)
    + β1 · ΔΦ_round(s)                    # potential: predictRoundCalibrated for my side
    + β2 · ΔΦ_xk(s)                       # potential: Σ own predictDuel over open pairs
                                          #            minus Σ enemy predictDuel over pairs on us
    + β3 · (damage_dealt − damage_taken)/100
    + β4 · objective events (plant +0.3, defuse +0.5, afterplant hold ticks small +)
    − β5 · coach rule hits (carelessness/mechanical/quality/sync ids, small, capped/round)
    + β6 · plan adherence (executed the commanded call per library matcher), annealed to 0
    + β7 · trade events (killer contested within the trade window), annealed slowly
    + β8 · information gain (drop in team belief entropy from a scout/clear), small, annealed to 0
    − β9 · readability (the critic's log-prob of our own option from enemy-side obs, 6.9)
```

- Both Φ terms are **potential-based shaping** (reward = γΦ(s′) − Φ(s)), which
  provably does not change the optimal policy: the training wheels can be
  removed by annealing β1, β2 → 0 across generations without having taught a
  different game. This is exactly the "cheat the evolution, then take the wheels
  off" mechanic the brief asks for.
- The xK potential uses the *same* fitted duel model the site ships
  (`predictDuel` with `paramVector()`), so "bots aim to be in favorable fights,
  which on average yields more kills" falls out by construction.
- Anti-reward-hacking guards: xK potential is symmetric (their xK on us
  subtracts), so farming xK by never committing loses to the round-win and
  objective terms; possession is deliberately NOT rewarded directly (bots would
  paint the map instead of winning); coach penalties are capped so one weird
  round cannot dominate a batch; every β is logged per generation for autopsies.
- Playstyle reward: round win ± economy-aware bonus (winning a round you were
  priced out of counts extra; losing a "won" round per round-model ≥ 0.8 counts
  double negative), plus the annealed plan-adherence term while it is scripted.
- β7 (trades) is annealed slowly rather than to zero: it is the one shaping term
  that encodes a fact about CS rather than a fact about our models. β8 must
  anneal to zero or bots will scout for a living.
- The potentials Φ may read god-view engine state, because potential-based
  shaping is training-only and never reaches an actor. The *features* named in
  7.2 that look similar (belief summaries, foresight prices) must be
  belief-derived. Stating it here because the two will otherwise be written by
  the same person on the same afternoon and quietly merged.

### 9.6 Credit between hivemind and individuals

- Individuals: per-agent advantages from the centralized critic (COMA-style
  counterfactual baseline as a v2 upgrade if plain MAPPO credit is too muddy).
- Playstyle: SMDP returns between directives; its advantage is computed on the
  round/win level so it is never blamed for a whiffed flick, only for calls.
- Parameter sharing note: the 5 Individuals share weights but receive different
  role/order/mimic conditioning: population diversity comes from the league and
  mimic profiles, not from 5 divergent networks (which would quintuple sample
  cost for no strategic gain).

### 9.7 Curriculum

| Stage | Content | Gate to next |
|---|---|---|
| C0 | Movement only, no enemies: follow real-team tapes and execute library calls | ≥ 90% call-validator pass; mimic follow error vs frozen world meets 10.4 (< 60 u median / 20 s) |
| C1 | 1v1 arena duels, all weapon classes | aim gates (8.3) green |
| C2 | 2v2 site micro (retakes, afterplants, trades) | trade rate and untraded-death rate within pro bands |
| C3 | 5v5 single rounds, fixed full-buy economy | > 55% vs BC anchor both sides |
| C4 | Full MR12 matches with economy | buy-decision sanity evals (no full-buy at $2,000), > 55% vs C3 champion |
| C5 | League forever | generation gates (9.8) |

### 9.8 Evaluation and generation gates (`scripts/sim-eval.mjs`)

A checkpoint becomes **generation N** only if all pass:

1. Elo vs pool: ≥ +25 vs previous generation over 400 matches (paired seeds:
   same seeds, sides swapped, to slash variance).
2. Aim gates: 8.3 distributions inside pro envelope. Hard fail otherwise.
3. Human-likeness: KS distance vs demo baselines on speed histograms, TTD,
   engagement ranges, rounds-with-zero-contact rate; coach `carelessness` rate
   not above 1.5× pro baseline.
4. Strategy diversity: entropy of executed call distribution per map above
   floor (no mono-strat collapse), measured with `z` sampled from the library
   (9.11); win rate as T and CT both within [35%, 65%] band on each map
   (detects degenerate side camping). Note what this gate is and is not: it
   detects *collapse*, never divergence from what pros prefer. A generation is
   free to like a formation the library rarely runs, because the meta is
   expected to move (6.22) and a band around the demo window would freeze it.
5. Determinism smoke: same seed re-run bit-identical.
6. **Surprise band** (6.9, two-sided): off-angle rate, smoke-cross rate,
   molly-cross rate, dry-entry rate, first-contact-spot entropy, and the pfw/pfo
   distribution of fights taken, each inside the library's own band for that map
   and side. Too tidy fails; too chaotic fails. This band is about *texture*,
   not about strategy: it catches bots that never do anything unusual and bots
   that do nothing else, and it deliberately says nothing about which calls a
   generation prefers.
7. **Team play**: trade rate and untraded-death rate inside pro bands (the C2
   gate, promoted to a generation gate), crossfire score of CT setups above the
   BC anchor, `spacing` coach-rule rate not above 1.5× pro baseline.
8. **Belief quality**: particle-filter KL against the truth beats the flow-prior
   baseline. A generation whose bots are winning while believing nonsense is
   winning by exploiting the engine.
9. **Exploitability** (9.12): a fixed-budget fresh exploiter must not beat the
   candidate above a set win rate.

All eval artifacts (matches) are stored as watchable sim rounds: every number in
the report links to rounds, the same philosophy the antistrat reports follow.

### 9.9 Model registry

`AIM4_REPLAY_DIR/sim/models/<gen>/manifest.json`:

```jsonc
{ "gen": 12, "parent": 11, "createdAt": "...", "phase": "C5",
  "individual": { "arch": "mlp512x2", "weights": "individual.bin", "norm": "norm.json" },
  "playstyle":  { "arch": "attn256",  "weights": "playstyle.bin" },
  "strategy":   { "arch": "mlp128x2", "weights": "strategy.bin", "keyVersion": 1 },
  "aimProfiles": "aim.json", "trainedSteps": 1.2e9, "league": ["gen11","gen9","bc0"],
  "genome": { "beta": [1.0, 0.6, 0.2, 1.0, 0.4, 0.0, 0.3, 0.0, 0.5],
              "tau": 0.85, "klCoef": 0.08, "entropy": 0.002, "traitPriors": "…" },
  "experience": { "lineage": "main", "rounds": 2.4e6, "hash": "sha256:…" },
  "evals": { "eloVsPrev": 31, "aimGates": "pass", "callEntropy": 2.4,
             "scorecard": "evals/12/scorecard.json", "worstAxis": "macro",
             "tier": { "INF": "top30", "MRG": "top10", "…": "…" },
             "exams": { "E2regret": 0.031, "E10delta": 0.09 },
             "exploiterWinRate": 0.54 } }
```

Follows the champions/`runtimeParams.js` philosophy: fitted weights are versioned
data the server loads, the admin can inspect, and the UI can pick per match
("Gen 12 vs Gen 8").

### 9.10 Team spirit: anneal from selfish to selfless

Sharing one team reward across five agents from step one is the classic way to
get a policy that learns nothing for a very long time: the credit signal for "I
positioned well" is buried under four teammates' outcomes. OpenAI Five solved
this with a **team spirit** parameter τ (17): each agent optimizes
`(1 - τ) · own reward + τ · team mean`, with τ annealed from about 0.3 to 1.0
across training. Adopt it verbatim. Early generations learn to fight and survive;
late generations learn to die for a trade. Log τ per generation in the manifest,
because a gen trained at τ = 0.4 is not comparable to one at τ = 1.

### 9.11 Strategy statistics: condition on z, do not hope for diversity

AlphaStar's trick for keeping strategic variety alive under self-play was to
condition the policy on a statistic `z` extracted from a human replay (its build
order and units), sample `z` from the human dataset during training, and let the
policy specialize. Diversity stops being something you pray for and becomes an
input.

Ours is a natural fit because the round library already *is* the statistic:
`z = (round-library call, utility signature, first-commit timing bucket, spawn
shape, lurk presence)`, extracted per round by the same code that produces BC
labels (9.3). Effects:

- Training samples `z` from the library, so the league cannot collapse to one
  call: a policy that ignores `z` scores badly on the adherence term for every
  `z` but one.
- At play time `z` is a **control**: the /sim setup panel's "starting command"
  becomes a full strategy statistic rather than a single enum, and "run this
  round the way Spirit runs it" is a vector, not a tape (which is the fuzzy
  middle ground between 10.3's layer 2 and layer 3 that the mimicry section
  currently lacks).
- The call-entropy gate in 9.8 gets teeth: it is measured with `z` sampled from
  the library's own distribution.

### 9.12 The league, spelled out as three populations

9.4 says "league" and lists exploiters as an afterthought. The version that
actually prevented collapse in StarCraft has three roles, and it is worth copying
exactly:

| Population | Trains against | Purpose |
|---|---|---|
| **Main agents** | PFSP over the whole pool, plus 35% self-play | The champions. These are the generations |
| **Main exploiters** | The current main agent only | Find its holes; reset to BC when they succeed or after a budget |
| **League exploiters** | PFSP over the whole pool | Find holes in the pool as a whole, so old weaknesses do not come back |

PFSP samples an opponent with probability proportional to `f(P(win against it))`
with `f` favoring hard-but-beatable (`f(x) = (1 - x)^p`, p around 2). Exploiters
are admitted to the pool but never shipped. A main agent's admission to
generation N still requires the 9.8 gates.

Add one gate: **exploitability**. Train a fresh exploiter against the candidate
champion for a fixed budget and report its win rate. A champion that a two-hour
exploiter beats 80% of the time is fragile no matter what its Elo says, and this
is the only metric that catches "we learned one strategy really well".

### 9.13 Expert iteration: distill the search

Where 6.11's search runs, its choice is a better action than the policy's. Store
`(observation, mask, search distribution)` from live matches and eval runs, and
add a cross-entropy term against the search distribution to the next generation's
loss. AlphaZero's loop, scaled down: search is expensive and rare, so it acts as a
slow teacher rather than the data source. The same store doubles as the human
review queue: any decision where search and policy strongly disagree is exactly
what artysan should be shown in the inspector.

### 9.14 Auxiliary heads

Small nets learn big games faster when they are forced to represent the right
things. All of these are training-only losses on the shared torso, all free at
inference (the heads can be dropped from the exported weights):

| Head | Label source | Why |
|---|---|---|
| Belief value | Round outcome | A learned P(win) from *belief* observations. Eventually replaces `predictRoundCalibrated` as the foresight leaf evaluator, because the fitted one reads god-view features |
| Enemy belief | The enemy team's true tracker at training time | Fakes, 6.10 |
| Exposure | The true `infoAdvantageSeconds` | Replaces the fixed estimator in 5.6 |
| Enemy position | True enemy positions | The classic auxiliary that teaches a torso to actually use its percepts |
| Readability critic | Our own next option, from enemy-side obs | Adversarial, 6.9. Trained with a gradient-reversal or as a separate net whose log-prob is a cost |
| Time to contact | Engine ground truth | Timing (5.6) |

### 9.15 What changes in the curriculum

Insert two stages into 9.7, both before C3, because both are where off-script
behavior is actually learnable in isolation:

| Stage | Content | Gate to next |
|---|---|---|
| **C1b** | Neutral game: 1v1 standoffs at a fixed pair of angles, no objective, clock only. Teaches peek timing, jiggling, repeeks, resets | Peek-style distribution and first-contact crosshair offsets within pro bands |
| **C2b** | Information game: 3v3 with no contact allowed until 20 s, then a forced objective. Teaches clearing, scouting, sound discipline, and belief maintenance | Belief accuracy (KL of the particle filter against truth) beats the flow-prior baseline by a set margin |

### 9.16 Grading: Elo is a ranking, not a skill level

9.8 gates a generation mostly against its own parents. That is enough to detect
regression and nothing else. A league of bad bots produces a champion with a
beautiful Elo, and every number in that league is measured in units of itself. If
the target is "tier 1 professional", the grade has to be anchored to something
outside the population, and the plan has exactly three anchors available:

| Anchor | What it is | What it can prove | What it cannot |
|---|---|---|---|
| **The pro library** | Thousands of real rounds with every metric the site already computes | That the bots' *play* falls inside, or above, the distribution real pros produce | That they would beat a pro team. Metrics are opponent-relative |
| **Frozen references** | The BC anchor (cloned from pros, never retrained), the scripted desire planner (6.17), and a fixed handicap ladder | Absolute progress on a scale that does not move under us | Anything about strategies invented after they were frozen |
| **Solved positions** | The late-round tablebase (18.7) and the exam suite (9.19) | Exact regret against optimal play, with no population involved at all | Anything about the open, early round |

None of the three is sufficient and all three are cheap, so the grade is all
three, and they are reported separately rather than blended into one number that
hides which one failed. The honest sentence, written here so nobody has to
discover it in month four: **we can never play a real tier-1 team, so "tier 1"
will always be a classification of how the bots play plus a demonstration of how
hard they are to beat, never a head-to-head result.** The mimic teams (10.3) are
the closest available, and a tape that cannot adapt is a floor test, not a proof.

One more trap worth naming. Several 9.8 gates reward *human-likeness*, and
human-likeness is trivially maximizable by being mediocre in a normal-looking
way. Strength gates and likeness gates therefore live on different axes of the
verdict (9.18) and a generation must pass both; neither may be traded for the
other.

### 9.17 The pro percentile scorecard (`scripts/sim-scorecard.mjs`)

Every metric below already exists in this repo, computed by code that runs on
real demos today. That is the whole trick: a sim round is a round nobody had to
play (1), so the site's own analysis stack grades sim rounds and pro rounds with
the same functions, and a percentile against the pro population is a two-line
comparison rather than a research project.

`scripts/sim-baselines.mjs` mines the population once per library version: for
every pro team-map in the library it produces the same metric bag, so each metric
has a distribution (per map, per side, and per role where the metric is a player
metric). The scorecard then places the candidate generation inside it.

| Axis | Metrics (source in repo) | Kind |
|---|---|---|
| **Mechanics** | Time to damage, first-shot crosshair offset, spray discipline, headshot rate (`shared/aimMetrics.js`, `coach/shotMistakes.js`) | Compliance band, not a growth axis: mechanics are set by the aim model (8), so this axis exists to prove the cap was honored |
| **Duel selection** | Mean `predictDuel` PFW of fights *taken*, PFO (`duels/duelStats.js`), share of fights entered with `infoAdvantageSeconds > 0` (`visionState.js`), opening-duel attempt rate, `expectedKillsAt` realized vs predicted (`coach/duelMistakes.js`) | Performance percentile |
| **Utility** | Utility damage per round, flash assists, smokes that actually block a sightline someone tried to use (`coach/coachSmokes.js`), lineups per site take vs the mined pro set, utility unspent at round end, molly denial seconds (`coach/utilityMistakes.js`) | Performance percentile + coverage band |
| **Teamwork** | Trade rate and untraded-death rate, core integrity and unearned-lurk rate (6.18), contract compliance per role (6.19), execute synchronization spread (`coach/siteExecute.js`), crossfire score, `synchronization` coach category rate | Performance percentile |
| **Macro** | Advantages created vs advantages choked (`stats/prwEnrich.js` `aca`/`ack`), PRW conversion curve (win rate in each `predictRoundCalibrated` bucket vs the pro curve), rotation timing (`late-rotation` / `early-rotation` rule rates), possession shares (`mapControlAdvantage.js`), save and force-buy outcomes, call entropy and in-match adaptation | Performance percentile |
| **Information** | Particle-filter KL against truth, deaths to enemies the bot had no belief mass on, exposure spent per unit of space taken (5.6), unnecessary-exposure rate | Performance percentile |
| **Objective** | Plant rate given a site take, time-to-plant distribution, afterplant hold rate, retake success rate by man-count, defuse conversion | Performance percentile |
| **Discipline** | The four coach categories (`carelessness`, `mechanical`, `quality`, `synchronization`) as rates per round, plus `praise` rate | Band: below the pro floor is as suspicious as above the ceiling |
| **Doctrine** | One metric per chapter of the doctrine document (20.15): bomb-in-Safe seconds, layer skips, utility purpose compliance, Level 2 emission rate, block timings, ledger positions at 0:50 and 0:30, zone-ownership violations, isolated duels conceded at +2, and the rest | Compliance percentile where the chapter has a direction, band membership where it does not. **Graded on a separate axis from strength and never blended with it** (9.16): a compliant team that loses is a finding about the doctrine, and that result must be obtainable |

Scoring rules, all of them chosen to resist the obvious cheats:

1. **Percentile, not raw value.** Every performance metric becomes the
   candidate's percentile within the pro population for that map, side, and role.
   Percentiles are comparable across metrics with wildly different units, which
   is the only way an axis score means anything.
2. **Style metrics score by band membership, not by more-is-better.** Aggression,
   engagement range, lurk rate, and tempo have no good direction. They score 1
   inside the pro band, and fall off with distance outside it. This is the
   surprise band from 9.8 generalized to every stylistic quantity.
3. **The axis score is the median of its metrics; the overall score is the
   worst axis, not the mean.** A generation is as good as the thing it is worst
   at. Averaging is how a mechanically perfect bot with no macro brain reports a
   respectable grade, and that bot is precisely the failure mode this whole
   document exists to avoid. Use a soft minimum (the 20th percentile of the axis
   scores) so a single noisy metric cannot torch a report.
4. **Everything is reported per map and per side.** "Good at CS" is not a
   quantity. Inferno CT and Mirage T are different games and a generation
   routinely lands two tiers apart on them.
5. **The opponent is held fixed and stated.** All scorecard matches are played
   against the frozen reference set, never against the candidate's own siblings,
   because metrics measured against a shifting opponent are not a time series.
   The confound is admitted in the report: pro metrics were produced against pro
   opponents, ours against the reference set, and the difference is estimated by
   also scoring the BC anchor (whose real-demo metrics we know) through the same
   pipeline and reporting the shift as a correction term.

Two scorecards are produced, not one: a **team** scorecard, and a **per-bot**
scorecard by role, because "the team's trade rate is fine" routinely hides one
bot who never trades anyone.

### 9.18 The tier verdict

The library's teams are not equally good, and the site already knows which is
which from standings. Bucket the pro population into tiers (top 10, top 30,
tier 2, the rest), compute the baseline distributions per tier, and then the
verdict is a **classification**: which tier's distribution best explains this
candidate's scorecard, per map and per side. A nearest-centroid in percentile
space with a likelihood ratio is enough; the number of metrics is small and the
populations are large.

The generation report ends with four verdicts, deliberately not merged:

| Verdict | Question | Source |
|---|---|---|
| **Strength** | Does it beat what came before? | Elo vs the pool, paired seeds (9.8) |
| **Quality** | Does it play like a team of a given tier? | Tier classification of the scorecard (9.17) |
| **Honesty** | Is it winning by playing CS, or by exploiting our engine? | Belief quality, aim gates, human-likeness KS, coach rates, determinism |
| **Robustness** | Does it survive being targeted? | Fresh exploiter win rate (9.12), exam regret (9.19) |

Tier 1 is reached, operationally, when: the tier classification is top-10 on at
least five of the seven maps on both sides; no axis on any map falls below the
top-30 band; a fixed-budget fresh exploiter cannot exceed 60% against it; exam
regret against the tablebase is under a set threshold; and every honesty gate is
green. That is a demanding and *falsifiable* definition, and it is the same
standard the site's analytics apply to real teams, which is the strongest claim
available to anyone who cannot book a match against a real team.

### 9.19 Certification exams (`scripts/sim-exams.mjs`)

Elo takes 400 matches to move and tells you nothing about why. The exams are a
fixed, deterministic, cheap battery run at every checkpoint. Each is a scenario
with a seeded start state and a scalar score, and every one of them is
diagnostic: when a generation regresses, the exam curve says where.

| Exam | Setup | Scored on | Pass band from |
|---|---|---|---|
| E1 Aim | Static and moving targets, all classes | 8.3 distributions | Real demo aim metrics |
| E2 Solved endings | Sampled states from the late-round tablebase (18.7) | Mean regret vs the exact optimal action | 0 by construction |
| E3 Retake | 3v2 with kit, 25 s on the clock, six site variants | Retake success rate | Library retakes in the same state |
| E4 Afterplant | 2v2 post-plant, bomb down, must not overpeek | dPRW lost per second, hold rate | Library afterplants |
| E5 Economy | Eco vs full buy, and the following two rounds | Damage traded per dollar, save discipline, round-3 equip value | Library eco rounds |
| E6 Utility | Commanded site take with full utility | Coverage of the sightlines pros actually smoke, waste rate | Mined lineup sets |
| E7 Information | One hidden enemy, must locate without dying | Seconds to locate, belief KL, deaths | Library equivalents |
| E8 Clutch | 1v3, 40 s, bomb down | Win rate and time usage | Library 1v3s |
| E9 Contract | Directive with no enemies present | Role contract compliance (6.19) | Pro compliance per role |
| **E10 Memory** | The same opponent runs the same call ten times in a row | Win rate on trials 6 to 10 minus win rate on trials 1 to 5 | Must be strictly positive |
| **E11 Degraded execute** | Commanded site take with one grenade removed at random (19.10) | Site-take rate drop versus the library's drop under the same degradation | Library executes missing the same resource |
| **E12 The AWP read** | An AWP in one of six sniper-quality spots, unknown (19.3) | Seconds to locate, deaths to it, and whether `awpThreat`'s argmax matched the truth before contact | Library equivalents `[mine the comparable set]` |
| **E13 The sacrifice** | 4v1 site take against an AWP (19.9) | Traded-entry rate and site-take rate | Library 4v1 site takes `[mine the comparable set]` |
| **E14 Understanding** | An unseen execute, with whatever utility the team happens to hold (20.13) | Assignment quality versus the nearest library cases | Pro assignments in comparable states |
| **E15 Doctrine** | The scenarios behind each doctrine chapter's rules, as fixed seeded states (20.15) | Per-chapter compliance | The doctrine document, and the library where it can adjudicate |

E10 is the important one and it is new. It is the only test in this document
that fails if the experience layer (18) does not work, and it is the direct,
falsifiable form of the claim that a bot with more rounds behind it is better
than an identical bot without them. A generation whose E10 delta is zero has a
strategy brain that is decorative, whatever its Elo says.

Exams are also the fastest possible regression suite: they run in minutes, not
hours, so they gate every checkpoint while the full scorecard gates only
generations.

### 9.20 Evolution: two loops, gradients inside, selection outside

"Evolution" in this plan is not a metaphor for training. There are two loops
with different objects, different timescales, and different failure modes, and
conflating them is why most self-play projects plateau.

| | Inner loop | Outer loop |
|---|---|---|
| Object | Network weights | The genome: reward coefficients β1 to β9, team spirit τ, KL leash, entropy, learning rate, γ, trait priors (6.16), `z` sampling distribution, curriculum stage |
| Mechanism | MAPPO gradients (9.4) | Selection, copying, and mutation across a population (9.21), plus league admission (9.12) |
| Timescale | Minutes | Hours to days |
| Fitness | The PPO objective | The scorecard composite (9.17), which is not the same thing and must not be |
| Failure | Collapse to a local strategy | Optimizing the proxy |

The critical rule: **the outer loop's fitness is the scorecard, not the reward.**
If selection is run on episode return, the population evolves to exploit the
shaping terms, which is the reward-hacking failure with extra steps and a
population to spread it. Selecting on an external grade that the agents cannot
influence except by playing better is the entire defense.

A **generation** is still what 9.9 says: a checkpoint that passed the gates and
entered the league. What is added here is that a generation now also carries its
genome and its scorecard in the manifest, so the history of the project is a
readable record of what the bots were optimizing when they got better, which is
the thing that is always lost and always wanted six months later.

### 9.21 Population-based training over rewards and traits

Run K = 8 agents concurrently on the box, each with its own genome. Every T
environment steps (start with 20 M), rank them by scorecard composite; the bottom
quartile copies weights and genome from a uniformly sampled member of the top
quartile, then perturbs the genome (each continuous gene multiplied by 0.8 or
1.25 with probability 0.25, each discrete gene resampled with probability 0.1).
This is DeepMind's PBT, and its most relevant precedent is the Quake III CTF
agents, where the population evolved not just hyperparameters but the agents'
*internal reward signals*, discovering shaping terms nobody wrote. That is
exactly what β1 to β9 are, and hand-tuning nine coefficients across a curriculum
is a job nobody should be given.

Constraints that keep it honest:

- Genes that exist to enforce honesty are **not** evolvable. The KL leash floor,
  the aim caps (8.3), and the surprise band are fixed by hand. A population
  allowed to evolve its own leash evolves the leash away on the first cycle.
- τ (team spirit) is evolvable but floor-annealed: PBT may schedule it faster
  than the hand schedule, never slower than the floor.
- Eight agents at once is a real cost on one 4090. If throughput does not allow
  it, run K = 4 with a longer T; PBT degrades gracefully with population size in
  a way that most of this document's other machinery does not.

### 9.22 The behavior archive: a gene pool, not a ladder

A league keeps old champions around. It does not keep *different* champions
around, and a pool of ten checkpoints that all play the same way is a pool of
one. Borrow the quality-diversity idea (MAP-Elites): maintain an archive indexed
by **behavior descriptors** rather than by strength, and keep the strongest agent
found in each cell.

Descriptors, four to six of them, discretized coarsely (five buckets each), all
already computed by the scorecard:

`tempo` (first-commit timing), `utilRate` (lineups per round), `sitePreference`
(A/B split as T, stack tendency as CT), `lurkRate`, `engagementRange`, and
`aggression` (share of duels initiated).

What the archive buys, in order of value:

1. **The opponent pool becomes genuinely varied.** PFSP sampling over an archive
   of behaviorally distinct elites is a much harder league than PFSP over a
   lineage, and hardness of the league is the only thing that has ever produced
   robust self-play agents.
2. **Strategy diversity stops being a gate we fear.** 9.8's call-entropy gate
   currently just detects collapse. With an archive, diversity is maintained by
   construction: an agent that collapses to one style occupies one cell and the
   other cells keep their occupants.
3. **The /sim page gets a roster.** "Play against an aggressive, low-utility
   Gen 12" is a dropdown over archive cells, which is a better product than a
   list of generation numbers, and it costs nothing extra.
4. **Recovery from a bad generation is instant.** If gen 19 is a dead end, the
   archive still holds every distinct thing gen 18 could do.

This composes with `z` conditioning (9.11) rather than competing: `z` produces
diversity *within* one policy from the human library, the archive produces
diversity *across* policies from self-play. Both are needed, because `z` cannot
invent a style the library does not contain and the archive cannot invent one
that self-play never stumbles into.

### 9.23 Where each kind of skill actually comes from

The brief's framing is exactly right: CS2's bots are architecturally interesting
and competitively worthless. Their navigation, hiding-spot analysis, and
encounter ordering (17.1) are genuinely good and we take all of it. Their
skill is bad *on purpose*: `bot_difficulty` handicaps reaction time and forces
deliberate misses, and their decision layer is a small finite state machine from
2004. We remove the handicaps entirely and replace both ends of the stack.

The reason this is achievable, and the single most load-bearing claim in the
training plan: **most of what people mean by "skill" is not learned here at
all.** It is fitted, mined, or baked, and only decision quality is left for RL.

| Capability | Where it comes from | Explicitly not from |
|---|---|---|
| Aim and recoil | The calibrated aim motor (8), fitted to real pro `aimMetrics` and capped at the pro envelope | RL. A policy that has to discover mouse control burns its entire sample budget on it |
| Movement quality | Source movement in the translator plus BC on real player tracks | RL |
| Pathing and angle clearing order | Baked nav plus CS-style spot analysis and spot encounters (4.2, 17.1) | RL |
| Utility execution | Mined lineups: the throw is exact by construction, because it was thrown by a pro | RL, physics |
| Utility selection and timing | Desire pricing plus RL | Mining, which knows the throw but not the moment |
| Angle and duel selection | Foresight pricing (6.7) plus RL | Hand rules |
| Timing and information edges | Particle filter, exposure, earliest-occupy tables | RL |
| Trades and spacing | Contracts, cores, shape, plus the trade shaping term with team spirit annealing | Hope |
| Round calls | Playstyle RL over library `z` | Scripts, past generation 0 |
| Adaptation inside a match | Opponent model and EXP3 (6.10) | RL |
| Adaptation across matches | The experience index and Strategy AI (18) | RL |

Read the right-hand column as the budget. What RL has to produce is *when to
peek, where to be, what to throw, and what to call*. That is a small enough
target for a 2 M-parameter policy and a home GPU. "Learn Counter-Strike from
pixels" is not, and is not being attempted.

### 9.24 The road to tier 1, with the uncertainty left in

| Generations | Stage | What is being bought | Expected tier verdict |
|---|---|---|---|
| G0 | BC on the library | Human-shaped movement, buys, and executes. Macro-naive, loses to its own scripted planner | Below tier 2 on quality, near the pro band on mechanics only |
| G1 to G3 | C1, C1b, C2 | Duel selection, peek timing, trade micro | Duel-selection axis reaches tier 2 |
| G4 to G8 | C2b, C3 | Information game, 5v5 shape, contract compliance | Teamwork and information axes reach tier 2 |
| G9 to G15 | C4 | Economy, full matches, save and force discipline | Macro axis stops being the worst axis |
| G16 to G30 | C5 league, PBT, archive | Robustness, diversity, exploiter resistance | Top-30 classification on the strongest maps |
| G30+ | League plus the experience layer switched on | Cross-match adaptation, E10 delta, opponent-specific play | Top-10 classification per map, one map at a time |

Wall-clock honesty: at the 9.4 throughput ceiling of roughly 1 to 2 M rounds per
day on one box, and 20 to 100 M rounds per generation depending on stage, a
generation is days rather than hours, and the table above is months of continuous
training, not a sprint. The three things that will actually determine whether it
gets there are, in order: whether the engine's fidelity holds up under a policy
optimizing against it (14), whether the reward can survive PBT without hacking,
and whether the experience layer delivers a real E10 delta. Everything else is
throughput.

Three gates are added to 9.8, and they are the ones a generation should be
allowed to fail without shame but never allowed to skip:

10. **Scorecard**: no axis below the previous generation's axis score by more
    than noise, on any map. Regression on one axis while Elo rises is the
    signature of a strategy that traded a skill for a trick.
11. **Exams**: E1 to E9 within band, and E10 strictly positive from the first
    generation that ships the experience layer.
12. **Contract compliance**: per-role compliance inside the pro band (6.19). A
    generation that abandoned roles to win is not the product being built.

Three more arrive with the visualization and doctrine layers, and the first is a
hard fail rather than a band:

13. **Belief calibration** (19.12): `countDist` reliability by Brier and ECE,
    with `pEmpty(site)` reported separately. A generation whose belief is
    confidently wrong is winning by exploiting the engine, which gate 8 already
    says and could not previously measure.
14. **Commitment texture** (19.12), two-sided: how many angles the first entry
    pre-aims, against the library's own distribution. Never committing and
    always committing both fail.
15. **Doctrine axis** (20.15): inside band, and reported separately from
    strength. A generation is allowed to fall below it deliberately once
    deviation licences exist (20.14), but only if the licence ledger explains
    which rules it outgrew and shows the record that earned it.

---

## 10. Commands, following, interrupts, and mimicry

The default life of a round, in one sentence: **pick spawns, start the plan,
run it until something happens, then either the bots who were hit or the
whole team make a new plan.**

That is true whether the plan came from a round-library call, from a mimicked
team's actual demo tracks, or from the Playstyle AI itself. The machinery is
the same. Only the source of the tape changes.

### 10.1 Commands: the round library as an order language (requirement 1)

- The /sim UI offers the map's round-library calls (T and CT vocabularies from
  `roundLibrary.js`) plus `default` as the starting command; the Playstyle AI is
  *conditioned* on it (its call head is forced for round 1 of the plan, free
  afterwards under trigger rules).
- Execution templates come from retrieval (10.3): real rounds tagged with that
  call supply per-role **movement tracks** (not just named anchors) the
  translator follows, so a commanded "A Execute" looks like actual A executes,
  not an abstract rush.
- **Validator**: after the round, run `classifyRoundTypes` on the encoded sim
  round; if the commanded call's matcher does not tag it, the command was not
  executed. This closes the loop with zero new judgment code and doubles as a BC
  metric, an RL adherence reward (annealed), and a CI test. The validator is
  only fair up to the first team interrupt: after a replan the round is allowed
  to become a different call.
- Stratbook future hook: the 2D creator's recording format (tracks of samples) is
  convertible into the same template shape, so "bots run your stratbook entry"
  is a natural later feature; noted, not in scope for v1.

### 10.2 Interrupts: local (affected bots) vs team (hivemind)

`shared/sim/interrupts.js` classifies every notable event as `ignore`, `local`,
or `team`. This is the difference between "the banana player got peeked, he
fights, the A execute continues" and "two dead plus a smoke, abort B." Getting
this taxonomy wrong is how you either freeze five bots on a dead tape or
replan every footstep.

**Ignore** (the tape keeps rolling for everyone):

- Distant gunfire on the other side of the map that the plan already expected
  (a retrieved template that includes a lurk contact).
- Own-team utility detonations that were on the tape.
- Clock ticks, bomb beeps after we planted, freeze ending.

**Local** (only the affected bot(s) leave FOLLOW and the Individual AI takes
their movement; everyone else stays on the tape):

- That bot takes damage.
- That bot gets a vision contact that is *actionable* (enemy in their 53° cone,
  LOS clear) and the tape did not have them shooting at this clock ±1 s.
- That bot's path is personally blocked (molly at feet, smoke they would have
  to walk through with xK < threshold).
- That bot wins a duel the tape did not contain (they now have a new job:
  trade, lurk, or wait for orders).
- Follow error: geodesic distance to the tape > 180 u for > 1.5 s (stuck on
  geometry, or they counter-strafed late).
- That bot dies: they are gone; this is also a candidate for promote-to-team
  (below). One death is local by default. The remaining four keep executing.

While a bot is locally autonomous they keep the last TeamDirective as *advice*
(role, anchor, call) but their movement head is unmasked. They can rejoin
FOLLOW if they get back within 80 u of the tape and no enemy is in cone: a
"re-sync" window of 2 s, once. After that they stay autonomous until a team
replan. Re-sync exists so a jiggle peek that won a fight can return to the
execute. It is not a second brain.

**Team** (Playstyle AI fires, new TeamDirective, all living bots drop the old
tape and take new orders, typically `autonomous` under the new call):

- Two or more deaths on this side, or the AWPer dies in the first 40 s.
- Three or more bots already locally broken (the execute has dissolved even
  if the call has not been formally cancelled).
- First contact at a site the plan was not hitting (T defaulting mid, CT
  hears a B hit while stacked A).
- Utility that invalidates the execute for the pack, not one body: a smoke
  wall across the rush path, a molly on the plant spot the tape was walking
  onto. The B-rush example lives here: 2 dead + banana smoked + xK through
  the smoke ≈ 0.1 → team replan, not "the remaining three keep running in."
- Bomb events the plan did not own (they planted against us; we planted off
  tape).
- Execute window missed (tape clock is 20 s ahead of the bots, or live clock
  past the call's typical first-commit from `roundTiming`).
- Afterplant: the moment the bomb goes down, always a team step (hold vs hunt
  is a money decision, 4.9).
- Playstyle trigger from the directive (`deaths>=2`, `site_contact(B)`, …).
- Heartbeat promote: the 5 s tick may raise a team replan if local breaks
  plus round-model win-prob say the current call is dead.

The B-rush abort, mapped onto this:

1. Tape is a retrieved B rush. Spawns were chosen to match it (4.12).
2. First death on banana: **local**. The dead bot is gone. Four still rush.
3. Second death, and a CT smoke lands on the remaining path: **team**. xK of
   walking through that smoke is computed with `predictDuel` under blocked
   LOS (the brief's 0.1). `commit` is masked unless the new directive forces
   it. Playstyle sees 3 alive, B blocked, maybe a contact A-side, and emits
   a new call (`fake-a`, `b-split-late`, `save`).
4. Survivors path under the new orders. They do not try to re-sync to the
   dead B-rush tape.

xK is a prior, not a cage: the mask relaxes when the directive is `commit`
(last seconds, bomb down, man-up). The policy learns which 0.1-xK pushes pay.
Save logic: round-model win-prob below threshold with alive-value math
(weapon prices vs next-round buy, including the explode-vs-elim $250 gap)
exposes a `save` task.

**Superseded by pricing (6.7).** The `xK < 0.1` gate above is the v1 fallback for
when foresight is budget-skipped. The real comparison is dPRW(cross) against
dPRW(wait) and dPRW(reroute), which is what makes the same three survivors cross
that smoke at 0:22 and refuse at 1:40 without a second rule being written. Read
10.2 as the interrupt *taxonomy*; read 6.7 as what the bot does once it is
interrupted.

IF a local fight is actually the opening of a site hit the other four need
to know about: the local bot's contact is written onto the team blackboard
(5.1, vision is already shared). The *movement* of the other four does not
change until a team interrupt fires. That is the honest CS radar version of
"I heard banana fighting, I am still walking toward A until someone calls."
The 0.5 to 1.5 s comm delay (5.1) is how fast that blackboard update reaches
bots who did not see the fight. It does not change the local vs team split.

IF the other side is also on a tape (ghost both-sides, 10.3): the first
kill that does not happen at the recorded clock ±0.5 s is a team interrupt
for **both** sides, otherwise you are watching a demo with extra steps.

### 10.3 Mimicry: copy a team's actual movement (requirements 3 and 5)

**This is the product, not a feature of it.** Everything else in this document
exists so that a team can scrim against a credible version of the team they are
about to play. A generic tier-1 bot is impressive; a bot side that plays the way
your next opponent plays, down to which player clears which angle first, is the
thing worth pitching. Read the rest of this section with that ordering in mind:
when mimicry fidelity and some other goal conflict, mimicry wins.

Four layers, used together. Layer 4 is new and it is where the pitch actually
lives.

1. **Conditioning** (fuzzy, always on). The 16-d player embedding from BC
   (9.3). Setting a bot to a SteamID64 biases tempo, aggression, utility
   habits, and the aim profile (8.2), clamped to the pro envelope. This is
   "play a bit like donk." It does not copy a round.
2. **Retrieval of a call** (named-anchor timeline). Given (map, side, call,
   optional team), query `row.rl` tags, take 2 to 3 rounds, extract per-role
   anchors via `roundFacts`. This is how a commanded "A Execute" gets a
   human shape when you did not pick a specific match. The AWPing-CT-peeks-
   banana example: retrieve rounds where the CT AWPer is on `banana_car` at
   1:45, read where the other four stood, order the team accordingly, and
   **choose the spawns** that make that peek geometrically possible (4.12).
3. **Movement mimic of a specific team's rounds** (the tape). This is the
   product feature. Pick a team (and optionally a match, a map, a call).
   The sim loads one real round from the library, role-aligns their five
   players onto our five bots using the existing roles module, **picks
   spawns** that minimize distance to those players' freeze-end positions,
   and puts every bot in `task: follow` with `trackSlot` pointing at that
   player's tick track. From live start, `trackFollow.js` copies their
   movement: position, yaw, gait, when they stop, when they swing. Utility
   on the tape is thrown at the recorded clock if the bot is within 48 u of
   the recorded throw origin; if they are not, that nade is skipped and
   logged (we do not teleport a smoke). Combat is **not** copied. The other
   team is not the original opponent. Our aim motor fights whoever is
   actually there. The tape runs until an interrupt (10.2, 10.4).
4. **Behavioral mimicry of individual players** (the part that survives the
   interrupt). A tape stops predicting the moment the round goes off script,
   which is exactly when the practice value starts. What should carry on is not
   the path but the *habits*, mined per player from every round of theirs the
   library holds:

| Mined per player | From | Feeds |
|---|---|---|
| **Angle clearing order**: which of a corridor's `SpotEncounter` entries they check, in what order, and which they habitually skip | Their yaw track against the baked spot-encounter lists (6.8) | The clearing controller's ordering, so a bot skips the same angle this player always skips |
| **Peek style**: wide swing vs shoulder vs jiggle, how long they hold before repeeking, whether they reset or recommit after a miss | Movement and yaw around known duel starts | The peek option's parameters (6.6) |
| **Pre-aim habit**: crosshair placement height and lead distance per position | `aimMetrics` per position | The aim motor's pre-aim target, inside the pro envelope (8.3) |
| **Trigger discipline**: how long they hold an angle before giving it up, when they trade versus when they save themselves | Duel and death timing | `deathPermission` in their contract (6.19) |
| **Utility timing signature**: the clocks and pressures at which they throw, and how much they vary | Grenade events versus round clock | The utility ladder's rungs 5 and 6 (6.22) |
| **Lurk and rotation tempo**: when they leave the core, how far, how long before rejoining | Core membership over time (6.18) | Their position contract's window |

These are distributions, not scripts, so they compose with everything else:
a mimicked player off the tape still decides with the shared policy, but the
policy is conditioned on that player's habit vector and the option controllers
are parameterized by it. This is what makes "they always clear coffins before
pit, and he repeeks within a second every single time" a thing a scrimming team
can actually practice against.

Sample-size discipline is the same as layer 1: below a floor of rounds per
player, each habit falls back to the team's distribution, and below that to the
position's league-wide distribution. The UI shows which habits are live and how
many rounds each is built from, because a confidently wrong habit is worse than
an honest average.

How a mimic round is chosen:

- UI: team typeahead (Database search), then a list of that team's rounds
  on this map, filterable by call, side, economy, result. Pick one, or pick
  `Random matching` which draws from the filter each sim round (so a match
  of 24 rounds is 24 different Spirit T rounds, not the same one looped).
- Role alignment: `entry.roles` on that demo maps their AWPer → our AWPer,
  their Banana → our Banana, and so on. IF a demo has a missing role (stand-in,
  4-man), the leftover bot gets `autonomous` from t=0 and the four-man tape
  still runs.
- Spawn alignment: `spawnAssign.matchToTracks`. This is why spawn choice is
  free. Without it, mimicry cannot start on the geometry the recording used.
- Both-sides ghost: optional config `mimic.bothSides: true` loads the same
  demo for T and CT. Useful to debug follow quality (the round should look
  like the demo until the first off-script death). Not a practice mode.
- Practice mode (the real one): T mimics Spirit's T rounds, CT is AI (or
  mimics a different team, or is a second human-shaped BC policy). T walks
  Spirit's paths until our CT does something Spirit's opponents did not.

What is copied, what is not:

| Copied from the demo | Not copied |
|---|---|
| Movement path, yaw, gait, holds, peek timings | Aim, sprays, who they shot (our motor fights the live enemy) |
| Utility lineups and throw clocks, if we are in range | Economy (our money, our buy, unless `mimic.buy: true` which copies freeze loadouts as a starting buy, still legalized by 4.9) |
| Role, spawn preference | Their HP, their luck, their enemy's positions |

IF the mimicked player jump-peeks: v1 follows the ground projection of that
path (no jump in the 2D engine except scripted jump-throws). The follow
error is tolerated up to the 180 u local interrupt; jump peeks that only
displace 40 u horizontally just look like a fast swing. Logged as a
fidelity gap, same family as doors (14).

IF the mimicked round is 128-tick or a different tickRate: resample the
track to 64 Hz the way the BC extractor already must (14.9). Never assume 64.

Retrieval templates (layer 2) also power the scripted Playstyle used in
phases P3/R1: a fully non-ML planner that is already a product ("watch a
real team's B execute run by bots"), de-risking everything downstream.
Layer 3 is that planner with the actual tick tape instead of anchors.

### 10.4 Follow until something happens

This is the runtime loop, used by commanded calls and by mimic tapes alike.

```
freeze:
  Playstyle picks spawns, roles, buy, and a tape (mimic round or call template)
  bots placed on chosen spawns
live:
  each bot.task == follow:
    translator.follow(track, clock)
    aim motor live (shoot if they see someone)
    interrupts.classify(event) -> ignore | local | team
  local:
    that bot.task = autonomous
    Individual AI owns their movement
    optional re-sync once if they return to the tape
  team:
    Playstyle.step(belief) -> new TeamDirective
    all living bots drop the old tape
    new orders (usually autonomous under a new call)
over:
  payout (4.9), including explode-vs-elim
```

The translator never teleports onto the tape. It presses W (and walk, and
crouch, and counter-strafe) toward the recorded pose using CS movement. That
is the same DecisionInterface a 3D port will implement as an actual bot
command. If CS movement cannot keep up with a recording that used a jump or
a boost, the bot falls behind and locally interrupts. That is correct: the
brain should notice it is not where the plan said.

Acceptance for mimic follow (P3): take 50 Inferno T rounds from one team,
run them against a frozen CT (no CT movement, just spawned), measure median
geodesic error vs the tape over the first 20 s of live, before any gunfire.
Target: < 60 u median, < 150 u p90. Then the same 50 against a live CT AI:
interrupt logs must show mostly `ignore` until first contact, then `local`
or `team` according to 10.2, never a team replan on a single banana peek
while four teammates are still walking A.

---

## 11. The /sim page UI

Style: obeys `.cursor/rules/aim4-ui-controls.mdc` and `CLAUDE.md` (flat fields,
seg switches, no labels-on-everything, no marketing copy, no em dashes).

### 11.1 Setup panel (left side, creator-like layout)

- Map select (7 maps), mode seg: `Round | Match (MR12)`.
- Per team: model/generation select (from the registry), skill seg
  `mix | t3 | average | t2 | t1 | pro` (8.4, default `average`), optional per-role skill overrides,
  mimic select (team typeahead, then round filter or `Random matching`),
  starting command select (round-library calls for map+side, `Default`,
  `Auto`, `Mimic`).
- Spawn seg: `Auto` (Playstyle picks) | `Mimic` (match the tape) | `Pin`
  (artysan assigns each role to a pool spawn). Free choice is the default
  engine rule; these are who is allowed to use it.
- Seed field (blank = random, shown after start for reproducibility), speed seg
  `1x | 4x | 16x | Instant`, Play.

### 11.1b Runs: starting evolution from the page

Three controls and two readouts, all of them thin clients over the job runner
(9.2b), because the panel should be able to steer a generation without knowing
anything about how one is computed.

- **Run match**: the existing play button, unchanged.
- **Start generation**: pick a parent, a curriculum stage, a genome, a tick and
  wall-clock budget, and a host. Refuses, with a reason, when no CUDA trainer is
  attached and the stage needs gradients.
- **Stop**: always safe, because a job is a directory of shards and a manifest.

- **Job list**: what is running, on which host, how far through its budget, and
  what it has produced. A run started from a browser that cannot be found again
  from another browser is a run that will be started twice.
- **Data readout**: which aggregates this run is using, their library versions,
  and their round counts (9.2c). Stale is shown as stale rather than as a
  number nobody reads.

### 11.2 Live view

- The existing radar viewer componentry rendering live WS frames: the server
  steps the engine at the chosen pace and streams compact frame diffs
  (`server/sim/live.js`, football.js pattern); pause/scrub within the finished
  portion (server keeps the tick buffer so far).
- View seg: `All | T POV | CT POV`: POV modes call the same `povFrameFor`/
  `povZonePaint` path the timeline viewer uses. Because of the 5.4 guarantee,
  "T POV" is exactly the T bots' knowledge, satisfying the brief's LIVE
  requirement observably.
- Clock, kill feed, economy strip, score: existing viewer widgets fed by sim
  meta.

### 11.3 Inspection (the debugging soul of the page)

- Click a bot: order card (role, task, spawn, call, follow/autonomous),
  current intent, top-3 alternatives with probabilities, xK badges vs known
  enemies, aim-motor state (reacting/tracking/firing), skill profile in
  effect, sound percepts heard recently, geodesic error to the tape if
  following.
- Decision log: timestamped interrupts with scope (`local bot3 damage` /
  `team: 2 dead + smoke B`), then Playstyle directives ("Replan: 2 deaths
  at 1:21; call b-rush → fake-a"), so the B-rush-abort story is readable
  as it happens.
- Overlays togglable: belief (particle cloud per enemy, colored by slot, with the
  team's entropy in a corner), sound rings, nav path lines, the mimic tape as a
  ghost trail, control paint.
- **Angle overlay**: the candidate (spot, yaw) entries at the selected bot's
  anchor (6.8), shaded by priced dPRW, with the chosen one outlined and the
  `exposureSet` painted. This is the picture that makes "why did he stand there"
  answerable.
- **Price card**: the top three options with dPRW, exposure cost, trade cover,
  and the risk distortion applied (`audacity` this round, `confidenceBias`), so
  a smoke walk can be read as "waiting was priced worse" rather than as a bug.
- **Awareness readout**: per known enemy, `pKnowsMe` and `infoAdvSecsHat` (5.6),
  next to the true value in a dev-only column so estimator drift is visible.
- **Bandit panel**: the EXP3 weights over calls and how they moved (6.10), plus
  whatever `antistratScan` has detected about the opponent so far.
- **Activity map** (FC IQ's, 6.13): before the round, the expected occupancy
  footprint of the chosen shape and role/focus assignment, drawn with
  `analytics/heatImage.js`. Missing coverage is visible before the round starts
  rather than diagnosable after it.
- **Shape overlay**: home positions, current offsets from them, the compactness
  band, and any responsibility left unbackfilled after someone made a run.
- **Space overlay**: the opportunity field (6.14) as a heat layer, togglable
  between control, value, and danger, with the per-match death-danger memory
  drawn separately so "they stopped pushing banana" is legible.
- **Spot-encounter ribbon**: for the selected bot's current path segment, the
  ordered danger spots and where along the path each one opens, with the ones
  already checked greyed out (6.8). This is the single clearest picture of
  whether a bot is clearing correctly.
- **Memory tab** (18.9): the situation key for the current decision point, the
  rows retrieved for it across the three scopes with `n`, the bound, the
  attribution split, and the library prior, each row linking to the past rounds
  it was built from. Plus the avoid-set in force and what it repriced.
- **Contract card**: the selected bot's role contract (6.19), its zone rights,
  its remaining utility budget, its trade pairing, and a live compliance meter,
  so "the anchor is roaming" is visible rather than deducible.
- **Core overlay**: the own-team core and lurkers drawn from `findCore`, and the
  believed enemy core drawn over the particle cloud with its confidence (6.18).
- **What the team learned**: a match-level timeline marking every round where
  the opponent model, the avoid-set, or the economy plan changed a call, with the
  before and after and the evidence count behind the change.
- Every entry in the decision log carries its **motive string** (6.17).
- After the round: `Save round` writes it to sim storage; `Open in viewer` deep
  links the standard timeline viewer against the sim store route.
- After the round, the **review** (18.6) is shown as it is written: the coach
  flags, the largest PRW drops, what the offline search would have done at each,
  and whether the loss was attributed to the call or to the execution. This is
  the same report the training queue consumes, so what artysan reads and what the
  next generation learns from are literally the same object.

### 11.4 Later (flagged, not v1)

Generation browser with Elo curves, eval reports, match archive search, A/B
harness UI, aim-gate dashboards. The admin Models tab gains a read-only "Sim"
card pointing at the registry.

### 11.5 God mode: call it, slow it, branch it, or leave it alone

The page has one viewer and he is omniscient by right. Four modes, and the
important thing is that none of them is required: the bots play a full match with
nobody watching.

| Mode | What it is |
|---|---|
| **Observe** | Watch. Nothing is asked of you. This is the default |
| **Call** | Issue calls at freeze and at any point mid-round, to the team or to any subset of it (the order scope in 6.1 is already a list). The bots may refuse, and a refusal with its motive is the most interesting thing this page can print |
| **Branch** | Save the round state at any tick, try a call, watch it play out, rewind to the savestate, try a different one. The engine is deterministic and seeded (4.1), so a savestate is a state snapshot plus a seed, and a branch is exact rather than approximate |
| **Grind** | Run matches unattended at high speed to accumulate rounds. This is not a spectator feature, it is how the experience index (18) fills up, and the speed cap should be whatever the box allows rather than a fixed number |

Design notes that follow from those:

- **Time control is continuous, not a seg of presets.** Slowing a round to think
  is the whole point of the Call mode, so the speed control runs from a crawl to
  as fast as the machine goes, and Grind is that control at its ceiling with
  rendering off.
- **Branching needs the engine to snapshot cleanly**, which is a constraint on
  `engine.js` from day one: all mutable round state in one serializable object,
  no closures holding state, PRNG state included in the snapshot. Cheap if
  designed in, near-impossible to retrofit.
- **A branch is a first-class artifact.** Trying three calls from the same
  savestate produces three watchable rounds that differ only in the decision,
  which is the cleanest teaching material this project can generate and costs
  nothing beyond storing three short tick buffers.
- **Calls made by a human are labelled as such** everywhere downstream: in the
  round meta, in the experience index, and in the training queue. A human call is
  not evidence about what the Strategy AI would have chosen, and letting the two
  mix would quietly poison both the memory and the evaluation.
- **The deep analysis is open to the viewer.** The full scorecard (9.17): the
  formation and pace distributions for this map against the pro population, per
  axis percentiles, contract compliance per position, the utility economy over
  the round. Not a gate readout, a place to actually look at what the bots are.
- **No comms.** No transcript, no voice, no persisted callout log. The decision
  log with motives stays compact and is not written into the replay file.

---

## 12. Storage, formats, and APIs

### 12.1 Directory layout (server, under `AIM4_REPLAY_DIR/sim/`)

```
sim/
  lineups/<MAP>.json          # mined utility (4.8)
  timings/<MAP>.json          # zone first-arrival distributions, flow priors (5.6)
  navcache/<MAP>.bin          # baked nav graph + masks + angle catalogue (6.8)
  datasets/bc-vN/             # BC shards + manifest
  models/<gen>/               # manifests + weight blobs (9.9)
  league/                     # pool bookkeeping, Elo table, PBT genomes
  archive/                    # behavior-archive cells: descriptor -> elite (9.22)
  baselines/<libVersion>/     # per-tier pro metric distributions (9.17)
  tablebase/<MAP>.bin         # solved late-round states + abstraction version (18.7)
  experience/<lineage>/       # the index: career / opponent / session shards (18.3)
  ledger/<gen>/               # per-bot, per-role mistake and praise counts (18.6)
  matches/<id>/               # match.json + round-N.meta.json.gz + round-N.ticks
  evals/<gen>/                # eval reports, scorecards, exam results, linked match ids
```

Sim rounds reuse the demo store codecs but live outside the library tree: nothing
in Demo Manager/Database/stats index ever scans them (secrecy + no stat
pollution). A `synthetic: true` field in every meta guards against future
accidental ingestion.

**The firewall is one-directional and absolute.** The sim reads the library, the
zone network, the fitted models, and the analysis code. It writes nowhere the
site can see, and nothing derived from simulated play is ever fed back into
anything a user touches: not the round library, not the pattern finder, not the
duel model, not the round model, not the stats index, not team pages. This is a
hard rule rather than a preference, for two reasons that both matter. Analytics
that users trust must describe games that were played; the moment a simulated
round can move a real number, every number on the site becomes a claim about our
engine's fidelity instead of about Counter-Strike. And the secrecy requirement
(2) is only as strong as its weakest write path, so there is no write path.

Concretely: `synthetic: true` in every meta, a separate directory tree, no shared
cache keys, and any script that ingests rounds refuses paths under `sim/`. The
sim improving our understanding of formations is a fine thing to *learn* from and
never a thing to *ship* into the analysis stack.

### 12.2 API surface (`/api/sim/*`, all guarded, all 404 on deny)

| Endpoint | Purpose |
|---|---|
| `GET /api/sim/me` | Gate probe for the client shell |
| `GET /api/sim/meta` | Maps ready (nav+lineups baked), models, mimic candidates |
| `GET /api/sim/mimic-rounds` | Library rounds for a team+map+side+call filter (for the mimic picker) |
| `POST /api/sim/matches` | Create match from config; returns id |
| `GET /api/sim/matches/:id` | State + results |
| `WS /ws/sim?match=:id` | Live frames + decision log stream |
| `GET /api/sim/matches/:id/rounds/:n/ticks|meta` | Viewer data, demo-shaped |
| `POST /api/sim/bake/:map` | Rebuild nav/lineups after zone edits |
| `GET /api/sim/models` | Registry list |

### 12.3 Match config (persisted, reproducible)

```jsonc
{ "map": "INF", "mode": "match", "seed": 421337,
  "teams": {
    "T":  { "model": "gen12", "skill": "average",
            "skillSlots": { "AWPer": "t1" },
            "mimic": { "team": "SPIRIT", "side": "T", "pick": "random-matching" },
            "command": "mimic", "spawns": "mimic",
            "memory": { "lineage": "main", "scopes": ["career", "opponent"],
                        "hash": "sha256:…", "keyVersion": 1 } },
    "CT": { "model": "gen8", "skill": "t2", "mimic": null,
            "command": "auto", "spawns": "auto", "memory": null } },
  "rules": { "freeze": 15, "overtime": true }, "createdBy": "<uuid>" }
```

---

## 13. The 3D port path

The end goal: five bots any real team can scrim against on a real CS2 server. The
plan keeps this honest from day one via the layer boundaries (3).

### 13.1 What ports unchanged

Both networks (weights), the DecisionInterface schema, the knowledge-tracker
*specification* (percepts and belief shapes), role/call vocabularies, aim skill
profiles (as targets for the 3D motor), spawn permutation (freeze `setpos` is
the 3D translator for it), the league/eval methodology.

### 13.2 What is re-implemented per world

The translator backend and the percept sources. On a CS2 server, the working
option today is a **CounterStrikeSharp (C#) plugin** `[verify current ecosystem]`:
read player/bot state from the server (positions, angles, health, weapons,
events: full fidelity, better than the 2D estimates), and drive bots by
overriding their usercommands per tick (move/aim/attack buttons), which community
plugins already demonstrate. Fallbacks if bot control proves brittle: driving
actual client instances (heavy), or partnering the sim as a coach/strat layer
over native bots (degraded). **This is the single largest external risk in the
whole project, so it is scheduled as an early spike (P8 can start any time after
P3), not a final step**: a 2-week proof: plugin `setpos`es one bot onto a
named spawn during freeze, walks it to `banana_car`, peeks, throws a mined
smoke on command from the DecisionInterface.

### 13.3 Sim-to-real gaps and mitigations

| Gap | Mitigation |
|---|---|
| Pitch/verticality absent in 2D | Decisions are named-spot coarse; the 3D aim motor owns pitch; z-layers already separate Nuke floors |
| Grenade physics differ | Lineups are mined from *real 3D demos*: `setpos/setang`-style throws replay natively in 3D; the 2D flight was only a visualization |
| Movement micro (air strafes, jump peeks) | Translator templates re-tuned in 3D against the same demo-calibrated timing targets; decisions unchanged. Mimic follow in 3D can use the real jump because the tape came from a real demo. |
| Vision fidelity (2D LOS raster vs real geometry) | Knowledge tracker in 3D uses real engine traces: strictly better inputs than training; domain gap is conservative in the safe direction |
| **Spawn assign in 3D** | After the CS2 port, a freeze-only `setpos` places each bot on the chosen pool spawn (Playstyle permutation or pin UI). Same DecisionInterface as 2D. No mid-round teleport. |
| Behavior drift after transfer | Fine-tune generations on a headless CS2 server farm later (slower ticks, tiny lr), with the 2D league as regression harness |

---

## 14. IFs, BUTs, MAYBEs: risks and edge cases

Engine and data:

1. **Radar mask lies** (stair shadows, decorative black, missing railings): bots
   walk through art or stall. Mitigation: per-map `simCollision` paint pass + a
   nav-fuzz test that random-walks 10 k paths asserting no wall clipping.
2. **Vision blockers vs physical walls diverge** (a painted smoke-common spot is
   not a wall): the union mask (4.2) errs solid; per-map review catches the rest.
3. **Spawn API depends on library demos**: a map with few demos yields sparse
   spawns; bake step warns below 5 spawns per side and **refuses to start a
   round** rather than duplicating points (4.12). Spawns also drift with game
   updates: rebake on library growth (`forgetSpawnCache` already exists). Mimic
   matching can collapse two recorded freeze positions onto one clustered
   spawn: the extra bot takes the next-nearest unused point and the t=0 follow
   error is logged, not silently teleported.
4. **Lineup mining sparsity** on less-played maps: fall back to admin utility DB
   spots with straight-line flight; UI marks low-coverage maps.
5. **Doors, breakables, boost spots** unmodeled in v1: known fidelity debt,
   listed per-map in `sim/meta`, revisit before 3D transfer relies on them.
6. **Nuke**'s two floors are a solved problem in this repo and the first four
   passes overstated them. `lowerZ`, `isLowerLevel`, per-level painted
   positions, and a second radar all already exist, so the bake produces a
   lattice per level and a body's floor follows from its z (4.2). What remains
   is calibration rather than architecture: traversal speed on ramps and
   ladders, and which of the geometrically-overlapping cells are real
   connections. Both are mined. The honest residual risk is that the overlap
   set is larger than the true connection set, which would let a bot change
   floor somewhere a player cannot, so the mined transitions must *narrow* the
   geometric candidates and the bake should report the ratio.
7. **Smoke constant inconsistency** (18 vs 22 s in-repo): freeze 20 s in sim
   constants, file a small follow-up to unify the repo's two.
8. **Determinism across platforms** (float drift Node versions/CPUs): pin the
   engine to standard `Math` ops (no `Math.fround` mixing), test a golden-seed
   hash in CI; if drift appears, quantize state per tick (positions already
   quantize to 0.25 u in the tick format).
9. **Tick-rate mismatch**: library demos vary (64 typical); the extractor reads
   `header.tickRate` and resamples to 8 Hz decisions: never assume 64.

ML:

10. **BC label noise** (round tags cover only defined calls; `default` dominates):
    weight rare calls up, and accept that BC learns "generic pro round" as the
    base: that is the correct prior.
11. **RL collapses to camping/passivity**: symmetric xK potential + objective
    rewards + call-entropy gate (9.8) + league exploiters. If it still camps,
    add a shot-clock shaping term T-side (time-decayed win potential already
    encodes urgency via the round model's clock feature).
12. **Reward hacking the duel model** (bots learn adversarial poses that fool
    `predictDuel`): the model was fitted on human play; anneal β2 to zero across
    generations and gate on *real* outcomes (Elo), never on the shaped score.
13. **Self-play strategy cycling**: league with past checkpoints and paired-seed
    evals is the standard, proven counter.
14. **Hivemind/individual credit muddle**: start with the scripted planner
    (removes the problem while individuals mature), then SMDP returns; COMA
    baseline as escalation.
15. **JS engine too slow for RL appetite**: profile first (it is mostly float
    math on small arrays); escape hatches: worker sharding, reduced 32 Hz
    physics for training only (with a parity test), or a Rust/WASM port of
    `engine.js` behind the same tests: the module boundary makes this a swap,
    not a rewrite.
16. **Mimic overfit to famous players** with few rounds: embedding shrinks to
    the archetype mean below a sample floor; retrieval requires ≥ 3 matching
    rounds or falls back to team-level. Movement mimic of a *specific* round
    has no sample-size problem (it is that round), but `Random matching` over
    a thin filter will loop the same three rounds: the UI must show the
    candidate count.
17. **Aim envelope gaming**: policies could exploit motor quirks (e.g. abuse
    zero-error first frame after reaction gate): aim gates measure *outcomes*
    (TTD, accuracy) so quirks show up as superhuman outputs and fail the gate;
    fix the motor, re-run.
18. **Interrupt over-triggering**: if every footstep of gunfire is `team`,
    mimicry never copies more than two seconds of a round. If nothing but
    death is `team`, the B-rush walks into the smoke. The 10.2 taxonomy is
    the spec; the P3 acceptance (single banana peek must stay `local`) is
    the test. Tune thresholds in `constants.js`, do not special-case maps.
19. **Mimic tape vs a live enemy**: the recording walked into empty space
    that our CT is now holding. That is the whole point of practice, and it
    is a local or team interrupt, not a follow bug. Do not "steer" the tape
    around live enemies. The aim motor fights; the feet keep copying until
    classified otherwise.
20. **Skill knobs leaking into training / eval**: training always runs at
    `pro`. Eval reports record the five effective profiles. A gen12 mix vs
    gen12 pro match is not an Elo data point for the league.
21. **Foresight is a second engine, and second engines lie.** The predicted pose
    trace in 6.7 comes from the translator's controllers rather than from a real
    engine step, so it will disagree with reality on geometry, tagging, and
    collision. Mitigation: a parity test that runs the real engine over a
    sampled set of priced options and asserts the pose traces match within a
    tolerance; recalibrate when the translator changes. A drifting foresight is
    invisible in the win rate and obvious in the parity test, which is the only
    reason to have one.
22. **Pricing everything is slower than playing.** Foresight at 8 Hz for 10 bots
    is the largest new CPU cost in the plan. Budget: top-3 options only, cached
    angle bitmaps, 12 hypotheses, foresight off in bulk rollouts (6.7). If the
    engine budget in 4.1 slips below 6 rounds/sec/core with foresight features
    on, cut hypotheses before cutting particles: the filter is what everything
    else reads.
23. **The duel model gets exploited harder now.** 14.12 already flags reward
    hacking; making `predictDuel` the *decision* function raises the stakes,
    because a pose that fools the model is now worth finding at 8 Hz. Guards:
    price with hypotheses rather than a single best case, keep the round-level
    Elo and exploitability gates as the only admission criteria, and audit the
    top-10 highest-priced options per generation by hand for physically absurd
    poses. If `predictDuel` starts being wrong in a systematic direction, that
    is a finding about the fitted model and it should go back into the duel
    trainer, not be patched in the sim.
24. **Surprise becomes an excuse.** Every bad behavior can be relabelled
    "personality". The defence is the two-sided band in 9.8: the rates are
    measured against the library, so "pros do this 4% of the time and we do it
    31%" is a failure, not a feature.
25. **EXP3 on 24 rounds is a small sample.** The bandit will look like it is
    learning when it is drifting. Keep its learning rate low, warm-start from
    the policy prior, cap how far it may move a logit, and show the confidence
    in the inspector so nobody reads noise as a read.
26. **Options make BC labelling harder before it makes it easier.** Segmenting a
    demo into options is a labelling problem with no ground truth. Start with
    rule-based segmentation (speed, LOS, and objective signatures), hand-audit
    200 segments per map, and accept that `advance` will absorb the ambiguous
    ones. The library matcher (10.1) remains the outer check.
27. **Kill-award or explode-vs-elim bugs**: a $250 or $600 error compounds
    over 24 rounds and teaches the wrong afterplant (hunt vs hold). Golden
    tests in P2 must lock both orderings and all four kill buckets before
    any RL run is allowed to see money.

Product and ops:

28. **Secrecy leak via bundle**: route string is visible in `site.js`: acceptable
    (it 404s), but keep all sim UI text inside the lazy chunk; never reference
    `/sim` from public pages; keep `SIM-PLAN.md` out of any published docs page.
29. **Sim work starving the site.** The panel can now start generations and
    matches on either host (9.2b), which trades a simple rule for a useful
    feature and takes on a real risk: an overnight run that quietly stops demo
    ingestion is a worse outcome than not having the button. The rails are one
    live match, a rollout pool that is opt-in per deployment
    (`AIM4_SIM_WORKERS`, default 0 on prod), child processes so the API event
    loop is never shared, declared tick and wall-clock budgets, and parse jobs
    preempting sim jobs. The detector is that parse throughput is already
    measured; if it drops while a sim job runs, the rails are wrong. Gradient
    steps still never run on prod.
30. **Supabase outage** makes `whoami` anonymous: the guard then denies: fails
    closed, correct for a secret page.
31. **Vercel catch-all**: forgetting the rewrite sends `/sim` to the trainer:
    it is in the Phase 0 checklist twice because it will absolutely happen
    otherwise.
32. **Windows dev, Linux prod**: path handling via `path.join` everywhere in new
    server code; binary shards little-endian both sides; test suite runs in CI on
    both if possible.
33. **Model weights are IP**: they never enter git or `dist/`; backups ride the
    existing `AIM4_REPLAY_DIR` strategy.
34. **Game updates change constants** (prices, speeds, kill awards): all in one
    file (`constants.js`) with a `RULES_VERSION`; matches record the version they
    ran under so old replays stay interpretable.
35. **Scope gravity**: the follow-until-interrupt mimic (P3) is the fallback
    plateau: if ML stalls for a month, the page still demos real value (bots
    walking a real team's round, then adapting when something happens). Protect
    that milestone. The off-script layer has its own plateau at P3b: priced
    options with a scripted planner is already "bots that play CS", before any
    RL run exists.

Behavior architecture (this revision):

36. **A shape makes bots rigid if it is a leash.** FC IQ works because roles pull
    players out of the formation; a formation with no deviation is five bots
    standing on crosses. Home positions are a *default and a price*, never a
    constraint, and the eval must watch for a collapse in position entropy
    against the library baseline (9.8.6 covers it).
37. **The space field will herd.** Five bots independently maximizing the same
    opportunity field all run to the same cell. Assignment must be a matching
    (Hungarian over roles and cells, as spawn choice already does in 4.12), not
    five independent argmaxes. This is the single most likely bug in 6.14 and it
    looks exactly like the bot clustering it was built to fix.
38. **Spot-encounter sweeps look robotic if they are identical.** Every bot
    clearing the same corridor with the same crosshair path in the same order is
    a tell. The `concentration` and `anticipation` traits must perturb which
    entries get checked and how long each is held, and the eval should measure
    crosshair-path variance against demo baselines.
39. **`earliestOccupy` assumes a standing start.** It is geometry, so it is right
    about the race and wrong about the runner: a bot that already spent 8 s
    walking mid does not get spawn timings. Always combine the baked number with
    the live clock and the belief, and mine the *behavioral* departure prior from
    demos (6.8) rather than trusting geometry alone.
40. **The desire arbiter can quietly become the product.** If the scripted
    desires are good enough, there is a real risk nobody finishes the learned
    policy. That is an acceptable outcome and should be named as one: P3b is a
    shippable bot, and P4 onward has to justify itself against it in the same
    paired-seed harness as any other generation.

Grading, evolution, and memory (this revision):

41. **The scorecard's population is not our population.** Pro metrics were
    produced against pro opponents; ours are produced against the reference set.
    Every percentile in 9.17 carries that confound. The correction term (score
    the BC anchor, whose real-demo metrics are known, through the same pipeline
    and report the shift) is not optional decoration, it is the thing that makes
    the number readable at all. If the correction is large, say so in the report
    rather than quietly subtracting it.
42. **Percentiles invite metric farming.** The moment an axis is graded, a
    population under PBT will find the cheapest way to move it, and "utility
    damage per round" has a cheap way. The defence is that style metrics score
    by band rather than by more-is-better, the overall score is a soft minimum
    rather than a mean, and Elo and exploitability remain separate verdicts that
    metric farming cannot help.
43. **PBT selecting on the scorecard is one indirection away from the same
    problem.** It is a better proxy, not a true objective. Rotate which held-out
    maps and reference opponents feed the fitness each cycle so the population
    cannot converge onto the exact evaluation it is being scored by.
44. **The tier classification will be over-read.** "Gen 22 is a top-10 team" will
    be repeated without the sentence that follows it, which is that this is a
    statement about how it plays, measured against a population it never faced.
    The report must print the caveat next to the verdict, every time, in the
    same box.
45. **Memory poisoning from weak self-play.** An index filled against generation-3
    anchors records that naive rushes win. Elo floor on career ingestion,
    quarantined exploiter scope, and a library prior that is never removed (18.8).
    The detector is arm D of the ablation: if opponent-scoped memory carries all
    the value and career memory carries none, the career scope is noise or worse.
46. **Avoidance turning into passivity** is the failure this feature is most
    likely to produce, and it will look like caution rather than a bug. The six
    rules in 18.5 are the design; the test is the surprise band and the T-side
    win-rate floor in 9.8, both of which a timid team fails.
47. **Memory breaks determinism if anyone writes during a round.** Stated in
    18.10 and repeated here because it is the kind of rule that gets broken by a
    convenient one-line commit inside the tick loop. Read-only during the round,
    commit at round end, index hash in the match config.
48. **The tablebase is optimal against its own abstraction.** Bucket boundaries
    are versioned data and the table is rebuilt when engine constants change; a
    stale table is worse than no table, because foresight will trust it.
49. **The situation key is a schema, and schemas rot.** Every key-version bump
    invalidates the entire index. Bump deliberately, keep a migration for the
    fields that survive, and never let two key versions coexist in one file.

Visualization (19):

50. **The joint filter can deplete.** Five discrete dimensions plus sharp
    negative information can kill every particle, and a belief that has
    confidently deleted the truth is worse than a wide one. Resample-move with a
    per-slot kick, stratify by layout signature, keep the per-slot marginals as
    a proposal, and widen back toward the flow prior when effective sample size
    collapses. The calibration gate (19.12) is the detector; KL alone would not
    catch it.
51. **Commitment and tunnel vision are the same behaviour until it works.** A
    bot that skips every angle but one is either a tier-1 entry or a broken VOI
    estimate. The defence is the two-sided commitment-texture band plus the
    covered/uncovered attribution on entry deaths, both in 19.12. Do not tune
    this by watching rounds; it looks correct either way.
52. **The VOI estimate is biased by its own sample.** The cheap version is the
    spread of prices across twelve stratified hypotheses, which is a heuristic
    and should be called one in the code. Falsification: does the commit-versus-
    widen decision correlate with round outcome better than a fixed schedule? If
    not, the whole budget mechanism is decoration.
53. **Sacrifice pricing invites feeding, and the guard is the grade.** No reward
    term pays for dying, ever. Untraded-death rate and contract compliance in pro
    bands (9.17) plus gate 10 (9.24) are the defence. Anyone who reaches for a
    "useful death" reward term has reintroduced the bug this rule exists to
    prevent.
54. **Two-body pricing invites five-body pricing.** Hold the line at two. Two is
    where Counter-Strike's coupling actually lives (trade pairs, bait and punish,
    entry and refrag); past two the combinatorics are unaffordable and the game
    does not work that way anyway.
55. **Execute DAGs will overfit to one team's rounds.** Show `n`; below a floor,
    fall back to the call-level modal structure and then to the league-wide one.
    Same sample-size discipline as mimicry (10.3), same UI obligation to display
    it.
56. **Econ-conditioned priors thin the data fast.** Conditioning the flow prior
    on (map, side, clock, econPair) splits the library into small cells. Back off
    along econ first, then clock. Write the backoff down or someone will condition
    on everything and ship noise.
57. **Momentum may simply not exist.** Test it against the library, controlling
    for economy, before any feature depends on it. Delete it if the effect is not
    there rather than keeping it as flavour.
58. **The support request can become a telepathy channel.** It carries an ask and
    never a percept, it pays the full comm delay, and it is capped per bot per
    round. A request that smuggles information defeats 5.1 entirely.
59. **Attention drain is the least falsifiable mechanism in the document.**
    Named as such in 19.4. If pro demos do not show late-round decision quality
    degrading with early-round complexity, drop it.

Doctrine (20):

60. **The zone classifier is a new source of truth and it will disagree with
    possession.** `possessionSharesAt` and the four-class zone map answer
    different questions and will produce different pictures on the same round.
    Show both in the inspector, use the classifier for doctrine metrics and
    possession for the analytics the site already ships, and never quietly
    reconcile them.
61. **Doctrine masks are a cage before they are a teacher.** Early-stage masking
    is what makes this affordable, and it also means a generation cannot discover
    that a rule is wrong. The three-regime schedule (20.14) is the design; the
    test is that the late-stage unmasked generation does not regress, and if it
    does, the mask was carrying the policy rather than training it.
62. **Doctrine compliance is trivially maximizable by being passive.** Most of
    the chapters reward patience, so a timid generation scores well on the
    doctrine axis. It is graded on a different axis from strength for exactly
    this reason (9.16's rule), and the T-side win-rate floor and surprise band
    (9.8) are what a passive team fails.
63. **The layer graph is a second map representation and can rot against the nav
    bake.** Bake them together, version them together, and fail the bake if a
    layer node references a zone the nav graph does not have.
64. **Level 2 comms make the belief worse before they make it honest.** Removing
    free negative information will lower every belief-accuracy number in 9.8.8 on
    the day it lands. That is correct, and the baselines must be re-mined rather
    than the feature reverted.
65. **Conditioning and the readability critic pull in opposite directions.**
    Signing the readability cost by intent (20.10) is the reconciliation, and it
    is the subtlest thing in section 20. If `conditioningValue` cannot be shown
    to correlate with actual punish conversion, keep the critic and drop the
    conditioning term rather than shipping both and hoping.
66. **Deviation licences will be farmed.** "We won the round" is not evidence the
    deviation was right. Licences are granted only on call-attributed outcomes
    (18.6) above a sample floor, and the licence ledger is auditable per bot per
    key. If licences correlate with nothing, the mechanism is decorative and
    should be said so in the report.
68. **Aggregates are a cache, and caches go stale invisibly.** A generation
    trained against a flow prior built from a third of the current library is a
    legitimate experiment and an illegitimate accident. Every aggregate carries
    its library version and round count, every manifest records what it used,
    and the panel shows both (9.2c). A silent staleness bug here looks exactly
    like a training plateau.
69. **Stratified sampling is easy to skip and hard to notice skipping.** The
    first version of any extractor reads whatever the filesystem hands it, which
    on this library groups by team and therefore by playstyle. The gate is that
    a shard's `(map, side, call, econ)` histogram must match the index's, and it
    is worth asserting rather than trusting.
70. **The panel's job runner is a new attack surface on a hidden page.** It
    starts processes. It is behind the same guard as everything else in section
    2, but a bug there is now worth more than a leaked page: job ids must be
    server-generated, budgets must be clamped server-side rather than trusted
    from the client, and no field of a job request may reach a shell.
71. **Mined floor transitions must narrow the geometric ones, never widen
    them.** The cells walkable on both Nuke lattices are candidates, not
    connections, and there are thousands of them. If mining produces a
    transition set close in size to the geometric overlap, that is evidence the
    mining is not working rather than evidence the map is permissive, and the
    bake should report the ratio so the difference is visible.

72. **The doctrine is one person's model of Counter-Strike, and it is not
    scripture.** It is a strong, coherent prior written by someone who plays at a
    high level, and several of its claims are empirical (the 82 percent, block
    timings, tug of war, momentum). Where the library can adjudicate a claim, it
    should, and a disagreement is a finding worth reporting rather than a bug to
    hide. The plan's own rule applies: the meta is expected to move (6.22), and a
    generation that outgrows a chapter should be able to show it.

---

## 15. Build order and acceptance criteria

**The 2D build is one build.** The table below is a dependency order, not a
release schedule: everything for the 2D simulation is built together and the
phases exist because P2 cannot be tested before P1 exists, not because P1 ships
and then P2 ships. Read the Acceptance column as "this is how we know that piece
works", and expect several rows to be in flight at once. The only genuinely
sequential thing in the project is the 3D port (13), which waits for the 2D
build to be a working whole.

Each phase lands with tests appended to the `npm test` chain, house-style.

| Phase | Scope | Acceptance |
|---|---|---|
| **P0** (day 1) | Hidden page + guard (section 2) | artysan sees the stub; everyone else and anonymous get 404 page and 404 API; guard tests green; `/sim` does not open the trainer on Vercel or `npm run host` |
| **P1** | `shared/sim`: constants, movement2d, navGraph, engine skeleton (freeze/live/over, no combat), encode, **spawn choice**; bake every map whose zones are ready, including the CS-style analysis pass (visibility, hiding spots, spot encounters, `earliestOccupy` per side, edge attributes) and one lattice per level on stacked maps (4.2) | Scripted bots run named-anchor paths at correct speeds on each baked map; spawn permutations never collide; the analysis bake is inspectable in an overlay and its `earliestOccupy` numbers match hand-timed runs within 0.5 s on three known routes per map; encoded round plays in the existing timeline viewer with working clock; determinism hash test; on Nuke a route from an upper anchor to a lower one exists and changes floor exactly once |
| **P2** | Combat: weapons/damage/aim motor/sound; utility mining + effects; economy; full MR12 + OT MR3 $10k; comm delay 0.5 to 1.5 s | Scripted 5v5 rounds complete with kills, plants, payouts; aim gates harness runs; economy golden tests: loss ladder, cap, T time-expiry $0, **all four kill-award buckets**, **explode-at-40s vs elim-at-39s after the same plant**; Team POV toggle on a sim round matches knowledge tracker (5.4 test); a sound heard by one bot reaches a teammate only after the delay |
| **P3** | Knowledge tracker, intents+masks, translator, **track follow**, **interrupt classifier**, scripted retrieval + **team-round mimic**, lineup executor; live WS + setup panel v1 | Commanded execute on each baked map → library matcher tags it ≥ 80% over 100 seeds (pre-interrupt); mimic follow vs frozen CT: median geodesic error < 60 u over first 20 s (10.4); a single isolated peek stays `local` while four teammates keep the tape; watchable live at 1x/16x with POV, ghost tape, and interrupt log |
| **P3b** (the off-script phase) | Particle filter (5.5), exposure estimator (5.6), attention + decision latency (5.7), angle catalogue and spot-encounter bake (6.8), option layer (6.6), foresight pricing (6.7), trade/spacing/crossfire geometry (6.12), shape and role/focus (6.13), space field and backfill (6.14), trigger table (6.15), trait vector (6.16), desire arbiter with motives (6.17) | Belief beats the flow-prior baseline on held-out demos; negative information visibly deletes cleared ground in the overlay; **the scripted desire arbiter alone is a watchable CS bot**: it beats the P3 scripted planner ≥ 65%, holds shape, backfills a vacated site within 3 s, and clears spot-encounter lists in order; foresight parity test within tolerance (14.21); a bot crosses a smoke at 0:22 and refuses at 1:40 in the same scripted scenario, with the price card and motive explaining both |
| **P3c** (the visualization phase) | Joint belief with the mined co-occupancy prior (19.2), typed threat field and the weapon-class sound percept (19.3), the visualization budget and its novelty cap (19.4, 20.11), `clearPartition` (19.5), paired two-body options and the support request (19.6), the three conservation laws and econ-conditioned priors (19.7), lurk triggers and the `opportunity` interrupt class (19.8), the death record and sacrifice gating (19.9), `sim-mine-executes.mjs` plus the repair ladder (19.10), sync anchors (19.11) | Belief calibration beats the marginal filter on `countDist` and on `pEmpty(site)` by a stated margin on held-out demos; the commitment-texture distribution sits inside the library band; an entry with a covered partition and an entry without it price differently and behave differently in the same scripted scenario; E11 to E13 run and produce stable numbers; a lurker kill visibly fires an `opportunity` replan and re-routes the carrier, with the motive string explaining the route choice |
| **P3d** (the doctrine phase) | `zones.js` live four-class classifier (20.2), the per-map layer graph baked with the nav pass, `LayerAction` as the macro action space (20.3), `ledgers.js` (20.4), the protocol library including WICK and the block cycle (20.5), keyword presets (20.6), the five-level comm schema with negative confirmation as a comm (20.7), zone ownership and the overcall protocol (20.8), the state-dependent risk quantile (20.9), clutch masks (20.12), the solved execute assignment (20.13) | The zone overlay is watchable and a human agrees with its four-class read on sampled rounds; the bomb-in-Safe mask is never violated without a directive; WICK produces the man-count-at-contact distribution the doctrine claims, or the discrepancy is reported; commanded keywords visibly change behaviour and the log names them; `predictRoundCalibrated` on library first-pick states is compared against the 82 percent anchor and the result is reported either way; E14 and E15 run |
| **P4** | BC: extractor, Python trainer, JS forward pass, mimic embeddings, option segmentation, `confidenceBias` fitted from pfw/pfo | BC bots beat scripted-random baseline ≥ 65%; call-validator ≥ 70% on commands; human-likeness KS within bands; surprise rates inside the two-sided band (9.8.6); page can pick `bc0` |
| **P4b** (the plumbing phase) | The job runner (9.2b): child-process rollout pool, declared budgets, preemption by parse jobs, job list and host status in the panel. The aggregate pipeline (9.2c): incremental per-map tables, stratified sampling, staleness reporting | A generation can be started, watched, and stopped from /sim on both hosts; killing the API process leaves the job resumable; demo parse throughput is unchanged while a rollout pool runs, measured rather than assumed; a shard's `(map, side, call, econ)` histogram matches the index's; every aggregate reports its library version and the panel shows a stale one as stale |
| **P5** | RL: rollout workers, MAPPO, reward (9.5), team spirit τ (9.10), z-conditioning (9.11), three-population league (9.12), auxiliary heads (9.14), eval harness, registry | gen1 admitted through gates (9.8) including surprise, team-play, belief and exploitability; generations selectable in UI; paired-seed Elo report stored |
| **P5b** | Opponent modeling (6.10): tendency tracker, EXP3 over calls, antistrat reuse, enemy-belief head; decision-time search (6.11) and expert iteration (9.13) | In a 24-round match against a fixed scripted opponent with an exploitable habit, the bandit's weights move measurably and the win rate in the second half beats the first; search-versus-policy disagreements are logged and distillable |
| **P5c** (the grading phase) | Role contracts (6.19) and live core reads (6.18); `sim-baselines.mjs` mines the per-tier pro distributions; `sim-scorecard.mjs`, `sim-exams.mjs`, the four-verdict report (9.16 to 9.19) | The BC anchor scores through the pipeline with a plausible tier verdict and a stated correction term; exams E1 to E9 run in under 10 minutes and produce stable numbers across seeds; a deliberately role-breaking agent fails the contract gate while winning on Elo, proving the gate has teeth |
| **P5d** (the memory phase) | Situation keys (18.2), the experience index with library priors (18.3), post-round review and attribution (18.6), the Strategy AI's supervised value head and selector (18.4), the avoid-set (18.5) | Exam E10 is strictly positive: against an opponent repeating one call ten times, the second half win rate beats the first; the ablation (18.8) reports a `Δ_E`; the Memory tab shows the rows behind a call and links to the rounds that produced them; determinism hash unchanged with memory enabled |
| **P6** | UX polish: inspector overlays, ghost tape, interrupt log, skill knobs, match archive, saving/opening rounds in the standard viewer, the Memory tab and the "what the team learned" timeline (18.9) | artysan can run a Spirit-mimic T side vs t2 CT, pause, inspect a local vs team replan, read why the call changed at round 14, save, and rewatch |
| **P7** | Scale: curriculum C0 to C5 across every baked map, mimic retrieval quality, buy-policy sanity, PBT population and the behavior archive (9.21, 9.22), the late-round tablebase solve (18.7) | Per-map gates green; call entropy floor; eval dashboard data; the archive holds occupants in at least half its cells and PFSP samples from it; exam E2 regret against the tablebase falls generation over generation |
| **P8** (parallel spike after P3) | CS2 server plugin proof (13.2) | Freeze `setpos` onto a chosen spawn, then one bot walks to `banana_car`, peeks, throws a mined smoke on command from the DecisionInterface |

Rough effort intuition: P0 a day; P1 to P3 are the engine month(s) and carry most
of the deterministic-correctness burden; P3b is three to four weeks and is the
phase that decides whether the bots are worth watching; P4 is a week once
extraction runs; P5 is open-ended by nature (that is the research part); P5b is a
week of very high product value for very little code; P8 is two focused weeks
that should happen early because its result shapes how much 3D faith the rest
deserves.

Sequencing note: P3b before P4 is deliberate. Behaviour cloning onto the option
vocabulary is far easier than cloning onto per-step movement heads, and the
angle catalogue and particle filter are the inputs those labels need. Building
BC first and retrofitting options means labelling the dataset twice.

The same argument extends to P3c and P3d, and more strongly. P3c changes the
belief's data structure, so every observation block and every BC label that
reads belief summaries would have to be rebuilt if it landed after P4. P3d
changes the *macro action space* from a per-map string to a map-independent
layer action, and behaviour cloning onto the wrong action space is the single
most expensive mistake available in this project: it would produce a Playstyle
net that has learned seven vocabularies instead of one theory, and no amount of
later training fixes a bad action space. Both phases are therefore ordered
before any cloning happens. P3c is roughly two weeks on top of P3b, P3d is three
to four, and P3d is the phase that decides whether the bots are *calling* rounds
or merely playing them.

---

## 16. Decisions (resolved)

1. **Training stack.** Python/PyTorch, on artysan's PC (RTX 4090). The website
   server has no GPU and never trains. Weights are exported as files and copied
   to wherever `/sim` should load them (9.2).
2. **Access.** No `AIM4_SIM_USER_IDS`. Gate `/sim` the same way `/admin` is
   gated: `whoami` + `isSiteAdmin`. The site already knows who artysan is (2.1).
3. **Maps.** All of them. Bots train on every map with baked nav and library
   demos. Engine still bakes map-by-map as collision paint is honest; a
   generation is eval'd on the ready set, not on Inferno alone (4.2).
4. **Freeze.** 15 s. Not worth a second mode.
5. **Compute.** Two machines: the **website** (serves pages, parses demos, no
   GPU) and **your PC** (4090). Gradient steps only ever happen on a CUDA host,
   so the website never trains in that sense. Everything else is now startable
   from the /sim panel: round simulations, and evolution runs whose rollouts may
   use a bounded, preemptible worker pool on either host (9.2, 9.2b). The rule
   changed from "prod never trains" to **"prod never starves"**, because being
   able to launch and steer a generation from a browser is worth more than the
   simplicity of forbidding it, and the guard rails (child processes, an
   opt-in worker cap, declared budgets, parse jobs preempting sim jobs) are
   cheap. Superseded the original answer deliberately; 14.29 carries the risk.
6. **Overtime.** On. MR3, $10,000 start.
7. **Decoys and wallbangs.** Out of v1.
8. **Comm delay.** 0.5 to 1.5 s per call, v1, not a later knob. Radar-like
   facts (teammate positions, spotted enemies) stay instant, like CS. Sound
   relays and orders to bots who did not see the event are delayed (5.1).
9. **Skill.** Adjustable per team and per bot. Play default is **`average`**.
   Training still runs at the pro envelope (8.4).
10. **Spawns after the CS2 port.** Freeze-only **`setpos`**: the plugin assigns
    each bot to the spawn the Playstyle AI (or the pin UI) picked, from the
    same pool, one bot per point. Mimicry and "AWP on banana" survive the
    port. No mid-round `setpos` (4.12, 13.3).
11. **The objective is PRW.** Bots maximize round win probability. xK is a
    feature and a metric, never a target (6.7). Every threshold expressed in xK
    in this document is a budget fallback, not the rule.
12. **Off-script movement is options, not per-step heads** (6.6). Commitment and
    decision latency are part of the contract, not tuning.
13. **The belief is a particle filter** with negative information (5.5). The
    reachability ball survives only as a derived feature.
14. **Surprise comes from beliefs, preferences, and mixing.** Never from the aim
    motor, the engine, or an `if (rand())` (6.9). It is measured against the
    library in both directions.
15. **Search is a teacher, not a runtime dependency** (6.11). The policy has to
    be strong alone, because a live CS2 server cannot be forked.
16. **Opponent adaptation ships before it is learned.** EXP3 plus a tendency
    tracker (6.10) is thirty lines and makes round 20 differ from round 2. The
    learned version replaces it later, or never.
17. **The bake copies CS's analysis pass** (4.2, 6.8). Hiding spots, spot
    encounters, area visibility and earliest occupy times are computed offline,
    once per map, because Valve computed them offline in 2003 for the same
    reasons and their bots still navigate better than their aim.
18. **Formation first, roles second** (6.13). The default answer to "nothing is
    happening" is a home position in a shape, not an improvisation. Roles and
    focuses are the deviation from it.
19. **Bots run at space, not at the ball** (6.14). Movement is driven by an
    opportunity field, not by the last thing that made a noise. Backfill is a
    rule, not a behavior the policy has to discover.
20. **Skill is a trait vector, not a slider** (6.16). Only three traits touch the
    aim motor and they stay inside the pro envelope; the rest are free to expose.
21. **Every decision carries a motive string** (6.17). If it cannot be explained
    in one line in the log, it is not shippable.

Resolved in the fourth pass (the twenty questions):

22. **Two vocabularies, both real** (6.20). The pattern-finder grammar (lanes,
    formation notation, pace type, fake) and the round-library call are both
    emitted and both used. The grammar describes how the round is *set up*; the
    library call describes what it *becomes*. Neither replaces the other.
23. **The snapshot clock is a measurement, not a decision** (6.20). It is the
    moment after the start has been chosen and before the round turns chaotic,
    which makes it the correct place to read what a team actually did and the
    correct anchor for the situation key. Nothing is decided *at* it.
24. **Directives are addressed per situation** (6.1). Order scope is a field: one
    bot, a pair, a core, or the team, whichever the situation calls for. Neither
    per-player nor per-group is right as a fixed rule.
25. **Tells: run both and keep what wins** (6.9, 9.17). `aggTells` on our own
    rounds as a measurable gate, the learned critic as the in-round cost, decided
    by which one moves the exploitability number.
26. **The opponent model is the scan plus the tracker** (6.10). The mined
    aggregators supply structure and thresholds that are already tuned; the
    tracker supplies the fast, low-sample in-match updates the scan cannot make.
27. **In-round knowledge is what the team sees and hears** (5.1, 5.2). Pooled
    across teammates with the comm delay. Nothing else.
28. **Post-round knowledge is PRW and PFW, not positions** (18.6). A team reviews
    the round in the currency of the models: where the round was won and lost,
    and which fights were good or bad. It does not get the enemy's coordinates.
29. **A dead bot sees what living teammates see** (5.8). Spectating adds no new
    percepts to the team, because it is a view of the same players. What it adds
    is thinking time, and that is what the plan gives it.
30. **Deception is not a formation head** (6.21). A fake is constrained by bodies
    at the formation scale and completely unconstrained at the utility scale, so
    it is modelled as managing the enemy's inference, at any scale, in any round
    state, including 3v3s.
31. **Contracts are keyed by map position** (6.19). Each map has its own five T
    and five CT positions; that is the contract table, and cross-map role names
    are derived labels on top of it.
32. **The AWPer reasons from macro theory** (6.19). Held open deliberately: the
    AWP position gets its own decision model, to be specified.
33. **The CT setup book is inspiration, not doctrine** (6.10, 9.7). Mined spreads
    and responses seed the prior; everything after that is learned and refined
    over rounds played.
34. **Strategy is not banded, mechanics are** (9.18). The meta is expected to
    converge on its own through the arms race (6.22), so likeness gates cover
    mechanics and honesty, never which strategies a generation prefers.
35. **The 2D build is one build** (15). Everything lands together; the phase
    table is a dependency order for implementation, not a shipping schedule.
36. **Team mimicry is the product's point** (10.3). Not a feature. Bots that can
    play as the team you are about to face, sampling *individual* players' angle
    clearing order, peek habits, and timings, is what this is for.
37. **Utility is utility** (6.22). Flashes at believed positions, molotovs
    against believed rushes, smokes under pressure, timings deliberately varied
    so the throws cannot be read. Executes are one use out of many, and there is
    a competency ladder rather than a lineup library.
38. **The target is a practice partner** (header, 10.3). Bot versus bot is the
    training ground; the eventual user is a real player scrimming against them.
39. **God mode, with savestates** (11.5). Call at freeze or mid-round, slow the
    round to any pace, branch from a savestate to try a different call, or sit
    back entirely and run matches at high speed to accumulate experience.
40. **No comms transcript** (11.5). Storage cost for no gain. Decision logs stay
    compact and ephemeral; nothing resembling voice is persisted.
41. **Total separation from the site** (12.1). The sim reads the library and
    writes nowhere near it. No sim-derived analysis is ever back-ported into the
    pattern finder, the round library, or any fitted model users see.

Resolved in the fifth pass (visualization):

42. **The belief is joint, not a product of marginals** (19.2). Bodies are
    conserved inside the filter, not just asserted in prose. The claim this
    makes, and it is testable: a tier-2 read is the product of the marginals, a
    tier-1 read is the joint, and the attention budget is what moves a bot
    between them.
43. **Threat is typed, and the AWP gets its own field** (19.3). Where a weapon
    class *is not* is the higher-value half, it is sharp because AWP spots are
    few, and it is a bitmap test rather than a model.
44. **Breadth is a priced decision, not a constant** (19.4). Value of information
    against the cost of delay, with three regimes falling out and no special case
    for entries. The compute cap and the tactical budget are different things and
    must stay different.
45. **Entry commitment is a team act** (19.5). Individuals commit to one angle;
    the team stays broad by partitioning the angles across bodies. Uncovered
    mass is the honest price of the entry and the reason not to go dry.
46. **Peeks are instruments and the bait is a two-body option** (19.6). Foresight
    prices pairs, and it stops at two, permanently.
47. **Support requests are first-class, priced, refusable, and delayed** (19.6).
    They carry an ask and never a percept.
48. **Three conservation laws: bodies, utility, money** (19.7). Every read about
    enemy intent is downstream of one of them, including why an unaffordable fake
    is not a fake.
49. **Lurks arm on observable events, not on calls** (19.8). The comm delay makes
    a called lurk timing impossible and a heard one free.
50. **Interrupts gain an `opportunity` class** (19.8). Every previous interrupt
    was a failure, which left the entire T-side upside unrepresented.
51. **Sacrifice is gated on trade geometry, never on courage** (19.9). If
    `tradeCover` is false the death is a donation. The anti-feeding defence is
    the grade, never a reward term.
52. **Executes are mined as effects and synchronization** (19.10), with repair by
    substitute, then degraded retrieval, then improvisation. Tiers 1 to 3 are a
    shortcut; tier 4 is the actual bot.
53. **Synchronization is anchored, not reactive** (19.11). Under a 0.5 to 1.5 s
    comm delay a team cannot sync by reacting to each other, so the anchor is a
    clock or an observable event, and the anchor itself is a tell.

Resolved in the sixth pass (the doctrine document):

54. **The doctrine is load-bearing** (20). `Counter-Strike 101` is the
    specification for the Playstyle AI, not background reading, and it supplies
    state, actions, priors, and grades as four separable jobs.
55. **Zones are computed per side from the belief, not painted** (20.2). Safe,
    risk, buffer, unknown are functions of reachability, sweep recency, and gate
    sets. The bomb-in-Safe rule is a mask.
56. **The macro action space is layer conversion, and it is map-independent**
    (20.3). The library call survives as a label on what the macro policy did,
    which is the same resolution 6.20 reached for formations.
57. **The four ledgers are the doctrine observation block** (20.4), snapshotted
    at 0:50 and 0:30, and they join the situation key.
58. **Keywords are presets over the arbiter** (20.6): a mask change, a risk
    distortion, and a trigger set. Commandable by a human, selectable by the
    policy, printable in the log.
59. **Negative information is a comm, not a fact** (20.7). This is the largest
    honesty hole found in six passes: free team-wide negative information made
    the game's most valuable call worthless.
60. **The zone owner is free, everyone else is bound** (20.8). Freedom and system
    are separated by geography rather than by degree, which is the document's own
    answer and the plan's answer to individual initiative.
61. **Risk posture is a function of state, not a personality constant** (20.9).
    Advantage lowers the quantile, disadvantage raises it, and the trait supplies
    the baseline and the spread.
62. **Predictability is an investment when a punish is planned** (20.10). The
    readability cost is signed by intent, and conditioning is a multi-round
    action owned by the Strategy AI.
63. **Which instinct to trust is one scalar** (20.10): the opponent model's own
    hit rate this match. Winning raises its weight, losing lowers it and takes the
    second-ranked call.
64. **In genuine novelty the budget collapses to zero** (20.11). Wrong but
    decisive beats right but late, so the visualization budget carries a novelty
    cap and a hysteresis lock.
65. **Clutch discipline is a mask** (20.12). At +2 or better, everyone peeks or
    nobody does, and isolated duels conceded is a graded number.
66. **The execute's assignment is solved, not memorized** (20.13). Chapter 16's
    argument is an argument about representation: encode the properties and the
    orders become derivable, which is also what makes repair and transfer free.
67. **Doctrine is a mask, then a price, then an expectation** (20.14), and
    deviation is licensed per bot per situation key out of the experience index.
    Brilliance is earned against the doctrine's own prior, scoped, revocable, and
    inspectable, which is why it is the pinnacle rather than the starting point.

Resolved in the seventh pass (operations):

68. **The panel is the control surface** (9.2, 9.2b). Generations and matches
    start, pace, and stop from /sim. Gradient steps still only run on a CUDA
    host, and when none is attached the panel says so rather than pretending.
69. **Prod never starves, rather than prod never trains** (9.2b, 14.29). Sim
    work on the production box is opt-in, capped, budgeted, in child processes,
    and preempted by demo parsing.
70. **The sim never reads the corpus** (9.2c). Three tiers: an always-resident
    index, per-map aggregates rebuilt incrementally, and individual rounds
    fetched by id. The working set does not grow with the library.
71. **Sampling is stratified and declared** (9.2c). Batches are drawn across
    map, side, call, tier, and economy, and every run records what it read.
72. **Stacked maps need no new architecture** (4.2, 14.6). One lattice per
    level, a body's floor from its z, and real floor transitions mined from demo
    z crossings rather than painted.

---

## 17. Prior art: bots that work in other games

Nothing in section 6 is invented. Every mechanism in the off-script architecture
is a thing that already beat humans somewhere else, ported to a game with a
53 degree cone and a bomb. This section is the map from there to here, so that
when a piece misbehaves it is clear which known recipe it came from and what that
recipe assumed.

### 17.1 Counter-Strike: the pathfinding is the good part

CS's bots aim like bots and navigate like professionals, and the navigation half
is fully documented in `source-sdk-2013` (`nav_area.h`, `nav_mesh.h`,
`nav_pathfind.h`, all Michael Booth, Turtle Rock, 2003). The mesh is convex areas
with directional connections, ladders, and painted attributes; the interesting
part is the offline **analysis** pass, which computes things our plan was going to
compute at runtime or not at all.

| CS structure | What it holds | Ours |
|---|---|---|
| `HidingSpot` with `IN_COVER`, `GOOD_SNIPER_SPOT`, `IDEAL_SNIPER_SPOT`, `EXPOSED` | Places to crouch and wait, classified by cover and sightline quality | Angle catalogue fields (6.8) |
| `SpotEncounter` / `SpotOrder{t, spot}` | Per path segment, the dangerous spots in the order they gain line of sight to that path | The clearing and pre-aim sweep (6.8), and negative information for the filter (5.5) |
| `m_earliestOccupyTime[team]` | Minimum time to reach this area from that team's spawn | The timing race, baked (6.8, 6.15) |
| `m_danger[team]` with a decay rate | Where this team has been dying lately, so bots avoid it | Per-match danger memory in the route cost (6.14) |
| `COMPUTE_MESH_VISIBILITY` | Area-to-area potential visibility | Visible and exposure sets (6.8) |
| A* with a cost functor, named route types | Fastest, safest, retreat as three functors over one search | Danger-aware routing (6.14) |
| `BotProfile.db` | `Skill`, `Aggression`, `ReactionTime`, `AttackDelay`, `Teamwork`, `AimFocus*`, look-angle spring constants per state | The trait vector (6.16), and a second opinion on the aim motor (8.1) |

Two design decisions in there are worth more than the data structures.
`ReactionTime` and `AttackDelay` are separate numbers, so noticing and shooting
are different faculties; we split them the same way across 5.7 and 8.1. And the
crosshair is a second-order spring with different stiffness and damping while
attacking, which is the same family as 8.1's critically damped rotation and a
useful sanity check on our constants.

What CS bots do badly, and why our plan does it differently: they have no belief
(they know or they do not), no team plan beyond a per-round scatter, no economy
sense, and difficulty is a single `Skill` number that mostly buys aim. Those four
gaps are sections 5.5, 6.13, 4.9, and 6.16 respectively.

### 17.2 FIFA and EA FC: shape, roles, and running at space

The most useful research in this whole section, because football has spent thirty
years on the problem CS bots have never solved: how do nine players who are not
involved in the current event decide where to stand.

**Space, not the ball** (FIFA 17, Active Intelligence System). EA's own
description of the change: player intelligence used to be based on where the ball
was and who had it, and runs were made relative to that; now players evaluate
where the defenders are, judge "if I can get into this space it is dangerous
space", and run there, including running into space a teammate has just vacated.
They shipped named run types out of it: runs in behind, dropping deep, showing
short, dummy and fake runs, orchestrated multi-player runs. Section 6.14 is that
idea with a control field instead of a pitch, and the run vocabulary transfers
almost word for word into CS.

**Formation versus roles** (FC IQ, FC 25). The formation is how the team defends
without the ball and the position everyone returns to; Player Roles govern
movement in possession and are what allow asymmetric, non-formation shapes. Each
role carries a Focus (one to three per role) that decides how it interprets the
role. Role Familiarity, assigned by a model over real-world data, makes players
better at roles they actually play and slower to transition in ones they do not.
Section 6.13 is the CS translation, with initiative standing in for possession and
the library standing in for Opta.

**Tell the user what the shape does.** FC IQ ships an Activity Map showing the
zones each role will occupy, and Smart Tactics surfaces in-match suggestions from
the game's own read of the flow. Both are directly buildable here (6.13, 11.3),
and both are the difference between a tactics screen and a spreadsheet.

**Anticipatory defence.** FC 25's patch notes list "Defensive Awareness when
Beat": defenders recognize they are *about to* be beaten and drop centrally before
it happens. The CS version is an anchor that gives up an angle it is losing and
resets to the next one instead of dying on it, which is 6.15's trigger table.

### 17.3 Football Manager: attributes wired to mechanisms

FM's match engine is a decision simulator running a slice every quarter second,
with players re-evaluating and able to change a decision mid-slice as the
situation develops. What matters for us is not the engine, it is the **attribute
model**: mental attributes are not a difficulty slider, they are each wired to a
specific faculty. Anticipation predicts events and reads movement. Decisions
chooses among options. Concentration keeps quality up over time. Composure holds
it under pressure, and the engine weights mental attributes harder in high-pressure
late-match moments. Off the Ball is movement into useful space; Positioning is its
defensive twin. Teamwork is adherence. Hidden attributes like Consistency and Big
Match Temperament govern how much a player varies from himself, which is the
surprise factor (6.9) modelled as a trait rather than as noise.

The community's ordering of those faculties is sharper than the manual and worth
encoding: concentration precedes anticipation, because a player who is switched
off is surprised even when their reading is good, and anticipation precedes
positioning, because reading the pass is what puts you where the interception is.
That is precisely the chain 5.7, 6.15 and 6.8 implement, in that order.

FM's tactical layer also converges on the same conclusions as the rest of this
document: space is what the engine actually evaluates (passing lanes, cover
shadows, numerical superiority zones, and a penalty for being too close together
or too far apart), pressing is trigger-based rather than constant, and the AI
adapts within a match by shifting intensity, exploiting overloaded zones, and
targeting isolated players rather than by rewriting its plan.

### 17.4 Dota 2: desires, and a hierarchy that admits it

Valve's shipped bots are a utility AI with a public API, which makes them the
best-documented arbitration layer in any live game. Every mode implements
`GetDesire()` returning 0 to 1; all modes are evaluated every frame; the highest
becomes active; only its `Think()` runs. Team desires are evaluated first and
separately (`UpdatePushLaneDesires`, `UpdateDefendLaneDesires`, `UpdateFarmLaneDesires`,
`UpdateRoamDesire`, `UpdateRoshanDesire`), and ability and item use runs on an
independent think so a bot can act with items while its mode is "retreat".
`GetDesire()` returning nil falls through to Valve's built-in calculation, and the
community's item layer returns a desire plus a **motive** for logging.

That is our architecture with different nouns, and section 6.17 adopts it
directly, including the two details that look like trivia and are not: the nil
fallback, which is the cleanest scripted-to-learned seam anyone has shipped, and
the motive string, which is the entire debugging story of the /sim page.

**OpenAI Five** is the other Dota lesson and lives in 9.10: five agents on one
reward need team spirit annealed from selfish to selfless, or early training has
no usable credit signal.

### 17.5 StarCraft II: managers, combat simulation, and the league

Two eras, both useful.

**The bot-competition era** (BWAPI, and the SC2 equivalents) converged on an
architecture that this plan has been reinventing: an Information Manager writing to
a shared blackboard, a Strategy Manager choosing the plan, a Squad Manager that
spawns one agent per group of units, and Combat Agents doing the individual micro.
The layer we were missing is the **squad** (6.16 in spirit, and now explicit in
6.13's shape): pairs and trios with a shared micro-objective, which is how CS is
actually played. PurpleWave's arbitration rule is the one to copy: it simulates
the battle, min-maxes tactical approaches for both sides ("charge in", "run away"),
and then the squad "takes the tactical suggestion under advisement, but behaves
independently". That is a better description of the Playstyle-to-Individual
relationship than "orders".

**SparCraft** is the ancestor of our foresight and search (6.7, 6.11): a fast,
deliberately abstract combat simulator, accurate about weapons, cooldowns and
speeds, explicitly not accurate about everything, used to decide whether a fight is
worth taking. Its authors are clear that it does not need to model the game
perfectly to be useful, which is the same bargain we are making with a 2D engine
and a fitted duel model. Bots also used **influence maps and potential fields**,
with the enemy threat radius computed as weapon range plus a margin plus speed
times the time you will be committed. We use that formula in 6.14.

**Persistent opponent memory** across a series, with strategies selected by their
success in previous games, is the other competition-era staple, and it is 6.10's
bandit.

**AlphaStar** contributes the modern half: the three-population league with PFSP
(9.12), `z` statistic conditioning from human replays so diversity is an input
rather than a hope (9.11), a supervised prior with a KL leash (9.4), and hard
limits on action rate and camera so the result means something (5.7, 8).

### 17.6 Everything else, briefly

| Source | What we take | Where |
|---|---|---|
| **Libratus / Pluribus** (poker) | Depth-limited search with several enemy continuation strategies; balanced ranges as unexploitability | 6.11, 6.9, 9.12 |
| **Fighting-game AI** (FightingICE, frame data) | Frame advantage as explicit state; safe pokes with bounded worst case; mixups and conditioning; capped reaction | 6.6, 6.8, 6.15, 6.10 |
| **Quake III bots** (Mr. Elusive) | Fuzzy weighted goal selection; per-bot character files as data | 6.17, 6.16 |
| **F.E.A.R.** (GOAP) | Actions with preconditions and effects, composed into legible plans | 6.6, the scripted planner |
| **AlphaZero / Leela** | Expert iteration; the value net is the product | 9.13, 9.14 |
| **Hanabi / BAD** | Infer teammate intent from actions, not from their state | 7.2, 6.10 |
| **GT Sophy** | Human-likeness as a hard term inside training, not a filter after it | 8.3, 9.8 |
| **Left 4 Dead AI Director** | Pacing as a designed dial, for practice modes only | 11.4 |

### 17.7 The five ideas that matter most

**Run at space, not at the ball** (FIFA 17). Everything else in this plan is
contact-reactive. This is the one change that makes five bots look like a team
rather than five people with the same map.

**Formation as the default, roles as the deviation** (FC IQ). It answers "what do I
do when nothing is happening", which is most of a CS round and which no bot in any
game has ever answered well by improvising.

**Precompute the danger along the path** (CS `SpotEncounter`). Ordered angle
clearing while walking, for one offline pass and zero learning.

**Attributes wired to mechanisms, not a difficulty slider** (Football Manager). It
is how "t2 team" becomes a personality instead of a handicap, and how the aim
envelope stays sealed while everything else stays adjustable.

**League with exploiters and `z` conditioning** (AlphaStar). Self-play against your
own latest checkpoint polishes one strategy forever; in CS that looks like ten bots
who have agreed on one execute and one hold.

### 17.8 What we deliberately do not take

- **Superhuman action rates.** AlphaStar needed APM caps and still got accused;
  we cap harder, and we cap decisions as well as mechanics (5.7, 8).
- **God-view actors.** Every one of these systems that shipped against humans
  restricted the agent's inputs. Ours reads the knowledge tracker or nothing
  (5.4), and the critic's omniscience never leaves training.
- **Self-play from scratch.** OpenAI Five could afford it; we cannot, and we do
  not need to, because 10,000 library rounds of human play are a better
  generation 0 than a month of random flailing.
- **Big networks and heavyweight runtimes.** MLP plus GRU, hand-rolled forward
  pass, weights as data (6.3, 9.2). No ONNX, no CUDA on prod, ever.
- **MCTS in the hot loop.** Search is budgeted, rare, and optional (6.11),
  because the 3D world cannot be forked.
- **An AI Director in competitive matches.** Pacing control is a practice-mode
  feature. A bot that goes easy on you silently is worse than no bot.

---

## 18. Experience: what a team carries between rounds

Everything in sections 5 to 8 is reset by the freeze. A team could lose the same
B execute nine times and walk into the tenth with a clean conscience, because
nothing in the architecture is permitted to remember round 9 during round 10.
That is not a small gap. It is the difference between a bot and a player.

### 18.1 Two axes: competence and experience

Split what a team is into two things that are stored differently, graded
differently, and improve at different speeds.

| | Competence | Experience |
|---|---|---|
| Stored as | Network weights | An index of situations, counted and scored |
| Learned by | Gradient descent over millions of rounds | Counting, one round at a time |
| Contains | What is true about Counter-Strike in general | What is true about *this* map, *this* opponent, *this* match |
| Improves | Slowly, in generations | Immediately, in rounds |
| Transfers | To every opponent | To the opponent it was learned from |
| Erasable | No | Yes, and that is a feature |

The brief's claim, that a 90%-perfect bot with 10,000 rounds beats a
99%-perfect bot with 10, is precisely the claim that the second column is worth
more than the first in the regime CS actually lives in: repeated opponents,
recurring situations, a 24-round match against the same five people. It is also
a claim that is easy to state loosely and easy to test exactly, so it is stated
exactly here (18.8) and tested by exam E10 (9.19).

Why not just let the weights learn it? Because gradients are the wrong
instrument for one-shot, opponent-specific facts. A gradient step averages over
every opponent in the batch, needs thousands of samples to move, and cannot be
undone when the opponent changes their setup at half. A count can be written
once, read immediately, scoped to one opponent, and thrown away at the swap. The
prior art is retrieval-augmented and episodic-memory agents (a differentiable
dictionary of state-value pairs read by nearest neighbor, which learns from a
handful of experiences precisely where gradient methods cannot), and the design
below is the tabular, inspectable version of that idea, chosen because an
inspectable memory is a product feature and a learned one is not.

### 18.2 The situation key: recognizing the map for what it is

Memory needs an address. The address is a **situation key**, computed at
decision points only, and deliberately coarse so that it collides usefully: two
rounds that a human would describe with the same sentence must produce the same
key.

```jsonc
{
  "v": 1,
  "map": "de_inferno", "side": "CT",
  "phase": "pre-plant",            // freeze | early | mid | post-contact | pre-plant | after-plant | retake
  "clock": "60-80",                // 20 s buckets
  "men": "4v5",                    // living counts, ours first
  "econ": "full-vs-full",          // from the economy inference (5.3), 4 buckets a side
  "control": "banana:T,mid:CT,apps:none",  // macro zone control signature (possession shares, 3-way)
  "start": "⊕3-1-1/slow-default",  // the snapshot read: formation, AWP lane, pace (6.20)
  "shape": "core3-A,lurk1",        // our cores and lurkers (6.18)
  "read":  "core4-believed-B",     // the enemy core read off the particle filter (5.5, 6.18)
  "util":  "us:med,them:high",     // remaining utility buckets
  "roles": "awp-alive,b-anchor-dead" // which contracts are still staffed (6.19)
}
```

Hashed, that is one string. Around 12 to 15 keys are written per round (freeze,
**the snapshot clock**, first contact, each man-count change, plant, each team
interrupt), which is the right resolution: a key per tick would never collide and
a key per round would collide with everything.

The `start` field is why the snapshot clock earns its place in the engine (6.20).
It is the one moment in the round where the team's intent is both already chosen
and not yet destroyed, so it is the field that makes memory rows *sayable*: "we
are 1-4 from `2-1-2` against a B stack on this map" is a sentence, and sentences
are what a retrieval system needs its addresses to be.

The key answers the four questions the brief asks, in order: **what the map is**
(`map`, `control`), **what we have** (`econ`, `util`, `men`, `roles`), **what we
know** (`read`, and the belief entropy that produced it), and **what we should
do** is what the index returns.

Exact keys are not always enough, so every situation also carries a **32-d
embedding** of the same underlying features, produced by the Strategy AI's torso
(9.14 auxiliary-head style, trained to predict round outcome from the situation
alone). Retrieval is coarse to fine: exact key first, then k-nearest neighbors in
embedding space among keys with the same map, side, and man-count, then the
library prior. Backoff is what stops a memory from being useless the first time
a slightly novel round happens, which is every round.

### 18.3 The experience index

One record per key, three scopes, one prior.

```jsonc
{ "key": "…", "n": 47, "w": 21, "sumDprw": -2.9, "gen": 14, "lastRound": 1183,
  "byCall": { "b-split": { "n": 12, "w": 8, "sumDprw": 1.4 },
              "a-default": { "n": 21, "w": 6, "sumDprw": -3.1 } },
  "byOption": { … },              // the same, at the individual decision level
  "attrib": { "call": 9, "exec": 12 } }   // why the losses happened (18.6)
```

**Three scopes, read together, weighted by specificity:**

| Scope | Contents | Half-life | Weight |
|---|---|---|---|
| Session | This match, this opponent | None, it is 24 rounds long | Highest per sample |
| Opponent | Every match against this opponent or this model id | 20 matches | Medium |
| Career | Everything this lineage has ever played | 5,000 rounds | Lowest per sample, largest n |

**The prior is the library, not zero.** Before a single sim round is played,
`roundFacts.js` can answer "how often does the CT side win from this situation,
in real games" for most keys, because the library is thousands of real rounds
tagged by the same call vocabulary. So the index starts at professional
knowledge and updates away from it with evidence, using a Beta posterior whose
pseudo-counts are the library's counts, capped so that a well-populated prior
does not become unmovable. This is the difference between a team that starts
knowing what CS players know and a team that has to lose 400 rounds to discover
that pushing B with no utility is bad.

Reading is a lower confidence bound, not a mean: a Wilson or Beta lower bound at
the 25th percentile, so a 2-and-0 record does not outrank a 40-and-25 one.
Writing is bounded, LRU by recency times count, sharded on disk under
`sim/experience/` and versioned by key version and library version, because a
key schema change invalidates every address in the file.

### 18.4 The Strategy AI: the third brain, and the only one that lives between rounds

| | Strategy AI | Playstyle AI | Individual AI |
|---|---|---|---|
| Scope | The match | The round | The bot |
| Ticks | Between rounds, plus advisory at team interrupts | Freeze plus team interrupts | 8 Hz |
| Reads | Match state, opponent model, the experience index | Team belief | Personal belief |
| Emits | Priors, budgets, postures, an avoid-set | The TeamDirective | Options |
| Samples per match | 24 | 24 to 80 | ~40,000 |

Its outputs are **priors and prices, never commands**. It does not pick the
round's call; it tilts the Playstyle AI's distribution over calls and the
Individual AI's desires:

- A prior over calls and over `z` statistics (9.11) for the coming round.
- A **risk posture** scalar feeding the confidence bias in 6.9, so a team that is
  behind actually plays like a team that is behind.
- An economy plan across this round and the next two, which is the one CS
  decision that is genuinely multi-round and which no per-round policy can make
  correctly.
- The utility budget split across role contracts (6.19).
- An **avoid-set**: situation keys with penalty weights, which reprice desires
  without ever removing legality (18.5).

Training it is a different problem from training the other two, and the mistake
to avoid is treating 24 samples per match as if they were 24 samples per second.
Three components, in the order they are built:

1. **A supervised value head**: `P(win | situation, call)` trained on the union
   of the library and all self-play, which is contextual-bandit learning, not
   RL. This is most of the value and it is available immediately.
2. **An adaptive selector**: EXP3 or Thompson sampling over calls inside a match
   (6.10), seeded by the head, which is what produces visible in-match
   adaptation on a 24-round horizon.
3. **Match-level RL last**: SMDP over rounds with γ = 1 and the round as a step,
   fine-tuning the head against the economy plan's long-horizon effects. Small,
   slow, and only worth doing once the first two are stable.

The architectural point that makes the whole scheme work: **the retrieved
statistics are inputs to the network.** The Strategy AI sees `n`, the lower
bound, the recency, the scope, and the attribution split for each candidate call
as features. So the weights learn *how to use memory* (when to trust 4 samples,
when a stale record is worthless, when the opponent has changed), while the
memory itself stays data. A new generation inherits the skill of using memory
and inherits, separately, the memory.

### 18.5 Avoidance without cowardice

"Recognize situations you keep losing and avoid them" has an obvious degenerate
solution: enter nothing, take no duels, let the clock run. Six rules keep the
avoid-set from finding it.

1. **Avoidance is relative to the alternatives at the same decision point.** A
   situation is penalized only against the best other branch reachable from
   where the team stands. When every branch is bad, the team takes the least bad
   one and plays. A losing position is a reason to choose carefully, never a
   reason to stop choosing.
2. **The evidence must beat the prior by a margin.** A record only moves a
   decision if its lower bound is materially below the library prior for the
   same key. Small-sample misery is noise, and noise should not change a call.
3. **Attribution gates the update.** Losing in a situation does not make the
   situation bad. It may mean somebody whiffed. Only losses the review
   attributes to the *call* update the situation's value; losses attributed to
   *execution* go to the mistake ledger and the training queue instead (18.6).
   This is the single most important rule in the memory design: without it, the
   Strategy AI learns to avoid every situation its worst bot has ever died in.
4. **Optimism keeps the team curious.** A UCB bonus on rarely-visited keys, so
   the index cannot ossify around generation-0 opinions and can discover that
   the B hit works now that the anchor rotates earlier.
5. **Scoping and decay.** What beat us three matches ago against a different
   opponent, at a different generation, is weighted accordingly. Every record
   stores the generation that produced it and is discounted by generational
   distance, because the team it describes no longer exists.
6. **The avoid-set never masks.** It reweights desires. Legality stays with the
   role contract and the option initiation mask, so no memory can produce a bot
   that refuses to play.

### 18.6 The post-round review: the bots coach themselves

A sim round is written in the parser's own format, which means the entire coach
stack runs on it unmodified. That is a large and slightly absurd amount of free
machinery: roughly 35 rules in five categories, PRW timelines, duel lookahead,
site-execute analysis, all of it already tuned against real demos.

**What a team is allowed to learn after the round is PRW and PFW, not
positions.** During the round, bots know what they and their teammates saw and
heard, and nothing else (5.1, 5.2, 5.8). After it, they get the round back in the
currency of the models: the round-win probability timeline and the fight-win
probabilities of the duels that happened, per situation. That is a precise and
defensible line, and it is worth understanding why it is the right one:

- It is what a real team actually gets. A team reviewing a round does not receive
  the enemy's coordinates for the seconds nobody saw them. It receives an
  understanding of which decisions were good and which fights were bad, which is
  exactly what a PRW timeline and a PFW per duel encode.
- It cannot leak into the belief. A model value attached to a *situation* is not
  a position, so there is no path by which round 9's review teaches round 10's
  particle filter where somebody stood. The honesty guarantee (5.4) survives
  intact, which it would not if reviews were god-view.
- It is the currency the rest of the plan already uses. Foresight prices in
  dPRW, duels price in PFW, and memory scores in both, so the review needs no
  translation layer and no second set of units.

So after every round, both teams run the review:

1. **Coach pass.** `analyzeDemo.js` produces flags. Carelessness, mechanical,
   quality, and synchronization flags go to the offending bot's ledger; praise
   flags go there too, because reinforcing what worked is half of learning and
   the repo already detects it.
2. **Find where the round was lost.** Walk the PRW timeline
   (`winProbability.js`, `roundDecided.js`) and take the k largest drops. Those
   moments are the round, and everything else is context.
3. **Ask what should have happened.** At the decision point preceding each drop,
   run the search (6.11) offline with a generous budget, and record its
   distribution. This is the **regret log**, and it is simultaneously the
   expert-iteration dataset (9.13) and the human review queue.
4. **Attribute.** If the search finds a materially better option that was
   available *to the same bot at that point*, the drop is execution. If every
   option at that point was already bad, the drop was decided earlier: walk up to
   the previous decision point and attribute there, repeating until the walk
   terminates at a call. This is credit assignment done with a model instead of a
   gradient, it costs milliseconds, and it is what lets a team distinguish "the
   B split was wrong" from "the B split was right and our entry lost a 70% duel".
5. **Write.** Situation-level results and attributions to the experience index;
   per-bot, per-position rule counts to the mistake ledger; disagreements to the
   training queue.

The offline search in step 3 is the one place the line has to be drawn carefully,
because a search that runs from the true world state is god-view by another name.
It runs from the **belief the team held at that moment**, replayed from the
tracker, with the enemy sampled from the particle filter. The question it answers
is therefore "given what we knew, was there a better option", which is the only
question worth asking about a decision and the only one whose answer is fair to
train on.

The mistake ledger closes the loop twice. Inside the match, the Strategy AI reads
it: "our B anchor has now lost three duels holding the same angle" is a fact
available at the next freeze, and changing that angle is a concrete decision.
Across generations, the ledger is a dataset, and the rules it counts are the
same rules that grade the generation (9.17), so improving the grade and
improving the play are the same activity by construction.

### 18.7 The late-round tablebase

Late rounds are the most visible skill in CS and the most tractable state space
in this document. Under a coarse abstraction, a post-plant 1v1 is small:

`(map, site, bomb position bucket, kit, clock bucket 5 s, attacker zone,
defender zone, weapon class each, HP bucket, utility bucket)`

That is a few million abstracted states for 1v1 and 1v2, which the engine can
solve offline: iterate values over the abstraction with rollouts under the
current policy, alternating best responses in the fictitious-play style until the
values stop moving. Store the value and the best action per state, ship it as a
weights-style data file, look it up in constant time.

Three uses, in order of value:

1. **Clutch play becomes exact** in the states that are covered. A bot that plays
   1vX at the level of a solved table is doing the single most watchable thing in
   Counter-Strike, and it requires no network at all.
2. **Foresight gets a true leaf evaluator** late in the round, replacing the
   fitted round model exactly where the fitted model is weakest.
3. **Exam E2 gets ground truth** (9.19): regret against a known optimum, with no
   population and no opponent involved.

The honesty caveat, stated up front: the table is optimal *within the
abstraction and against the policy class used to build it*, not
game-theoretically optimal for CS. Poker's endgame solvers carry the same
caveat and remain the strongest part of those systems. The abstraction bucket
boundaries are therefore versioned data, and the table is rebuilt whenever the
engine's constants change.

### 18.8 Memory is inherited; weights are only half the animal

A new generation starts with its parent's experience index, subject to a
validity check on key version, map version, and library version. Weights are
replaced every generation; memory accumulates across all of them. After 30
generations the career scope holds millions of rounds that no amount of
retraining would have reproduced, because most of what it holds is not
generalizable, which is exactly why it had to be stored rather than learned.

The ablation that turns the brief's claim into a number, run every ten
generations and printed in the generation report:

| Arm | Competence | Experience | What it isolates |
|---|---|---|---|
| A | Gen N | Empty | The weights alone |
| B | Gen N | Full career | The value of experience, `Δ_E` |
| C | Gen N-5 | Full career | Whether experience is worth five generations of training |
| D | Gen N | Opponent scope only | How much of `Δ_E` is opponent-specific rather than general |

If C beats A, the brief's claim is true in this system and we can say so with a
number attached. If C loses to A badly, the memory is decorative and section 18
needs rebuilding rather than defending. Either result is worth having, and this
is the only way to find out which one is real.

One failure mode deserves its own guard. Memory filled from self-play against
weak opponents teaches the team that bad calls work: the index would faithfully
record that a naive B rush wins 70% of the time, because against our own
generation-3 anchors it does. So the career scope only ingests matches against
pool members above an Elo floor, exploiter matches are quarantined in their own
scope, and the library prior is never removed from the posterior.

### 18.9 What experience looks like on screen

This layer is the most watchable thing in the plan and it should be shown, not
inferred. The motive strings (6.17) gain a memory clause:

> `call: b-split (0.68). motive: they have stacked A after every 2-0 start this
> match, 3 of 3, and this key is 4-1 for us lifetime with the prior at 0.52.`

The inspector gains a **Memory** tab: the retrieved rows behind the current call,
with `n`, the bound, the scope, the attribution split, and a link to every past
round the row was built from. Those rounds are watchable sim rounds (9.8), so the
chain from "the bot did this" to "here are the eleven rounds that taught it"
is two clicks and no explanation. A match view gets a "what the team learned"
timeline: each round where the avoid-set or the opponent model changed a call,
with the before and after.

Nothing else in this document produces a demo this good, and the machinery to
render it already exists.

### 18.10 Costs, limits, and the one rule that must not be broken

- **Determinism.** Retrieval is deterministic given the index file, but a memory
  that writes back during a match makes "same seed re-runs bit-identical" (9.8
  gate 5) false immediately. The rule: **the index is read-only for the duration
  of a round, and commits happen at round end, outside the tick loop.** The
  index hash is part of the match config (12.3) and part of the replay record, so
  a reproduction loads the same memory the original had.
- **Cost.** Around 24 hashed lookups plus a small k-NN per round, per team.
  Immaterial next to the engine.
- **Nonstationarity against ourselves.** Records describe a team that has since
  been retrained. Handled by storing the generation and discounting by
  generational distance, and by the Elo floor on ingestion.
- **Overfitting to the league.** The index can learn to beat our own bots
  specifically. The exploiter populations (9.12) are the detector: a champion
  whose advantage evaporates against a fresh exploiter was leaning on memory of
  a pool that no longer describes anything.
- **The 3D port.** Situation keys are abstract and survive the port unchanged,
  which is the point of writing them as buckets instead of coordinates. The
  *values* attached to them do not survive and must be re-validated against 3D
  play, and the tablebase must be rebuilt outright.

---

## 19. Visualization: the tier-1 faculty

### 19.1 What it is, and the four faculties it decomposes into

Visualization is the act of maintaining a live model of where the enemy is,
what they hold, and what they are about to do, and then choosing movement,
timing, and crosshair placement that beat *that model* rather than beating the
world. It is not perception and it is not aim. It sits between them, it is the
most expensive thing a player does per second, and it is where a tier-1 carry
and a tier-2 weak link differ most.

It decomposes into four faculties. Every mechanism in this section belongs to
exactly one of them, which is the only way to keep the section from becoming a
pile of clever features:

| Faculty | The question it answers | Machinery |
|---|---|---|
| **Enumerate** | Which whole-map layouts are consistent with what we know and what we have failed to see? | The joint belief (19.2) |
| **Type** | What does each of them hold, and what can it therefore do to me from where it is? | The threat field (19.3) |
| **Budget** | How much of this can I afford before the moment passes? | Value of information against delay (19.4, 19.5) |
| **Counter** | What act changes their state in my favour? | The repertoire (19.6) |

Weak players have a version of Enumerate (they know roughly where people are)
and a version of Counter (they know what a shoulder peek is). What they lack is
Type done sharply and Budget done at all: they cannot say where the AWP *is
not*, and they either check everything and arrive too late or check nothing and
die to the first angle. Both failures are budget failures, and both are
representable here as budget failures rather than as "worse aim".

Two constraints the whole section obeys, restated because everything below is
downstream of them:

- **Nothing reads engine truth.** Every quantity here is derived from percepts
  through the knowledge tracker, and the 5.4 honesty test extends to cover each
  new summary. Training-time labels for auxiliary heads are fine (9.14); actors
  never see them.
- **Surprise still comes from beliefs, preferences, and mixing** (6.9). A better
  visualization model makes bots *wrong less often and later*, which is exactly
  what the skill ladder in 8.4 is supposed to move.

### 19.2 The belief is joint: bodies are conserved

5.5 runs one particle filter per enemy slot. That is a product of marginals, and
a product of marginals is structurally incapable of the read the brief actually
asks for. It cannot say how many enemies are on a site, because independent
slots give a Poisson-binomial with the wrong variance and put mass on layouts
that never occur. It cannot say that clearing banana makes A *thicker*, because
nothing couples the slots. And it cannot express doctrine, because doctrine is
entirely about relationships: CTs do not double up on the same angle at the same
depth, Ts move in cores, a 2-2-1 is a real thing and a 5-0-0 is not.

So the filter becomes joint. One particle is a whole-map layout:

```
particle {
  slots: [ { node, gait, weaponClass, hasKit } × 5 ],   // null for dead slots
  weight, bornTick
}
N = 256 joint particles per team, update rate 8 Hz, engine PRNG (4.1)
```

Cost is roughly four times the old node-propagation work and still nothing next
to physics. The update rules from 5.5 survive verbatim, with three that get
strictly stronger because they now act on layouts:

3. **Negative information eliminates layouts, not points.** Clearing a cell
   kills every layout that placed anybody there, which *re-normalizes mass onto
   the rest of the map*. "Banana is empty" therefore makes "four on A" more
   likely for all five slots at once. This is how a human's read actually
   updates and it is structurally impossible under marginals.
5. **The kill feed is a hard constraint.** A dead slot is removed from every
   layout and the roster shrinks. Bodies are conserved, which is stated in 6.21
   as a fact about fakes and is now enforced as a fact about the belief.
7. **A co-occupancy prior, mined.** Propagation is biased toward layout
   *signatures* that real teams actually produce: per map, side, and clock
   bucket, the empirical distribution over zone-count vectors (`A:2, mid:1,
   B:2`), from the same library pass that builds the flow prior
   (`analytics/presenceRadar.js`, `heatImage.js`). This is what "based on
   experience" means concretely, and it is data rather than an authored rule.

**What the policy reads**, extending the derived summary in 5.5 (never the raw
cloud):

| Read | Meaning | Who uses it |
|---|---|---|
| `countDist(zone)` | Probability over 0..5 enemies in each macro zone | The team visualization the brief asks for, literally |
| `pEmpty(site)`, `pAtMostOne(site)` | The two numbers that decide whether a fast hit is free | Playstyle call selection, opportunity interrupts (19.8) |
| `layoutModes` | Top 3 whole-map signatures and their mass | What a caller says out loud: "they are either 3-2 or 2-3" |
| `splitEntropy` | Entropy over the zone-count vector | **The "we do not know the split" scalar.** This is the quantity that decides commit versus gather (19.4) |
| `staleness(zone)` | Seconds since our vision last swept it | Feeds the doctrine zone classifier (20.2) |

Two implementation notes that matter more than they look:

- **Depletion is the real risk.** Joint filters in five dimensions with sharp
  negative information can kill every particle, and a belief that has
  confidently deleted the truth is worse than a wide one. Mitigations, all
  standard: resample-move with a per-slot MCMC kick, stratified resampling by
  layout signature, the per-slot marginals retained as a *proposal* distribution
  for the joint target, and a hard floor that widens back toward the flow prior
  when effective sample size collapses.
- **Attention degrades the joint, and that is the whole point.** 5.7 gives each
  bot `k` slots at full fidelity. In a joint filter the natural degradation is
  that a bot keeps the joint structure only over its attended slots and
  marginalizes the rest. So the design's central claim becomes mechanical rather
  than rhetorical: **a low-attention bot's belief literally is the product of
  the marginals, and a high-attention bot's belief is the joint.** That is the
  tier-2 versus tier-1 difference, implemented as a budget rather than authored
  as a difference in competence.

Honesty and grading. The 5.4 test extends: feed the recorded percept stream and
the engine-generated one, assert the summaries match. Gate 9.8.8 gets a second
term, and it is the more important one: the belief must be **calibrated**, not
just close. When it says `P(exactly 2 on A) = 0.2` that should be true two times
in ten. Reliability diagrams and a Brier score per `countDist`, plus a dedicated
number for the `pEmpty(site)` call, because that is the read the whole T side
bets on.

### 19.3 Threat is typed: where the AWP is, and where it is not

Knowing that someone is on B is a fraction of the read. Knowing that the AWP is
on B, and therefore that the two mid angles are rifle angles held at rifle
depth, is the read. So the joint particle already carries `weaponClass` per
slot, and it is updated from percepts that exist or are nearly free:

| Evidence | Effect |
|---|---|
| Kill feed | Exact weapon of the killer. CS shows the icon; this is hard evidence and it is free |
| Gunshot percept | 4.7 delivers type, sector, and range band. Extend the type with a **weapon class plus a confusion matrix**: an AWP is unmistakable, an AK and an M4 are distinguishable, a Galil and an AK less so `[calibrate]`. This is the percept that carries the most information per byte in the game |
| Seen on contact | Collapses that slot's class (already `weaponSeen`, 5.2) |
| Economy inference | An eco round has no AWP. 5.3 bounds the class distribution before a single shot is fired |
| Drops seen, previous-round saves | Shifts the prior, same tracker |

From that, the quantity everything else reads:

```
threat(spot, yaw, class) = Σ_particles w · 1[ some living slot of that class
                                              has LOS to (spot, yaw) ]
```

computed as a bitmap test against the cached `exposureSet` of the angle
catalogue entry (6.8), so it is a lookup per particle per candidate spot rather
than a raycast. Cap the candidate set at the bot's top ~8 spots per step.

**The negative read is the valuable one, and it is sharp for exactly one class.**
A rifle can be anywhere; an AWP is only worth playing in a handful of spots per
map, and the nav bake already classifies them (`sniperQuality`,
`GOOD_SNIPER_SPOT` / `IDEAL_SNIPER_SPOT`, 6.8), while the library says which of
those a real AWPer on this map actually uses, and mimicry (10.3 layer 4) says
which ones *this* AWPer uses. So the AWP marginal starts small and collapses
fast: clearing three of six candidate spots concentrates the rest enormously. A
bot that has swept mid knows the AWP is on B without having seen anything, which
is the most human inference available in this document and it costs one bitmap
per particle.

What that buys, all priced through 6.7 rather than scripted:

- **Angle choice becomes weapon-aware.** A spot with high `awpThreat` and a
  large `coverDist` is a grave, and the hold-spot chooser avoids it or buys it
  down with utility. The same spot against rifle-only threat is fine.
- **Peek style becomes weapon-aware and range-aware.** Against a high-`awpThreat`
  long angle, the priced-best act is usually cheap information that also costs
  the enemy his shot: `jiggle` or `shoulder_peek`. Against a high-`awpThreat`
  *close* angle, a wide swing carrying maximum velocity is the classic answer.
  **This one needs verification before it is believed:** it is only correct if
  the fitted duel model's mover-speed term actually rewards crosser velocity
  against a scoped weapon at that range `[verify against paramSpec.js and the
  fitted weights]`. If `predictDuel` does not say so, that is a finding about
  the fitted model and it goes back to the duel trainer, exactly as 14.23
  requires. It does not get patched inside the sim.
- **Utility gets a target.** The highest-mass AWP hypothesis on the angle we
  need is precisely what a flash is for, which is the trigger for 19.6's request.
- **`pAtMostOne(site)` plus `awpMass` is the entry brief.** One defender, with
  the AWP, on a site with three approach corridors is a completely different
  problem from one defender with a rifle, and 19.9 is about that difference.

### 19.4 The visualization budget: when to widen, when to commit

The brief's sharpest question is when a bot considers every possibility and when
it commits to the most likely one. The current plan answers a different question:
6.7 caps foresight at twelve hypotheses and three options because that is what
the CPU can afford. That is a **machine budget** and it is a hard ceiling.
Underneath it there is a second, softer budget which is the tactical one: how
much of the ceiling to actually spend, paid for in **round clock and attention**,
chosen per decision.

The rule is the standard one and it is computable from prices foresight already
produces:

```
VOI  =  E_h[ max_a price(a | h) ]  −  max_a E_h[ price(a | h) ]
```

the gap between playing best-response to a *known* hypothesis and playing best
against the mixture. If every hypothesis agrees on the best move, VOI is zero
and more thinking cannot change the decision, so the bot commits immediately. If
the top two options swap under different hypotheses, the read matters and it is
worth buying.

Then compare it against what buying costs, which foresight already subtracts as
"clock burned":

```
widen   if VOI(next hypothesis batch) > dPRW_cost(the seconds it takes)
gather  if VOI is high but no amount of thinking resolves it, because the
        uncertainty is about the world rather than about the arithmetic:
        spend an *action* (jiggle, scout, listen, an HE into a smoke) instead
commit  otherwise: take the argmax against the modal hypothesis and stop
```

Three regimes fall out, and they match what humans do without anyone writing
three rules:

| Regime | State | Behaviour |
|---|---|---|
| Early, low clock pressure, high `splitEntropy` | Nothing is decided | Widen and gather. This is what a default round *is*, and it is now derived rather than scripted |
| Mid round, moderate pressure | A lean exists | Widen to a few hypotheses, commit to the modal one, keep one cheap contingency armed (`repeek`, `fall_back`) with a short `minCommitTicks` |
| Entry, or any closing window | The window shuts before the thinking finishes | VOI is dominated by the delay cost. Commit, pre-aim the modal angle, and **check nothing else** |

The third row is the brief's "skip every other potential angle", and it is the
same inequality rather than a special case. It fires hardest when a *timer* is
running: a punish window against a cycling AWP is worth roughly 1.4 seconds
(6.15), and inside 1.4 seconds no plausible VOI beats the cost of spending one
of them looking somewhere else.

**Traits wire straight into this** and this is where the trait vector (6.16)
finally earns its keep on the decision side rather than the motor side:
`anticipation` sets how far ahead the budget may look, `concentration` sets how
much budget exists and how fast it decays, `decisions` sets whether the argmax is
actually taken, and `composure` shrinks the budget under pressure. A low-composure
bot collapses its breadth prematurely in a 1v2, which is exactly what a tier-2
player does in a clutch, and it is now a mechanism rather than an adjective.

**Drain.** 5.7's attention budget already decays over round time under
`concentration`. Make the decay rate a function of cumulative visualization
spend, so thinking wide early costs `k` late. This is the most speculative
mechanism in the section and it is marked as such: the falsification is whether
pro demos show late-round decision quality degrading with early-round
complexity, and if they do not, it is dropped rather than defended
`[calibrate, and be willing to delete]`.

**The cap that stops this from being a naive information-maximizer** is in
20.11: when the situation is genuinely novel, widening is *wrong*, and the
budget collapses to zero deliberately. A naive VOI agent widens exactly when it
is most uncertain, which in Counter-Strike is precisely when it should pick a
direction and go.

### 19.5 Entry: commitment is a team act

The tension in the brief is real: an entry who visualizes four angles pre-aims
none of them and dies to all four, but a team that only ever looks at one angle
walks into the other three. Both halves are true and the resolution is
structural rather than a compromise.

**The team visualizes broadly, partitions the breadth across bodies, and each
body commits to one slice.**

At the moment an execute commits (the pace type's commit window, 6.20), solve an
assignment:

```
clearPartition:
  angles = the spot-encounter list (6.8) for the entry corridor, filtered to
           entries whose belief mass clears a floor, typed by threat (19.3)
  bodies = the pack, ordered by arrival time along the corridor
  cost(body, angle) = −[ mass(angle)
                         × P(body wins there | pre-aimed, typed threat)
                         × P(traded | body dies there) ]     (6.8 tradeCover)
                     + arrival mismatch penalty
  solve Hungarian, the same solver spawn choice uses (4.12) and the same fix
  the space field needs (14.37)
```

The first man pre-aims the highest-mass angle **and nothing else**. The second
takes the second. Angles nobody can cover form the **uncovered set**, and its
total mass is the honest price of the entry.

Four things this produces that the plan could not previously express:

1. **A derived reason not to entry dry.** If uncovered mass is too high, the
   correct act is not courage: it is to buy an angle down with utility, gather
   first (19.4), or pick another corridor. Bots that refuse bad entries for a
   *stated* reason are a different product from bots that refuse them because a
   threshold said so.
2. **A target for the flash request.** The highest-mass uncovered angle is
   exactly what you ask a teammate for (19.6).
3. **A grade for the read, separate from the duel.** Post-round, was the killer
   in the covered set or the uncovered set? Covered means the read was right and
   a duel was lost. Uncovered means the read or the partition was wrong. That is
   18.6's attribution applied to entries, and it feeds the mistake ledger with a
   distinction that no coach rule currently makes.
4. **Man-down execution for free.** With one body fewer the assignment simply
   re-solves over the remaining bodies and the uncovered mass rises, which is
   the correct and automatic answer to "we lost someone, do we still go".

The partition depends on arrival order, arrival order depends on spacing, and
spacing depends on the synchronization anchor (19.11). Those three interlock and
that interlock is what the brief calls synchronization.

### 19.6 The counterplay repertoire, and asking for help

The reframe that makes this section coherent: **a peek is not a way to see, it
is a way to change the enemy's state.** Four acts, each with a consequence in a
model that was fitted on real demos rather than in a rule somebody wrote:

| Act | State change it creates | Term it moves | Who collects |
|---|---|---|---|
| Shoulder peek, jiggle | Draws the shot. The AWP is now cycling, the rifler is in recoil recovery, both have committed a crosshair to a place I am no longer in | `cycleW`, and their `crossW` against the next body | **A teammate**, inside the window |
| Wide swing at velocity | Maximizes the tracking they must do, buys the angle outright | the mover-speed term `[verify]` | Me, if pre-aimed |
| Flash over | Deletes the hold for 2 to 4 s | vision test fails, `infoW` flips | The entry |
| Molotov the anchor | Denies the spot and forces a reposition into a *worse* catalogue entry | `crossW` via the forced pose, `coverDist` | The pack |

Row one is not a solo action and the current option layer models it as one. So:

**Paired options.** A bait and its punish are one decision with two bodies and a
shared timer.

```jsonc
// shared/sim/options.js
{ "id": "bait_shot",
  "params": { "spot": "banana_car", "style": "shoulder", "partner": "bot4",
              "windowMs": 1400 },
  "pairs":  { "partner": "punish_window", "armOn": "shotHeard | shotSeen" } }
```

The peeker's price is **the partner's dPRW inside the window**, minus the
peeker's own risk of being clipped. That is a different price shape from
anything single-body foresight can compute, so `foresight.js` gains joint
pricing over **two** bodies. It stops at two, deliberately and permanently: two
is where Counter-Strike's coupling actually lives (trade pairs, bait and punish,
entry and refrag), and the combinatorics past two are neither affordable nor
true to the game. The same extension serves 19.9, so it is one piece of
machinery for two features.

**The support request.** A bot that prices "I would take this angle if it were
flashed" currently has no way to say so. Utility is budgeted top-down and thrown
by its owner, which means the most common sentence in competitive CS has no
representation.

```jsonc
// shared/sim/comms.js, subject to the 0.5 to 1.5 s delay (5.1)
{ "type": "request",
  "what":  "flash" | "smoke" | "molotov" | "trade" | "info",
  "where": "banana_logs",      // an angle-catalogue entry or a zone
  "by":    4.2,                 // seconds; the request expires
  "worth": 0.061 }              // the requester's dPRW gain if it is served
```

Serving it is an ordinary priced decision by the receiver: does `worth`,
discounted by comm delay and travel time, beat what he would otherwise do with
that grenade and those seconds? **He is not obliged**, which is correct, because
good teams refuse bad requests. Role contracts scope it: the teammate holding
that lineup in his `utilBudget` (6.19) is the natural servicer.

Three consequences worth having:

- The decision log reads like comms without a comms transcript existing, which
  keeps decision 40 intact: requests are structured, tiny, and ephemeral.
- **Unserved requests are a diagnostic.** A team whose entry asks for the same
  flash every round and never gets it has a budget bug or a sync bug, and it is
  one counter rather than an investigation.
- It must never become a back channel that defeats the comm delay. A request
  carries an ask and no percepts, and it pays the same delay as everything else.
  Cap requests per bot per round and let them die on their deadline; a request
  storm is a real failure mode and the cap is the only defence.

**Mechanical texture, because the brief asks for it explicitly.** A shoulder
peek is defined by showing *just enough*: step out to the point where my
`exposureSet` first intersects the threat's likely spot, hold at most N ticks,
counter-strafe back. Whether a bot actually shows just enough is then a
mechanical property, so 8.2's profile gains two constants, both clamped inside
the pro envelope: `counterStrafeError` (milliseconds late on the release) and
`peekDepthError` (units past the intended exposure point). A weak bot's shoulder
peek genuinely over-exposes and gets punished for it, which is a *specific*
mistake rather than generic worse aim, and that is the entire philosophy of 8.4.
Mimicry already mines peek style per player (10.3 layer 4); these two constants
are exactly what it should be fitting.

### 19.7 Reading the buy: three conservation laws

Every read a good player makes about enemy intent is downstream of something
being conserved. Naming the three turns a pile of heuristics into one idea.

**1. Bodies.** Five minus the kill feed, enforced by the joint filter (19.2). A
fake with four bodies committed to A is not a fake. Already stated in 6.21;
now it is enforced in the belief rather than asserted in prose.

**2. Utility.** The enemy's inventory is bounded by what their buy could contain
and decremented by every detonation we saw and every throw we heard. Two
consequences, and the second is the brief's own example:

- **The late round is a count, not a guess.** A CT side that stopped a 1:40 rush
  with three molotovs has bought the early round with the late one (6.22 rung 7),
  and the T side can *know* this rather than sense it.
- **A fake must be affordable.** `P(fake | two smokes on B)` falls as their
  believed utility falls, because a side that cannot pay for both sides cannot
  buy a convincing lie. This drops straight out of the inventory tracker with no
  new rule, and it is exactly the inference the brief describes.

**3. Money.** 5.3's econ tracker is upgraded from "a class" to a distribution
over loadouts with a spend history, using inputs it currently ignores: the loss
ladder is public, drops are observable, saved weapons carry forward, and,
critically, **absence of evidence is evidence**. A side that shows nothing for
forty seconds is saving, stacking, or deliberately hiding, which is three
hypotheses rather than a default.

Then the behavioural layer, which is what the brief actually wants. **Economy
conditions the priors, never the rules:**

- The **flow prior** (5.5) is conditioned on `(map, side, clock, econPair)`,
  mined from the library, which already carries econ digits per round. "CTs on
  SMGs against a full buy stand here and push this often" becomes data.
- The **enemy call prior** in the tendency tracker (6.10) is conditioned the same
  way, and `aggCtSpread` already conditions its setup distribution on economy
  state, so half of this is shipped.
- The **enemy's risk posture is derived, not mined.** 6.7's second consequence
  says a side priced out of a fair fight correctly seeks variance. Run that same
  logic on the *opponent's* inferred economy and the belief should expect a
  disadvantaged enemy further forward, more stacked, and off their default
  angles: gamble stacks, smoke pushes, and early aggression, exactly as the
  brief describes. This is the first place the plan turns its own decision
  theory around to predict the opponent, it costs nothing, and it is internally
  consistent by construction.
- **Our own buy is a tell we manage.** Not firing, not showing utility, and not
  revealing weapons on a thin buy are deception acts under 6.21's cost function,
  with the enemy's econ posterior as the thing being moved:
  `deceptionValue = ΔPRW_from_their_wrong_econ_read − exposureCost`. That
  produces a bot holding a deep angle with a pistol who declines an available
  but marginal shot because taking it tells them what he has. It is a very
  high-level behaviour and it needs no new machinery.

**Momentum**, which the brief also names, is the weakest-evidence item here and
is treated accordingly. Score, streak, and the loss ladder are public, so a
momentum feature is free; whether it *means* anything is an empirical question
the library can answer: controlling for economy, do real teams play measurably
differently on a three-round streak? If yes, it conditions the posture prior. If
no, it is deleted rather than kept as flavour.

### 19.8 Lurks: a second clock, and the opportunity interrupt

Three problems, three answers.

**A lurk runs on the pack's clock, not its own.** So a lurk order is a
conditional contract with a teammate-generated trigger rather than a route:

```jsonc
{ "to": ["bot2"], "position": "a-lurk", "task": "lurk",
  "arm":   { "on": "pack_contact(B) | pack_committed(B) | clock<0:55",
             "lead": 4.0 },          // from the mined first-arrival table (5.6)
  "goal":  "cut(mid→B rotation) | take(A) | info(A)",
  "abort": { "on": "pack_aborted | seenBy>=1 | men<=2" } }
```

The lead comes from data: how long after A contact does a CT actually leave mid,
per map, and per team where the sample allows. Under comm delay the lurker
cannot be *told* the pack made contact in time, but he can **hear** it, so the
trigger's observable is a percept. That is both correct and free, and it is the
first of several places where the comm delay stops being an obstacle and starts
being the reason the design has the shape it has (19.11, 20.7).

**The lurk is priced, not assigned.** 6.18 already says leaving the core is a
decision. The addition is that its value is dominated by `P(they are not looking
here)`, which is estimable two ways: `exposure.js`'s `pKnowsMe` (5.6) and the
enemy-belief auxiliary head (9.14). And because the lurk's value is conditional
on what the pack does, it is priced jointly with the pack's plan using the same
two-body foresight from 19.6.

**Success needs its own interrupt class.** Every trigger in 10.2 is bad news:
deaths, blocked paths, missed windows. Nothing in the taxonomy notices that the
round just got better, which is the entire payoff of a lurk. So:

**`opportunity`**, a fourth class, promoted to a team replan under stricter
conditions than a failure, because chasing every piece of good news is its own
pathology:

- A lurker's kill on the far side (the canonical case).
- A zone's `countDist` collapsing onto zero (19.2).
- The AWP confirmed dead, or confirmed on the far side (19.3).
- A pack kill that opens a corridor with `tradeCover` still intact.

Then the brief's route question. With the far site now believed thin, the bomb
carrier chooses among routes priced by the space field's `control(c, τ)` and
`danger(c)` (6.14), using a **carrier-specific cost functor**: the bomb is a
conserved object, and losing it in neutral ground costs more than losing a body,
because a dropped bomb in contested territory can end the round on its own. So
the functor adds `P(die on route) × cost(bomb dropped in that zone)`, and the
choice between the slow rotation through ground we control and the fast one
through neutral ground becomes two numbers and the clock rather than a rule.
Which one wins changes with the clock, which is exactly the point.

One more consequence worth stating because it produces correct behaviour for
free: **a lurker's kill is the loudest exposure event in the game.** The moment
he kills, the enemy knows a lurker exists and roughly where. His post-kill
options are therefore priced against `pKnowsMe` spiking toward 1, which is why
good lurkers relocate immediately, and 5.6 already represents it.

### 19.9 Refragging: dying on purpose, and the geometry that makes it pay

The brief's hardest question, and the naive implementation (reward the bot for
dying usefully) is reward hacking with a bow on it. Four parts.

**The corpse is the sharpest percept in the game.** Make the death record
explicit in 5.1 and in the joint filter's update rules:

```
deathRecord { victim, tick, pos, victimYaw, killerWeapon, headshot?,
              penetrated?, shotBearing }
```

All of it is legitimately available: the kill feed is global and carries the
weapon, the body's position is known, and the damage direction sector is already
granted instantly (5.1). The belief update is a **hard likelihood**, not a soft
reweight: keep only layouts in which some slot of that weapon class had LOS to
that cell at that tick. Against the cached `visibleSet` bitmaps that is a lookup,
and it typically collapses the belief onto a handful of spots. This is how a
human knows where the killer is without having seen him.

**The window.** The killer's post-kill state is known and decaying: an AWP
cycling for about 1.4 s (already a trigger in 6.15), a rifle in recoil recovery,
a crosshair committed to a corpse, and a strong tendency to reset to cover
within a second or two. So `refrag(enemySlot)` is armed by the death event with
a hard timer and a price that falls off a cliff. **That timer is what forces the
skip-every-other-angle behaviour**, through 19.4's inequality rather than
through a special case: with a window closing in 1.4 s, no plausible VOI beats
the cost of spending one of those seconds looking elsewhere, so the bot pre-aims
the killer's most likely cell and takes nothing else into account. The brief's
question is answered by the general rule, which is the only kind of answer worth
having.

**When to run at a death you expect.** Willingness is `deathPermission` (6.19),
but the clause that matters is that it is **gated on the geometry that makes the
death productive**, never on courage:

```
sacrificeIsPriced(entry) iff
    tradeCover(entrySpot, partnerSpot) holds inside the trade window, AND
    the partner's arrival lands inside the killer's exposure window, AND
    dPRW( P(die)·[traded + space + information] + P(live)·[entry won] )
        > dPRW(wait)  and  > dPRW(reroute)
```

If `tradeCover` is false, the death buys nothing: that is a donation, not a
sacrifice, and the difference is computable **before the peek**. This is the
direct answer to how a bot knows when to rush at its own death. Not hope. The
partner's geometry, the partner's arrival time, and the price.

Walking the brief's own scenario, because it exercises the whole section: the
joint belief says `pAtMostOne(B) = 0.8`; the threat field says that one holds
the AWP; an AWP holds one angle at a time and the approach's `angleCount` says
there are three. So the first body's death **reveals which angle he chose**, and
that collapses the belief for everyone behind him. The first entry is buying
information as much as space, and the information is worth exactly the mass it
removes. That value is only visible if foresight propagates the belief to the
option's arrival time before pricing it, which is 6.15's first change: this is
the case where that change pays for itself.

**The anti-feeding defence is the grade, not the reward.** Nothing here adds a
reward term for dying, and nothing should: under a shared team reward with team
spirit annealed toward selfless (9.10), a bot that is paid to die will find a
way to die. The defence is that untraded-death rate and contract compliance are
already scorecard metrics in pro bands (9.17 teamwork axis), and 9.24's gate 10
fails any generation that regresses an axis while Elo rises. A team that learned
to feed passes Elo and fails teamwork, loudly.

Finally, `deathPermission` should be **mined rather than typed**: what fraction
of a real Inferno T entry's deaths are traded inside the window, and what is the
pro distribution of the dPRW at which entries die? Both are computable from the
library with `duelLookahead` and the trade window, which makes the constant a
fitted distribution, and mimicry can then set it per player from exactly the
signal 10.3 already mines ("when they trade versus when they save themselves").

### 19.10 Executes as effects, and repair under chaos

The brief asks how Vitality runs an A execute, and then asks the better
question: what do we do when we do not have the utility that execute assumes.
The current plan cannot answer it, because retrieval stores **tapes and
lineups**, and a tape with a missing grenade has no representation except
failure.

So mine executes as **effects and synchronization**, not as positions and
throws:

```jsonc
{ "id": "inf-a-exec-vitality-3", "map": "de_inferno", "side": "T",
  "call": "a-execute", "source": { "team": "Vitality", "n": 11 },
  "steps": [
    { "id": "s1", "effect": "denySightline", "from": "library", "to": "apps-exit",
      "means": ["inf_smoke_lib_1", "inf_smoke_lib_2"],
      "window": [-3.0, +14.0], "actor": "role:2ndMid" },
    { "id": "s2", "effect": "denySightline", "from": "ct-spawn", "to": "site",
      "means": ["inf_smoke_ct_*"], "window": [-2.5, +14.0], "actor": "role:Ramp" },
    { "id": "s3", "effect": "grantExposure", "at": "pit", "means": ["inf_flash_pit_*"],
      "window": [-0.4, +2.0], "actor": "role:Banana", "requires": ["s1", "s2"] },
    { "id": "s4", "effect": "deliverBodies", "to": ["apps-exit", "short"],
      "count": 2, "spread": 1.2, "window": [0.0, +1.6],
      "actor": "core:pack", "requires": ["s3"] }
  ],
  "anchor": "s3.detonate",
  "outcome": { "n": 11, "sitesTaken": 8, "plants": 7, "prwDelta": +0.21 } }
```

Every field is minable from what the parser already stores: grenade events give
throw and detonate ticks and paths, `sightRay.js` plus the angle catalogue turn
a detonation into the set of sightlines it deletes, tick tracks give body
arrivals, and `coach/siteExecute.js` already computes synchronization spread.
`scripts/sim-mine-executes.mjs` is a sibling of `sim-mine-lineups.mjs`, and it
clusters across a team's rounds to get the modal structure **plus its variance**,
which matters because the variance is the honest bound on timing jitter (6.22
rung 6) and on how much a repair is allowed to deviate.

Then the ladder, which is the brief's question in the brief's own order:

| Tier | When | What happens |
|---|---|---|
| **1. Run it** | Preconditions satisfied | Execute the DAG. Timing tolerance is the mined variance, never zero |
| **2. Substitute** | A `means` is gone but the *effect* is still achievable | Any lineup whose blocked-cell set covers the same sightline is legal. A molotov that denies the hold can stand in for a flash that blinds it. A body with `deathPermission` can stand in for a flash by eating the angle. Substitution is computed from geometry, so it needs no table and no author |
| **3. Retrieve a degraded case** | The effect cannot be produced at all | Re-query the library for rounds with the same call **and the same missing resource**: A executes run with no CT smoke exist in the thousands, because pro teams also run out. The retrieved case supplies a different structure: later timing, a different corridor, more bodies through one door |
| **4. Improvise** | Nothing matches | Hand the execute's *goal* (these sightlines denied, these bodies onto these angles, by this clock) to the option layer as an objective and let foresight price it against the joint belief. This is not a degraded fallback. It is the rest of section 6 |

The honest statement that keeps this from being a shortcut culture: **tiers 1 to
3 are a prior and a saving of effort; tier 4 is the actual bot.** If tier 4 is
bad, the first three tiers only hide it, and they hide it exactly in the rounds
that matter. So the eval must test degradation on purpose (exam E11, 9.19): run
the commanded execute with a grenade removed at random and compare the drop in
site-take rate to the library's own drop under the same degradation.

Two interlocks worth naming. The situation key already carries a utility bucket
(18.2), so "our A execute without the CT smoke is 2 and 9 this lineage" is a
retrievable memory rather than a fresh guess every time. And our own executes
are readable: run `aggTells` at our own rounds (6.9, 6.21) and a template with
no timing jitter will be detected and charged, which is why the mined variance
is carried as data rather than collapsed to a median.

### 19.11 Synchronization under comm delay

With a 0.5 to 1.5 s comm delay drawn independently per message (5.1), **a team
physically cannot synchronize by reacting to each other.** Five bots cannot go
on a call that arrives at five different times. Synchronization therefore has to
be pre-agreed at the last common moment and anchored to something every
participant can observe locally.

Two anchor types, both real, both already available:

| Anchor | Example | Property |
|---|---|---|
| **Clock** | "go at 1:32" | Exact, needs no percept, and is readable by an opponent who is counting |
| **Event** | "go on the CT smoke" | Self-correcting under drift, needs only a percept everyone gets (a detonation is seen or heard), and is what real teams mostly use |

The TeamDirective gains a `sync` field, and role contract `window` clauses
(6.19) are measured relative to the anchor rather than to the round clock.
Deviation from it is the synchronization spread that `coach/siteExecute.js`
already measures against real teams, so the metric ships with the feature.

Four consequences:

- **The comm delay stops being a nuisance and becomes the reason executes have
  the structure they have.** Decision 8 made the delay a v1 commitment; this is
  the first place the design uses it rather than working around it.
- **The anchor is a tell.** A team that always goes on the smoke can be timed,
  so the anchor choice is mixed by the same machinery as everything else (6.9).
- **A dead player's call is late by construction.** 5.8 lets dead bots fire team
  interrupts, and under delay a mid-execute call from a dead player arrives
  after the window. That is correct, and it is precisely why the pre-agreed
  anchor matters more than the caller.
- **Partial breaks re-solve rather than abort.** If a body is late past
  tolerance, the pack either waits (paying clock and anchor freshness) or goes
  short-handed, and going short-handed is just `clearPartition` (19.5) re-solved
  over fewer bodies. Priced, not scripted.

### 19.12 Costs, gates, and exams

**Cost.** Joint filter at 256 particles per team per 8 Hz step, roughly four
times the marginal filters it replaces. Threat field is one bitmap test per
(particle, candidate spot) with candidates capped at eight per bot per step.
Paired foresight is two bodies and top-two paired options, and only in entry,
bait, and trade contexts. Execute DAG matching is a few dozen precondition
checks once per execute. `clearPartition` is an 8×5 Hungarian once per entry.
All of it is off during bulk RL rollouts under the same rule as the rest of
foresight (6.7), with the outputs surviving as observation features so the
network internalizes the pricing rather than depending on it.

**Observation additions** (7.2): a joint-belief block (`countDist` per macro
zone, `splitEntropy`, top layout modes and their mass), a threat block
(`awpThreat` and rifle threat at my spot and my top-two candidates, plus my
partition slice's uncovered mass), a budget block (VOI of the current decision,
seconds affordable, breadth actually used), a pair block (my paired partner and
the window remaining), and a request block (outstanding requests to and from me).

**Gates added to 9.8:**

- **Belief calibration**, not only KL: reliability of `P(k in zone)` by Brier and
  ECE, with `pEmpty(site)` reported separately because that is the number a
  round gets bet on.
- **Commitment texture**, two-sided: the distribution of how many angles the
  first entry pre-aims, against the library's own. A bot that never commits and
  a bot that always commits both fail.
- **Sacrifice quality**: entry traded-death rate, and the share of entry deaths
  whose killer was in the covered set of the partition.
- **Request health** is a *diagnostic and not a gate*, honestly labelled,
  because demos do not record comms and there is therefore no pro baseline to
  band it against. Requests per round, served fraction, and expired fraction get
  printed and watched.

**Exams added to 9.19:**

| Exam | Setup | Scored on | Pass band from |
|---|---|---|---|
| **E11 Degraded execute** | Commanded site take with one grenade removed at random | Site-take rate drop versus the library's drop under the same degradation | Library executes with the same missing resource |
| **E12 The AWP read** | An AWP placed in one of six sniper-quality spots, unknown | Seconds to locate, deaths to it, and whether `awpThreat`'s argmax matched the truth *before* contact | Library equivalents `[mine the comparable set]` |
| **E13 The sacrifice** | 4v1 site take against an AWP | Traded-entry rate and site-take rate | Library 4v1 site takes `[mine the comparable set]` |

---

## 20. The doctrine layer: Counter-Strike 101 as an architecture

### 20.1 What the document is, and what job it does here

`Counter-Strike 101` is a complete tactical doctrine: sixteen chapters covering
zone and layer theory, utility doctrine, five levels of communication, keywords
and pace, threat levels, antieco, buy versus buy on both sides, macro, tug of
war and conditioning, system and roles, risk management and the T-side 4v5,
adaptation, clutch discipline, and a closing argument that understanding beats
memorization. It is written for elite human players making the step to tier 1.

For this project it does four separate jobs, and keeping them separate is the
whole trick:

| Job | What it supplies | Where it lands |
|---|---|---|
| **State** | Zones, layers, ledgers, threat level: a description of a round that is map-independent and small | 20.2, 20.3, 20.4 |
| **Action** | Layer conversion, protocols, keywords, blocks: what a caller actually decides | 20.3, 20.5, 20.6 |
| **Prior** | What a good team does by default in each situation, with the reasoning attached | 20.5, 20.9, 20.14 |
| **Grade** | Sixteen chapters of competencies, each of which is measurable | 20.15 |

The single most important thing it is **not** is a script. Chapter 16 makes that
argument better than this plan could: the B-execute utility assignment is
derived from properties (molotovs are thrown from close and burn out fast, so
the second man carries them; smoke positions sit near the entry pair, so the
third man smokes; flash lineups are furthest away and flashes are thrown last,
so the lurker carries them and arrives late), and a player who understands those
properties never has to memorize the order. That is a statement about
representation, and it is the design brief for everything below: **encode the
properties, not the orders, and the orders become derivable.**

### 20.2 Zones are computed, not painted

Chapter 1 defines four zone types, and the definitions are precise enough to
implement directly. Crucially they are defined **relative to a side's knowledge**,
which means they are a function of the belief and the nav graph rather than a
map author's paint. `shared/sim/zones.js`, per side, at 4 Hz over the named zone
graph:

```
reach(Z, τ)   P(some living enemy can be inside Z within τ), from the joint
              filter (19.2) geodesically inflated over the nav lattice
hold(Z)       we have a living body inside Z, or with LOS into it
swept(Z)      seconds since our vision last covered Z (negative information)
gate(Z)       the set of zones every path into Z must cross

Unknown   swept(Z) is stale AND belief mass in Z is above a floor
Risk      hold(Z) AND reach(Z, τ_short) > 0
Buffer    not hold(Z), both sides can reach it, and it lies on gate(S) for
          some zone S we classify Safe
Safe      hold(Z) AND every zone in gate(Z) is classified Risk or Safe
```

The Safe clause is a literal transcription of the doctrine's own sentence, "an
enemy cannot reach you here without first taking another zone", expressed as a
reachability query on the nav graph against the belief. It is cheap, it updates
live, and it means the map paints itself differently for each side every second,
which is what the doctrine actually describes and what a static zone layer never
could.

What immediately follows, with no further design:

- **The bomb rule becomes a mask.** "The bomb must never leave a green zone
  until the path is secure" is a hard constraint on the carrier's option
  initiation set (6.6), relaxed only by an explicit directive. This is the
  cheapest high-value rule in the document, it is checkable every tick, and
  every FPS bot ever shipped gets it wrong.
- **Buffer becomes a *thing to trade*.** The doctrine says losing a buffer costs
  the enemy utility and exposure to take it back. That is exactly
  `deceptionValue`'s shape and it prices a deliberate withdrawal, which no bot
  in any game does on purpose.
- **The zone ledger (20.4) writes itself**, and so does the `control` field of
  the situation key (18.2), which currently uses raw possession shares and can
  use the doctrine classification instead: strictly more meaningful, same cost.
- **Off-script idle behaviour gets a better default than "hold your anchor"**:
  a bot with nothing to do returns toward the shape's home position *inside the
  deepest Safe zone that still overwatches the frontier*, which is the doctrine's
  own answer and a better one than 6.13's.

### 20.3 Layers, and a macro action space that transfers across maps

Chapter 1's rhythm is the entire T side of the game: spend resources to convert
an Unknown into a Risk, take deeper control to convert the previous Risk into a
Safe, repeat until you are at the site. Chapter 9 generalizes it and Chapter 12
adds that the same conversion can be done with two, three, four, or five bodies
and that the choice is a prioritization.

This is a better macro action space than the one the plan currently has. Today
the Playstyle AI picks a call from `roundLibrary.js`, which is 13 to 21 strings
per map. Strings do not transfer: a network that has learned Inferno's
vocabulary knows nothing about Ancient. The doctrine's action space is
map-independent:

```jsonc
// LayerAction, the Playstyle AI's primary macro decision
{ "convert": "banana_lower",          // a node in the per-map layer graph
  "protocol": "three-man" | "two-man" | "four-man" | "five-man" | "poke",
  "pace": "rush"|"pop"|"contact"|"full-exec"|"default"|"slow-default",  // 6.20
  "spend": { "smoke": 1, "flash": 1, "molotov": 0 },   // the priced investment
  "keep":  { "smoke": 2, "molotov": 2 },               // the late-round reserve
  "abort": "on_contact>=2 | util_spent>budget | clock<0:50" }
```

The **layer graph** is baked per map alongside the nav graph and the angle
catalogue: nodes are named zones, edges carry which zone gates which, and each
node carries its complexity descriptor from chapter 1 (pathway count, height
delta, off-angle count from the catalogue's `rarity` tail, cover density). That
descriptor is what tells a bot how much utility a zone costs to take, and it is
computed from geometry rather than authored per map, so a new map inherits the
theory the day its zones are painted.

Three consequences, and the first is the answer to how a network is supposed to
learn any of this:

1. **Transfer.** Convert-this-layer-with-this-protocol-for-this-price is the
   same decision on every map. The policy learns the *theory* on seven maps at
   once instead of learning seven vocabularies, which for a 200 k-parameter
   Playstyle net is the difference between feasible and not.
2. **The library call becomes a label, not the decision.** A sequence of layer
   conversions produces a round that `classifyRoundTypes` tags as `b-split` or
   whatever else, exactly as it tags a real round. So the 10.1 validator still
   works, `z` conditioning (9.11) still works, and the library vocabulary
   survives as the human-facing name for what the macro policy did. Both
   vocabularies stay, which is the same resolution 6.20 reached for formations.
3. **Utility becomes a budget with a reserve, at the point of decision.** The
   `spend` and `keep` fields are the utility balance doctrine (chapter 2 and
   chapter 11) made structural: the decision to take a layer and the decision
   about what to have left at 0:35 are the *same* decision, which is precisely
   what the document says and precisely what the current plan splits apart.

### 20.4 The four ledgers: the doctrine observation block

Chapter 9 says to track four ledgers, and to read them at 0:50 and 0:30. This is
a gift, because it is a small, fixed, interpretable, map-independent feature
block, which is exactly what a small network needs and what section 7 currently
lacks at the macro level.

`shared/sim/ledgers.js`, computed continuously, snapshotted at the doctrine
clocks:

| Ledger | Contents | Built from |
|---|---|---|
| **Utility** | Ours exact by type; theirs believed by type; spend rate so far; projected reserve at 0:35 for both sides | Conservation law 2 (19.7), inventory tracking |
| **Zone** | Count of zones in each of the four classes, per side, plus which named layers we own and which are contested | 20.2 |
| **Threat** | For each site: `countDist`, proximity-to-plant in seconds, and whether the enemy could convert it now | 19.2 plus the layer graph |
| **Timing** | Who beats whom to each contested zone, from `earliestOccupy` (6.8) combined with the live clock and the belief | 6.8, 5.6 |

These are also the natural fields to add to the situation key (18.2), which
means the experience index starts addressing memories the way the doctrine
addresses situations: "we are late on the timing ledger with a negative utility
ledger against a 3-2" is a sentence, and 18.2 already argues that sentences are
what retrieval addresses need.

Two doctrine snapshot clocks (0:50 and 0:30) join the pattern-finder's own
snapshot clock (6.20) as the moments a key is written. Three reads per round
rather than one, each at a moment the doctrine says is decisive.

### 20.5 The protocol library

Chapters 1, 7, 12, and 13 specify reusable multi-body procedures. These are
**composite options**: temporally extended, multi-actor, with an initiation set,
bound roles, a fixed micro-controller, and a termination condition. They slot
into 6.6 as a second tier above the single-body option, and they are the concrete
form of the two-body pricing extension in 19.6 generalized to three and four.

| Protocol | Bound roles | Initiation | Termination | Source |
|---|---|---|---|---|
| **Three-man take** | Support (in Safe, holds the unlocking utility), Entry 1 (gun out, clears, permitted to die), Entry 2 (two metres back, guaranteed trade) | A target Unknown, three available bodies, the right utility in the right hands | Zone becomes Risk, or two die, or the abort clause | Ch 1, Ch 7, Ch 12 |
| **WICK** | A three-core, one prober, one lurker | Man advantage, or a CT side forced to move | Contact confirmed and a local 4v1 is available | Ch 4, Ch 7, Ch 9 |
| **Block cycle** (CT) | Whoever owns the lineup | Clock at ~1:00 and ~0:40, or an early threat spike | Stall window elapsed | Ch 6, Ch 8 |
| **Divide and conquer** (4v5) | Three rifles at point, one support with a ready pop, one pincher | CT distribution read as pockets, no clean pick available | Pocket engaged or the timing window closes | Ch 13 |
| **Antiflash** | One body per grouped contact | Two or more bodies grouped in a Risk zone | Contact resolved | Ch 2 |
| **Sync peek** | All living bodies | Man advantage of +2 or more | Everyone peeked, or the call is cancelled | Ch 15 |

Two of these deserve their own paragraphs because they carry the most doctrine
per line of code.

**WICK is a state machine, not a script.** Wait (hold; if they push you win the
fight you wanted, if they stack you lose nothing), Identify (move a three-core to
the map's central pathway so it can reach either side within 10 to 15 seconds and
connect with the lurker), Confirm (send exactly one extremity body to poke),
Kill (collapse four onto the isolated pocket). Each phase carries its own option
masks and its own success condition, and the doctrine's claim, that you always
end up with a local 4v1 somewhere, is **checkable**: run WICK a thousand times
and print the distribution of man-count-at-contact. If it does not produce local
advantages, either the implementation or the doctrine is wrong, and finding out
which is worth doing.

**The antiflash role is a percept-level obligation** and it is the kind of thing
no bot has ever done. One body in a grouped contact faces away from the flash
bearing, is therefore not blinded, and takes over as first contact when the entry
is. Implementation is small: a posture flag that biases the yaw target away from
the most likely flash bearing (which the belief already gives us) and a
promotion rule on the entry's flash state. Its value is that grouped bot pushes
stop being all-or-nothing.

### 20.6 Keywords: presets over the arbiter

Chapter 4's keywords are compressed orders that change how the whole team
behaves. Every one of them decomposes into things the plan already has: a mask
change, a risk distortion, and a trigger set. So a keyword is a **preset over the
option arbiter** (6.17), which makes it simultaneously a Playstyle action head, a
human command in the /sim UI, and a line in the decision log.

| Keyword | Masks | Risk distortion | Triggers |
|---|---|---|---|
| **VP** | Solo options illegal; every peek requires `tradeCover`; no option whose uncovered mass exceeds a floor | CVaR: maximize a low quantile of dPRW, not the mean | WICK phase transitions |
| **Liquid** | Grouping constraint (core of 4+), commit window compressed to 5 to 10 s | Mean, with `timingEdge` weighted up | Arms on a rotation-length read |
| **Freeze** | Everything except `fall_back` and `hold` masked until the team is in Safe zones and `splitEntropy` drops | Neutral | Disarms all pending ASPs |
| **Joker** | Four bots masked to hold **and to emit no sound** (walk only, no utility); one bot unmasked entirely | The initiator gets an aggression bonus, the others get none | All four collapse on the initiator's contact |

Joker is worth noting as the cleanest test of whether the comm and sound models
are honest: it only functions if silence is genuinely observable (4.7 says
walking and crouching emit nothing) and if the collapse trigger is a percept
rather than a message. Both are already true, so Joker is nearly free, and it is
the most distinctive-looking behaviour in the whole document.

The pace half of chapter 4 maps onto the six pace types already in
`patternDefs.js` (6.20), so keywords and pace compose rather than compete: a
keyword sets the *protocol and the risk posture*, pace sets the *tempo*, and the
pair is what the Playstyle AI emits alongside the layer action.

### 20.7 Communication levels: negative information is a comm, not a fact

Chapter 3 is the correction of the largest honesty hole in five passes.

5.5's rule 3 deletes belief mass from every cell the *team* can currently see,
instantly and for everybody, because the filter lives on the team blackboard.
That makes negative information free. But chapter 3 says the difference between
Level 1 and Level 2 comms, between "one short" and "**only** one short", is one
of the biggest gaps between amateur and professional play. If negative
information were free, Level 2 would be worth nothing.

So: **clearing an angle deletes mass from the clearing bot's own view
immediately, and from the team blackboard only via a comm**, at the comm delay,
and only if the bot chooses to say it. The comm schema becomes the doctrine's
five levels:

```jsonc
{ "level": 1|2|3|4|5,
  "observation": {...},        // L1: what I see or hear
  "negative":    {...},        // L2: what I have cleared and it was empty
  "intent":      {...},        // L3: the option I am about to take
  "request":     {...},        // L4: what I want you to do (19.6)
  "asp":         { "if": "...", "then": "..." } }   // L5: the after-situation plan
```

Consequences, several of which are large:

- **The belief becomes two-tiered**: a personal view that is sharp and current,
  and a team blackboard that is behind by the comm delay and by whatever nobody
  bothered to say. That is what a real team's shared picture is, and it is
  strictly more honest than what 5.5 shipped.
- **Comm quality becomes a trait with teeth.** Whether a bot emits Level 2 at
  all, and how concise its Level 5 is, is a per-bot property that mimicry can fit
  and skill can scale. A `mix` team is not blind; its members simply do not tell
  each other what they have cleared, and the team plays on a staler map. That is
  a far better model of bad play than slower reactions.
- **ASPs make conditional orders available to any bot, not just the hivemind.**
  6.1 gives the TeamDirective a `triggers` array. An ASP is the same object,
  scoped and issued mid-round by whichever bot owns the zone (20.8). "Flash me
  short, rotate if clear" is a request plus an intent plus a conditional order,
  and it is three fields.
- **Silence discipline is a cost, not a rule.** Chapter 3 says do not talk to a
  player who is in a duel. Mechanically, a message received while `inDuel` costs
  attention `k` (5.7). So comm spam is punished and terseness is rewarded without
  anybody writing "be terse", and the "do not explain why mid-round" rule follows
  from the same arithmetic, because explanation is a longer message for the same
  action content.
- **No transcript is stored.** Decision 40 stands. These are structured fields,
  they are tiny, and they are ephemeral.

### 20.8 Zone ownership, initiative, and the overcall protocol

Chapter 12 answers a question the plan had not asked: when two bots have ideas,
who wins?

**Zone ownership.** Every named zone has exactly one owner per round, assigned at
freeze alongside roles. The owner has the right and the obligation to set tempo
there: when to poke or hold, which utility layer to spend, when to call the hit,
and what ASP follows. Non-owners entering that zone default to Entry 2 or Support
under the owner's plan and may not overtake his lane. Implementation is an
option-mask term keyed by (bot, zone), which is the same mechanism role contracts
already use (6.19), so it costs nothing new.

This is also **the plan's answer to the freedom question**, and it is the
document's answer too: the owner is free inside his zone, everybody else is
bound. Individual initiative and team structure stop being in tension because
they are separated by geography rather than by degree.

**The overcall protocol**, which is needed the moment ASPs exist, because
conflicting calls will happen:

| Situation | Rule |
|---|---|
| Time-sensitive | One voice overcalls or aborts. It preempts every pending ASP, everybody follows immediately, and no arbitration happens |
| Relaxed | Information is relayed, and the zone owner or the IGL assembles the call |

Mechanically: messages carry `priority` and `timeSensitive`, an overcall cancels
pending ASPs on receipt, and under relaxed conditions the owner aggregates
before emitting. Who may overcall is a role property (the IGL slot), and chapter
12's regional split of call ownership (IGL early with players mid-round, players
early with IGL mid-round, IGL both) becomes a **team-identity parameter** in the
match config: which bot owns the first twenty seconds, which assembles the
mid-round. That is a genuinely different-feeling team for one enum, and it is
exactly the kind of variety the behaviour archive (9.22) wants to index.

### 20.9 Threat level, and the 82 percent

Chapter 5 defines a threat as **proximity to round loss**, not noise, and insists
that the response match the danger, including the response of throwing a grenade
instead of moving a body. That definition is already this plan's objective
function read backwards: threat is `−dPRW(their best continuation)`, computed
over the joint belief. So the threat ledger is not a new model; it is the
existing round model evaluated per site against sampled layouts. Chapter 5's
insistence that a lurker at a key position outranks four bodies in a zone that
cannot convert falls straight out of that arithmetic, and it does not fall out of
counting bodies, which is what every bot does.

Chapter 13's number is more useful than it looks: **professional teams convert
the first pick into a round win about 82 percent of the time.** That is an
external calibration anchor for a model the plan already ships. Run
`predictRoundCalibrated` on library first-pick states in full-buy 5v5 and it
should reproduce roughly that figure. If it does not, that is a finding about
the fitted model, reported rather than patched (14.23's rule).

The number also supplies the **risk rule**, which the plan had only as a
personality constant. Chapter 9 and chapter 13: advantage means reduce risk and
cash out, disadvantage means accept risk and manufacture volatility. So
`riskQuantile` (8.2) stops being a fixed trait and becomes a function of state:

```
riskQuantile = f( PRW, manDelta, doctrine posture )
  PRW well above 0.5   ->  low quantile (CVaR): trade on our terms, no coin flips
  PRW well below 0.5   ->  high quantile: seek variance, force isolation
  PRW near 0.5         ->  the trait's own baseline
```

The trait remains as the *baseline and the spread around it*, so players still
differ, but the direction of travel is doctrine rather than personality. This
also makes VP mechanically meaningful: calling VP is calling for the low
quantile plus the trade masks, which is what the chapter describes.

### 20.10 Tug of war and conditioning: predictability as an investment

Chapter 10 exposes a genuine contradiction in the existing plan and resolves it.

6.9 charges the policy for being readable, via an adversarial critic that
predicts our next option from the enemy's observation. Chapter 10 says the
opposite: repeat the same action deliberately until the opponent reallocates
resources, then punish the adjustment. Repetition is the *setup*, and the payoff
is the deviation.

Both are right, and the reconciliation is that **the readability cost must be
signed by intent**. Being predictable is a leak when nothing is planned and an
investment when a punish is. The machinery to tell them apart already exists:

```
conditioningValue = Δ(their belief moved toward the pattern we have been showing)
                    × dPRW(the deviation we are about to run)
                    − readabilityCost(the rounds spent establishing it)
```

The first factor comes from the enemy-belief auxiliary head (9.14) and the
tendency tracker pointed at ourselves (6.21). The second is an ordinary price.
So conditioning becomes a **multi-round strategic action owned by the Strategy
AI** (18.4), which is the only layer that lives between rounds and therefore the
only layer that can hold an investment.

Chapter 9's cadence rule gives that layer an objective it did not have:
front-load the tug of war in the opening three rounds of a half, interleave fast
and slow to deny pattern learning, use repetition deliberately, and pivot at the
moment the adjustment arrives. "The moment the adjustment arrives" is
observable: it is when the tendency tracker's prediction of *their* response to
our pattern starts coming true. That is a detector, not a guess.

And chapter 10's golden rule is the cleanest mechanization in the entire
document. **When winning, trust your first instinct. When losing, trust your
second.** Read as a statement about model trust rather than about confidence:

- Winning the tug of war means they are reacting to us, so our opponent model is
  being confirmed. Weight its features up and exploit.
- Losing means we are the ones being conditioned, so our first instinct is the
  response they engineered. Weight the opponent model down toward the prior and
  take the second-ranked call.

Both are one scalar: **track the opponent model's own hit rate this match**, the
fraction of its predictions about their behaviour that came true. High hit rate
raises its weight in call selection; low hit rate lowers it and shifts the
argmax. This is strictly better than "explore more when losing", it is
inspectable, and it prints as a motive string a human can check.

### 20.11 Adaptation: which instinct, and the blind maze

Chapter 14's three states are winning, losing, and the unknown. The first two are
20.10. The third is the correction to 19.4 and it matters, because a naive
value-of-information agent does exactly the wrong thing.

A VOI agent widens its search when uncertainty is high. Chapter 14 says that in
genuine novelty this is the losing move: oscillating between options and dying in
no man's land is worse than picking a direction and committing, because the delay
cost in Counter-Strike is convex and the enemy is acting while you think. The
blind maze model is the doctrine's statement of it: pick a wall, follow it, do
not switch. **Wrong but decisive beats right but late.**

So the visualization budget carries a **novelty cap**:

```
if retrieval returns no matching situation (18.3 backoff exhausted)
   AND splitEntropy is above a threshold
   AND no option's price dominates
then  budget := 0
      take the argmax, apply a hysteresis lock (a raised minCommitTicks),
      and emit a Level 5 comm with an ASP so the team commits with you
```

That final clause is the part that makes it a team behaviour rather than a
stubborn bot: chapter 14's answer to chaos is a clean directional call with an
ASP, plus the overcall protocol if timing is tight, plus the safety nets (bomb in
green with two teammates, antiflash ready, spacing for trades). All four are
mechanisms that already exist by this point in the document, which is a good sign
that the decomposition is right.

Chapter 14's other rule is about training rather than play, and it is worth
obeying: fix mistakes after the round, never during. The post-round review (18.6)
is already the only place learning happens, so this one is satisfied by
construction, and it is worth noting because the temptation to add a mid-round
correction channel will come up and should be refused.

### 20.12 Clutch discipline: the cheapest rule in the document

Chapter 15 is four sentences long and worth more than most of section 6. In a man
advantage of +2 or more, either everyone peeks together or nobody peeks. The
reason is exact: a chain of isolated 1v1s is what lets one player win a clutch,
and numbers only convert if they arrive simultaneously.

This is the single most common failure of every bot team ever shipped, and it is
a mask:

```
if manAdvantage >= 2:
    peek-family options are illegal unless the sync condition holds
    (>= N teammates able to peek the same space inside a shared window),
    or the team posture is `hold`
```

It is also directly gradeable: count isolated duels conceded while at +2 and band
it against the library. A generation that fails this is visibly bad in a way that
Elo would take four hundred matches to notice.

### 20.13 Understanding, not memorizing: why the execute is solved

Chapter 16 is the argument that decides the shape of the whole doctrine layer,
and it happens to be an argument about machine learning made without reference to
it.

The chapter's B-execute example derives an entire utility assignment from
properties: molotovs are thrown from close and burn fast, so the second man in
line carries them; the smoke lineups sit near where players one and two already
are, so the third man smokes; the flash lineups are furthest out and flashes are
the last piece thrown before entry, so the fourth man carries them and arrives
late; the first man is first contact, so he holds. Nobody memorized that order.
It is the unique solution to a small assignment problem whose costs are geometry
and timing.

So: **the execute's utility assignment is solved at runtime, not retrieved.**
Given the effects required (19.10), the lineup geometry (throw origin, travel
time, effect duration, from the mined data), the current body positions, and who
holds what, solve the assignment that satisfies the DAG's ordering constraints at
minimum cost. The mined template supplies the *effects and the anchor*; the
assignment is derived every time.

Three payoffs:

1. **It repairs by construction.** A missing grenade changes the cost matrix
   rather than invalidating a script, which is tier 2 of 19.10's ladder arriving
   for free.
2. **It transfers.** The same solver runs on a map whose executes were never
   mined, because the costs are geometry.
3. **It is testable, and the test is the chapter's own thesis.** Exam **E14
   (Understanding)**: hand the team an execute they have never run, with the
   utility they happen to hold, and score the assignment they solve against what
   pros do in the nearest library cases. A team that scores well here has
   understanding; a team that only scores well on E11 has memory. Grading both
   separately is how we find out which one the generation actually built.

This principle generalizes past executes and is the reason the doctrine layer is
built as state and costs rather than as rules. Every place this section could
have written a rule (which utility clears which zone, which anchor to hold, who
throws what) it instead writes a property (zone complexity, catalogue geometry,
lineup timing) and lets the arbiter derive the rule. The rules are then emergent,
inspectable through motive strings, and correct on maps nobody mined.

### 20.14 Doctrine versus brilliance: the deviation licence

The brief is explicit: bots should work on these principles while still balancing
individual brilliance, and brilliance is the pinnacle rather than the starting
point. That ordering is a training schedule, and it maps onto machinery the plan
already has.

**Doctrine is enforced in three regimes, in this order:**

| Stage | Doctrine is | Mechanism | Why |
|---|---|---|---|
| **Early** (BC and the first RL generations) | A **mask** | Illegal options are simply absent from the initiation set | A policy that has not learned to price anything cannot be trusted to price a deviation. Masking also shrinks the search space enormously, which is most of why this is affordable |
| **Middle** | A **price** | Doctrine violation is a shaping penalty, annealed like β6's plan adherence (9.5) | The policy learns *why* the rule exists by paying for breaking it and occasionally profiting |
| **Late** | An **expectation** | No mask, no penalty, but doctrine compliance is a graded scorecard axis (20.15) | A generation may outgrow a rule, and must then be able to show it won by doing so |

**The deviation licence** is what makes the last stage safe. Rather than a global
switch, the right to deviate is earned per bot, per situation key, out of the
experience index (18.3):

```
licence(bot, key, doctrineRule) is granted when
    the bot's deviations in this key have a Beta lower bound above
    the doctrine prior's rate for the same key, at n above a floor,
    attributed to the *call* rather than to execution (18.6)
and it is revoked when the bound falls back below.
```

Five properties that make this the right shape:

1. **It is earned against the doctrine's own prior**, not against zero, so
   "brilliance" means measurably better than the book rather than merely
   different from it.
2. **It is scoped.** A bot may earn the right to over-peek in one situation on
   one map and hold none anywhere else. That is what a real player's licence
   looks like.
3. **It is revocable**, which is exactly what the memory layer is for and exactly
   what weights cannot do.
4. **It is inspectable.** The Memory tab (18.9) shows the rows that granted a
   licence, and the motive string reads "off-contract, licensed: this bot is 7
   and 2 deviating here against a 0.48 prior".
5. **It is the pinnacle by construction**, because a licence cannot exist until
   there is enough experience to justify it, and experience accumulates across
   generations (18.8). Early generations are disciplined because they have no
   record; late ones have stars because some of their bots earned one.

The failure mode is obvious and named in 14: licences will be farmed if the
attribution is sloppy, because "we won the round" is not evidence that the
deviation was right. 18.6's model-based attribution is the defence, and the guard
is that licences are granted only on call-attributed outcomes.

### 20.15 The doctrine curriculum, scorecard, and exam

The document is already a curriculum. Its chapters are ordered by dependency, and
they map onto training stages that isolate one competency at a time. Two stages
join 9.7 and 9.15, and both sit before C3 because both are learnable without a
full round:

| Stage | Content | Gate to next |
|---|---|---|
| **C2c** | Layer conversion with no objective: convert a named Unknown to Safe using the three-man protocol, against a scripted defence, with a utility budget | Conversion success and utility spend per zone within the pro band mined for the same zone; bomb never leaves Safe |
| **C3b** | Ledger play: full rounds where the reward is dominated by the four ledgers at 0:50 and 0:30 rather than by the round result | Ledger positions at both clocks inside the library's winning-side distributions |

The scorecard (9.17) gains a **Doctrine** axis, one metric per chapter, all of
them computable from a sim round with code that exists or is specified above:

| Chapter | Metric |
|---|---|
| 1 Zones and layers | Fraction of live seconds the bomb spends outside a Safe zone; layer skips (entering an Unknown with no conversion) per round |
| 2 Utility | Purpose compliance (each grenade classified into the four purposes), overthrow and underthrow rates, goodbye-flash rate |
| 3 Comms | Level 2 emission rate after clearing a zone, Level 5 share of orders, message volume to bots in duels |
| 4 Keywords and pace | Pace-type distribution against the library; keyword-appropriate behaviour when commanded |
| 5 Threat | Rotation correctness against the threat ledger; response-type mix (utility stall versus body rotation) |
| 6 Antieco | Antieco conversion rate both sides; formation and site-choice compliance |
| 7, 8 Buy vs buy | Early spend versus late reserve; block timing distribution (CT); hinge-layer pressure rate (T) |
| 9 Macro | Ledger positions at 0:50 and 0:30 versus winning-side distributions |
| 10 Tug of war | Conditioning attempts detected, and their punish conversion rate |
| 11 Slow vs slow | Utility balance at 0:35 in low-contact rounds |
| 12 System | Zone-ownership violations (lane overtakes), utility-in-the-wrong-hands rate (entries dying with unspent heavy utility) |
| 13 Risk | Risk quantile versus PRW correlation; 4v5 method selection and its outcome |
| 14 Adaptation | Time-to-commit in novel situations; oscillation rate (option changes per decision under high entropy) |
| 15 Clutch | Isolated duels conceded at +2 or better |
| 16 Understanding | Exam E14: assignment quality on unseen executes |

Scored by the same rules as every other axis (9.17): percentile where there is a
direction, band membership where there is not, axis score as the median, overall
as the soft minimum. And the axis is subject to the same caveat as the rest: it
measures whether bots play the way the document says, which is a claim about
*style compliance*, and it must never be blended with the strength verdict.
A generation could comply perfectly and lose, and that would be a finding about
the doctrine rather than about the bots, which is a result worth being able to
get.

Two exams join 9.19:

| Exam | Setup | Scored on | Pass band from |
|---|---|---|---|
| **E14 Understanding** | An unseen execute, with whatever utility the team happens to hold | Assignment quality versus the nearest library cases (20.13) | Pro assignments in comparable states |
| **E15 Doctrine** | The scenarios behind each chapter's rules, run as fixed seeded states | Per-chapter compliance | The document, and the library where it can adjudicate |

E15 is deliberately the machine version of the exam the document itself links on
every page. If a human is graded on this material, a generation can be graded on
it too, and the two grades are comparable, which is the most direct possible
answer to whether the bots have learned what the document teaches.

---

*Companion docs: `FACEIT-INGEST-PLAN.md` (library growth feeds BC data, lineups,
spawns), `README.md` Part 2 (pipeline the sim's encode step plugs into),
`Counter-Strike 101` (the tactical doctrine section 20 implements).*
