#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/cs3d-weapons.mjs
// The weapons pipeline (CS3D-ENGINE-PLAN E-6 data, E-7 models, E-9 viewmodel):
// pull the game's own weapon table, its weapon and grenade models, and the
// first-person arms and their animation, into a pack the browser can stream.
//
//   server/data/cs3d/raw/weapons/    VRF exports
//   server/data/cs3d/pack/weapons/   what src/cs3d/viewModel.js loads
//     manifest.json                  per weapon: model, class, and the numbers
//     w_<name>.glb                   one model per weapon and grenade
//     vm_arms_T.glb / _CT.glb        first-person arms on the viewmodel rig
//     vmanims_<class>.glb            viewmodel clips: draw, idle, shoot, …
//
// Four things worth knowing, each of which decided the design:
//
//   1. `scripts/weapons.vdata_c` is the whole of E-6's "extract the weapon
//      table" in one file: cycle time, deploy duration, damage, headshot and
//      armour multipliers, penetration, range falloff, spread and inaccuracy,
//      recoil magnitude and seed, and the muzzle position. It is a prefab tree
//      — `weapon_ak47_prefab` inherits `rifle` inherits `primary` inherits
//      `weapon_base` — so a value has to be resolved up the `_base` chain
//      rather than read off the entry (scripts/lib/kv3.mjs).
//   2. CS2 has ONE model per weapon: the thing in your hands and the thing on
//      the ground are the same `weapon_rif_ak47.vmdl`. So this pack serves the
//      viewmodel and, later, the world model and the dropped weapon.
//   3. The first-person arms are already inside the agent models — the mesh
//      groups `firstperson_default_gloves_arms` and `firstperson_sleeves` that
//      cs3d-models.mjs throws away. They are skinned to the agent's own
//      skeleton, but the viewmodel CLIPS are authored against a different rig
//      (`animation/skeletons/characters/viewmodel.vnmskel`), which branches at
//      the shoulder — `root_motion → armUpperShoulder_L → arm_lower_L` where
//      the agent goes `clavicle_L → arm_upper_L → arm_lower_L`. Below the
//      elbow the two are the same rig to the millimetre (arm 11.79, hand
//      11.08, finger 2.87), so `rebindArms()` moves the mesh onto the
//      viewmodel skeleton: every vertex through `vmRest · agentBindInverse`,
//      and new inverse binds from the viewmodel rest pose. 48 joints, of which
//      only 4 are missing on the viewmodel rig, all procedural forearm TWIST
//      helpers — those fold into their parent.
//   4. A melee weapon has no attack timing in the vdata (the knife inherits
//      the base `m_flCycleTime = [0.15, 0.3]`, which is not its swing rate).
//      Its rate is the animation: the pack measures `light_*`/`heavy_*` clip
//      lengths and ships them, so the runtime can swing at the length of the
//      swing.
//
// Usage:
//   node scripts/cs3d-weapons.mjs                # import (if missing) + pack
//   node scripts/cs3d-weapons.mjs --force        # re-export everything
//   node scripts/cs3d-weapons.mjs --skip-import  # pack only, from raw/
//   node scripts/cs3d-weapons.mjs --game "<...>\Counter-Strike Global Offensive\game\csgo"
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Document, NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, resample, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { Matrix4, Quaternion, Vector3 } from 'three';

import { ROOT, fail as failWith, assertLocalOutput, findVrf, findGameDir, runVrf } from './lib/vrf.mjs';
import { parseKv3, resolveBase } from './lib/kv3.mjs';
import { dropAlpha, normalIsBlank } from './lib/texAlpha.mjs';

const TAG = 'cs3d-weapons';
const fail = (msg) => failWith(TAG, msg);

export const PACK_VERSION = 1;
const RAW_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'weapons');
const PACK_DIR = path.join(ROOT, 'server', 'data', 'cs3d', 'pack', 'weapons');
const PLAYERS_RAW = path.join(ROOT, 'server', 'data', 'cs3d', 'raw', 'players', 'models');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const force = flag('--force');
const skipImport = flag('--skip-import');
const threads = Number(opt('--threads') || 8);

/**
 * The viewmodel clip sets. CS2 ships a per-weapon set as well
 * (`viewmodel/rifle/rifle_ak/…`); these generic ones drive every weapon of a
 * class, which is what the runtime needs before per-weapon bolt and slide
 * animation is worth the bytes.
 */
const VM_SETS = [
  { key: 'rifle', res: 'animation/anims/viewmodel/rifle/_default_rifle/', strip: /_rifle$/ },
  { key: 'pistol', res: 'animation/anims/viewmodel/pistol/_default_pistol/', strip: /_pistol$/ },
  { key: 'knife', res: 'animation/anims/viewmodel/knife/_default_knife/', strip: /_knife$/ },
  { key: 'grenade', res: 'animation/anims/viewmodel/grenade/_default_grenade/', strip: /_grenade$/ }
];

/** The agents whose arms become viewmodel hands, matching the players pack. */
const AGENTS = [
  { side: 'T', name: 'tm_phoenix' },
  { side: 'CT', name: 'ctm_sas' }
];

