#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-pack.mjs
// Step 2 of the 3D map pipeline: turn the raw VRF exports (cs3d-import.mjs)
// into the pack the browser streams. Reads server/data/cs3d/raw/maps/<slug>/,
// writes server/data/cs3d/pack/<slug>/:
//
//   manifest.json   materials, geometry groups (load order + bounds), spawns,
//                   bomb sites, buy zones, sun, exposure, map bounds, the
//                   texture bundle directory, the 3D skybox placement, stats
//   phys.glb        collision mesh, one node per collision kind (solid,
//                   playerclip, ladder, grenadeclip, sky, entity)
//   geo/gNN.glb     render geometry, meshopt-compressed, one mesh per
//                   material tile, grouped biggest-first so the world fills in
//                   large surfaces → details; materials carry names only
//   sky3d/gNN.glb   the 3D skybox's geometry, same shape, drawn ×16
//   tex.bin         every texture, webp, back to back; the manifest holds
//                   the offsets. One request instead of a thousand.
//   lightmap.webp   baked irradiance atlas, RGBM-encoded (HDR in 8 bits)
//   sky/sky.hdr     the map's skybox (scripts/cs3d-sky.mjs writes this)
//
// Why this shape: VRF hands back one draw call per Source draw call, each
// referencing the whole vertex buffer (a 100 MB Mirage), so the pack compacts
// and welds vertices, bakes every node transform, and joins everything that
// shares a material, then cuts the result into ground-plane tiles that the
// loader turns into one BatchedMesh per material: one pipeline per material,
// one culled draw per tile. Textures live outside the geometry so a chunk
// arriving does not re-download the brick texture, and each material's
// average colour ships in the manifest so the world is coloured before a
// single texture lands.
//
// The scene frame is Source units, y-up: three (x, y, z) = source (x, z, -y).
// See shared/sim3d/units.js. VRF exports metres, glTF y-up with x=source y,
// z=source x; the pack undoes that so nothing downstream does axis math.
//
// Usage:
//   node --max-old-space-size=8192 scripts/cs3d-pack.mjs [--map mirage] [--force]
//       [--tex 1024] [--normal 512] [--orm 512] [--lightmap 4096] [--no-normal] [--no-orm]
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import {
  compactPrimitive,
  copyToDocument,
  flatten,
  getBounds,
  join,
  meshopt,
  prune,
  transformMesh,
  weld
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

import { CS3D_MAPS, cs3dMap } from '../shared/cs3d/maps.js';
import { encodeRgbe, RGBE_BYTES } from '../shared/cs3d/rgbe.js';
import { VRF_TO_SCENE_MAT4 } from '../shared/sim3d/units.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'maps');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack');

/** Bump when the pack layout changes; the loader refuses older packs. */
export const PACK_VERSION = 2;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || '') : dflt;
};
const force = flag('--force');
const only = opt('--map', '');
const TEX_BASE = Number(opt('--tex', 1024));
// 384, not 512: normal maps are encoded near-lossless (see TextureBundle.normal
// — lossy webp's chroma subsampling destroys them), which costs about 3x the
// bytes at a given size. Normals are low-frequency next to an albedo, so
// spending that budget on resolution buys much less than spending it on
// getting the channels right; 384 near-lossless is ~40% over 512 lossy rather
// than ~180% over it, and looks better.
const TEX_NORMAL = Number(opt('--normal', 384));
const TEX_ORM = Number(opt('--orm', 512));
const TEX_LIGHTMAP = Number(opt('--lightmap', 4096));
/**
 * Probe-grid cell, units (see bakeProbeGrid).
 *
 * 192, not the 128 CS2 authors its own voxels at, because this term is a
 * low-frequency ambient read through trilinear interpolation: what it has to
 * get right is "am I under this roof", and a doorway transition spread over
 * about a second of walking is what the eye expects anyway. 128 costs 3.4x the
 * bytes for a difference you cannot see on a body 32 units wide — Nuke's grid
 * is 0.9 MB here and was 5.2 MB there.
 */
const PROBE_GRID_CELL = Number(opt('--probe-cell', 192));
const WANT_NORMAL = !flag('--no-normal');
const WANT_ORM = !flag('--no-orm');
/** Target bytes of (uncompressed) vertex data per geometry group. */
const GROUP_TARGET_BYTES = 2_500_000;
/** Ground-plane tile size (units) for splitting map-wide materials so they cull. */
const CELL_SIZE = Number(opt('--cell', 1024));
/** Source's 3D skybox scale when the sky_camera does not say otherwise. */
const SKY_SCALE_DEFAULT = 16;
/**
 * Where geometry with no lightmap chart is pointed. Nothing lightmapped ends up
 * here any more — `splitByLightmapChart` moves chartless prims onto their own
 * probe-lit material, which never samples the atlas — so this is only the 3D
 * skybox's placeholder and a backstop.
 *
 * It is NOT a reserved spot. The atlas covers the whole texture (see
 * packLightmap); m_vLightmapUvScale = 8/7 scales the mesh's UVs up to it, it
 * does not mean 1/8 of the page is spare.
 */
const LM_NEUTRAL_UV = [0.97, 0.97];
/**
 * A lightmap UV never leaves the packed 7/8 of the atlas. VRF exports material
 * UV sets alongside it and some of those also sit inside [0,1], so the bound is
 * the one thing that tells them apart — and it has to be the real one: at the
 * old 0.9 a material UV reaching 0.88 passed as a chart and lit its surface
 * from a random corner of the atlas.
 */
const LM_UV_MAX = 0.876;
/** One texel of the 4096² atlas, in UV. A chart smaller than this is not one. */
const LM_TEXEL = 1 / 4096;
/** RGBM range for the lightmap: values up to this many units of radiance survive. */
const LM_RANGE = 16;
/**
 * Opacity for a `csgo_glass` pane whose vmat gives no GlassMaskTranslucency
 * (the frosted variants, which set GlassMaskTransmission instead). Low enough
 * to see through, high enough that the pane is still there. This is the one
 * glass number that is a judgement call rather than a value read off the vmat.
 */
const GLASS_OPACITY = 0.22;

