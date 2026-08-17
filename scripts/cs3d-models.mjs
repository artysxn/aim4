#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-models.mjs
// The player pipeline (CS3D-ENGINE-PLAN E-10 + the first slice of E-8): pull
// one T and one CT agent, their hitboxes and the world-model locomotion clips
// out of the game's pak01 with the ValveResourceFormat CLI, and pack them the
// way the maps are packed — a local, gitignored, streamable directory:
//
//   server/data/cs3d/raw/players/          VRF exports (glb + png, ~250 MB)
//   server/data/cs3d/pack/players/         what src/cs3d/playerModels.js loads
//     manifest.json                        models, clip sets, hitboxes, bones
//     tm_phoenix.glb  ctm_sas.glb          third-person body + gloves, skinned,
//                                          webp textures, meshopt
//     anims_rifle.glb  anims_pistol.glb    one glb per clip set: the worldmodel
//     anims_knife.glb  anims_shared.glb    skeleton plus every selected clip as
//     anims_c4.glb                         a glTF animation, retargetable by
//                                          bone name
//
// Three facts about the game files that this script is built around, because
// each cost a probe to learn and none is written down anywhere else:
//
//   1. `characters/models/<agent>.vmdl_c` in pak01 are 4.8 KB STUBS (a 5-unit
//      cube on a "dummy" bone). The real agents live under
//      `agents/models/<agent>/<agent>.vmdl_c` (~560 KB): four mesh groups
//      (thirdperson body / gloves, firstperson arms / sleeves), an 86-bone
//      skeleton, the `cstrike` hitbox set (19 capsules) and a ragdoll PHYS
//      block. Only the third-person half is packed here.
//   2. CS2 no longer animates players through .vanim/.vagrp/.vanmgraph. It is
//      the "Nm" system: `animation/skeletons/characters/worldmodel.vnmskel_c`
//      (74 bones), 2,355 `.vnmclip_c` clips under `animation/anims/world/`
//      (locomotion per weapon class: rifle / pistol / knife, plus shared
//      deaths, flinches, defuse, plant) and `.vnmgraph_c` graphs. VRF 19.2
//      exports an NmClip straight to glb (a skeleton + one animation), which
//      is what makes this pipeline a script rather than a research project.
//      The graphs are behaviour (which clip when, blend weights) and are
//      re-derived in src/cs3d/playerModels.js.
//   3. The model's skeleton and the clip skeleton agree bone for bone in
//      WORLD space, but factor `root_motion` differently: the model puts a
//      120° rotation on root_motion and expresses its children in that frame;
//      the clips leave root_motion at identity. Applied blindly, every clip
//      turns the whole body on its side. `normalizeRootMotion()` rewrites the
//      MODEL to the clip convention (world pose unchanged, so the inverse bind
//      matrices stay valid) and every clip then binds by name with no
//      per-track fix-up.
//
// Clips carry no root motion (m_rootMotion is identity: the game moves the
// entity, the clip runs in place), so `groundSpeed` per locomotion clip is
// measured here from the planted foot's speed and shipped in the manifest;
// the runtime scales playback by actual speed / groundSpeed.
//
// Usage:
//   node scripts/cs3d-models.mjs                # import (if missing) + pack
//   node scripts/cs3d-models.mjs --force        # re-export everything
//   node scripts/cs3d-models.mjs --skip-import  # pack only, from raw/
//   node scripts/cs3d-models.mjs --all-clips    # pack every clip in the sets,
//                                               #   not just the locomotion subset
//   node scripts/cs3d-models.mjs --game "<...>\Counter-Strike Global Offensive\game\csgo"
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Document, NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, resample, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { Quaternion, Vector3, Matrix4 } from 'three';

import { ROOT, fail as failWith, assertLocalOutput, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { dropAlpha, normalIsBlank, roughnessIsEmpty, ROUGHNESS_DEFAULT } from './lib/texAlpha.mjs';

const TAG = 'cs3d-models';
const fail = (msg) => failWith(TAG, msg);

export const PACK_VERSION = 1;
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'players');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', 'players');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const force = flag('--force');
const skipImport = flag('--skip-import');
const allClips = flag('--all-clips');
const threads = Number(opt('--threads') || 8);

// ---- what to pull -----------------------------------------------------------

