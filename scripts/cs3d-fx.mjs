#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-fx.mjs
// The grenade-effect pack: the sprite sheets CS2 actually draws smoke and fire
// with, rebuilt into atlases a browser can stream, plus the numbers the
// renderer needs to draw them the way the game does.
//
//   server/data/cs3d/pack/fx/
//     fx.json          sheet geometry, sequences, colour ramps, renderer consts
//     smoke.webp       smokeloop_i_0_sc_hardedge   128 frames, 2 sequences
//     smoke_mv.webp    smokeloop_i_0_flwmix         64 motion-vector frames
//     fire.webp        fire_small_sim_b           131 frames, 4 sequences
//     fire_mv.webp     fire_small_sim_b_mv         131 motion-vector frames
//
// Four things this had to get right, each of which took a probe to find out:
//
//   1. A Source 2 sheet is NOT a uniform grid. `fire_small_sim_b_desat` is a
//      4096x2048 rectangle-packed atlas: 101 distinct frame origins across x,
//      30 across y, no constant pitch. What IS constant is the *uncropped*
//      frame size (184.5 px there, 127.5 for smoke) — the logical canvas the
//      sim was rendered into. Every frame stores two rects: `uvUncropped`, the
//      canvas, and `uvCropped`, the tight box the non-empty pixels sit in.
//   2. So the frame's position INSIDE its canvas is data, not padding. On the
//      fire sheet the crop inset runs from 1 to 112 px across x and 4.5 to 139
//      across y — that spread IS the flame rising and leaning. Rebuild the
//      atlas by centring each cropped frame in a cell (the obvious thing, and
//      what the competitor's rip did) and the animation stops moving: every
//      frame gets yanked back to the middle. Honour the inset instead.
//   3. Source2Viewer-CLI writes one PNG per frame, already cropped, named
//      `<base>_seq<S>_<F>.png`. Pairing those with the rects out of `-b DATA`
//      is the whole extraction: no DXT decoding here, no guessing at a grid.
//   4. The motion-vector sheets carry direction, not colour, so they are
//      written lossless and never resampled. `smokeloop_i_0_flwmix` has 64
//      frames against the colour sheet's 128 because the colour sheet is two
//      64-frame variants (solidcolor / solidhardcolor) of the same loop, and
//      one set of vectors serves both.
//
// The colour ramps come out of the particle systems themselves
// (`molotov_groundfire_outline` / `incendiary_groundfire_outline`), where a
// `SPRITECARD_TEXTURE_1D_COLOR_LOOKUP` maps the desaturated sim's luminance to
// the flame colour. That gradient is why a CS2 molotov has a violet edge and an
// incendiary a cyan one, and it is read here rather than eyeballed.
//
// Usage:
//   node scripts/cs3d-fx.mjs                  # extract (if missing) + pack
//   node scripts/cs3d-fx.mjs --force          # re-export from the .vpk
//   node scripts/cs3d-fx.mjs --report         # print what the sheets contain
//   node scripts/cs3d-fx.mjs --game "<...>\Counter-Strike Global Offensive\game\csgo"
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { ROOT, fail as failWith, assertLocalOutput, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { parseKv3 } from './lib/kv3.mjs';

const TAG = 'cs3d-fx';
const fail = (msg) => failWith(TAG, msg);

/** Bumped when the sheet layout or the manifest shape changes. */
export const FX_VERSION = 1;

const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'fx');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', 'fx');

/**
 * What to pull, and how big to rebuild it.
 *
 * `cell` is the side of a cell in the rebuilt atlas. Leaving it at the sheet's
 * own uncropped size keeps texel density identical to the game's; dropping it
 * (fire, 184.5 -> 128) trades detail no one can see on a blurred emissive
 * sprite for a third of the bytes. `cols` only decides the atlas shape.
 *
 * `mv` marks a motion-vector sheet: written lossless, never resampled, and
 * repacked to RGB, because its pixels are directions rather than colour.
 */
const SHEETS = [
  {
    key: 'smoke',
    tex: 'materials/particle/smoke/smokeburst/smokeloop_i_0_sc_hardedge.vtex',
    cols: 16,
    what: 'CS2 smoke grenade body, explosion_smokegrenade_voxel'
  },
  {
    key: 'smoke_mv',
    tex: 'materials/particle/smoke/smokeburst/smokeloop_i_0_flwmix.vtex',
    cols: 8,
    mv: true,
    what: 'motion vectors for smoke, SPRITECARD_TEXTURE_ANIMMOTIONVEC'
  },
  {
    key: 'fire',
    tex: 'materials/particle/fire_small_sim/fire_small_sim_b.vtex',
    cols: 12,
    cell: 128,
    what: 'flame sim, molotov_groundfire_main_fancy'
  },
  {
    key: 'fire_mv',
    tex: 'materials/particle/fire_small_sim/fire_small_sim_b_mv.vtex',
    cols: 12,
    mv: true,
    what: 'motion vectors for fire'
  }
];