/** Which viewmodel clip set a weapon uses. */
function classOf(v) {
  if (v.melee) return 'knife';
  if (v.grenade) return 'grenade';
  return v.slot === 'GEAR_SLOT_PISTOL' ? 'pistol' : 'rifle';
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder
});

const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;

// ---- the weapon table -------------------------------------------------------

/**
 * Every weapon in `scripts/weapons.vdata_c`, `_base` chains resolved, keyed by
 * the bare name the rest of the repo uses (`ak47`, not `weapon_ak47`).
 */
function readWeaponTable(dumpText) {
  const start = dumpText.indexOf('<!-- kv3');
  const doc = parseKv3(dumpText.slice(start < 0 ? 0 : start));
  const out = {};
  for (const [key, entry] of Object.entries(doc)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = entry.m_szName || (/^weapon_(.+)_prefab$/.test(key) ? key.replace(/_prefab$/, '') : null);
    if (!name || !String(name).startsWith('weapon_')) continue;
    const r = resolveBase(doc, entry);
    if (!r.m_szWorldModel) continue;
    const bare = String(name).replace(/^weapon_/, '');
    // `_prefab` and the concrete entry both exist for most weapons; the one
    // carrying a world model and the richer field set wins.
    const prev = out[bare];
    if (prev && Object.keys(prev.raw).length > Object.keys(r).length) continue;
    const num = (v, d = 0) => (Array.isArray(v) ? +v[0] : Number.isFinite(v) ? +v : d);
    const pair = (v, d = 0) => (Array.isArray(v) ? [+v[0], +v[1]] : [num(v, d), num(v, d)]);
    const taxonomy = r.taxonomy || {};
    out[bare] = {
      raw: r,
      name: bare,
      model: String(r.m_szWorldModel).replace(/\.vmdl$/, ''),
      slot: r.m_GearSlot || '',
      type: r.m_WeaponType || '',
      melee: !!r.m_bMeleeWeapon,
      grenade: !!taxonomy.grenade || /GRENADE/i.test(r.m_WeaponType || ''),
      auto: !!r.m_bIsFullAuto,
      // Seconds between shots. Melee weapons carry the base pair and get their
      // real timing from the animation instead (see measureKnifeTiming).
      cycleTime: pair(r.m_flCycleTime, 0.15),
      deploy: num(r.m_flDeployDuration, 1),
      clip: num(r.m_iMaxClip1, 0),
      damage: num(r.m_nDamage, 0),
      headshot: num(r.m_flHeadshotMultiplier, 4),
      armorRatio: num(r.m_flArmorRatio, 1),
      penetration: num(r.m_flPenetration, 1),
      range: num(r.m_flRange, 8192),
      rangeModifier: num(r.m_flRangeModifier, 0.98),
      maxSpeed: num(r.m_flMaxSpeed, 215),
      bullets: num(r.m_nNumBullets, 1),
      spread: num(r.m_flSpread, 0),
      inaccuracyStand: num(r.m_flInaccuracyStand, 0),
      inaccuracyMove: num(r.m_flInaccuracyMove, 0),
      recoilMagnitude: num(r.m_flRecoilMagnitude, 0),
      recoilAngle: num(r.m_flRecoilAngle, 0),
      recoilSeed: num(r.m_nRecoilSeed, 0),
      recoveryStand: num(r.m_flRecoveryTimeStand, 0),
      muzzle: Array.isArray(r.m_vecMuzzlePos0) ? r.m_vecMuzzlePos0.map(Number) : null,
      price: num(r.m_nPrice, 0)
    };
  }
  return out;
}

// ---- import -----------------------------------------------------------------

async function importAll(vrf, gameDir) {
  const pak = path.join(gameDir, 'pak01_dir.vpk');
  await fsp.mkdir(RAW_DIR, { recursive: true });

  // The weapon table.
  const vdataFile = path.join(RAW_DIR, 'weapons.vdata.txt');
  if (force || !fs.existsSync(vdataFile)) {
    const txt = await runVrf(vrf, ['-i', pak, '-f', 'scripts/weapons.vdata_c', '-b', 'DATA'], 'weapon table', { capture: true });
    await fsp.writeFile(vdataFile, txt);
    console.log(`  weapon table: ${(txt.length / 1024).toFixed(0)} kB`);
  }
  const table = readWeaponTable(await fsp.readFile(vdataFile, 'utf8'));

  // One model per weapon. Every one is a separate VRF invocation, but they are
  // small and it is a one-off; --threads makes each export parallel internally.
  const models = path.join(RAW_DIR, 'models');
  const wanted = Object.values(table);
  let exported = 0;
  for (const w of wanted) {
    const glb = path.join(models, ...`${w.model}.glb`.split('/'));
    if (!force && fs.existsSync(glb)) continue;
    try {
      await runVrf(
        vrf,
        ['-i', pak, '-f', `${w.model}.vmdl_c`, '-d', '-o', models, '--gltf_export_format', 'glb', '--gltf_export_materials', '--threads', String(threads)],
        `${w.name}`,
        { quiet: true }
      );
      exported++;
    } catch (e) {
      console.warn(`  ! ${w.name}: ${e.message.split('\n')[0]}`);
    }
  }
  console.log(`  models: ${exported} exported, ${wanted.length - exported} already present`);

  // Viewmodel clips.
  for (const s of VM_SETS) {
    const dir = path.join(RAW_DIR, 'vmanims', ...s.res.split('/').filter(Boolean));
    const have = fs.existsSync(dir) ? (await fsp.readdir(dir)).filter((f) => f.endsWith('.glb')).length : 0;
    if (force || !have) {
      await runVrf(
        vrf,
        ['-i', pak, '-f', s.res, '-d', '-o', path.join(RAW_DIR, 'vmanims'), '--gltf_export_format', 'glb', '--threads', String(threads)],
        `${s.key} viewmodel clips`
      );
    } else {
      console.log(`  ${s.key} viewmodel clips: ${have} present, skipping (use --force)`);
    }
  }
  return table;
}

