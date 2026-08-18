# CS3D asset extraction checklist

What to pull from your own CS2 install for the 3D replica (CS3D-PLAN.md §2),
and where to drop it so the importer finds it. Everything lands under
`server/data/cs3d/raw/` — already gitignored, stays local, never served.

Tooling: Source2Viewer (GUI) or its CLI (ValveResourceFormat). GUI is fine
for the one-off character/weapon exports; use the CLI for the map batches.
Exact flags move between releases — trust `--help` over this doc. Prefer
single-file `.glb`; leave textures as PNG at full size (the importer does
the downscaling and KTX2 compression, so export once, not per experiment).

## Drop layout

```
server/data/cs3d/raw/
  maps/<MAP>/world/       map glTF export (.glb + textures/)
  maps/<MAP>/phys/        physics collision export
  maps/<MAP>/entities.txt decompiled entity lump
  maps/<MAP>/radar/       overview image + its scale/offset data (cross-check)
  models/characters/      ctm_*.glb, tm_*.glb (+ textures/)
  models/weapons/         one .glb per weapon worldmodel
  models/grenades/        thrown-projectile models
  models/props/c4/        c4 + planted c4 + defuser
  anims/                  whatever animation export the models yield
  sounds/                 optional, see below
  replica/                the open-source replica checkout, LICENSE included
```

## 1. Maps — one folder per map, INF first

Order: **INF**, DD2, MIR, NUK, ANC, ANU, CCH
(de_inferno, de_dust2, de_mirage, de_nuke, de_ancient, de_anubis, de_cache).

Per map, three exports from the compiled map (`game/csgo/maps/de_<name>.vpk`):

- [ ] **World geometry** → glTF/GLB with textures. Export the whole map in
      one pass (world + placed static props), not mesh-by-mesh. Expect
      hundreds of MB raw — that is fine, it stays local.
- [ ] **Physics collision** (the `.vphys` world physics + prop physics) →
      mesh export. This is the authoritative solid geometry; if a map's
      vphys refuses to export cleanly, note it and move on — the importer
      has a render-mesh fallback, and the plan says a stubborn map waits.
- [ ] **Entities** → decompiled text dump of the entity lump. This carries
      spawn points, `func_bomb_target`, buy zones, ladders — the importer
      parses `meta.json` from it, nothing gets hand-marked.
- [ ] **Radar/overview** image + its position/scale data. We already have 2D
      calibration for all 7 maps; this is the cross-check that the 3D
      transform agrees with it.

NUK note: two floors — nothing special to do at export, but do not strip
anything; the level split happens in the importer.

## 2. Character models — once, not per map

**Automated (2026-08-17):** `npm run cs3d:models` does all of this from the
CS2 install (no manual GUI export) and writes `server/data/cs3d/pack/players/`.
See CS3D-RENDERER.md "fourth pass" for what it found. What it pulls:

- [x] CT: `agents/models/ctm_sas/ctm_sas.vmdl_c` (NOT `characters/models/…`,
      those are stubs) → GLB with skeleton, third-person meshes, hitboxes
- [x] T: `agents/models/tm_phoenix/tm_phoenix.vmdl_c`
- [x] Their textures (albedo 1024, normal 512, ORM 512, webp)
- [x] **Animations**: CS2's Nm clips (`animation/anims/world/…`), which VRF
      19.2 exports cleanly — idle, 8-way run / walk / crouch, in-air, jump,
      shoot, draw, deaths, defuse, plant, throw. The graphs (`.vnmgraph_c`)
      are not exported; the runtime blend replaces them.

Skip agent skins and cosmetic variants entirely.

## 3. Weapon worldmodels

One GLB per weapon the sim models (`shared/sim/weapons.js` roster — this
exact list): ak47, m4a1, m4a1_silencer, galilar, famas, sg556, aug, awp,
ssg08, g3sg1, scar20, glock, usp_silencer, p250, fiveseven, tec9, cz75a,
elite, deagle, revolver, mac10, mp9, mp5sd, ump45, p90, bizon, nova,
xm1014, mag7, sawedoff, negev, m249, knife (default), taser.

- [ ] All worldmodels above (one export pass over the weapons content)
- [ ] Grenade models: hegrenade, flashbang, smokegrenade, molotov,
      incgrenade, decoy
- [ ] c4, planted c4, defuse kit
- [ ] **Viewmodels (first-person arms + v_ models): OPTIONAL.** Only the M2
      sandbox wants them; the demo viewer never shows them. Grab them if the
      pass is cheap, skip if it drags.