/**
 * Where the flame colour ramps live. Two per grenade type, and taking the wrong
 * one paints the fire purple:
 *
 *   body   `*_groundfire_main_fancy` — the 500-particle flame itself. Black ->
 *          dark red -> ORANGE by 0.26 -> tan -> cream -> white. The sheet's
 *          luminance sits between 0.5 and 0.8, so nearly all of it lands in
 *          orange, which is what a molotov looks like.
 *   edge   `*_groundfire_outline` — a thin trail around the flame. Black ->
 *          blue -> VIOLET -> orange -> white for a molotov, and through cyan
 *          for an incendiary. This is where the coloured fringe comes from, and
 *          it is a detail on the rim, not the colour of the fire. Reaching for
 *          it as the body ramp paints the whole flame magenta.
 */
const RAMPS = {
  molotov: {
    body: 'particles/inferno_fx/molotov_groundfire_main_fancy.vpcf',
    edge: 'particles/inferno_fx/molotov_groundfire_outline.vpcf'
  },
  incgrenade: {
    body: 'particles/inferno_fx/incendiary_groundfire_main_fancy.vpcf',
    edge: 'particles/inferno_fx/incendiary_groundfire_outline.vpcf'
  }
};

// ---- reading the sheet -----------------------------------------------------

/**
 * Pull the frame table out of the text Source2Viewer prints for a texture's
 * DATA block. Returns pixel rects, not UVs, because every consumer here wants
 * pixels and the conversion needs the sheet size anyway.
 *
 * A frame can carry up to four images; CS2's grenade sheets use one (smoke
 * stores a second that is a byte-for-byte copy of the first), so image 0 is
 * the frame.
 */
export function parseSheet(dump) {
  const width = Number(dump.match(/^Width\s*=\s*(\d+)/m)?.[1]);
  const height = Number(dump.match(/^Height\s*=\s*(\d+)/m)?.[1]);
  if (!width || !height) fail('no Width/Height in the DATA dump; is this a .vtex?');

  const rect = String.raw`\{\s*\(\s*([\d.eE+-]+),\s*([\d.eE+-]+)\s*\),\s*\(\s*([\d.eE+-]+),\s*([\d.eE+-]+)\s*\)\s*\}`;
  const re = new RegExp(
    String.raw`\[(\d+)\.(\d+)\.(\d+)\]\s*uvCropped\s*=\s*${rect}\s*` +
      String.raw`\[\d+\.\d+\.\d+\]\s*uvUncropped\s*=\s*${rect}`,
    'g'
  );

  const frames = [];
  for (const m of dump.matchAll(re)) {
    if (Number(m[3]) !== 0) continue; // image 0 is the frame
    const px = (u, axis) => Number(u) * (axis === 'x' ? width : height);
    const c = [px(m[4], 'x'), px(m[5], 'y'), px(m[6], 'x'), px(m[7], 'y')];
    const u = [px(m[8], 'x'), px(m[9], 'y'), px(m[10], 'x'), px(m[11], 'y')];
    frames.push({
      seq: Number(m[1]),
      frame: Number(m[2]),
      // where the pixels sit inside the frame's own canvas
      inset: [c[0] - u[0], c[1] - u[1]],
      cropped: [c[2] - c[0], c[3] - c[1]],
      canvas: [u[2] - u[0], u[3] - u[1]]
    });
  }
  if (!frames.length) fail('the DATA dump has no sheet frames');

  // The canvas is the one thing the rebuild leans on being constant.
  const cw = frames[0].canvas[0];
  const ch = frames[0].canvas[1];
  const drift = frames.reduce((a, f) => Math.max(a, Math.abs(f.canvas[0] - cw), Math.abs(f.canvas[1] - ch)), 0);
  if (drift > 0.5) fail(`frame canvas is not constant (varies by ${drift.toFixed(2)}px); the rebuild assumes it is`);

  const sequences = [];
  for (const f of frames) {
    const s = (sequences[f.seq] ||= { id: f.seq, start: 0, count: 0 });
    s.count++;
  }
  const clamps = [...dump.matchAll(/m_bClamp\s*=\s*(True|False)/g)].map((m) => m[1] === 'True');
  let at = 0;
  for (const s of sequences) {
    s.start = at;
    at += s.count;
    s.clamp = clamps[s.id] ?? false;
  }

  return { width, height, canvas: [cw, ch], frames, sequences };
}

// ---- rebuilding the atlas --------------------------------------------------

