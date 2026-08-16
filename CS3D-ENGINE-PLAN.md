# CS3D engine: the gameplay systems

CS3D-PLAN.md set the shape of the 3D replica and CS3D-RENDERER.md built the
part that draws it. Maps, lighting, collision geometry, the pack pipeline and
the renderer are done — `aim4.io/nuke` loads a real map with the map's own sun,
its baked light and its physics hulls.

What is left is the half that makes it a game rather than a diorama: movement,
weapons, utility, models, animation, and the tick contract underneath all of
them. This document plans those ten systems, says which CS2 files each one
needs decompiled, and — the part that matters most — says what to measure so
"1:1" is a number rather than an opinion.

This expands CS3D-PLAN §4–6, which sketched movement, weapons and grenades in
a paragraph each. Where the two disagree, this document wins: it is written
against the pipeline that actually shipped.

---

## 0. The distinction that shapes everything: data vs behaviour

Decompiling the VPKs gives you **data**. It does not give you the **engine**.

| Comes out of the VPK | Lives only in the binary |
|---|---|
| Models, skeletons, animation clips, animgraphs | The movement controller |
| Weapon `.vdata` numbers (damage, cycle, spread, recoil params) | The recoil sequence algorithm |
| Particle systems, sound events | Flashbang blindness formula |
| Surface properties (friction, bounce, penetration) | Volumetric smoke propagation |
| Map entities, brush geometry, clip volumes | Subtick input encoding |

Half of the user-facing list on this page is in the right-hand column. No
amount of extraction produces it. So every system below names **three** sources
and uses them in this order:

1. **Extracted data.** Authoritative when it exists. A number in a `.vdata` is
   the number; do not "tune" it.
2. **The demo corpus.** 3,122 `.aim4replay` files, already parsed, already
   carrying per-tick truth. This is the oracle — see §2. Behaviour that cannot
   be extracted can very often be *fitted* against real ticks.
3. **Public reference implementations and community measurement.** Hypotheses,
   never conclusions. Every constant taken this way carries `[verify]` until an
   oracle test pins it.

**The rule: no constant ships without an oracle or a `[verify]` marker.** The
2D sim's calibration debt was expensive to pay down; this is how the 3D engine
avoids repeating it.

---

## 1. What already exists — do not re-derive

Before extracting anything, know what the repo already holds. Several systems
below are much cheaper than they look because of this.

| Asset | Where | What it gives |
|---|---|---|
| Collision hulls, tagged by kind | `phys.glb` per pack, `scripts/cs3d-pack.mjs` `physKind()` | `solid`, `playerclip`, `grenadeclip`, `ladder`, `sky`, `entity` — **clip brushes and ladders are already separated**, which is most of the "proper blocking" ask |
| Per-node `SurfaceProperty` | `phys.glb` node extras | The join key for friction, bounce restitution, footstep sounds and penetration |
| Brush-entity classnames | `phys.glb` `entity` nodes | `func_door`, `func_breakable` etc. already isolated as separate collision nodes |
| Entity lump | `ents/default_ents.vents` | Spawns, bomb sites, buy zones, ladders, doors, triggers — parsed text, re-readable for any new classname |
| Map metadata | pack `manifest.json` | `spawns`, `sites`, `buyzones`, `bombRadius`, `bounds` |
| Weapon tables | `shared/sim/weapons.js` | Damage, `armorPen`, `rangeMod`, hit-group multipliers, cycle times, prices |
| Source movement subset | `src/utils/SourceMovement.js` | 215/112/73 speeds, accel 5.5, friction 5.2, stopspeed 80, gravity 800, jump 301.993, airaccel 12, air cap 30 |
| Coordinate module | `shared/sim3d/units.js` | Source↔three, the one place sign flips are allowed |
| BVH raycasting | `three-mesh-bvh` over `phys.glb` | Already built and walked by `player.js` |

The importer runs `tools/vrf/Source2Viewer-CLI.exe` — **Windows only**. Every
extraction task below is workstation work, not Mac work.

---

