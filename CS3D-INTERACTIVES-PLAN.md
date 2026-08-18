# CS3D Interactives Plan — doors, glass, vents, props

Making the parts of a map that move and break actually move and break. This is
CS3D-ENGINE-PLAN **E-3 (Map physics)**, expanded, and written after extracting
the real data rather than before it.

Every number below was read out of the game's own files on 2026-08-18, using the
local CS2 install and `tools/vrf/Source2Viewer-CLI.exe`. Where something is not
known, it says so.

---

## 0. The one thing that makes this different from grenades

Grenades were easy to get exact for a reason that does not repeat here: **the
demo networks the projectile's own physics state**, so every constant could be
read off the entity that flew. Doors and breakables have no such oracle.

Confirmed by probing a demo:

| | |
|---|---|
| Entity classes demoparser2 exposes | `CCSGameRulesProxy`, `CCSPlayerController`, `CCSPlayerPawn`, `CCSTeam`, `Grenade`, `Weapon` |
| Break/door game events in a demo | `entity_killed` — and nothing else |
| Door state in the tick stream | absent |

So the note already in `server/demoparser/schema.js` is right: doors are not
captured and cannot be.

**The consequence is not that we have to guess — it is that the source of truth
moves.** For grenades, truth was the demo. For interactives, truth is the map's
own entity lump and the model files, which is `[docs]`-grade provenance: not
fitted, not measured, just read. That is a stronger starting position than the
grenade work had.

What we lose is end-to-end validation. There is no equivalent of
`scripts/cs3d-nade-oracle.mjs` replaying 400 real throws against ground truth.
Section 7 says what to do instead.

---

## 1. What is actually on a map

Nuke's entity lump (`maps/de_nuke/entities/default_ents.vents` — one lump, 702
entities). The interactive ones:

| classname | count | what it is here |
|---|---|---|
| `prop_door_rotating` | 4 | the swinging metal doors |
| `prop_dynamic` | 18 | includes the roll-up garage door and the vents |
| `func_breakable` | 2 | brush breakables, `health = 1` |
| `prop_physics_multiplayer` | 25 | loose props (hard hats, cones) |
| `func_brush` | 20 | toggleable brush geometry (`[PR#]brush.blocker`) |
| `func_clip_vphysics` | 6 | physics-only clip |
| `func_nav_blocker` | 4 | bot navigation only, no collision |

Two things to notice, because both shape the design:

1. **The vents are `prop_dynamic`, not `func_breakable`.** Their breakability is
   not an entity key at all. It lives in the model.
2. **Brush-entity geometry is a model too.** `func_brush`, `func_breakable` and
   `func_clip_vphysics` all carry
   `model = "maps/de_nuke/entities/<name>.vmdl"`, and the Nuke VPK holds 806 of
   those. So "brush entity" and "prop" turn out to be the same extraction
   problem, which is convenient.

### 1.1 Doors, in full

Every `prop_door_rotating` on Nuke carries its complete specification:

```
model      models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001.vmdl
distance   89.0          degrees of swing
speed      200           degrees per second
opendir    0             which way it may open
health     0             not breakable by damage
forceclosed true|false   whether it shuts itself again
spawnflags 8192
slavename  [PR#]door_01  a second door that opens with this one
soundopenoverride      Door.de_nuke_full_open_01
soundunlockedoverride  Door.de_nuke_unlock_01
```

`distance` and `speed` together mean a door takes `89 / 200 = 0.445 s` to open.
That is not a guess and it is per-door: nothing here needs a constant invented.

The `slavename` link matters. `door_02` names `door_01` as its slave, which is
how the double doors swing as a pair.

**A door is not destructible, but an HE blows it open.** The door model carries
no `prop_data` block and no `BreakPieceList` at all, and the entity's
`health = 0`, so there is nothing there to damage — the blast swings it to its
open position instead. Doors and breakables therefore need two different rules
out of the same HE detonation: breakables take damage, doors take an impulse.

### 1.2 Breakables, in full

