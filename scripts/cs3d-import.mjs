#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-import.mjs
// Step 1 of the 3D map pipeline: pull the raw exports out of the game's map
// .vpk files with the ValveResourceFormat CLI (Source2Viewer-CLI). Writes
// server/data/cs3d/raw/maps/<slug>/ (gitignored, local only):
//
//   world/world.glb + *.png     render geometry, materials, textures
//   world/world_physics.glb     entity physics (props, brush entities, triggers)
//   phys/world_physics_physics.glb   the static world collision mesh
//   ents/default_ents.vents     entity lump as text (spawns, sun, bomb sites)
//   world.kv3                   the world resource's DATA block (lightmap uv
//                               scale, lightmap list, baked shadow channels)
//   lightmaps/direct_light_shadows.png
//                               baked sun/light shadow masks, one per channel,
//                               8-bit linear PNG via tools/cs3d-tex mask2d
//   lightmaps/irradiance.png    baked indirect light, 16-bit linear PNG via
//                               tools/cs3d-tex (the CLI would tonemap it)
//   sky/world/world.glb + ...   the 3D skybox: the separate prefab map the
//   sky/ents/...                skybox_reference entity points at, from
//                               game/csgo/maps/prefabs/<map>/<name>.vpk
//
// The .vpk drop in cs3d/maps/ is the roster: every de_<name>.vpk there is a
// map to import. The exports themselves run against the SAME file inside the
// CS2 install, because a map .vpk only carries geometry and lightmaps; every
// material and texture it references lives in the game's pak01, and VRF only
// finds pak01 when the input sits inside the game folder. The drop is verified
// byte-for-byte in size against the install copy so nothing silently drifts.
//
// Step 2 (scripts/cs3d-pack.mjs) turns the raw exports into the web pack.
//
// Usage:
//   node scripts/cs3d-import.mjs                 # every map in cs3d/maps
//   node scripts/cs3d-import.mjs --map mirage    # one map (slug, de_name or code)
//   node scripts/cs3d-import.mjs --force         # re-export even if present
//   node scripts/cs3d-import.mjs --game "C:\...\Counter-Strike Global Offensive\game\csgo"
//   CS3D_VRF=path\to\Source2Viewer-CLI.exe       # override the CLI location
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CS3D_MAPS, cs3dMap } from '../shared/cs3d/maps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DROP_DIR = path.join(ROOT, 'cs3d', 'maps');
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'maps');
const DEFAULT_VRF = path.join(ROOT, 'tools', 'vrf', 'Source2Viewer-CLI.exe');
const TEX_TOOL_DIR = path.join(ROOT, 'tools', 'cs3d-tex');
const TEX_TOOL = path.join(TEX_TOOL_DIR, 'bin', 'Release', 'net9.0', 'cs3d-tex.exe');
/** Lightmap atlas size shipped to the browser (the game's is 8192²; 4096² is 2×2 averaged). */
const LIGHTMAP_SIZE = 4096;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const force = flag('--force');
const only = opt('--map');
const threads = Number(opt('--threads') || 8);

function fail(msg) {
  console.error(`cs3d-import: ${msg}`);
  process.exit(1);
}

/** Refuse to write anywhere but the gitignored raw dir (CS3D-PLAN §0). */
function assertLocalOutput(dir) {
  const rel = path.relative(path.join(ROOT, 'server', 'data'), dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`refusing output outside server/data: ${dir}`);
}

function findVrf() {
  const cand = process.env.CS3D_VRF || DEFAULT_VRF;
  if (!fs.existsSync(cand)) {
    fail(
      `VRF CLI not found at ${cand}. Download cli-windows-x64.zip from ` +
        'https://github.com/ValveResourceFormat/ValveResourceFormat/releases and unzip into tools/vrf/.'
    );
  }
  return cand;
}

/** The CS2 game/csgo folder: --game, CS2_GAME_DIR, else scan Steam libraries. */
function findGameDir() {
  const explicit = opt('--game') || process.env.CS2_GAME_DIR;
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, 'pak01_dir.vpk'))) fail(`no pak01_dir.vpk under ${explicit}`);
    return explicit;
  }
  const libs = new Set();
  for (const steam of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    path.join(process.env.ProgramFiles || '', 'Steam')
  ]) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(steam);
    const txt = fs.readFileSync(vdf, 'utf8');
    for (const m of txt.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const lib of libs) {
    const g = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo');
    if (fs.existsSync(path.join(g, 'pak01_dir.vpk'))) return g;
  }
  fail('CS2 install not found. Pass --game "<...>\\Counter-Strike Global Offensive\\game\\csgo".');
}