## 2. The oracle harness — build this first

This is the highest-leverage item on the page and it is not on the user's list.

`.aim4replay` already carries, per tick, for all ten players
(`src/replays/shared/tickFormat.js`):

- `x, y, z` at ¼-unit precision (`POS_SCALE = 4`)
- `yaw, pitch` at 1/100°
- `FLAG_AIRBORNE`, `FLAG_DUCKING`, `FLAG_SCOPED`, `FLAG_ALIVE`
- `flash` — remaining blindness in 20ths of a second

and per grenade (`server/demoparser/schema.js` `GrenadeEvent`):

- `type`, `throwTick`, `detonateTick`
- `from` (throw origin), `at` (detonation point)
- `path` — **the full flight trajectory, tick by tick**

That is a movement oracle, a utility-physics oracle and a flash oracle already
sitting on disk, across 3,122 professional matches on seven maps.

**Build `scripts/cs3d-oracle.mjs` before any system below.** It takes a demo, a
system under test, and reports divergence:

| Oracle | Method | Target |
|---|---|---|
| Movement | Feed reconstructed inputs, integrate, compare to recorded ticks | p95 positional drift over a 5-second untouched run |
| Grenade flight | Replay `from` + fitted release velocity, compare to `path` | p95 landing error vs `at` |
| Fuse timing | Simulated detonation tick vs `detonateTick` | exact tick match rate |
| Flash | Simulated blind duration vs the `flash` byte | p95 error in 20ths of a second |
| Damage | Simulated hit vs `DamageEvent.hp` | exact match rate by weapon and hit group |

Two warnings. Player **inputs are not recorded** — only resulting state — so
movement validation is trajectory-following (given observed velocity, does the
controller produce the observed next position?) rather than input replay.
And demo positions are quantised to ¼ unit, which sets the noise floor: a
target tighter than ~0.25u is measuring the codec, not the physics.

---

## 3. Extraction manifest

Paths in CS2 move between updates. **Discover, do not memorise** — list the VPK
and grep, exactly as CS3D-ASSETS.md says to trust `--help` over documentation:

```
tools\vrf\Source2Viewer-CLI.exe --vpk_dir -i "<CS2>\game\csgo\pak01_dir.vpk" > pak01.txt
```

Then filter that listing for what each system needs. `game/csgo_core/pak01_dir.vpk`
holds engine-level shared content and is worth listing too.

| # | System | Extract | Extensions |
|---|---|---|---|
| E1 | Tick / subtick | *(nothing — behavioural)* | — |
| E2 | Movement | Surface properties (friction per material) | `.vdata_c` / `scripts/surfaceproperties*` |
| E3 | Map physics | Already have hulls + ents. Add: door/breakable models and their `.vphys` | `.vmdl_c`, `.vphys_c` |
| E4 | Utility physics | Grenade `.vdata` (throw velocity, fuse, bounce), grenade worldmodels | `.vdata_c`, `.vmdl_c` |
| E5 | Utility effects | Particle systems for smoke / inferno / flash / HE; their sound events | `.vpcf_c`, `.vsndevts_c` |
| E6 | Weapons | `CCSWeaponBaseVData` per weapon — damage, cycle time, spread, inaccuracy, recoil params, penetration | `.vdata_c` |
| E7 | Gun + utility models | Worldmodels and viewmodels for the `shared/sim/weapons.js` roster + all six grenades | `.vmdl_c` (+ `.vmat_c`, `.vtex_c`) |
| E8 | Animations | Clips, sequences, animation graphs for weapons and players | `.vanim_c`, `.vagrp_c`, `.vanmgraph_c` |
| E9 | Viewmodel | `v_` models, arm models, viewmodel bone layout | `.vmdl_c` |
| E10 | Player models | One T + one CT agent with skeleton, hitboxes, animgraph | `.vmdl_c`, `.vphys_c` |

Economy and roster cross-reference: `scripts/items/items_game.txt`.

Three extraction risks to size early, because each can reshape a milestone:

