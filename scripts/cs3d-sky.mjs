#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-sky.mjs
// Step 3 of the 3D map pipeline: each map's real skybox, straight out of the
// game, into its pack as an HDR cube.
//
// The map's `env_sky` entity names a skybox material (cs3d-pack writes it to
// the manifest as `skyMaterial`, e.g. materials/skybox/sky_de_nuke.vmat).
// The matching texture sits in pak01 as <name>_exr_<hash>.vtex_c: a BC6H HDR
// cubemap. Source2Viewer-CLI throws decoding cube textures, so this drives
// tools/cs3d-tex (a small program over the VRF library) instead, and writes
// six Radiance .hdr faces plus a `sky` block in the manifest.
//
// HDR and not PNG on purpose: the browser tonemaps once on the way to the
// screen, so the sky has to reach it in linear light. A pre-tonemapped sky
// gets flattened twice and comes out grey.
//
// Usage:
//   node scripts/cs3d-sky.mjs [--map inferno] [--force] [--size 512]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CS3D_MAPS, cs3dMap } from '../shared/cs3d/maps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack');
const TOOL_DIR = path.join(ROOT, 'tools', 'cs3d-tex');
const TOOL_EXE = path.join(TOOL_DIR, 'bin', 'Release', 'net9.0', 'cs3d-tex.exe');


const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : d;
};
const force = flag('--force');
const only = opt('--map', '');
const size = opt('--size', '512');

function fail(msg) {
  console.error(`cs3d-sky: ${msg}`);
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || out.trim() || `exit ${code}`))));
  });
}

/** Same Steam-library scan as cs3d-import. */
function findGameDir() {
  const explicit = opt('--game', '') || process.env.CS2_GAME_DIR;
  if (explicit) return explicit;
  const libs = new Set();
  for (const steam of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(steam);
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const lib of libs) {
    const g = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    if (fs.existsSync(path.join(g, 'pak01_dir.vpk'))) return g;
  }
  fail('CS2 install not found. Pass --game "<...>\\game\\csgo".');
}

async function ensureTool() {
  if (fs.existsSync(TOOL_EXE)) return;
  console.log('  building tools/cs3d-tex (first run)...');
  await run('dotnet', ['build', '-c', 'Release', '-v', 'quiet'], { cwd: TOOL_DIR }).catch((e) => {
    fail(`could not build tools/cs3d-tex: ${e.message}\nNeeds the .NET SDK (dotnet --version).`);
  });
  if (!fs.existsSync(TOOL_EXE)) fail(`build produced no ${TOOL_EXE}`);
}

/**
 * The sky texture for a skybox material. Valve names it after the material
 * with an `_exr_<hash>` (or `_pfm_`/`_tga_`) suffix, so match on the stem and
 * take the largest candidate — for materials with `_lighting`/`_fog` variants
 * the plain one is the actual sky.
 */
function findSkyTexture(listing, vmatPath) {
  let stem = path.basename(String(vmatPath)).replace(/\.vmat$/i, '');
  const dir = path.dirname(String(vmatPath));
  // Some maps' env_sky points at the `_lighting` (or `_fog`) variant, which is
  // the tiny probe texture used for ambient, not the sky you can see. Ancient
  // does this: 216 KB at 256px instead of the real 22 MB sky. Prefer the base
  // material's texture when one exists.
  const base = stem.replace(/_(lighting|fog)$/i, '');
  if (base !== stem && listing.some((f) => new RegExp(`^${dir}/${base}_[a-z]+_[0-9a-f]+\\.vtex_c$`, 'i').test(f))) {
    stem = base;
  }
  const re = new RegExp(`^${dir}/${stem}_(exr|pfm|tga|psd|png)_[0-9a-f]+\\.vtex_c$`, 'i');
  const exact = listing.filter((f) => re.test(f));
  if (exact.length) return exact.sort((a, b) => b.length - a.length)[0];
  // Some maps point at a material whose texture is named for a shared sky.
  const loose = listing.filter((f) => f.startsWith(`${dir}/${stem}`) && /\.vtex_c$/.test(f));
  return loose.sort((a, b) => a.length - b.length)[0] || null;
}

/**
 * Textures under one vpk directory. Most maps point at materials/skybox/, but
 * a few (Cache) keep their sky beside the map's own materials, so this is
 * called per skybox-material directory rather than once for a fixed path.
 */
async function listTextures(vrfCli, pak, dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  const out = await run(vrfCli, ['-i', pak, '-f', `${dir}/`, '-l']).catch(() => '');
  const files = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+\.vtex_c)\s/);
    if (m) files.push(m[1].replace(/\\/g, '/'));
  }
  cache.set(dir, files);
  return files;
}