// ---- shared glTF helpers ----------------------------------------------------

/** Bone nodes of a document by name (everything that is not a mesh holder). */
function boneMap(doc) {
  const out = new Map();
  for (const n of doc.getRoot().listNodes()) if (!n.getMesh()) out.set(n.getName(), n);
  return out;
}

/** World matrices for a rest-pose skeleton, keyed by bone name. */
function restWorld(rootNode) {
  const out = new Map();
  const walk = (n, parent) => {
    if (n.getMesh()) return;
    const m = parent.clone().multiply(new Matrix4().fromArray(n.getMatrix()));
    out.set(n.getName(), m);
    for (const c of n.listChildren()) walk(c, m);
  };
  for (const c of rootNode.listChildren()) walk(c, new Matrix4());
  return out;
}

/**
 * The skeleton root of a VRF export: the one top-level node that holds bones
 * rather than a mesh. Normalized to our frame (Source units, −90° about x) the
 * same way cs3d-models.mjs does it, so a weapon, a body and a pair of hands
 * all agree about which way is up.
 */
function normalizeSkeletonRoot(doc, label) {
  const scene = doc.getRoot().listScenes()[0];
  const roots = scene.listChildren().filter((n) => !n.getMesh());
  if (!roots.length) throw new Error(`${label}: no skeleton root`);
  const root = roots[0];
  const s = root.getScale();
  if (Math.abs(s[0] - 0.0254) > 1e-6) throw new Error(`${label}: unexpected root scale ${s}`);
  root.setTranslation([0, 0, 0]).setScale([1, 1, 1]);
  root.setRotation(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2).toArray());
  // root_motion carries a rotation on models and none on clips; fold it into
  // the children so both conventions meet (cs3d-models.mjs normalizeRootMotion).
  const rm = doc.getRoot().listNodes().find((n) => n.getName() === 'root_motion');
  if (rm) {
    const q = new Quaternion().fromArray(rm.getRotation());
    if (Math.abs(q.w) <= 0.9999) {
      for (const child of rm.listChildren()) {
        const ct = new Vector3().fromArray(child.getTranslation()).applyQuaternion(q);
        const cr = q.clone().multiply(new Quaternion().fromArray(child.getRotation()));
        child.setTranslation(ct.toArray()).setRotation(cr.toArray());
      }
      rm.setRotation([0, 0, 0, 1]);
    }
  }
  return root;
}

// ---- textures ---------------------------------------------------------------

const sharpOf = (tex) => sharp(Buffer.from(tex.getImage()), { limitInputPixels: false });

/** One channel of a texture at w×h, or its constant when it is a 1×1 stand-in. */
async function channelAt(tex, channel, w, h, fallback) {
  if (!tex) return { data: null, constant: fallback };
  const img = sharpOf(tex);
  const meta = await img.metadata();
  if ((meta.width || 1) <= 1 && (meta.height || 1) <= 1) {
    const { data } = await img.raw().toBuffer({ resolveWithObject: true });
    return { data: null, constant: data[Math.min(channel, (meta.channels || 1) - 1)] };
  }
  // Channel 3 IS the alpha and keeps it; every other channel drops it first, or
  // the resize premultiplies it away (lib/texAlpha.mjs).
  const src = channel === 3 ? img.ensureAlpha() : await dropAlpha(sharpOf(tex));
  const { data, info } = await src.resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(w * h);
  const ch = Math.min(channel, info.channels - 1);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels + ch];
  return { data: out, constant: null };
}

/** Source aspect, longest side capped — the ORM must not be squashed square. */
async function sizeOf(tex, cap) {
  if (!tex) return { w: cap, h: cap };
  const meta = await sharpOf(tex).metadata();
  if (!meta.width || !meta.height || (meta.width <= 1 && meta.height <= 1)) return { w: cap, h: cap };
  const k = Math.min(1, cap / Math.max(meta.width, meta.height));
  return { w: Math.max(1, Math.round(meta.width * k)), h: Math.max(1, Math.round(meta.height * k)) };
}

