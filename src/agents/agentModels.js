// ---------------------------------------------------------------------------
// src/agents/agentModels.js
// CS2's own agent models (the CT and T characters) and their world-model
// animation clips, in the trainer's WebGL scene.
//
// The pack and the blend are the map explorer's: `scripts/cs3d-models.mjs`
// builds `players/`, and `src/cs3d/playerModels.js` works out which loops to
// mix at what weight. This file is the WebGL-side twin of that blend — same
// rings, same phase rule, same aim tilt, same numbers — because the trainer
// runs the WebGL three build and the explorer runs `three/webgpu`, and one
// module cannot import both (see src/agents/packBase.js for why).
//
// **If you change the blend, change it in both.** The parts that are only
// numbers (the direction rings, the idle threshold, the aim weights) are worth
// keeping identical on sight; the parts that differ do so deliberately:
//
//   · Materials are MeshStandardMaterial, not the explorer's node materials.
//     There is no probe grid in a trainer arena and no baked ambient to sample,
//     so a body is lit by the scene's own hemisphere + sun. The vmat rails
//     survive the translation, though — see `buildMaterial`, and the comments
//     in playerModels.js for what each one is protecting against.
//   · No ragdoll and no xray. The trainer fades a dead target out on its own
//     clock (components/Target.js); a physics corpse would outlive it.
//
// Units. The pack's joints are in SOURCE units and the model faces Source +x
// at yaw 0. The trainer counts metres and its bots face +z at yaw 0, so
// `AgentBody.group` carries the scale and `frame` carries the quarter turn —
// callers only ever see metres.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js?three-webgl';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { WALK_SPEED_SCALE } from '../../shared/sim3d/constants.js';
import { DEFAULT_WEAPON_SPEED } from '../../shared/sim/constants.js';
import { packBase, packLoader, readManifest, packVersionQuery, loadGlb } from './packBase.js';
import { buildVertexGroups, applyGroupColors, flattenMaterial, staticLighting } from './agentPaint.js';
import {
  DIRS,
  AIR_DIRS,
  IDLE_SPEED,
  AIR_MOVE_SPEED,
  AIM_BONES,
  AIM_PITCH_LIMIT,
  dirWeights,
  gaitWeights,
  wrap180
} from './agentBlend.js';

export { IDLE_SPEED, dirWeights } from './agentBlend.js';

export const PLAYERS_PACK_VERSION = 1;

/**
 * How agents are shaded in the trainer, and the defaults.
 *
 * `flat` swaps the CS2 textures for four flat colours by body group — the
 * colour theme the trainer has always had for its own bots, on a real model.
 * It is a preference, not a mode: with it off you get the game's own skins,
 * and everything else here (the static light, the hit capsules, the clips) is
 * the same either way.
 *
 * The colour defaults are the trainer's existing enemy colours, so turning the
 * option on lands somewhere familiar rather than somewhere arbitrary.
 */
export const DEFAULT_AGENT_PAINT = Object.freeze({
  flat: false,
  head: '#ffcf4d',
  torso: '#8a8a8a',
  arms: '#8a8a8a',
  legs: '#8a8a8a'
});

const DEG = Math.PI / 180;

/** Roughness floors — see playerModels.js. Skin has no SSS here; cloth is never a mirror. */
const SKIN_ROUGHNESS_MIN = 0.45;
const CLOTH_ROUGHNESS_MIN = 0.35;
/**
 * Ceiling on `g_flAmbientOcclusionMasking` read as three's `aoMapIntensity`.
 * The agents ship 0.99 on the CT's torso materials, and at 1.0 an AO channel
 * of zero renders that torso black. No crease on a character should be able to
 * take more than half its ambient light away.
 */
const AO_MASK_MAX = 0.5;

/** Which anim sets a trainer bot needs: rifle locomotion, and the deaths. */
export const TRAINER_SETS = ['rifle', 'shared'];

/** channelStats results, by texture image, so a shared ORM is read once. */
const STATS = new WeakMap();
const SEEN_MATS = new Set();