- **Animgraphs may not export usefully.** CS2 animation is graph-driven; VRF's
  support for `.vanmgraph_c` is the weakest link in this table. If graphs do
  not come out, §E8 falls back to clips plus our own state machine — which is
  what CS3D-PLAN §2.3 already assumed.
- **Weapon `.vdata` field names change between updates.** Pin the schema by
  dumping one weapon and reading it, not by trusting a wiki.
- **Recoil patterns are probably not in the data at all.** See §E6.

---

## 4. The systems

Ten systems, grouped by dependency. Group A is the foundation and is strictly
ordered; Group B depends on A; Group C is asset-pipeline work that can run in
parallel with either.

### Group A — simulation core

#### E1. Server encoding and the tick contract

**Goal:** the simulation's notion of time matches CS2's, so that timing-sensitive
behaviour (utility especially) is reproducible.

The user's framing — "jumpthrown smokes were thrown higher at 128t than 64t in
CSGO" — is exactly right about CSGO and exactly the thing CS2 changed. CS2
introduced **subtick** input: inputs carry a sub-tick timestamp, and movement,
shooting and jumping are evaluated at the moment the input happened rather than
snapped to the tick boundary. That was Valve's stated reason for it, and it is
why jumpthrow behaviour no longer varies with server tickrate — and why
jumpthrow binds themselves were changed.

**This means the target is not "64 vs 128". It is subtick semantics.** A fixed
64 Hz loop with tick-quantised inputs will reproduce CSGO's artefacts, not
CS2's behaviour, and every utility timing test will be subtly wrong in a way
that looks like a physics bug.

- Extract: nothing.
- Derive: input timestamping, the order of input application within a tick, and
  what CS2 rounds vs interpolates. Demos record subtick input timing — the
  parser is the way in.
- Approach: keep the deterministic 64 Hz outer loop (CS3D-PLAN §0 requires it
  and training depends on it), but give inputs a fractional-tick timestamp and
  integrate in sub-steps between them. Determinism is preserved because the
  timestamps are data, not wall-clock.
- Accept: a scripted jumpthrow produces an identical release velocity at 64 and
  128 Hz outer rates. Demo-derived throw releases reproduce their `path`.
- Risk: **this is the one system that is cheapest now and ruinous later.**
  Retrofitting subtick into a tick-quantised engine means re-validating every
  system above it. Do it first even though nothing visibly depends on it.

#### E2. Movement physics

**Goal:** 1:1, replacing the current emulation in `src/cs3d/player.js`.

- Extract: surface properties (per-material friction).
- Derive: the controller. `SourceMovement.js` already has the scalar core;
  what is missing is 3D completion and the CS2-specific parts.
- Scope, explicitly:
  - Ground: friction → accelerate → wishdir, per-weapon speed caps from
    `weapons.js`.
  - Air: `airaccelerate` with the 30 u/s wish cap — **surfing and bhopping both
    emerge from this and the collide-and-slide, they are not features to add.**
    If they do not appear, the port is wrong.
  - Collide-and-slide: swept AABB 32×32×72 (54 ducked) against the BVH, step
    height 18u, walkable slope ≤ 45.57° `[verify]`. Surf ramps are the same
    code path with no ground contact.
  - Clip brushes: `playerclip` blocks the hull, `grenadeclip` does not —
    already separated in `phys.glb`, so this is wiring, not extraction.
  - Crouch fatigue: CS2 penalises repeated crouching. Model as a duck-speed
    cooldown `[verify]` — oracle is `FLAG_DUCKING` transition timing in demos.
  - Ladders: the `ladder` collision kind exists; movement mode is derive-only.
- Accept: `sim3d/movement.test.js` tapes green (time-to-215, stop distance,
  jump apex, strafe-jump distance, crouch transition); oracle p95 drift under
  target over 5-second demo runs; the operator cannot find a spot the hull
  escapes or snags that the real game does not have.
- Risk: death by a thousand constants. Burn `[verify]` markers one measurement
  at a time; the harness is the definition of done.

#### E3. Map physics

**Goal:** ladders, doors, breakables and triggers that interact with players.

