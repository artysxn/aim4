#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-directional.mjs
// Adds CS2's directional lightmap (scripts/lib/directionalLightmap.mjs) to
// packs that were built before cs3d-import/cs3d-pack carried it, in place,
// without re-packing the map: one export, one webp, one manifest field.
//
// The export has to come from the SAME map build the pack was made from, or
// its charts land on the wrong surfaces. Valve recompiles maps in updates
// (Ancient, Cache, Mirage and Nuke changed in the install on 2026-09-23, after
// these packs), so the default source is the snapshot in cs3d/maps/ that the
// import used, and every map is checked before it is patched: the irradiance
// atlas is exported again from that same file and compared with the one the
// pack was built from. A mismatch is refused, not patched.
//
// Usage:
//   node scripts/cs3d-directional.mjs                # every packed map
//   node scripts/cs3d-directional.mjs --map nuke     # one map
//   node scripts/cs3d-directional.mjs --force        # redo maps that have it
//   node scripts/cs3d-directional.mjs --vpk <file>   # with --map: this .vpk
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { CS3D_MAPS, cs3dMap } from '../shared/cs3d/maps.js';
import { DIRECTIONAL_FILE, DIRECTIONAL_PNG, packDirectional } from './lib/directionalLightmap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack');
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'maps');
const DROP_DIR = path.join(ROOT, 'cs3d', 'maps');
const TEX_TOOL = path.join(ROOT, 'tools', 'cs3d-tex', 'bin', 'Release', 'net9.0', 'cs3d-tex.exe');
/** cs3d-import's export size and scale for the irradiance, so the check compares like with like. */
const LIGHTMAP_SIZE = 4096;
const IRRADIANCE_SCALE = '4096';
/** Mean |difference| in 16-bit units above which the atlases are different builds. */
const MAX_MEAN_DIFF = 2;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : d;
};

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || out.trim() || `exit ${code}`))));
  });
}

/** Mean |a − b| over a sparse sample of two same-sized 16-bit RGBA PNGs, or Infinity if the sizes differ. */
async function atlasDifference(a, b) {
  const [ra, rb] = await Promise.all(
    [a, b].map((f) => sharp(f, { limitInputPixels: false }).raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true }))
  );
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return Infinity;
  const da = new Uint16Array(ra.data.buffer, ra.data.byteOffset, ra.data.byteLength / 2);
  const db = new Uint16Array(rb.data.buffer, rb.data.byteOffset, rb.data.byteLength / 2);
  const ca = ra.info.channels;
  const cb = rb.info.channels;
  let sum = 0;
  let n = 0;
  for (let p = 0; p < ra.info.width * ra.info.height; p += 97) {
    for (let c = 0; c < 3; c++) sum += Math.abs(da[p * ca + c] - db[p * cb + c]);
    n += 3;
  }
  return sum / n;
}

async function patchMap(entry) {
  const packDir = path.join(PACK_DIR, entry.slug);
  const manifestFile = path.join(packDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
  if (!manifest.lightmap?.file) {
    console.log(`  ${entry.slug}: no lightmap in this pack, nothing to do`);
    return true;
  }
  if (manifest.directional?.file && !flag('--force')) {
    console.log(`  ${entry.slug}: directional present, skipping (--force to redo)`);
    return true;
  }
  const vpk = opt('--vpk', '') || path.join(DROP_DIR, `${entry.file}.vpk`);
  if (!fs.existsSync(vpk)) {
    console.warn(`  ! ${entry.slug}: no ${vpk}; pass --vpk with the build this pack came from`);
    return false;
  }
  const rawLm = path.join(RAW_DIR, entry.slug, 'lightmaps');
  const rawIrr = path.join(rawLm, 'irradiance.png');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), `cs3d-dir-${entry.slug}-`));
  try {
    const prefix = `maps/${entry.file}/lightmaps/`;
    // Same build? The irradiance this vpk holds must be the one the pack has.
    if (fs.existsSync(rawIrr)) {
      await run(TEX_TOOL, ['hdr2d', vpk, `${prefix}irradiance.vtex_c`, tmp, 'irradiance', String(LIGHTMAP_SIZE), IRRADIANCE_SCALE]);
      const diff = await atlasDifference(rawIrr, path.join(tmp, 'irradiance.png'));
      if (!(diff <= MAX_MEAN_DIFF)) {
        console.warn(`  ! ${entry.slug}: ${path.basename(vpk)} is a different build from the pack (irradiance differs by ${diff.toFixed(1)}); not patched`);
        return false;
      }
      console.log(`  ${entry.slug}: ${path.basename(vpk)} matches the packed irradiance (mean diff ${diff.toFixed(2)})`);
    } else {
      console.warn(`  ${entry.slug}: no raw irradiance.png to check against; trusting ${path.basename(vpk)}`);
    }
    const res = await run(TEX_TOOL, ['mask2d', vpk, `${prefix}directional_irradiance.vtex_c`, tmp, 'directional_irradiance', String(LIGHTMAP_SIZE)]);
    const png = path.join(tmp, 'directional_irradiance.png');
    // Kept with the raw imports, where cs3d-pack looks for it on a re-pack.
    await fsp.mkdir(rawLm, { recursive: true });
    await fsp.copyFile(png, path.join(rawLm, DIRECTIONAL_PNG));
    const dl = await packDirectional(png, path.join(packDir, DIRECTIONAL_FILE), manifest.lightmap.size || LIGHTMAP_SIZE);
    // Re-read: another step may have written the manifest while this ran.
    const fresh = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    fresh.directional = { file: DIRECTIONAL_FILE, ...dl };
    // `generated` stays: every other pack file is unchanged and keeps its
    // cache, and the new file has a name of its own.
    await fsp.writeFile(manifestFile, JSON.stringify(fresh));
    console.log(`  ${entry.slug}: ${res}; ${DIRECTIONAL_FILE} ${(dl.bytes / 1e6).toFixed(1)} MB, mean ${dl.mean}`);
    return true;
  } catch (e) {
    console.warn(`  ! ${entry.slug}: ${e.message.split('\n')[0]}`);
    return false;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

const only = opt('--map', '');
const wanted = only ? cs3dMap(only) : null;
if (only && !wanted) {
  console.error(`cs3d-directional: unknown map "${only}"`);
  process.exit(1);
}
if (!fs.existsSync(TEX_TOOL)) {
  console.error(`cs3d-directional: ${TEX_TOOL} missing; build it with "dotnet build -c Release" in tools/cs3d-tex`);
  process.exit(1);
}
const list = (wanted ? [wanted] : CS3D_MAPS).filter((m) => fs.existsSync(path.join(PACK_DIR, m.slug, 'manifest.json')));
let ok = 0;
for (const entry of list) if (await patchMap(entry)) ok++;
console.log(`cs3d-directional: ${ok}/${list.length} map(s) done`);
process.exit(ok === list.length ? 0 : 1);