/** One default agent per side. Cosmetic variety is a non-goal (CS3D-PLAN §2.2). */
const MODELS = [
  { side: 'T', name: 'tm_phoenix', res: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c' },
  { side: 'CT', name: 'ctm_sas', res: 'agents/models/ctm_sas/ctm_sas.vmdl_c' }
];

/**
 * The world-model clip sets. Every path is a folder in pak01; VRF exports the
 * whole folder in one pass (194 rifle clips in ~4 s), and the pack keeps the
 * subset `select` names unless --all-clips.
 *
 * `strip` removes the class suffix from a clip name so the same selector serves
 * rifle, pistol and knife: `run_n_rifle` → `run_n`.
 */
const DIRS = '(n|ne|e|se|s|sw|w|nw)';
const LOCO_SELECT = new RegExp(
  `^(idle|idle_crouch|idles|run_${DIRS}|walk_${DIRS}|crouch_${DIRS}|inair_(stand|n|e|s|w)|inair_crouch_(stand|n|e|s|w)|jump_(stand|n|e|s|w)|jump_crouch_(stand|n|e|s|w)|shoot|draw|draw_crouch|frontswing|frontswing_crouching|frontstab|frontstab_crouching|backstab|backstab_crouching)$`
);
const CLIP_SETS = [
  { key: 'rifle', res: 'animation/anims/world/rifle/_default_rifle/', strip: /_rifle$/, select: LOCO_SELECT },
  { key: 'pistol', res: 'animation/anims/world/pistol/_default_pistol/', strip: /_pistol$/, select: LOCO_SELECT },
  { key: 'knife', res: 'animation/anims/world/knife/_default_knife/', strip: /_knife$/, select: LOCO_SELECT },
  {
    key: 'shared',
    res: 'animation/anims/world/shared/',
    strip: null,
    // Deaths, the defuse channel per weapon class, and the flashed poses.
    // Flinches and the jump additives are delta clips for a later blend layer.
    select: /^(death_[a-z_]+|defuse\/defuse_(crouch_)?(enter|loop)_(rifle|pistol|knife)|flashed|flashed_crouch)$/
  },
  { key: 'c4', res: 'animation/anims/world/equipment/c4/', strip: /_c4$/, select: /^(idle|idle_crouch|draw|draw_crouch|planting|planting_crouch)$/ },
  // Grenades have no locomotion of their own (the graph runs pistol legs under
  // a grenade upper body); these are the hold / pin / throw clips.
  { key: 'grenade', res: 'animation/anims/world/grenade/_default_grenade/', strip: /_grenade$/, select: /./ }
];

/**
 * Locomotion loops whose authored ground speed is worth measuring — the runtime
 * scales their playback rate by (actual speed / groundSpeed).
 */
const LOCO_LOOP = new RegExp(`^(run|walk|crouch)_${DIRS}$`);

// ---- io ---------------------------------------------------------------------

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder
});

const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const fmtKB = (b) => `${(b / 1024).toFixed(0)} kB`;

// ---- import ------------------------------------------------------------------

async function importAll(vrf, gameDir) {
  const pak = path.join(gameDir, 'pak01_dir.vpk');
  await fsp.mkdir(RAW_DIR, { recursive: true });

  for (const m of MODELS) {
    const glb = path.join(RAW_DIR, 'models', ...m.res.split('/').slice(0, -1), `${m.name}.glb`);
    const dump = path.join(RAW_DIR, 'models', `${m.name}.dump.txt`);
    if (force || !fs.existsSync(glb)) {
      // --gltf_export_animations is what makes VRF write the skeleton and the
      // skins at all; without it the export is four unskinned meshes and the
      // clips have nothing to bind to. The two embedded animations it brings
      // along (tools_preview, eye_test) are dropped at pack time.
      await runVrf(
        vrf,
        ['-i', pak, '-f', m.res, '-d', '-o', path.join(RAW_DIR, 'models'), '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_export_animations', '--threads', String(threads)],
        `${m.name} model`
      );
    } else {
      console.log(`  ${m.name} model: present, skipping (use --force)`);
    }
    if (!fs.existsSync(glb)) throw new Error(`${m.name}: expected ${path.relative(ROOT, glb)} was not written`);
    // The full block dump: the `cstrike` hitbox set lives in an MDAT block and
    // is not part of the glTF export.
    if (force || !fs.existsSync(dump)) {
      const txt = await runVrf(vrf, ['-i', pak, '-f', m.res, '-a'], `${m.name} dump`, { capture: true });
      await fsp.writeFile(dump, txt);
      console.log(`  ${m.name} dump: ${fmtKB(txt.length)}`);
    }
  }

  for (const s of CLIP_SETS) {
    const dir = path.join(RAW_DIR, 'anims', ...s.res.split('/').filter(Boolean));
    const have = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.glb')).length : 0;
    if (force || !have) {
      await runVrf(
        vrf,
        ['-i', pak, '-f', s.res, '-d', '-o', path.join(RAW_DIR, 'anims'), '--gltf_export_format', 'glb', '--threads', String(threads)],
        `${s.key} clips`
      );
    } else {
      console.log(`  ${s.key} clips: ${have} present, skipping (use --force)`);
    }
  }
}

// ---- hitboxes ----------------------------------------------------------------

/**
 * The `cstrike` hitbox set out of the model dump: capsules (shape 2) between
 * two points in bone space with a radius, or boxes, each with the group id the
 * game's damage tables key on (1 head, 2 chest, 3 stomach, 4/5 arms, 6/7 legs,
 * 8 neck). Bone names in this set are lower-case (`arm_lower_r`) where the
 * skeleton says `arm_lower_R`; the runtime matches case-insensitively.
 */