- Extract: door and breakable models plus their `.vphys`; re-read the entity
  lump for `func_door`, `func_door_rotating`, `func_breakable`,
  `func_movelinear`, `trigger_push`, `prop_dynamic` with health.
- Derive: entity update semantics (open speed, blocking behaviour, damage
  thresholds).
- Approach: brush entities are **already separate nodes** in `phys.glb` with
  their classnames. A moving door is a BVH sub-tree with a transform; a broken
  one is a sub-tree removed. Neither needs a general physics engine.
- Accept: Nuke's doors open and block movement; a demo where a player walks
  through a doorway that was opened mid-round does not desync against the
  oracle.
- Note: this closes a debt SIM-PLAN §14.5 and CS3D-PLAN §10 both took
  knowingly in 2D. Doors change rotations and timings; the 2D sim guesses.

### Group B — combat

#### E4. Utility physics

**Goal:** trajectories, detonation timing, and throw-vs-movement coupling.

- Extract: grenade `.vdata` — throw velocity, fuse times, bounce restitution,
  mass/drag; grenade worldmodels.
- Derive: the throw model. Release velocity is a function of view angles, throw
  strength (full/half/short), **and the player's own velocity at release** —
  the coupling the user names.
- Approach, and this is the good part: **fit it.** The corpus has `from`,
  `path` and `at` for every grenade in 3,122 matches, and the tick record has
  the thrower's velocity and view angles at `throwTick`. That is a
  ready-made regression: solve for the velocity-contribution coefficient and
  the pitch offset directly from data, then check the residual.
- Accept: replayed throws land within p95 of `at`; `detonateTick` matches
  exactly; the mined playbook lineups (`from`/`at`/`flight`) reproduce — which
  is also CS3D-PLAN §6's acceptance and doubles as a regression suite via
  `sim:cs3d-lineups`.
- Depends on: E1 (release timing is subtick-sensitive — this is precisely the
  jumpthrow case).

#### E5. Utility effects

**Goal:** smoke, fire, flash, and the interactions between them.

The hardest system on the list, and the one where CS3D-PLAN's v1 answer
(sphere occluder) is explicitly superseded.

- Extract: particle systems for smoke, inferno, flashbang and HE; their sound
  events. Particles are the *look*; none of the behaviour is in them.
- Derive: everything behavioural.
  - **Smoke.** CS2 smoke is a volumetric voxel grid that fills space, flows
    through doorways and down stairs, and is displaced by HE and by bullets.
    The sphere model cannot express any of that. Plan a coarse voxel grid
    seeded at the detonation point, flood-filled against the BVH with a
    per-tick expansion budget, capped by volume. Resolution is the tuning knob
    and the performance risk.
  - **Fire.** Molotov spread is a set of flame spawn points propagated across
    walkable surfaces from the impact point, with damage ticks per point.
  - **Flash.** Blindness = f(angle between view and flash, distance, LOS
    occlusion). The exact curve is derive-only — and the `flash` byte in every
    tick record is a direct oracle, which makes this the most cheaply-validated
    system here.
  - **Interactions.** Smoke extinguishes fire on volume overlap; HE displaces
    smoke temporarily. Both fall out of the voxel representation; neither is
    expressible in the sphere model. This is *why* the volumetric version is
    worth the cost.
- Accept: flash p95 error under target against the `flash` oracle; a smoke
  thrown at a mined lineup occludes the same sightlines the demo shows;
  molotov + smoke extinguish reproduces; HE + smoke displacement reproduces.
- Risk: **highest on the page.** Volumetric smoke is a research task with a
  performance budget attached, and headless training needs it at ≥30× realtime.
  Mitigation: ship the sphere occluder as the fallback behind the same
  interface, and let the voxel version prove itself against the oracle before
  it becomes the default.

#### E6. Weapon physics

**Goal:** shooting, spray patterns, spray transfer, recoil, viewmodel recoil,
screen shake — all matching.

- Extract: `CCSWeaponBaseVData` per weapon — cycle time, base spread, moving
  and jumping inaccuracy, recoil angle and magnitude parameters, penetration.