/**
 * The same channel layout the maps and the players use: albedo lossy, normal
 * near-lossless RGB, and one lossless ORM built from AO's R, the normal's
 * alpha (Source 2 keeps roughness there) and metalness's R.
 */
async function packMaterials(doc, label, cap = 512) {
  doc.createExtension(EXTTextureWebP).setRequired(true);
  let bytes = 0;
  const seen = new Map();
  for (const mat of doc.getRoot().listMaterials()) {
    const base = mat.getBaseColorTexture();
    const normal = mat.getNormalTexture();
    const ao = mat.getOcclusionTexture();
    const metal = mat.getMetallicRoughnessTexture();
    const key = [base, normal, ao, metal].map((t) => t?.getName() || '-').join('|');
    let p = seen.get(key);
    if (!p) {
      p = {};
      if (base) {
        const buf = await sharpOf(base).resize(cap, cap, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88, alphaQuality: 90, smartSubsample: true, effort: 4 }).toBuffer();
        p.base = doc.createTexture(`${label}_c`).setMimeType('image/webp').setImage(buf);
        bytes += buf.length;
      }
      if (normal) {
        const { data, info } = await (await dropAlpha(sharpOf(normal)))
          .resize(cap / 2, cap / 2, { fit: 'inside', withoutEnlargement: true })
          .raw({ depth: 'uchar' })
          .toBuffer({ resolveWithObject: true });
        if (normalIsBlank(data, info.channels)) {
          console.warn(`cs3d-weapons: ${label} — the normal map is blank across ${info.width}x${info.height}; using a flat normal`);
          for (let i = 0; i < data.length; i += info.channels) {
            data[i] = 128;
            data[i + 1] = 128;
            data[i + 2] = 255;
          }
        }
        const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
          .webp({ nearLossless: true, quality: 30, effort: 4 })
          .toBuffer();
        p.normal = doc.createTexture(`${label}_n`).setMimeType('image/webp').setImage(buf);
        bytes += buf.length;
      }
      const { w, h } = await sizeOf(normal || ao || metal, cap / 2);
      const [o, r, m] = await Promise.all([channelAt(ao, 0, w, h, 255), channelAt(normal, 3, w, h, 180), channelAt(metal, 0, w, h, 0)]);
      if (o.data || r.data || m.data) {
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
        const buf = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).webp({ lossless: true, effort: 4 }).toBuffer();
        p.orm = doc.createTexture(`${label}_orm`).setMimeType('image/webp').setImage(buf);
        bytes += buf.length;
      } else {
        p.roughness = r.constant / 255;
        p.metalness = m.constant / 255;
      }
      seen.set(key, p);
    }
    mat.setBaseColorTexture(p.base || null).setNormalTexture(p.normal || null).setEmissiveTexture(null);
    if (p.orm) mat.setMetallicRoughnessTexture(p.orm).setOcclusionTexture(p.orm).setMetallicFactor(1).setRoughnessFactor(1);
    else mat.setMetallicRoughnessTexture(null).setOcclusionTexture(null).setMetallicFactor(p.metalness).setRoughnessFactor(p.roughness);
    mat.setExtras({});
  }
  return bytes;
}

// ---- weapon models ----------------------------------------------------------

/**
 * One weapon, packed. Weapon models are rigid or lightly boned (bolt, trigger,
 * magazine); the pack keeps the skeleton so a later pass can drive those, and
 * the runtime hangs the whole thing off the viewmodel's `weapon` bone.
 */
async function packWeapon(w) {
  const src = path.join(RAW_DIR, 'models', ...`${w.model}.glb`.split('/'));
  if (!fs.existsSync(src)) return null;
  const doc = await io.read(src);
  // The physics/collision twin VRF writes beside the render model is not this.
  for (const mesh of doc.getRoot().listMeshes()) {
    if (/physics/i.test(mesh.getName())) {
      for (const parent of mesh.listParents()) if (parent.propertyType === PropertyType.NODE) parent.dispose();
      mesh.dispose();
    }
  }
  for (const a of doc.getRoot().listAnimations()) a.dispose();
  let root = null;
  try {
    root = normalizeSkeletonRoot(doc, w.name);
  } catch {
    // A rigid weapon has no bone root; give the mesh nodes our frame instead.
    const scene = doc.getRoot().listScenes()[0];
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2).toArray();
    for (const n of scene.listChildren()) {
      const s = n.getScale();
      if (Math.abs(s[0] - 0.0254) < 1e-6) n.setScale([1, 1, 1]).setRotation(q).setTranslation([0, 0, 0]);
    }
  }
  if (root) root.setName(w.name);
  const texBytes = await packMaterials(doc, w.name, 512);
  await doc.transform(prune(), dedup());
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const file = `w_${w.name}.glb`;
  const glb = await io.writeBinary(doc);
  await fsp.writeFile(path.join(PACK_DIR, file), glb);
  const tris = doc.getRoot().listMeshes().reduce((a, m) => a + m.listPrimitives().reduce((b, p) => b + (p.getIndices()?.getCount() || 0) / 3, 0), 0);
  const bones = [...boneMap(doc).keys()];
  return { file, bytes: glb.length, tris, texBytes, bones };
}

