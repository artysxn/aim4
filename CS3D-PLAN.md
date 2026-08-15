# CS3D: the 3D replica

A plan for a playable 3D Counter-Strike replica: enter a real map, run around,
shoot, throw grenades — the game, minus everything that is not the game. Two
consumers, in order:

1. **The 3D demo viewer.** Watch a real pro demo inside the real map, first
   person or free cam. Every `.aim4replay` we have already carries per-tick
   `x, y, z, yaw, pitch` for all ten players (`tickFormat.js`) — the 3D viewer
   is *rendering over data we already ship*, not new simulation.
2. **The 3D bot embodiment.** The sim brain (desireBot, the caller, the tapes)
   drives 3D bodies through the same intent contract it drives 2D bodies
   today. SIM-PLAN's domain-gap table already promises this step: "Knowledge
   tracker in 3D uses real engine traces: strictly better inputs than
   training." This plan is that milestone's floor.

Not a shipped game. A lab instrument that happens to be playable.

## 0. Ground rules

- **Assets are local-only, forever.** Maps, models, animations extracted from
  the operator's own game install. They never enter git, never get served by
  aim4.io, never ship in a bundle. The importer writes to a gitignored
  directory (same split as the v2 playbook corpus: raw data local, derived
  compact artifacts committable only if we made them ourselves — nav meshes,
  collision hulls we baked, calibration tables). The hosted site keeps its 2D
  viewer; the 3D viewer runs locally, or loads the operator's asset pack from
  local disk via the File System Access API so the server never touches it.
- **The open-source replica is a reference, not a dependency, until its
  license says otherwise.** [operator: name the repo] Before any code moves:
  check the license. Permissive (MIT/BSD/Apache) → we may port code directly
  with attribution. GPL → it stays a *reference implementation* we test
  against (numbers, behaviors, formulas), or lives in an isolated
  GPL-compatible tool that is not part of the site bundle. Animations data
  extracted from the game files follows the local-only rule regardless.
- **Determinism or it did not happen.** Fixed 64-tick, seeded RNG, no
  wall-clock reads in the step loop — identical to the 2D engine's rule. The
  training consumer is unusable without it, and the viewer gets replay
  scrubbing for free from it.
- **One brain, two bodies.** The 2D engine's API (`setIntent`, `step`,
  `state.bodies`, `beginPlant`, `beginDefuse`, `clock`, percept events) is the
  contract. `engine3d` implements the same surface. The translator, desireBot,
  the caller, the tapes — none of them learn they are in 3D. Anything that
  needs a new capability (pitch aim, jump, crouch intent) extends the contract
  in BOTH engines or in neither.

## 1. Stack

**Browser + Three.js for the client; the same code headless in Node for
training.** The whole of aim4 is a Vite/Three-adjacent web app, the 2D viewer
exists, the replays are already served, and the sim already runs headless in
Node at 64 Hz. A native engine (Godot/Unity) would render faster and split
the codebase in half, cost the demo-viewer-in-the-site story entirely, and
add an IPC boundary between brain and body that the 2D sim proved we do not
need. Web wins.

- Rendering: Three.js on the **WebGL2 backend** (decided; the trainer already
  ships Three 0.169). Map scale is an importer problem — chunking, frustum
  culling, instanced props, KTX2 textures — not a renderer-API problem;
  Three's WebGPU backend stays a later swap behind the same scene code, taken
  only if a measured bottleneck asks for it. glTF assets, `three-mesh-bvh`
  for raycasts against map geometry (vision traces, bullets, grenade
  collisions all share the BVH).
- Physics: our own character controller (§4). No general-purpose physics
  engine — CS movement is not physical, it is *Source*, and every ported
  general engine fight ends with rewriting the controller anyway. Grenades
  are the only free-flying bodies and they are a sphere against the BVH.
- Headless: the identical `shared/sim3d/` modules run in Node with no
  renderer. The BVH and math are plain JS/typed arrays — nothing imports
  `three`'s renderer outside `src/`.

## 2. Asset pipeline

`scripts/cs3d-import.mjs` — runs on the operator's machine, against the
operator's install, writes `server/data/cs3d/<MAP>/` (gitignored).

1. **Maps.** Source 2 content out of the game's `.vpk` via ValveResourceFormat
   (Source2Viewer CLI) → glTF (world geometry, materials as baked flat
   textures v1) + the physics collision meshes (`.vphys` hulls/meshes — VRF
   exports these; they are the authoritative walkable/solid answer, far
   cleaner than raycasting render geometry with its foliage and clutter).
   Output per map: `world.glb` (render), `phys.glb` (collision),
   `meta.json` (spawns, bomb sites, buy zones as AABBs, extracted or
   hand-marked v1).
2. **Player + weapon models.** VRF → glTF with skeletons. Two agent models v1
   (one T, one CT), viewmodel arms + one worldmodel per weapon class we
   simulate. Cosmetic variety is a non-goal.