`func_breakable` carries `health = 1`, plus `material`, `physdamagescale`,
`explodedamage`, `exploderadius`, `minhealthdmg`.

The vents carry theirs in the model. From
`models/props/de_nuke/hr_nuke/nuke_vent_slats/nuke_vent_slats.vmdl`:

```
game_class = "prop_data"
game_keys = {
    base          = "Metal.Medium"   inherits from the prop damage table
    health        = 1.0
    dmg.bullets   = -1.0
    dmg.club      = -1.0
    dmg.explosive = -1.0
    dmg.fire      = -1.0
}
BreakPieceList: 10 x BreakPieceExternal
    model = ".../nuke_vent_slats/piece.vmdl"
    collision_group_override = "debris"
    fadetime = 4.0
    random_spawn_chance = 1.0
```

**`-1.0` is "no override", not "immune".** It sits on all four damage types
including `dmg.bullets`, and a vent immune to bullets could not be broken at
all. The real multipliers come from `base`, which points into
`scripts/propdata.vdata` — a second inheritance chain, resolved exactly the way
`readWeaponTable()` already resolves `_base` in the weapon table:

```
Metal.Medium   dmg.bullets 1.0  dmg.club 1.0  dmg.explosive 1.0  health 0
               _base = "Metal.Base"   physicsmode 1
Metal.Base     dmg.bullets 1.0  dmg.club 1.0  dmg.explosive 1.0  health 0
```