/**
 * Run the CLI, streaming a filtered log (VRF is chatty; shader-version noise
 * is dropped). With `capture` the full stdout is returned instead of logged,
 * for the block dumps (-b DATA) that print KV3 to the console.
 */
function runVrf(vrf, cliArgs, label, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(vrf, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let written = 0;
    let lastErr = '';
    const captured = [];
    const onLine = (line) => {
      if (capture) captured.push(line);
      if (!line) return;
      if (/^--- (Writing model|Dump written)/.test(line)) written++;
      // The CS2 shader format moved past what this VRF build parses; textures
      // still resolve through its fallbacks, so this is noise, not a failure.
      if (/VCS file versions|UnexpectedMagicException|^\s+at Valve|Failed to get texture inputs/.test(line)) return;
      if (/^(Failed|Unhandled|Exception)/.test(line)) lastErr = line;
    };
    let buf = '';
    const feed = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      onLine(buf);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) return reject(new Error(`${label}: VRF exited ${code} ${lastErr}`));
      if (!capture) console.log(`  ${label}: ${written} file(s) written in ${secs}s`);
      resolve(captured.join('\n'));
    });
  });
}

/** Plain child process → stdout, for tools/cs3d-tex. */
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

async function ensureTexTool() {
  if (fs.existsSync(TEX_TOOL)) return true;
  console.log('  building tools/cs3d-tex (first run)...');
  try {
    await run('dotnet', ['build', '-c', 'Release', '-v', 'quiet'], { cwd: TEX_TOOL_DIR });
  } catch (e) {
    console.warn(`  ! could not build tools/cs3d-tex (${e.message}); lightmaps will be skipped`);
    return false;
  }
  return fs.existsSync(TEX_TOOL);
}