/**
 * min / max / mean of a packed texture's R, G and B, 0..1.
 *
 * Every rail in `buildMaterial` exists because a channel came out of VRF
 * holding something other than what its slot means (an occlusion slot filled
 * with the constant zero VRF writes for "no texture here"), and from the
 * client the only way to tell is to look. 32×32 is enough for "is this channel
 * degenerate": a real AO map has structure at any resolution, a constant fill
 * has none at any.
 */
export function channelStats(tex) {
  const img = tex?.image;
  if (!img) return null;
  if (STATS.has(img)) return STATS.get(img);
  let out = null;
  try {
    let d = null;
    if (ArrayBuffer.isView(img.data)) {
      d = img.data;
    } else {
      const N = 32;
      const canvas =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(N, N)
          : Object.assign(document.createElement('canvas'), { width: N, height: N });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, N, N);
      d = ctx.getImageData(0, 0, N, N).data;
    }
    const ch = [0, 1, 2].map(() => ({ min: 255, max: 0, sum: 0 }));
    let n = 0;
    for (let i = 0; i + 3 < d.length; i += 4) {
      n++;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c];
        if (v < ch[c].min) ch[c].min = v;
        if (v > ch[c].max) ch[c].max = v;
        ch[c].sum += v;
      }
    }
    if (!n) throw new Error('empty');
    const norm = (o) => ({ min: o.min / 255, max: o.max / 255, mean: o.sum / n / 255 });
    out = { r: norm(ch[0]), g: norm(ch[1]), b: norm(ch[2]) };
  } catch {
    out = null; // a texture nothing here can read; the rails keep their defaults
  }
  STATS.set(img, out);
  return out;
}

// ---------------------------------------------------------------------------

/**
 * The players pack: the agent models and the clip sets, loaded once per page
 * and cloned per body.
 */
export class AgentModels {
  /**
   * @param {object} [o]
   * @param {string} [o.base]   pack URL prefix; default `${packBase()}/players`
   * @param {string[]} [o.sides] which agents to fetch ('CT', 'T')
   * @param {string[]} [o.sets]  which clip sets to fetch
   */
  constructor({ base, sides = ['CT'], sets = TRAINER_SETS } = {}) {
    this.base = base || `${packBase()}/players`;
    this.sides = sides;
    this.sets = sets;
    this.manifest = null;
    this.ready = false;
    this.failed = null;
    /** See DEFAULT_AGENT_PAINT. Read by every body, live. */
    this.paint = { ...DEFAULT_AGENT_PAINT };
    /** side → { scene, hitboxes, bones, name } */
    this.models = {};
    /** set → Map<clip name, AnimationClip> */
    this.clips = {};
    /** set → { run, walk, crouch } authored u/s */
    this.gait = {};
    this._loading = null;
  }

  /** Fetch the manifest, the models and the clip sets. Resolves to `ready`. */
  load() {
    if (this._loading) return this._loading;
    this._loading = this._load().then(
      () => (this.ready = true),
      (e) => {
        this.failed = e;
        console.warn('aim4: agent models unavailable, keeping the built-in bot —', e.message || e);
        return false;
      }
    );
    return this._loading;
  }