function parseHitboxes(dumpText, modelName) {
  const start = dumpText.indexOf('m_hitboxsets');
  if (start < 0) throw new Error(`${modelName}: no m_hitboxsets in the dump`);
  const end = dumpText.indexOf('m_SourceFilename', start);
  const head = dumpText.slice(start, end > 0 ? end : undefined);
  const setName = /m_name\s*=\s*"([^"]+)"/.exec(head)?.[1] || '';
  // The set's own m_name precedes m_HitBoxes; only match boxes after it.
  const list = head.indexOf('m_HitBoxes');
  const txt = list >= 0 ? head.slice(list) : head;
  const boxes = [];
  const re = /\{\s*m_name\s*=\s*"([^"]+)"[\s\S]*?m_sBoneName\s*=\s*"([^"]+)"[\s\S]*?m_vMinBounds\s*=\s*\[([^\]]+)\][\s\S]*?m_vMaxBounds\s*=\s*\[([^\]]+)\][\s\S]*?m_flShapeRadius\s*=\s*([-\d.eE+]+)[\s\S]*?m_nGroupId\s*=\s*(\d+)[\s\S]*?m_nShapeType\s*=\s*(\d+)[\s\S]*?m_nHitBoxIndex\s*=\s*(\d+)/g;
  let m;
  while ((m = re.exec(txt))) {
    const vec = (s) => s.split(',').map((v) => Number(v.trim()));
    boxes.push({
      name: m[1],
      bone: m[2],
      min: vec(m[3]),
      max: vec(m[4]),
      radius: Number(m[5]),
      group: Number(m[6]),
      shape: Number(m[7]), // 0 box, 1 sphere, 2 capsule
      index: Number(m[8])
    });
  }
  if (!boxes.length) throw new Error(`${modelName}: hitbox set "${setName}" parsed empty`);
  return { set: setName, boxes };
}

// ---- model pack --------------------------------------------------------------

/**
 * Rewrite the skeleton so `root_motion` carries no rotation and its direct
 * children are expressed in the un-rotated frame — the clip skeleton's
 * convention. World transforms are unchanged (T' = R·T, R' = R·Rc for each
 * child, root R' = I), so the skin's inverse bind matrices stay valid.
 */
function normalizeRootMotion(doc, label) {
  const root = doc.getRoot().listNodes().find((n) => n.getName() === 'root_motion');
  if (!root) throw new Error(`${label}: no root_motion bone`);
  const q = new Quaternion().fromArray(root.getRotation());
  if (Math.abs(q.w) > 0.9999) return false; // already identity
  const t = root.getTranslation();
  if (Math.hypot(...t) > 1e-4) throw new Error(`${label}: root_motion is translated (${t}); expected 0`);
  for (const child of root.listChildren()) {
    const ct = new Vector3().fromArray(child.getTranslation()).applyQuaternion(q);
    const cr = q.clone().multiply(new Quaternion().fromArray(child.getRotation()));
    child.setTranslation(ct.toArray()).setRotation(cr.toArray());
  }
  root.setRotation([0, 0, 0, 1]);
  return true;
}

/** sharp pipeline over a glTF texture's bytes. */
const sharpOf = (tex) => sharp(Buffer.from(tex.getImage()), { limitInputPixels: false });

/**
 * One channel of a PNG as a raw single-channel buffer at exactly `w`×`h`, or a
 * constant fill when the texture is a 1×1 stand-in (VRF writes those for
 * absent slots, and the vmat's `Texture<Slot>` vector says what they mean).
 *
 * The size is passed in rather than assumed square: these are UV-mapped
 * character sheets, most of them 2:1 or 1:2, and squashing one to a square
 * slides every texel off the UV it belongs to. That is exactly what happened
 * the first time — the albedo kept its aspect and the ORM did not, so a
 * model's roughness, AO and metalness were sampled from the wrong places.
 */
async function channelAt(tex, channel, w, h, fallback) {
  if (!tex) return { data: Buffer.alloc(w * h, fallback), constant: fallback };
  const img = sharpOf(tex);
  const meta = await img.metadata();
  if (meta.width <= 1 && meta.height <= 1) {
    const { data } = await img.raw().toBuffer({ resolveWithObject: true });
    const v = data[Math.min(channel, (meta.channels || 1) - 1)];
    return { data: Buffer.alloc(w * h, v), constant: v };
  }
  // Channel 3 IS the alpha, so that read has to keep it (a resize never scales
  // alpha by itself). Every other channel has to lose it first — see dropAlpha.
  const src = channel === 3 ? img.ensureAlpha() : await dropAlpha(sharpOf(tex));
  const { data, info } = await src
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(w * h);
  const ch = Math.min(channel, info.channels - 1);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels + ch];
  return { data: out, constant: null };
}

/** The ORM's size: the source aspect, longest side capped at `cap`. */
async function ormSize(tex, cap) {
  const fallback = { w: cap, h: cap };
  if (!tex) return fallback;
  const meta = await sharpOf(tex).metadata();
  if (!meta.width || !meta.height || (meta.width <= 1 && meta.height <= 1)) return fallback;
  const k = Math.min(1, cap / Math.max(meta.width, meta.height));
  return { w: Math.max(1, Math.round(meta.width * k)), h: Math.max(1, Math.round(meta.height * k)) };
}

/**
 * What the vmat says about a character material beyond its textures.
 *
 * `csgo_character.vfx` is not a plain metal/rough dielectric: cloth surfaces
 * carry a sheen lobe (`F_CLOTH_SHADING` + `g_flSheenScale` / tint) and skin a
 * subsurface term. Rendered as ordinary dielectrics they read as wet plastic,
 * which is precisely how the first pass looked. The flags ride in the packed
 * material's extras so src/cs3d/playerModels.js can build the right BRDF.
 *
 * `Texture<Slot>` vectors are VRF's constant stand-ins for a slot with no real
 * texture (`TextureMetalness [0,0,0,0]` means "metalness is 0"), and they win
 * over whatever 1×1 placeholder was exported for that slot.
 */