/**
 * Lay the cropped frames out in a uniform grid, each one placed at the inset
 * the sheet recorded for it. This is the step that keeps a rising flame rising
 * (see note 2 up top).
 */
async function buildAtlas(sheet, frameDir, base, { cols, cell, mv }) {
  // Default to no resampling at all: a cell big enough for the canvas, frames
  // copied in at their own size. Only an explicit `cell` rescales, and only
  // the fire colour sheet asks for that.
  const cellPx = cell || Math.ceil(sheet.canvas[0]);
  const scale = cell ? cellPx / sheet.canvas[0] : 1;
  const rows = Math.ceil(sheet.frames.length / cols);
  const W = cols * cellPx;
  const H = rows * cellPx;

  // Straight pixel copies, never sharp's `composite`. Compositing means alpha
  // blending, which premultiplies: on the motion-vector sheets the vector's y
  // component IS the alpha channel, so blending it against a transparent
  // canvas moved values by up to 62/255 and tore the frame blend. The colour
  // sheets have the same problem more quietly — `sc_hardedge` carries real RGB
  // under low alpha. Frames never overlap, so a copy is also the correct
  // composite.
  const atlas = new Uint8Array(W * H * 4);
  let spilled = 0;

  for (let i = 0; i < sheet.frames.length; i++) {
    const f = sheet.frames[i];
    const file = path.join(frameDir, `${base}_seq${f.seq}_${f.frame}.png`);
    if (!fs.existsSync(file)) fail(`missing frame export ${path.basename(file)}`);

    let img = sharp(file).ensureAlpha();
    if (scale !== 1) {
      img = img.resize(Math.max(1, Math.round(f.cropped[0] * scale)), Math.max(1, Math.round(f.cropped[1] * scale)), {
        fit: 'fill',
        kernel: 'lanczos3'
      });
    }
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });

    const left = (i % cols) * cellPx + Math.round(f.inset[0] * scale);
    const top = Math.floor(i / cols) * cellPx + Math.round(f.inset[1] * scale);
    const cellRight = ((i % cols) + 1) * cellPx;
    const cellBottom = (Math.floor(i / cols) + 1) * cellPx;
    if (left + info.width > cellRight || top + info.height > cellBottom) spilled++;

    for (let y = 0; y < info.height; y++) {
      const ay = top + y;
      if (ay < 0 || ay >= H) continue;
      for (let x = 0; x < info.width; x++) {
        const ax = left + x;
        if (ax < 0 || ax >= W) continue;
        const s = (y * info.width + x) * info.channels;
        const d = (ay * W + ax) * 4;
        atlas[d] = data[s];
        atlas[d + 1] = data[s + 1];
        atlas[d + 2] = data[s + 2];
        atlas[d + 3] = data[s + 3];
      }
    }
  }
  if (spilled) console.warn(`  ! ${base}: ${spilled} frame(s) reach past their cell and were clipped`);

  if (mv) {
    // A motion-vector sheet is a vector field wearing an image's clothes:
    // Valve puts x in G and y in A and leaves R and B at zero. Repack to plain
    // RGB (x in R, y in G) so nothing downstream can treat the y component as
    // transparency, and so lossless webp has three flat-ish planes instead of
    // four. The manifest records the layout.
    const rgb = new Uint8Array(W * H * 3);
    for (let p = 0, q = 0; p < atlas.length; p += 4, q += 3) {
      rgb[q] = atlas[p + 1];
      rgb[q + 1] = atlas[p + 3];
      rgb[q + 2] = 0;
    }
    const buffer = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
      .webp({ lossless: true, effort: 6 })
      .toBuffer();
    return { buffer, width: W, height: H, cols, rows, cell: cellPx, channels: 'rg' };
  }

  const buffer = await sharp(atlas, { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 94, alphaQuality: 100, effort: 5 })
    .toBuffer();
  return { buffer, width: W, height: H, cols, rows, cell: cellPx, channels: 'rgba' };
}

// ---- the colour ramps ------------------------------------------------------

/**
 * The 1D colour lookup a flame's luminance is mapped through. Read straight
 * out of the particle system so the violet on a molotov is the game's violet.
 */
function readRamp(vpcfText) {
  // `-b DATA` prints a banner before the document; start at the kv3 header.
  const at = vpcfText.indexOf('<!-- kv3');
  const doc = parseKv3(at < 0 ? vpcfText : vpcfText.slice(at));
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) { const r = walk(x); if (r) return r; } return null; }
    if (!v || typeof v !== 'object') return null;
    if (v.m_bReplaceTextureWithGradient && v.m_Gradient?.m_Stops?.length) return v.m_Gradient.m_Stops;
    for (const x of Object.values(v)) { const r = walk(x); if (r) return r; }
    return null;
  };
  const stops = walk(doc);
  if (!stops) return null;
  return stops
    .map((s) => ({ at: Number(s.m_flPosition), rgb: (s.m_Color || []).slice(0, 3).map(Number) }))
    .filter((s) => Number.isFinite(s.at) && s.rgb.length === 3)
    .sort((a, b) => a.at - b.at);
}