  async _load() {
    const { manifest, base } = await readManifest('players', PLAYERS_PACK_VERSION, this.base.replace(/\/players$/, ''));
    this.manifest = manifest;
    this.base = base;
    const v = packVersionQuery(manifest);
    const loader = packLoader();
    const load = (file) => loadGlb(loader, `${base}/${file}${v}`);

    const modelJobs = this.sides
      .filter((side) => manifest.models[side])
      .map(async (side) => {
        const m = manifest.models[side];
        const gltf = await load(m.file);
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          // Bounds are the bind pose; a running body leaves them every stride.
          o.frustumCulled = false;
        });
        this.models[side] = { scene: gltf.scene, hitboxes: m.hitboxes, bones: m.bones, name: m.name };
      });
    // Only the locomotion set is required. `shared` carries the deaths, and a
    // bot that cannot fall over is still a bot worth having — where an
    // all-or-nothing load means one dropped connection on a rate-limited CDN
    // costs the whole feature and falls silently back to the built-in model.
    const REQUIRED = new Set(['rifle']);
    const clipJobs = this.sets
      .filter((set) => manifest.anims[set])
      .map(async (set) => {
        const a = manifest.anims[set];
        let gltf;
        try {
          gltf = await load(a.file);
        } catch (e) {
          if (REQUIRED.has(set)) throw e;
          console.warn(`aim4: agent clip set "${set}" did not load; bots keep everything else —`, e.message || e);
          return;
        }
        const map = new Map();
        for (const clip of gltf.animations) map.set(clip.name, clip);
        this.clips[set] = map;
        this.gait[set] = a.gaitSpeed || {};
      });
    await Promise.all([...modelJobs, ...clipJobs]);
    if (!Object.keys(this.models).length) throw new Error('players pack has none of the requested agents');
    if (!this.clips.rifle) throw new Error('players pack has no rifle locomotion set');

    // The clip skeleton carries helper bones the agents do not have
    // (wpnHand_L/R, attachWorld …). A track aimed at a bone that is not there
    // is one PropertyBinding warning per track per action — thousands, with a
    // dozen bots — so drop them once, here.
    const bones = new Set();
    for (const m of Object.values(this.models)) m.scene.traverse((o) => bones.add(o.name));
    let dropped = 0;
    for (const map of Object.values(this.clips)) {
      for (const clip of map.values()) {
        const kept = clip.tracks.filter((t) => bones.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        dropped += clip.tracks.length - kept.length;
        clip.tracks = kept;
      }
    }
    if (dropped) console.log(`aim4: agent clips — ${dropped} tracks on helper bones the models lack were dropped`);
  }

  /**
   * One body's material, from the loader's PBR maps plus the vmat flags the
   * pack carries in `extras.cs3d`.
   *
   * Per body rather than shared because the trainer fades a dying target out
   * by writing `material.opacity`, and that has to be this body's own.
   *
   * The rails are src/cs3d/playerModels.js's, minus the ones that only mean
   * something to a node material (the sheen lobe, the sun's mirror lobe).
   * Each is guarding a channel VRF filled with something other than what the
   * slot means; the comments there say which.
   */
  buildMaterial(src, { flat = false } = {}) {
    const cs3d = src.userData?.cs3d || {};
    const m = new THREE.MeshStandardMaterial();
    m.name = src.name;
    m.color.copy(src.color);
    m.map = src.map || null;
    m.normalMap = src.normalMap || null;
    if (src.normalScale) m.normalScale.copy(src.normalScale);
    m.roughnessMap = src.roughnessMap || null;
    m.aoMap = src.aoMap || null;
    m.roughness = src.roughness;
    m.metalness = src.metalness;
    m.metalnessMap = src.metalnessMap || null;

    // AO: an all-zero occlusion channel is VRF's constant stand-in for "no
    // texture", not "fully occluded". Read at face value it renders the CT's
    // torso black.
    const orm = m.aoMap || m.roughnessMap;
    const stats = orm ? channelStats(orm) : null;
    const aoEmpty = !!stats && stats.r.max <= 2 / 255;
    if (aoEmpty) m.aoMap = null;
    m.aoMapIntensity = Math.max(0, Math.min(AO_MASK_MAX, Number.isFinite(cs3d.aoMasking) ? cs3d.aoMasking : 1));

    // Cloth and skin are dielectrics: `csgo_character.vfx` has no metal path
    // for either, and metalness kills the diffuse term outright.
    if (cs3d.cloth || cs3d.sss) {
      m.metalness = 0;
      m.metalnessMap = null;
    }
    // Roughness floors. Both stop a surface reading as wet, and the cloth one
    // is also what keeps a texture that lost its roughness channel from
    // rendering as chrome.
    const floor = cs3d.sss ? SKIN_ROUGHNESS_MIN : cs3d.cloth ? CLOTH_ROUGHNESS_MIN : 0;
    if (floor > 0) m.roughness = Math.max(m.roughness, floor);
    if (floor > 0 && m.roughnessMap && stats && stats.g.max < floor) m.roughnessMap = null;

    m.side = THREE.FrontSide;
    // The arenas have no lightmap and a target must not get harder to see for
    // facing away from a light, so the body is lit in its own frame. Always,
    // textured or flat — see agentPaint.js.
    staticLighting(m);
    if (flat) flattenMaterial(m, { vertexColors: true });
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.aoMap]) if (t) t.anisotropy = 4;

    if (!SEEN_MATS.has(m.name)) {
      SEEN_MATS.add(m.name);
      const band = (c) => (c ? `${Math.round(c.min * 100)}-${Math.round(c.max * 100)}` : 'n/a');
      console.log(
        `aim4: agent material ${m.name || '(unnamed)'} — cloth=${!!cs3d.cloth} sss=${!!cs3d.sss}` +
          ` ao=${cs3d.aoMasking ?? 1}→${m.aoMapIntensity}${aoEmpty ? ' (channel empty, AO dropped)' : ''}` +
          ` metal=${m.metalness} | ORM% AO ${band(stats?.r)} rough ${band(stats?.g)} metal ${band(stats?.b)}`
      );
    }
    return m;
  }

  /** A new body for a side ('T' | 'CT'). Only valid once `ready`. */
  createBody(side) {
    return new AgentBody(this, side);
  }
}

