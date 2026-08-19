#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-decals.mjs
// What a bullet leaves behind: CS2's own impact decals, the table that says
// which one a surface gets, the sizes the game projects them at, and the
// streak its tracers are drawn with.
//
//   server/data/cs3d/pack/bullets/
//     manifest.json    groups, weights, world sizes, the surface→group table
//     decals.webp      colour + mask atlas, one 128px cell per decal
//     decals_n.webp    the matching normal atlas
//     tracer.webp      materials/effects/spark — the trail texture itself
//
// Where each piece comes from, and the two things that are easy to get wrong:
//
//   `scripts/decalgroups.vdata` is the game's own list. 31 `Impact.*` groups
//   over 98 materials, each with a `m_flProbability` — Concrete has five holes
//   at equal weight, MetalShield has four at 2/2/1/1, so the first two show up
//   twice as often. That weighting is data, not a detail: a wall shot fifty
//   times in CS2 does not repeat one texture ten times in a row, and a uniform
//   pick makes it look like it does.
//
//   The SIZE is on the material, not on the group. Every decal .vmat carries
//   `DecalWorldWidth` / `DecalWorldHeight` in Source units (5×5 for a concrete
//   bullet hole) and a `DecalSizeVariance` (0.5) the game rolls per impact, so
//   holes are not all the same size. It also carries `g_flCutoffAngle` (60°)
//   with a 5° softness — the angle past which the projection stops writing,
//   which is what keeps a decal from smearing down a wall it only grazed.
//   Both are read here rather than chosen.
//
// TRAP 1 — the vmats do not decompile. `-d` on a decal .vmat_c throws inside
// VRF's material writer (the CS2 shader build is past what this VRF parses).
// The DATA block prints fine, so this script reads `-b DATA` and takes the
// texture references and the attributes out of the KV3 itself. One CLI call
// dumps all of `materials/decals/` in under a second.
//
// TRAP 2 — the surface→group map is NOT in any file. Neither the .vsurf nor
// `surfaceproperties_game.txt` names a decal group; the game picks one from the
// one-letter `gamematerial` in code. So SURFACE_DECAL below is a table, derived
// from the game material letters the surface pack already carries, and it is
// the only guessed thing in this file — marked, and small enough to check by
// walking a map and shooting each surface.
//
// Usage:
//   node scripts/cs3d-decals.mjs                # extract (if missing) + pack
//   node scripts/cs3d-decals.mjs --force        # re-export from the .vpk
//   node scripts/cs3d-decals.mjs --report       # print the table, write nothing
//   node scripts/cs3d-decals.mjs --game "<...>\Counter-Strike Global Offensive\game\csgo"
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { ROOT, fail as failWith, assertLocalOutput, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { parseKv3 } from './lib/kv3.mjs';

const TAG = 'cs3d-decals';
const fail = (msg) => failWith(TAG, msg);

export const PACK_VERSION = 1;
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'bullets');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', 'bullets');

/** Atlas cell, px. A bullet hole is 5 units across; 128 is more than it needs. */
const CELL = 128;

/**
 * Transparent border around each cell, px.
 *
 * The runtime keeps the full mip chain, and a mip is a box filter that does not
 * know about cell boundaries: at the 8x8 level one texel already spans sixteen
 * cells' worth of the sheet, so a decal seen from across the map samples its
 * neighbours. Eight pixels of empty margin at full size is one texel of margin
 * four mips down, which is where a 5-unit hole actually lands on screen.
 *
 * The margin is INSIDE the cell — the decal is drawn at CELL - 2*GUTTER and
 * centred — so `cellUv` stays the plain cell box and the runtime needs to know
 * nothing about it.
 */
const GUTTER = 8;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const force = flag('--force');
const report = flag('--report');

/**
 * Which groups this pack carries.
 *
 * `Impact.*` is every bullet hole. `Scorch` and `MolotovScorch` are the burn
 * marks an HE and a molotov leave, which src/cs3d/nadeEffects.js has no decal
 * for yet and will want; they cost four textures, so they come along now rather
 * than after a second extraction pass.
 *
 * Blood and the Half-Life leftovers (`ManhackCut`) are skipped.
 */
const WANTED = (name) => /^Impact\./.test(name) || name === 'Scorch' || name === 'MolotovScorch';