Resolved, a vent has **health 1** (the model overrides the base's 0) and takes
full damage from bullets, melee and explosives.

**`propdata.vdata` defines exactly three damage types — `dmg.bullets`,
`dmg.club` and `dmg.explosive` — and the string `dmg.fire` does not occur
anywhere in the file.** Fire is not a damage type a prop responds to. That is the
whole explanation of the observed behaviour: an HE breaks a Nuke vent, and a
molotov burning on top of it does nothing at all.

So a vent takes one point of bullet, melee or explosive damage, ignores fire
entirely, and shatters into ten named gib models that fade after four seconds.

The door model has **no** `BreakPieceList` — doors do not shatter. It does have
a `metal_door_001_glass` material, so glass in a door is a material rather than
a separate breakable entity.

---

## 2. The hard part: collision that changes

Everything else in this plan is bookkeeping. This is the actual engineering.

Today `src/cs3d/mapLoader.js` merges all collision into **one static BVH**, in
bands, and `src/cs3d/hullWorld.js` gives each audience (player, grenade, light) a
triangle-index range filter over it. That design fits static geometry well. It
cannot express geometry that moves or disappears.

Three sub-problems, three different answers.

### 2.1 Things that disappear (breakables) — a per-triangle mask

The cheapest possible change. The band filter in `hullWorld.js` already runs a
per-triangle predicate, so this is one more array lookup:

```js
if (disabled && disabled[i]) return false;
```

`disabled` is a `Uint8Array` over the merged triangle count, owned by the map
pack and flipped when an entity breaks. The pack records, per interactive entity,
the triangle range it occupies — the bands already prove that technique works.
Breaking is then a `fill(1)` over one range.

Cost: one byte per triangle (191 KB on Nuke) and one array read per triangle
test. No rebuild, no second BVH, no allocation.

**This only works because triangle indices survive the BVH build**, which is true
only with `indirect: true` and only without a `resolveTriangleIndex` call. The
measurements behind that are in the header comment of `hullWorld.js`, and
`src/cs3d/hullWorld.test.js` guards it.

### 2.2 Things that move (doors) — their own small hull

A moving door cannot be a range in a static BVH. But a door is tiny: one
`metal_door_001` hull is on the order of tens of triangles. So each moving entity
gets its own triangle soup in **local space**, and the broadphase transforms the
query into that space instead of transforming the geometry:

```
localStart = doorInverseMatrix * start
localEnd   = doorInverseMatrix * end
```

For a rotating door the matrix is a hinge rotation, so this is exact rather than
an approximation of a swept rotation. The tracer then runs against a handful of
triangles with no BVH at all — a linear scan beats a tree at this size, and
`shared/sim3d/hullTrace.js` already ships `triangleSoupTracer` for exactly this
shape of world.

`createHullWorld` grows from "one BVH" to "one BVH plus a short list of
transformed hulls", returning the nearest hit across both. The audience filter
applies to the movers too: a door blocks players and grenades, a broken vent
blocks neither.

### 2.4 The blocker found while building: interactive geometry is baked in

Discovered after this plan was first written, and it changes the shape of the
work. The packed world render bakes door and vent geometry into **aggregate
nodes merged per model per cell** — 169 such nodes on Nuke, named like
`n0_lr0_agg_merge_metal_door_001_0_fragment1_c0_0`, several thousand triangles
each. Every `metal_door_001` in a cell is one mesh, interactive and decorative
alike.

So an individual door cannot be hidden or moved at runtime: there is no node
that is just that door. The same is true of the vents.

This gates RENDERING only. The simulation, the damage model and the collision
mask are all unaffected, because none of them reads the world render. But making
a door visibly swing needs `scripts/cs3d-pack.mjs` to emit interactive entity
geometry as its own node instead of merging it into the world aggregate — and
that means re-packing every map and re-uploading, which is hours, not minutes.

Until that happens the honest state is: doors and breakables know what they are,
what breaks them and how fast they swing, and can be driven and tested headlessly
— they just cannot be seen to move.

### 2.3 Things that fall over (physics props) — deliberately out of scope

`prop_physics_multiplayer` (25 on Nuke: hard hats, cones) needs a rigid-body
solver with friction, angular momentum and stacking. That is a physics engine,
not a feature, and the tactical value is close to zero. **Not in this plan.**
They stay static props. If they are ever wanted it is a separate decision with a
library attached to it.

---

## 3. Pack-side work (`scripts/cs3d-pack.mjs`)

The entity lump is already parsed. `parseEnts()` reads every entity and
`extractMeta()` keeps spawns, bomb sites, buy zones, fog and the sun, then throws
the rest away. So this is extraction, not new plumbing.

**P1. Emit an `interactives` array into the manifest.** Per entity: a stable id,
classname, origin, angles, the model reference, and the class-specific keys
(`distance`, `speed`, `opendir`, `forceclosed`, `slavename`, `health`,
`spawnflags`, the sound overrides).

**P2. Export the models.** Two sources, one path each:

- props: `models/props/de_nuke/...` from `pak01_dir.vpk`
- brush entities: `maps/de_nuke/entities/*.vmdl` from the map VPK

Both go through the same VRF export the weapons pipeline already uses. Pack them
into one `interactives.glb` per map, one node per entity id.

**P3. Export the break pieces.** For any model with a `BreakPieceList`, export
each `BreakPieceExternal` model too, and record `fadetime`,
`random_spawn_chance` and `collision_group_override`. Gibs are `debris`: they
collide with the world but not with players, which is a fourth collision audience
and drops straight into the band scheme.

**P4. Resolve the prop damage chain and record the result.** Two files, two
levels: the model's `game_keys` (`health`, `base`, and any genuine `dmg.*`
override) and `scripts/propdata.vdata` (the `Metal.Medium` -> `Metal.Base`
chain). Extract `propdata.vdata` once per pack the way `cs3d-weapons.mjs`
already extracts `weapons.vdata`, resolve `_base`, and store the effective
`health` plus the three multipliers per entity. Treat `-1.0` as absent, not as
zero.

**P5. Tag collision triangles with their entity id.** `packPhysics()` already
tags entity hulls with `kind: 'entity'` and `classname`; extend that to carry the
id, and emit the per-entity triangle ranges the runtime mask in 2.1 needs.

Also add the missing classes to `ENTITY_SOLID_RE`, which today does not include
`prop_door_rotating` at all — meaning **doors currently have no collision in the
explorer whatsoever**. Worth knowing before anyone tests a door.

Bump `PACK_VERSION`; assets and client ship together, as always.

---

## 4. Runtime work (`src/cs3d/`)