function readVmat(mat) {
  const v = mat.getExtras()?.vmat || {};
  const I = v.IntParams || {};
  const F = v.FloatParams || {};
  const V = v.VectorParams || {};
  const num = (x, d) => (Number.isFinite(x) ? x : d);
  return {
    name: v.Name || null,
    shader: v.ShaderName || null,
    cloth: !!I.F_CLOTH_SHADING,
    sss: !!I.F_SUBSURFACE_SCATTERING,
    sheen: num(F.g_flSheenScale, 0),
    sheenTint: Array.isArray(V.g_flSheenTintColor) ? V.g_flSheenTintColor.slice(0, 3) : [1, 1, 1],
    aoMasking: num(F.g_flAmbientOcclusionMasking, 1),
    // [brightness, contrast] applied to the roughness the normal's alpha holds.
    roughAdjust: Array.isArray(V.g_vRoughnessAdjustBrightnessContrast)
      ? [num(V.g_vRoughnessAdjustBrightnessContrast[0], 0), num(V.g_vRoughnessAdjustBrightnessContrast[1], 1)]
      : [0, 1],
    constMetal: Array.isArray(V.TextureMetalness) ? num(V.TextureMetalness[0], null) : null,
    constAo: Array.isArray(V.TextureAmbientOcclusion) ? num(V.TextureAmbientOcclusion[0], null) : null,
    tint: Array.isArray(V.g_vColorTint) ? V.g_vColorTint.slice(0, 3) : [1, 1, 1]
  };
}

/**
 * Textures the way the map pack builds them (cs3d-pack.mjs, "Textures"): the
 * albedo lossy at 1024, the normal near-lossless RGB at 512 (its alpha is the
 * roughness, which moves to the ORM), and one lossless ORM from AO's R,
 * normal's A and metalness's R — Source 2's channel layout, verified against
 * the exports. VRF puts the raw g_tMetalness in the metallicRoughness slot,
 * which read as-is makes every rough surface a chrome one.
 *
 * Every map keeps the SOURCE ASPECT (see channelAt): these sheets are 2:1 and
 * 1:2 as often as square, and an ORM squashed to a square samples roughness
 * and AO from the wrong texels — the "wet plastic" of the first pass.
 */
async function packMaterials(doc, label) {
  doc.createExtension(EXTTextureWebP).setRequired(true);
  let bytes = 0;
  const seen = new Map(); // source texture → packed texture, so shared arms/gloves pack once
  for (const mat of doc.getRoot().listMaterials()) {
    const vmat = readVmat(mat);
    const base = mat.getBaseColorTexture();
    const normal = mat.getNormalTexture();
    const ao = mat.getOcclusionTexture();
    const metal = mat.getMetallicRoughnessTexture();
    const key = [base, normal, ao, metal].map((t) => t?.getName() || t?.getURI() || '-').join('|');
    let packed = seen.get(key);
    if (!packed) {
      packed = {};
      if (base) {
        const buf = await sharpOf(base)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 88, alphaQuality: 90, smartSubsample: true, effort: 4 })
          .toBuffer();
        packed.base = doc.createTexture(`${label}_${mat.getName()}_color`).setMimeType('image/webp').setImage(buf);
        bytes += buf.length;
      }
      if (normal) {
        // dropAlpha, not `.removeAlpha()`: the alpha here is roughness, and a
        // resize would premultiply the normal by it. See lib/texAlpha.mjs.
        const { data, info } = await (await dropAlpha(sharpOf(normal)))
          .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
          .raw({ depth: 'uchar' })
          .toBuffer({ resolveWithObject: true });
        if (normalIsBlank(data, info.channels)) {
          console.warn(
            `cs3d-models: ${label}/${mat.getName()} — the normal map is blank ` +
              `(no blue anywhere across ${info.width}x${info.height}); using a flat normal ` +
              `instead of shading the surface with (-1,-1,-1)`
          );
          for (let i = 0; i < data.length; i += info.channels) {
            data[i] = 128;
            data[i + 1] = 128;
            data[i + 2] = 255;
          }
        }
        const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .webp({ nearLossless: true, quality: 30, effort: 4 })
          .toBuffer();
        packed.normal = doc.createTexture(`${label}_${mat.getName()}_normal`).setMimeType('image/webp').setImage(buf);
        bytes += buf.length;
      }
      {
        // The ORM follows the normal map's shape (roughness is its alpha, and
        // it is the highest-frequency of the three); AO and metalness are
        // resampled onto it.
        const { w, h } = await ormSize(normal || ao || metal, 512);
        const [o, r, m] = await Promise.all([
          vmat.constAo !== null ? { data: null, constant: Math.round(vmat.constAo * 255) } : channelAt(ao, 0, w, h, 255),
          channelAt(normal, 3, w, h, ROUGHNESS_DEFAULT),
          vmat.constMetal !== null ? { data: null, constant: Math.round(vmat.constMetal * 255) } : channelAt(metal, 0, w, h, 0)
        ]);
        // An empty alpha is not "roughness 0", it is a missing channel.
        if (r.data && roughnessIsEmpty(r.data)) {
          console.warn(
            `cs3d-models: ${label}/${mat.getName()} — the normal map carries no roughness ` +
              `(alpha is 0 across ${w}x${h}); using ${(ROUGHNESS_DEFAULT / 255).toFixed(2)} instead of rendering it as a mirror`
          );
          r.data = Buffer.alloc(w * h, ROUGHNESS_DEFAULT);
        }
        if (o.constant === null || r.constant === null || m.constant === null) {
          const fill = (c) => c.data || Buffer.alloc(w * h, c.constant);
          const od = fill(o);
          const rd = fill(r);
          const md = fill(m);
          const rgb = Buffer.alloc(w * h * 3);
          for (let i = 0; i < w * h; i++) {
            rgb[i * 3] = od[i];
            rgb[i * 3 + 1] = rd[i];
            rgb[i * 3 + 2] = md[i];
          }
          const buf = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
            .webp({ lossless: true, effort: 4 })
            .toBuffer();
          packed.orm = doc.createTexture(`${label}_${mat.getName()}_orm`).setMimeType('image/webp').setImage(buf);
          bytes += buf.length;
        } else {
          packed.roughness = r.constant / 255;
          packed.metalness = m.constant / 255;
        }
      }
      seen.set(key, packed);
    }
    mat.setBaseColorTexture(packed.base || null);
    mat.setNormalTexture(packed.normal || null);
    mat.setEmissiveTexture(null);
    if (packed.orm) {
      mat.setMetallicRoughnessTexture(packed.orm).setOcclusionTexture(packed.orm);
      mat.setMetallicFactor(1).setRoughnessFactor(1);
    } else {
      mat.setMetallicRoughnessTexture(null).setOcclusionTexture(null);
      mat.setMetallicFactor(packed.metalness).setRoughnessFactor(packed.roughness);
    }
    // The vmat's whole dump is 5 kB a material; what the renderer needs of it
    // is the shading model (see readVmat).
    mat.setExtras({ cs3d: vmat });
  }
  return bytes;
}