// ---- viewmodel arms ---------------------------------------------------------

/**
 * Move the agent's first-person arm meshes onto the viewmodel skeleton.
 *
 * The two rigs share the arm below the shoulder exactly but branch above it,
 * so the mesh cannot simply be reparented: it has to be re-bound. For every
 * vertex, `v' = Σ wᵢ · vmRest(bᵢ) · agentBindInverse(bᵢ) · v` puts the mesh
 * into the viewmodel's rest pose, and the new inverse binds are that rest
 * pose's inverses — after which the viewmodel clips drive it directly.
 *
 * The four forearm TWIST bones the viewmodel rig lacks are procedural in the
 * game (a constraint spreading wrist roll up the arm); their weight folds into
 * the parent, which costs a little forearm deformation and nothing else.
 */
function rebindArms(out, agentDoc, vmDoc, label) {
  const vmRootSrc = normalizeSkeletonRoot(vmDoc, `${label} viewmodel rig`);
  const vmRest = restWorld(vmRootSrc);
  const agentRoot = normalizeSkeletonRoot(agentDoc, `${label} agent`);
  const agentRest = restWorld(agentRoot);

  // Copy the viewmodel skeleton into the output document.
  const buffer = out.getRoot().listBuffers()[0] || out.createBuffer();
  const scene = out.getRoot().listScenes()[0] || out.createScene('viewmodel');
  const nodes = new Map();
  const copy = (n, parent) => {
    if (n.getMesh()) return;
    const nn = out.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
    nodes.set(n.getName(), nn);
    if (parent) parent.addChild(nn);
    for (const c of n.listChildren()) copy(c, nn);
  };
  const rigRoot = out.createNode(`${label}_vm`).setRotation(vmRootSrc.getRotation()).setScale([1, 1, 1]);
  scene.addChild(rigRoot);
  for (const c of vmRootSrc.listChildren()) copy(c, rigRoot);

  /** A joint the viewmodel rig lacks resolves to its nearest present ancestor. */
  const resolveJoint = (name) => {
    if (nodes.has(name)) return name;
    const m = /^(.*?)(_TWIST\d*)$/.exec(name);
    if (m && nodes.has(m[1])) return m[1];
    return null;
  };

  let moved = 0;
  let dropped = 0;
  const skinJoints = [];
  const seenJoint = new Map();
  const jointIndex = (name) => {
    if (seenJoint.has(name)) return seenJoint.get(name);
    const i = skinJoints.length;
    skinJoints.push(nodes.get(name));
    seenJoint.set(name, i);
    return i;
  };

  for (const node of agentDoc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin || !/firstperson/i.test(mesh.getName())) continue;
    const srcJoints = skin.listJoints().map((j) => j.getName());
    const ibmAcc = skin.getInverseBindMatrices();
    // agentBind(b) is the inverse of its inverse-bind; vmRest(b) is where the
    // same bone sits in the viewmodel's rest pose.
    const xform = srcJoints.map((name, i) => {
      const target = resolveJoint(name);
      if (!target) return null;
      const rest = vmRest.get(target);
      if (!rest) return null;
      const ibm = new Matrix4().fromArray(ibmAcc.getElement(i, []));
      return { target, m: rest.clone().multiply(ibm) };
    });

    const outMesh = out.createMesh(mesh.getName().split('.').pop());
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      const uvA = prim.getAttribute('TEXCOORD_0');
      const ji = prim.getAttribute('JOINTS_0');
      const wt = prim.getAttribute('WEIGHTS_0');
      const count = pos.getCount();
      const P = new Float32Array(count * 3);
      const N = new Float32Array(count * 3);
      const J = new Uint16Array(count * 4);
      const W = new Float32Array(count * 4);
      const el = [];
      const jj = [];
      const ww = [];
      const nn = [];
      const v = new Vector3();
      const acc = new Vector3();
      const accN = new Vector3();
      const tmp = new Vector3();
      for (let i = 0; i < count; i++) {
        pos.getElement(i, el);
        ji.getElement(i, jj);
        wt.getElement(i, ww);
        if (nrm) nrm.getElement(i, nn);
        acc.set(0, 0, 0);
        accN.set(0, 0, 0);
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const w = ww[k];
          if (!(w > 0)) continue;
          const x = xform[jj[k]];
          if (!x) {
            dropped++;
            continue;
          }
          tmp.set(el[0], el[1], el[2]).applyMatrix4(x.m).multiplyScalar(w);
          acc.add(tmp);
          if (nrm) {
            tmp.set(nn[0], nn[1], nn[2]).transformDirection(x.m).multiplyScalar(w);
            accN.add(tmp);
          }
          const idx = jointIndex(x.target);
          J[i * 4 + total] = idx;
          W[i * 4 + total] = w;
          total++;
        }
        if (!total) {
          // Nothing survived: leave the vertex where it was, unweighted.
          v.set(el[0], el[1], el[2]);
          acc.copy(v);
          J[i * 4] = 0;
          W[i * 4] = 1;
        }
        P[i * 3] = acc.x;
        P[i * 3 + 1] = acc.y;
        P[i * 3 + 2] = acc.z;
        if (nrm) {
          accN.normalize();
          N[i * 3] = accN.x;
          N[i * 3 + 1] = accN.y;
          N[i * 3 + 2] = accN.z;
        }
        moved++;
      }
      const p = out.createPrimitive().setMaterial(null);
      p.setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(P).setBuffer(buffer));
      if (nrm) p.setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(N).setBuffer(buffer));
      if (uvA) {
        const uv = new Float32Array(count * 2);
        const e2 = [];
        for (let i = 0; i < count; i++) {
          uvA.getElement(i, e2);
          uv[i * 2] = e2[0];
          uv[i * 2 + 1] = e2[1];
        }
        p.setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
      }
      p.setAttribute('JOINTS_0', out.createAccessor().setType('VEC4').setArray(J).setBuffer(buffer));
      p.setAttribute('WEIGHTS_0', out.createAccessor().setType('VEC4').setArray(W).setBuffer(buffer));
      const idx = prim.getIndices();
      if (idx) {
        const arr = new Uint32Array(idx.getCount());
        for (let i = 0; i < idx.getCount(); i++) arr[i] = idx.getScalar(i);
        p.setIndices(out.createAccessor().setType('SCALAR').setArray(arr).setBuffer(buffer));
      }
      // Materials are copied by name from the agent pack's own textures later;
      // for now carry the source material's name so the packer can match it.
      p.setExtras({ material: prim.getMaterial()?.getName() || null });
      outMesh.addPrimitive(p);
    }
    const node2 = out.createNode(mesh.getName().split('.').pop()).setMesh(outMesh);
    scene.addChild(node2);
    node2.setSkin(null); // set below, once every joint is known
    outMesh.setExtras({ needsSkin: true });
  }

  // One skin over every joint the arms actually use.
  const ibm = new Float32Array(skinJoints.length * 16);
  skinJoints.forEach((j, i) => {
    const rest = vmRest.get(j.getName());
    const inv = rest ? rest.clone().invert() : new Matrix4();
    inv.toArray(ibm, i * 16);
  });
  const skin = out
    .createSkin('viewmodel')
    .setInverseBindMatrices(out.createAccessor().setType('MAT4').setArray(ibm).setBuffer(buffer))
    .setSkeleton(rigRoot);
  for (const j of skinJoints) skin.addJoint(j);
  for (const n of out.getRoot().listNodes()) if (n.getMesh()?.getExtras()?.needsSkin) n.setSkin(skin);

  return { rigRoot, nodes, joints: skinJoints.length, moved, dropped };
}