**R1. `interactives.js` — the entity registry.** Loads `interactives.glb` and the
manifest rows, instantiates one object per entity, owns their state (`closed`,
`opening`, `open`, `broken`), and ticks them at the fixed 64 Hz alongside
`projectiles.js`. Same shape as that file: a headless state machine plus a thin
three.js body.

**R2. Doors.** A rotation about the hinge, `speed` degrees per second, stopping
at `distance`. Master and slave move together via `slavename`. `forceclosed`
re-shuts after a delay. A door blocked by a player is a `traceHull` against its
swept volume; CS2 stops the door rather than pushing.

**R3. Breakables.** Health, damage-table multipliers, and on death: hide the
model, flip the collision mask, spawn the gibs, play the sound. Gibs are the one
place a crude rigid body is acceptable — they are cosmetic and last four seconds,
and `shared/sim3d/grenade.js` already has a bounce-and-rest integrator that fits
them exactly.

**R4. Damage sources.** Three, and only one of them exists today:

- **HE.** `nadeEffects.js` already knows where a blast happened and its radius;
  it needs to report that to the registry, which does two different things with
  it: damage to breakables (times `dmg.explosive`), and an open impulse to any
  door in range. This is the path that breaks Nuke's vents.
- **Molotov: nothing.** Fire is not a damage type in `propdata.vdata`. A molotov
  burning on a vent leaves it intact, and the registry should not special-case
  that — it falls out of the damage table having no fire column at all.
- **Bullets.** There is no world hitscan in the explorer yet — `viewModel.attack()`
  plays an animation and nothing leaves the barrel. A ray against the collision
  BVH with the audience filter is small work, and it is the prerequisite for
  shooting a vent. It belongs to E-6, but this plan needs a minimal version.
- **Use (`+E`).** Doors only. A short ray from the eye, a range check, a
  classname test.

**R5. Sounds.** The entity lump names the sound events
(`Door.de_nuke_full_open_01`). There is no sound system in cs3d at all, so this
is stubbed behind an interface and left for whenever audio lands.

---

## 5. Interaction with what already exists

| system | what changes |
|---|---|
| `hullWorld.js` | audience filter gains the disabled-triangle mask and the mover list |
| `mapLoader.js` | bands gain per-entity ranges; collider exposes them |
| `projectiles.js` | grenades bounce off closed doors and through broken vents, free once collision is dynamic |
| `nadeEffects.js` | reports blast damage to the registry |
| `sunlight.js` | a broken vent should stop casting, but the shadow mask is baked — a known limitation, not a fix |
| `demoView.js` | replay can drive breakables from `events.broken` (section 6) |

---

## 6. The replay side

`PARSER_REVISION` 3 already records `events.broken` — raw `entity_killed` rows
with indices undecoded, deliberately kept so a per-map table could decode them
later. This plan builds that table: pack-side entity ids are stable, so a per-map
`entityIndex -> interactive id` mapping turns those rows into "this vent broke on
this tick" during replay.

Doors stay unrecoverable in replays. Nothing in the demo carries their state and
no amount of table-building changes that. A replay shows doors in their spawn
state unless someone infers them from player movement, which is not worth doing.

---

## 7. How this gets verified without an oracle

The grenade work could measure itself. This cannot, so verification is structural
rather than statistical:

1. **Extraction round-trip.** Every value in the manifest must equal the value in
   the file it came from. A test that re-reads `default_ents.vents` and the
   `.vmdl` and diffs against the packed manifest catches the whole class of "we
   mis-parsed a key", which is by far the most likely failure.
2. **Collision-mask unit tests**, in the shape of `hullWorld.test.js`: a player is
   stopped by a closed door and not an open one; a grenade passes a broken vent
   and not an intact one; a gib collides with the world and not with a player.
3. **Geometry sanity.** A door's swept volume must not intersect the wall it is
   hinged to at any point in its arc. Checkable offline for every door on every
   map, and it catches a wrong `opendir` or a hinge on the wrong edge.
4. **The one real-world check available.** `events.broken` from the ten demos in
   `sampledemos/` says that *something* broke at a given tick. Once the index
   table exists, the count and rough position of breakages is a weak but genuine
   cross-check that the right entities were tagged breakable.