async function packModel(m) {
  const rawGlb = path.join(RAW_DIR, 'models', ...m.res.split('/').slice(0, -1), `${m.name}.glb`);
  const dumpFile = path.join(RAW_DIR, 'models', `${m.name}.dump.txt`);
  const doc = await io.read(rawGlb);
  const root = doc.getRoot();

  // The two first-person mesh groups (arms + sleeves) are viewmodel work
  // (E-9); the demo viewer and the bots want the third-person body + gloves.
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const n = mesh.getName();
    if (/firstperson/i.test(n)) {
      node.dispose();
      mesh.dispose();
    } else {
      const short = /gloves/i.test(n) ? 'gloves' : 'body';
      node.setName(short);
      mesh.setName(short);
    }
  }
  // tools_preview / eye_test are the model's own embedded animations; every
  // pose the runtime plays comes from the clip sets instead.
  for (const a of root.listAnimations()) a.dispose();

  const rewrote = normalizeRootMotion(doc, m.name);

  // The scene root: VRF's metres-y-up frame → scene units. The composed
  // transform is exactly units.js sourceToScene, i.e. a −90° turn about x
  // with no scale, so the packed model's joints stay in Source units and the
  // body faces +x at yaw 0.
  const scene = root.listScenes()[0];
  const top = scene.listChildren().filter((n) => !n.getMesh());
  if (top.length !== 1) throw new Error(`${m.name}: expected one skeleton root, found ${top.length}`);
  const modelRoot = top[0];
  const s = modelRoot.getScale();
  if (Math.abs(s[0] - 0.0254) > 1e-6) throw new Error(`${m.name}: unexpected root scale ${s} (VRF export frame changed?)`);
  modelRoot.setName(m.name).setTranslation([0, 0, 0]).setScale([1, 1, 1]);
  modelRoot.setRotation(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2).toArray());

  const texBytes = await packMaterials(doc, m.name);

  const skins = root.listSkins();
  const bones = skins[0]?.listJoints().map((j) => j.getName()) || [];

  await doc.transform(prune(), dedup());
  // Quantize + meshopt, as the map tiles are. Skinned positions are handled by
  // gltf-transform through the inverse bind matrices, not a node transform.
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  const out = path.join(PACK_DIR, `${m.name}.glb`);
  const glb = await io.writeBinary(doc);
  await fsp.writeFile(out, glb);

  const tris = root.listMeshes().reduce((a, mesh) => a + mesh.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() || 0) / 3, 0), 0);
  const hit = parseHitboxes(await fsp.readFile(dumpFile, 'utf8'), m.name);
  console.log(
    `  ${m.name}: ${fmtMB(glb.length)} (${fmtMB(texBytes)} textures), ${tris} tris, ${bones.length} bones, ${hit.boxes.length} hitboxes${rewrote ? ', root_motion normalized' : ''}`
  );
  return { file: `${m.name}.glb`, bytes: glb.length, tris, bones, hitboxes: hit, side: m.side, name: m.name };
}

// ---- animation pack ----------------------------------------------------------