3. **Animations.** From the game files where extractable, else from the
   replica [license permitting], else v1 = walk/run/crouch cycles + aim pose
   blended per pitch, which is enough for a *viewer* (players glide but stand
   and aim right, which is what analysis needs). Full anim graph parity is
   explicitly later.
4. **Calibration table.** One committed JSON per map: the affine transform
   between demo/world coordinates and the 2D radar coordinates the whole
   existing product uses (`mapCalibration.js` already holds radar↔world for
   2D — extend it with z). This is OUR derived data: committable.

Acceptance for the whole pipeline is visual and cheap: overlay the 2D nav
anchors (we have them for 7 maps) into the 3D scene at their world positions
— every anchor must sit on a walkable floor, doorways line up, site boxes
contain the sites. If the anchors float or sink, the transform is wrong and
nothing downstream is worth testing.

## 3. Coordinates

One module, `shared/sim3d/units.js`, tested, and no coordinate math anywhere
else. Source: x/y horizontal, z up, units (1u = 0.0254 m — the constant
already lives in `SourceMovement.js`). Three: y up, right-handed. The module
owns: source→three vectors, yaw/pitch→quaternion, and the per-map calibration
from §2.4. Every past 2D viewer bug in this area was a sign flip done inline
somewhere; centralizing is the fix.

## 4. Movement (the fidelity item everything rests on)

Port of Source movement, 3D-complete. We already run a faithful 1D/2D subset
(`src/utils/SourceMovement.js`: 215/112/73 speeds, accel 5.5, friction 5.2,
stopspeed 80, gravity 800u/s², eye heights) — the 2D sim walks on it today.
Extend to the full controller:

- Ground move: wishdir from yaw + WASD, friction, accelerate, per-weapon
  speed caps (the sim's `weapons.js` tables are the source of truth — knife
  250 included, and the knife-out model from the 2D engine carries over).
- Air: airaccelerate with the 30 u/s wish cap (strafe jumping emerges from
  this constant or the port is wrong).
- Jump: impulse 301.99 u/s `[verify against replica]`, crouch-jump, no
  auto-bhop (CS2 rules: speed clamp on landing `[verify]`).
- Hull: AABB 32×32×72, 54 crouched, eye 64.06 / 46.04 `[verify]`; swept-AABB
  collide-and-slide against the `.vphys` mesh, step height 18u, walkable
  slope ≤ 45.57°, NOCLIP free-cam for the viewer.
- Ladders, water: parked until a map needs them (none of the 7 active maps
  hinge on either for v1) — listed so they are a decision, not a discovery.

**Parity harness, not vibes:** `sim3d/movement.test.js` replays scripted
input tapes and asserts positions against numbers taken from the reference
replica (or in-game measurement): flat-ground time-to-215, stop distance,
jump apex and hang time, crouch transition time, a strafe-jump distance.
The same tape must produce the same trajectory byte-for-byte across runs
(determinism) and across Node/browser (no `Math` divergence — use the same
seeded RNG and avoid trig identities that differ; test it).

## 5. Weapons

Hitscan against the BVH + player hitboxes (head/chest/stomach/legs boxes
bound to the skeleton — 4 boxes v1, not per-bone). Damage, armor, penetration
falloff, movement inaccuracy, spread and recoil patterns: **port from the 2D
sim's `weapons.js`**, which already models this in units the brain
understands; where 2D simplified (recoil as cone), 3D inherits the
simplification v1 and upgrades behind the same table. Tracers and impact
decals for the viewer. Wallbangs: single-surface penetration with material
damage scale v1 `[verify table]`, no multi-surface.

## 6. Grenades

Sphere projectile against the BVH: gravity, bounce restitution ~0.45
`[verify]`, friction on bounce, fuse clocks from the 2D sim's constants.

- HE: radius damage with LOS falloff (2D tables).
- Flash: dot(view, toFlash) + LOS trace → flash duration; write `flash` into
  the replay record like the parser does.
- Molly: spread patch on the floor polygon hit; damage ticks; extinguish by
  smoke overlap.
- Smoke: **v1 is a sphere occluder** with CS2 radius and lifetime: vision
  traces test against it, rendering is a billboard/volume blob. CS2's real
  volumetric fill (spreads through doorways, dispelled by HE) is explicitly
  out — flagged as the known fidelity gap, same family as doors in SIM-PLAN
  §14.5. The mined lineups (playbook utility, `from`/`at`/`flight`) must
  reproduce: **acceptance is a mined smoke replayed in 3D landing within
  ~50u of where the demo says it detonated.**

## 7. The milestones

### M1 — Demo playback (build FIRST, no physics needed)

Load map, animate ten models straight off `.aim4replay` tick buffers
(x/y/z/yaw/pitch/weapon/flags are all in the record), grenade arcs from the
parser's grenade events, kill feed from round events. Free cam + chase cam +
first person. Reuse the 2D viewer's round/scrub/timeline UI (`playback.js`)
— same scrub bar drives both renderers, and the 2D radar stays on screen as
the minimap. **This milestone validates the entire asset pipeline against
ground truth**: 3,122 demos of players walking through doorways will find
every transform error, which is why it precedes movement code.