5. **The operator.** Doors and vents are things you can look at. Unlike a bounce
   coefficient, a door opening the wrong way is obvious in one second, so visual
   sign-off is worth more here than anywhere else in the engine.

---

## 8. Open questions

Two questions that were open in the first draft are now closed, and both were
closed by testing in game rather than by reading a file harder. Worth recording
because the first reading was confidently wrong:

- **`dmg.* = -1.0` means "no override", not "immune".** The first draft read it
  as immunity and concluded an HE could not break a Nuke vent. It can. Section
  1.2 has the inheritance chain that actually decides it.
- **Doors are blown open by HE.** Not destroyed — moved. Section 1.1.

Still unresolved, and not to be quietly decided in code:

1. **`spawnflags = 8192` on every Nuke door** — which flag is that, and does it
   change the open behaviour? The flag table is not in any file we have.
2. **Do the other six packed maps look like Nuke?** Every number here is Nuke's.
   The same extraction should run across all seven before the schema is fixed: a
   map with a `func_movelinear` or a `func_breakable_surf` adds a case.
3. **Does the lightmap need anything?** Breaking a vent changes what the sun
   reaches, and the shadow mask is baked. Almost certainly accept the artifact,
   but make it a decision rather than an oversight.

---

## 9. Order of work

| # | step | depends on | size |
|---|---|---|---|
| 1 | Extract and manifest interactives for all seven maps (P1) | — | small |
| 2 | Answer the open questions in section 8 | 1 | small |
| 3 | Export entity and gib models, pack them (P2, P3, P4) | 1 | medium |
| 4 | Per-entity triangle ranges, `ENTITY_SOLID_RE` fix (P5) | 3 | small |
| 5 | Dynamic collision: mask and movers (2.1, 2.2) | 4 | medium, the risky one |
| 6 | `interactives.js` registry, doors first (R1, R2) | 5 | medium |
| 7 | Minimal world hitscan (R4) | 5 | small |
| 8 | Breakables and gibs (R3) | 6, 7 | medium |
| 9 | Replay index table (section 6) | 1 | small |
| 10 | Sound interface stub (R5) | 6 | tiny |

Doors before breakables on purpose. Doors exercise the moving-collision path,
which is the part of this that can go wrong in ways the tests in section 7 would
not catch, and they are the half of the feature that is already fully specified
by data.

---

## 10. What was built, 2026-08-18

Nuke only, as asked. Every number below is measured, not estimated.

### The geometry split (`scripts/cs3d-split-interactives.mjs`)

The blocker in 2.4 is closed, and without the 17 GB re-pack the plan feared. It
post-processes the packed `geo/*.glb` in place: 6 of Nuke's 80 world groups
change, 6,064 triangles move into a 247 kB `interactives.glb`, and only the
index buffers shrink so the manifest's per-material totals stay true. `geo.orig`
is kept beside it and `--restore` puts it all back.

Attribution ended up needing two rules and, more importantly, an order between
them:

* **By model node**, first. A node named after an interactive's model belongs to
  the interactives as a whole, and each triangle goes to the NEAREST one, not to
  the model that named the node. That detail is load-bearing:
  `nuke_window_93x76.unnamed_1` holds 48 triangles which are two 93x76 windows
  AND two 63x76 ones. An earlier version matched model-to-model and silently
  lost the 63x76 pair.
* **By collision hull**, only as a fallback. `phys.glb` already carries one
  `kind: entity` node per breakable — 17 on Nuke, with classname and surface —
  which is an exact box. Run first it over-claims badly: a window's hull is a
  box around the PANE, and the window FRAME is separate static geometry standing
  in the same box, so it cut the frames out with the glass (456 triangles for a
  two-triangle pane). On Nuke the first rule finds all 21 and this never fires.

The result checks itself: every window's measured bounds match the dimensions in
its own model name (`nuke_window_84x68` → 14 × 84 × 67), and
`interactives.test.js` asserts that.