function fail(msg) {
  console.error(`cs3d-pack: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Entity lump (.vents text): "====N====" blocks of "key   value" lines.
// ---------------------------------------------------------------------------

function parseEnts(text) {
  const ents = [];
  for (const block of text.split(/^====\d+====\s*$/m)) {
    const e = {};
    for (const raw of block.split('\n')) {
      const line = raw.replace(/\r$/, '');
      const m = line.match(/^(\S+)\s+(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (/^resource_name:/.test(v)) v = v.replace(/^resource_name:/, '');
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      v = v.replace(/^\[PR#\]/, '');
      if (/^\[.*\]$/.test(v)) {
        v = v
          .slice(1, -1)
          .split(',')
          .map((s) => Number(s.trim()));
      } else if (v === 'true' || v === 'false') v = v === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      // The skybox lump writes vectors as "x y z" strings.
      else if (/^-?[\d.]+ -?[\d.]+ -?[\d.]+$/.test(v)) v = v.split(' ').map(Number);
      e[m[1]] = v;
    }
    if (e.classname) ents.push(e);
  }
  return ents;
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** Source (x, y, z) → scene (x, z, -y). Kept inline here so the pack has no runtime imports. */
const srcToScene = ([x, y, z]) => [x, z, -y];

/** sRGB 0..1 → linear 0..1, rounded to something a manifest can hold. */
const srgbToLinear = (v) =>
  Math.round((v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * 10000) / 10000;

function extractMeta(ents) {
  const spawns = { T: [], CT: [] };
  for (const e of ents) {
    const side =
      e.classname === 'info_player_terrorist' ? 'T' : e.classname === 'info_player_counterterrorist' ? 'CT' : null;
    if (!side || !isVec3(e.origin)) continue;
    if (e.enabled === false) continue;
    spawns[side].push({
      pos: srcToScene(e.origin),
      yaw: isVec3(e.angles) ? e.angles[1] : 0,
      priority: Number.isFinite(e.priority) ? e.priority : 0
    });
  }
  const sunEnt = ents.find((e) => e.classname === 'light_environment');
  let sun = null;
  if (sunEnt && isVec3(sunEnt.angles)) {
    // Source angles: [pitch, yaw, roll], pitch positive = looking down.
    const pitch = (sunEnt.angles[0] * Math.PI) / 180;
    const yaw = (sunEnt.angles[1] * Math.PI) / 180;
    // Direction the light travels, in Source axes.
    const dir = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
    sun = {
      dir: srcToScene(dir),
      color: isVec3(sunEnt.color) ? sunEnt.color.map((c) => c / 255) : [1, 1, 1],
      brightness: Number.isFinite(sunEnt.brightness) ? sunEnt.brightness : 1,
      skyColor: isVec3(sunEnt.skycolor) ? sunEnt.skycolor.map((c) => c / 255) : [0.5, 0.7, 1],
      skyIntensity: Number.isFinite(sunEnt.skyintensity) ? sunEnt.skyintensity : 1,
      // How much of the sky bounces off the ground in the bake; the loader
      // uses it as a hint for the ambient floor.
      skyAmbientBounce: isVec3(sunEnt.skyambientbounce) ? sunEnt.skyambientbounce.map((c) => c / 255) : null
    };
  }
  const bounds = ents.filter((e) => e.classname === 'cs_minimap_boundary' && isVec3(e.origin));
  let radar = null;
  if (bounds.length >= 2) {
    const xs = bounds.map((e) => e.origin[0]);
    const ys = bounds.map((e) => e.origin[1]);
    radar = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  const params = ents.find((e) => e.classname === 'info_map_parameters');
  // A map can ship several env_sky entities and enable one from a script
  // (Inferno keeps a Hosek-Wilkie reference sky next to the real one). The
  // enabled one wins; when every one of them starts disabled — Anubis and
  // Ancient — the first is still the map's sky.
  const skies = ents.filter((e) => e.classname === 'env_sky');
  const sky = skies.find((e) => e.startdisabled !== true && e.startdisabled !== 1) || skies[0] || null;
  // env_sky carries a yaw, and half the roster uses one (Inferno 245°, Anubis
  // 270°, Cache 116°, Ancient 65°). Without it the sky texture's sun sits
  // somewhere other than where light_environment puts the real one.
  const skyYaw = sky && isVec3(sky.angles) ? sky.angles[1] : 0;
  // The game's auto-exposure range for this map. Absolute light levels vary
  // 3× between maps (Anubis' sun is 6.35, Nuke's 2.4) and the game's
  // tonemapper normalises them; the loader does the same with these bounds.
  const ppv =
    ents.find((e) => e.classname === 'post_processing_volume' && e.master === true && e.enableexposure) ||
    ents.find((e) => e.classname === 'post_processing_volume' && e.enableexposure);
  const exposure = ppv
    ? {
        min: Number.isFinite(ppv.minexposure) ? ppv.minexposure : 1,
        max: Number.isFinite(ppv.maxexposure) ? ppv.maxexposure : 1
      }
    : null;
  return {
    spawns,
    sun,
    radarBounds: radar,
    bombRadius: params && Number.isFinite(params.bombradius) ? params.bombradius : 500,
    skyMaterial: sky?.skyname || null,
    skyBrightness: sky && Number.isFinite(sky.brightnessscale) ? sky.brightnessscale : 1,
    skyYaw,
    fog: extractFog(ents),
    exposure,
    // Trigger volumes get their boxes from the entity physics export; the
    // lump only tells us which model is which site.
    bombTargets: ents
      .filter((e) => e.classname === 'func_bomb_target')
      .map((e) => ({ model: e.model || '', name: e.targetname || '', designation: String(e.bomb_site_designation ?? '') })),
    buyZones: ents.filter((e) => e.classname === 'func_buyzone').map((e) => ({ model: e.model || '', team: e.teamnum })),
    // Entities the map spawns disabled: the wingman/retake blockers that a
    // Pulse script (GameModeCheck) enables for those modes. VRF exports their
    // models like any other, so without this the 5v5 map ships walled off.
    disabledOrigins: ents
      .filter((e) => (e.startdisabled === true || e.startdisabled === 1) && e.model && isVec3(e.origin))
      .map((e) => e.origin)
  };
}

/**
 * The map's atmosphere, from the two fog entities every CS2 map ships. This is
 * the haze that makes distance read as distance in-game; without it the far
 * side of a bombsite is as crisp as the wall in front of you.
 *
 *   env_cubemap_fog   the main one, on all ten maps. Its colour is the SKY,
 *                     sampled in the view direction and blurred by
 *                     `cubemapfoglodbiase`, so distance washes toward whatever
 *                     part of the sky you are looking at rather than toward a
 *                     flat grey.
 *   env_gradient_fog  a flat-coloured layer over the top, on six of the ten.
 *
 * Both are distance × height products: the distance term ramps between start
 * and end raised to a falloff exponent, the height term fades the fog out
 * between two world heights. Heights come across in Source Z and are handed
 * over as scene Y, which is the same number — this is only ever a rename, but
 * it is the rename that keeps the loader free of Source axes.
 */
function extractFog(ents) {
  const on = (e) => e && e.startdisabled !== true && e.startdisabled !== 1;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const g = ents.find((e) => e.classname === 'env_gradient_fog' && on(e));
  const c = ents.find((e) => e.classname === 'env_cubemap_fog' && on(e));
  if (!g && !c) return null;
  return {
    gradient: g
      ? {
          // fogcolor is authored in sRGB bytes; the loader wants linear.
          color: isVec3(g.fogcolor) ? g.fogcolor.map((v) => srgbToLinear(v / 255)) : [0.5, 0.6, 0.7],
          start: num(g.fogstart, 0),
          end: num(g.fogend, 8000),
          falloff: num(g.fogfalloffexponent, 1),
          strength: num(g.fogstrength, 1),
          maxOpacity: num(g.fogmaxopacity, 1),
          // heightfog off = no vertical falloff at all, which is a height
          // range so tall nothing in the map reaches the top of it.
          heightStart: g.heightfog === false ? -1e5 : num(g.fogstartheight, 0),
          heightEnd: g.heightfog === false ? 1e5 : num(g.fogendheight, 10000),
          heightExponent: num(g.fogverticalexponent, 1)
        }
      : null,
    cubemap: c
      ? {
          start: num(c.cubemapfogstartdistance, 0),
          end: num(c.cubemapfogenddistance, 12000),
          falloff: num(c.cubemapfogfalloffexponent, 1),
          maxOpacity: num(c.cubemapfogmaxopacity, 1),
          heightStart: c.cubemapheightfog === false ? -1e5 : num(c.cubemapfogheightstart, 0),
          heightEnd: c.cubemapheightfog === false ? 1e5 : num(c.cubemapfogheightend, 10000),
          heightExponent: num(c.cubemapfogheightexponent, 1),
          // How blurred a copy of the sky the fog reads, 0 = sharp.
          lodBias: num(c.cubemapfoglodbiase, 0)
        }
      : null
  };
}

/** m_worldLightingInfo out of the world resource's KV3 dump (cs3d-import writes world.kv3). */
function parseWorldKv3(text) {
  const out = { lightmapUvScale: [1, 1], hasLightmaps: false, shadowChannels: [] };
  if (!text) return out;
  const wl = text.indexOf('m_worldLightingInfo');
  const block = wl >= 0 ? text.slice(wl) : text;
  const sc = block.match(/m_vLightmapUvScale\s*=\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/);
  if (sc) out.lightmapUvScale = [Number(sc[1]), Number(sc[2])];
  out.hasLightmaps = /m_bHasLightmaps\s*=\s*true/.test(block);
  for (const m of block.matchAll(/m_nLightHash\s*=\s*(\d+)[\s\S]*?m_nShadowChannel\s*=\s*(\d+)/g)) {
    out.shadowChannels.push({ lightHash: m[1], channel: Number(m[2]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const TOOLS_RE = /^materials\/tools\//i;

/**
 * The self-illumination a `csgo_complex` material declares, or null.
 *
 * F_SELF_ILLUM alone says almost nothing: a Nuke vending machine, a lit office
 * fixture and a control-room display all set it, and what separates them is
 * `g_tSelfIllumMask` (which parts glow), `g_flSelfIllumAlbedoFactor` (whether
 * the glow takes the surface's own colour or is a flat tint) and the
 * scale/brightness pair. Reading only the flag and emitting white is what made
 * the vending machine a featureless white box.
 *
 * Brightness 0 shows up on materials that clearly do glow, so it reads as
 * "unset" rather than "off"; the product is clamped because a light fixture
 * authored at 3 is meant to bloom in a renderer that has bloom, and here it
 * would just be a white hole.
 */
function selfIllumOf(vmat) {
  const ints = vmat.IntParams || {};
  if (ints.F_SELF_ILLUM !== 1) return null;
  const floats = vmat.FloatParams || {};
  const vecs = vmat.VectorParams || {};
  const tint = Array.isArray(vecs.g_vSelfIllumTint) ? vecs.g_vSelfIllumTint.slice(0, 3) : [1, 1, 1];
  const scale = Number.isFinite(floats.g_flSelfIllumScale) ? floats.g_flSelfIllumScale : 1;
  const bright = Number.isFinite(floats.g_flSelfIllumBrightness) ? floats.g_flSelfIllumBrightness : 1;
  const intensity = Math.min(4, scale * (bright > 0 ? bright : 1));
  if (!(intensity > 0)) return null;
  return {
    tint: tint.map((v) => Math.round(v * 1000) / 1000),
    intensity: Math.round(intensity * 1000) / 1000,
    // 1 = the glow is the albedo lit up, 0 = a flat tint.
    albedoFactor: Number.isFinite(floats.g_flSelfIllumAlbedoFactor) ? floats.g_flSelfIllumAlbedoFactor : 1
  };
}

/**
 * Classify a VRF material from its extras.vmat; null → do not render at all.
 *
 * Everything here reads the Source 2 material's own parameters rather than
 * the glTF material VRF derived from them. The derived one is lossy in ways
 * that matter: it reports OPAQUE for overlay decals, never marks foliage
 * two-sided, and (see cs3d-import.mjs) loses the alpha channel entirely.
 */
function classifyMaterial(mat) {
  const vmat = mat.getExtras()?.vmat || {};
  const name = String(vmat.Name || mat.getName() || '');
  const shader = String(vmat.ShaderName || '');
  const ints = vmat.IntParams || {};
  const floats = vmat.FloatParams || {};
  const vecs = vmat.VectorParams || {};
  const tex = vmat.TextureParams || {};
  if (TOOLS_RE.test(name)) return null; // blocklight, trigger, nodraw, clip, skybox brushes
  if (/blocklight|toolsnodraw|toolsclip|toolstrigger|toolsskip|toolshint|toolsinvisible/i.test(name)) return null;
  // `csgo_effects` is the atmosphere shader: an unlit card whose opacity is its
  // colour map's alpha times up to three scrolling masks, scaled by
  // g_flColorBoost and g_flOpacityScale, blended or added. The pack used to
  // drop every one of them because drawing them opaque made white slabs — but
  // that also threw away the sky's cloud layer (`nuke_clouds_003`), the sun's
  // glow disc and the chimney steam. Rendered the way the vmat asks, they
  // belong. Loose particle sheets under materials/effects/ still go: those are
  // sprites the game spawns, not placed scenery.
  //
  // Except that the path says nothing about which is which. Inferno's entire
  // cloud layer is `materials/effects/smoke/cloud_001_b.vmat` — placed scenery
  // in its 3D skybox, named like a particle — and this rule was silently
  // deleting it, which is why Inferno had a bare gradient for a sky while Nuke
  // (`nuke_clouds_003`, a path this rule happens to miss) had clouds. What
  // actually separates them is placement: geometry in the map or the skybox
  // prefab is scenery whatever it is called. So drop only the ones that are
  // NOT clouds; a cloud card that got placed is a cloud.
  if (/^materials\/effects\/(smoke|dust|light)/i.test(name) && !/cloud/i.test(name)) return null;
  // A retakes-mode wall, not scenery.
  if (/retakes_blocker/i.test(name)) return null;
  const effect = /^csgo_effects/.test(shader);
  // Water caustics: a `csgo_static_overlay` flipbook (F_TEXTURE_ANIMATION,
  // g_nNumAnimationCells 60 on an 8x8 g_vAnimationGrid) that the game plays a
  // cell at a time over the floor near water. Nothing here animates, so the
  // whole sprite sheet lands on the surface at once and reads as a tiled blue
  // blob across the room — Nuke's B site and Anubis' canals. Dropped rather
  // than approximated: a single frozen frame of caustics is not the effect.
  if (/caustics?/i.test(name)) return null;

  const overlay =
    ints.F_OVERLAY === 1 || /static_overlay/.test(shader) || /\/decals?\/|\/overlays?\//i.test(name);
  // F_BLEND_MODE (unlit/overlay shaders): 0 opaque, 1 alpha test, 2+ blended
  // (translucent, additive, ...). The 3D skyboxes' cloud domes are unlit
  // white-on-alpha cards with mode 4; drawn opaque they are a lid over the sky.
  const blendMode = Number.isFinite(ints.F_BLEND_MODE) ? ints.F_BLEND_MODE : 0;
  const alphaTest = ints.F_ALPHA_TEST === 1 || blendMode === 1;
  // Water is a whole simulation in-game (waves, refraction, caustics); here
  // it is a glossy translucent sheet in the water's own fog colour that
  // reflects the sky probe. Its g_tColor is a low-res map-space tint, not an
  // albedo, so it is skipped.
  const water = /csgo_water/.test(shader);
  /**
   * Glass. `csgo_glass` has no `g_tColor` at all — the sheet is defined by
   * parameters, not an albedo, and its textures are `g_tGlassDust`,
   * `g_tGlassTintColor` and `g_tNormal`. The pack used to resolve no base
   * texture, fall back to a white factor and then draw it as BLEND at opacity
   * 1, which is an opaque white panel: Nuke's control-room windows and door
   * lights were flat pale slabs you could not see through.
   *
   * What the vmat actually says:
   *   GlassMaskTranslucency  how much of the sheet you see — 0.02 on clean
   *                          glass, i.e. all but invisible, which is what real
   *                          window glass is once its reflection is the only
   *                          thing carrying it
   *   TextureRoughness       0.078 on the frosted variants
   *   GlassTintColor         the sheet's tint
   * A pane with no translucency parameter (the frosted ones set
   * GlassMaskTransmission instead) gets GLASS_OPACITY, which is the one number
   * here that is a judgement rather than a reading.
   */
  const glass = /csgo_glass/.test(shader);
  const glassVec = (k) => (Array.isArray(vecs[k]) ? vecs[k] : null);
  const glassOpacity = glass
    ? glassVec('GlassMaskTranslucency')
      ? Math.min(0.9, Math.max(0.03, glassVec('GlassMaskTranslucency')[0]))
      : GLASS_OPACITY
    : undefined;
  const glassRoughness = glass
    ? glassVec('TextureRoughness')
      ? Math.min(1, Math.max(0, glassVec('TextureRoughness')[0]))
      : 0.05
    : undefined;
  // An effect card is always blended — its whole substance is opacity — and it
  // never announces that through F_BLEND_MODE.
  const translucent = ints.F_TRANSLUCENT === 1 || glass || water || effect || blendMode >= 2;
  // Order matters: a cut-out surface is a MASK even when it also sets
  // F_TRANSLUCENT, and an overlay decal blends whatever its alpha says.
  const alphaMode = alphaTest ? 'MASK' : translucent || overlay ? 'BLEND' : 'OPAQUE';
  // csgo_black_unlit has no texture and no tint param: it is just black.
  const fog = Array.isArray(vecs.g_vWaterFogColor) ? vecs.g_vWaterFogColor.slice(0, 3) : [0.25, 0.4, 0.45];
  /**
   * Only tints the pack invents itself go here.
   *
   * NOT `g_vColorTint`: VRF has already folded it into the glTF material's
   * baseColorFactor (sRGB → linear, so 0.859 arrives as 0.708), and the loader
   * applies that per tile as the BatchedMesh colour. Emitting it here as well
   * multiplied the vmat's tint in a second time *and* in the wrong space —
   * `sRGB_value × linear(sRGB_value)` — so every tinted material came out too
   * dark, the harder the more it was tinted: 0.859 → 0.608 instead of 0.708,
   * but 0.294 → 0.021 instead of 0.070, which is 3.4× and reads as black.
   *
   * That is one bug wearing two faces. On a lit surface it is the "colour
   * modifier writes double" look — the parts whose vmat carries a tint go
   * near-black while the parts tinted only per-instance come out right. On a
   * metal it is worse: a metal has no diffuse at all, so its whole appearance
   * is reflection × base colour, and darkening the base colour 3× turns the
   * surface black. Nuke's tinted vmats are `metal_pipe_002/003`,
   * `hr_metal_corrugated_001`, `hr_metal_wall_001/002`, `nuke_silo_001/002` —
   * the pipes, ducts and silos, and only 12 vmats of 269, which is why it hit
   * some models and not others.
   *
   * The water fog colour, the glass tint and black_unlit's black are different:
   * the pack derives those from parameters VRF does not put in baseColorFactor,
   * so they are applied here and nowhere else.
   */
  const tint = /black_unlit/.test(shader)
    ? [0, 0, 0]
    : water
      ? fog
      : glass && Array.isArray(vecs.GlassTintColor)
        ? vecs.GlassTintColor.slice(0, 3)
        : [1, 1, 1];
  // Two-layer world shaders: layer 2 is mixed over layer 1 by the vertex
  // paint the artist laid down (Source's VertexPaintBlendParams stream, which
  // VRF exports as _TEXCOORD_4), softened by the layers' height maps.
  //
  // Not every two-layer material says so in its shader name. Dust 2's blends
  // are plain `csgo_lightmappedgeneric` with `F_LAYERS = 1`, and they name
  // layer 1 `g_tColor` rather than `g_tColor1` — so the old test, which
  // required a layer-1-suffixed slot *and* a layer-2 one, matched nothing at
  // all on the map and every blended road, floor and plaster wall rendered as
  // layer 1 alone. A layer-2 colour slot is on its own proof of a blend.
  //
  // The inferred half of that test is only safe on world surfaces. A layered
  // material that is NOT one — an unlit card, an effects card — has no vertex
  // paint to blend by, so the weight comes out of an attribute that was never
  // written and layer 2 washes over the whole card. Dust 2's 3D skybox cloud
  // dome (`nuke_clouds_002`, csgo_unlitgeneric, F_LAYERS 1, 229 tiles) is
  // exactly that: 229 cards of flat blue slab across the sky. Nuke's dome is
  // the same art on `csgo_effects`, which takes the effect path and was never
  // caught by this, which is why only Dust 2 showed it. A shader that names
  // itself a 2-way blend still counts — that one is not an inference.
  const cardShader = /unlit/.test(shader) || effect;
  const blend =
    /csgo_environment_blend|csgo_simple_2way_blend|_2way_blend|csgo_blend/.test(shader) ||
    (!cardShader &&
      (ints.F_LAYERS >= 1 ||
        ints.F_MULTIBLEND >= 1 ||
        !!(tex.g_tColor2 || tex.g_tColorB || tex.g_tLayer2Color)));
  const scale1 = Array.isArray(vecs.g_vTexCoordScale1) ? vecs.g_vTexCoordScale1 : Array.isArray(vecs.g_vTexCoordScale) ? vecs.g_vTexCoordScale : [1, 1];
  const scale2 = Array.isArray(vecs.g_vTexCoordScale2) ? vecs.g_vTexCoordScale2 : scale1;
  /**
   * Per-layer colour correction, the `csgo_environment` family only.
   *
   * These shaders do not draw their albedo as authored: each layer is pushed
   * through a saturation / contrast / brightness adjust first, gated by
   * `g_nColorCorrectionMode<n>`. Inferno's stone walls run layer 1 at
   * saturation 0.5 — half — with a tint mask brightened 1.977×.
   *
   * Nuke is 83% `csgo_complex`, which has no such parameters, so ignoring them
   * cost nothing there and the map looked right. Inferno is 76%
   * `csgo_environment` / `csgo_environment_blend`, so ignoring them meant every
   * blended wall and floor rendered at full saturation with an unscaled tint —
   * the same pack code, the same render path, a different shader vocabulary in.
   *
   * Read per layer; layer 2's values only matter on a blend.
   */
  const ccOf = (n) => {
    if (Number(ints[`g_nColorCorrectionMode${n}`]) !== 1) return null;
    const sat = floats[`g_fTextureColorSaturation${n}`];
    const con = floats[`g_fTextureColorContrast${n}`];
    const bri = floats[`g_fTextureColorBrightness${n}`];
    const out = {
      sat: Number.isFinite(sat) ? sat : 1,
      con: Number.isFinite(con) ? con : 1,
      bri: Number.isFinite(bri) ? bri : 1
    };
    return out.sat === 1 && out.con === 1 && out.bri === 1 ? null : out;
  };
  const cc1 = ccOf(1);
  const cc2 = blend ? ccOf(2) : null;
  const tintMaskBright = floats.g_fTintMaskBrightness1;
  /**
   * How `csgo_environment` applies its per-instance tint. Read off the game's
   * own shader (VRF's csgo_environment.frag is decompiled from it), and it is
   * nothing like the plain multiply every other shader uses:
   *
   *   mask   = saturate(((height.g - 0.5) * g_fTintMaskContrast + 0.5) * g_fTintMaskBrightness)
   *   tn     = normalize(tint)                     the tint's HUE, unit length
   *   tinted = tn * min(luma(albedo) / luma(tn), 3 * luma(albedo) * max(tint))
   *   amount = g_flModelTintAmount * (1 - min(tint))
   *   out    = mix(albedo, tinted, amount * mask * g_bModelTint)
   *
   * i.e. the albedo is recoloured to the tint's hue AT ITS OWN LUMINANCE, only
   * capped darker for a dark tint. A multiply darkens by the tint's brightness
   * as well, which is why Inferno's plaster went from terracotta to blood-red
   * and its barrels to near-black: the barrels' tint is a dark brown, and on top
   * of that they set g_bModelTint1 = 0 — tint OFF — which nothing here honoured.
   * 37 of Inferno's 237 environment vmats also run g_flModelTintAmount = 0.
   *
   * The mask is the HEIGHT map's green channel per the decompiled shader. VRF's
   * hand-written environment_blend uses the colour map's alpha instead; the two
   * are not separable from texture statistics alone, so this follows the
   * decompiled source. If tinted props look masked wrong, that channel index
   * (below, `mask(h1, .., 1)`) is the one thing to try flipping to alpha.
   */
  const env = /csgo_environment/.test(shader);
  const layerTint = (n) => ({
    on: Number(ints[`g_bModelTint${n}`] ?? 1) !== 0,
    bright: Number.isFinite(floats[`g_fTintMaskBrightness${n}`]) ? floats[`g_fTintMaskBrightness${n}`] : 1,
    contrast: Number.isFinite(floats[`g_fTintMaskContrast${n}`]) ? floats[`g_fTintMaskContrast${n}`] : 1
  });
  const envTint = env
    ? {
        amount: Number.isFinite(floats.g_flModelTintAmount) ? floats.g_flModelTintAmount : 1,
        l1: layerTint(1),
        l2: blend ? layerTint(2) : undefined
      }
    : undefined;
  return {
    name,
    shader,
    decal: overlay,
    unlit: /unlit|black_unlit/.test(shader),
    water,
    alphaMode,
    alphaCutoff: alphaTest ? (floats.g_flAlphaTestReference ?? 0.5) : undefined,
    // Foliage cards and fences are single-sided geometry meant to be seen
    // from both sides; without this every leaf disappears at half the angles.
    doubleSided: ints.F_RENDER_BACKFACES === 1 || /foliage/.test(shader) || effect,
    effect: effect
      ? {
          additive: ints.F_ADDITIVE_BLEND === 1,
          boost: Number.isFinite(floats.g_flColorBoost) ? floats.g_flColorBoost : 1,
          opacity: Number.isFinite(floats.g_flOpacityScale) ? floats.g_flOpacityScale : 1,
          tint: Array.isArray(vecs.g_vColorTint) ? vecs.g_vColorTint.slice(0, 3) : [1, 1, 1],
          // Each mask tiles at its own scale and drifts at its own speed; that
          // drift is what makes the cloud layer move.
          masks: [1, 2, 3].map((i) => ({
            scale: Array.isArray(vecs[`g_vMask${i}Scale`]) ? vecs[`g_vMask${i}Scale`].slice(0, 2) : [1, 1],
            pan: Array.isArray(vecs[`g_vMask${i}PanSpeed`]) ? vecs[`g_vMask${i}PanSpeed`].slice(0, 2) : [0, 0]
          }))
        }
      : undefined,
    tintMask: ints.F_TINT_MASK === 1 || !!tex.g_tTintMask,
    envTint,
    glass,
    glassOpacity,
    glassRoughness,
    selfIllum: selfIllumOf(vmat),
    tint: tint.every((v) => v === 1) ? undefined : tint,
    blend,
    // Layer 2's texture scale relative to layer 1 (both tile the same UV set).
    blendScale2: blend ? [scale2[0] / (scale1[0] || 1) || 1, scale2[1] / (scale1[1] || 1) || 1] : undefined,
    blendSoftness: Number.isFinite(floats.g_flBlendSoftness) ? floats.g_flBlendSoftness : 0.5,
    cc1: cc1 || undefined,
    cc2: cc2 || undefined,
    tintMaskBright:
      Number.isFinite(tintMaskBright) && tintMaskBright !== 1 ? tintMaskBright : undefined,
    tex
  };
}

// ---------------------------------------------------------------------------
// Source 2 texture slots
//
// The vmat names its own textures and every one of them was exported next to
// world.glb under the .vtex basename, so slots resolve by name rather than by
// whatever VRF chose to put in the glTF's PBR slots. Channel layout, verified
// against the exports:
//
//   g_tColor              RGB albedo, A = alpha-test / blend mask
//   g_tNormal             RGB tangent normal, A = ROUGHNESS  (Source 2 packs
//                         them together; the files are even named *_rough_*)
//   g_tAmbientOcclusion   R = AO
//   g_tMetalness          R = metalness
//   g_tHeight1/2          height for the blend shaders' layer transition
//
// three wants one ORM texture (R=AO, G=roughness, B=metalness), so the pack
// builds it from those three sources.
// ---------------------------------------------------------------------------

/** Exported PNG filename for a vmat texture path, or null. */
function texFile(rawDir, vtexPath) {
  if (!vtexPath) return null;
  const png = path.basename(String(vtexPath)).replace(/\.vtex$/i, '.png');
  return fs.existsSync(path.join(rawDir, png)) ? png : null;
}

/** True for VRF's 1x1 stand-ins, which are not worth a file or a texture unit. */
function isDefaultTex(vtexPath) {
  return /^materials\/default\//i.test(String(vtexPath || ''));
}

// Not every shader calls its albedo g_tColor. The blend shaders name their
// layers instead, and on a map like Overpass they are a third of all
// materials (csgo_environment_blend 169, csgo_environment 86,
// csgo_simple_2way_blend 22) — miss them and a third of the world renders
// untextured grey. These chains are tried in order; the first slot the
// material actually has wins.
const SLOT_COLOR = ['g_tColor', 'g_tColor1', 'g_tColorA', 'g_tLayer1Color', 'g_tColorB', 'g_tColor2'];
const SLOT_NORMAL = ['g_tNormal', 'g_tNormal1', 'g_tNormalA', 'g_tLayer1NormalRoughness'];
const SLOT_AO = ['g_tAmbientOcclusion', 'g_tLayer1AmbientOcclusion', 'g_tAmbientOcclusion1'];
const SLOT_METAL = ['g_tMetalness', 'g_tMetalness1'];
const SLOT_COLOR2 = ['g_tColor2', 'g_tColorB', 'g_tLayer2Color'];
const SLOT_NORMAL2 = ['g_tNormal2', 'g_tNormalB', 'g_tLayer2NormalRoughness'];
const SLOT_HEIGHT1 = ['g_tHeight1', 'g_tHeightA', 'g_tLayer1Height'];
const SLOT_HEIGHT2 = ['g_tHeight2', 'g_tHeightB', 'g_tLayer2Height'];
// The other way a two-layer material shapes its transition: one texture whose
// R is the threshold the vertex paint is compared against (and G a per-texel
// width). Dust 2 uses this and no height pair at all.
const SLOT_BLENDMOD = ['g_tBlendModulation', 'g_tBlendModulation1', 'g_tLayer1BlendModulation'];
/**
 * Which texels a model's instance tint is allowed to touch (F_TINT_MASK).
 *
 * A prop's rendercolor does NOT recolour the whole model. Dust 2's taxi is one
 * `dust_300d_color` vmat with four instance tints, and the mask is what keeps
 * the tint on the body panels and off the chrome trim and bumpers. Applying the
 * tint everywhere painted the trim yellow with the rest of the car — and on
 * Nuke it is worse, because `metal_door_001` and `metal_pipe_001` (23 tint
 * variants) are masked too, so a door's whole face took a tint meant for one
 * painted panel. 47 tinted vmats on Dust 2 and 66 on Nuke carry one.
 */
const SLOT_TINTMASK = ['g_tTintMask', 'g_tTintMask1'];
/** csgo_effects' three scrolling opacity masks. */
const SLOT_EMASK = [['g_tMask1'], ['g_tMask2'], ['g_tMask3']];
const SLOT_SELFILLUM = ['g_tSelfIllumMask', 'g_tSelfIllum', 'g_tEmissive'];

/**
 * First slot in `names` that the material has and that resolves to a real
 * exported file. `allowDefault` keeps VRF's 1x1 stand-ins out of the pack.
 */
function pickTex(rawDir, tp, names, { allowDefault = false } = {}) {
  for (const n of names) {
    const v = tp[n];
    if (!v) continue;
    if (!allowDefault && isDefaultTex(v)) continue;
    const f = texFile(rawDir, v);
    if (f) return f;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Textures → one bundle
// ---------------------------------------------------------------------------

function shortHash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function resizeTo(pipe, meta, maxSize) {
  const w = meta.width || 1;
  const h = meta.height || 1;
  const scale = Math.min(1, maxSize / Math.max(w, h, 1));
  if (scale >= 1) return { pipe, w, h };
  return {
    pipe: pipe.resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), {
      kernel: 'lanczos3'
    }),
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale))
  };
}

/**
 * Every packed texture, deduplicated by (source, kind, size). Encodes to webp
 * buffers in memory; `write()` lays them back to back into tex.bin and
 * returns the directory the manifest ships. Entries are appended in the
 * order they are first requested, and the pack requests them in material
 * priority order, so the bundle streams biggest surfaces first.
 */
class TextureBundle {
  constructor(rawDir) {
    this.rawDir = rawDir;
    this.entries = []; // { key, kind, buf, w, h, alpha, avg }
    this.byKey = new Map(); // key → Promise<index|null>
  }

  _add(key, kind, make) {
    if (this.byKey.has(key)) return this.byKey.get(key);
    const p = (async () => {
      try {
        const e = await make();
        if (!e) return null;
        const idx = this.entries.length;
        this.entries.push({ key, kind, ...e });
        return idx;
      } catch (err) {
        console.warn(`    ! ${kind} ${key}: ${err.message}`);
        return null;
      }
    })();
    this.byKey.set(key, p);
    return p;
  }

  /** Colour texture: RGB albedo, alpha preserved (it is the cut-out mask). */
  color(png, maxSize, keepAlpha = true) {
    if (!png) return Promise.resolve(null);
    return this._add(`base|${png}|${maxSize}|${keepAlpha ? 'a' : 'rgb'}`, 'base', async () => {
      const src = path.join(this.rawDir, png);
      const meta = await sharp(src, { limitInputPixels: false }).metadata();
      const input = keepAlpha ? sharp(src, { limitInputPixels: false }) : await this._rgbOf(src);
      const { pipe, w, h } = resizeTo(input, meta, maxSize);
      // The alpha goes only where it is genuinely opacity (cut-outs, blends).
      // Source 2 puts masks in g_tColor's alpha too — it is "transparent" over
      // 79% of `metal_door_001` and 83% of `metal_pipe_001` — and carrying it
      // through costs the RGB underneath twice over: the resize premultiplies
      // it (see _rgbOf) and then libwebp wipes whatever is left under fully
      // transparent texels because it is invisible and compresses better that
      // way. Both are true right up until the material ignores alpha and draws
      // that RGB. Source 0.92, delivered 0.20.
      //
      // smartSubsample: lossy webp is YUV 4:2:0, so chroma is halved in both
      // directions. On an albedo that is mostly fine, but a painted stripe or
      // a sign next to plaster bleeds its colour a texel or two either side —
      // this makes libwebp choose subsampled values that survive the round
      // trip instead of averaging blindly.
      const buf = await pipe.webp({ quality: 88, alphaQuality: 95, smartSubsample: true, effort: 4 }).toBuffer();
      const st = await sharp(src, { limitInputPixels: false }).stats();
      const avg = st.channels.slice(0, 3).map((c) => Math.round(c.mean));
      // A mask that is solid white carries no information; the loader can skip
      // alpha handling for it and keep the material opaque.
      const alphaMin = meta.hasAlpha && st.channels[3] ? st.channels[3].min : 255;
      return {
        buf,
        w,
        h,
        avg: avg.length === 3 ? avg : [avg[0] ?? 128, avg[0] ?? 128, avg[0] ?? 128],
        alpha: keepAlpha && alphaMin < 250
      };
    });
  }

  /**
   * Normal map: RGB only (its alpha is roughness and goes into the ORM).
   *
   * near-lossless, not lossy. A normal map is not a picture: X and Y live in
   * the red and green channels, and lossy webp encodes every image as YUV
   * 4:2:0, which throws away three quarters of the chroma — i.e. three
   * quarters of the surface detail, replaced by 2x2 blocks of averaged
   * direction. That is what put the blocky, faintly iridescent shading on
   * pipes and painted metal. Near-lossless runs the *lossless* codec with a
   * preprocessing pass, so channels stay independent; it costs roughly 2x the
   * bytes of quality-92 lossy and is worth every one of them.
   */
  normal(png, maxSize) {
    if (!png) return Promise.resolve(null);
    return this._add(`normal|${png}|${maxSize}`, 'normal', async () => {
      const src = path.join(this.rawDir, png);
      const meta = await sharp(src, { limitInputPixels: false }).metadata();
      // The alpha (roughness) goes before the resize, not after: see _rgbOf.
      const { pipe, w, h } = resizeTo(await this._rgbOf(src), meta, maxSize);
      const buf = await pipe.webp({ nearLossless: true, quality: 20, effort: 4 }).toBuffer();
      return { buf, w, h };
    });
  }

  /** A single-channel mask (self-illum), packed into the red channel. */
  /**
   * A single-channel mask. `channel` defaults to R, which is where a dedicated
   * mask texture keeps it; `csgo_environment` has no dedicated tint-mask slot
   * and keeps its tint mask in the COLOUR map's alpha instead, so that family
   * asks for channel 3 of its g_tColor1/2.
   */
  mask(png, maxSize, channel = 0) {
    if (!png) return Promise.resolve(null);
    const size = Math.min(maxSize, 512);
    return this._add(`mask|${png}|${channel}|${size}`, 'mask', async () => {
      const raw = await this._channelAt(png, channel, size, 255);
      // Constant-white masks say "the whole surface glows", which the material
      // can express with no texture at all.
      let min = 255;
      for (let i = 0; i < raw.length; i++) if (raw[i] < min) min = raw[i];
      if (min >= 250) return null;
      const buf = await sharp(raw, { raw: { width: size, height: size, channels: 1 } })
        .webp({ lossless: true, effort: 4 })
        .toBuffer();
      return { buf, w: size, h: size };
    });
  }

  /**
   * The image with any alpha channel dropped *before* anything can resize it.
   *
   * sharp runs its operations in a fixed pipeline order, not the order they are
   * called in, and resize premultiplies RGB by alpha. Calling `.removeAlpha()`
   * does not help: the resize has already happened by then. On a texture whose
   * alpha is opacity that is harmless, but Source 2 puts *masks* in alpha —
   * g_tColor's alpha is a mask, g_tNormal's alpha is roughness — and there the
   * premultiply silently scales the channels underneath by something unrelated.
   * `metal_door_001`'s albedo reads 0.92 in the source and 0.20 after; every
   * normal map came out multiplied by its own roughness; and every single
   * channel pulled with _channelAt (AO, metalness, tint masks, blend heights
   * and modulation, self-illum masks) was scaled the same way. Round-tripping
   * the raw pixels drops the channel before sharp gets the chance.
   */
  async _rgbOf(file) {
    const { data, info } = await sharp(file, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
    if (info.channels < 4) return sharp(file, { limitInputPixels: false });
    const n = info.width * info.height;
    const rgb = Buffer.allocUnsafe(n * 3);
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      const p = i * info.channels;
      rgb[o] = data[p];
      rgb[o + 1] = data[p + 1];
      rgb[o + 2] = data[p + 2];
    }
    return sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } });
  }

  /** One channel of an image as a raw greyscale buffer at exactly size x size. */
  async _channelAt(png, channel, size, fallback) {
    if (!png) return Buffer.alloc(size * size, fallback);
    try {
      const file = path.join(this.rawDir, png);
      // Channel 3 IS the alpha, so it has to keep it; a resize never scales
      // alpha by itself. Every other channel has to lose it first.
      const src = channel === 3 ? sharp(file, { limitInputPixels: false }) : await this._rgbOf(file);
      return await src
        .extractChannel(channel)
        .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
        .raw()
        .toBuffer();
    } catch {
      return Buffer.alloc(size * size, fallback);
    }
  }

  /**
   * ORM for three: R = AO, G = roughness (from the normal map's alpha),
   * B = metalness. Null when all three would be constant defaults, in which
   * case the material's scalar roughness/metalness factors are enough.
   */
  orm({ ao, normal, metal }, maxSize) {
    if (!ao && !normal && !metal) return Promise.resolve(null);
    // One square size for all three so the channels line up. This is the map
    // where lossy webp does real damage: the three channels are unrelated
    // quantities packed into R/G/B, and 4:2:0 chroma subsampling smears
    // metalness into roughness and back. A rough dielectric next to a metal
    // rivet came out half-metal, which reads as a dark, oddly tinted patch —
    // and on a lightmapped surface, which gets no environment reflection, as
    // a black one. So: lossless, and small enough that lossless is cheap.
    // ORM detail matters far less than colour.
    const size = Math.min(maxSize, 256);
    return this._add(`orm|${ao || '-'}|${normal || '-'}|${metal || '-'}|${size}`, 'orm', async () => {
      const [r, g, b] = await Promise.all([
        this._channelAt(ao, 0, size, 255), // no AO map → unoccluded
        this._channelAt(normal, 3, size, 220), // roughness rides in the normal map's ALPHA
        this._channelAt(metal, 0, size, 0) // no map → dielectric
      ]);
      const rgb = Buffer.alloc(size * size * 3);
      for (let i = 0, o = 0; i < size * size; i++, o += 3) {
        rgb[o] = r[i];
        rgb[o + 1] = g[i];
        rgb[o + 2] = b[i];
      }
      const buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        .webp({ lossless: true, effort: 4 })
        .toBuffer();
      return { buf, w: size, h: size };
    });
  }

  /**
   * Blend modulation: R = the threshold the vertex paint is compared against,
   * G = how wide the transition is there. Lossless and small — it is a control
   * signal, and a smeared threshold puts a ragged edge on every road.
   */
  blendMod(png) {
    if (!png) return Promise.resolve(null);
    const size = 256;
    return this._add(`bmod|${png}|${size}`, 'blend', async () => {
      const [r, g] = await Promise.all([this._channelAt(png, 0, size, 128), this._channelAt(png, 1, size, 255)]);
      const rgb = Buffer.alloc(size * size * 3);
      for (let i = 0, o = 0; i < size * size; i++, o += 3) {
        rgb[o] = r[i];
        rgb[o + 1] = g[i];
        rgb[o + 2] = 0;
      }
      const buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        .webp({ lossless: true, effort: 4 })
        .toBuffer();
      return { buf, w: size, h: size };
    });
  }

  /**
   * csgo_effects' three opacity masks in one RGB texture (R = mask 1, G = 2,
   * B = 3). They tile and scroll independently, so the shader samples this one
   * texture three times at three UVs and takes a different channel each time.
   */
  effectMasks(pngs, maxSize) {
    if (!pngs.some(Boolean)) return Promise.resolve(null);
    const size = Math.min(maxSize, 256);
    return this._add(`emask|${pngs.map((p) => p || '-').join('|')}|${size}`, 'mask', async () => {
      const [r, g, b] = await Promise.all(pngs.map((p) => this._channelAt(p, 0, size, 255)));
      const rgb = Buffer.alloc(size * size * 3);
      for (let i = 0, o = 0; i < size * size; i++, o += 3) {
        rgb[o] = r[i];
        rgb[o + 1] = g[i];
        rgb[o + 2] = b[i];
      }
      const buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        .webp({ quality: 90, effort: 4 })
        .toBuffer();
      return { buf, w: size, h: size };
    });
  }

  /** Blend heights: R = layer 1 height, G = layer 2 height. Small; it only shapes the transition. */
  heights({ h1, h2 }) {
    if (!h1 && !h2) return Promise.resolve(null);
    const size = 256;
    return this._add(`hgt|${h1 || '-'}|${h2 || '-'}|${size}`, 'blend', async () => {
      const [r, g] = await Promise.all([this._channelAt(h1, 0, size, 128), this._channelAt(h2, 0, size, 128)]);
      const rgb = Buffer.alloc(size * size * 3);
      for (let i = 0, o = 0; i < size * size; i++, o += 3) {
        rgb[o] = r[i];
        rgb[o + 1] = g[i];
        rgb[o + 2] = 0;
      }
      // Two independent channels again: lossless, and it is only 256².
      const buf = await sharp(rgb, { raw: { width: size, height: size, channels: 3 } })
        .webp({ lossless: true, effort: 4 })
        .toBuffer();
      return { buf, w: size, h: size };
    });
  }

  /** Lay every buffer end to end. Returns { file bytes written, dir[] for the manifest }. */
  async write(file) {
    const dir = [];
    let off = 0;
    const chunks = [];
    for (const e of this.entries) {
      dir.push({ off, len: e.buf.length, w: e.w, h: e.h, kind: e.kind, alpha: e.alpha || undefined, avg: e.avg || undefined });
      chunks.push(e.buf);
      off += e.buf.length;
    }
    await fsp.writeFile(file, Buffer.concat(chunks));
    return { bytes: off, dir };
  }
}

/**
 * The irradiance atlas: 16-bit linear PNG (cs3d-import + tools/cs3d-tex) →
 * RGBM webp. RGBM keeps HDR range in four 8-bit channels (rgb × a × RANGE),
 * which webp carries at a tenth of a Radiance file's size.
 *
 * The whole texture is charts. An earlier pass read m_vLightmapUvScale = 8/7 as
 * "the atlas fills 7/8 of the page" and painted the last eighth of each axis
 * with the mean, as a neutral spot for chartless geometry — but that eighth is
 * ordinary packed charts, and measuring it says so plainly: past 7/8 the raw
 * atlas is 93.8% non-zero with the same mean (0.417) as the rest (0.424).
 * Flattening it destroyed 1 − (7/8)² = 23.4% of the bake, which is where the
 * hard-edged rectangles of flat light came from — a chart that landed in the
 * strip lost its shading entirely and rendered as one uniform slab.
 *
 * The 8/7 is a scale from mesh UV space onto the page, nothing more: mesh
 * lightmap UVs top out at 0.875 and 0.875 × 8/7 = 1.0.
 */
async function packLightmap(pngFile, outFile, maxSize) {
  const meta = await sharp(pngFile, { limitInputPixels: false }).metadata();
  const size = Math.min(maxSize, meta.width);
  // toColourspace('rgb16') is what keeps sharp from flattening the 16-bit
  // PNG to 8 bits on read; without it every value comes back /257.
  const raw = await sharp(pngFile, { limitInputPixels: false })
    .toColourspace('rgb16')
    .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
    .raw({ depth: 'ushort' })
    .toBuffer();
  const px = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const ch = meta.channels || 4;
  const scale = 4096; // cs3d-import wrote linear × 4096
  const n = size * size;
  const out = Buffer.alloc(n * 4);
  // Mean and luminance percentiles over the whole atlas, for the loader's
  // exposure and its shade level.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let cnt = 0;
  const lums = [];
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      const i = (y * size + x) * ch;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      // Unpacked charts are black; they are not light.
      if (r + g + b < 3) continue;
      sr += r;
      sg += g;
      sb += b;
      cnt++;
      lums.push((0.2126 * r + 0.7152 * g + 0.0722 * b) / scale);
    }
  }
  const mean = [sr / cnt / scale, sg / cnt / scale, sb / cnt / scale];
  lums.sort((a, b) => a - b);
  const pct = (p) => (lums.length ? lums[Math.min(lums.length - 1, Math.floor(p * lums.length))] : 0);
  const percentiles = { p50: pct(0.5), p90: pct(0.9), p98: pct(0.98) };
  for (let i = 0; i < n; i++) {
    const r = px[i * ch] / scale;
    const g = px[i * ch + 1] / scale;
    const b = px[i * ch + 2] / scale;
    // RGBM: m = max / RANGE, quantised up so rgb/m stays ≤ 1.
    const mx = Math.min(LM_RANGE, Math.max(r, g, b, 1e-6));
    const m = Math.ceil((mx / LM_RANGE) * 255) / 255;
    const k = 1 / (m * LM_RANGE);
    out[i * 4] = Math.min(255, Math.round(r * k * 255));
    out[i * 4 + 1] = Math.min(255, Math.round(g * k * 255));
    out[i * 4 + 2] = Math.min(255, Math.round(b * k * 255));
    out[i * 4 + 3] = Math.round(m * 255);
  }
  // Lossless alpha (the multiplier) so dark charts do not sparkle; lossy RGB
  // is fine because it is normalised.
  const buf = await sharp(out, { raw: { width: size, height: size, channels: 4 } })
    .webp({ quality: 88, alphaQuality: 100, effort: 4 })
    .toBuffer();
  await fsp.writeFile(outFile, buf);
  return { size, bytes: buf.length, mean, percentiles, range: LM_RANGE };
}

/**
 * The sun's baked shadow mask: 8-bit RGBA PNG (one mask per channel) → a
 * single-channel lossless webp holding SUN VISIBILITY (1 = in daylight).
 *
 * CS2 does not bake the sun into the irradiance atlas. It stores the sun as an
 * ordinary `light_environment` and bakes only its occlusion here, then at
 * runtime lights the world with `sunColor × N·L × visibility`. The atlas is the
 * indirect term alone — which is why its bright tail sits only 1.8× above its
 * median on Dust 2, nowhere near a real sun-to-shade ratio, and why dropping
 * the analytic sun on lightmapped geometry left every map looking overcast.
 *
 * `direct_light_shadows` stores SHADOW, not visibility, so it is inverted here.
 * Reading it the other way round is what put every map's lighting inside out:
 * a palm's shadow came out as bright fronds on dark ground, and the contact
 * shadow under a wall came out as a bright skirting board. Three independent
 * measurements over Dust 2 say which way it goes, all in the same direction:
 *   - surfaces facing the sun average 0.62 in the stored mask, surfaces facing
 *     away 0.90, and downward-facing ones 0.87. Visibility would run the other
 *     way (1.6M vertices, lightmap UV sampled against the vertex normal).
 *   - the stored mask anti-correlates with the irradiance atlas at r = -0.57.
 *     Bounce light is strongest where the sun lands, so a visibility mask would
 *     correlate positively; a shadow mask correlates negatively, as this does.
 *     (The atlas itself measures correct: +0.16 against N·up, i.e. up-facing
 *     surfaces get more sky. Only the mask was inside out.)
 *   - the two non-sun channels sit at 0.996 with 99.4% of texels at 1.0. As
 *     shadow that reads as two small local lights that reach almost nothing,
 *     which is what they are; as visibility it would mean two point lights that
 *     illuminate the whole map and are blocked in 0.4% of it.
 *
 * Which channel is the sun: `world.kv3`'s `m_bakedShadows` maps a light hash
 * to a channel but never says which light is the sun. The sun is the only light
 * whose mask carries structure across the whole world, so the channel with the
 * most variation wins; on Dust 2 that is R at sd 0.41 against 0.07 and 0.06 for
 * the two local lights. Every channel's mean and sd is returned so the choice
 * is auditable.
 *
 * Like the irradiance atlas, this covers the whole texture — there is no spare
 * strip to overwrite, and flattening the last eighth of each axis cost 23.4% of
 * the sun's shadows. Chartless geometry does not sample it at all any more; it
 * goes to a probe-lit material (see splitByLightmapChart).
 */
async function packShadowMask(pngFile, outFile, maxSize) {
  const meta = await sharp(pngFile, { limitInputPixels: false }).metadata();
  const size = Math.min(maxSize, meta.width);
  const raw = await sharp(pngFile, { limitInputPixels: false })
    .resize(size, size, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer();
  const ch = meta.channels || 4;
  const sums = [0, 0, 0];
  const sqs = [0, 0, 0];
  let cnt = 0;
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      const i = (y * size + x) * ch;
      for (let c = 0; c < 3; c++) {
        const v = raw[i + c] / 255;
        sums[c] += v;
        sqs[c] += v * v;
      }
      cnt++;
    }
  }
  const means = sums.map((s) => s / cnt);
  const sds = sqs.map((s, c) => Math.sqrt(Math.max(0, s / cnt - means[c] * means[c])));
  let sun = 0;
  for (let c = 1; c < 3; c++) if (sds[c] > sds[sun]) sun = c;
  const n = size * size;
  const visMean = 1 - means[sun];
  const out = Buffer.alloc(n);
  // Stored shadow → visibility.
  for (let i = 0; i < n; i++) out[i] = 255 - raw[i * ch + sun];
  // Lossless: this multiplies the sun, so webp's chroma subsampling would put
  // 2x2 blocks of half-shadow along every shadow edge in the map.
  const buf = await sharp(out, { raw: { width: size, height: size, channels: 1 } })
    .webp({ lossless: true, effort: 4 })
    .toBuffer();
  await fsp.writeFile(outFile, buf);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    size,
    bytes: buf.length,
    channel: sun,
    encoding: 'visibility',
    shadowMeans: means.map(r3),
    shadowSds: sds.map(r3),
    visMean: r3(visMean)
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** gltf-transform narrates every prune/quantize otherwise; errors are enough. */
const QUIET = new Logger(Logger.Verbosity.ERROR);

function makeIO() {
  return new NodeIO()
    .setLogger(QUIET)
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

function quietDoc(doc) {
  doc.setLogger(QUIET);
  return doc;
}

const isDisabled = (ex) =>
  ex && (ex.startdisabled === '1' || ex.startdisabled === 1 || ex.startdisabled === true || ex.startdisabled === 'true');

/**
 * Whole-tile offset, or 0 when the UV is degenerate/out of usable range.
 */
function safeOffset(v) {
  if (!Number.isFinite(v) || Math.abs(v) > 1e6) return 0;
  return Math.floor(v);
}

/**
 * Shift each primitive's UVs down by a whole number of tiles.
 *
 * Source derives world-brush UVs from world position, so a big wall can carry
 * texture coordinates in the tens of thousands (Ancient's blend walls reach
 * 26,810). A float32 has about 0.002 of precision up there, which is coarser
 * than one texel: the screen-space derivatives the GPU uses to pick a mip
 * level turn into noise. Subtracting an integer offset is invisible to a
 * repeating texture (wrapping has period 1) and brings the values back into
 * a range float32 can resolve. Clamped textures already live in [0,1], so
 * their offset is 0 and nothing changes for them.
 *
 * A single aggregate mesh holds many separately-UV'd pieces (each brick of a
 * wall carries its own world-derived offset), so one offset for the whole
 * primitive cannot bring them all in. Every triangle gets its own offset,
 * which needs each triangle to own its vertices; the caller welds again
 * afterwards, and vertices that ended up identical (most of them) re-merge.
 */
function recenterUVs(doc, threshold = 8) {
  let shifted = 0;
  let worst = 0;
  let unwelded = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const uvAttr = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices();
      if (!uvAttr || !idx) continue;
      const min = uvAttr.getMin([]);
      const max = uvAttr.getMax([]);
      const reach = Math.max(Math.abs(min[0]), Math.abs(min[1]), Math.abs(max[0]), Math.abs(max[1]));
      if (Number.isFinite(reach) && reach <= threshold) continue;

      const ia = idx.getArray();
      const triCount = ia.length / 3;
      const semantics = prim.listSemantics();
      const src = {};
      for (const s of semantics) src[s] = prim.getAttribute(s);

      const out = {};
      for (const s of semantics) {
        const a = src[s];
        out[s] = new Float32Array(triCount * 3 * a.getElementSize());
      }
      const el = [];
      for (let t = 0; t < triCount; t++) {
        // Whole-tile offset from the triangle's own UV centroid; integer, so
        // a repeating texture samples exactly the same texels as before.
        let cu = 0;
        let cv = 0;
        for (let k = 0; k < 3; k++) {
          uvAttr.getElement(ia[t * 3 + k], el);
          cu += el[0];
          cv += el[1];
        }
        // Some exported triangles carry degenerate UVs (Overpass has values
        // around 5.7e37). Shifting by those would poison good vertices too, so
        // leave them exactly as they were and let them stay broken alone.
        const offU = safeOffset(cu / 3);
        const offV = safeOffset(cv / 3);
        worst = Math.max(worst, Math.abs(offU), Math.abs(offV));
        for (const s of semantics) {
          const a = src[s];
          const size = a.getElementSize();
          for (let k = 0; k < 3; k++) {
            a.getElement(ia[t * 3 + k], el);
            if (s === 'TEXCOORD_0') {
              // Degenerate coordinates poison the whole triangle's mip
              // derivatives, so clamp them to the texture origin rather than
              // letting 1e38 through.
              el[0] = Number.isFinite(el[0]) && Math.abs(el[0]) < 1e6 ? el[0] - offU : 0;
              el[1] = Number.isFinite(el[1]) && Math.abs(el[1]) < 1e6 ? el[1] - offV : 0;
            }
            const o = (t * 3 + k) * size;
            for (let c = 0; c < size; c++) out[s][o + c] = el[c];
          }
        }
      }
      for (const s of semantics) {
        prim.setAttribute(
          s,
          doc.createAccessor().setType(src[s].getType()).setArray(out[s]).setNormalized(false)
        );
      }
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(triCount * 3).map((_, i) => i)));
      shifted++;
      unwelded += triCount;
    }
  }
  return { shifted, worst, unwelded };
}

/**
 * The map's baked light probes, ready to sample at a world point.
 *
 * This is how CS2 lights props, and it is the answer to the sky probe being a
 * single unoccluded environment: a crate in a sealed hall got exactly as much
 * sky as one in the open yard, so no probe intensity was right for both, and
 * the best compromise moved from map to map with the indoor/outdoor ratio.
 *
 * The atlas is one BC6H volume; its depth is six stacked planes holding an
 * ambient cube (+X, -X, +Y, -Y, +Z, -Z), and each volume entity names its own
 * block inside it. Sampled here at pack time and baked into the vertices, so
 * nothing about it reaches the browser.
 *
 * Everything in this sampler is SOURCE space (z-up), the frame the entities
 * are authored in; the caller converts.
 */
function makeProbeSampler(dir) {
  const metaFile = path.join(dir, 'volumes.json');
  const binFile = path.join(dir, 'probes.rgbe');
  if (!fs.existsSync(metaFile) || !fs.existsSync(binFile)) return null;
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const buf = fs.readFileSync(binFile);
  const w = buf.readInt32LE(0);
  const h = buf.readInt32LE(4);
  const d = buf.readInt32LE(8);
  const data = buf.subarray(12);
  const plane = d / 6; // six ambient-cube components stacked along z
  if (!Number.isInteger(plane)) throw new Error(`probe atlas depth ${d} is not 6 planes`);

  // Smallest volume first: CS2 nests tight volumes inside loose ones and the
  // tight one is the more specific answer.
  const vols = meta.volumes
    .map((v) => {
      const yaw = ((v.angles?.[1] || 0) * Math.PI) / 180;
      return {
        ...v,
        cos: Math.cos(-yaw),
        sin: Math.sin(-yaw),
        span: [v.maxs[0] - v.mins[0], v.maxs[1] - v.mins[1], v.maxs[2] - v.mins[2]],
        vol: (v.maxs[0] - v.mins[0]) * (v.maxs[1] - v.mins[1]) * (v.maxs[2] - v.mins[2])
      };
    })
    .sort((a, b) => a.vol - b.vol);

  const rgbe = (x, y, z, out) => {
    const i = ((z * h + y) * w + x) * 4;
    const e = data[i + 3];
    if (!e) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    const s = Math.pow(2, e - 136);
    out[0] = data[i] * s;
    out[1] = data[i + 1] * s;
    out[2] = data[i + 2] * s;
  };

  const c0 = new Float64Array(3);
  const acc = new Float64Array(18); // 6 components x rgb
  /** Trilinear ambient cube at grid coords, into `acc`. */
  const sampleCube = (v, gx, gy, gz) => {
    acc.fill(0);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;
    for (let dz = 0; dz < 2; dz++) {
      const pz = Math.min(v.size[2] - 1, Math.max(0, z0 + dz));
      const wz = dz ? fz : 1 - fz;
      for (let dy = 0; dy < 2; dy++) {
        const py = Math.min(v.size[1] - 1, Math.max(0, y0 + dy));
        const wy = dy ? fy : 1 - fy;
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(v.size[0] - 1, Math.max(0, x0 + dx));
          const wgt = (dx ? fx : 1 - fx) * wy * wz;
          if (wgt <= 0) continue;
          for (let c = 0; c < 6; c++) {
            rgbe(v.atlas[0] + px, v.atlas[1] + py, c * plane + v.atlas[2] + pz, c0);
            acc[c * 3] += c0[0] * wgt;
            acc[c * 3 + 1] += c0[1] * wgt;
            acc[c * 3 + 2] += c0[2] * wgt;
          }
        }
      }
    }
  };

  // The union of every volume's world box, as an AABB. Yaw-rotated volumes
  // contribute the AABB of their rotated corners, which is a superset — the
  // grid built over it simply has a few cells no volume covers, and those are
  // filled by dilation.
  const gmin = [Infinity, Infinity, Infinity];
  const gmax = [-Infinity, -Infinity, -Infinity];
  for (const v of vols) {
    const cs = Math.cos(((v.angles?.[1] || 0) * Math.PI) / 180);
    const sn = Math.sin(((v.angles?.[1] || 0) * Math.PI) / 180);
    for (let i = 0; i < 8; i++) {
      const lx = i & 1 ? v.maxs[0] : v.mins[0];
      const ly = i & 2 ? v.maxs[1] : v.mins[1];
      const lz = i & 4 ? v.maxs[2] : v.mins[2];
      const wx = v.origin[0] + lx * cs - ly * sn;
      const wy = v.origin[1] + lx * sn + ly * cs;
      const wz = v.origin[2] + lz;
      gmin[0] = Math.min(gmin[0], wx);
      gmin[1] = Math.min(gmin[1], wy);
      gmin[2] = Math.min(gmin[2], wz);
      gmax[0] = Math.max(gmax[0], wx);
      gmax[1] = Math.max(gmax[1], wy);
      gmax[2] = Math.max(gmax[2], wz);
    }
  }

  return {
    volumes: vols.length,
    /** Source-space AABB covering every volume. */
    bounds: { min: gmin, max: gmax },
    /**
     * Irradiance at a source-space point for a source-space normal.
     * @returns {boolean} false when no volume covers the point
     */
    sample(px, py, pz, nx, ny, nz, out) {
      for (const v of vols) {
        // Into the volume's own frame (yaw only; the entities never pitch).
        const dx = px - v.origin[0];
        const dy = py - v.origin[1];
        const lx = dx * v.cos - dy * v.sin;
        const ly = dx * v.sin + dy * v.cos;
        const lz = pz - v.origin[2];
        if (lx < v.mins[0] || lx > v.maxs[0] || ly < v.mins[1] || ly > v.maxs[1] || lz < v.mins[2] || lz > v.maxs[2]) continue;
        const g = [0, 1, 2].map((i) => {
          const t = v.span[i] > 0 ? ([lx, ly, lz][i] - v.mins[i]) / v.span[i] : 0;
          return Math.min(v.size[i] - 1, Math.max(0, t * (v.size[i] - 1)));
        });
        sampleCube(v, g[0], g[1], g[2]);
        // The normal is in the volume's frame too.
        const rx = nx * v.cos - ny * v.sin;
        const ry = nx * v.sin + ny * v.cos;
        const wx = rx * rx;
        const wy = ry * ry;
        const wz = nz * nz;
        const ix = rx > 0 ? 0 : 1;
        const iy = ry > 0 ? 2 : 3;
        const iz = nz > 0 ? 4 : 5;
        for (let k = 0; k < 3; k++) {
          out[k] = wx * acc[ix * 3 + k] + wy * acc[iy * 3 + k] + wz * acc[iz * 3 + k];
        }
        return true;
      }
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// The probe grid: the same baked light, sampleable at runtime.
//
// Static geometry gets its probe irradiance baked per vertex (below). A PLAYER
// moves, so it cannot. CS2 answers this by sampling the same probe volumes per
// entity per frame; this grid is that, resampled onto a regular lattice so the
// browser needs neither the 12 MB atlas nor the volume hierarchy.
//
// One cell holds an ambient cube: six irradiance values, one per axis
// direction, which is exactly what CS2 stores. A surface with normal n reads
// Σ nᵢ² · cube[axis(nᵢ)] — cheap, and it keeps the directionality that makes a
// body read as lit from the window rather than uniformly tinted.
//
// Stored in SCENE axis order (+x, −x, +y up, −y, +z, −z) so the runtime never
// converts, and as RGBE (three bytes and a shared exponent) because the values
// are HDR and 24 bytes a cell keeps the whole grid under a megabyte.
// ---------------------------------------------------------------------------

/** Scene-space cube directions, as the source-space normals to sample. */
const CUBE_DIRS_SOURCE = [
  [1, 0, 0], // scene +x
  [-1, 0, 0], // scene −x
  [0, 0, 1], // scene +y (up)
  [0, 0, -1], // scene −y
  [0, -1, 0], // scene +z
  [0, 1, 0] // scene −z
];

/**
 * Resample the probe volumes onto a regular grid over their union.
 *
 * Cells outside every volume (the union AABB is a superset, and volumes have
 * gaps) are filled by dilating their covered neighbours, so a body that steps
 * a little outside the authored coverage keeps the light of the place it just
 * left instead of going black.
 */
function bakeProbeGrid(probes, cellSize, worldBox) {
  const { min, max } = probes.bounds;
  // Source (x, y, z) → scene (x, z, −y): the grid is indexed in scene axes so
  // the runtime can address it with a body's own position.
  let sMin = [min[0], min[2], -max[1]];
  let sMax = [max[0], max[2], -min[1]];
  // Clipped to the world: CS2's volumes reach a long way past the playable map
  // (Nuke's union is half again the size of its geometry), and every cell out
  // there is one nothing can ever stand in.
  if (worldBox) {
    const pad = cellSize;
    sMin = sMin.map((v, i) => Math.max(v, worldBox.min[i] - pad));
    sMax = sMax.map((v, i) => Math.min(v, worldBox.max[i] + pad));
    for (let i = 0; i < 3; i++) if (sMax[i] < sMin[i]) sMax[i] = sMin[i];
  }
  const dims = [0, 1, 2].map((i) => Math.max(1, Math.ceil((sMax[i] - sMin[i]) / cellSize) + 1));
  const cells = dims[0] * dims[1] * dims[2];
  const cellBytes = 6 * RGBE_BYTES;
  const data = Buffer.alloc(cells * cellBytes);
  const covered = new Uint8Array(cells);
  const out = [0, 0, 0];
  let hit = 0;
  for (let iz = 0; iz < dims[2]; iz++) {
    for (let iy = 0; iy < dims[1]; iy++) {
      for (let ix = 0; ix < dims[0]; ix++) {
        const sx = sMin[0] + ix * cellSize;
        const sy = sMin[1] + iy * cellSize;
        const sz = sMin[2] + iz * cellSize;
        // Back to source space for the sampler.
        const px = sx;
        const py = -sz;
        const pz = sy;
        const cell = (iz * dims[1] + iy) * dims[0] + ix;
        let any = false;
        for (let c = 0; c < 6; c++) {
          const d = CUBE_DIRS_SOURCE[c];
          if (probes.sample(px, py, pz, d[0], d[1], d[2], out)) {
            encodeRgbe(out[0], out[1], out[2], data, cell * cellBytes + c * RGBE_BYTES);
            any = true;
          }
        }
        if (any) {
          covered[cell] = 1;
          hit++;
        }
      }
    }
  }
  // Dilate into the gaps: repeated 6-neighbour fills from covered cells.
  const at = (x, y, z) => (z * dims[1] + y) * dims[0] + x;
  for (let pass = 0; pass < 8; pass++) {
    const grew = [];
    for (let iz = 0; iz < dims[2]; iz++) {
      for (let iy = 0; iy < dims[1]; iy++) {
        for (let ix = 0; ix < dims[0]; ix++) {
          const cell = at(ix, iy, iz);
          if (covered[cell]) continue;
          const n = [
            ix > 0 && at(ix - 1, iy, iz),
            ix < dims[0] - 1 && at(ix + 1, iy, iz),
            iy > 0 && at(ix, iy - 1, iz),
            iy < dims[1] - 1 && at(ix, iy + 1, iz),
            iz > 0 && at(ix, iy, iz - 1),
            iz < dims[2] - 1 && at(ix, iy, iz + 1)
          ].filter((c) => c !== false && covered[c] === 1);
          if (n.length) grew.push([cell, n[0]]);
        }
      }
    }
    if (!grew.length) break;
    for (const [cell, from] of grew) {
      data.copy(data, cell * cellBytes, from * cellBytes, from * cellBytes + cellBytes);
      covered[cell] = 2;
    }
    for (let i = 0; i < cells; i++) if (covered[i] === 2) covered[i] = 1;
  }
  return { data, dims, min: sMin, cell: cellSize, cells, hit };
}

/**
 * Bake the probe irradiance into every vertex that has no lightmap chart.
 *
 * Per vertex rather than per prop: a tile is a whole material inside a 1024u
 * cell, so one value each would band along the cell edges and light a pipe
 * running from indoors to outdoors as if it were entirely in one or the other.
 * Positions are scene space by this point (bakeNodeTransforms has run), so both
 * they and the normals go back to Source's z-up frame to meet the entities.
 */
function bakeProbeAmbient(doc, lmByMat, probes) {
  const out = new Float64Array(3);
  let baked = 0;
  let missed = 0;
  let peak = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      // Charted geometry has the lightmap; only the rest needs this, and
      // baking it everywhere costs 30 MB of geometry nothing reads.
      const lm = lmByMat.get(prim.getMaterial());
      if (lm && lm.lm > 0) continue;
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      if (!pos) continue;
      const n = pos.getCount();
      const amb = new Float32Array(n * 3);
      const p = [];
      const q = [0, 1, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, p);
        if (nrm) nrm.getElement(i, q);
        // scene (x, y, z) -> source (x, -z, y); see shared/sim3d/units.js.
        if (probes.sample(p[0], -p[2], p[1], q[0], -q[2], q[1], out)) baked++;
        else {
          out[0] = out[1] = out[2] = 0;
          missed++;
        }
        amb[i * 3] = out[0];
        amb[i * 3 + 1] = out[1];
        amb[i * 3 + 2] = out[2];
        if (out[0] > peak) peak = out[0];
        if (out[1] > peak) peak = out[1];
        if (out[2] > peak) peak = out[2];
      }
      prim.setAttribute('_AMB', doc.createAccessor().setType('VEC3').setArray(amb));
    }
  }
  return { baked, missed, peak };
}

/**
 * Per-vertex sun visibility for chartless geometry: 1 in daylight, 0 occluded.
 *
 * Charted world geometry gets this from `shadowmask.webp`, a 4096² atlas the
 * game baked. Props have no chart, so until now they were the only things in
 * the map still relying on the runtime shadow map to be blocked — and it leaks.
 * A single ortho cascade with `normalBias = 2.5` units pushes the lookup off
 * thin geometry entirely, so cables and conduit indoors sampled lit and glowed
 * as the sun scaled up, while the wall behind them stayed correctly dark.
 *
 * Occluders are every world triangle, charted or not, which is what makes the
 * roof over an indoor prop count. Rays that leave the map hit nothing and read
 * as full sun, so anything outside a building is unaffected.
 *
 * This is per VERTEX, so it resolves at the density of the mesh: excellent at
 * the question that actually matters ("is this prop under a roof"), and poor at
 * a crisp shadow edge across a large low-poly prop, which smears over the span
 * between its corners instead. That trade is deliberate.
 */
function bakeSunVisibility(doc, lmByMat, sunDir, THREE, MeshBVH) {
  // ---- occluder set: every triangle in the world, flattened to a soup ------
  let triTotal = 0;
  const prims = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      prims.push({ prim, pos, idx, count });
      triTotal += Math.floor(count / 3);
    }
  }
  const verts = new Float32Array(triTotal * 9);
  let w = 0;
  const v = [];
  for (const { pos, idx, count } of prims) {
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        pos.getElement(idx ? idx.getScalar(i + k) : i + k, v);
        verts[w++] = v[0];
        verts[w++] = v[1];
        verts[w++] = v[2];
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  const bvh = new MeshBVH(geo, { targetLeafSize: 8 });

  // ---- toward the sun, with a small cone for a soft edge -------------------
  // sun.dir is the direction the light travels, so the ray runs against it.
  const L = new THREE.Vector3(-sunDir[0], -sunDir[1], -sunDir[2]).normalize();
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  t1.set(0, 1, 0);
  if (Math.abs(L.dot(t1)) > 0.9) t1.set(1, 0, 0);
  t2.crossVectors(L, t1).normalize();
  t1.crossVectors(t2, L).normalize();
  // ~2.5°: wider than the real sun, but this is sampled 4×, and a per-vertex
  // term wants its penumbra from the cone rather than from mesh density.
  const SPREAD = 0.044;
  const taps = [
    [0, 0],
    [SPREAD, 0],
    [-SPREAD * 0.5, SPREAD * 0.87],
    [-SPREAD * 0.5, -SPREAD * 0.87]
  ];
  const dirs = taps.map(([a, b]) =>
    new THREE.Vector3().copy(L).addScaledVector(t1, a).addScaledVector(t2, b).normalize()
  );

  const ray = new THREE.Ray();
  const origin = new THREE.Vector3();
  let baked = 0;
  let lit = 0;
  let skipped = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const lm = lmByMat.get(prim.getMaterial());
      if (lm && lm.lm > 0) continue; // charted: the atlas already has it
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      if (!pos) continue;
      const n = pos.getCount();
      const vis = new Float32Array(n);
      const p = [];
      const q = [0, 1, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, p);
        if (nrm) nrm.getElement(i, q);
        // Facing away from the sun: N·L kills the term in the shader anyway,
        // so the ray would be wasted. About a third of every mesh.
        const nDotL = q[0] * L.x + q[1] * L.y + q[2] * L.z;
        if (nDotL <= 0) {
          vis[i] = 1;
          skipped++;
          continue;
        }
        // Off the surface along the normal, or every ray hits its own triangle.
        origin.set(p[0] + q[0] * 0.5, p[1] + q[1] * 0.5, p[2] + q[2] * 0.5);
        let open = 0;
        for (const d of dirs) {
          ray.set(origin, d);
          if (!bvh.raycastFirst(ray, THREE.DoubleSide, 0, 1e6)) open++;
        }
        vis[i] = open / dirs.length;
        if (vis[i] > 0) lit++;
        baked++;
      }
      prim.setAttribute('_SUN', doc.createAccessor().setType('SCALAR').setArray(vis));
    }
  }
  return { baked, lit, skipped, occluders: triTotal };
}

/**
 * A prim's lightmap chart: the highest TEXCOORD_n (n ≥ 1) that stays inside the
 * atlas, or null when the prim has none. Props are the null case — CS2 lights
 * them from `env_light_probe_volume_atlas`, not the lightmap, so VRF exports
 * them with a material UV and nothing else.
 */
function lightmapUvOf(prim) {
  const sets = prim
    .listSemantics()
    .filter((s) => /^TEXCOORD_\d+$/.test(s))
    .map((s) => Number(s.slice(9)))
    .filter((n) => n >= 1)
    .sort((a, b) => b - a);
  for (const n of sets) {
    const a = prim.getAttribute(`TEXCOORD_${n}`);
    const mn = a.getMin([]);
    const mx = a.getMax([]);
    if (mn[0] < -0.01 || mn[1] < -0.01 || mx[0] > LM_UV_MAX || mx[1] > LM_UV_MAX) continue;
    // A chart that collapses to a point is not a chart. Its UVs sit inside the
    // atlas range — [0, 0] passes every bound above — so the prim was called
    // charted and then sampled ONE texel of the atlas across its whole surface.
    // Where that texel is dark the model renders black, beside an identical
    // instance that got a real chart: 525 prims and 1.4M triangles of Ancient,
    // including the wall and roof trims. Rejected here, they fall through to
    // the chartless path and get the probe bake instead, which is what CS2
    // lights them with anyway.
    //
    // Both axes, not either: a long thin trim can legitimately be one texel
    // wide, and only two prims in Ancient are that shape.
    if (mx[0] - mn[0] < LM_TEXEL && mx[1] - mn[1] < LM_TEXEL) continue;
    return a;
  }
  return null;
}

/**
 * Split every vmat that covers both charted and chartless geometry in two, so
 * each half can be lit the way it was baked.
 *
 * A vmat is shared freely between world brushes (which carry lightmap charts)
 * and prop instances (which do not): `dust_kasbah_wood_planks` is 45% props,
 * `dust_awning_02` 51%. The pack used to give the whole material the majority's
 * verdict, which left the minority sampling one flat spot in the atlas — a
 * third of Dust 2's triangles rendering at a single hardcoded light level,
 * hard-edged against their correctly-baked neighbours. That is the blotchy,
 * patchwork look: whole floor slabs and wall panels a different brightness
 * from the slab beside them, along straight polygon boundaries.
 *
 * The chartless half becomes its own material id, which then falls through to
 * the ordinary prop path (sky probe + the dynamic sun and its shadow map) —
 * the same lighting every unshared prop in the map already gets, and the one
 * CS2 uses for them too. Materials that are wholly one or the other are left
 * alone; only mixed ones are cloned, so the extra draw calls are few.
 */
function splitByLightmapChart(doc) {
  // Counted per VMAT, not per glTF material: VRF emits one glTF material per
  // (vmat, instance tint), and a pack material is the vmat. Counting per glTF
  // material misses the case that matters most — a tint variant that is wholly
  // props, skipped as "already a prop material", then regrouped by name into
  // the same pack material as its charted sibling and mixed all over again.
  const vmatOf = (mat) => String(mat.getExtras()?.vmat?.Name || mat.getName() || '');
  const counts = new Map(); // vmat name → { charted, chartless }
  const prims = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    if (isDisabled(mesh.getExtras())) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat || prim.getMode() !== 4) continue;
      const charted = !!lightmapUvOf(prim);
      const key = vmatOf(mat);
      const c = counts.get(key) || { charted: 0, chartless: 0 };
      c[charted ? 'charted' : 'chartless']++;
      counts.set(key, c);
      if (!charted) prims.push({ prim, mat });
    }
  }
  const twins = new Map();
  let moved = 0;
  for (const { prim, mat } of prims) {
    const c = counts.get(vmatOf(mat));
    if (!c.charted) continue; // wholly chartless: it is already a prop material
    let twin = twins.get(mat);
    if (!twin) {
      twin = mat.clone();
      const extras = { ...(mat.getExtras() || {}) };
      const vmat = { ...(extras.vmat || {}) };
      vmat.Name = `${vmat.Name || mat.getName()}#props`;
      twin.setExtras({ ...extras, vmat });
      twin.setName(`${mat.getName()}#props`);
      twins.set(mat, twin);
    }
    prim.setMaterial(twin);
    moved++;
  }
  return { split: twins.size, moved };
}