// ---- viewmodel clips --------------------------------------------------------

/** Every exported clip of a set, by its stripped name. */
function listVmClips(set) {
  const dir = path.join(RAW_DIR, 'vmanims', ...set.res.split('/').filter(Boolean));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.glb'))
    .map((f) => ({ name: f.replace(/\.glb$/, '').replace(set.strip, ''), file: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One glb per clip set: the viewmodel skeleton plus every clip as a glTF
 * animation, retargetable by bone name — the same shape cs3d-models.mjs packs
 * the world-model clips in.
 */
async function packVmSet(set) {
  const files = listVmClips(set);
  if (!files.length) {
    console.warn(`  ! ${set.key}: no viewmodel clips under raw/weapons/vmanims/${set.res}`);
    return null;
  }
  const out = new Document();
  const buffer = out.createBuffer();
  const scene = out.createScene('vmanims');
  const nodes = new Map();
  const clips = [];
  let kept = 0;
  let dropped = 0;

  for (const c of files) {
    const doc = await io.read(c.file);
    const anim = doc.getRoot().listAnimations()[0];
    if (!anim) continue;
    if (!nodes.size) {
      normalizeSkeletonRoot(doc, `${set.key} rig`);
      const src = doc.getRoot().listScenes()[0].listChildren().filter((n) => !n.getMesh());
      const copy = (n, parent) => {
        if (n.getMesh()) return;
        const nn = out.createNode(n.getName()).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
        nodes.set(n.getName(), nn);
        if (parent) parent.addChild(nn);
        else scene.addChild(nn);
        for (const ch of n.listChildren()) copy(ch, nn);
      };
      for (const n of src) copy(n, null);
    }
    const a = out.createAnimation(c.name);
    // The clip's length first, over every channel. A clip where some bones are
    // animated and others hold one key (a shoot is 13 frames of arm over a
    // still forearm) must take its length from the animated ones — padding
    // each still channel to a second turned a 0.37 s shot into a 1 s one.
    let duration = 0;
    for (const ch of anim.listChannels()) {
      const inp = ch.getSampler().getInput();
      duration = Math.max(duration, inp.getElement(inp.getCount() - 1, [])[0]);
    }
    // Every channel a single key: a pose, not an animation. Give it a second
    // to hold, because three's mixer cannot loop a zero-length clip.
    const isPose = duration <= 1e-6;
    if (isPose) duration = 1;
    for (const ch of anim.listChannels()) {
      const pathName = ch.getTargetPath();
      if (pathName === 'scale') continue;
      const target = nodes.get(ch.getTargetNode()?.getName());
      if (!target) {
        dropped++;
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
        if (still) continue;
      }
      kept++;
      let inData = new Float32Array(inArr);
      let outData = new Float32Array(outArr);
      // Only a whole-clip pose gets stretched; a single key inside an animated
      // clip is a bone holding still, which the mixer already does.
      if (isPose && inArr.length === 1) {
        inData = new Float32Array([0, duration]);
        outData = new Float32Array([...outArr, ...outArr]);
      }
      const sampler = out
        .createAnimationSampler()
        .setInput(out.createAccessor().setType('SCALAR').setArray(inData).setBuffer(buffer))
        .setOutput(
          out
            .createAccessor()
            .setType(pathName === 'rotation' ? 'VEC4' : 'VEC3')
            .setArray(outData)
            .setBuffer(buffer)
        )
        .setInterpolation(s.getInterpolation());
      a.addSampler(sampler).addChannel(out.createAnimationChannel().setTargetNode(target).setTargetPath(pathName).setSampler(sampler));
    }
    clips.push({ name: c.name, duration: +duration.toFixed(4) });
  }

  await out.transform(resample({ tolerance: 1e-4 }), dedup({ propertyTypes: [PropertyType.ACCESSOR] }), prune());
  out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const file = `vmanims_${set.key}.glb`;
  const glb = await io.writeBinary(out);
  await fsp.writeFile(path.join(PACK_DIR, file), glb);
  console.log(`  ${set.key} viewmodel: ${clips.length} clips, ${nodes.size} bones, ${kept} channels (${dropped} off-rig) → ${fmtMB(glb.length)}`);
  return { file, bytes: glb.length, clips };
}

/**
 * A melee weapon's attack rate, which is in neither file that should have it.
 *
 * `scripts/weapons.vdata_c` gives every knife the base `m_flCycleTime =
 * [0.15, 0.3]` — no knife entry overrides it, and it is not the swing rate.
 * `scripts/items/items_game.txt` only declares `cycletime` as an attribute
 * class in CS2; the per-weapon values moved into the vdata. And the swing
 * ANIMATIONS are 1.13 s (light) and 1.10 s (heavy), which is the whole
 * wind-up-and-settle, not how often the game lets you swing — in play the
 * next attack cuts the previous one off.
 *
 * So this is the one number here that is not extracted, and it is marked as
 * such. `[verify]` against the CS2-server instrument when it exists; the clip
 * lengths ride along in the manifest so the comparison is one read away.
 */
const KNIFE_ATTACK = Object.freeze({
  /** [guessed] seconds between primary (left) swings. */
  primary: 0.4,
  /** [guessed] seconds between secondary (right) swings. */
  secondary: 1.0,
  provenance: 'guessed: absent from weapons.vdata and items_game; community-measured CSGO/CS2 value'
});

/** The swing clip lengths, so the guess above can be checked against them. */
function measureKnifeClips(clips) {
  const longest = (re) => clips.filter((c) => re.test(c.name)).reduce((a, c) => Math.max(a, c.duration), 0);
  return { lightClip: +longest(/^light_(hit|miss)/).toFixed(4) || null, heavyClip: +longest(/^heavy_(hit|miss)/).toFixed(4) || null };
}

// ---- main -------------------------------------------------------------------

async function main() {
  assertLocalOutput(TAG, RAW_DIR);
  assertLocalOutput(TAG, PACK_DIR);
  let table;
  if (!skipImport) {
    const vrf = findVrf(TAG);
    const gameDir = findGameDir(TAG, opt('--game'));
    console.log(`${TAG}: VRF ${path.relative(ROOT, vrf)}, game ${gameDir}`);
    table = await importAll(vrf, gameDir);
  } else {
    table = readWeaponTable(await fsp.readFile(path.join(RAW_DIR, 'weapons.vdata.txt'), 'utf8'));
  }
  await MeshoptEncoder.ready;
  await fsp.mkdir(PACK_DIR, { recursive: true });
  console.log(`${TAG}: packing → ${path.relative(ROOT, PACK_DIR)}`);

  // ---- weapons ----
  const weapons = {};
  let wBytes = 0;
  let missing = 0;
  for (const w of Object.values(table)) {
    let packed = null;
    try {
      packed = await packWeapon(w);
    } catch (e) {
      console.warn(`  ! ${w.name}: ${e.message}`);
    }
    if (!packed) {
      missing++;
      continue;
    }
    wBytes += packed.bytes;
    const { raw, model, ...stats } = w;
    weapons[w.name] = { ...stats, class: classOf(w), file: packed.file, bytes: packed.bytes, tris: packed.tris, bones: packed.bones };
  }
  console.log(`  weapons: ${Object.keys(weapons).length} packed (${missing} without a model) → ${fmtMB(wBytes)}`);

  // ---- viewmodel clips ----
  const vmanims = {};
  for (const s of VM_SETS) {
    const r = await packVmSet(s);
    if (r) vmanims[s.key] = r;
  }
  // The knife's rate is in neither data file; see KNIFE_ATTACK.
  if (vmanims.knife) {
    const c = measureKnifeClips(vmanims.knife.clips);
    for (const w of Object.values(weapons)) {
      if (!w.melee) continue;
      w.cycleTime = [KNIFE_ATTACK.primary, KNIFE_ATTACK.secondary];
      w.cycleTimeProvenance = KNIFE_ATTACK.provenance;
      w.swingClipSeconds = c;
    }
    console.log(
      `  knife: attack ${KNIFE_ATTACK.primary}s / ${KNIFE_ATTACK.secondary}s [guessed — not in the vdata]; ` +
        `swing clips run ${c.lightClip}s / ${c.heavyClip}s`
    );
  }

  // ---- viewmodel arms ----
  const arms = {};
  const vmRigFile = listVmClips(VM_SETS[0])[0]?.file;
  for (const a of AGENTS) {
    const agentGlb = path.join(PLAYERS_RAW, 'agents', 'models', a.name, `${a.name}.glb`);
    if (!fs.existsSync(agentGlb) || !vmRigFile) {
      console.warn(`  ! ${a.side} arms: need raw/players (npm run cs3d:models) and the rifle clips`);
      continue;
    }
    try {
      const out = new Document();
      out.createBuffer();
      out.createScene('viewmodel');
      const agentDoc = await io.read(agentGlb);
      const vmDoc = await io.read(vmRigFile);
      const r = rebindArms(out, agentDoc, vmDoc, a.side);
      // Carry the agent's arm materials across by name.
      const byName = new Map(agentDoc.getRoot().listMaterials().map((m) => [m.getName(), m]));
      for (const mesh of out.getRoot().listMeshes()) {
        mesh.setExtras({});
        for (const prim of mesh.listPrimitives()) {
          const want = prim.getExtras()?.material;
          prim.setExtras({});
          const src = want && byName.get(want);
          if (!src) continue;
          const copy = out.createMaterial(src.getName());
          copy.setBaseColorFactor(src.getBaseColorFactor()).setAlphaMode(src.getAlphaMode()).setDoubleSided(src.getDoubleSided());
          for (const [get, set] of [
            ['getBaseColorTexture', 'setBaseColorTexture'],
            ['getNormalTexture', 'setNormalTexture'],
            ['getOcclusionTexture', 'setOcclusionTexture'],
            ['getMetallicRoughnessTexture', 'setMetallicRoughnessTexture']
          ]) {
            const t = src[get]();
            if (!t) continue;
            copy[set](out.createTexture(t.getName()).setMimeType(t.getMimeType()).setImage(t.getImage()));
          }
          copy.setExtras({ cs3d: src.getExtras()?.cs3d || null });
          prim.setMaterial(copy);
        }
      }
      const texBytes = await packMaterials(out, `${a.side}_arms`, 1024);
      // Prune everything EXCEPT nodes: the arms glb is also the rig, and the
      // bones the mesh does not weight are exactly the ones that matter for
      // attaching — `wpn` and the weapon's own `weapon` / `weapon_offset`,
      // which the clips animate and the gun hangs off. A default prune drops
      // them for being unused and leaves nowhere to put the weapon.
      await out.transform(
        prune({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MATERIAL, PropertyType.TEXTURE, PropertyType.MESH, PropertyType.PRIMITIVE] }),
        dedup()
      );
      await out.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }));
      out.createExtension(KHRMeshQuantization).setRequired(true);
      out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
      const file = `vm_arms_${a.side}.glb`;
      const glb = await io.writeBinary(out);
      await fsp.writeFile(path.join(PACK_DIR, file), glb);
      arms[a.side] = { file, bytes: glb.length, joints: r.joints };
      console.log(`  ${a.side} arms: ${r.joints} joints, ${r.moved} vertices rebound${r.dropped ? `, ${r.dropped} weights folded` : ''} (${fmtMB(texBytes)} textures) → ${fmtMB(glb.length)}`);
    } catch (e) {
      console.warn(`  ! ${a.side} arms: ${e.stack || e.message}`);
    }
  }

  const manifest = {
    version: PACK_VERSION,
    generated: new Date().toISOString(),
    frame: { units: 'source', up: 'z', forward: '+x', rootRotationX: -90 },
    weapons,
    viewmodel: { arms, anims: vmanims }
  };
  await fsp.writeFile(path.join(PACK_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
  const total = wBytes + Object.values(vmanims).reduce((a, s) => a + s.bytes, 0) + Object.values(arms).reduce((a, s) => a + s.bytes, 0);
  console.log(`${TAG}: done — ${fmtMB(total)} in ${path.relative(ROOT, PACK_DIR)} (local only, not in git)`);
}

main().catch((e) => fail(e.stack || e.message));