| | count | triangles |
|---|---|---|
| doors (`metal_door_001_br`) | 4 | 572 each |
| vents | 3 | 564, 564, 2500 |
| glass | 14 | 12 each, except two 2-triangle brush panes |

### Collision that changes (2.1, 2.2), both real

`collider.mask` is a `Uint8Array` over the merged BVH, honoured by every tracer
through `hullWorld.js`. It works because the BVH is `indirect: true` and the
shapecast index is therefore the original triangle — the same property the
grenade band filter depends on.

* **Breakables** map to their `kind: entity` node's triangle range, so breaking
  one is `mask.fill(1, start, end)`.
* **Doors** have no entity hull: the game spawns a `prop_door_rotating`, so VRF
  baked the leaf into `physics_group_metal` with the wall around it. The runtime
  masks whatever sits inside the leaf's own measured box (6 to 19 triangles a
  door — a leaf hull, not a wall) and hands the tracer a swinging oriented box in
  its place. A shut door is genuinely solid, an open one genuinely walk-through,
  and the box that collides is the same box that is drawn.

### The other three asks

* **Bullets** (`shared/sim3d/penetration.js`, `src/cs3d/rayWorld.js`,
  `src/cs3d/shooting.js`). Source's FireBullet loop over the map's real surface
  table. Bullets get a third collision set again: through the clips, stopped by
  the drawn world, and free through `physics_passbullets_*` brushes, which is
  why Nuke's chainlink and grates cost nothing.
* **Ladders** (`shared/sim3d/motion.js`). Nuke's one 16-triangle climb node
  splits into 12 vertical faces and 5 ladders, of 245, 96, 178, 343 and 267
  units of climb. `world.ladderAt` is optional, so no existing oracle result
  moves.
* **Wallbangs**, the same solver, reported live on the HUD as `concrete 12u →
  23 dmg` with the path drawn: yellow through air, red inside the wall.

### Provenance, and the one number that has none

`scripts/cs3d-surfaces.mjs` writes `shared/sim3d/surfaces.js` from the game's own
`surfaceproperties.vsurf` and `surfaceproperties_game.txt`, base chains resolved:
164 surfaces with `bulletPenetrationDistanceModifier`,
`bulletPenetrationDamageModifier`, the game material, and `climbable`.

`scripts/cs3d-bullet-oracle.mjs` replays every recorded `player_hurt` through the
solver. Across 1,347 hits in two demos it caught two real bugs and then settled
the damage law:

| | solved from demos | in use |
|---|---|---|
| chest | 0.980 (n=411) | 1.0 |
| stomach | 1.235 (n=106) | 1.25 |
| arms | 0.979 / 0.986 (n=85) | 1.0 |
| legs | 0.741 / 0.777 (n=30) | 0.75 |
| neck | 0.981 (n=6) | 1.0 |

The bugs: kevlar was protecting the head (every recorded pistol headshot came in
40 to 60 points above prediction, and the gap was exactly the vest ratio), and
kevlar was protecting the legs (0 of 36 recorded leg hits on an armoured victim
took any armour damage, against 96-100% for every other group). `armorRatio × 0.5`
is confirmed by every published armour-penetration figure: AK 1.55 → 77.5%,
AWP 1.95 → 97.5%, Deagle 1.864 → 93.2%, Glock 0.94 → 47%.

Final agreement: 68.6% of hits within one health point, 81.7% within three.

**`PENETRATION_UNITS` is the one `[guessed]` number in any of this.** A demo
records that a bullet arrived, not what it went through, so no oracle here can
settle the scale from penetration power to units of wall. Every RATIO around it
is real and does the shaping; only the scale is a choice. Settling it needs the
shot line replayed against the map's collision, which is the job
`cs3d-nade-oracle.mjs` does for grenades and is the obvious next piece of work.

### Still open

* The other six maps. Everything here is per-map data, and the split is one
  command each, but only Nuke has been run and checked.
* Gibs. A broken thing vanishes rather than shattering; the break pieces are
  extracted and unused.
* Sound (R5) and the replay index table (section 6).