## 4. Sounds — optional, but cheap while you are in there

Not needed for M1-M4; bots hear event-bus percepts, not audio. If
extraction is one more click: footsteps (per surface), per-weapon fire,
nade bounce, smoke/flash/HE detonate, molly ignite/burn, plant/defuse,
bomb beeps, explosion. Drop as-is in `sounds/`, organization later.

## 4b. Grenade effect sheets — automated, `npm run cs3d:fx`

**Automated (2026-08-18):** nothing to export by hand. `scripts/cs3d-fx.mjs`
pulls the sprite sheets CS2 draws smoke and fire with straight out of
`pak01_dir.vpk` and writes `server/data/cs3d/pack/fx/` (~2.1 MB), which
`src/cs3d/spriteCard.js` streams once for every map:

| sheet | from | what |
|---|---|---|
| `smoke.webp` | `smokeloop_i_0_sc_hardedge` | 128 frames, 2 sequences |
| `smoke_mv.webp` | `smokeloop_i_0_flwmix` | 64 motion-vector frames |
| `fire.webp` | `fire_small_sim_b_desat` | 131 frames, 4 sequences |
| `fire_mv.webp` | `fire_small_sim_b_mv` | 131 motion-vector frames |
| `fx.json` | the `.vpcf` files | sheet geometry + the flame colour ramps |

Two traps, both of which silently produce something that looks nearly right:

1. **A Source 2 sheet is not a uniform grid.** Frames are rectangle-packed and
   each stores a `uvUncropped` canvas alongside the `uvCropped` box its pixels
   sit in. The offset between them is the flame's position in its own frame —
   on the fire sheet it spans 1–112 px across x — so rebuilding the atlas by
   centring each frame in a cell freezes the animation in place.
2. **The motion-vector sheets keep the vector's y in the alpha channel.** Any
   compositing step that treats alpha as opacity premultiplies it and corrupts
   the field (measured: up to 62/255 off, which tears the frame blend). The
   script copies raw pixels and repacks the vectors to plain RGB.

Both are handled; `--report` prints what each sheet contains without writing.

## 5. The reference replica

- [ ] The repo checkout into `replica/` (or a path note if it lives
      elsewhere) — **with its LICENSE file**. The license decides
      port-vs-oracle (CS3D-PLAN §0) before any of its code is read.

## Already have — do not re-extract

- Demos (3,122 `.aim4replay` on the data machine) — the M1 ground truth.
- 2D radar calibration, nav graphs, anchors, angle catalogues for all 7
  maps (`simdata/`) — the overlay validation data.
- Weapon behavior tables (`shared/sim/weapons.js`) — 3D inherits them;
  nothing about weapon *stats* needs extracting.

## When a drop is ready

Say which map/model landed and I build the importer against it starting
with `maps/INF/`: transform + chunking + BVH bake + `meta.json`, then the
anchor-overlay check (CS3D-PLAN 3D-0) before anything else.

## Fresh clone on a new workstation

All the pipeline *code* is in git — the renderer (`src/cs3d/`), the import
and pack scripts, and the `cs3d-tex` exporter source. Three things are not,
because they are large, re-acquirable, or Valve's to distribute:

| Missing | Size | How to restore |
|---|---|---|
| `cs3d/maps/*.vpk` | 2.0 GB | Copy from the old machine, or re-pull from your own CS2 install (`game/csgo/maps/de_*.vpk`). |
| `tools/vrf/` | 166 MB | Source2Viewer CLI, `cli-windows-x64.zip` from the ValveResourceFormat releases page, unzipped in place. |
| `tools/cs3d-tex/bin/` | 245 MB | `dotnet build -c Release` in `tools/cs3d-tex/`. |

The players pack (`server/data/cs3d/pack/players/`, 8.7 MB) is likewise not
in git: `npm run cs3d:models` rebuilds it from the install in ~15 s. Without
it the 3D demo viewer draws placeholder cylinders.

**de_nuke ships packed** (`server/data/cs3d/pack/nuke/`, ~91 MB) so the
renderer has something to draw on a fresh clone without any of the above.
It is the map carrying the baked light-probe ambient. The other six re-pack
once the .vpk drop and VRF are back:

```
npm run cs3d:build
```

That is import + pack for every map found in the drop. Expect a ~17 GB
intermediate under `server/data/cs3d/raw/`, which is gitignored and can be
deleted afterwards — only `pack/` is served.
