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
| 4 | Assigned roles and positions per map | 6.4 |
| 5 | Bots modelled on real players; mimic a team's actual movement | 10.3, 10.4 |
| 6 | Game-engine constraints replicated: economy, speeds, halftime, buy time, utility travel | 4.5 to 4.10 |
| 7 | Kill awards 100 / 300 / 600 / 900; bomb money depends on explode vs elim order | 4.5, 4.9 |
| 8 | Bots freely choose among available spawns each round | 4.12 |
| 9 | Skill tunable per bot or for the whole team | 8.4 |

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
| Roles | `src/replays/roles/` (`computeRoles`, `mapRoleAssign.js`, `teamPositions.js`) | Role vocabulary per map/side. T: AWPer/Lurk/Pack, CT: AWPer/Anchor/Rotation, with map-specific labels (Inferno T: AWPer, A Lurk, Banana, Ramp, 2nd Mid; exactly the brief's example). |
| Coach rules | `src/replays/coach/` (~35 rule ids in 5 categories) | Negative reward terms and human-likeness evals (9.5, 9.8). |
| Aim metrics | `src/replays/shared/aimMetrics.js` | Calibration targets for the aim motor (8.3): time-to-damage, crosshair offset distributions from real demos. |
| Stats bags | `server/replays/statsIndex.js` (`row.mv` psdt/dt, `row.pos1/2`, `row.du`) | Movement and possession calibration baselines. |
| Model training pattern | `scripts/extract-duel-episodes.mjs`, `train-duel-model.mjs`, `src/replays/models/runtimeParams.js`, champions | The house pattern for extract → train → versioned weights → runtime override. The sim trainer follows it (9). |
| Identity | `server/replays/identity.js` (`whoami`), `site_admins` table, `server/admin/routes.js` 404 pattern | Access control for /sim (2). |
| WS servers | `server/lobby.js` (`MultiplayerServer`, `/ws`), `server/football.js` (`/football`), upgrade router in `server/index.js` | Template for the live sim stream (11.2). |
| Utility constants | `src/replays/viewer/utilityMarkers.js` (smoke 144u/22s, fire 120u/7s), `roundFacts.js` (`SMOKE_SECONDS=18`) | Note the 18 vs 22 s smoke inconsistency in-repo; the sim freezes one value (4.8) and the repo constant should be unified. |
| Demo grenade events | `schema.js` GrenadeEvent: `throwTick`, `detonateTick`, `from`, `at`, `path[]` | The lineup mining source (4.8): real travel times and real trajectories, no physics needed. |

### 1.2 What does NOT exist and must be built

- A cash economy simulator (only eco/force/full classification exists, `server/demoparser/economy.js`).
- Per-weapon damage, armor penetration, range falloff, tagging, per-weapon move speed, kill awards.
- Plant 3.2 s / defuse 5 s|10 s as timed actions; MR12 match state machine with halftime swap and OT.
- Grenade flight (creator uses a 300 u/s straight line; the sim mines real trajectories instead).
- Flash blindness, HE damage, molotov damage as combat rules.
- Any sound propagation model (nothing exists in the analysis stack).
- A humanized aim motor (trainer bots are RNG hit-chance, not a motor model).
- A nav graph with named positions as nodes (only the Dijkstra lattice exists).
- Everything ML beyond the two small fitted models: policy networks, BC dataset extraction, self-play infra, league, evaluation harness.

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
|  BRAINS (learned, evolving)                                    |
|  Playstyle AI  (one per team, ~1 Hz + event-driven)            |
|  Individual AI (one per bot, shared weights, 8 Hz)             |
|  In:  observations built ONLY from the knowledge tracker       |
|  Out: intents (JSON-schema'd decisions, engine-agnostic)       |
+---------------------------------------------------------------+
|  TRANSLATOR (fixed constants, never learned)                   |
|  intents -> per-tick inputs: wishdir/walk/duck/jump,           |
|  aim motor targets, fire/reload, throw lineup, plant/defuse    |
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
  translator.js                # intents -> per-tick inputs
  spawnAssign.js               # legal spawn permutations, mimic matching, freeze pick
  trackFollow.js               # follow a recorded tick path with CS movement (no teleport)
  interrupts.js                # local vs team interrupt classifier (10.2, 10.4)
  skill.js                     # team / per-bot skill -> aim + decision knobs (8.4)
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
  sim-extract-bc.mjs           # BC dataset (obs via knowledge tracker replay, labels)
  sim-eval.mjs                 # eval suites, Elo ladder, human-likeness gates
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
5. **Z handling**: `z` is carried per bot (spawns have real z; nodes inherit
   sampled z from demo tracks where available, else 0). Nuke uses the `level`
   flags the zones already carry plus `isLowerLevel`; cross-floor edges only at
   painted connections (ramp, ladders, vents) with fixed traversal speeds.
6. **Doors** (Inferno banana door, Nuke hut): v1 has no door state; doorways are
   always-open walkable gaps, as the radar mask already shows them. Logged as a
   fidelity gap (14).

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
  "tempo": "slow" | "default" | "fast",
  "buy": { "team": "full"|"force"|"half"|"eco",
           "saveThreshold": 2 },
  "spawns": { "bot3": "sp_CT_-410_1830" },       // freeze only; permutation of the pool (4.12)
  "follow": {                                    // 10.3 / 10.4; null = no template
    "source": "mimic" | "call-template" | null,
    "roundRef": "demoFile:roundN" | null,
    "until": "interrupt"
  },
  "orders": {
    "bot3": { "role": "banana", "task": "hold"|"execute"|"lurk"|"rotate"|"save"|"follow"|"autonomous",
              "anchor": "banana_car",
              "trackSlot": 2,                    // which mimicked player this bot shadows
              "utilityBudget": ["inf_smoke_coffins_1", "..."] }
  },
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

### 6.2 Playstyle AI (the hivemind)

- One instance per team. Runs at freeze start (pick **spawns**, call, roles, buy
  posture, whether this round is FOLLOW or AUTONOMOUS) and then **only on team
  interrupts** (10.2), plus a slow 5 s heartbeat that is allowed to fire a team
  replan only if a trigger is armed. It does **not** chatter every contact.
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
| Teammates | 5×24=120 | alive, rel pos (geodesic dist + direction sector 8), zone emb, health, weapon class, flash, role emb 4, task one-hot, hasBomb |
| Known enemies | 5×26=130 | exists, seenNow, age, lastKnown rel pos + zone emb, reachable-ball radius, weaponSeen class, threat: xK of the hypothetical duel me-vs-them NOW via `predictDuel` (a feature, not a reward), inMyCone |
| Sounds | 8×6=48 | last 8 team percepts: type one-hot, sector, range band, age |
| Map control | 24 | own-side control share per painted area (povZonePaint semantics), t/ct/neu global shares |
| Plan | 30 | call embedding 8, my role emb 4, my task one-hot, anchor rel pos, tempo, directive age, trigger armed flags |
| Round state | 28 | phase one-hot, clock/115, bomb timer/40 if planted, plant site one-hot, alive counts both, score both/13, round number/24, half, my team side, economy state one-hot own + inferred enemy, loss streaks |
| **Total** | **~420** | |

v2 adds an egocentric 32×32 occupancy/control grid through a tiny conv column,
only if vector features plateau: it complicates the JS forward pass, so it must
pay rent.

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

### 7.4 Action heads

Individual (all categorical, all masked):

| Head | Arity | Notes |
|---|---|---|
| move.mode | 8 | follow/hold/advance/peek/repeek/fallback/rotate/clear. `follow` is forced while task is follow and no local interrupt has fired |
| move.target | 24 | candidate set: k-nearest named anchors + order anchor + plan waypoints + retreat node; mask by reachability and role legality; ignored during follow |
| gait | 3 | run/walk/crouchwalk; during follow, inferred from the tape and masked |
| stance | 2 | stand/crouch |
| combat.posture | 4 | free/holdAngle/avoid/commit |
| combat.preAim | 16 | LOS-plausible named spots from current/next node |
| combat.focus | 6 | known-enemy slot or none |
| utility | 1+M | none + legal lineups (inventory ∧ reachable ∧ role budget), M≈24 |
| objective | 8 | none/plant/defuse/pickupBomb/dropBomb/dropWeapon/hunt/holdSite |
| buy | 12 binary | gated to buy period; legality via economy module |

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
sprayDiscipline, hsBias, triggerConfidence, decisionTemperature, discipline}`:
one profile per bot. Sources, in override order: per-bot UI knob (8.4) → mimic
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

### 9.2 Trainer runtime: local 4090, never the prod box

Training runs in **Python/PyTorch** under `tools/simtrainer/` on **artysan's
PC (RTX 4090)**. The production server has no GPU and does not train, does not
run rollout workers, and does not grind self-play overnight. Prod only serves
`/sim`, plays live matches for the signed-in admin, and loads exported weight
files.

The seam is thin and file-based:

- Node on the PC exports datasets/rollouts as flat binary + JSON manifests
  (library rounds can be copied, or extraction can read a local replay dir).
- Python on the 4090 trains and exports weights as JSON/fp32 blobs + norm stats.
- Copy the `models/<gen>/` folder onto the server (or into `AIM4_REPLAY_DIR/sim/`
  on the PC for local `npm run host`). The website never needs CUDA.
- Node/browser inference is the hand-rolled forward pass (6.3), so **the product
  has zero Python and zero native-ML dependencies at runtime**.

Self-play rollouts also run on the PC: N Node worker processes
(`server/sim/rollout.js`) stepping matches with the current policy, writing
trajectories to disk; the Python trainer watches the directory, updates weights,
writes back a new manifest; workers hot-reload. Simple, robust, resumable, no
gRPC, no prod CPU stolen from demo parsing.

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
   floor (no mono-strat collapse); win rate as T and CT both within [35%, 65%]
   band on each map (detects degenerate side camping).
5. Determinism smoke: same seed re-run bit-identical.

All eval artifacts (matches) are stored as watchable sim rounds: every number in
the report links to rounds, the same philosophy the antistrat reports follow.

### 9.9 Model registry

`AIM4_REPLAY_DIR/sim/models/<gen>/manifest.json`:

```jsonc
{ "gen": 12, "parent": 11, "createdAt": "...", "phase": "C5",
  "individual": { "arch": "mlp512x2", "weights": "individual.bin", "norm": "norm.json" },
  "playstyle":  { "arch": "attn256",  "weights": "playstyle.bin" },
  "aimProfiles": "aim.json", "trainedSteps": 1.2e9, "league": ["gen11","gen9","bc0"],
  "evals": { "eloVsPrev": 31, "aimGates": "pass", "callEntropy": 2.4 } }
```

Follows the champions/`runtimeParams.js` philosophy: fitted weights are versioned
data the server loads, the admin can inspect, and the UI can pick per match
("Gen 12 vs Gen 8").

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

Three layers, used together. The new one, and the one the brief is asking
for when it says "mimic how real players do it," is (3).

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
- Overlays togglable: belief (last-knowns + reachability balls), sound rings,
  nav path lines, the mimic tape as a ghost trail, control paint.
- After the round: `Save round` writes it to sim storage; `Open in viewer` deep
  links the standard timeline viewer against the sim store route.

### 11.4 Later (flagged, not v1)

Generation browser with Elo curves, eval reports, match archive search, A/B
harness UI, aim-gate dashboards. The admin Models tab gains a read-only "Sim"
card pointing at the registry.

---

## 12. Storage, formats, and APIs

### 12.1 Directory layout (server, under `AIM4_REPLAY_DIR/sim/`)

```
sim/
  lineups/<MAP>.json          # mined utility (4.8)
  navcache/<MAP>.bin          # baked nav graph + masks
  datasets/bc-vN/             # BC shards + manifest
  models/<gen>/               # manifests + weight blobs (9.9)
  league/                     # pool bookkeeping, Elo table
  matches/<id>/               # match.json + round-N.meta.json.gz + round-N.ticks
  evals/<gen>/                # eval reports + linked match ids
```

Sim rounds reuse the demo store codecs but live outside the library tree: nothing
in Demo Manager/Database/stats index ever scans them (secrecy + no stat
pollution). A `synthetic: true` field in every meta guards against future
accidental ingestion.

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
            "command": "mimic", "spawns": "mimic" },
    "CT": { "model": "gen8", "skill": "t2", "mimic": null,
            "command": "auto", "spawns": "auto" } },
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
6. **Nuke** two-floor pathing and radar duality is genuinely hard. Bake it
   honestly or leave it out of a generation's eval set; do not train on a
   lying nav. The curriculum is "every map that is ready," not "skip Nuke
   forever."
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
21. **Kill-award or explode-vs-elim bugs**: a $250 or $600 error compounds
    over 24 rounds and teaches the wrong afterplant (hunt vs hold). Golden
    tests in P2 must lock both orderings and all four kill buckets before
    any RL run is allowed to see money.

Product and ops:

22. **Secrecy leak via bundle**: route string is visible in `site.js`: acceptable
    (it 404s), but keep all sim UI text inside the lazy chunk; never reference
    `/sim` from public pages; keep `SIM-PLAN.md` out of any published docs page.
23. **Long-running matches on the server**: live Play on `/sim` is a CPU burst
    on prod (one match, admin only). Cap concurrent live sims at 1. Training
    rollouts never run here; they run on the 4090 PC (9.2). Never share the
    event loop with the parser.
24. **Supabase outage** makes `whoami` anonymous: the guard then denies: fails
    closed, correct for a secret page.
25. **Vercel catch-all**: forgetting the rewrite sends `/sim` to the trainer:
    it is in the Phase 0 checklist twice because it will absolutely happen
    otherwise.
26. **Windows dev, Linux prod**: path handling via `path.join` everywhere in new
    server code; binary shards little-endian both sides; test suite runs in CI on
    both if possible.
27. **Model weights are IP**: they never enter git or `dist/`; backups ride the
    existing `AIM4_REPLAY_DIR` strategy.
28. **Game updates change constants** (prices, speeds, kill awards): all in one
    file (`constants.js`) with a `RULES_VERSION`; matches record the version they
    ran under so old replays stay interpretable.
29. **Scope gravity**: the follow-until-interrupt mimic (P3) is the fallback
    plateau: if ML stalls for a month, the page still demos real value (bots
    walking a real team's round, then adapting when something happens). Protect
    that milestone.

---

## 15. Build order and acceptance criteria

Each phase lands with tests appended to the `npm test` chain, house-style.

| Phase | Scope | Acceptance |
|---|---|---|
| **P0** (day 1) | Hidden page + guard (section 2) | artysan sees the stub; everyone else and anonymous get 404 page and 404 API; guard tests green; `/sim` does not open the trainer on Vercel or `npm run host` |
| **P1** | `shared/sim`: constants, movement2d, navGraph, engine skeleton (freeze/live/over, no combat), encode, **spawn choice**; bake every map whose zones are ready | Scripted bots run named-anchor paths at correct speeds on each baked map; spawn permutations never collide; encoded round plays in the existing timeline viewer with working clock; determinism hash test |
| **P2** | Combat: weapons/damage/aim motor/sound; utility mining + effects; economy; full MR12 + OT MR3 $10k; comm delay 0.5–1.5 s | Scripted 5v5 rounds complete with kills, plants, payouts; aim gates harness runs; economy golden tests: loss ladder, cap, T time-expiry $0, **all four kill-award buckets**, **explode-at-40s vs elim-at-39s after the same plant**; Team POV toggle on a sim round matches knowledge tracker (5.4 test); a sound heard by one bot reaches a teammate only after the delay |
| **P3** | Knowledge tracker, intents+masks, translator, **track follow**, **interrupt classifier**, scripted retrieval + **team-round mimic**, lineup executor; live WS + setup panel v1 | Commanded execute on each baked map → library matcher tags it ≥ 80% over 100 seeds (pre-interrupt); mimic follow vs frozen CT: median geodesic error < 60 u over first 20 s (10.4); a single isolated peek stays `local` while four teammates keep the tape; watchable live at 1x/16x with POV, ghost tape, and interrupt log |
| **P4** | BC: extractor, Python trainer, JS forward pass, mimic embeddings | BC bots beat scripted-random baseline ≥ 65%; call-validator ≥ 70% on commands; human-likeness KS within bands; page can pick `bc0` |
| **P5** | RL: rollout workers, MAPPO, reward (9.5), league, eval harness, registry | gen1 admitted through gates (9.8); generations selectable in UI; paired-seed Elo report stored |
| **P6** | UX polish: inspector overlays, ghost tape, interrupt log, skill knobs, match archive, saving/opening rounds in the standard viewer | artysan can run a Spirit-mimic T side vs t2 CT, pause, inspect a local vs team replan, save, and rewatch |
| **P7** | Scale: curriculum C0 to C5 across every baked map, mimic retrieval quality, buy-policy sanity | Per-map gates green; call entropy floor; eval dashboard data |
| **P8** (parallel spike after P3) | CS2 server plugin proof (13.2) | Freeze `setpos` onto a chosen spawn, then one bot walks to `banana_car`, peeks, throws a mined smoke on command from the DecisionInterface |

Rough effort intuition: P0 a day; P1 to P3 are the engine month(s) and carry most
of the deterministic-correctness burden; P4 is a week once extraction runs; P5 is
open-ended by nature (that is the research part); P8 is two focused weeks that
should happen early because its result shapes how much 3D faith the rest deserves.

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
5. **Compute (what that question meant).** There are two machines in this
   project: the **website** (serves pages, parses demos, no GPU) and **your
   PC** (4090). The question was "should the website also grind training
   simulations at night?" Answer: **no.** Your PC runs rollouts + PyTorch.
   Prod only serves `/sim` and plays the live match you click. That is why
   item 1 and item 5 are the same decision.
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

---

*Companion docs: `FACEIT-INGEST-PLAN.md` (library growth feeds BC data, lineups,
spawns), `README.md` Part 2 (pipeline the sim's encode step plugs into).*