/** Entity lump text → [{classname, ...}] with the few value shapes we read here. */
function parseEntsLite(text) {
  const ents = [];
  for (const block of text.split(/^====\d+====\s*$/m)) {
    const e = {};
    for (const raw of block.split('\n')) {
      const m = raw.replace(/\r$/, '').match(/^(\S+)\s+(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^resource_name:/.test(v)) v = v.replace(/^resource_name:/, '');
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      e[m[1]] = v;
    }
    if (e.classname) ents.push(e);
  }
  return ents;
}

/**
 * The 3D skybox is its own map: `skybox_reference.targetmapname` names a
 * prefab .vmap, compiled next to the game as maps/prefabs/<map>/<name>.vpk.
 * Export its world + entities under raw/<slug>/sky/ with the same shape as
 * the main map so cs3d-pack can run the same code over both.
 */
async function importSkybox(vrf, gameDir, entry, out, entsTxt) {
  const ents = parseEntsLite(await fsp.readFile(entsTxt, 'utf8'));
  const ref = ents.find((e) => e.classname === 'skybox_reference' && e.targetmapname);
  if (!ref) {
    console.log(`  ${entry.slug} sky: no skybox_reference entity; map has no 3D skybox`);
    return false;
  }
  const target = String(ref.targetmapname).replace(/\\/g, '/').replace(/\.vmap$/i, '');
  const skyVpk = path.join(gameDir, `${target}.vpk`);
  if (!fs.existsSync(skyVpk)) {
    console.warn(`  ! ${entry.slug} sky: ${target}.vpk not in the install; skipping the 3D skybox`);
    return false;
  }
  const skyOut = path.join(out, 'sky');
  const prefix = `${target}/`;
  await runVrf(
    vrf,
    ['-i', skyVpk, '-f', `${prefix}world.vwrld_c`, '-d', '-o', path.join(skyOut, 'world'), '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_export_extras', '--threads', String(threads)],
    `${entry.slug} sky world`
  );
  await runVrf(
    vrf,
    ['-i', skyVpk, '-f', `${prefix}entities/`, '-e', 'vents_c', '-d', '-o', path.join(skyOut, 'ents')],
    `${entry.slug} sky ents`
  );
  // Where the pack finds them, plus the reference entity's own placement.
  await fsp.writeFile(
    path.join(skyOut, 'sky.json'),
    JSON.stringify({ target, vpk: skyVpk, referenceOrigin: ref.origin || '0 0 0', worldGroup: ref.worldgroupid || null })
  );
  return true;
}

/**
 * The map's baked light probes: `env_(combined_)light_probe_volume` entities
 * plus the atlas they all index into.
 *
 * This is how CS2 lights props. Each volume is a grid of probes over a world
 * box, and every entity carries everything needed to find its own block —
 * `light_probe_atlas_x/y/z`, `light_probe_size_x/y/z`, its box, origin, yaw
 * and voxel size. The atlas is one BC6H volume texture: Nuke's is
 * 200 x 188 x 648, and 648 = 6 x 108, six stacked planes holding an ambient
 * cube (+X, -X, +Y, -Y, +Z, -Z).
 *
 * Written to raw/ and never shipped: cs3d-pack samples it per vertex and bakes
 * the result into the geometry, so the browser gets the lighting without the
 * 12 MB atlas or any runtime probe lookup.
 */
async function importProbes(vrf, entry, out, entsTxt, gameVpk) {
  const text = (await fsp.readFile(entsTxt, 'utf8')).replace(/\r/g, '');
  const vols = [];
  let atlasRes = null;
  for (const blk of text.split(/^====\d+====\s*$/m)) {
    if (!/light_probe_volume/.test(blk)) continue;
    const num = (k) => {
      const m = new RegExp('^\\s*' + k + '\\s+"?(-?[\\d.]+)"?', 'm').exec(blk);
      return m ? Number(m[1]) : null;
    };
    const vec = (k) => {
      const m = new RegExp('^\\s*' + k + '\\s+\\[\\s*(-?[\\d.]+),\\s*(-?[\\d.]+),\\s*(-?[\\d.]+)', 'm').exec(blk);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const tex = /^\s*lightprobetexture\s+resource_name:"([^"]+)"/m.exec(blk);
    if (tex && !atlasRes) atlasRes = tex[1];
    const v = {
      size: [num('light_probe_size_x'), num('light_probe_size_y'), num('light_probe_size_z')],
      atlas: [num('light_probe_atlas_x'), num('light_probe_atlas_y'), num('light_probe_atlas_z')],
      mins: vec('box_mins'),
      maxs: vec('box_maxs'),
      origin: vec('origin') || [0, 0, 0],
      angles: vec('angles') || [0, 0, 0],
      voxel: num('voxel_size'),
      indoor: num('indoor_outdoor_level')
    };
    if (v.size[0] !== null && v.atlas[0] !== null && v.mins && v.maxs) vols.push(v);
  }
  if (!vols.length || !atlasRes) {
    console.log(`  ${entry.slug} probes: no light probe volumes`);
    return false;
  }
  const dir = path.join(out, 'probes');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'volumes.json'), JSON.stringify({ atlas: atlasRes, volumes: vols }, null, 1));
  const res = `${atlasRes.replace(/\\/g, '/').replace(/\.vtex$/i, '')}.vtex_c`;
  const outText = await run(TEX_TOOL, ['vol3d', gameVpk, res, dir, 'probes']);
  console.log(`  ${entry.slug} probes: ${vols.length} volumes, ${outText}`);
  return true;
}

/** A named float out of a .vpost's KV3 dump. */
const vpostNum = (txt, key, dflt = 0) => {
  const m = new RegExp(`${key}\\s*=\\s*(-?[\\d.eE+]+)`).exec(txt);
  return m ? Number(m[1]) : dflt;
};

/**
 * The map's colour grading: `post_processing_volume.postprocessing` → a .vpost
 * in pak01 → `post/post.json` (tonemap + bloom) and `post/lut.bin` (the raw
 * 32³ RGBA colour-correction volume).
 *
 * The LUT is written as raw bytes rather than an image because this script has
 * no image encoder; cs3d-pack turns it into the strip the browser loads.
 */
