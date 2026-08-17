# CS3D renderer notes

## Status after the fourth pass (2026-08-17): player models, clips, the movement sim in the explorer

The first slice of CS3D-ENGINE-PLAN Group C (E-10 player models, E-8
animations) and of E-2 (the movement controller under the walking body). Two
new pipelines, one new runtime module, and the explorer's walking body now
runs the real sim.

**The players pack.** `npm run cs3d:models` (`scripts/cs3d-models.mjs`) pulls
one T (`tm_phoenix`) and one CT (`ctm_sas`) agent, their `cstrike` hitbox sets
and the world-model locomotion clips out of pak01 and packs them under
`server/data/cs3d/pack/players/` (local only, gitignored, 8.7 MB): two skinned
glbs with webp textures + meshopt, one glb per clip set (`rifle`, `pistol`,
`knife`, `shared`, `c4`, `grenade`) holding the worldmodel skeleton and every
selected clip as a glTF animation, and a `manifest.json` with the clip lists,
per-gait authored ground speeds and the hitboxes. Served like a map pack at
`/api/cs3d/players/…` (`server/cs3d/routes.js` and the Vite dev middleware
already take any slug). Four facts about the game files, learned by probing
and written down nowhere else:

| Fact | Consequence |
|---|---|
| `characters/models/<agent>.vmdl_c` in pak01 are 4.8 KB **stubs** (a 5-unit cube on a `dummy` bone). The real agents are `agents/models/<agent>/<agent>.vmdl_c` (~560 KB): four mesh groups (third-person body / gloves, first-person arms / sleeves), 86–94 bones, the `cstrike` hitbox set, a ragdoll PHYS block | The pack keeps the third-person half; the first-person meshes are E-9's |
| CS2 does not animate players through `.vanim`/`.vagrp`/`.vanmgraph`. It is the **Nm** system: `animation/skeletons/characters/worldmodel.vnmskel_c` (74 bones), 2,355 `.vnmclip_c` under `animation/anims/world/` (`rifle/_default_rifle`, `pistol/…`, `knife/…` each 194–214 clips: 8-way run / walk / crouch, in-air, jump, turn, ladder, plant, shoot; `shared/` deaths, flinches, defuse, flashed; `equipment/c4`, `grenade/…`), and `.vnmgraph_c` graphs | VRF 19.2 exports an NmClip straight to glb (a skeleton + one animation) — 194 clips in 4 s — so this is a script, not a research project. The graphs are behaviour and are re-derived in `src/cs3d/playerModels.js` |
| VRF only writes the skeleton and skins when `--gltf_export_animations` is on; without it the model export is four unskinned meshes | The flag is always passed; the two embedded animations it brings (`tools_preview`, `eye_test`) are dropped |
| The model's skeleton and the clip skeleton agree bone for bone in world space but factor `root_motion` differently: the model carries a 120° rotation on `root_motion` and expresses its children in that frame, the clips leave `root_motion` at identity. Applied blindly, every clip lays the body on its side | `normalizeRootMotion()` rewrites the **model** to the clip convention (world pose unchanged, inverse bind matrices stay valid); every clip then binds by bone name with no per-track fix-up. `verifyPack()` re-poses each packed model with `run_n` and checks the head is at 65 and the feet on the floor, so this cannot silently regress |

Also: clips carry **no root motion** (`m_rootMotion` is identity, the game
moves the entity), so the pack measures each locomotion loop's authored ground
speed from the planted foot (run 182, walk 104, crouch 92 u/s — identical
across weapon classes, the legs are shared) and the runtime scales playback by
actual speed / authored speed. Roughness lives in `g_tNormal`'s alpha and
`g_tMetalness` is a packed mask with metalness in R, exactly as on the maps;
VRF's own metallicRoughness slot is the raw metalness map and reads as chrome.
The 19 hitboxes are capsules on bones (`m_nShapeType 2`, two points + radius,
group ids 1 head / 2 chest / 3 stomach / 4-5 arms / 6-7 legs / 8 neck) with
lower-case bone names where the skeleton's are mixed case.

**The runtime** (`src/cs3d/playerModels.js`). Loads the pack once, clones a
skinned body per player (`SkeletonUtils.clone`), one `AnimationMixer` each,
and drives it from what the tick record carries — speed, heading relative to
the view, duck amount, airborne, held weapon — through a small blend that
stands in for the graph: stand and crouch layers mixed by duck amount, each an
8-way directional loop (the two nearest directions blended by angle), the
stand layer blending idle → walk → run by speed, everything read at one shared
phase so the walk/run cross-blend never double-steps, in-air poses replacing
the lot while airborne, weapon-class sets (`rifle` / `pistol` / `knife`,
grenades and the bomb on pistol legs) cross-fading on a switch, and the view
pitch applied after the mixer as a spine-to-head tilt because every clip is
authored level. `demoView.js` uses it for the ten bodies when the pack is
present and keeps the cylinders as the fallback. Build-of-three note: the
loader and mixer are plain `three` (a second copy of the core next to
`three/webgpu`); the WebGPU renderer reads the skinned meshes by duck typing,
and the materials are rebuilt as `MeshStandardNodeMaterial` so the body takes
the scene sun and probe like any prop.