// ---- the run ---------------------------------------------------------------

async function extract(vrf, pak, entry, force) {
  const base = path.basename(entry.tex, '.vtex');
  const frameDir = path.join(RAW_DIR, base);
  const dumpFile = path.join(RAW_DIR, `${base}.data.txt`);

  if (force || !fs.existsSync(dumpFile)) {
    const dump = await runVrf(vrf, ['-i', pak, '-f', entry.tex, '-b', 'DATA'], `${entry.key} sheet`, { capture: true });
    await fsp.mkdir(RAW_DIR, { recursive: true });
    await fsp.writeFile(dumpFile, dump);
  }
  if (force || !fs.existsSync(frameDir)) {
    await fsp.mkdir(frameDir, { recursive: true });
    await runVrf(vrf, ['-i', pak, '-o', frameDir, '-d', '-f', entry.tex], `${entry.key} frames`);
  }

  // VRF mirrors the game path under the output dir; find the leaf that has the
  // PNGs rather than assuming the shape of it.
  let dir = frameDir;
  const findLeaf = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) { const r = findLeaf(p); if (r) return r; }
      else if (name.startsWith(`${base}_seq`) && name.endsWith('.png')) return d;
    }
    return null;
  };
  dir = findLeaf(frameDir) || fail(`no frame PNGs under ${frameDir}`);

  return { sheet: parseSheet(await fsp.readFile(dumpFile, 'utf8')), frameDir: dir, base };
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const report = argv.includes('--report');
  const gameArg = argv[argv.indexOf('--game') + 1];

  const vrf = findVrf(TAG);
  const gameDir = findGameDir(TAG, argv.includes('--game') ? gameArg : undefined);
  const pak = path.join(gameDir, 'pak01_dir.vpk');
  if (!fs.existsSync(pak)) fail(`no pak01_dir.vpk in ${gameDir}`);
  assertLocalOutput(TAG, PACK_DIR);

  await fsp.mkdir(PACK_DIR, { recursive: true });

  const manifest = { version: FX_VERSION, sheets: {}, ramps: {}, source: 'csgo/pak01_dir.vpk' };

  for (const entry of SHEETS) {
    const { sheet, frameDir, base } = await extract(vrf, pak, entry, force);
    if (report) {
      console.log(
        `${entry.key.padEnd(9)} ${sheet.width}x${sheet.height} ` +
          `${String(sheet.frames.length).padStart(3)} frames, ${sheet.sequences.length} seq, ` +
          `canvas ${sheet.canvas[0]}px  (${entry.what})`
      );
      continue;
    }
    const atlas = await buildAtlas(sheet, frameDir, base, entry);
    const file = `${entry.key}.webp`;
    await fsp.writeFile(path.join(PACK_DIR, file), atlas.buffer);
    manifest.sheets[entry.key] = {
      file,
      from: entry.tex,
      width: atlas.width,
      height: atlas.height,
      cols: atlas.cols,
      rows: atlas.rows,
      cell: atlas.cell,
      channels: atlas.channels,
      frames: sheet.frames.length,
      sequences: sheet.sequences.map((s) => ({ start: s.start, count: s.count, clamp: s.clamp }))
    };
    console.log(
      `  ${entry.key.padEnd(9)} ${atlas.width}x${atlas.height} ` +
        `${sheet.frames.length} frames in ${atlas.cols}x${atlas.rows} cells of ${atlas.cell}px ` +
        `(${(atlas.buffer.length / 1024).toFixed(0)} KB)`
    );
  }

  for (const [kind, files] of Object.entries(RAMPS)) {
    manifest.ramps[kind] = {};
    for (const [which, rel] of Object.entries(files)) {
      const dump = await runVrf(vrf, ['-i', pak, '-f', `${rel}_c`, '-b', 'DATA'], `${kind} ${which}`, { capture: true });
      const stops = readRamp(dump);
      if (!stops) fail(`no colour gradient in ${rel}`);
      manifest.ramps[kind][which] = stops;
      if (report) {
        console.log(`${kind.padEnd(10)} ${which} ramp: ${stops.length} stops, second colour ${JSON.stringify(stops[1]?.rgb)}`);
      }
    }
  }

  if (report) return;

  await fsp.writeFile(path.join(PACK_DIR, 'fx.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`cs3d-fx: wrote ${Object.keys(manifest.sheets).length} sheets + fx.json to ${path.relative(ROOT, PACK_DIR)}`);
}

main().catch((err) => fail(err?.stack || String(err)));