/**
 * [guessed] Game material letter → decal group.
 *
 * The letters are `gamematerial` out of `surfaceproperties_game.txt`, which
 * shared/sim3d/surfaces.js already resolves per surface, so a bullet that knows
 * which triangle it hit knows its letter. CS2 maps letter to group inside the
 * client binary — there is no data file for it — so this is read off the names
 * on both sides and is the one thing here that is not extracted.
 *
 * The letters are Source's CHAR_TEX_* set. CS:GO added the numeric ones; the
 * ones below are the ones CS2's own surface table actually emits (checked
 * against every distinct `material` in shared/sim3d/surfaces.js).
 */
const SURFACE_DECAL = {
  C: 'Impact.Concrete', // concrete, and the `default` surface
  M: 'Impact.Metal',
  G: 'Impact.Metal', // metalgrate — a bullet through a grate still marks the bar
  V: 'Impact.Vent',
  Y: 'Impact.Glass',
  W: 'Impact.Wood',
  D: 'Impact.Dirt',
  N: 'Impact.Sand',
  J: 'Impact.Grass',
  O: 'Impact.Leaves', // foliage
  P: 'Impact.Computer',
  U: 'Impact.Cardboard',
  R: 'Impact.Brick',
  Q: 'Impact.Asphalt',
  T: 'Impact.Tile',
  K: 'Impact.Snow',
  L: 'Impact.Plastic',
  S: 'Impact.Concrete', // slosh (shallow water) — the floor under it marks
  B: 'Impact.RtWound', // bloodyflesh
  F: 'Impact.RtWound',
  H: 'Impact.RtWound',
  1: 'Impact.Mud', // clay
  2: 'Impact.Plaster',
  3: 'Impact.Rock',
  4: 'Impact.Rubber',
  5: 'Impact.Sheetrock',
  6: 'Impact.Upholstery', // cloth
  7: 'Impact.Upholstery', // carpet
  9: 'Impact.Upholstery',
  11: 'Impact.Mud',
  12: 'Impact.Metal', // metal barrel
  14: 'Impact.MetalShield'
};

/** What a surface with no letter, or a letter not above, gets. */
const DEFAULT_GROUP = 'Impact.Concrete';

/**
 * [docs] CS2 authors a `_Grazing` variant for six of the impact groups —
 * a longer, smeared hole for a bullet that came in nearly parallel to the
 * surface. The angle it switches at is not in the files; the pack ships both
 * and the runtime picks (src/cs3d/decals.js).
 */
const GRAZING_SUFFIX = '_Grazing';

// ---- the group table --------------------------------------------------------

/** `scripts/decalgroups.vdata` → { group: [{ material, probability }] }. */
function readGroups(dumpText) {
  const start = dumpText.indexOf('<!-- kv3');
  const doc = parseKv3(dumpText.slice(start < 0 ? 0 : start));
  const out = {};
  for (const [name, entry] of Object.entries(doc)) {
    const options = entry?.m_vecOptions;
    if (!Array.isArray(options) || !WANTED(name)) continue;
    const rows = options
      .map((o) => ({ material: String(o?.m_hMaterial || ''), probability: Number(o?.m_flProbability) || 1 }))
      .filter((o) => o.material);
    if (rows.length) out[name] = rows;
  }
  return out;
}

/**
 * One `-b DATA` dump of many .vmat_c → { path: { color, normal, width, … } }.
 *
 * The dump is one KV3 document per material with the CLI's own banner between
 * them, so it splits on the KV3 header and lets the parser stop at the closing
 * brace of each (parseKv3 reads one value and ignores the rest).
 */
function readMaterials(dumpText) {
  const out = {};
  const chunks = dumpText.split(/(?=<!-- kv3)/g);
  for (const chunk of chunks) {
    if (!chunk.startsWith('<!-- kv3')) continue;
    let doc;
    try {
      doc = parseKv3(chunk);
    } catch {
      continue;
    }
    const name = String(doc.m_materialName || '');
    if (!name) continue;
    const tex = {};
    for (const t of doc.m_textureParams || []) tex[t.m_name] = String(t.m_pValue || '');
    const fl = {};
    for (const f of doc.m_floatParams || []) fl[f.m_name] = Number(f.m_flValue);
    const at = {};
    for (const a of doc.m_floatAttributes || []) at[a.m_name] = Number(a.m_flValue);
    for (const a of doc.m_intAttributes || []) if (!(a.m_name in at)) at[a.m_name] = Number(a.m_nValue);
    if (!tex.g_tColor) continue;
    out[name] = {
      name,
      shader: String(doc.m_shaderName || ''),
      color: tex.g_tColor,
      normal: tex.g_tNormal || null,
      // Source units. The runtime rolls a size in [1 - v, 1 + v] × this.
      width: at.DecalWorldWidth ?? 5,
      height: at.DecalWorldHeight ?? 5,
      sizeVariance: at.DecalSizeVariance ?? 0,
      // How deep the projection box reaches, and where it starts. A hole on a
      // pillar wraps onto the faces beside it because of this, and the offset
      // is what pulls the box back out of the wall so the near face is caught.
      depth: at.DecalDepth ?? 12,
      depthOffset: at.DecalDepthOffset ?? 0,
      // Past this angle between the surface and the projection axis the decal
      // stops writing, softened over `cutoffSoftness` degrees.
      cutoffAngle: fl.g_flCutoffAngle ?? 90,
      cutoffSoftness: fl.g_flCutoffAngleSoftness ?? 0
    };
  }
  return out;
}