**Movement.** `shared/sim3d/motion.js` (Source's `CGameMovement` in f32,
already oracle-verified for gravity, jump, air-accelerate) now has a world to
run in: `shared/sim3d/sweptBox.js` (13-axis SAT time of impact, box vs
triangle, exact and allocation-free) under `shared/sim3d/hullTrace.js` (the
`traceHull` contract over any triangle query: Source frame in, scene-frame
triangles, DIST_EPSILON = 1/32 pull-back, startsolid above 0.25 u of overlap),
and `src/cs3d/hullWorld.js` is the ten-line adapter over the pack's BVH.
`src/cs3d/player.js` lost its capsule controller: it turns keys into the sim's
per-tick input, steps `stepPlayer`, and puts the camera on the eyes; Q cycles a
held weapon for its speed cap. Two rules landed with it: no standing up into a
ceiling (`FinishUnDuck`'s headroom trace, in motion.js) and Source's IN_JUMP
latch (no bunny-hop from holding space, in player.js).
`shared/sim3d/hullTrace.test.js` (in `npm test`) checks the primitive, that a
triangle floor reproduces `flatWorld()` tick for tick, wall stop-and-slide at
250 u/s with no tunnelling, a 16 u step climbed and a 38 u ledge refused, a
ceiling capping a jump, the headroom rule, byte-for-byte determinism.

## The viewmodel (2026-08-17): hands, weapons, and firing

CS3D-ENGINE-PLAN E-6's data, E-7's models and E-9's viewmodel, in one pass.
`npm run cs3d:weapons` (`scripts/cs3d-weapons.mjs`) builds
`server/data/cs3d/pack/weapons/` — 66 weapon and grenade models, the four
viewmodel clip sets, and the first-person arms — and `src/cs3d/viewModel.js`
draws them.

**The weapon table is a file, not a reverse-engineering job.**
`scripts/weapons.vdata_c` carries cycle time, deploy duration, damage,
headshot and armour multipliers, penetration, range falloff, spread and every
inaccuracy term, recoil magnitude and seed, and the muzzle position. It is a
prefab tree (`weapon_ak47_prefab` → `rifle` → `primary` → `weapon_base`), so
values resolve up a `_base` chain — `scripts/lib/kv3.mjs` parses it and
`resolveBase` flattens it. Spot-checked against the real game: AK 0.1 s
(600 RPM), M4A4 0.09, MP9 0.07, Deagle 0.225, AWP 1.455. This is most of E-6's
"extract `CCSWeaponBaseVData`" line item, and it means the fire rates are
*data*, not constants someone typed.

**Three findings worth keeping:**

| | |
|---|---|
| CS2 has **one model per weapon** | `weapon_rif_ak47.vmdl` is both the thing in your hands and the thing on the ground, so this pack serves the viewmodel now and the world model later |
| The first-person **arms are inside the agent models** | the `firstperson_*` mesh groups `cs3d-models.mjs` throws away. They are skinned to the agent's skeleton, but the viewmodel clips are authored against `animation/skeletons/characters/viewmodel.vnmskel`, which branches at the shoulder (`root_motion → armUpperShoulder_L → arm_lower_L` where the agent goes `clavicle_L → arm_upper_L → arm_lower_L`). Below the elbow the rigs are identical to the millimetre — arm 11.79, hand 11.08, finger 2.87 — so `rebindArms()` moves the mesh across: every vertex through `vmRest · agentBindInverse`, new inverse binds from the viewmodel rest pose. 48 joints, of which 4 are missing on the viewmodel rig and all four are procedural forearm TWIST helpers, which fold into their parent |
| A melee weapon's swing rate is **in neither data file** | every knife inherits the base `m_flCycleTime = [0.15, 0.3]` and overrides nothing; `items_game.txt` only declares `cycletime` as an attribute class in CS2, the values having moved to the vdata; and the swing *animations* are 1.13 s / 1.10 s, which is the whole wind-up and settle rather than how often the game lets you swing. So 0.4 s / 1.0 s ship as `[guessed]` with their provenance in the manifest, and the clip lengths ride along so the comparison is one read away |

Also fixed, in both packers: a clip's duration was taken per channel while
padding single-key channels to a second, so a clip that animates some bones and
holds others — which is every shoot animation — came out 1 s long instead of
0.37 s. The length is now read across every channel first, and only a clip
where *every* channel is a single key gets stretched.

**The runtime.** `viewModel.js` draws the hands in their own pass with their
own camera and a cleared depth buffer, at CS2's narrower `viewmodel_fov` (68)
while the world stays at 90 — the same reason the game separates them, and what
stops a muzzle poking through the wall behind it. The gun hangs off the rig's
`wpn` bone, which the clips animate, so it moves with the hands. Bob, sway and
recoil are derived (the game computes them in the binary): bob is a walk cycle
whose amplitude follows speed, sway is a clamped lag on view rotation, and the
kick is a spring scaled by the weapon's own `m_flRecoilMagnitude`. All three
carry `[verify]` constants. The fill light takes the map's baked ambient at the
player's position, so the gun darkens indoors with everything else.

**Firing.** Left and right mouse while pointer-locked; automatic weapons repeat
while held, semi-autos once per click, both gated on the table's cycle time and
on the deploy lockout after a switch. `1`/`2`/`3` are rifle / pistol / knife
with the draw animation and its `m_flDeployDuration`; the knife alternates its
light and heavy swings so a spammed slice does not replay one clip. In a demo
POV the viewmodel takes that player's weapon, bobs on the speed their legs are
already running on, and kicks on the ticks the demo says they pulled the
trigger (`events.shots`).

Open: the weapon's own bones (bolt, trigger, magazine) are packed but not
driven — the clips animate them through a per-weapon secondary skeleton, and
the generic `_default_*` sets this pack uses do not carry a given weapon's. No
tracers, no muzzle flash, no sound, no hit registration: firing moves the
viewmodel and nothing else yet. Grenade throw clips are packed and unbound.

**Where the bodies show up.** Three places, one module: the explorer's demo
playback (`demoView.js`), the timeline viewer's 3D view
(`src/replays/viewer/view3d.js`, the same `PlayerBody` per slot, its mixers
advanced by the tick delta between drawn frames so the animation clock is demo
time and a scrub is exact) and the explorer's own walking body
(`src/cs3d/liveBody.js`: the same `set()` fed from the movement sim instead of
a tick record — `T` puts the camera behind it, which is also the path a bot's
body will take). `sharedPlayerModels()` fetches the pack once per page.

**One look, both viewers.** The timeline's 3D view was rendering the map with
the sun at ~300 (everything white). Cause: the explorer's `applyLight('sun',
5)` runs before `MapLighting` exists, so its base was cached as **1** and the
"sun ×5" slider has always meant an *absolute* 5 (likewise sky = absolute 0.1);
`look.js` had faithfully implemented the label — 5 × `sunIntensity`
(brightness × 25 ≈ 60 on Nuke). `createLook()` in `look.js` is now the one
controller both pages drive, with the explorer's real semantics written down
(sun and sky absolute, bake a multiplier over the pack's lightmap intensity,
grade uniforms straight through), applied at the same points in the same order
in both boots, and re-applied for `sky` after `loadSkybox` (which used to race
the pack load in the explorer). `MapLighting.sunIntensity` / `SUN_BOOST` are
starting values the look replaces.

**Bodies stand in the map's own light** (2026-08-17, second pass). The first
pass lit them the one way nothing else in the map is lit any more: the scene's
global sky probe, as both diffuse and reflection. An environment with no
occlusion gives a player in a sealed hall exactly the sky a player in the yard
gets — blue, from above, with a mirror sheen over it. That is the "wet plastic
from another dimension" look, and it is the same defect `materials.js`
documents for props, which is why props stopped being lit that way.

CS2's answer for anything that moves is its `env_light_probe_volume` atlas,
which the importer already extracts and the pack already samples per vertex for
static geometry. A player cannot carry a vertex bake, so `cs3d-pack` now also
resamples that atlas onto a lattice — `bakeProbeGrid`, one **ambient cube**
(six irradiance values, the game's own representation) per 192-unit cell,
clipped to the world box, RGBE, in scene axis order. Nuke: 57×18×43 cells,
1.06 MB, 94% covered by volumes, and its luminance distribution (p50 0.43,
p90 0.65) sits right on the lightmap's (0.29 / 0.68), so a body and the crate
beside it come out of one bake at one brightness. `mapLoader.js ProbeGrid`
reads it trilinearly; `playerModels.js BodyMaterial` samples it at chest height
each frame into six uniforms and evaluates Σ nᵢ²·cube[axis] per pixel, with the
sky probe demoted to reflections-only (`SpecularOnlyEnvironmentNode`, now
exported from materials.js). The four-byte HDR encoding is `shared/cs3d/rgbe.js`
rather than a copy in each end — an encoder in the packer and a decoder in the
browser is a codec with two different exponent biases in it eventually, and the
failure mode is not a crash but every player in the map lit 2^k too bright.
`rgbe.test.js` holds both ends to the round trip, to black being exact, and to
the bias being the importer's 136. The dynamic sun and its shadow map stay — that is
the half CS2 also keeps for players. `manifest.probeGrid` is optional, so a
pack from before this still loads and its bodies fall back to a flat ambient.

Three more material defects, all in the packer:

| Symptom | Cause | Fix |
|---|---|---|
| Roughness, AO and metalness smeared across the wrong parts of a model | The ORM was resized `fit: 'fill'` to a **square** while the albedo kept its aspect. Most character sheets are 2:1 or 1:2 (legs 2048×1024, arms 1024×2048), so every ORM texel sat off the UV it belonged to | `channelAt` takes a width and a height; the ORM follows the normal map's shape |
| Cloth read as latex | `csgo_character.vfx` shades vest, fatigues and balaclava with `F_CLOTH_SHADING` + a sheen lobe (`g_flSheenScale`, `g_flSheenTintColor`), and they were drawn as smooth dielectrics | The vmat's shading model rides in the packed material's extras (`readVmat`) and becomes three's `sheen` / `sheenColor` on a `MeshPhysicalNodeMaterial` |
| Skin shiny; AO at full strength everywhere | `F_SUBSURFACE_SCATTERING` has no equivalent in three, and `g_flAmbientOcclusionMasking` (0.4) was ignored | Skin takes a roughness floor (0.45) instead of SSS; AO takes the vmat's strength |

Also: `TextureMetalness [0,0,0,0]` and friends are VRF's **constant stand-ins**
for a slot with no texture, and now win over the 1×1 placeholder exported for
that slot.

**Two steps then a skate on the third** was the authored ground speed, and the
lesson is about the estimator rather than the number. The clips carry no root
motion — the game moves the entity and the legs run in place — so the pack
measures what speed each loop is authored for and the runtime plays it at
`actual / authored`. Get that wrong and the feet slide; get it 23% wrong and
the slip accumulates to a whole step every couple of cycles, which reads as a
hitch rather than a drift.

The first estimator took the median horizontal speed over every frame whose
foot was in the lowest third of its travel. That window is not contact: it also
holds the plant and the lift, where the foot is still decelerating in or
already swinging forward (a quarter of those frames move *forwards*), and the
median of the mixture came out 182 u/s against a real 224. During genuine
contact the foot's speed sits on a **plateau** at exactly the body speed and
every other frame is slower, so the fix is to read the top of the distribution
instead of its middle: per frame, the horizontal speed of whichever foot is
lower; per clip, its p90. Not the max — that catches a swing frame where the
wrong foot was picked as the low one.

It validates three ways: the eight directions of a gait agree to ±10% (run),
±6% (walk) and ±1% (crouch) where before they spread 118–209; and the
walk/run ratio it produces is **0.512**, which is `WALK_SPEED_SCALE` — a number
the demo corpus measured at 0.52 entirely independently. Authored speeds are
run 224.4, walk 115.0, crouch 93.4 u/s, identical across weapon classes because
the legs are shared.

(A related trap that turned out not to bite: VRF times a clip's frames at
`duration / N` rather than `duration / (N−1)`, so the exported span is 0.7014 s
where the game says 0.7333. It cancels — the authored speed is measured against
the same compressed clock, and cadence depends only on the product
`authored × duration`, which is distance per cycle. The loop itself is closed:
the last key matches the first to 4e-4, so wrapping the phase at `duration` has
no seam.)

**Bodies folding into themselves** was the aim tilt: the full view pitch (±89°)
distributed across the spine, so a player looking down bent double and ended up
inside their own legs. CS2 clamps how far the world model follows the view and
weights it toward the head. `AIM_PITCH_LIMIT` is 55°, and the per-bone weights
now run 0.10 / 0.15 / 0.25 / 0.20 / 0.30 up the chain.

Open, in the order they matter:

0. **R2 is a re-pack behind.** All seven maps carry probe grids locally;
   `npm run cs3d:upload` pushes them (and the rebuilt geometry) to the bucket.
1. **Operator eye-test.** Direction naming is assumed `e` = the body's right;
   if the legs cross the wrong way on a strafe, swap the sign of `relYaw` in
   `playerModels.js` `DIRS`. Playback cadence and the pitch weights are first
   guesses. The lighting on bodies is the dynamic sun + probe, not the map's
   baked terms (CS3D-RENDERER known-remaining #2 still stands).
2. Deaths, plant, defuse, throw, flashed and flinch clips are packed but not
   triggered: `PlayerBody.playOnce(set, name)` exists, the round events that
   would call it are not wired. Airborne comes only from `FLAG_AIRBORNE`, which
   the pre-revision corpus does not carry (bodies do not jump there).
3. No weapon world models on the `wpn` bone (E-7), no twist/jiggle bones
   driven (the model's `CTiltTwistConstraint` list is in its DATA block).
4. `constants.js` DUCK is still [guessed] and the sim's duck is an instant hull
   swap; the camera eases, the sim does not.

## Status after the third pass (2026-08-15, night): atmosphere and grade

The second pass got the geometry, the textures and the baked light right. What
was left was everything the game does *between* a lit pixel and the screen —
and one class of bug in the pack that was quietly corrupting the maps that
control shading.

**No atmosphere at all.** The single biggest gap. CS2 draws every surface
through a haze that grows with distance and thins with height; the explorer had
`THREE.Fog(horizon, 9000, 60000)`, which never touched anything, because the
largest of these maps is about 4,500 units across. Nothing was ever far enough
away to pick up one percent of it. Every map ships the real thing in its entity
lump and the pack now reads both entities:

| Entity | On | What it does |
|---|---|---|
| `env_cubemap_fog` | all seven | The main layer. Colour is the **sky in the direction you are looking**, blurred by `cubemapfoglodbiase`, so the haze goes warm toward the sun and cool away from it. Dust 2: 512 → 9,000 units, falloff 1.3, max opacity 0.5. |
| `env_gradient_fog` | five (not Dust 2 or Mirage) | A flat-coloured layer over the top. Inferno: 500 → 15,000, colour `[128,172,212]`, height 0 → 10,000. |

Both are a distance ramp times a height ramp, each with its own exponent, so
`src/cs3d/fog.js` covers both with one function and folds the two "over"
composites into the one (colour, factor) pair a `FogNode` can carry. The sky
colour is a measured three-term fit (horizon band, zenith band, a lobe toward
the sun) rather than a per-pixel `pmremTexture` lookup — deliberately, because
that keeps the fog colour in *uniforms*, so swapping the procedural sky for the
map's real one is a uniform write instead of a shader rebuild across every
material in the scene. At `lodbias` blur a sky **is** a vertical gradient with a
sun lobe on it.

The 3D skybox is now fogged like everything else, and heavily. It used to be
exempt (`m.sky → material.fog = false`), which is why the distant hills read as
crisp grey cut-outs pasted behind the map. The loader draws the skybox at its
real ×16 size and distance rather than as a miniature around the camera, so
those hills are genuinely 40,000 units away and the same ramp washes them out
exactly as much as the game does.

**No grade.** Khronos PBR Neutral on its own is designed to leave colour alone:
almost linear to 0.8, then desaturating as it rolls off. That is the opposite
of a game tonemapper, and it produces a picture that is flat in the midtones and
washed in the highlights at the same time — shadows without weight, skies
without colour. `src/cs3d/grade.js` registers a tone mapping function under
`CustomToneMapping` that puts an S-curve about scene-linear 0.18 and a
saturation lift in front of three's own Neutral curve (fetched from the node
library, not reimplemented). It runs inside the tone map three already calls per
pixel: no extra pass, no extra render target. `?contrast=`, `?saturation=` and
`?lift=` override the constants for dialling in against the game.

Fixed in this pass:

| Symptom | Cause | Fix |
|---|---|---|
| Nuke's blue door frames, benches and roller doors render **black** | Lightmapped materials returned `null` from `setupEnvironment`, dropping the probe entirely. Correct for diffuse (the bake has it) but a metal has *no* diffuse — its whole appearance is the reflection | `SpecularOnlyEnvironmentNode`: swallow `EnvironmentNode`'s `iblIrradiance` accumulation, keep its `radiance` |
| Nuke's vending machines render as **white boxes**; ~9–29 props per map likewise | The pack emitted `emissive: [1,1,1]` for anything with `F_SELF_ILLUM`. What says which *pixels* glow is `g_tSelfIllumMask`, and it was never read | Pack `g_tSelfIllumMask` + `g_vSelfIllumTint`, `g_flSelfIllumScale`, `g_flSelfIllumBrightness`, `g_flSelfIllumAlbedoFactor`; `_wireEmissive()` builds `tint × lerp(1, albedo, factor) × mask × intensity` |
| Blocky, faintly iridescent shading on pipes and painted metal; muddy colour patches | **Lossy webp is always YUV 4:2:0.** Normal maps and the ORM are not pictures — X/Y and AO/roughness/metalness are independent channels in R/G/B — so three quarters of the chroma, i.e. of the data, was being replaced by 2×2 averages. A rough dielectric next to a metal rivet came out half-metal, which on a lightmapped surface (no reflection, see above) came out black | Normals near-lossless at 384 (~40% over 512 lossy, not the ~180% that 512 near-lossless costs); ORM and blend heights fully lossless at 256; albedo keeps lossy but with `smartSubsample` |
| Muddy, blotchy shading in corners | The ORM's AO was multiplied into the *baked* irradiance, darkening exactly the creases the bake had already darkened | `aoMap` only on materials without a lightmap chart |
| The sky's sun in a different place from the scene's | `env_sky` carries a yaw and four maps set one (Inferno 245°, Anubis 270°, Cache 116°, Ancient 65°). `Scene.backgroundRotation`/`environmentRotation` exist in r169 but the WebGPU renderer never reads either | `rotateEquirectYaw()` wraps the equirect's pixels before PMREM, so background and probe both turn |
| Inferno's "alien" dark teal sky | Its sky texture really is cyan-ish *and* dim (upper-hemisphere mean 0.22 against Nuke's 0.43), and the world's exposure — set from the baked atlas, which says nothing about the sky — pushed it to about 0.15 on screen | The sky is measured and calibrated separately against `SKY_TARGET`, bounded to 0.5–6× the authored `brightnessscale × 2^bias`, so a deliberately dim sky stays dim but stops being black |
| Two `env_sky` entities, wrong one used | Inferno keeps a Hosek-Wilkie reference sky next to the real one | Prefer the one that is not `startdisabled`; fall back to the first when all are (Anubis and Ancient enable theirs from a script) |

Manifest additions (all optional, so a v2 pack still loads — it just has no fog
and no emissive masks): `fog`, `skyYaw`, and per material `emissiveIntensity`,
`emissiveMask`, `emissiveAlbedo`. A pack without `fog` gets a haze sized off the
map's own bounds so it is not a diorama while you re-pack.

Cost: Dust 2's `tex.bin` goes 28.6 → 34.3 MB, almost all of it normals bought
back from the chroma subsampler.

**Roster cut to seven** (2026-08-16): Overpass, Train and Vertigo are not in the
active-duty pool, so their packs, raw imports and .vpks are gone — about 8.6 GB.
The live set is Ancient, Anubis, Cache, Dust 2, Inferno, Mirage, Nuke, all
re-packed against everything above. Re-adding one needs a .vpk, `cs3d:build`, an
entry in `shared/cs3d/maps.js` and a line in each of vercel.json's two rewrites;
nothing else hardcodes the list.

## Status after the second pass (2026-08-15, evening): pack v2

Everything below the next heading still stands as history; this section is
what the pipeline and the island do now.

**One bug behind most of the report.** The swirls (Nuke pipe), the "caustic"
cells (Nuke corridor, Anubis walls), the flat untextured surfaces the operator
saw on Dust 2 and the ice-blue Anubis were the same defect: `MaterialLibrary`
built every material with 1×1 placeholder textures and later swapped the real
ones in with `needsUpdate`. On the WebGPU backend (three r169) that leaves the
placeholder's sampler bound — a nearest-filtered, mip-less sampler on a 1024²
mipmapped map. One driver aliases (moiré/cells), another collapses (flat
colour). Proven in-browser: a *fresh* material with the same textures rendered
clean, and `dispose()` on one live material fixed every surface at once.
Materials are now built once, with their final textures; until then a mesh
carries a flat interim material and the whole material object is swapped.

What the pack (`scripts/cs3d-pack.mjs`, `PACK_VERSION = 2`) now ships per map:

| File | What | Why |
|---|---|---|
| `tex.bin` + `manifest.tex.dir` | every texture, webp, back to back, offsets in the manifest | one request instead of ~1,000; streamed and decoded (`createImageBitmap`) as bytes arrive, biggest surfaces first |
| `lightmap.webp` | the game's baked irradiance atlas (8192² BC6H → 4096² RGBM webp, `tools/cs3d-tex hdr2d` → `cs3d-import` → pack) | **Indirect only** — CS2 keeps the sun analytic. Lightmap UV = the last `TEXCOORD_n` whose range stays inside the page (≤ 0.875 — the bound is what tells a chart from the material UV sets beside it) × `m_vLightmapUvScale` (8/7 on every map, from `world.vwrld_c`), shipped as `TEXCOORD_1`. **Charts cover the whole page**: the 8/7 scales mesh UVs onto it, it does not leave an eighth spare, and treating the last eighth of each axis as a neutral strip flattened 23.4% of the bake into hard-edged rectangles |
| `shadowmask.webp` | the sun's baked visibility, one channel out of `direct_light_shadows` (8192² BC7 → 4096² lossless webp), same UV as the atlas | the world is lit `atlas + sunColor × N·L × visibility`, the way the game does it. The game's texture stores **shadow** (1 = occluded); the pack inverts it. Read the wrong way every shadow in the map renders as a bright patch — a palm's fronds come out lit and the ground under them dark |
| `geo/gNN.glb` | tiles: one mesh per (vmat, ≤1024u cell), attributes normalised per material | the loader puts every tile of a material into one `BatchedMesh`: one pipeline per material, one culled draw per tile |
| `sky3d/gNN.glb` + `manifest.sky3d` | the 3D skybox map (`maps/prefabs/<map>/<name>.vpk`, found via `skybox_reference`) | drawn ×16 about the `sky_camera`: pyramids, dunes, the town beyond the walls |
| `phys.glb` | as before, minus disabled entities | see wingman below |

Fixed in this pass:

| Symptom | Cause | Fix |
|---|---|---|
| Wingman/retake walls in the 5v5 map (Overpass, Vertigo, Nuke, Inferno, Mirage) | The blockers are `func_brush`/`prop_dynamic` with `startdisabled=1`, enabled by a Pulse `GameModeCheck` script; VRF exports their models like any other | Skip meshes whose extras carry `startdisabled`; skip their bodies in the physics export by matching origins (the physics glb has no keyvalues) |
| Awnings white, tarps white, barrels grey; 754 materials on Dust 2 | VRF emits one glTF material per (vmat, instance tint) and puts the prop's `rendercolor` in `baseColorFactor`; the pack read only the vmat's `g_vColorTint` | One pack material per vmat (277 on Dust 2); the tint rides on each tile's glTF material and becomes the tile's `BatchedMesh` colour |
| Anubis white-out | `light_environment` brightness 6.35 vs Nuke's 2.4; the game auto-exposes | Exposure from the atlas: √(p90·p98) of its luminance (sunlit stone) lands at 1.15 before Neutral tonemapping; the sky probe is calibrated to the atlas median so props sit in the same light as the floor; the dynamic sun (props only) is calibrated to `p90 − p50` |
| Blend layer 2 missing (tan/black patches) | `csgo_environment_blend` mixes `g_tColor1/2` by the vertex paint VRF exports as `_TEXCOORD_4.x` (`COLOR_0` from VRF is all ones) | Pack writes the paint to `COLOR_0.r`, ships layer 2 colour/normal + a 256² height pair; a TSL material mixes them, height-modulated |
| Every blended road, floor and plaster wall on Dust 2 showing layer 1 alone (0 of 320 materials detected as blends) | Dust 2's blends are plain `csgo_lightmappedgeneric` with `F_LAYERS = 1`, not one of the `*_blend` shader names, and they call layer 1 `g_tColor` — so the fallback's "a layer-1 slot **and** a layer-2 slot" never matched. They also shape the transition with `g_tBlendModulation` (R = threshold, G = width) rather than a height pair | Detect `F_LAYERS`/`F_MULTIBLEND`, and treat a layer-2 colour slot as proof on its own; pack the modulation texture losslessly and add a modulation branch to `_wireBlend`. 78 of 413 materials blend. The paint alone would not have been enough — it only reaches ~0.4 on these surfaces, so the threshold texture does most of the work |
| Whole floor slabs and wall panels a flat, wrong brightness, hard-edged along polygon boundaries | A vmat is shared between world brushes (charted) and prop instances (not), and the pack gave the whole material the majority's verdict — the minority sampled one flat spot in the atlas. 33% of Dust 2's tris have no chart | `splitByLightmapChart()` splits mixed vmats in two; the chartless half takes the ordinary prop path (probe + dynamic sun). Count per **vmat**, not per glTF material: VRF emits one material per (vmat, tint), so an all-props tint variant otherwise regroups by name into its charted sibling. 90,200 → 2 verts on the fallback |
| Every frame walks ~2,300 meshes; shadow pass draws the map again | per-mesh objects | `BatchedMesh` per material (Anubis: 391 → 1,789 tiles in 391 draws; Dust 2 320); shadow map redrawn only when the player has moved 256u or the world changed (`shadow.autoUpdate=false`) |
| Sky dim/olive on Dust 2 | `sky.vfx` `g_flBrightnessExposureBias` (0.765 stops on Dust 2) was not applied | `cs3d-sky` reads it; `backgroundIntensity = brightnessscale × 2^bias` |
| Skybox clouds a solid lid over the sky | unlit cloud dome with `F_BLEND_MODE 4`, exported opaque | `F_BLEND_MODE ≥ 2 → BLEND`, `1 → MASK` |
| Water white | `csgo_water_fancy` has no albedo (its `g_tColor` is a map-space tint) | glossy translucent sheet in `g_vWaterFogColor`, reflecting the probe |

**Two three r169 bugs the island patches or avoids** (both in `src/cs3d/`):

- `WebGPUAttributeUtils.updateAttribute()` cannot upload part of an attribute: it passes `0` as the destination offset and converts `dataOffset`/`size` to bytes, but the WebGPU spec measures both in *elements* when `data` is a TypedArray. Asking for 4× a Float32Array throws `OperationError: Number of bytes to write is too large` — hundreds of times per load, since streaming tiles into a `BatchedMesh` is exactly a partial upload, and the affected tiles never reach the GPU. The WebGL2 backend in the same build gets it right. `threePatches.js` installs the corrected version (guarded, so a three upgrade retires it).
- A raw `ShaderMaterial` cannot compile on the WebGPU backend at all (`NodeMaterial: Material "ShaderMaterial" is not compatible`), which silently killed the procedural sky dome *and* the ambient probe built from it. The dome is TSL now (`makeDomeMaterial()`), so the fallback path works on both backends.
- `Scene.backgroundRotation` and `Scene.environmentRotation` are declared on `Scene` and read nowhere in the WebGPU backend. `sky.js` turns the equirect's pixels instead, which is exact for a yaw and costs one pass over the image at load.

Loader-side rules worth knowing:

- Lightmapped materials get **no scene lights and no ambient diffuse from the probe** (`lightsNode = lights([])`, `SpecularOnlyEnvironmentNode`); their sun is the analytic term inside `setupLightMap`, masked by `shadowmask.webp`. The bake already contains the sky's diffuse, so adding a scene light or the probe's irradiance lights the map twice (which is what made the first lightmapped render look flat: doubled sun filled the baked shadows). They **do** keep the probe's reflection — dropping it too is what made every lightmapped metal black.
- Lightmapped batches **cast** shadows (so a prop in an alley is shaded like its floor) but do not **receive** (`receiveShadow=false`); props do both.
- Tiles within 1800u of the camera are drawn even outside the frustum: r169's WebGPU backend never calls `onBeforeShadow`, so the shadow pass reuses the main pass's cull; without this a wall behind the player stops casting the shadow in front of them.
- Attributes per tile are normalised in `normalizeTile()` (world-space float positions, snorm8x4 normals, float uv, unorm16 uv1, unorm8 colour) because `BatchedMesh` needs one layout per material and meshopt quantises each tile differently.

Known remaining:

1. The `post_processing_volume` `.vpost` colour grading LUT is still not applied — `grade.js` is a generic S-curve, not the map's own grade. It is also the last thing left that would explain a per-map colour cast.
2. `directional_irradiance` unused: no normal-map response to the baked indirect and no specular sun highlight on world geometry. Dynamic objects (players, later) should sample `shadowmask.webp` so they sit in baked shadow rather than only in the dynamic cascade.
3. Anubis' skybox shows a stray dark chunk high in the eastern sky (a sky-world mesh with a transform the bake does not place); not investigated.
4. Inferno is 116 MB of geometry + ~55 MB textures: VRF's export is LOD0 for everything and welds to ~1 vertex per triangle (a tolerant weld recovers 5%). PVS/occlusion or LODs are the next lever.

## Status after the first parity pass (2026-08-15)

Confirmed with the operator that memorin uses three.js on WebGPU, which
settles §6 below: we stay on three. The island now runs on
`WebGPURenderer` (`three/webgpu`, automatic WebGL2 fallback, `?webgl=1` to
force it). CSM is gone with it — the addon patches shaders through
`onBeforeCompile`, which node materials never call, so it was silently doing
nothing; a single fitted directional shadow replaced it.

Fixed in this pass, each with the evidence that found it:

| Symptom | Cause | Fix |
|---|---|---|
| Foliage/fences as solid black-edged cards | `--gltf_textures_adapt` re-encodes `g_tColor` as RGB, destroying the alpha every cut-out tests against. Direct `.vtex_c` export has alpha 0–255; through the flag it has none. | Drop the flag; pack ORM ourselves |
| Every surface's roughness wrong | Source 2 packs roughness in `g_tNormal`'s **alpha**, not a separate map | Build ORM as R=AO, G=normal.a, B=metalness |
| A third of some maps untextured | Blend shaders keep albedo in `g_tColor1`/`g_tColorA`, not `g_tColor` (Overpass: 287 of 850 materials) | Slot chain, `pickTex` |
| Walls flat grey on one GPU, swirling moiré on another | World-derived UVs reach 26,810; float32 has ~0.002 precision there, so mip-selection derivatives are noise. Mip collapse on one driver, aliasing on the other. | Per-triangle whole-tile UV recentring after the spatial split |
| Sky rendered as a visible box | Source cubes are z-up, ours y-up: a -90° X rotation that also spins each face's contents. Renaming faces is not enough. | Resample the cube to equirect in scene space (`tools/cs3d-tex`) |
| Two sky faces still wrong after that | ±X face selection used `sc=-dy,tc=-dz`; the cube convention is `sc=-dz,tc=-dy` | Corrected; other four faces were already right |
| Whole maps blown out white | One ambient constant for every map | Sun and ambient scale off the map's own `light_environment` |

Known remaining, in priority order:

1. **Blend shaders composite only layer 1.** `csgo_environment_blend` mixes
   `g_tColor1`/`g_tColor2` by vertex alpha and height; we draw layer 1 alone,
   so the layer-2 regions show a flat factor colour (the tan/black brick
   patches on Ancient). Needs the second layer plus `COLOR_0`, which the pack
   currently strips. Verified it is *not* a UV-set problem: rendering those
   materials through UV sets 1 and 2 is identical and worse than set 0.
2. **Baked lightmaps** — still the big one, see §2 below.
3. Batching + PVS for draw-call cost.

---

# CS3D renderer evaluation

Written 2026-08-15 after the first end-to-end run of the map pipeline
(`cs3d-import` → `cs3d-pack` → `/mirage`), against the operator's comparison
with memorin.app's in-browser CS2. Question asked: is three.js the limit, and
what would Babylon / PlayCanvas / a custom WebGPU renderer / a game engine
cost and buy?

Short version: **the gap is not the rasterizer.** Every visible defect traces
to the importer (what we pull out of the .vpk) and to material/lighting code
we have not written yet; both are the same work in any renderer. Two facts
were established today by probing the files, and they set the real cost:
the baked lightmap atlas exports cleanly but the exported lightmap UVs need a
per-draw transform we still have to recover, and CS2's PVS is in the vpk but
in a block VRF does not decode. Details below, then the options.

## 1. What is actually wrong, item by item

| What you see | Root cause | Layer that owns it |
|---|---|---|
| Shadows blotchy, shade flat blue-grey, colours cold | We light with a dynamic sun + hemisphere fill + 3 cascaded shadow maps. CS2 and memorin use the map's **baked lightmaps** (irradiance atlas + directional + light probes). Every wall in-game is lit by a texture, not by a light. | importer + material |
| Flat red decals | Those overlays store alpha in a separate mask texture and tint via `g_vColorTint`; VRF's glTF export gives us colour only. `F_LAYERS` wall blends (54 materials on Mirage) got layer 0 only. | importer + material |
| Textures soft | Packed at 512 px for the first pass (memorin ≈ 1024–2048). | pack setting |
| "Simplified" props | Suspected LOD selection in the export (`_lod0/_lod1` names present); not yet verified. | importer |
| Draw-call bound (Inferno 846 draws → 23 ms; naive 1024u tiling → 2393 draws → 60 ms) | Merged-per-material meshes never cull; the tile split multiplied draws without a batching primitive. Needs multi-draw batching (`BatchedMesh` / instanced merge) + a PVS. | engine code |
| Everything loads at once | No PVS/streaming yet. | engine code |

None of these rows say "three.js cannot do X". They say "we have not fed the
renderer the right data yet".

## 2. Facts established today (probes, no product code)

**Lightmaps.** `maps/<map>/lightmaps/irradiance.vtex_c` is an 8192² BC6H HDR
atlas (Mirage: 76 MB compressed). VRF exports it as EXR (293 MB float) or,
with `--texture_decode_flags ForceLDR`, as PNG (54 MB). A 1024 preview of the
atlas shows exactly what you would expect: sky-blue shade, warm bounce, lamp
glow, packed charts. Also present: `directional_irradiance` (normal-mapped
lighting), `direct_light_shadows`, `env_light_probe_volume_atlas` (props),
`env_cubemap_array` (specular).

**Lightmap UVs.** The world meshes carry `TEXCOORD_1` in [0,1] on 3,012 of
3,488 draws. Applying the atlas through it as-is renders scrambled charts
(tested both texture orientations): the exported UV set is not the final
atlas coordinate on its own; a per-draw scale/offset (or the atlas UV in a
stream VRF does not emit) is missing. The world node data has
`m_vLightmapUvScale = [1,1]`, `m_bHasLightmaps = false`, so CS2 keeps it
elsewhere (`lightmap_query_data.kv3`, 8.8 MB, and/or the vmesh draw calls).
VRF's own renderer draws CS2 lightmaps correctly, and VRF is MIT with a NuGet
library, so the reference implementation is readable and the fix is either a
small C# tool over the VRF library or a patch to its glTF exporter. Bounded,
1–3 sessions, and **identical work for every renderer candidate**.

**PVS.** `world_visibility.vvis_c` is real: 4,096 base clusters on an 8-unit
grid, 512 PVS bytes per cluster, a node tree (90k nodes) mapping positions to
clusters, and per-draw `m_visClusterMembership` in the world nodes. VRF dumps
the header but not the `VXVS` block (4 MB). Options: decode it (VRF source is
the map to the format; a few sessions, some risk), or bake our own coarse
PVS offline from the collision BVH we already have (cell → visible tiles;
deterministic cost, one session). Either feeds any renderer the same
"cluster → draw list" table.

**Draw calls.** three's per-object cost measured ~5 µs/draw here (846 draws ×
4 passes ≈ 18 ms CPU). The fix is fewer submissions, not a faster library:
`BatchedMesh` (WebGL multi-draw, one call per material with per-piece
frustum culling), and no shadow passes at all once lightmaps carry the sun.

## 3. Requirements the renderer has to meet

- R1 Baked lightmaps (HDR atlas, second UV set), light probes for dynamic props.
- R2 Custom materials: csgo_lightmappedgeneric (2–4 layer blends by vertex
  alpha + mask, tint masks, detail), static_overlay (decal alpha), foliage,
  glass, unlit; cubemap specular.
- R3 300–1,300 materials and 1–9 M triangles per map at 60 fps: multi-draw
  batching, PVS/occlusion culling, streaming.
- R4 KTX2/Basis textures, meshopt geometry.
- R5 Later: skinned characters + animations, first-person viewmodel, decals,
  tracers, smoke volumes, HUD.
- R6 The sim stays in JS (`shared/sim3d`, headless in Node); the renderer is a
  view over it. CS3D-PLAN §1 rejected an IPC boundary between brain and body.
- R7 Lives inside the aim4 site (Vite, three 0.169 already shipped, the
  trainer and 2D viewer are three).

## 4. Options

### A. three.js (current; WebGL2 now, WebGPURenderer available)

- R1: `lightMap` on uv1 built in; HDR needs an RGBM/half-float texture or a
  10-line shader patch. Probes: custom uniform sampling.
- R2: `onBeforeCompile` patches or full `ShaderMaterial`; TSL node materials
  on the WebGPU backend if we ever move. Standard practice.
- R3: `BatchedMesh` for multi-draw; PVS/occlusion is our code (as it would be
  everywhere; no web renderer ships Source-style PVS).
- R4/R5: KTX2Loader, meshopt, skinning, DecalGeometry, particles: all there.
- R6/R7: zero migration, zero bundle growth, one renderer on the site.
- Buys nothing for free either: the material shaders and culling are ours to
  write.

### B. Babylon.js

- R1 `lightmapTexture` (LDR) or NodeMaterial; R2 NodeMaterial / ShaderMaterial;
  R3 has per-mesh GPU occlusion queries built in (nice), thin instances,
  mesh merging, no multi-draw abstraction, no PVS; R4 KTX2 + meshopt in its
  glTF loader; R5 strong animation stack; WebGPU engine is mature.
- Cost: second renderer on the site (~2–4 MB), everything in `src/cs3d/`
  rewritten (loader, materials, sky, controls glue), and every future
  three-based tool (2D viewer overlays, trainer assets) cannot share code.
- What it fixes from §1 by itself: nothing. Lightmaps, csgo materials, PVS are
  the same tasks in Babylon syntax. Occlusion queries would help R3, but PVS
  from the vpk beats queries and is renderer-agnostic.

### C. PlayCanvas engine (MIT)

- R1 lightmapping support; R2 shader-chunk system; R3 static batching +
  hardware instancing, no PVS; WebGPU in progress; editor is a hosted product
  we would not use.
- Same cost profile as Babylon (second renderer, full rewrite of the island),
  smaller community than either three or Babylon for the shader work we need.

### D. Custom WebGPU renderer (own code)

- The only option that changes the ceiling: compute-shader culling into
  indirect draws, bindless-style material tables, real GPU-driven rendering.
  That is what "an actual engine" means at 50k+ draws.
- Cost: glTF/KTX2/meshopt loading, materials, tone mapping, skinning,
  animation, decals, particles, text, a scene graph: weeks before we are back
  to what three gives on day one, and every §R5 feature hand-rolled after.
- WebGPU availability in 2026 is broad but not universal for aim4's audience;
  a WebGL2 fallback would mean two renderers.
- For our workload (10 bodies, a static map, ~1k materials) the ceiling it
  raises is not one we hit: BatchedMesh + PVS on WebGL2 handles it. If we
  ever need GPU-driven culling, three's WebGPURenderer exposes compute (TSL)
  behind the same scene code, which is the escape hatch CS3D-PLAN §1 named.

### E. Game engine to WASM (Unity, Godot 4 web)

- Buys occlusion culling, lightmapping pipeline, animation, physics, an
  editor. Unity's web occlusion (Umbra) is genuinely good.
- Costs: 20–50 MB WASM payloads, the Source-2 asset import is the same VRF
  export we do today, and the sim/renderer split becomes an IPC boundary
  (CS3D-PLAN §1 rejected exactly this; headless training in Node would not
  exist). Godot's web export is WebGL2-only with no occlusion culling in the
  compatibility renderer.

## 5. Cost to close the gap, by path (sessions ≈ one focused day)

| Work item | Needed on three | Needed on Babylon/PlayCanvas | Needed on custom WebGPU |
|---|---|---|---|
| Recover lightmap UV transform from the vpk (VRF library tool) | 1–3 | 1–3 | 1–3 |
| Lightmap atlas → RGBM/half KTX2, probes for props | 1 | 1 | 1 |
| csgo material shaders (layers, tint masks, decals, foliage, cubemaps) | 2–4 | 2–4 | 3–5 |
| 1024 px KTX2 textures, LOD selection check | 1 | 1 | 1 |
| BatchedMesh / multi-draw + tile culling | 1–2 | 2–3 (no multi-draw; instancing/merge) | 2–4 |
| PVS: decode VXVS or bake own | 1–4 | 1–4 | 1–4 |
| Port loader/materials/controls/HUD to the new renderer | 0 | 3–5 | 8–15 (+ every future feature) |
| Second renderer on the site, bundle, maintenance | 0 | ongoing | ongoing |

## 6. Recommendation

Stay on three.js. Do, in this order, each one measurable:

1. **Lightmaps**: recover the atlas UV transform (VRF library), ship the
   irradiance atlas as RGBM KTX2, drop CSM and the hemisphere fill. This is
   the item that makes it look like the game. Accept: CT-spawn frame matches
   the memorin/in-game frame in shading (not just geometry).
2. **Materials**: static_overlay alpha masks + tint, F_LAYERS two-layer blend
   with vertex alpha, foliage translucency, cubemap specular from
   `env_cubemap_array`. Accept: no flat colour rectangles anywhere on Mirage.
3. **Textures/LOD**: 1024 px KTX2 (toktx), verify LOD0 selection.
4. **Batching + PVS**: BatchedMesh per material with tile pieces; PVS from the
   vvis if the block decodes in a session, else our own bake. Accept: Inferno
   ≤ 8 ms CPU/frame at spawn, and objects behind walls not submitted.

Revisit the renderer only if step 4 lands and Inferno still misses 60 fps,
and then the escape hatch is three's WebGPU backend + compute culling, not a
different library.