async function importPost(vrf, gameDir, entry, out, entsTxt) {
  const ents = parseEntsLite(await fsp.readFile(entsTxt, 'utf8'));
  const vol = ents.find((e) => e.classname === 'post_processing_volume' && e.postprocessing);
  if (!vol) {
    console.log(`  ${entry.slug} post: no post_processing_volume; the map authors no grade`);
    return false;
  }
  const res = `${String(vol.postprocessing).replace(/\\/g, '/').replace(/\.vpost$/i, '')}.vpost_c`;
  const pak = path.join(gameDir, 'pak01_dir.vpk');
  const dump = await runVrf(vrf, ['-i', pak, '-f', res, '-b', 'DATA'], `${entry.slug} post`, { capture: true });
  const start = dump.indexOf('m_bHasTonemapParams');
  if (start < 0) throw new Error(`no post-processing data in ${res}`);
  const txt = dump.slice(start);

  const post = {
    resource: res,
    // The map's own auto-exposure window, off the entity rather than the vpost.
    exposure: {
      enabled: String(vol.enableexposure) === 'true',
      min: Number(vol.minexposure ?? 1),
      max: Number(vol.maxexposure ?? 1)
    },
    tonemap: /m_bHasTonemapParams\s*=\s*true/.test(txt)
      ? {
          // Hable's filmic curve, the same parameter names Source 2 uses.
          exposureBias: vpostNum(txt, 'm_flExposureBias'),
          shoulderStrength: vpostNum(txt, 'm_flShoulderStrength'),
          linearStrength: vpostNum(txt, 'm_flLinearStrength'),
          linearAngle: vpostNum(txt, 'm_flLinearAngle'),
          toeStrength: vpostNum(txt, 'm_flToeStrength'),
          toeNum: vpostNum(txt, 'm_flToeNum'),
          toeDenom: vpostNum(txt, 'm_flToeDenom'),
          whitePoint: vpostNum(txt, 'm_flWhitePoint', 1)
        }
      : null,
    bloom: /m_bHasBloomParams\s*=\s*true/.test(txt)
      ? {
          blendMode: (/m_blendMode\s*=\s*"([^"]+)"/.exec(txt) || [])[1] || 'BLOOM_BLEND_ADD',
          strength: vpostNum(txt, 'm_flBloomStrength'),
          screenStrength: vpostNum(txt, 'm_flScreenBloomStrength'),
          blurStrength: vpostNum(txt, 'm_flBlurBloomStrength'),
          threshold: vpostNum(txt, 'm_flBloomThreshold', 1),
          thresholdWidth: vpostNum(txt, 'm_flBloomThresholdWidth'),
          skyboxStrength: vpostNum(txt, 'm_flSkyboxBloomStrength'),
          computeStrength: vpostNum(txt, 'm_flComputeBloomStrength'),
          computeThreshold: vpostNum(txt, 'm_flComputeBloomThreshold', 1),
          computeRadius: vpostNum(txt, 'm_flComputeBloomRadius')
        }
      : null,
    lutDim: 0
  };

  const dim = vpostNum(txt, 'm_nColorCorrectionVolumeDim', 0);
  const hex = /m_colorCorrectionVolumeData\s*=\s*#\[([\s\S]*?)\]/.exec(txt);
  await fsp.mkdir(path.dirname(path.join(out, 'post', 'post.json')), { recursive: true });
  if (dim > 0 && hex) {
    const bytes = hex[1].trim().split(/[\s,]+/).filter(Boolean);
    const want = dim * dim * dim * 4;
    if (bytes.length !== want) throw new Error(`LUT is ${bytes.length} bytes, expected ${want} for dim ${dim}`);
    const buf = Buffer.alloc(want);
    for (let i = 0; i < want; i++) buf[i] = parseInt(bytes[i], 16);
    await fsp.writeFile(path.join(out, 'post', 'lut.bin'), buf);
    post.lutDim = dim;
  }
  await fsp.writeFile(path.join(out, 'post', 'post.json'), JSON.stringify(post, null, 1));
  console.log(
    `  ${entry.slug} post: ${post.lutDim ? `${post.lutDim}³ LUT, ` : 'no LUT, '}` +
      `${post.tonemap ? `filmic white ${post.tonemap.whitePoint}` : 'no tonemap'}${post.bloom ? ', bloom' : ''}`
  );
  return true;
}