/**
 * Per raw primitive, before anything is merged:
 *   - drop prims on non-rendered materials, non-triangles, disabled entities
 *   - TEXCOORD_0 stays the material UV
 *   - the highest TEXCOORD_n (n ≥ 1) that lies inside the atlas range is the
 *     lightmap UV → TEXCOORD_1, pre-multiplied by m_vLightmapUvScale; a prim
 *     without one gets the neutral spot in the atlas's unused strip
 *   - for blend materials, VRF's _TEXCOORD_4.x (the vertex paint) → COLOR_0.r
 *   - everything else goes
 * Every prim ends with the same attribute set per material, which is what
 * lets join() merge a whole material into one primitive and BatchedMesh take
 * every tile of it later.
 */
function normalizePrims(doc, matInfo, { lmScale, lightmapped }) {
  let dropped = 0;
  let disabled = 0;
  let lmPrims = 0;
  let lmTris = 0;
  let allTris = 0;
  const lmByMat = new Map(); // mat → { lm, tris }
  for (const mesh of doc.getRoot().listMeshes()) {
    const dis = isDisabled(mesh.getExtras());
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const info = mat ? matInfo.get(mat) : null;
      if (!info || prim.getMode() !== 4 /* TRIANGLES */ || dis) {
        prim.dispose();
        if (dis) disabled++;
        else dropped++;
        continue;
      }
      const pos = prim.getAttribute('POSITION');
      const count = pos.getCount();
      const idx = prim.getIndices();
      const tris = idx ? idx.getCount() / 3 : count / 3;
      allTris += tris;

      const lmSrc = lightmapped ? lightmapUvOf(prim) : null;
      const lmUv = new Float32Array(count * 2);
      if (lmSrc) {
        const el = [];
        for (let i = 0; i < count; i++) {
          lmSrc.getElement(i, el);
          lmUv[i * 2] = el[0] * lmScale[0];
          lmUv[i * 2 + 1] = el[1] * lmScale[1];
        }
        lmPrims++;
        lmTris += tris;
      } else {
        for (let i = 0; i < count; i++) {
          lmUv[i * 2] = LM_NEUTRAL_UV[0];
          lmUv[i * 2 + 1] = LM_NEUTRAL_UV[1];
        }
      }
      const e = lmByMat.get(mat) || { lm: 0, tris: 0 };
      e.tris += tris;
      if (lmSrc) e.lm += tris;
      lmByMat.set(mat, e);

      // Blend weight → COLOR_0.
      let color = null;
      if (info.blend) {
        color = new Float32Array(count * 4);
        const paint = prim.getAttribute('_TEXCOORD_4') || prim.getAttribute('TEXCOORD_4');
        const el = [];
        for (let i = 0; i < count; i++) {
          let w = 0;
          if (paint) {
            paint.getElement(i, el);
            w = Number.isFinite(el[0]) ? Math.min(1, Math.max(0, el[0])) : 0;
          }
          color[i * 4] = w;
          color[i * 4 + 1] = 0;
          color[i * 4 + 2] = 0;
          color[i * 4 + 3] = 1;
        }
      }

      for (const sem of prim.listSemantics()) {
        if (sem !== 'POSITION' && sem !== 'NORMAL' && sem !== 'TEXCOORD_0') prim.setAttribute(sem, null);
      }
      if (!prim.getAttribute('TEXCOORD_0')) {
        prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(count * 2)));
      }
      if (!prim.getAttribute('NORMAL')) {
        const n = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) n[i * 3 + 1] = 1;
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(n));
      }
      prim.setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(lmUv));
      if (color) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(color));
      for (const t of prim.listTargets()) t.dispose();
      compactPrimitive(prim);
    }
    if (!mesh.listPrimitives().length) mesh.dispose();
  }
  return { dropped, disabled, lmPrims, lmTris, allTris, lmByMat };
}