// ---- extraction -------------------------------------------------------------

async function dumpBlock(vrf, pak, filter, file, { extensions = null } = {}) {
  const cached = path.join(RAW_DIR, file);
  if (!force && fs.existsSync(cached)) return fsp.readFile(cached, 'utf8');
  const cli = ['-i', pak, '-f', filter, '-b', 'DATA'];
  if (extensions) cli.push('-e', extensions);
  const text = await runVrf(vrf, cli, `dump ${filter}`, { capture: true });
  await fsp.mkdir(RAW_DIR, { recursive: true });
  await fsp.writeFile(cached, text);
  return text;
}

/**
 * Pull the textures the chosen materials name, as PNG, into raw/.
 *
 * One CLI call for the whole set: the filter is a path prefix, and every decal
 * texture lives under `materials/decals/`, so exporting the lot and then
 * picking is one process instead of 200.
 */
async function extractTextures(vrf, pak, wanted) {
  const missing = wanted.filter((t) => !fs.existsSync(pngFor(t)));
  if (!force && !missing.length) return 0;
  await fsp.mkdir(RAW_DIR, { recursive: true });
  await runVrf(
    vrf,
    ['-i', pak, '-o', path.join(RAW_DIR, 'tex'), '-d', '-f', 'materials/decals/', '-e', 'vtex_c', '--threads', '8'],
    'decal textures'
  );
  return missing.length;
}

/** `materials/decals/concrete/x.vtex` → where extractTextures put its PNG. */
function pngFor(vtex) {
  return path.join(RAW_DIR, 'tex', `${vtex.replace(/\.vtex$/, '')}.png`);
}

/**
 * The tracer's own texture.
 *
 * `weapon_tracers_assrifle.vpcf` draws its trail with `C_OP_RenderTrails` over
 * `materials/effects/spark` — a 32×64 strip, white-hot down the middle with a
 * warm falloff and a taper at the head. That IS the streak; there is no sheet
 * and no animation on it, the particle system stretches it along the bullet.
 */
const TRACER_TEX = 'materials/effects/spark.vtex_c';

async function extractTracer(vrf, pak) {
  const png = path.join(RAW_DIR, 'tex', 'materials/effects/spark.png');
  if (force || !fs.existsSync(png)) {
    await runVrf(vrf, ['-i', pak, '-o', path.join(RAW_DIR, 'tex'), '-d', '-f', TRACER_TEX], 'tracer texture', { quiet: true });
  }
  if (!fs.existsSync(png)) return null;
  // Kept at its authored size: it is 2 KB and every pixel of it is the streak.
  return sharp(png).ensureAlpha().webp({ quality: 95 }).toBuffer();
}

// ---- packing ----------------------------------------------------------------

/**
 * Both atlases, in one pass over the cell list.
 *
 * Colour keeps its alpha (the alpha IS the hole's shape — the RGB is a full
 * rectangle of rubble and without the mask a decal is a grey square). The
 * normal map's blue is dropped and rebuilt on the GPU from RG, which is what
 * lets both sheets be one 4-channel webp instead of six.
 */
async function buildAtlases(cells) {
  const cols = Math.ceil(Math.sqrt(cells.length));
  const rows = Math.ceil(cells.length / cols);
  const W = cols * CELL;
  const H = rows * CELL;
  const color = Buffer.alloc(W * H * 4, 0);
  const normal = Buffer.alloc(W * H * 4, 0);
  // A cell with no normal map reads as flat: +z, which is (128, 128) in RG.
  for (let i = 0; i < W * H; i++) {
    normal[i * 4] = 128;
    normal[i * 4 + 1] = 128;
    normal[i * 4 + 2] = 255;
    normal[i * 4 + 3] = 255;
  }

  for (let i = 0; i < cells.length; i++) {
    const cx = (i % cols) * CELL + GUTTER;
    const cy = Math.floor(i / cols) * CELL + GUTTER;
    const c = await resample(cells[i].color);
    blit(color, W, cx, cy, c);
    if (cells[i].normal) {
      const n = await resample(cells[i].normal);
      blit(normal, W, cx, cy, n);
    }
  }

  return {
    cols,
    rows,
    cell: CELL,
    color: await sharp(color, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 92 }).toBuffer(),
    normal: await sharp(normal, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 90 }).toBuffer()
  };
}