async function importMap(vrf, gameDir, entry, dropVpk) {
  const gameVpk = path.join(gameDir, 'maps', `${entry.file}.vpk`);
  if (!fs.existsSync(gameVpk)) {
    console.warn(`  ! ${entry.file}: no ${gameVpk} in the install; VRF cannot resolve materials without it. Skipped.`);
    return false;
  }
  const dropSize = fs.statSync(dropVpk).size;
  const gameSize = fs.statSync(gameVpk).size;
  if (dropSize !== gameSize) {
    console.warn(
      `  ! ${entry.file}: drop (${dropSize} B) differs from install (${gameSize} B). ` +
        'Exporting from the install copy; refresh the drop if that is not what you meant.'
    );
  }

  const out = path.join(RAW_DIR, entry.slug);
  assertLocalOutput(out);
  const worldGlb = path.join(out, 'world', 'maps', entry.file, 'world.glb');
  const physGlb = path.join(out, 'phys', 'maps', entry.file, 'world_physics_physics.glb');
  const entsTxt = path.join(out, 'ents', 'maps', entry.file, 'entities', 'default_ents.vents');
  const worldKv3 = path.join(out, 'world.kv3');
  const lightmapPng = path.join(out, 'lightmaps', 'irradiance.png');
  const shadowPng = path.join(out, 'lightmaps', 'direct_light_shadows.png');
  const skyJson = path.join(out, 'sky', 'sky.json');
  const postJson = path.join(out, 'post', 'post.json');
  const probesJson = path.join(out, 'probes', 'volumes.json');
  await fsp.mkdir(out, { recursive: true });
  const prefix = `maps/${entry.file}/`;

  // The three big exports are skipped when present; the cheap extras below
  // (world KV3, lightmap, 3D skybox) fill in on their own when missing, so a
  // pipeline upgrade does not force a 10-minute re-export of every world.
  if (force || !(fs.existsSync(worldGlb) && fs.existsSync(physGlb) && fs.existsSync(entsTxt))) {
    // World render geometry + materials + textures (+ entity physics as a bonus).
    await runVrf(
      vrf,
      [
        '-i', gameVpk,
        '-f', `${prefix}world.vwrld_c`,
        '-d',
        '-o', path.join(out, 'world'),
        '--gltf_export_format', 'glb',
        '--gltf_export_materials',
        // NOT --gltf_textures_adapt. That flag packs ORM for us but re-encodes
        // g_tColor as RGB, destroying the alpha channel every cut-out surface
        // (foliage, fences, grates, decals) tests against — leaves come out as
        // solid black-edged cards. We keep the raw textures and pack ORM
        // ourselves in cs3d-pack.mjs, where the vmat params say which texture
        // is which (and that roughness lives in g_tNormal's alpha).
        '--gltf_export_extras',
        '--threads', String(threads)
      ],
      `${entry.slug} world`
    );
    // Static world collision (surface-property groups, clips, ladders, sky).
    await runVrf(
      vrf,
      ['-i', gameVpk, '-f', `${prefix}world_physics.vmdl_c`, '-d', '-o', path.join(out, 'phys'), '--gltf_export_format', 'glb'],
      `${entry.slug} phys`
    );
    // Entity lump → text.
    await runVrf(
      vrf,
      ['-i', gameVpk, '-f', `${prefix}entities/`, '-e', 'vents_c', '-d', '-o', path.join(out, 'ents')],
      `${entry.slug} ents`
    );
  } else {
    console.log(`  ${entry.slug}: world/phys/ents present, skipping those (use --force to redo)`);
  }
  for (const f of [worldGlb, physGlb, entsTxt]) {
    if (!fs.existsSync(f)) throw new Error(`${entry.slug}: expected ${path.relative(out, f)} was not written`);
  }

  // World resource KV3: m_worldLightingInfo.m_vLightmapUvScale is the one
  // number that turns the exported lightmap UVs into atlas coordinates, and
  // m_bakedShadows says which shadow-mask channel is the sun's.
  if (force || !fs.existsSync(worldKv3)) {
    const dump = await runVrf(vrf, ['-i', gameVpk, '-f', `${prefix}world.vwrld_c`, '-b', 'DATA'], `${entry.slug} world kv3`, { capture: true });
    const start = dump.indexOf('<!-- kv3');
    await fsp.writeFile(worldKv3, start >= 0 ? dump.slice(start) : dump);
    console.log(`  ${entry.slug} world kv3: ${fs.statSync(worldKv3).size} bytes`);
  }

  // Baked INDIRECT light, 8192² BC6H → 16-bit linear PNG. Indirect only: CS2
  // does not fold the sun into this atlas, it applies the sun analytically at
  // runtime and multiplies it by direct_light_shadows below. Treating this as
  // the finished lighting is what left the world flat and shadowless.
  if (force || !fs.existsSync(lightmapPng)) {
    if (await ensureTexTool()) {
      await fsp.mkdir(path.dirname(lightmapPng), { recursive: true });
      try {
        const res = await run(TEX_TOOL, ['hdr2d', gameVpk, `${prefix}lightmaps/irradiance.vtex_c`, path.dirname(lightmapPng), 'irradiance', String(LIGHTMAP_SIZE), '4096']);
        console.log(`  ${entry.slug} lightmap: ${res}`);
      } catch (e) {
        console.warn(`  ! ${entry.slug} lightmap: ${e.message.split('\n')[0]}`);
      }
    }
  }

  // Baked shadow masks, 8192² BC7 → 8-bit linear PNG. One mask per channel;
  // world.kv3's m_bakedShadows maps a light hash to its channel, and the pack
  // picks the sun's by which channel actually carries shadow.
  if (force || !fs.existsSync(shadowPng)) {
    if (await ensureTexTool()) {
      await fsp.mkdir(path.dirname(shadowPng), { recursive: true });
      try {
        const res = await run(TEX_TOOL, ['mask2d', gameVpk, `${prefix}lightmaps/direct_light_shadows.vtex_c`, path.dirname(shadowPng), 'direct_light_shadows', String(LIGHTMAP_SIZE)]);
        console.log(`  ${entry.slug} shadows: ${res}`);
      } catch (e) {
        console.warn(`  ! ${entry.slug} shadows: ${e.message.split('\n')[0]}`);
      }
    }
  }

  // Colour grading. The map's post_processing_volume names a .vpost that lives
  // in pak01, NOT in the map's own vpk — which is why it was never picked up
  // with the rest of the map's lighting. It holds the filmic tonemap curve, the
  // bloom parameters and a 32³ colour-correction LUT, i.e. everything between
  // the renderer's linear output and what the game actually puts on screen.
  if (force || !fs.existsSync(postJson)) {
    try {
      await importPost(vrf, gameDir, entry, out, entsTxt);
    } catch (e) {
      console.warn(`  ! ${entry.slug} post: ${e.message}`);
    }
  }

  // Baked light probes: how CS2 lights every prop.
  if (force || !fs.existsSync(probesJson)) {
    if (await ensureTexTool()) {
      try {
        await importProbes(vrf, entry, out, entsTxt, gameVpk);
      } catch (e) {
        console.warn(`  ! ${entry.slug} probes: ${e.message.split('\n')[0]}`);
      }
    }
  }

  // 3D skybox map (the miniature the map's horizon is made of).
  if (force || !fs.existsSync(skyJson)) {
    try {
      await importSkybox(vrf, gameDir, entry, out, entsTxt);
    } catch (e) {
      console.warn(`  ! ${entry.slug} sky: ${e.message}`);
    }
  }
  return true;
}

