// ---------------------------------------------------------------------------
// src/cs3d/playerModels.js
// The player bodies: CS2's own agent models and world-model clips, packed by
// scripts/cs3d-models.mjs, loaded once and cloned per body, animated by a
// small locomotion blend that stands in for the game's animation graph.
//
// The graph is behaviour, not data — nothing in the .vpk says "run_ne at this
// weight" — so it is re-derived here from what the tick record carries:
// speed, movement direction relative to the view, duck amount, airborne, the
// held weapon's class. That is exactly the input CS2's graph reads too, so a
// closer port only ever changes this file.
//
// What the blend does, in one paragraph. Two layers, stand and crouch, mixed
// by the duck amount. Each layer is an 8-way directional loop (n, ne, e, ...)
// picked by the angle between where the feet are going and where the eyes
// look, the two nearest directions blended by angle; the stand layer also
// blends idle → walk → run by speed. Every loop is authored in place at one
// speed (the pack measured it from the planted foot: run 182, walk 104,
// crouch 92 u/s), so all of them share one phase advanced at
// speed / (authored speed × loop length) — the same cadence rule the game's
// graph uses — and are read at that phase rather than left to free-run, which
// is what keeps the walk→run cross-blend from double-stepping. Airborne
// replaces the lot with the in-air pose. Pitch is applied after the mixer as
// a spine-to-head tilt, because every clip is authored looking level.
//
// Two build-of-three notes, because the island runs on 'three/webgpu' and
// GLTFLoader / SkeletonUtils import plain 'three' (a second copy of the core):
//   - the loaded objects (SkinnedMesh, Bone, Skeleton, AnimationClip) and the
//     mixer come from that plain copy, and everything between them stays in it;
//     the WebGPU renderer reads them by duck typing (isSkinnedMesh, skeleton.
//     boneMatrices, bindMatrix) and renders them fine.
//   - the loader's MeshStandardMaterial would be converted by the renderer at
//     first draw; instead it is rebuilt here as an explicit
//     MeshStandardNodeMaterial so the body takes the scene's sun and probe on
//     the same terms as any prop, and so a later per-map term (baked shadow
//     mask, probe volume) has a material of ours to land in.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AnimationMixer, LoopRepeat, LoopOnce } from 'three';
import { WEAPON_SPEED, DEFAULT_WEAPON_SPEED } from '../../shared/sim/constants.js';
import { WALK_SPEED_SCALE } from '../../shared/sim3d/constants.js';
import { assetBase } from './mapLoader.js';

export const PLAYERS_PACK_VERSION = 1;

const DEG = Math.PI / 180;

/** The eight directional loops, by the angle (Source degrees, CCW = left) they move in. */
const DIRS = [
  { key: 'n', angle: 0 },
  { key: 'nw', angle: 45 },
  { key: 'w', angle: 90 },
  { key: 'sw', angle: 135 },
  { key: 's', angle: 180 },
  { key: 'se', angle: -135 },
  { key: 'e', angle: -90 },
  { key: 'ne', angle: -45 }
];
/** The in-air loops only come in five flavours. */
const AIR_DIRS = [
  { key: 'n', angle: 0 },
  { key: 'w', angle: 90 },
  { key: 's', angle: 180 },
  { key: 'e', angle: -90 }
];

/** Below this the body is standing still: idle, no phase advance. */
const IDLE_SPEED = 6;
/** Speed above which an airborne body picks a directional in-air pose. */
const AIR_MOVE_SPEED = 40;

/**
 * Bones that share the view pitch, top of the spine to the head, and how much
 * of it each takes. The clips are authored aiming level; the game blends an
 * aim matrix on top. Weights sum to 1 so the gun ends up on the pitch.
 */
const AIM_BONES = [
  ['spine_1', 0.15],
  ['spine_2', 0.2],
  ['spine_3', 0.25],
  ['neck_0', 0.15],
  ['head_0', 0.25]
];