async function main() {
  await ensureTool();
  const gameDir = findGameDir();
  const pak = path.join(gameDir, 'pak01_dir.vpk');
  if (!fs.existsSync(pak)) fail(`no pak01_dir.vpk under ${gameDir}`);
  const vrfCli = process.env.CS3D_VRF || path.join(ROOT, 'tools', 'vrf', 'Source2Viewer-CLI.exe');
  if (!fs.existsSync(vrfCli)) fail(`VRF CLI not found at ${vrfCli}`);

  const wanted = only ? cs3dMap(only) : null;
  if (only && !wanted) fail(`unknown map "${only}"`);
  const list = (wanted ? [wanted] : CS3D_MAPS).filter((m) => fs.existsSync(path.join(PACK_DIR, m.slug, 'manifest.json')));
  if (!list.length) fail('no packed maps found; run cs3d-pack.mjs first');

  const listCache = new Map();
  let ok = 0;
  for (const entry of list) {
    const packDir = path.join(PACK_DIR, entry.slug);
    const manifestFile = path.join(packDir, 'manifest.json');
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (!force && manifest.sky?.equirect) {
      console.log(`  ${entry.slug}: sky present, skipping`);
      ok++;
      continue;
    }
    let vmat = manifest.skyMaterial;
    if (!vmat) {
      console.warn(`  ! ${entry.slug}: no env_sky in the entity lump; keeping the procedural sky`);
      continue;
    }
    /**
     * `env_sky` naming a `_lighting` material: take the render sibling instead.
     *
     * Ancient points at `sky_hr_aztec_02_lighting.vmat`, whose texture is a
     * 256² irradiance cube — no cloud detail and a hard white rectangle where
     * the sun is. Shipped as the visible sky it gives a clear blue sky with a
     * blown-out blob overhead instead of the map's overcast weather. The real
     * one, `sky_hr_aztec_02.vmat`, sits beside it and names a different texture
     * at a different exposure bias.
     *
     * Both are legitimate: the map lights from one and draws the other. We use
     * the sky for both jobs, and of the two the render version is the one worth
     * having — it carries the detail, and its irradiance is close enough once
     * loadSkybox measures and calibrates it.
     */
    if (/_lighting\.vmat$/i.test(vmat)) {
      const render = vmat.replace(/_lighting\.vmat$/i, '.vmat');
      // Existence is the test: a dump that comes back with a sky texture means
      // the sibling is really there.
      const ok = await run(vrfCli, ['-i', pak, '-f', render.replace(/\.vmat$/i, '.vmat_c'), '-b', 'DATA'])
        .then((d) => /g_tSkyTexture/.test(d))
        .catch(() => false);
      if (ok) {
        console.log(`  ${entry.slug}: env_sky names a _lighting material; using ${path.basename(render)} for the visible sky`);
        vmat = render;
      }
    }
    // The material's own brightness and, more importantly, the texture it
    // actually names.
    //
    // `g_tSkyTexture` is the authority. Guessing the texture from the
    // material's filename works only while the two share a stem, and Inferno's
    // does not: `materials/skybox/test/s2_de_inferno_sky01.vmat` points at
    // `materials/de_inferno/skybox/inferno_sky_01_exr_*.vtex`, a different
    // name in a different directory. The stem match found an unrelated texture
    // sitting beside the material in skybox/test/ and shipped that instead —
    // which is why Inferno's sky was a dim teal gradient with no clouds while
    // every other map, whose names happen to line up, looked right.
    let exposureBias = 0;
    let named = null;
    try {
      const dump = await run(vrfCli, ['-i', pak, '-f', String(vmat).replace(/\.vmat$/i, '.vmat_c'), '-b', 'DATA']);
      const m = dump.match(/g_flBrightnessExposureBias"\s*\n\s*m_flValue\s*=\s*(-?[\d.]+)/);
      if (m) exposureBias = Number(m[1]) || 0;
      const t = dump.match(/g_tSkyTexture"\s*\n\s*m_pValue\s*=\s*resource:"([^"]+)"/);
      if (t) named = t[1].replace(/\.vtex$/i, '.vtex_c');
    } catch {
      /* fall back to the stem match below */
    }
    let vtex = null;
    if (named) {
      // Named textures carry a content hash VRF keeps, so the path is exact.
      const listing = await listTextures(vrfCli, pak, path.dirname(named).replace(/\\/g, '/'), listCache);
      vtex = listing.find((f) => f.toLowerCase() === named.toLowerCase()) || null;
      if (!vtex) console.warn(`  ! ${entry.slug}: ${named} not in the pak; falling back to the name match`);
    }
    if (!vtex) {
      const listing = await listTextures(vrfCli, pak, path.dirname(String(vmat)).replace(/\\/g, '/'), listCache);
      vtex = findSkyTexture(listing, vmat);
    }
    if (!vtex) {
      console.warn(`  ! ${entry.slug}: no texture matching ${vmat}`);
      continue;
    }
    const outDir = path.join(packDir, 'sky');
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    try {
      const res = await run(TOOL_EXE, ['cube', pak, vtex, outDir, 'sky', size]);
      const file = path.join(outDir, 'sky.hdr');
      if (!fs.existsSync(file)) throw new Error('no sky.hdr written');
      const bytes = fs.statSync(file).size;
      // Equirect, already in scene space (see tools/cs3d-tex): three loads it
      // with EquirectangularReflectionMapping and needs no rotation.
      manifest.sky = { equirect: 'sky/sky.hdr', format: 'hdr', bytes, exposureBias };
      // The manifest is the cache key for every other pack file, so bump it.
      manifest.generated = new Date().toISOString();
      await fsp.writeFile(manifestFile, JSON.stringify(manifest));
      console.log(`  ${entry.slug}: ${res} (${(bytes / 1e6).toFixed(1)} MB) from ${path.basename(vtex)}${exposureBias ? `, exposure bias ${exposureBias}` : ''}`);
      ok++;
    } catch (e) {
      console.warn(`  ! ${entry.slug}: ${e.message}`);
    }
  }
  console.log(`cs3d-sky: ${ok}/${list.length} map(s) have a real sky`);
}

main().catch((e) => fail(e.stack || e.message));