async function main() {
  const vrf = findVrf();
  const gameDir = findGameDir();
  if (!fs.existsSync(DROP_DIR)) fail(`no drop dir ${DROP_DIR}`);
  const drops = (await fsp.readdir(DROP_DIR)).filter((f) => /^de_[a-z0-9_]+\.vpk$/i.test(f));
  if (!drops.length) fail(`no de_*.vpk in ${DROP_DIR}`);

  const wanted = only ? cs3dMap(only) : null;
  if (only && !wanted) fail(`unknown map "${only}" (roster: ${CS3D_MAPS.map((m) => m.slug).join(', ')})`);

  console.log(`cs3d-import: VRF ${path.relative(ROOT, vrf)}, game ${gameDir}`);
  let ok = 0;
  let skipped = 0;
  for (const f of drops.sort()) {
    const file = f.replace(/\.vpk$/i, '').toLowerCase();
    const entry = cs3dMap(file);
    if (!entry) {
      console.warn(`  ! ${f}: not in the roster (shared/cs3d/maps.js); add it there first. Skipped.`);
      skipped++;
      continue;
    }
    if (wanted && entry.slug !== wanted.slug) continue;
    console.log(`- ${entry.slug} (${entry.file})`);
    try {
      if (await importMap(vrf, gameDir, entry, path.join(DROP_DIR, f))) ok++;
      else skipped++;
    } catch (e) {
      console.error(`  ! ${entry.slug}: ${e.message}`);
      skipped++;
    }
  }
  console.log(`cs3d-import: ${ok} map(s) exported, ${skipped} skipped. Next: node scripts/cs3d-pack.mjs`);
}

main().catch((e) => fail(e.stack || e.message));