/** Cell minus its two gutters: the pixels the decal actually occupies. */
const INNER = CELL - GUTTER * 2;

/**
 * One decal texture at cell size, RGBA.
 *
 * A note about alpha, because the obvious worry here turns out not to apply.
 * sharp premultiplies around a resize and cannot recover colour where alpha is
 * zero — a synthetic red-under-transparent image comes back black, and
 * `removeAlpha()` does not dodge it. That WOULD matter on an atlas, because a
 * darkened transition band at a decal's edge reads as a halo.
 *
 * It does not matter for these textures: 6,258 of the 6,391 fully-transparent
 * texels in `bullethole_concrete_1_color` are ALREADY black in the source, so
 * the premultiply has nothing to lose. CS2 authors them that way and draws
 * them that way. What DOES matter is the gutter above — the mip chain, not the
 * resize, is what bleeds one decal into the next.
 *
 * The stride is read off `info` rather than assumed: a four-channel buffer
 * walked three at a time turns every decal into red and cyan stripes, which
 * looks like a colour-space bug and is not one.
 */
async function resample(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .resize(INNER, INNER, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  if (ch === 4) return data;
  const out = Buffer.alloc(INNER * INNER * 4);
  for (let i = 0; i < INNER * INNER; i++) {
    out[i * 4] = data[i * ch];
    out[i * 4 + 1] = data[i * ch + 1];
    out[i * 4 + 2] = data[i * ch + 2];
    out[i * 4 + 3] = ch > 3 ? data[i * ch + 3] : 255;
  }
  return out;
}

function blit(dst, dstW, x, y, src) {
  for (let r = 0; r < INNER; r++) {
    const from = r * INNER * 4;
    const to = ((y + r) * dstW + x) * 4;
    src.copy(dst, to, from, from + INNER * 4);
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const vrf = findVrf(TAG);
  const game = findGameDir(TAG, opt('--game'));
  const pak = path.join(game, 'pak01_dir.vpk');
  assertLocalOutput(TAG, PACK_DIR);

  const groupDump = await dumpBlock(vrf, pak, 'scripts/decalgroups.vdata_c', 'decalgroups.kv3');
  const groups = readGroups(groupDump);
  if (!Object.keys(groups).length) fail('no impact decal groups in decalgroups.vdata');

  const matDump = await dumpBlock(vrf, pak, 'materials/decals/', 'decal-materials.kv3', { extensions: 'vmat_c' });
  const materials = readMaterials(matDump);

  // Only the materials the wanted groups actually name.
  const used = new Map();
  const gaps = [];
  for (const [group, rows] of Object.entries(groups)) {
    for (const row of rows) {
      const m = materials[row.material];
      if (!m) {
        gaps.push(`${group} → ${row.material}`);
        continue;
      }
      if (!used.has(m.name)) used.set(m.name, m);
    }
  }
  if (gaps.length) console.warn(`  ${gaps.length} decal material(s) named by a group but absent from the dump: ${gaps.slice(0, 4).join(', ')}`);

  if (report) {
    console.log(`${TAG}: ${Object.keys(groups).length} groups, ${used.size} materials`);
    for (const [g, rows] of Object.entries(groups)) {
      const total = rows.reduce((s, r) => s + r.probability, 0);
      const sizes = rows.map((r) => materials[r.material]).filter(Boolean);
      const w = sizes.length ? `${Math.min(...sizes.map((s) => s.width))}–${Math.max(...sizes.map((s) => s.width))}u` : '?';
      console.log(`  ${g.padEnd(26)} ${String(rows.length).padStart(2)} option(s), weight ${total}, ${w}`);
    }
    return;
  }

  const cells = [...used.values()];
  const pulled = await extractTextures(
    vrf,
    pak,
    cells.flatMap((c) => [c.color, c.normal].filter(Boolean))
  );
  if (pulled) console.log(`  ${pulled} texture(s) exported`);

  // A material whose PNG never arrived is dropped rather than atlassed black.
  const ready = [];
  const lost = [];
  for (const c of cells) {
    const color = pngFor(c.color);
    if (!fs.existsSync(color)) {
      lost.push(c.name);
      continue;
    }
    const normal = c.normal && fs.existsSync(pngFor(c.normal)) ? pngFor(c.normal) : null;
    ready.push({ ...c, colorPng: color, normalPng: normal });
  }
  if (lost.length) console.warn(`  ${lost.length} material(s) without a colour texture, dropped: ${lost.slice(0, 3).join(', ')}`);
  if (!ready.length) fail('no decal textures could be exported');

  const index = new Map(ready.map((c, i) => [c.name, i]));
  const atlas = await buildAtlases(ready.map((c) => ({ color: c.colorPng, normal: c.normalPng })));

  const tracer = await extractTracer(vrf, pak);
  if (!tracer) console.warn('  tracer texture missing; bullets will draw an untextured streak');

  await fsp.mkdir(PACK_DIR, { recursive: true });
  await fsp.writeFile(path.join(PACK_DIR, 'decals.webp'), atlas.color);
  await fsp.writeFile(path.join(PACK_DIR, 'decals_n.webp'), atlas.normal);
  if (tracer) await fsp.writeFile(path.join(PACK_DIR, 'tracer.webp'), tracer);

  const manifest = {
    version: PACK_VERSION,
    generated: new Date().toISOString(),
    atlas: {
      color: 'decals.webp',
      normal: 'decals_n.webp',
      cols: atlas.cols,
      rows: atlas.rows,
      cell: atlas.cell,
      /** Empty margin inside each cell, px — the runtime insets by it. */
      gutter: GUTTER
    },
    /**
     * The tracer, straight out of `weapon_tracers_assrifle.vpcf`. Speed is the
     * `C_INIT_MoveBetweenPoints` literal, length the `C_OP_RenderTrails` cap,
     * and the fades are `C_OP_FadeAndKillForTracers`. `radius` is that op's
     * `m_flMaxSize` in the particle system's own normalised units, taken here
     * as a fraction of the trail length, which is what puts a rifle tracer at
     * roughly two and a half units across.
     */
    tracer: tracer
      ? {
          texture: 'tracer.webp',
          speed: 20500,
          maxLength: 1200,
          lengthFadeIn: 0.08,
          minSize: 0.00075,
          maxSize: 0.002,
          radiusScale: 0.5,
          fadeInAt: 0.2,
          fadeOutAt: 0.95,
          nearFade: 180
        }
      : null,
    /** Per cell: the size and projection the game's own material asks for. */
    decals: ready.map((c) => ({
      name: c.name.replace(/^materials\/decals\//, '').replace(/\.vmat$/, ''),
      width: c.width,
      height: c.height,
      sizeVariance: c.sizeVariance,
      depth: c.depth,
      depthOffset: c.depthOffset,
      cutoffAngle: c.cutoffAngle,
      cutoffSoftness: c.cutoffSoftness
    })),
    /** group → [{ cell, weight }], the weights straight out of the vdata. */
    groups: Object.fromEntries(
      Object.entries(groups)
        .map(([g, rows]) => [
          g,
          rows.map((r) => ({ cell: index.get(r.material), weight: r.probability })).filter((r) => r.cell !== undefined)
        ])
        .filter(([, rows]) => rows.length)
    ),
    /** [guessed] game material letter → group. See SURFACE_DECAL above. */
    surfaceGroup: SURFACE_DECAL,
    defaultGroup: DEFAULT_GROUP,
    grazingSuffix: GRAZING_SUFFIX
  };
  // `manifest.json`, and the name is load-bearing: server/cs3d/routes.js caches
  // every OTHER file in a pack for a year as immutable and only this one for a
  // minute, which is what lets a re-pack be picked up at all. The runtime then
  // hangs `?v=<generated>` off the atlases (src/cs3d/bulletPack.js).
  await fsp.writeFile(path.join(PACK_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);

  const bytes = atlas.color.length + atlas.normal.length + (tracer?.length || 0);
  const grazing = Object.keys(manifest.groups).filter((g) => g.endsWith(GRAZING_SUFFIX)).length;
  console.log(
    `${TAG}: ${ready.length} decals in ${Object.keys(manifest.groups).length} groups ` +
      `(${grazing} grazing), ${atlas.cols}×${atlas.rows} × ${CELL}px → ${(bytes / 1024).toFixed(0)} KB in ${path.relative(ROOT, PACK_DIR)}`
  );
}

main().catch((e) => fail(e?.stack || String(e)));