/**
 * One loader per page. Every bot in every scenario draws the same agent, and
 * the pack is a few MB: fetch it once and clone from it.
 */
let shared = null;
export function sharedAgentModels() {
  if (!shared) shared = new AgentModels();
  return shared;
}

/**
 * Every body that exists right now.
 *
 * The paint is a live setting — a colour picker is dragged, not submitted —
 * and bots are made and reaped by whatever scenario is running, so there is no
 * one place that holds them all. This is that place.
 */
export const liveAgentBodies = new Set();

/**
 * Repaint every agent in the app.
 *
 * Only rebuilds materials when the flat/textured switch itself moves; a colour
 * change is a buffer rewrite on shared geometry, which is one pass for every
 * bot on the map at once.
 */
export function setAgentPaint(paint = {}) {
  const models = sharedAgentModels();
  const wasFlat = models.paint.flat === true;
  Object.assign(models.paint, paint);
  const rebuild = (models.paint.flat === true) !== wasFlat;
  for (const body of liveAgentBodies) {
    if (body.models !== models) continue;
    body.applyPaint({ rebuild });
  }
  return models.paint;
}
/** Test seam: install a stub loader (and clear it with no argument). */
export function setSharedAgentModels(models) {
  shared = models || null;
}

// ---------------------------------------------------------------------------

const _yAxis = new THREE.Vector3(0, 1, 0);
const _qDelta = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();

/**
 * One animated body, in metres.
 *
 * `group` is what goes in the scene: it carries the Source→metre scale and the
 * quarter turn that puts the model's forward on the trainer's +z. Drive it
 * with `set(state)` (Source degrees, Source u/s) and `update(dt)`.
 */
export class AgentBody {
  constructor(models, side) {
    this.models = models;
    this.side = null;
    this.group = new THREE.Group();
    this.group.name = 'agentBody';
    liveAgentBodies.add(this);
    this.group.scale.setScalar(UNIT_M);
    /**
     * The packed model faces Source +x at yaw 0 and the trainer's bots face
     * +z, so everything under here is a quarter turn round from the caller's
     * frame. Ry(−90°) maps +x → +z.
     */
    this.frame = new THREE.Group();
    this.frame.rotation.y = -Math.PI / 2;
    this.group.add(this.frame);

    this.model = null;
    this.mixer = null;
    /** Set by whoever owns this body, to repaint what it hung on the bones. */
    this.onPaint = null;
    this._opacity = 1;
    this._srcMaterials = new Map();
    this.actions = new Map();
    this.aimBones = [];
    this.meshes = [];
    this.materials = [];
    this.oneShot = null;
    this._deadHold = null;
    this._wasAlive = true;

    /** Blend inputs, smoothed. */
    this.speed = 0;
    this.relYaw = 0;
    this.air = 0;
    this.duck = 0;
    this.pitch = 0;
    this.phase = 0;
    this.locoSet = 'rifle';
    this.runSpeed = DEFAULT_WEAPON_SPEED;
    this._tilted = false;
    this.state = {
      speed: 0,
      moveYaw: 0,
      viewYaw: 0,
      pitch: 0,
      duck: 0,
      airborne: false,
      alive: true
    };
    this.setSide(side);
  }