- Derive: the recoil *sequence*. CSGO generated spray patterns at runtime from
  a seeded per-weapon algorithm rather than storing a table, and the community
  tables everyone uses were measured in-game, not extracted. Assume CS2 is the
  same until proven otherwise: **the pattern is very likely not in the files.**
- Approach: three separable pieces, and keeping them separate is the point —
  - *Aim punch* (where bullets go) — the simulation truth.
  - *View punch* (where the camera goes) — cosmetic, but it is what a player
    counter-strafes against, so it must match for a human to spray correctly.
  - *Viewmodel recoil and screen shake* — pure presentation, decoupled.
  Spray transfer is not a separate feature: it is the correct composition of
  recoil state with view angle changes. If transfer feels wrong, the recoil
  state machine is wrong.
- Accept: simulated spray pattern matches the measured per-weapon pattern
  within tolerance for the full magazine; `DamageEvent` reproduction rate by
  weapon and hit group; a human tester can transfer a spray between two static
  targets the way they can in game.
- Depends on: E1 (fire timing is subtick), E2 (movement inaccuracy).

### Group C — presentation

Asset-pipeline work. Parallelisable with A and B, and the same local-only rule
from CS3D-PLAN §0 applies to every byte of it.

#### E7. Gun and utility models

Worldmodels for the `shared/sim/weapons.js` roster (34 weapons) plus all six
grenades. Extract to glTF, pack the same way map geometry is packed — the
existing `cs3d-pack.mjs` texture bundling and KTX2 path applies unchanged.

Accept: every weapon in the roster renders in a viewer scene, correct scale
against the player hull.

#### E8. Animations

Clips and graphs for weapons (draw, fire, reload, inspect) and players (idle,
run, walk, crouch, jump, land, plant, defuse, death).

- Extract: `.vanim_c`, `.vagrp_c`, `.vanmgraph_c`.
- Fallback if graphs do not export: our own state machine over extracted clips.
  CS3D-PLAN §2.3 already declared this acceptable, and for the viewer and
  training consumers it is — pose-correctness matters, beauty does not.
- Accept: a demo-driven player animates through a full round without pose
  popping; weapon fire animation is frame-locked to the shot tick.

#### E9. Viewmodel

First-person arms and weapon, 1:1 — position, FOV, bob, sway, lag, and the
recoil coupling from E6.

- Extract: `v_` models and arm models.
- Derive: bob and sway curves, viewmodel offset defaults. `[verify]` against
  in-game measurement; there is no oracle in the demo corpus for this one,
  which makes it the least verifiable system here and a candidate for
  "operator eye-test" acceptance rather than a metric.

#### E10. Player models

One T and one CT agent with skeleton and hitboxes, driven by movement state.

- Extract: agent `.vmdl_c` with skeleton and `.vphys_c` hitboxes.
- Approach: hitboxes matter more than looks — E6's hit registration resolves
  against them, so extract the real hitbox set rather than the 4-box
  approximation CS3D-PLAN §5 allowed for v1.
- Accept: demo playback shows correct gait for velocity and direction; hitbox
  raycasts agree with `DamageEvent` hit groups.

---

## 5. Build order

| Step | What | Gate |
|---|---|---|
| E-0 | `cs3d-oracle.mjs` harness | reports divergence for one demo, one system |
| E-1 | Subtick tick contract | jumpthrow identical at 64 and 128 outer rate |
| E-2 | Movement controller | tapes green; oracle drift under target; hull unbreakable |
| E-3 | Map physics | doors and breakables; ladder movement |
| E-4 | Utility physics | throw model fitted; lineups reproduce; fuse ticks exact |
| E-6 | Weapon physics | spray patterns match; damage reproduction rate |
| E-7 | Weapon + utility models | roster renders at correct scale |
| E-10 | Player models + hitboxes | hitbox agreement with demo damage |
| E-8 | Animations | full round animates without popping |
| E-9 | Viewmodel | operator eye-test |
| E-5 | Utility effects | flash oracle; smoke occlusion; the interactions |