/** Which clip set animates a weapon; grenades and the bomb use pistol legs. */
export function weaponClassOf(weaponName) {
  const w = String(weaponName || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  if (!w) return 'rifle';
  if (w === 'knife' || w.startsWith('knife') || w === 'bayonet') return 'knife';
  if (w === 'c4') return 'c4';
  if (/grenade|flashbang|molotov|decoy|smoke|incgrenade/.test(w)) return 'grenade';
  if (['glock', 'hkp2000', 'usp_silencer', 'p250', 'fiveseven', 'tec9', 'cz75a', 'elite', 'deagle', 'revolver', 'taser'].includes(w)) return 'pistol';
  return 'rifle';
}

/** Locomotion set for a weapon class (grenade / c4 have no loops of their own). */
const LOCO_SET = { rifle: 'rifle', pistol: 'pistol', knife: 'knife', grenade: 'pistol', c4: 'pistol' };

/**
 * Weapon run speed for the cadence and gait anchors. Knife skins are knives
 * (250); a grenade in hand runs at 245 (the corpus, see deriveFlags.js).
 */
export function runSpeedOf(weaponName) {
  const cls = weaponClassOf(weaponName);
  if (cls === 'knife') return WEAPON_SPEED.knife;
  if (cls === 'grenade') return 245;
  const w = String(weaponName || '')
    .toLowerCase()
    .replace(/^weapon_/, '');
  return WEAPON_SPEED[w] ?? DEFAULT_WEAPON_SPEED;
}

const wrap180 = (d) => {
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return d;
};

// ---------------------------------------------------------------------------

export class PlayerModels {
  /**
   * @param {object} [o]
   * @param {string} [o.base]  pack URL prefix; default `${assetBase()}/players`
   */
  constructor({ base } = {}) {
    this.base = base || `${assetBase()}/players`;
    this.manifest = null;
    this.ready = false;
    this.failed = null;
    /** side → { scene: Object3D (skinned template), hitboxes } */
    this.models = {};
    /** set → Map<clip name, AnimationClip> */
    this.clips = {};
    /** set → { run, walk, crouch } authored u/s */
    this.gait = {};
    this._loading = null;
    this._materials = new Map();
  }

  /** Fetch the manifest, both models and every clip set. Resolves to `ready`. */
  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('cs3d: player models unavailable, keeping placeholder bodies —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const res = await fetch(`${this.base}/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`no players pack (${res.status} from ${this.base}/manifest.json)`);
    const manifest = await res.json();
    if (manifest.version !== PLAYERS_PACK_VERSION) {
      throw new Error(`players pack is v${manifest.version}; this build reads v${PLAYERS_PACK_VERSION}. Re-run cs3d-models.`);
    }
    this.manifest = manifest;
    const v = `?v=${encodeURIComponent(manifest.generated || String(manifest.version))}`;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const load = (file) =>
      new Promise((resolve, reject) => loader.load(`${this.base}/${file}${v}`, resolve, undefined, (e) => reject(new Error(`${file}: ${e?.message || e}`))));

    const modelJobs = Object.entries(manifest.models).map(async ([side, m]) => {
      const gltf = await load(m.file);
      const scene = gltf.scene;
      scene.traverse((o) => {
        if (!o.isMesh) return;
        o.material = this._bodyMaterial(o.material);
        // Bounds are the bind pose; a running body leaves them every stride.
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      this.models[side] = { scene, hitboxes: m.hitboxes, bones: m.bones, name: m.name };
    });
    const clipJobs = Object.entries(manifest.anims).map(async ([set, a]) => {
      const gltf = await load(a.file);
      const map = new Map();
      for (const clip of gltf.animations) map.set(clip.name, clip);
      this.clips[set] = map;
      this.gait[set] = a.gaitSpeed || {};
    });
    await Promise.all([...modelJobs, ...clipJobs]);
    if (!this.models.T || !this.models.CT) throw new Error('players pack lacks a T or CT model');
  }

  /**
   * The body material: the loader's PBR maps on a node material of ours, lit
   * by the scene's directional sun (with its shadow map) and the sky probe —
   * the same path a map prop takes when it carries no baked terms.
   */
  _bodyMaterial(src) {
    let m = this._materials.get(src);
    if (m) return m;
    m = new THREE.MeshStandardNodeMaterial();
    m.name = src.name;
    m.color.copy(src.color);
    m.map = src.map || null;
    m.normalMap = src.normalMap || null;
    if (src.normalScale) m.normalScale.copy(src.normalScale);
    m.roughnessMap = src.roughnessMap || null;
    m.metalnessMap = src.metalnessMap || null;
    m.aoMap = src.aoMap || null;
    m.roughness = src.roughness;
    m.metalness = src.metalness;
    m.side = THREE.FrontSide;
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) if (t) t.anisotropy = 8;
    this._materials.set(src, m);
    return m;
  }

  /** A new body for a side ('T' | 'CT'). Only valid once `ready`. */
  createBody(side) {
    return new PlayerBody(this, side);
  }
}

// ---------------------------------------------------------------------------

/**
 * One animated body. Drive it with `set(state)` every frame and `update(dt)`;
 * `group` is the scene object to place (position in scene units, `rotation.y`
 * is the Source yaw in radians — the packed model faces +x).
 */
export class PlayerBody {
  constructor(models, side) {
    this.models = models;
    this.side = null;
    this.group = new THREE.Group();
    this.group.name = 'player';
    this.model = null;
    this.mixer = null;
    this.actions = new Map(); // `${set}/${name}` → AnimationAction
    this.aimBones = [];
    this.oneShot = null; // { action, until }
    /** Blend inputs, smoothed. */
    this.speed = 0;
    this.relYaw = 0;
    this.air = 0;
    this.duck = 0;
    this.pitch = 0;
    this.phase = 0;
    this.locoSet = 'rifle';
    /** set → weight, eased, so a weapon switch cross-fades the locomotion set. */
    this.setWeights = new Map();
    this.runSpeed = DEFAULT_WEAPON_SPEED;
    this.state = {
      speed: 0,
      moveYaw: 0,
      viewYaw: 0,
      pitch: 0,
      duck: 0,
      airborne: false,
      weapon: '',
      alive: true
    };
    this.setSide(side);
  }

  /** Swap the team model (teams change sides at half). */
  setSide(side) {
    if (side === this.side) return;
    const tmpl = this.models.models[side];
    if (!tmpl) return;
    if (this.model) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
      this.group.remove(this.model);
    }
    this.side = side;
    this.model = cloneSkinned(tmpl.scene);
    this.group.add(this.model);
    this.mixer = new AnimationMixer(this.model);
    this.actions.clear();
    this.setWeights.clear();
    this.oneShot = null;
    // The packed model root (rotated −90° about x): under it everything is in
    // Source's frame, which is where the aim tilt is expressed.
    const rootMotion = this.model.getObjectByName('root_motion');
    this.frameNode = rootMotion ? rootMotion.parent : this.model;
    this.aimBones = [];
    for (const [name, w] of AIM_BONES) {
      const b = this.model.getObjectByName(name);
      if (b) this.aimBones.push({ bone: b, w });
    }
    this.hitboxes = tmpl.hitboxes;
  }

  /** Per-frame inputs. Angles in Source degrees; speed u/s; duck 0..1. */
  set(state) {
    Object.assign(this.state, state);
  }

  _action(set, name, loop = true) {
    const key = `${set}/${name}`;
    let a = this.actions.get(key);
    if (a) return a;
    const clip = this.models.clips[set]?.get(name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    a.weight = 0;
    // Loops are read at the shared phase, not free-run (see header).
    a.timeScale = loop ? 0 : 1;
    a.play();
    this.actions.set(key, a);
    return a;
  }

  /**
   * Play a full-body clip once over the locomotion (plant, throw, death).
   * Locomotion weights are scaled down by the one-shot's weight while it runs.
   */
  playOnce(set, name, { fade = 0.12 } = {}) {
    const a = this._action(set, name, false);
    if (!a) return null;
    a.reset();
    a.weight = 1;
    a.fadeIn(fade);
    this.oneShot = { action: a, fade };
    return a;
  }

  /**
   * Advance the blend and the mixer. `dt` seconds of wall time (or demo time,
   * when scrubbing).
   */
  update(dt) {
    if (!this.model) return;
    const s = this.state;
    const g = this.group;
    g.visible = !!s.alive;
    if (!s.alive) return;
    g.rotation.y = s.viewYaw * DEG;

    // Smooth the blend inputs: a demo's per-tick velocity is quantised to
    // ¼ u / tick, and the direction of a nearly-still body is noise.
    const k = 1 - Math.exp(-dt / 0.08);
    this.speed += (s.speed - this.speed) * k;
    const rel = s.speed > IDLE_SPEED ? wrap180(s.moveYaw - s.viewYaw) : this.relYaw;
    this.relYaw += wrap180(rel - this.relYaw) * k;
    this.relYaw = wrap180(this.relYaw);
    this.air += ((s.airborne ? 1 : 0) - this.air) * (1 - Math.exp(-dt / 0.06));
    this.duck += (Math.max(0, Math.min(1, s.duck)) - this.duck) * (1 - Math.exp(-dt / 0.05));
    this.pitch += (s.pitch - this.pitch) * (1 - Math.exp(-dt / 0.04));

    const cls = weaponClassOf(s.weapon);
    const set = this.models.clips[LOCO_SET[cls]] ? LOCO_SET[cls] : 'rifle';
    this.locoSet = set;
    this.runSpeed = runSpeedOf(s.weapon);

    this._blend(set, dt);
    this.mixer.update(dt);
    this._aim();
  }

  /**
   * Locomotion weights and the shared phase. The current set eases in and the
   * previous one out (a weapon switch cross-fades rifle legs into knife legs
   * rather than popping); each set with any weight gets the same blend.
   */
  _blend(set, dt) {
    const sw = this.setWeights;
    if (!sw.has(set)) sw.set(set, sw.size ? 0 : 1);
    const ease = 1 - Math.exp(-dt / 0.12);
    let total = 0;
    for (const [k, w] of sw) {
      const nw = w + ((k === set ? 1 : 0) - w) * ease;
      if (k !== set && nw < 1e-3) sw.delete(k);
      else {
        sw.set(k, nw);
        total += nw;
      }
    }

    // Everything under a running one-shot is scaled down by its weight.
    let locoScale = 1;
    if (this.oneShot) {
      const a = this.oneShot.action;
      const clip = a.getClip();
      if (a.time >= clip.duration - 1e-3 || !a.isRunning()) {
        a.fadeOut(this.oneShot.fade);
        this.oneShot = null;
      } else locoScale = 1 - a.getEffectiveWeight();
    }

    // Zero every loop's weight, then add the ones that carry it. Actions are
    // created lazily; a set that lacks a clip simply contributes nothing.
    for (const a of this.actions.values()) if (a.timeScale === 0) a.weight = 0;

    let phaseAdvanced = false;
    for (const [k, w] of sw) {
      const scale = (w / (total || 1)) * locoScale;
      if (scale < 1e-4) continue;
      // The phase advances once, on the current set's cadence.
      this._blendSet(k, scale, k === set && !phaseAdvanced ? dt : 0);
      if (k === set) phaseAdvanced = true;
    }
  }

  /** One locomotion set's loops at `scale` of the body's weight. */
  _blendSet(set, scale, dt) {
    const gait = this.models.gait[set] || {};
    const speed = this.speed;
    const duck = this.duck;
    const air = this.air;
    const walkRef = this.runSpeed * WALK_SPEED_SCALE;
    const runRef = this.runSpeed;

    // Gait weights on the stand layer: idle → walk → run by speed.
    let wIdle = 0;
    let wWalk = 0;
    let wRun = 0;
    if (speed <= IDLE_SPEED) wIdle = 1;
    else if (speed < walkRef) {
      wWalk = (speed - IDLE_SPEED) / (walkRef - IDLE_SPEED);
      wIdle = 1 - wWalk;
    } else if (speed < runRef) {
      wRun = (speed - walkRef) / (runRef - walkRef);
      wWalk = 1 - wRun;
    } else wRun = 1;
    // Crouch layer: idle_crouch → crouch loop.
    const crouchRef = Math.max(20, this.runSpeed * 0.34);
    const wCrouchMove = speed <= IDLE_SPEED ? 0 : Math.min(1, (speed - IDLE_SPEED) / (crouchRef - IDLE_SPEED));

    // Directional weights: the two nearest of eight.
    const dir = dirWeights(DIRS, this.relYaw);
    const airDir = speed > AIR_MOVE_SPEED ? dirWeights(AIR_DIRS, this.relYaw) : null;

    // Shared phase: cadence is a weighted mix of each active loop's cycles/s.
    const cps = (name, w) => {
      if (!(w > 0)) return 0;
      const clip = this.models.clips[set]?.get(name);
      const authored = gait[name.split('_')[0]];
      if (!clip || !authored || clip.duration <= 0) return 0;
      return (w * speed) / (authored * clip.duration);
    };
    let rate = 0;
    let rateW = 0;
    for (const [gaitName, w] of [
      ['walk', wWalk * (1 - duck)],
      ['run', wRun * (1 - duck)],
      ['crouch', wCrouchMove * duck]
    ]) {
      if (!(w > 0)) continue;
      rate += cps(`${gaitName}_n`, w);
      rateW += w;
    }
    if (rateW > 0 && dt > 0) {
      this.phase += (rate / rateW) * dt;
      this.phase -= Math.floor(this.phase);
    }

    const ground = (1 - air) * scale;
    const airW = air * scale;

    const add = (name, w) => {
      if (!(w > 1e-4)) return;
      const a = this._action(set, name, true);
      if (!a) return;
      a.weight += w;
      const d = a.getClip().duration;
      a.time = d > 0 ? this.phase * d : 0;
    };
    // Stand layer.
    add('idle', ground * (1 - duck) * wIdle);
    for (const [d, w] of dir) {
      add(`walk_${d}`, ground * (1 - duck) * wWalk * w);
      add(`run_${d}`, ground * (1 - duck) * wRun * w);
    }
    // Crouch layer.
    add('idle_crouch', ground * duck * (1 - wCrouchMove));
    for (const [d, w] of dir) add(`crouch_${d}`, ground * duck * wCrouchMove * w);
    // Airborne.
    if (airW > 1e-4) {
      if (airDir) {
        for (const [d, w] of airDir) {
          add(`inair_${d}`, airW * (1 - duck) * w);
          add(`inair_crouch_${d}`, airW * duck * w);
        }
      } else {
        add('inair_stand', airW * (1 - duck));
        add('inair_crouch_stand', airW * duck);
      }
    }
    // Idle poses hold a still frame; do not let the phase scrub them.
    for (const name of ['idle', 'idle_crouch', 'inair_stand', 'inair_crouch_stand']) {
      const a = this.actions.get(`${set}/${name}`);
      if (a) a.time = 0;
    }
  }

  /**
   * View pitch as a spine-to-head tilt about the body's lateral axis, applied
   * on top of the mixer's pose. In the model root frame (Source: +x forward,
   * +y left, +z up) a positive Source pitch (looking down) is a positive
   * rotation about +y.
   */
  _aim() {
    if (!this.aimBones.length) return;
    const total = this.pitch * DEG;
    if (Math.abs(total) < 1e-4) return;
    for (const { bone, w } of this.aimBones) {
      _qDelta.setFromAxisAngle(_yAxis, total * w);
      // Parent's orientation in the model root frame (Source axes), from live
      // local values — the chain stops under the −90° root, so +y is lateral.
      _qParent.identity();
      for (let p = bone.parent; p && p !== this.frameNode && p !== this.model; p = p.parent) _qParent.premultiply(p.quaternion);
      _qTmp.copy(_qParent).invert().multiply(_qDelta).multiply(_qParent);
      bone.quaternion.premultiply(_qTmp);
    }
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.model);
    }
    this.group.removeFromParent();
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0);
const _qDelta = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();

/**
 * Weights of the two directional loops bracketing `angle` (Source degrees,
 * wrapped), as [key, weight] pairs. Directions are on an evenly spaced ring
 * for DIRS; AIR_DIRS is 90° spaced.
 */
function dirWeights(ring, angle) {
  const step = 360 / ring.length;
  let best = null;
  let bestD = 1e9;
  for (const d of ring) {
    const dd = Math.abs(wrap180(angle - d.angle));
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  const off = wrap180(angle - best.angle); // signed offset from the nearest
  const t = Math.min(1, Math.abs(off) / step);
  if (t < 1e-4) return [[best.key, 1]];
  // Neighbour on the side of the offset.
  const nb = ring.reduce((acc, d) => {
    const dd = wrap180(d.angle - best.angle);
    if (Math.sign(dd) === Math.sign(off) && Math.abs(Math.abs(dd) - step) < 1e-3) return d;
    return acc;
  }, null);
  if (!nb) return [[best.key, 1]];
  return [
    [best.key, 1 - t],
    [nb.key, t]
  ];
}