  get ready() {
    return !!this.model;
  }

  setSide(side) {
    if (side === this.side) return;
    const tmpl = this.models.models[side];
    if (!tmpl) return;
    if (this.model) this._teardown();
    this.side = side;
    this.model = cloneSkinned(tmpl.scene);
    // SkeletonUtils.clone shares materials with the template; this body needs
    // its own so the death fade can write opacity on it, and so the flat
    // colours are this body's rather than every body's.
    this.meshes = [];
    /** mesh → the TEMPLATE material it was cloned from; the paint rebuilds from these. */
    this._srcMaterials = new Map();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      this._srcMaterials.set(o, o.material);
      o.castShadow = true;
      o.receiveShadow = true;
      this.meshes.push(o);
    });
    this._buildMaterials();
    this.frame.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions.clear();
    this.oneShot = null;
    this._deadHold = null;
    // The packed model root (rotated −90° about x): under it everything is in
    // Source's frame, which is where the aim tilt is expressed.
    const rootMotion = this.model.getObjectByName('root_motion');
    this.frameNode = rootMotion ? rootMotion.parent : this.model;
    this.aimBones = [];
    for (const [name, w] of AIM_BONES) {
      const b = this.model.getObjectByName(name);
      if (b) this.aimBones.push({ bone: b, w, base: b.quaternion.clone() });
    }
    this._tilted = false;
    this.hitboxes = tmpl.hitboxes;
    /**
     * Every node by name, and by lower-cased name.
     *
     * The hitbox table names its bones in lower case (`leg_upper_l`) and the
     * skeleton does not (`leg_upper_L`) — VRF writes the two out of different
     * blocks. Matching case-sensitively finds the seven bones whose names have
     * no side suffix and misses all twelve that do, which is a bot you can
     * shoot in the chest and not in the arms or the legs.
     */
    this.bonesByName = new Map();
    this.model.traverse((o) => {
      if (!o.name) return;
      this.bonesByName.set(o.name, o);
      const lower = o.name.toLowerCase();
      if (!this.bonesByName.has(lower)) this.bonesByName.set(lower, o);
    });
  }

  /**
   * Build this body's materials from the templates', in the current paint.
   *
   * One material per distinct template material, not per mesh: the agent ships
   * five across six meshes and they are shared exactly as the pack shares
   * them, so a flat-colour rebuild is five objects rather than six.
   */
  _buildMaterials() {
    const flat = this.models.paint?.flat === true;
    for (const m of this.materials) m.dispose();
    const mine = new Map();
    for (const mesh of this.meshes) {
      const src = this._srcMaterials.get(mesh);
      if (!src) continue;
      let m = mine.get(src);
      if (!m) mine.set(src, (m = this.models.buildMaterial(src, { flat })));
      mesh.material = m;
      if (flat) buildVertexGroups(mesh);
    }
    this.materials = [...mine.values()];
    if (flat) this._paintGroups();
    if (this._opacity < 1) this.setOpacity(this._opacity);
  }

  /**
   * Push the four group colours into the geometry.
   *
   * The geometry belongs to the TEMPLATE — SkeletonUtils.clone shares it — so
   * this writes once for every body of this side at the same time, which is
   * what makes dragging a colour picker cheap.
   */
  _paintGroups() {
    const p = this.models.paint || DEFAULT_AGENT_PAINT;
    const done = new Set();
    for (const mesh of this.meshes) {
      if (done.has(mesh.geometry)) continue;
      done.add(mesh.geometry);
      applyGroupColors(mesh.geometry, p);
    }
  }

  /**
   * Re-read `models.paint`. A colour change is one buffer rewrite; the
   * flat/textured switch itself needs the materials rebuilt.
   */
  applyPaint({ rebuild = true } = {}) {
    if (rebuild) this._buildMaterials();
    else if (this.models.paint?.flat) this._paintGroups();
    // Whatever else this body is carrying — the bot's rifle hangs off a bone
    // and is not one of `meshes`, so its owner repaints it.
    this.onPaint?.(this);
  }

  /** A node of this body by name, case-insensitively (see `bonesByName`). */
  boneNamed(name) {
    if (!name) return null;
    return this.bonesByName.get(name) || this.bonesByName.get(String(name).toLowerCase()) || null;
  }

  /** Per-frame inputs. Angles in Source degrees; speed u/s; duck 0..1. */
  set(state) {
    Object.assign(this.state, state);
  }

  /** Fade the whole body (the dying target's cross-fade). */
  setOpacity(v) {
    const o = Math.max(0, Math.min(1, v));
    this._opacity = o;
    for (const m of this.materials) {
      m.transparent = o < 1;
      m.opacity = o;
      m.depthWrite = o >= 1;
    }
  }

  _action(set, name, loop = true) {
    const key = `${set}/${name}`;
    let a = this.actions.get(key);
    if (a) return a;
    const clip = this.models.clips[set]?.get(name);
    if (!clip) return null;
    a = this.mixer.clipAction(clip);
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.enabled = true;
    a.weight = 0;
    // Loops are read at the shared phase, not free-run.
    a.timeScale = loop ? 0 : 1;
    a.play();
    this.actions.set(key, a);
    return a;
  }

  /** First packed death clip, preferring a forward fall. */
  deathClipName() {
    const map = this.models.clips?.shared;
    if (!map) return null;
    if (map.has('death_front')) return 'death_front';
    for (const name of map.keys()) if (String(name).startsWith('death_')) return name;
    return null;
  }

  /** How long the packed death animation runs, seconds (0 when there is none). */
  deathDuration() {
    const name = this.deathClipName();
    const clip = name ? this.models.clips.shared.get(name) : null;
    return clip ? clip.duration : 0;
  }

  _playDeath() {
    this.oneShot = null;
    for (const a of this.actions.values()) if (a.timeScale === 0) a.weight = 0;
    const name = this.deathClipName();
    if (!name || !this.mixer) return;
    const a = this._action('shared', name, false);
    if (!a) return;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.weight = 1;
    a.enabled = true;
    a.paused = false;
    a.play();
    this._deadHold = a;
  }

  _stopDeath() {
    if (!this._deadHold) return;
    this._deadHold.stop();
    this._deadHold.weight = 0;
    this._deadHold = null;
  }

  /** Advance the blend and the mixer. */
  update(dt) {
    if (!this.model) return;
    const s = this.state;
    this.group.rotation.y = 0; // the caller owns the body's heading, not this
    const alive = s.alive !== false;
    if (!alive) {
      if (this._wasAlive) this._playDeath();
      this._wasAlive = false;
      this._unaim();
      if (this._deadHold) {
        const dur = this._deadHold.getClip().duration;
        this._deadHold.paused = this._deadHold.time >= dur - 1e-3;
      }
      this.mixer.update(Math.max(0, dt));
      return;
    }
    if (!this._wasAlive) this._stopDeath();
    this._wasAlive = true;

    // Smooth the blend inputs. On |dt|, so a step never walks a smoother away
    // from its target.
    const ease = (tau) => 1 - Math.exp(-Math.abs(dt) / tau);
    const k = ease(0.08);
    this.speed += (s.speed - this.speed) * k;
    const rel = s.speed > IDLE_SPEED ? wrap180(s.moveYaw - s.viewYaw) : this.relYaw;
    this.relYaw += wrap180(rel - this.relYaw) * k;
    this.relYaw = wrap180(this.relYaw);
    this.air += ((s.airborne ? 1 : 0) - this.air) * ease(0.06);
    this.duck += (Math.max(0, Math.min(1, s.duck)) - this.duck) * ease(0.05);
    this.pitch += (s.pitch - this.pitch) * ease(0.04);

    const set = this.models.clips[this.locoSet] ? this.locoSet : 'rifle';

    // Order matters. `_unaim` runs before BOTH of the next two lines: before
    // `_blend`, because it creates actions lazily and a new binding snapshots
    // the bone it finds as the pose to blend back toward; and before
    // `mixer.update`, because that is what may or may not overwrite the bone.
    this._unaim();
    this._blend(set, dt);
    this.mixer.update(dt);
    this._aim();
  }

  /**
   * Locomotion weights and the shared phase. Only one set is ever live in the
   * trainer (bots carry a rifle for the whole run), so there is no cross-fade
   * between sets here — that is the one thing this blend drops.
   */
  _blend(set, dt) {
    let locoScale = 1;
    if (this.oneShot) {
      const a = this.oneShot.action;
      const clip = a.getClip();
      if (a.time >= clip.duration - 1e-3 || !a.isRunning()) {
        a.fadeOut(this.oneShot.fade);
        this.oneShot = null;
      } else locoScale = 1 - a.getEffectiveWeight();
    }
    for (const a of this.actions.values()) if (a.timeScale === 0) a.weight = 0;
    this._blendSet(set, locoScale, dt);
  }

  _blendSet(set, scale, dt) {
    const gait = this.models.gait[set] || {};
    const speed = this.speed;
    const duck = this.duck;
    const air = this.air;
    const { idle: wIdle, walk: wWalk, run: wRun, crouchMove: wCrouchMove } = gaitWeights(
      speed,
      this.runSpeed,
      WALK_SPEED_SCALE
    );

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
    add('idle', ground * (1 - duck) * wIdle);
    for (const [d, w] of dir) {
      add(`walk_${d}`, ground * (1 - duck) * wWalk * w);
      add(`run_${d}`, ground * (1 - duck) * wRun * w);
    }
    add('idle_crouch', ground * duck * (1 - wCrouchMove));
    for (const [d, w] of dir) add(`crouch_${d}`, ground * duck * wCrouchMove * w);
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
   * Put the spine back the way the mixer left it, undoing the last frame's
   * tilt.
   *
   * `PropertyMixer.apply` ends with a compare: if this frame's blended value is
   * bit-identical to the last one's it never writes the bone, and the bone is
   * still holding OUR quaternion from `_aim`. Applying the tilt again on such a
   * frame compounds it — twice is a lean, five times is a body folded through
   * its own chest. Restoring first makes the whole thing idempotent.
   */
  _unaim() {
    if (!this._tilted) return;
    for (const b of this.aimBones) b.bone.quaternion.copy(b.base);
    this._tilted = false;
  }

  /**
   * View pitch as a spine-to-head tilt on top of the mixer's pose, because
   * every clip is authored looking level. In the model root frame (Source: +x
   * forward, +y left, +z up) a positive Source pitch (looking down) is a
   * positive rotation about +y.
   */
  _aim() {
    if (!this.aimBones.length) return;
    for (const b of this.aimBones) b.base.copy(b.bone.quaternion);
    const total = Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, this.pitch)) * DEG;
    if (Math.abs(total) < 1e-4) return;
    for (const { bone, w } of this.aimBones) {
      _qDelta.setFromAxisAngle(_yAxis, total * w);
      // Parent's orientation in the model root frame, from live local values —
      // the chain stops under the −90° root, so +y is lateral.
      _qParent.identity();
      for (let p = bone.parent; p && p !== this.frameNode && p !== this.model; p = p.parent) _qParent.premultiply(p.quaternion);
      _qTmp.copy(_qParent).invert().multiply(_qDelta).multiply(_qParent);
      bone.quaternion.premultiply(_qTmp);
    }
    this._tilted = true;
  }

  _teardown() {
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    this.model?.removeFromParent();
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.meshes = [];
    this._srcMaterials = new Map();
    this.model = null;
  }

  /**
   * Drop this body. Materials are this body's own and go with it; geometry and
   * textures belong to the template and MUST NOT be disposed — every future
   * bot clones from them.
   */
  dispose() {
    this._teardown();
    this.group.removeFromParent();
    liveAgentBodies.delete(this);
  }
}
