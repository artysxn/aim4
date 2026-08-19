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

## 4c. Bullet decals and the tracer — automated, `npm run cs3d:decals`

**Automated (2026-08-19):** nothing to export by hand. `scripts/cs3d-decals.mjs`
pulls CS2's own impact decals and the streak its tracers are drawn with out of
`pak01_dir.vpk` and writes `server/data/cs3d/pack/bullets/` (~1.3 MB), which
`src/cs3d/decals.js` and `src/cs3d/tracers.js` stream once per page:

| file | from | what |
|---|---|---|
| `manifest.json` | `scripts/decalgroups.vdata` + each decal `.vmat` | 31 impact groups, the game's own per-material probabilities, world sizes and projection depths |
| `decals.webp` | 98 `materials/decals/**` colour maps | 10x10 atlas of 128px cells, alpha is the hole's shape |
| `decals_n.webp` | their normal maps | the same cells, so a hole has relief |
| `tracer.webp` | `materials/effects/spark` | the 32x64 streak itself |

Two traps, both of which silently produce something that looks nearly right:

1. **The decal `.vmat` files do not decompile.** `-d` on one throws inside VRF's
   material writer (the CS2 shader build is past what this VRF parses). The DATA
   block prints fine, so the script reads `-b DATA` and takes the texture
   references and the size attributes out of the KV3. One CLI call covers all of
   `materials/decals/` in under a second.
2. **The surface-to-group map is in no file.** Neither the `.vsurf` nor
   `surfaceproperties_game.txt` names a decal group; the game picks one from the
   one-letter `gamematerial`. `SURFACE_DECAL` in the script is therefore a
   table, marked `[guessed]`, and it is the only guessed thing in the pipeline.

What the vmats DO carry, and what the runtime uses rather than choosing:
`DecalWorldWidth`/`Height` (5x5 for a concrete hole, 2x2 for a vent, 10x10 for
tile), `DecalSizeVariance`, `DecalDepth` 12, and `g_flCutoffAngle` 60 with 5
degrees of softness — the angle past which the projection stops writing, which
is what keeps a hole from smearing around a corner.

## 4d. The spray pattern — no extraction needed

`scripts/weapons.vdata` already carries `m_nRecoilSeed` per weapon, and CS2
generates the pattern from it at load. So there is nothing to export: the
weapons pack (§3) carries the seed and the bounds, and `shared/sim3d/recoil.js`
rebuilds the table. See CS3D-ENGINE-PLAN E6.

The VALIDATION is worth knowing about, because it needs demos rather than the
install: CS2 networks `CCSPlayerPawn.m_aimPunchAngle` per tick for every player,
so `npm run cs3d:spray-truth -- <demo.dem>` reads the real pattern straight out
of a GOTV demo. Six demos give ~750 AK sprays.

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
it the 3D demo viewer draws placeholder cylinders. Same for the bullets pack
(`pack/bullets/`, 1.3 MB, `npm run cs3d:decals`, ~40 s) — without it bullets
leave no holes and no streaks, and nothing else changes.

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

## Serving the packs: get off `pub-*.r2.dev`

The packs are served from a Cloudflare R2 bucket through its public
development URL, `https://pub-<hash>.r2.dev`. **That domain is rate limited**,
Cloudflare says so in as many words, and it is not a theoretical problem: it is
what made Anubis render with nine of its seventy-four geometry tiles missing on
a live page, and Dust 2 with holes of its own.

Loading a map opens roughly fifteen requests at once — four geometry workers,
the texture bundle, the lightmap, the shadow mask, the probe grid, plus the
player, weapon, fx and bullet packs — and some of them come back 429 or with
the socket dropped. The browser reports the dropped socket as a CORS failure
with a **null status**, because an error page carries no
`Access-Control-Allow-Origin`, which is why it reads as a configuration problem
rather than a throttle. Measured against the live bucket on 2026-08-19: twelve
concurrent HEADs turned ~100 objects into 429s in a row; four sequential ones a
second apart never failed once.

`src/cs3d/packFetch.js` retries through it and `MapPack._loadGroups` takes a
second pass at anything still missing, so a map now loads whole. Keep both — a
CDN edge drops the odd connection whatever the domain. But the rate limit
itself only goes away with a **custom domain bound to the bucket**, which is
five minutes of dashboard work:

1. **Cloudflare dashboard → R2 → the bucket → Settings → Public access →
   Custom domains → Connect domain.** Enter `cdn.aim4.io`. The domain has to be
   on a zone in the same Cloudflare account; the DNS record is created for you
   and proxied (orange cloud). Certificate issuance is a minute or two.
2. **Settings → CORS policy** on the same bucket. The r2.dev URL comes with a
   permissive default; a custom domain does not, and without a rule every fetch
   fails at once instead of occasionally, which is a much louder version of the
   same bug. Minimum:

   ```json
   [
     {
       "AllowedOrigins": ["https://www.aim4.io", "https://aim4.io"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range"],
       "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   `Range` matters: `tex.bin` is streamed. The exposed headers are the ones the
   loader reads its progress off, and they are the same set
   `scripts/cs3d-upload.mjs` documents.
3. **Point the client at it.** `VITE_CS3D_ASSET_BASE=https://cdn.aim4.io` in
   the deploy environment, then redeploy. It is read at build time
   (`src/cs3d/mapLoader.js` `assetBase()`), so a redeploy is required — setting
   the variable alone changes nothing. Unset, the loader falls back to the API
   host's `/api/cs3d`, which serves the same files from the origin box.
4. **Verify before trusting it.**

   ```bash
   npm run cs3d:audit -- --base https://cdn.aim4.io
   ```

   Every file every manifest names, checked for MISSING (404), STALE (bytes
   differ from the local pack) and THROTTLED (429). It should print `ok` for
   all eleven packs. `--notes` also shows the harmless ones (a manifest byte
   count left stale by `cs3d:split`, which only skews the loading bar).

Caching does not need changing: `cs3d-upload.mjs` already writes everything
except `manifest.json` as `immutable` for a year, and the loader versions every
URL with the manifest's timestamp.

### Leave `geo.orig/` out of the bucket

`npm run cs3d:split` keeps the pre-split geometry in `geo.orig/` beside `geo/`
so `--restore` can put it back. Nothing ever fetches it — the loader only asks
for files the manifest names — and it is about as large as the pack itself.
`cs3d-upload.mjs` skips it (`SKIP_DIRS`); it was walking it until 2026-08-19,
which would have put 458 MB of dead objects across six maps into the bucket.