/** Clip name without the class suffix, and the raw glb path. */
function listClipFiles(set) {
  const dir = path.join(RAW_DIR, 'anims', ...set.res.split('/').filter(Boolean));
  const out = [];
  const walk = (d, rel) => {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) walk(full, rel ? `${rel}/${f}` : f);
      else if (f.endsWith('.glb')) {
        const raw = (rel ? `${rel}/` : '') + f.replace(/\.glb$/, '');
        const name = set.strip ? raw.replace(set.strip, '') : raw;
        out.push({ raw, name, file: full });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Nodes of a clip document keyed by name, skipping the exporter's empty mesh. */
function skeletonNodes(doc) {
  const map = new Map();
  for (const n of doc.getRoot().listNodes()) if (!n.getMesh()) map.set(n.getName(), n);
  return map;
}

/**
 * Forward kinematics over a clip at each keyframe: joint world positions in
 * the skeleton frame (Source units, z-up), for the ground-speed estimate.
 * Uses the clip's own sampled times; every VRF clip is LINEAR at the source
 * frame rate.
 */
function sampleJointWorld(doc, anim, jointName) {
  const nodes = skeletonNodes(doc);
  const target = nodes.get(jointName);
  if (!target) return null;
  // Chain root → joint.
  const chain = [];
  for (let n = target; n && n.getName() !== 'root_motion'; n = n.getParentNode()) chain.unshift(n);
  const tracks = new Map(); // node → { t: Float32Array, path → Float32Array }
  for (const ch of anim.listChannels()) {
    const n = ch.getTargetNode();
    if (!chain.includes(n)) continue;
    const s = ch.getSampler();
    let e = tracks.get(n);
    if (!e) tracks.set(n, (e = {}));
    e[ch.getTargetPath()] = { t: s.getInput().getArray(), v: s.getOutput().getArray() };
  }
  // Time base: the densest track in the chain.
  let times = null;
  for (const e of tracks.values()) for (const k of Object.keys(e)) if (!times || e[k].t.length > times.length) times = e[k].t;
  if (!times) return null;
  const sampleVec = (tr, time, size, out) => {
    const t = tr.t;
    const v = tr.v;
    if (t.length === 1) {
      for (let i = 0; i < size; i++) out[i] = v[i];
      return out;
    }
    let i1 = 0;
    while (i1 < t.length - 1 && t[i1 + 1] < time) i1++;
    const i2 = Math.min(t.length - 1, i1 + 1);
    const span = t[i2] - t[i1] || 1;
    const f = Math.max(0, Math.min(1, (time - t[i1]) / span));
    for (let i = 0; i < size; i++) out[i] = v[i1 * size + i] * (1 - f) + v[i2 * size + i] * f;
    if (size === 4) {
      const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
      for (let i = 0; i < 4; i++) out[i] /= len;
    }
    return out;
  };
  const pos = [];
  const m = new Matrix4();
  const local = new Matrix4();
  const q = new Quaternion();
  const tv = new Vector3();
  const sv = new Vector3(1, 1, 1);
  const tmp4 = [0, 0, 0, 1];
  const tmp3 = [0, 0, 0];
  for (const time of times) {
    m.identity();
    for (const n of chain) {
      const tr = tracks.get(n) || {};
      if (tr.translation) tv.fromArray(sampleVec(tr.translation, time, 3, tmp3));
      else tv.fromArray(n.getTranslation());
      if (tr.rotation) q.fromArray(sampleVec(tr.rotation, time, 4, tmp4));
      else q.fromArray(n.getRotation());
      local.compose(tv, q, sv);
      m.multiply(local);
    }
    pos.push(new Vector3().setFromMatrixPosition(m));
  }
  return { times: Array.from(times), pos };
}

/**
 * Authored ground speed of an in-place locomotion loop.
 *
 * A planted foot does not slip: while it is in contact its world position is
 * fixed, so in an in-place clip it must travel backwards under the body at
 * exactly the speed the body moves forwards. Fit that.
 *
 * Which frames count is the whole problem. The first version took the MEDIAN
 * horizontal speed over every frame whose foot was in the lowest third, which
 * sounds equivalent and is not: that window also holds the frames where the
 * foot is planting and lifting, still decelerating into contact or already
 * swinging forward again (a quarter of them move forward). The median of that
 * mixture came out ~25% low — 182 u/s against a real 224 — and a cadence a
 * quarter too fast is a body that takes two steps and skates the third.
 *
 * During real contact the foot's speed sits on a PLATEAU at exactly the body
 * speed; every other frame is slower. So take, per frame, the horizontal speed
 * of whichever foot is lower, and read the plateau off the top of that
 * distribution (p90 — not the max, which catches a swing frame mis-picked as
 * the low foot). Speed rather than a signed axis, because `run_e` strafes
 * along y and only the magnitude is the body's.
 *
 * The estimator checks out against the game's own numbers: across the eight
 * directions it lands within ±10% on run, ±6% on walk, ±1% on crouch, and the
 * walk/run ratio it produces is 0.512 — WALK_SPEED_SCALE, which the demo
 * corpus measured at 0.52 independently.
 */
function estimateGroundSpeed(doc, anim) {
  const left = sampleJointWorld(doc, anim, 'ankle_L');
  const right = sampleJointWorld(doc, anim, 'ankle_R');
  if (!left || !right || left.pos.length < 4) return null;
  const speeds = [];
  for (let i = 1; i < left.pos.length; i++) {
    const dt = left.times[i] - left.times[i - 1];
    if (dt <= 0) continue;
    // The lower foot over this interval is the one bearing weight.
    const lowLeft = Math.min(left.pos[i].z, left.pos[i - 1].z) <= Math.min(right.pos[i].z, right.pos[i - 1].z);
    const a = lowLeft ? left : right;
    speeds.push(Math.hypot(a.pos[i].x - a.pos[i - 1].x, a.pos[i].y - a.pos[i - 1].y) / dt);
  }
  if (!speeds.length) return null;
  speeds.sort((a, b) => a - b);
  return +speeds[Math.min(speeds.length - 1, Math.floor(speeds.length * 0.9))].toFixed(1);
}

/**
 * Merge every selected clip of a set into one glb: the worldmodel skeleton
 * once, then each clip as an animation whose channels point at those nodes.
 * Scale channels are dropped (every clip's are constant 1) and so are
 * translation channels that sit on the bone's rest translation for the whole
 * clip — that is every bone but the pelvis and a few weapon helpers, and it
 * halves the file before compression.
 */
async function packClipSet(set) {
  const files = listClipFiles(set).filter((c) => allClips || set.select.test(c.name));
  if (!files.length) {
    console.warn(`  ! ${set.key}: no clips exported under raw/players/anims/${set.res}; run without --skip-import`);
    return null;
  }
  const out = new Document();
  const buffer = out.createBuffer();
  const scene = out.createScene('anims');
  const nodes = new Map();
  let skeletonBones = 0;
  const clips = [];
  let dropped = 0;
  let kept = 0;
  let unmatched = new Set();

  for (const c of files) {
    const doc = await io.read(c.file);
    const anim = doc.getRoot().listAnimations()[0];
    if (!anim) continue;
    // First clip: copy the skeleton (names, hierarchy, rest transforms).
    if (!nodes.size) {
      const src = skeletonNodes(doc);
      const copy = (n, parent) => {
        const nn = out.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
        nodes.set(n.getName(), nn);
        if (parent) parent.addChild(nn);
        else scene.addChild(nn);
        for (const ch of n.listChildren()) if (!ch.getMesh()) copy(ch, nn);
      };
      for (const n of doc.getRoot().listScenes()[0].listChildren()) if (!n.getMesh() && src.has(n.getName())) copy(n, null);
      skeletonBones = nodes.size;
    }
    const a = out.createAnimation(c.name);
    // The clip's length comes from every channel before any of them is
    // rewritten: a clip that animates some bones and holds others on a single
    // key must take its length from the animated ones. (Padding each held
    // channel to a second instead turned the viewmodel's 0.37 s shot into a
    // 1 s one, which is how this was found.)
    let duration = 0;
    for (const ch of anim.listChannels()) {
      const inp = ch.getSampler().getInput();
      duration = Math.max(duration, inp.getElement(inp.getCount() - 1, [])[0]);
    }
    // Every channel a single key: a pose, not an animation. It gets a second
    // to hold, because three's mixer cannot loop a zero-length clip.
    const isPose = duration <= 1e-6;
    if (isPose) duration = 1;
    for (const ch of anim.listChannels()) {
      const pathName = ch.getTargetPath();
      if (pathName === 'scale') continue;
      const target = nodes.get(ch.getTargetNode()?.getName());
      if (!target) {
        unmatched.add(ch.getTargetNode()?.getName());
        continue;
      }
      const s = ch.getSampler();
      const inArr = s.getInput().getArray();
      const outArr = s.getOutput().getArray();
      if (pathName === 'translation') {
        const rest = target.getTranslation();
        let still = true;
        for (let i = 0; i < outArr.length && still; i += 3) {
          if (Math.abs(outArr[i] - rest[0]) > 1e-3 || Math.abs(outArr[i + 1] - rest[1]) > 1e-3 || Math.abs(outArr[i + 2] - rest[2]) > 1e-3) still = false;
        }
        if (still) {
          dropped++;
          continue;
        }
      }
      kept++;
      let inData = new Float32Array(inArr);
      let outData = new Float32Array(outArr);
      // Only a whole-clip pose is stretched; a single key inside an animated
      // clip is a bone holding still, which the mixer already does.
      if (isPose && inArr.length === 1) {
        inData = new Float32Array([0, duration]);
        outData = new Float32Array([...outArr, ...outArr]);
      }
      const input = out.createAccessor().setType('SCALAR').setArray(inData).setBuffer(buffer);
      const output = out
        .createAccessor()
        .setType(pathName === 'rotation' ? 'VEC4' : 'VEC3')
        .setArray(outData)
        .setBuffer(buffer);
      const sampler = out.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation());
      const channel = out.createAnimationChannel().setTargetNode(target).setTargetPath(pathName).setSampler(sampler);
      a.addSampler(sampler).addChannel(channel);
    }
    const entry = { name: c.name, duration: +duration.toFixed(4) };
    if (LOCO_LOOP.test(c.name)) {
      const gs = estimateGroundSpeed(doc, anim);
      if (gs) entry.groundSpeed = gs;
    }
    clips.push(entry);
  }
  if (unmatched.size) console.warn(`  ! ${set.key}: channels on bones missing from the first clip's skeleton: ${[...unmatched].join(', ')}`);

  await out.transform(resample({ tolerance: 1e-4 }), dedup({ propertyTypes: [PropertyType.ACCESSOR] }), prune());
  out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const file = `anims_${set.key}.glb`;
  const glb = await io.writeBinary(out);
  await fsp.writeFile(path.join(PACK_DIR, file), glb);

  // One authored speed per gait, not per direction: the per-clip estimates
  // spread ±25% across the eight directions (crossover steps slide the planted
  // foot), while the entity moves at one speed whichever way it strafes. The
  // graph plays a blend space at one rate; so does the runtime.
  const gaitSpeed = {};
  const spreads = [];
  for (const gait of ['run', 'walk', 'crouch']) {
    const v = clips.filter((c) => c.name.startsWith(`${gait}_`) && c.groundSpeed).map((c) => c.groundSpeed).sort((a, b) => a - b);
    if (!v.length) continue;
    gaitSpeed[gait] = v[Math.floor(v.length / 2)];
    // The eight directions are one body speed animated eight ways, so a wide
    // spread here means the fit is picking up something other than contact.
    spreads.push(`${gait} ${gaitSpeed[gait]} (${v[0].toFixed(0)}-${v[v.length - 1].toFixed(0)})`);
  }
  const gaits = spreads.join(', ');
  console.log(
    `  ${set.key}: ${clips.length} clips, ${skeletonBones} bones, ${kept} channels (${dropped} rest translations dropped) → ${fmtMB(glb.length)}${gaits ? `; authored u/s: ${gaits}` : ''}`
  );
  return { file, bytes: glb.length, clips, gaitSpeed };
}

// ---- verify ------------------------------------------------------------------

/**
 * Read the pack back and pose each model with a clip by bone name, the way
 * the runtime will: if the root_motion frames disagreed, or a bone renamed,
 * the head ends up at the feet or the body on its side, and this catches it
 * before a browser does. Cheap: one FK pass per model.
 */
async function verifyPack(manifest) {
  const anims = await io.read(path.join(PACK_DIR, manifest.anims.rifle.file));
  const clip = anims.getRoot().listAnimations().find((a) => a.getName() === 'run_n');
  if (!clip) throw new Error('verify: anims_rifle has no run_n');
  const at = 0.3;
  const pose = new Map();
  for (const ch of clip.listChannels()) {
    const s = ch.getSampler();
    const input = s.getInput();
    let i1 = 0;
    while (i1 < input.getCount() - 1 && input.getElement(i1 + 1, [])[0] < at) i1++;
    const name = ch.getTargetNode().getName();
    if (!pose.has(name)) pose.set(name, {});
    pose.get(name)[ch.getTargetPath()] = s.getOutput().getElement(i1, []);
  }
  for (const [side, m] of Object.entries(manifest.models)) {
    const doc = await io.read(path.join(PACK_DIR, m.file));
    const root = doc.getRoot().listScenes()[0].listChildren().find((n) => !n.getMesh());
    const world = new Map();
    const walk = (n, parent) => {
      const p = pose.get(n.getName()) || {};
      const local = new Matrix4().compose(
        new Vector3().fromArray(p.translation || n.getTranslation()),
        new Quaternion().fromArray(p.rotation || n.getRotation()),
        new Vector3(1, 1, 1)
      );
      const w = parent.clone().multiply(local);
      world.set(n.getName(), new Vector3().setFromMatrixPosition(w));
      for (const c of n.listChildren()) walk(c, w);
    };
    for (const c of root.listChildren()) walk(c, new Matrix4());
    const head = world.get('head_0');
    const lAnkle = world.get('ankle_L');
    const rAnkle = world.get('ankle_R');
    const hand = world.get('hand_R');
    const bad = [];
    if (!head || head.z < 55 || head.z > 75) bad.push(`head z ${head?.z.toFixed(1)}`);
    if (!lAnkle || !rAnkle || Math.min(lAnkle.z, rAnkle.z) > 12) bad.push(`feet z ${lAnkle?.z.toFixed(1)}/${rAnkle?.z.toFixed(1)}`);
    if (!hand || hand.x < 0) bad.push(`right hand x ${hand?.x.toFixed(1)} (should be in front, +x)`);
    const missing = [...pose.keys()].filter((n) => !world.has(n));
    if (bad.length) throw new Error(`verify ${side}: run_n poses wrong — ${bad.join(', ')}`);
    console.log(`  verify ${side}: run_n head z ${head.z.toFixed(1)}, feet z ${lAnkle.z.toFixed(1)}/${rAnkle.z.toFixed(1)}, ${pose.size - missing.length}/${pose.size} clip bones on the model`);
  }
}

// ---- main --------------------------------------------------------------------

async function main() {
  assertLocalOutput(TAG, RAW_DIR);
  assertLocalOutput(TAG, PACK_DIR);
  if (!skipImport) {
    const vrf = findVrf(TAG);
    const gameDir = findGameDir(TAG, opt('--game'));
    console.log(`${TAG}: VRF ${path.relative(ROOT, vrf)}, game ${gameDir}`);
    await importAll(vrf, gameDir);
  }
  await MeshoptEncoder.ready;
  await fsp.mkdir(PACK_DIR, { recursive: true });

  console.log(`${TAG}: packing → ${path.relative(ROOT, PACK_DIR)}`);
  const models = {};
  for (const m of MODELS) models[m.side] = await packModel(m);
  const anims = {};
  for (const s of CLIP_SETS) {
    const r = await packClipSet(s);
    if (r) anims[s.key] = r;
  }

  const manifest = {
    version: PACK_VERSION,
    generated: new Date().toISOString(),
    // The packed model root is rotated −90° about x: joints and hitboxes are
    // in Source units, z-up, body facing +x. Place a body with
    // group.position = sourceToScene(x, y, z), group.rotation.y = yaw.
    frame: { units: 'source', up: 'z', forward: '+x', rootRotationX: -90 },
    models,
    anims
  };
  await fsp.writeFile(path.join(PACK_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
  await verifyPack(manifest);
  const total = Object.values(models).reduce((a, m) => a + m.bytes, 0) + Object.values(anims).reduce((a, s) => a + s.bytes, 0);
  console.log(`${TAG}: done — ${fmtMB(total)} in ${path.relative(ROOT, PACK_DIR)} (local only, not in git)`);
}

main().catch((e) => fail(e.stack || e.message));