E-5 is deliberately last despite being listed second by the user: it is the
highest-risk system, it depends on E-4 for delivery, and shipping the sphere
occluder behind its interface means nothing downstream is blocked while the
volumetric version is proven.

Each step lands with its tests in the npm chain, same discipline as the sim.

---

## 6. Downstream — gated, not scheduled

The six integrations the user named are **not** part of this plan's scope, and
none of them should start before the engine passes §5. They are listed here so
the engine work knows what it must eventually support, and so nobody is tempted
to build them against a half-calibrated engine.

| # | Integration | What it needs from the engine | Already exists |
|---|---|---|---|
| 1 | Bots train in 3D (navaja, paracord) | `engine3d` implementing the 2D engine's API; BVH vision traces replacing the angle-catalogue approximation | The brains, the tapes, the caller, `desireBot` |
| 2 | Timeline viewer in 3D | E7/E8/E10 + demo playback. **No physics at all** | The 2D viewer's scrub/round UI, tick buffers |
| 3 | Free play / empty server | E2, E4, E5, plus a spawn-and-place UI | Map loading, spawns |
| 4 | Stratbook recordings in 3D | Deterministic playback; the recording format extended with pitch | The 2D stratbook |
| 5 | Play-against (dropped into a round) | Everything, plus round-state seeding from a demo tick | Round reconstruction in the replay stack |
| 6 | FPS maps into deathmatch and duels | E2, E6, E9, E10 + the trainer's existing gamemode loop | The aim trainer, matchmaking, entitlements |

Two observations worth acting on now, because they cost nothing during engine
work and are expensive to retrofit:

- **#2 needs no physics.** It is E7+E8+E10 over data already on disk, which
  makes it the cheapest possible proof that the model and animation pipeline
  works — and CS3D-PLAN §7 already argues demo playback should come first for
  exactly that reason. It is the natural acceptance test for Group C.
- **#1 is the reason determinism is non-negotiable.** Every system above must
  hold the "same seed → same result" line, in Node with no renderer. A system
  that only reproduces in the browser is not done.

---

## 7. Risks

| Risk | Position |
|---|---|
| Subtick retrofitted late | E-1 first, before anything depends on tick semantics |
| Volumetric smoke cost, especially headless | Sphere occluder behind the same interface; voxel version must earn its place against the oracle |
| Recoil patterns not extractable | Assume measured-not-extracted; budget in-game measurement time |
| Animgraph export gaps | Clip-plus-state-machine fallback declared acceptable up front |
| Movement parity by a thousand constants | Oracle harness is the definition of done |
| Viewmodel has no oracle | Accept eye-test acceptance for E-9 only; do not let that standard spread |
| Extraction is Windows-only | All of §3 is workstation work; the Mac verifies against packed output |
| Asset legality | CS3D-PLAN §0's local-only rule applies unchanged to models and animations |
| Scope creep toward "a game" | CS3D-PLAN §10 stands: no netcode, no matchmaking, no cosmetics |

---

## 8. Open questions

1. **Does the demo parser expose subtick input timing today?** E-1's whole
   approach depends on it. If not, that is a parser task and it is on the
   critical path.
2. **CS2 movement constant drift.** `SourceMovement.js` carries CSGO-era
   numbers. Which have changed? The oracle answers this, but it needs a first
   pass to know how much of §E2 is porting versus re-deriving.
3. **Smoke resolution budget.** What voxel resolution is acceptable at ≥30×
   realtime headless for ten bots? This decides whether E-5's volumetric path
   is viable for training or viewer-only.
4. **Hitbox fidelity vs the 2D duel model.** The fitted duel model was trained
   against 4-box geometry. Moving to real hitboxes is strictly better input but
   invalidates that calibration — plan the re-fit.
5. **Which map first?** The renderer's home is Nuke (the only packed map). The
   sim's home is Inferno. Movement work wants the map with the nastiest
   geometry; Nuke's two floors and Inferno's banana both qualify.