Accept: an INF round plays end to end; nobody clips through world geometry
that the demo says they walked around; smokes/mollies appear at demo
positions; the same round scrubbed twice renders identically.

### M2 — Movement sandbox ("enter a map and run around")

The §4 controller under a first-person client: spawn menu (map, T/CT),
WASD + mouse, jump/crouch/walk, weapon switching with correct speed caps,
knife out to run. No opponents, no HUD beyond speed/pos debug overlay.

Accept: the §4 parity harness green; the operator runs Inferno bananas and
apartments and cannot find a spot the hull escapes or snags that the real
game does not have.

### M3 — Shooting + grenades

§5 + §6 against static targets and thrown-at-will nades. Lineup mode: stand
on a mined lineup's `from`, throw, measure landing error against the tape —
this doubles as the §6 acceptance harness, run over every mined lineup on
the map (`sim:cs3d-lineups` script, reports p50/p95 landing error).

### M4 — Headless + bot embodiment

`engine3d` implements the 2D engine's API surface; `translator3d` maps the
same intents (`moveTo`, gait, knife, yaw — plus pitch) onto controller
inputs; navigation reuses the existing per-map nav graph for global routing
(it is a projection of the same floors) with 3D funneling local steering.
Vision: replace the 2D angle-catalogue approximation with real BVH frustum
traces — the strictly-better input SIM-PLAN promised. desireBot plays a full
round vs itself in 3D, headless, deterministic.

Accept: the sim suite pattern reruns green against engine3d (engine, round,
match level); same seed → same round; a tape-following T side executes onto
A in 3D with the caller's tapes unchanged.

### M5 — Demo-vs-sim split screen (the payoff)

The viewer plays the real demo and the bots' re-simulation of the same round
side by side in the same 3D map. This is the eye-test instrument the 2D
motive feed was built for, at full fidelity.

## 8. Performance targets

- Viewer: 60 fps on the operator's machine with 10 models + Inferno; BVH
  raycasts only for the local player's crosshair. Nothing here is hard.
- Headless: ≥ 30× realtime per core for a 10-bot round (vision traces are
  the budget: ~10 bots × ~20 rays × 64 Hz ≈ 13k raycasts/s against a static
  BVH — comfortably cheap; if belief wants more rays, budget per decision
  tick, not per engine tick, like the 2D attention system already does).
  RL-scale training parallelizes by process, same as the 2D pipeline.

## 9. Risks, named

| Risk | Position |
|---|---|
| VRF export gaps (a map that will not export clean) | Start with INF + DD2; a map that fights the pipeline waits, the plan does not |
| Movement parity death by a thousand constants | The parity harness is the definition of done; the replica is the oracle; `[verify]` markers burn down one measurement at a time |
| Smoke fidelity | Sphere v1, declared divergence, revisit only when a training result hinges on it |
| Animation quality | Viewer needs pose-correctness, not beauty; glide-walking is acceptable v1 |
| License of the replica code | Checked before the first line is ported; GPL demotes it to oracle |
| Asset legality | Local-only rule in §0, enforced by gitignore + the importer refusing non-local output paths |
| Scope creep toward "a game" | §10 |

## 10. What we are not building

Netcode, matchmaking, other humans. Anti-cheat. Buy menu UX (the sim buys).
Sounds v1 (events exist; audio is additive later — footstep/nade sound
*percepts* for bots come from the event bus like 2D, not from audio).
Cosmetics, skins, sprays. Workshop. Other modes. Doors that open, breakable
glass, boost-on-head physics — same known-debt list as SIM-PLAN §14.5,
inherited knowingly.

## 11. Build order

| Step | What | Accept |
|---|---|---|
| 3D-0 | units.js + importer + INF renders, anchors overlaid | anchors sit on floors, doors line up |
| 3D-1 | M1 demo playback | real round plays clean; scrub deterministic |
| 3D-2 | collision + §4 controller | parity harness green; operator cannot break the hull |
| 3D-3 | §5 weapons vs targets | table parity with 2D sim; hit reg on all 4 boxes |
| 3D-4 | §6 grenades + lineup harness | mined lineups land ≤ ~50u p95 |
| 3D-5 | M2 sandbox polish | "it feels like CS" from the operator, in those words |
| 3D-6 | engine3d + translator3d headless | engine/round/match-level suites green in 3D; deterministic |
| 3D-7 | desireBot in 3D, tapes unchanged | a called execute lands on site in 3D |
| 3D-8 | M5 split screen | demo and re-sim side by side, one scrub bar |

Each step lands with its tests in the npm chain, same discipline as the sim.

## 12. Open questions for the operator

1. Name and license of the reference replica (drives §0's port-vs-oracle
   decision).
2. CS2-era assets or CS:GO-era? (VRF handles Source 2; CS:GO would mean
   Crowbar/StudioMdl-era tooling instead — different importer, same plan.)
3. First map: INF assumed (the sim's home map). Confirm.
4. Does the 3D viewer need to reach non-operator users soon? If yes, the
   local-asset-pack UX (§0) moves up from "later" to M1.