/** Remove skins, cameras, lights, animations: the world is static geometry here. */
function stripNonGeometry(doc) {
  const root = doc.getRoot();
  for (const n of root.listNodes()) {
    n.setSkin(null);
    n.setCamera(null);
    const light = n.getExtension('KHR_lights_punctual');
    if (light) n.setExtension('KHR_lights_punctual', null);
  }
  for (const s of root.listSkins()) s.dispose();
  for (const a of root.listAnimations()) a.dispose();
  for (const c of root.listCameras()) c.dispose();
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply: out = a * b. */
function mat4Multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** A mesh whose primitives own their accessors (so transforms touch nobody else). */
function deepCloneMesh(doc, mesh) {
  const dst = doc.createMesh(mesh.getName());
  for (const prim of mesh.listPrimitives()) {
    const p = prim.clone();
    for (const sem of p.listSemantics()) p.setAttribute(sem, p.getAttribute(sem).clone());
    if (p.getIndices()) p.setIndices(p.getIndices().clone());
    dst.addPrimitive(p);
  }
  return dst;
}

/**
 * Bake every scene node's transform, then the VRF→scene frame change, into
 * vertex data. VRF keeps mesh data in raw Source units/axes and converts with
 * a node matrix (and join() keeps that convention), so this is where the pack
 * moves from "whatever frame VRF left it in" to Source units, y-up. Nodes end
 * up identity; shared meshes are cloned first so no vertex is transformed twice.
 */
function bakeNodeTransforms(doc) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  for (const node of scene.listChildren()) {
    let mesh = node.getMesh();
    if (!mesh) {
      node.dispose();
      continue;
    }
    const nodeParents = mesh.listParents().filter((p) => p.propertyType === 'Node');
    if (nodeParents.length > 1) {
      mesh = deepCloneMesh(doc, mesh);
      node.setMesh(mesh);
    }
    transformMesh(mesh, mat4Multiply(VRF_TO_SCENE_MAT4, node.getWorldMatrix()));
    node.setMatrix(IDENTITY);
  }
}

function primStats(prim) {
  const idx = prim.getIndices();
  const pos = prim.getAttribute('POSITION');
  const tris = idx ? idx.getCount() / 3 : pos ? pos.getCount() / 3 : 0;
  const verts = pos ? pos.getCount() : 0;
  return { tris, verts, idx: idx ? idx.getCount() : verts };
}

/** Rough uncompressed byte weight of a primitive (for grouping). */
function primBytes(prim) {
  const { tris, verts } = primStats(prim);
  return verts * 32 + tris * 3 * 4;
}

/**
 * Split one primitive into per-cell primitives by triangle centroid on the
 * x/z ground plane. Returns [{mesh, prim}] — the original when it is small
 * enough to leave alone, otherwise fresh single-prim meshes (and the source
 * mesh is disposed).
 */
function splitPrimByCells(doc, mesh, prim, cell) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  if (!pos || !idx) return [{ mesh, prim }];
  const min = pos.getMin([]);
  const max = pos.getMax([]);
  if (max[0] - min[0] < cell * 1.5 && max[2] - min[2] < cell * 1.5) return [{ mesh, prim }];
  const ia = idx.getArray();
  const p = [0, 0, 0];
  const cells = new Map();
  for (let t = 0; t < ia.length; t += 3) {
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      pos.getElement(ia[t + k], p);
      cx += p[0];
      cz += p[2];
    }
    const key = `${Math.floor(cx / 3 / cell)}_${Math.floor(cz / 3 / cell)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(ia[t], ia[t + 1], ia[t + 2]);
  }
  if (cells.size <= 1) return [{ mesh, prim }];
  const out = [];
  const name = mesh.getName();
  for (const [key, list] of cells) {
    const np = prim.clone(); // shares attribute accessors until compacted
    const nidx = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(list));
    np.setIndices(nidx);
    compactPrimitive(np);
    const nm = doc.createMesh(`${name}_c${key}`);
    nm.addPrimitive(np);
    out.push({ mesh: nm, prim: np });
  }
  mesh.dispose();
  prim.dispose();
  return out;
}

function bboxOfPrim(prim) {
  const pos = prim.getAttribute('POSITION');
  if (!pos) return null;
  return { min: pos.getMin([]), max: pos.getMax([]) };
}

function mergeBox(a, b) {
  if (!a) return b ? { min: [...b.min], max: [...b.max] } : null;
  if (!b) return a;
  return {
    min: a.min.map((v, i) => Math.min(v, b.min[i])),
    max: a.max.map((v, i) => Math.max(v, b.max[i]))
  };
}

/** Write a set of single-primitive meshes from `srcDoc` as one compressed GLB. */
async function writeGroupGlb(io, srcDoc, meshes, outFile) {
  const dst = quietDoc(new Document());
  dst.createExtension(KHRMeshQuantization).setRequired(true);
  dst.createExtension(EXTMeshoptCompression).setRequired(true);
  const buffer = dst.createBuffer();
  const scene = dst.createScene('map');
  const copied = copyToDocument(dst, srcDoc, meshes);
  for (const m of meshes) {
    const node = dst.createNode(m.getName()).setMesh(copied.get(m));
    scene.addChild(node);
  }
  for (const acc of dst.getRoot().listAccessors()) acc.setBuffer(buffer);
  for (const mat of dst.getRoot().listMaterials()) {
    // Names only; the loader owns textures.
    mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null).setEmissiveTexture(null);
  }
  await dst.transform(
    // Position 16 bits over the whole map (~0.25 u on a 16k-unit map),
    // normals 8-bit oct; texcoords quantize only when inside [0,1] (the
    // library skips tiled UV ranges itself, so they survive as float), so
    // the lightmap UVs quantize and the material UVs mostly do not; colours
    // (the blend weight) go to 8 bits.
    meshopt({
      encoder: MeshoptEncoder,
      level: 'medium',
      quantizePosition: 16,
      quantizeNormal: 8,
      quantizeTexcoord: 16,
      quantizeColor: 8
    }),
    // keepAttributes: the materials here have no textures on purpose, and
    // prune's default would take that as licence to delete every UV set.
    prune({ keepAttributes: true })
  );
  const glb = await io.writeBinary(dst);
  await fsp.writeFile(outFile, glb);
  return glb.length;
}

// ---------------------------------------------------------------------------
// One world (the map, or its 3D skybox) → tiles + textures + manifest rows
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.worldGlb  VRF world export
 * @param {TextureBundle} o.bundle  shared across worlds
 * @param {number} o.idBase   first material id to use
 * @param {number[]} o.lmScale  m_vLightmapUvScale
 * @param {boolean} o.lightmapped  false for the skybox (its charts are not in our atlas)
 * @param {string} o.label
 */
async function packWorld({ io, worldGlb, bundle, idBase, lmScale, lightmapped, label, probes, sunDir }) {
  let probeStats = null;
  let sunStats = null;
  const doc = quietDoc(await io.read(worldGlb));
  const root = doc.getRoot();
  const stats = {
    rawMeshes: root.listMeshes().length,
    rawMaterials: root.listMaterials().length,
    rawTextures: root.listTextures().length
  };
  console.log(`  ${label}: ${stats.rawMeshes} meshes, ${stats.rawMaterials} materials, ${stats.rawTextures} textures`);

  // Materials: classify, then rename to stable ids so the loader can match.
  //
  // VRF emits one glTF material per (vmat, instance tint): a prop's
  // rendercolor becomes the material's baseColorFactor, so Dust 2 has 715
  // materials for 277 vmats. Textures, flags and shading are per vmat, so
  // that is what a pack material is; the tint stays on the glTF material of
  // each tile (the loader reads it as a per-tile batch colour), and join()
  // keeps tint variants apart because they are still distinct material objects.
  // Before grouping: a vmat that covers both charted and chartless geometry
  // becomes two, so the chartless half gets the prop path instead of one flat
  // spot in the atlas.
  if (lightmapped) {
    const sp = splitByLightmapChart(doc);
    if (sp.split) console.log(`  ${label} lighting split: ${sp.split} vmat(s) → a props twin, ${sp.moved} chartless prim(s) moved`);
  }
  const matInfo = new Map(); // VRF material → { id, ...cls }
  const byVmat = new Map(); // vmat name → { id, cls, mats }
  for (const mat of root.listMaterials()) {
    const cls = classifyMaterial(mat);
    if (!cls) continue;
    let g = byVmat.get(cls.name);
    if (!g) {
      g = { id: idBase + byVmat.size, cls, mats: [] };
      byVmat.set(cls.name, g);
    }
    g.mats.push(mat);
    matInfo.set(mat, { id: g.id, ...cls });
  }
  const materials = [...byVmat.values()];
  stripNonGeometry(doc);
  const norm = normalizePrims(doc, matInfo, { lmScale, lightmapped });
  console.log(
    `  ${label} prims: dropped ${norm.dropped} (tools/non-triangle), ${norm.disabled} on disabled entities; ` +
      `lightmap uv on ${norm.lmPrims} prims (${Math.round((100 * norm.lmTris) / Math.max(1, norm.allTris))}% of tris)`
  );
  await doc.transform(flatten(), join({ keepNamed: false, keepMeshes: false }), weld());
  bakeNodeTransforms(doc);
  console.log(`  ${label} join: ${root.listMeshes().length} meshes after merging by material`);
  // Positions are scene space now, which is what the probe bake needs.
  if (probes) {
    const t0 = Date.now();
    const r = bakeProbeAmbient(doc, norm.lmByMat, probes);
    console.log(
      `  ${label} probes: baked ${r.baked} vertices from ${probes.volumes} volumes` +
        `${r.missed ? `, ${r.missed} outside every volume` : ''}, peak ${r.peak.toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    probeStats = r;
  }
  // Sun visibility rides with the probe bake: both answer "what light reaches
  // this vertex" for the geometry the lightmap never covered, and both need
  // positions already in scene space.
  if (probes && sunDir) {
    const t0 = Date.now();
    // Namespace import: three's ESM build has no default export.
    const [THREE, { MeshBVH }] = await Promise.all([import('three'), import('three-mesh-bvh')]);
    const r = bakeSunVisibility(doc, norm.lmByMat, sunDir, THREE, MeshBVH);
    console.log(
      `  ${label} sun: baked ${r.baked} vertices against ${r.occluders} occluders ` +
        `(${r.skipped} back-facing skipped), ${Math.round((100 * r.lit) / Math.max(1, r.baked))}% see sun, ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    sunStats = r;
  }

  // Textures: resolved from the vmat's own slots (see the section comment
  // above texFile) against the PNGs VRF wrote next to world.glb.
  const rawTexDir = path.dirname(worldGlb);
  const texBundle = bundle.for(rawTexDir);
  const manifestMaterials = [];
  const matById = new Map();
  // Request in triangle order so the bundle streams big surfaces first.
  const trisById = new Map();
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const info = matInfo.get(p.getMaterial());
    if (info) trisById.set(info.id, (trisById.get(info.id) || 0) + primStats(p).tris);
  }
  materials.sort((a, b) => (trisById.get(b.id) || 0) - (trisById.get(a.id) || 0));
  // Texture budget by importance: the third of materials carrying the most
  // triangles (and anything over 20k) get the full sizes; the long tail of
  // small props gets half. Inferno's bundle drops from 93 MB to ~55 MB and
  // nothing you can walk up to loses detail.
  const bigCut = Math.max(1, Math.floor(materials.length * 0.34));
  materials.forEach((m, i) => (m.big = i < bigCut || (trisById.get(m.id) || 0) >= 20000));
  for (const { id, mats, cls, big } of materials) {
    const texBase = big ? TEX_BASE : Math.max(256, TEX_BASE >> 1);
    const texNormal = big ? TEX_NORMAL : Math.max(128, TEX_NORMAL >> 1);
    const texOrm = big ? TEX_ORM : Math.max(128, TEX_ORM >> 1);
    const tp = cls.tex || {};
    const colorPng = cls.water ? null : pickTex(rawTexDir, tp, SLOT_COLOR, { allowDefault: true });
    const normalPng = WANT_NORMAL ? pickTex(rawTexDir, tp, SLOT_NORMAL) : null;
    const aoPng = pickTex(rawTexDir, tp, SLOT_AO);
    const metalPng = pickTex(rawTexDir, tp, SLOT_METAL);
    // Roughness rides in the normal map's alpha, so the ORM needs the normal
    // even when the material has no normal map slot of its own.
    const roughSrc = pickTex(rawTexDir, tp, SLOT_NORMAL, { allowDefault: true });
    const color2Png = cls.blend ? pickTex(rawTexDir, tp, SLOT_COLOR2) : null;
    const normal2Png = cls.blend && WANT_NORMAL ? pickTex(rawTexDir, tp, SLOT_NORMAL2) : null;
    // Height maps: the blend threshold on a two-layer material, and on the
    // csgo_environment family the tint mask (height.g) even with one layer.
    const h1 = cls.blend || cls.envTint ? pickTex(rawTexDir, tp, SLOT_HEIGHT1) : null;
    const h2 = cls.blend ? pickTex(rawTexDir, tp, SLOT_HEIGHT2) : null;
    const modPng = cls.blend ? pickTex(rawTexDir, tp, SLOT_BLENDMOD) : null;
    const illumPng = cls.selfIllum ? pickTex(rawTexDir, tp, SLOT_SELFILLUM) : null;
    const tintMaskPng = cls.tintMask ? pickTex(rawTexDir, tp, SLOT_TINTMASK) : null;
    // Sequential per material on purpose: the bundle order is the stream order.
    // Only a cut-out or blended material reads the albedo's alpha as opacity;
    // for everything else the channel is a mask we do not use, and shipping it
    // costs the RGB underneath it (see TextureBundle.color).
    const wantAlpha = cls.alphaMode !== 'OPAQUE';
    const b = await texBundle.color(colorPng, texBase, wantAlpha);
    const n = await texBundle.normal(normalPng, texNormal);
    const o = WANT_ORM ? await texBundle.orm({ ao: aoPng, normal: roughSrc, metal: metalPng }, texOrm) : null;
    const b2 = color2Png ? await texBundle.color(color2Png, texBase, wantAlpha) : null;
    const n2 = normal2Png ? await texBundle.normal(normal2Png, texNormal) : null;
    const hb = cls.blend && (h1 || h2) ? await texBundle.heights({ h1, h2 }) : null;
    const bm = await texBundle.blendMod(modPng);
    const si = illumPng ? await texBundle.mask(illumPng, texOrm) : null;
    // csgo_environment: the tint mask is the HEIGHT map's green channel, per
    // layer (see envTint in classifyMaterial). Everything else has a dedicated
    // mask texture, channel 0. A constant-white height.g comes back null from
    // mask() and means "fully masked in"; no height map at all means the
    // shader's default grey, 0.5 — the two are told apart by envMask*Const.
    const tm = cls.envTint ? (h1 ? await texBundle.mask(h1, texOrm, 1) : null) : tintMaskPng ? await texBundle.mask(tintMaskPng, texOrm) : null;
    const tm2 = cls.envTint && cls.blend && h2 ? await texBundle.mask(h2, texOrm, 1) : null;
    const envMask1Const = cls.envTint && tm === null ? (h1 ? 1 : 0.5) : undefined;
    const envMask2Const = cls.envTint && cls.blend && tm2 === null ? (h2 ? 1 : 0.5) : undefined;
    const em = cls.effect ? await texBundle.effectMasks(SLOT_EMASK.map((s) => pickTex(rawTexDir, tp, s)), texOrm) : null;
    const baseEntry = b !== null ? bundle.entry(b) : null;
    // A cut-out material whose colour map turned out to be fully opaque has
    // nothing to cut; leaving it as MASK just costs a shader branch.
    // An effect card keeps its blend even when its colour map turned out
    // opaque: the masks, not the map's alpha, are what shape it.
    const alphaMode =
      !cls.effect && cls.alphaMode !== 'OPAQUE' && baseEntry && !baseEntry.alpha ? 'OPAQUE' : cls.alphaMode;
    const lm = { lm: 0, tris: 0 };
    for (const mat of mats) {
      const e = norm.lmByMat.get(mat);
      if (e) {
        lm.lm += e.lm;
        lm.tris += e.tris;
      }
    }
    const m = {
      id,
      name: cls.name,
      shader: cls.shader,
      alphaMode,
      alphaCutoff: alphaMode === 'MASK' ? Math.round((cls.alphaCutoff ?? 0.5) * 1000) / 1000 : undefined,
      doubleSided: cls.doubleSided || undefined,
      decal: cls.decal || undefined,
      unlit: cls.unlit || undefined,
      water: cls.water || undefined,
      glass: cls.glass || undefined,
      color: cls.tint || [1, 1, 1],
      // Shallow water/puddles are a wet sheen over the ground; canals and
      // rivers hide their bed.
      opacity: cls.water ? (/shallow|puddle/i.test(cls.name) ? 0.25 : 0.5) : cls.glass ? cls.glassOpacity : 1,
      roughness: cls.water ? 0.08 : cls.glass ? cls.glassRoughness : 1,
      metalness: o !== null ? 1 : 0,
      // Self-illumination, as the vmat authored it: which parts glow (mask),
      // in what colour (tint, and whether the albedo shows through), how hard.
      // The first pass emitted a flat white [1,1,1] here for anything with
      // F_SELF_ILLUM set, which turned Nuke's vending machines and Train's
      // and Overpass' two dozen lit props into featureless white boxes.
      emissive: cls.selfIllum ? cls.selfIllum.tint : undefined,
      emissiveIntensity: cls.selfIllum ? cls.selfIllum.intensity : undefined,
      emissiveMask: si ?? undefined,
      emissiveAlbedo: cls.selfIllum ? cls.selfIllum.albedoFactor : undefined,
      base: b ?? undefined,
      normal: n ?? undefined,
      orm: o ?? undefined,
      // Where the per-tile instance tint is allowed to land. Absent = the whole
      // surface takes it, which is the majority of materials.
      tintMask: tm ?? undefined,
      // csgo_environment's per-layer albedo adjust, and how hard the tint mask
      // is driven. Absent on csgo_complex, which has no such parameters.
      cc1: cls.cc1,
      cc2: cls.cc2,
      tintMaskBright: cls.tintMaskBright,
      // csgo_environment's luminance-preserving tint (see classifyMaterial).
      // The per-layer masks ride in tintMask / blend.tintMask; a layer with no
      // mask texture carries its constant here instead.
      envTint: cls.envTint
        ? { ...cls.envTint, l1: { ...cls.envTint.l1, const: envMask1Const }, l2: cls.envTint.l2 ? { ...cls.envTint.l2, const: envMask2Const } : undefined }
        : undefined,
      effect: cls.effect ? { ...cls.effect, masks: em !== null ? cls.effect.masks : undefined, maskTex: em ?? undefined } : undefined,
      // Layer 2 of a blend shader, plus how it is mixed in.
      blend: cls.blend
        ? {
            base: b2 ?? undefined,
            normal: n2 ?? undefined,
            heights: hb ?? undefined,
            mod: bm ?? undefined,
            scale2: cls.blendScale2,
            softness: cls.blendSoftness,
            // Layer 2's own tint mask (csgo_environment keeps one per layer).
            tintMask: tm2 ?? undefined
          }
        : undefined,
      // Materials whose geometry carries lightmap charts get the baked
      // irradiance instead of the sky probe. A material split between world
      // brushes and props takes the majority's word.
      lightmapped: !!(lightmapped && !cls.water && lm.tris && lm.lm >= lm.tris * 0.5) || undefined,
      avg: baseEntry?.avg || [128, 128, 128],
      wrap: 'repeat',
      tris: 0,
      verts: 0,
      idx: 0,
      tiles: 0
    };
    for (const mat of mats) mat.setName(`m${id}`);
    manifestMaterials.push(m);
    matById.set(id, m);
  }
  // The loader indexes manifest.materials by id; the request order above was
  // only for the bundle.
  manifestMaterials.sort((a, b) => a.id - b.id);
  // Geometry GLBs carry material names only; drop the images from the source
  // doc now so copyToDocument never drags a texture into a group file.
  for (const mat of root.listMaterials()) {
    mat.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null);
    mat.setOcclusionTexture(null).setEmissiveTexture(null);
  }
  for (const t of root.listTextures()) t.dispose();

  // Geometry tiles: one single-prim mesh per material, then cut wide ones.
  let singles = [];
  for (const mesh of root.listMeshes()) {
    const prims = mesh.listPrimitives();
    if (!prims.length) continue;
    if (prims.length === 1) singles.push({ mesh, prim: prims[0] });
    else {
      for (const prim of prims) {
        const m2 = doc.createMesh(mesh.getName());
        mesh.removePrimitive(prim);
        m2.addPrimitive(prim);
        singles.push({ mesh: m2, prim });
      }
      mesh.dispose();
    }
  }
  // A material that spans the map is one draw call that can never be
  // frustum-culled, in the main pass and again in the shadow pass. Cut the
  // wide ones into CELL-sized tiles so most of the map is skipped per frame;
  // small props stay whole.
  const beforeSplit = singles.length;
  const split = [];
  for (const s of singles) split.push(...splitPrimByCells(doc, s.mesh, s.prim, CELL_SIZE));
  singles = split;
  console.log(`  ${label} cells: ${beforeSplit} material meshes → ${singles.length} tiles (${CELL_SIZE}u cells)`);
  // Recentre after the split, not before: a merged aggregate mesh can span
  // tens of thousands of tiles internally, so centring the whole thing leaves
  // half of it just as far out. One spatial cell's worth of wall has a local
  // UV range, and that is what fits in float32.
  const uv = recenterUVs(doc);
  const vertsBeforeWeld = singles.reduce((a, s) => a + primStats(s.prim).verts, 0);
  // Re-weld: recentring split every triangle apart; the ones that landed on
  // identical values (nearly all of them) merge straight back.
  await doc.transform(weld());
  const vertsAfterWeld = singles.reduce((a, s) => a + primStats(s.prim).verts, 0);
  console.log(
    `  ${label} uv: recentred ${uv.shifted} far-flung tile(s) per triangle (${uv.unwelded} tris, ` +
      `largest offset ${uv.worst}); weld ${vertsBeforeWeld} → ${vertsAfterWeld} verts`
  );
  for (const s of singles) {
    const mat = s.prim.getMaterial();
    const info = mat ? matInfo.get(mat) : null;
    s.matId = info ? info.id : -1;
    s.bytes = primBytes(s.prim);
    s.stats = primStats(s.prim);
    s.box = bboxOfPrim(s.prim);
    if (info) {
      const mm = matById.get(info.id);
      mm.tris += s.stats.tris;
      mm.verts += s.stats.verts;
      mm.idx += s.stats.idx;
      mm.tiles++;
    }
  }
  singles.sort((a, b) => b.bytes - a.bytes);
  const worldBox = getBounds(root.getDefaultScene() || root.listScenes()[0]);
  return { doc, io, singles, materials: manifestMaterials, stats, worldBox };
}

/** Group tiles biggest-first and write geo/gNN.glb files; returns manifest rows. */
async function writeGroups(io, world, outDir, subdir) {
  const groups = [];
  let cur = null;
  for (const s of world.singles) {
    if (!cur || (cur.bytes + s.bytes > GROUP_TARGET_BYTES && cur.items.length)) {
      cur = { items: [], bytes: 0 };
      groups.push(cur);
    }
    cur.items.push(s);
    cur.bytes += s.bytes;
  }
  await fsp.mkdir(path.join(outDir, subdir), { recursive: true });
  const rows = [];
  let totalTris = 0;
  let totalVerts = 0;
  let geoBytes = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const file = `${subdir}/g${String(i).padStart(2, '0')}.glb`;
    const bytes = await writeGroupGlb(
      io,
      world.doc,
      g.items.map((s) => s.mesh),
      path.join(outDir, file)
    );
    let box = null;
    let tris = 0;
    let verts = 0;
    for (const s of g.items) {
      box = mergeBox(box, s.box);
      tris += s.stats.tris;
      verts += s.stats.verts;
    }
    totalTris += tris;
    totalVerts += verts;
    geoBytes += bytes;
    rows.push({
      file,
      bytes,
      tris,
      materials: [...new Set(g.items.map((s) => s.matId))],
      box: box ? { min: box.min.map(Math.floor), max: box.max.map(Math.ceil) } : null
    });
    process.stdout.write(`\r  ${subdir}: ${i + 1}/${groups.length} groups, ${(geoBytes / 1e6).toFixed(1)} MB`);
  }
  console.log('');
  return { rows, tris: totalTris, verts: totalVerts, bytes: geoBytes };
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

/** Collision kind from a VRF physics node name. */
function physKind(nodeName) {
  const n = String(nodeName || '');
  if (/grenadeclip/.test(n)) return 'grenadeclip';
  if (/^physics_ladder/.test(n)) return 'ladder';
  if (/^physics_sky/.test(n)) return 'sky';
  if (/playerclip|npcclip/.test(n)) return 'playerclip';
  if (/^physics_passbullets/.test(n)) return 'solid';
  if (/^physics_group/.test(n)) return 'solid';
  return null;
}

/** Entity physics from the world export: brush entities and dynamic props players collide with. */
const ENTITY_SOLID_RE = /^(func_brush|prop_dynamic|prop_dynamic_override|func_breakable|func_wall|func_detail)$/;
const TRIGGER_RE = /^(func_bomb_target|func_buyzone)$/;

function applyMat4(m, [x, y, z]) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}

/** Source origin → the VRF glTF frame (metres, x=source y, y=source z, z=source x). */
const K_VRF = 0.0254;
const srcToVrf = ([x, y, z]) => [y * K_VRF, z * K_VRF, x * K_VRF];

async function packPhysics(io, { physGlb, entPhysGlb, disabledOrigins, out }) {
  const pdoc = quietDoc(await io.read(physGlb));
  const proot = pdoc.getRoot();
  const physKinds = {};
  for (const n of proot.listNodes()) {
    const kind = physKind(n.getName());
    const mesh = n.getMesh();
    if (!kind || !mesh) {
      n.dispose();
      if (mesh) mesh.dispose();
      continue;
    }
    n.setExtras({ kind, surface: n.getExtras()?.SurfaceProperty || null });
    physKinds[kind] = (physKinds[kind] || 0) + 1;
  }
  // Entity physics: solid brush entities + dynamic props from the world export.
  const triggers = { bombsites: [], buyzones: [] };
  let disabledSkipped = 0;
  if (fs.existsSync(entPhysGlb)) {
    const edoc = quietDoc(await io.read(entPhysGlb));
    const eroot = edoc.getRoot();
    const keep = [];
    const disabledVrf = disabledOrigins.map(srcToVrf);
    for (const n of eroot.listNodes()) {
      const cls = n.getName();
      const mesh = n.getMesh();
      if (!mesh) continue;
      if (TRIGGER_RE.test(cls)) {
        // Box in the VRF frame → our frame via the same matrix.
        const box = getBounds(n);
        const corners = [];
        for (const x of [box.min[0], box.max[0]])
          for (const y of [box.min[1], box.max[1]])
            for (const z of [box.min[2], box.max[2]]) corners.push(applyMat4(VRF_TO_SCENE_MAT4, [x, y, z]));
        const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i])));
        const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i])));
        (cls === 'func_bomb_target' ? triggers.bombsites : triggers.buyzones).push({ min, max });
        continue;
      }
      if (!ENTITY_SOLID_RE.test(cls)) continue;
      // The physics export carries no keyvalues, so a disabled entity is
      // recognised by its origin (the node's translation, in VRF metres).
      const t = n.getTranslation();
      if (disabledVrf.some((d) => Math.hypot(d[0] - t[0], d[1] - t[1], d[2] - t[2]) < 0.05)) {
        disabledSkipped++;
        continue;
      }
      keep.push(n);
    }
    if (keep.length) {
      const meshes = keep.map((n) => n.getMesh());
      const copied = copyToDocument(pdoc, edoc, meshes);
      const scene = proot.listScenes()[0];
      keep.forEach((n, i) => {
        const nn = pdoc.createNode(n.getName()).setMesh(copied.get(meshes[i]));
        nn.setMatrix(n.getMatrix());
        nn.setExtras({ kind: 'entity', surface: n.getExtras()?.SurfaceProperty || null, classname: n.getName() });
        scene.addChild(nn);
      });
      physKinds.entity = keep.length;
    }
  }
  for (const mesh of proot.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const sem of prim.listSemantics()) if (sem !== 'POSITION') prim.setAttribute(sem, null);
      compactPrimitive(prim);
    }
  }
  for (const m of proot.listMaterials()) m.dispose();
  for (const t of proot.listTextures()) t.dispose();
  await pdoc.transform(flatten(), weld());
  bakeNodeTransforms(pdoc);
  const pdst = quietDoc(new Document());
  pdst.createExtension(KHRMeshQuantization).setRequired(true);
  pdst.createExtension(EXTMeshoptCompression).setRequired(true);
  const pbuf = pdst.createBuffer();
  const pscene = pdst.createScene('phys');
  const pmeshes = proot.listNodes().filter((n) => n.getMesh()).map((n) => n.getMesh());
  const pnodes = proot.listNodes().filter((n) => n.getMesh());
  const pcopied = copyToDocument(pdst, pdoc, pmeshes);
  pnodes.forEach((n, i) => {
    const nn = pdst.createNode(n.getName()).setMesh(pcopied.get(pmeshes[i])).setExtras(n.getExtras());
    pscene.addChild(nn);
  });
  for (const acc of pdst.getRoot().listAccessors()) acc.setBuffer(pbuf);
  await pdst.transform(
    meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 16 }),
    prune({ keepAttributes: true })
  );
  const physOut = await io.writeBinary(pdst);
  await fsp.writeFile(path.join(out, 'phys.glb'), physOut);
  let physTris = 0;
  for (const m of pdst.getRoot().listMeshes()) for (const p of m.listPrimitives()) physTris += primStats(p).tris;
  console.log(
    `  phys: ${physTris} tris, ${(physOut.length / 1e3).toFixed(0)} KB, kinds ${JSON.stringify(physKinds)}` +
      (disabledSkipped ? `, ${disabledSkipped} disabled entity bodies skipped` : '')
  );
  return { triggers, physTris, physBytes: physOut.length };
}

// ---------------------------------------------------------------------------
// Per-map pack
// ---------------------------------------------------------------------------

/** One texture bundle per pack; `for(rawDir)` gives a view bound to a texture folder. */
class PackTextures extends TextureBundle {
  constructor() {
    super('');
  }
  for(rawDir) {
    const view = Object.create(this);
    view.rawDir = rawDir;
    return view;
  }
  entry(idx) {
    return this.entries[idx] || null;
  }
}

async function packMap(entry) {
  const raw = path.join(RAW_DIR, entry.slug);
  const worldGlb = path.join(raw, 'world', 'maps', entry.file, 'world.glb');
  const entPhysGlb = path.join(raw, 'world', 'maps', entry.file, 'world_physics.glb');
  const physGlb = path.join(raw, 'phys', 'maps', entry.file, 'world_physics_physics.glb');
  const entsTxt = path.join(raw, 'ents', 'maps', entry.file, 'entities', 'default_ents.vents');
  const worldKv3 = path.join(raw, 'world.kv3');
  const lightmapPng = path.join(raw, 'lightmaps', 'irradiance.png');
  const shadowPng = path.join(raw, 'lightmaps', 'direct_light_shadows.png');
  const skyJson = path.join(raw, 'sky', 'sky.json');
  const probeDir = path.join(raw, 'probes');
  // The baked light probes CS2 lights its props with. Sampled per vertex during
  // packWorld, and resampled onto a coarse grid for things that MOVE (players,
  // bots) — the atlas itself never reaches the browser either way.
  let probes = null;
  try {
    probes = makeProbeSampler(probeDir);
  } catch (e) {
    console.warn(`  ! probes: ${e.message}`);
  }
  for (const f of [worldGlb, physGlb, entsTxt]) {
    if (!fs.existsSync(f)) {
      console.warn(`  ! ${entry.slug}: missing ${path.relative(raw, f)}; run cs3d-import.mjs first. Skipped.`);
      return false;
    }
  }
  const out = path.join(PACK_DIR, entry.slug);
  const manifestFile = path.join(out, 'manifest.json');
  let previousSky = null;
  if (fs.existsSync(manifestFile)) {
    try {
      const m = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
      if (!force && m.version === PACK_VERSION) {
        console.log(`  ${entry.slug}: pack v${PACK_VERSION} present, skipping (use --force to redo)`);
        return true;
      }
      // The skybox HDR is made by cs3d-sky.mjs; keep it across re-packs.
      if (m.sky?.equirect && fs.existsSync(path.join(out, m.sky.equirect))) previousSky = m.sky;
    } catch {
      /* rebuild */
    }
  }
  const keepSkyFile = previousSky ? await fsp.readFile(path.join(out, previousSky.equirect)).catch(() => null) : null;
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(path.join(out, 'geo'), { recursive: true });

  const t0 = Date.now();
  const io = makeIO();
  const stats = {};

  // ---- entities -----------------------------------------------------------
  const ents = parseEnts(await fsp.readFile(entsTxt, 'utf8'));
  const meta = extractMeta(ents);
  const worldInfo = parseWorldKv3(fs.existsSync(worldKv3) ? await fsp.readFile(worldKv3, 'utf8') : '');
  const haveLightmap = worldInfo.hasLightmaps && fs.existsSync(lightmapPng);
  console.log(
    `  ents: ${ents.length} entities, ${meta.spawns.T.length} T / ${meta.spawns.CT.length} CT spawns, ` +
      `${meta.disabledOrigins.length} start-disabled; lightmap ${haveLightmap ? `yes (uv scale ${worldInfo.lightmapUvScale[0]})` : 'no'}`
  );

  // ---- world --------------------------------------------------------------
  const bundle = new PackTextures();
  const world = await packWorld({
    io,
    worldGlb,
    bundle,
    idBase: 0,
    lmScale: worldInfo.lightmapUvScale,
    lightmapped: haveLightmap,
    label: 'world',
    probes,
    // Already scene space (y-up, y negative pointing down), same as positions.
    sunDir: meta.sun?.dir
  });
  const geo = await writeGroups(io, world, out, 'geo');
  stats.tris = geo.tris;
  stats.verts = geo.verts;
  stats.geoBytes = geo.bytes;
  stats.groups = geo.rows.length;
  stats.materials = world.materials.length;
  stats.rawMeshes = world.stats.rawMeshes;
  stats.rawMaterials = world.stats.rawMaterials;

  // ---- probe grid ----------------------------------------------------------
  // After the world, because it is clipped to the world's own box. A failure
  // here must not cost the map: without a grid, bodies fall back to the sky
  // probe (the pre-grid behaviour).
  let probeGrid = null;
  if (probes) {
    try {
      const g = bakeProbeGrid(probes, PROBE_GRID_CELL, world.worldBox);
      await fsp.writeFile(path.join(out, 'probegrid.bin'), g.data);
      probeGrid = { file: 'probegrid.bin', min: g.min, cell: g.cell, dims: g.dims, bytes: g.data.length };
      console.log(
        `  probe grid: ${g.dims.join('x')} cells at ${g.cell}u, ${((g.hit / g.cells) * 100).toFixed(0)}% covered by volumes, ` +
          `${(g.data.length / 1e6).toFixed(2)} MB`
      );
    } catch (e) {
      console.warn(`  ! probe grid: ${e.message}`);
    }
  }

  // ---- 3D skybox ----------------------------------------------------------
  let sky3d = null;
  if (fs.existsSync(skyJson)) {
    try {
      const sj = JSON.parse(await fsp.readFile(skyJson, 'utf8'));
      const skyRaw = path.join(raw, 'sky');
      const skyWorldGlb = path.join(skyRaw, 'world', ...sj.target.split('/'), 'world.glb');
      const skyEntsTxt = path.join(skyRaw, 'ents', ...sj.target.split('/'), 'entities', 'default_ents.vents');
      if (fs.existsSync(skyWorldGlb)) {
        const skyEnts = fs.existsSync(skyEntsTxt) ? parseEnts(await fsp.readFile(skyEntsTxt, 'utf8')) : [];
        const cam = skyEnts.find((e) => e.classname === 'sky_camera');
        const ws = skyEnts.find((e) => e.classname === 'worldspawn');
        const skyWorld = await packWorld({
          io,
          worldGlb: skyWorldGlb,
          bundle,
          idBase: world.materials.length,
          lmScale: [1, 1],
          lightmapped: false,
          label: 'sky3d'
        });
        const skyGeo = await writeGroups(io, skyWorld, out, 'sky3d');
        const refOrigin = isVec3(sj.referenceOrigin) ? sj.referenceOrigin : String(sj.referenceOrigin || '').replace(/[[\]]/g, '').split(/[ ,]+/).map(Number);
        sky3d = {
          // world = (v - camOrigin) * scale + refOrigin, all in scene units.
          scale: cam && Number.isFinite(cam.scale) ? cam.scale : SKY_SCALE_DEFAULT,
          camOrigin: srcToScene(cam && isVec3(cam.origin) ? cam.origin : [0, 0, 0]),
          refOrigin: srcToScene(isVec3(refOrigin) ? refOrigin : [0, 0, 0]),
          fog:
            ws && (ws.fogenable === 1 || ws.fogenable === true || ws.fogenable === '1')
              ? {
                  color: isVec3(ws.fogcolor) ? ws.fogcolor.map((c) => c / 255) : [0.8, 0.8, 0.8],
                  start: Number(ws.fogstart) || 0,
                  end: Number(ws.fogend) || 0
                }
              : null,
          materials: skyWorld.materials,
          groups: skyGeo.rows,
          bounds: { min: skyWorld.worldBox.min.map(Math.floor), max: skyWorld.worldBox.max.map(Math.ceil) },
          stats: { tris: skyGeo.tris, bytes: skyGeo.bytes, groups: skyGeo.rows.length }
        };
        for (const m of skyWorld.materials) m.sky = true; // scenery: no fog, no shadows, sky-probe ambient
        world.materials.push(...skyWorld.materials);
        console.log(`  sky3d: ${skyGeo.tris} tris, ${(skyGeo.bytes / 1e6).toFixed(1)} MB, scale ${sky3d.scale}`);
      }
    } catch (e) {
      console.warn(`  ! sky3d: ${e.message}`);
    }
  }

  // ---- textures -----------------------------------------------------------
  const tex = await bundle.write(path.join(out, 'tex.bin'));
  stats.textures = tex.dir.length;
  stats.textureBytes = tex.bytes;
  console.log(`  tex: ${tex.dir.length} textures, ${(tex.bytes / 1e6).toFixed(1)} MB in tex.bin`);

  // The map's colour grading (cs3d-import pulled it out of pak01). The LUT
  // ships as raw RGBA bytes rather than an image: it is a lookup table, not a
  // picture, and 32³×4 is 128 kB that the browser can hand straight to a
  // Data3DTexture with no decode and no chance of an encoder reinterpreting it.
  let post = null;
  const postDir = path.join(raw, 'post');
  if (fs.existsSync(path.join(postDir, 'post.json'))) {
    try {
      post = JSON.parse(await fsp.readFile(path.join(postDir, 'post.json'), 'utf8'));
      const lutSrc = path.join(postDir, 'lut.bin');
      if (post.lutDim && fs.existsSync(lutSrc)) {
        await fsp.mkdir(path.join(out, 'post'), { recursive: true });
        await fsp.copyFile(lutSrc, path.join(out, 'post', 'lut.bin'));
        post.lut = 'post/lut.bin';
      }
      console.log(
        `  post: ${post.lutDim ? `${post.lutDim}³ LUT` : 'no LUT'}` +
          `${post.tonemap ? `, white point ${post.tonemap.whitePoint.toFixed(3)}` : ''}`
      );
    } catch (e) {
      console.warn(`  ! post: ${e.message}`);
      post = null;
    }
  }

  let lightmap = null;
  let shadowMask = null;
  if (haveLightmap) {
    try {
      const lm = await packLightmap(lightmapPng, path.join(out, 'lightmap.webp'), TEX_LIGHTMAP);
      const r3 = (v) => Math.round(v * 1000) / 1000;
      lightmap = {
        file: 'lightmap.webp',
        size: lm.size,
        bytes: lm.bytes,
        range: lm.range,
        mean: lm.mean.map(r3),
        p50: r3(lm.percentiles.p50),
        p90: r3(lm.percentiles.p90),
        p98: r3(lm.percentiles.p98),
        neutralUv: LM_NEUTRAL_UV,
        encoding: 'rgbm'
      };
      console.log(`  lightmap: ${lm.size}² rgbm webp, ${(lm.bytes / 1e6).toFixed(1)} MB, mean ${lightmap.mean}, p50 ${lightmap.p50}, p90 ${lightmap.p90}, p98 ${lightmap.p98}`);
    } catch (e) {
      console.warn(`  ! lightmap: ${e.message}`);
    }
    if (fs.existsSync(shadowPng)) {
      try {
        const sm = await packShadowMask(shadowPng, path.join(out, 'shadowmask.webp'), TEX_LIGHTMAP);
        shadowMask = {
          file: 'shadowmask.webp',
          size: sm.size,
          bytes: sm.bytes,
          channel: sm.channel,
          encoding: sm.encoding,
          shadowMeans: sm.shadowMeans,
          shadowSds: sm.shadowSds,
          visMean: sm.visMean
        };
        console.log(
          `  shadows: ${sm.size}² visibility webp, ${(sm.bytes / 1e6).toFixed(1)} MB, sun = channel ${'RGB'[sm.channel]}` +
            ` (shadow means ${sm.shadowMeans}, sds ${sm.shadowSds}); ${Math.round(sm.visMean * 100)}% of the atlas in daylight`
        );
      } catch (e) {
        console.warn(`  ! shadows: ${e.message}`);
      }
    } else {
      console.warn('  ! shadows: no direct_light_shadows.png; re-run cs3d-import (world will have no sun)');
    }
  }

  // ---- physics ------------------------------------------------------------
  const phys = await packPhysics(io, { physGlb, entPhysGlb, disabledOrigins: meta.disabledOrigins, out });
  stats.physTris = phys.physTris;
  stats.physBytes = phys.physBytes;

  // Bomb site letters: entity lump order matches designation 0/1 → A/B.
  const sites = phys.triggers.bombsites.map((b, i) => ({
    ...b,
    letter: meta.bombTargets[i] ? (meta.bombTargets[i].designation === '1' ? 'B' : meta.bombTargets[i].designation === '0' ? 'A' : String.fromCharCode(65 + i)) : String.fromCharCode(65 + i)
  }));

  // ---- manifest -----------------------------------------------------------
  let sky = null;
  if (keepSkyFile && previousSky) {
    await fsp.mkdir(path.join(out, path.dirname(previousSky.equirect)), { recursive: true });
    await fsp.writeFile(path.join(out, previousSky.equirect), keepSkyFile);
    sky = previousSky;
  }
  const manifest = {
    version: PACK_VERSION,
    map: { slug: entry.slug, file: entry.file, name: entry.name, code: entry.code },
    frame: 'source-units, y-up: three(x,y,z) = source(x,z,-y)',
    generated: new Date().toISOString(),
    bounds: { min: world.worldBox.min.map(Math.floor), max: world.worldBox.max.map(Math.ceil) },
    spawns: meta.spawns,
    sun: meta.sun,
    exposure: meta.exposure,
    sites,
    buyzones: phys.triggers.buyzones,
    radarBounds: meta.radarBounds,
    bombRadius: meta.bombRadius,
    skyMaterial: meta.skyMaterial,
    skyBrightness: meta.skyBrightness,
    skyYaw: meta.skyYaw,
    fog: meta.fog,
    sky,
    post,
    // Chartless geometry carries baked probe irradiance in its `_AMB` attribute.
    probeAmbient: !!probes,
    // The same light on a lattice, for anything that moves (see bakeProbeGrid).
    probeGrid,
    // ...and baked sun visibility in `_SUN`, so props take the analytic sun the
    // charted world takes rather than the runtime shadow map.
    sunVis: !!(probes && meta.sun?.dir),
    phys: 'phys.glb',
    tex: { file: 'tex.bin', bytes: tex.bytes, dir: tex.dir },
    lightmap,
    shadowMask,
    materials: world.materials,
    groups: geo.rows,
    sky3d,
    stats
  };
  await fsp.writeFile(manifestFile, JSON.stringify(manifest));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  done in ${secs}s: ${stats.tris} tris, ${world.materials.length} materials, ` +
      `${(stats.geoBytes / 1e6).toFixed(1)} MB geo + ${(stats.textureBytes / 1e6).toFixed(1)} MB tex` +
      (lightmap ? ` + ${(lightmap.bytes / 1e6).toFixed(1)} MB lightmap` : '')
  );
  return true;
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  const wanted = only ? cs3dMap(only) : null;
  if (only && !wanted) fail(`unknown map "${only}" (roster: ${CS3D_MAPS.map((m) => m.slug).join(', ')})`);
  const list = wanted ? [wanted] : CS3D_MAPS.filter((m) => fs.existsSync(path.join(RAW_DIR, m.slug)));
  if (!list.length) fail(`nothing to pack under ${RAW_DIR}; run cs3d-import.mjs first`);
  let ok = 0;
  for (const entry of list) {
    console.log(`- ${entry.slug} (${entry.file})`);
    try {
      if (await packMap(entry)) ok++;
    } catch (e) {
      console.error(`  ! ${entry.slug}: ${e.stack || e.message}`);
    }
  }
  console.log(`cs3d-pack: ${ok}/${list.length} map(s) packed into ${path.relative(ROOT, PACK_DIR)}`);
}

main().catch((e) => fail(e.stack || e.message));
