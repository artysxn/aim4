// ---------------------------------------------------------------------------
// src/cs3d/nadeEffects.js
// What a grenade leaves behind, drawn.
//
// The BEHAVIOUR is in shared/sim3d — the smoke's flood fill
// (shared/sim3d/smokeVolume.js), the fire's outward walk
// (shared/sim3d/fireSpread.js), and the flashbang
// (shared/sim3d/flash.js), all headless and all testable. This file is
// the body around them: it turns cells and seats into something on screen, and
// owns the look.
//
// The look is not invented here either. Every sheet, colour, ramp and blend
// constant below was read out of the game's own particle systems on 2026-08-18
// with tools/vrf/Source2Viewer-CLI.exe, and the ones that are still guesses say
// so.
//
//   SMOKE   NOT A SPRITE. `explosion_smokegrenade_voxel` emits sprite cards,
//           but what CS2 actually puts on screen is a raymarched volume, and
//           the difference is not subtle: a cloud made of hundreds of blended
//           quads has to be depth-sorted every frame, and every time two of
//           them swap order the pixel they share changes colour. Over a whole
//           cloud that is a strobe. src/cs3d/smokeVolume3d.js is the march,
//           src/cs3d/smokeLpv.js is the light volume that puts the map's
//           shadows across it, and this file drives them.
//
//   FIRE    `molotov_groundfire_main_fancy.vpcf`. The sheet is a flame sim and
//           its luminance goes through a 1D lookup, mixed half and half with
//           the sheet's own colour. The BODY ramp is black → dark red → orange
//           → cream → white and covers almost the whole sheet; the separate
//           EDGE ramp (`*_groundfire_outline`) runs through violet for a
//           molotov and cyan for an incendiary and belongs on the rim, which is
//           the only thing that tells the two apart. Self-illum 1, diffuse 0,
//           drawn twice — once normally and once additive — and the additive
//           pass is written far above white so the effects bloom in look.js
//           picks it up. Fire that does not glow does not read as fire.
//
//   HE      `explosion_hegrenade_*.vpcf`, and the TIMING is the point. The fire
//           is not a fireball that swells and drifts: it is there on the frame
//           the grenade goes off, at full size, and it is gone about a tenth of
//           a second later, leaving a flash the bloom smears and a puff of
//           almost-black smoke that starts thinning the instant it appears.
//           Drawn as anything that grows, it reads as a small molotov.
//
// Everything except the smoke is instanced: one draw per layer, whatever the
// particle count.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { mix, positionGeometry, uniform, vec3, vec4 } from 'three/webgpu';
import { sourceToScene, sceneToSource } from '../../shared/sim3d/units.js';
import { createHullWorld } from './hullWorld.js';
import { createRayWorld } from './rayWorld.js';
import {
  radiusFlashForPlayer,
  applyBlind,
  flashOverlayAlpha
} from '../../shared/sim3d/flash.js';
import { SpriteCardBatch, loadFxPack } from './spriteCard.js';
import { SmokeCards, warmSmokeCards } from './smokeCards.js';
import {
  buildSmokeVolume,
  stepSmokeVolume,
  pushSmoke,
  smokeBlocks,
  SMOKE_RADIUS,
  SMOKE_SECONDS,
  SMOKE_CELL,
  SMOKE_KNIT,
  SMOKE_HOLD,
  SMOKE_PUSH_RADIUS
} from '../../shared/sim3d/smokeVolume.js';
import {
  buildFireSpread,
  FIRE_SECONDS,
  FIRE_SECONDS_INC,
  FIRE_RANGE,
  FLAME_SPACING
} from '../../shared/sim3d/fireSpread.js';

export { FLASH_MAX_SECONDS, SV_FLASHBANG_STRENGTH, FLASH_RADIUS } from '../../shared/sim3d/flash.js';
export { SMOKE_RADIUS, SMOKE_SECONDS };
/** Kept for callers that used the old name. */
export const FIRE_RADIUS = FIRE_RANGE;
export { FIRE_SECONDS };

// Imported AND re-exported: the numbers are shared with the aim trainer
// (shared/sim3d/nadeStats.js) and are also read a few hundred lines below, and
// a bare `export ... from` re-exports without binding a local name.
import { HE_RADIUS, HE_DAMAGE, DECOY_SECONDS } from '../../shared/sim3d/nadeStats.js';

export { HE_RADIUS, HE_DAMAGE, DECOY_SECONDS };

/**
 * The three beats of an HE, seconds, and they are all short.
 *
 * `[guessed]`, from frame-stepping the game. What matters is the SHAPE: the
 * fire and the flash are one event that is over before you have registered it,
 * and the smoke is already fading when it arrives. Nothing here eases in.
 */
const HE_FLAME = 0.165;
const HE_FLASH = 0.07;
const HE_SMOKE = 1.5;
/**
 * How long an HE's smoke hangs about, which is the whole effect's life: the
 * fire and the flash are over in a tenth of a second and this is what is left.
 * Exported because a demo has to decide whether to create the effect at all
 * before it has one to read `fx.life` off (src/cs3d/demoNades.js).
 */
export const HE_SECONDS = HE_SMOKE;
/** Ring-wave travel uses the original 0.11s beat so a longer flame does not fly further. */
const HE_FLAME_THROW = 0.11;


/**
 * How long a blast keeps pushing a smoke around, seconds.
 *
 * CS2 holds five and drops them after seven, which is longer than the hole
 * takes to knit (`HE_SHADOW_AGE_RAMP` tops out at five) so the last of the
 * recovery is not cut off mid-close. +1s vs that reading so the drawn hole
 * outlives the extra second of refill.
 */
const HE_MEMORY = 10;

/**
 * How many blasts a smoke tracks at once. CS2's `uHE` is five.
 *
 * Lived in smokeVolume3d.js until the march was deleted, and the deletion took
 * it with it — `_he()` kept reading the name and threw on the first grenade.
 * It belongs here: it is a property of how many blasts the EFFECT remembers,
 * not of whatever draws the result.
 */
const HE_SLOTS = 5;

/**
 * How far a blast drags smoke in, units, and over how long it lets go.
 *
 * The displacement CS2 applies and the reason an HE reads as punching a hole
 * rather than deleting one: the cloud visibly rushes towards the blast and
 * then breathes back out. The old march did it per sample in the shader; a
 * card cloud does it by moving the cards, which is the same motion and a good
 * deal cheaper.
 */
const HE_PULL_RADIUS = 340;
const HE_PULL_SECONDS = 6;
const HE_PULL_MAX = 0.55;

/**
 * Per-side tint, `uColor` in the march.
 *
 * These are the game's: `E2` and `T2` in the demo viewer's smoke path, 200/172/145
 * for a T and 172/184/194 for a CT. They look far too strong written down and
 * are not, because the march applies them through `smokeTint`, which divides
 * the tinted colour's luma back out — the tint only ever moves hue — and
 * `uTintMix` fades it from 0.5 to 0 over the cloud's first eighteen seconds.
 */
export const SMOKE_TINT = Object.freeze({
  T: 0xc8ac91,
  CT: 0xacb8c2,
  none: 0xffffff
});

/**
 * `C_OP_RenderSprites` settings, per effect, straight off the particle systems.
 * Anything not named here is the sprite card's own default.
 *
 * The overbrights on the additive passes are OURS, and they are large on
 * purpose: the scene renders unmapped into an HDR target and look.js blooms
 * everything past 3, so an effect that is meant to glow has to be written well
 * past white. CS2 gets the same result with `m_bOnlyRenderInEffectsBloomPass`
 * and a compositor we do not have.
 */
const LOOK = Object.freeze({
  // molotov_groundfire_main_fancy.vpcf, first renderer
  fire: { color: [255, 255, 255], alphaScale: 2, selfIllum: 1, diffuse: 0, feather: 12, overbright: 2.4 },
  // molotov_groundfire_outline.vpcf, the additive second pass — the glow
  fireGlow: { color: [255, 255, 255], alphaScale: 1.1, selfIllum: 1, diffuse: 0, feather: 3, overbright: 4.5, additive: true, bloomOnly: true },
  // explosion_hegrenade_b.vpcf: `_g` carries colour scale 0,0,0, so the blast
  // smoke is nearly black and lit rather than emissive.
  heSmoke: { color: [54, 54, 57], alphaScale: 0.7, selfIllum: 0.12, diffuse: 0.9, feather: 20, overbright: 1, alphaOnly: true },
  heFire: { color: [255, 255, 255], alphaScale: 1.4, selfIllum: 1, diffuse: 0, feather: 8, overbright: 16, additive: true, bloomOnly: true }
});

/**
 * The cloud's life, as CS2's own curves over its age in seconds.
 *
 * All four are the same shape — a smoothstep between two ages — and the numbers
 * are the shipped `sD`/`iD` pairs out of the demo viewer's smoke path. `birth`
 * and `death` are the pair the march multiplies together for `uAlphaBirthDeath`;
 * `dissolve` is the ball opening out of the middle at the start; `alpha` is the
 * long slow thinning that ends the cloud.
 */
const RAMP = [
  [22, -5], // 0: death. Runs BACKWARDS — 1 until 17s, 0 by 22.
  [0.1, 1.4], // 1: unused by this path, kept so the indices match the game's
  [4, 14], // 2: the greying
  [0.1, 1.9] // 3: birth
];
const smoothstep01 = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const ramp = (n, t) => smoothstep01((t - RAMP[n][0]) / RAMP[n][1]);

/** [docs] Seconds the volume takes to unfold from the canister. */
const SMOKE_GROW = 1;
/** [docs] Seconds of linear thinning at the very end (96 ticks). */
const SMOKE_FADE_OUT = 96 / 64;

function smokeCurves(age, life) {
  const left = life - age;
  const fadeOut = left < SMOKE_FADE_OUT ? Math.max(0, left / SMOKE_FADE_OUT) : 1;
  const g = Math.min(1, age / SMOKE_GROW);
  return {
    // 1 - (1-t)^2.8: fast at first and then easing, so the cloud rushes out of
    // the canister and settles rather than inflating evenly.
    grow: 1 - Math.pow(1 - g, 2.8),
    dissolve: ramp(3, age),
    alphaFade: Math.min(ramp(0, age), fadeOut),
    birthDeath: Math.min(1, Math.max(0, ramp(3, age) * ramp(0, age) * 8)),
    tintMix: 0.5 * (1 - ramp(2, age))
  };
}

/** [guessed] How fast each sheet's flipbook runs, frames a second. */
const SMOKE_FPS = 7;
const FIRE_FPS = 24;
const HE_FPS = 30;

/**
 * [guessed] Sprite cards per flame. `buildFireSpread` puts down at most 16
 * seats for a molotov, which is the right number of *places that burn* and far
 * too few *things to draw*: CS2 runs 400 particles over the same footprint.
 */
const CARDS_PER_FLAME = 6;

/**
 * [guessed] How much shorter the edge of a fire is than its middle. A molotov
 * stands tall where the bottle broke and runs low where the fuel spread; at 0
 * the patch is a flat-topped wall, which is the giveaway.
 */
const FIRE_EDGE_DROP = 0.5;

/** How many smoke puffs and fireball cards an HE gets. */
const HE_PUFFS = 34;
const HE_BALLS = 30;

/**
 * [docs] The ring wave the fire leaves on, units a second.
 * `C_INIT_RingWave` in explosion_hegrenade_e (1200-3500) and _h (500-2500);
 * this spans both because we draw them as one layer.
 */
const HE_RING_SPEED = [900, 3400];

const _c = new THREE.Color();
const _tint = new THREE.Color();
/** Reused by `_smokeWorld().solidAt`: the fill asks it thousands of times a throw. */
const _solidAt = { x: 0, y: 0, z: 0 };
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _viewBox = new THREE.Box3();

/** Deterministic jitter, so a replayed throw looks identical. */
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export class NadeEffects {
  /**
   * @param {object} o
   * @param {() => object|null} o.getCollider  the map's collision, for the
   *   smoke's flood fill and its sun traces, the fire's ground probe and the
   *   flash's sight line
   * @param {() => object|null} [o.getMovers]  swinging doors, for flash LOS
   * @param {() => string} [o.getSide]  'T' | 'CT', for the smoke tint
   * @param {THREE.Camera} [o.camera]  the sprite layers sort against it
   */
  constructor({ getCollider, getMovers, getSide, camera = null } = {}) {
    this.getCollider = getCollider || (() => null);
    this.getMovers = getMovers || (() => null);
    this.getSide = getSide || (() => 'T');
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'nade-effects';
    this.smokeRoot = new THREE.Group();
    this.smokeRoot.name = 'nade-smoke';
    // Under the effects root, i.e. in the SCENE — not a scene of its own, the
    // way the raymarched volume needed. Being in the scene pass is what gets
    // the cards depth-tested against the map and graded with it.
    this.root.add(this.smokeRoot);
    this.live = [];
    this._world = null;
    this._collider = null;
    this._flashWorld = null;
    this._flashCollider = null;
    this._flashMovers = null;
    /** 0..1, how blinded the camera is right now. main.js draws the overlay. */
    this.flash = 0;
    /** 0..1, leak Deafen DSP amount. No audio duck is wired yet. */
    this.deafen = 0;
    this._flashState = null;
    this._deafenUntil = 0;
    this._deafenAmount = 0;
    /** The sheets. Null until `loadFx` resolves; effects still simulate. */
    this.fx = null;
    this._light = null;
    /** Live blasts, scene frame, for the smoke march's displacement. */
    this._hes = [];
    /** @type {() => object|null} */
    this.getProbeGrid = () => null;
    /** Wall clock the shaders animate on. */
    this._time = 0;
    /**
     * Whether the renderer can hand a sprite the scene's depth. Off: three
     * r169's `viewportLinearDepth` cannot sample an MSAA depth buffer, and the
     * renderer is built with `antialias: true`. See src/cs3d/spriteCard.js.
     */
    this.depthFeather = false;
    this._geo = { blip: new THREE.SphereGeometry(3, 8, 6) };
  }

  /**
   * Pull the sprite sheets. Effects spawned before this resolves are not lost:
   * the sim runs regardless and the cards are built the first time a live
   * effect is posed with the pack in hand. The smoke needs none of it.
   *
   * @param {string} base  e.g. `${assetBase()}/fx`
   */
  async loadFx(base, version = '') {
    // The smoke needs none of the pack, but it does need its noise volume, and
    // baking that is a couple of hundred milliseconds. Do it here so the cost
    // lands on the map load instead of on the first grenade someone throws.
    warmSmokeCards();
    this.fx = await loadFxPack(base, { version });
    return this.fx;
  }

  /** Turn per-pixel depth feathering on, where the renderer supports it. */
  setDepthFeather(on) {
    this.depthFeather = !!on;
  }

  /**
   * The map's baked ambient cubes. A GETTER, not the grid: the pack streams it
   * in after the map is up, so anything that grabs it once at load time gets
   * null (playerModels.js takes the same shape for the same reason).
   */
  setProbeGrid(get) {
    this.getProbeGrid = typeof get === 'function' ? get : () => get || null;
  }

  /** The map's sun, so smoke and fire shade like part of the scene. */
  setLight(light) {
    this._light = light || null;
    for (const fx of this.live) {
      for (const l of fx.layers || []) l.setLight(light);
      fx.smoke?.setLight(light, light?.ambient);
    }
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  /** True while a raymarched smoke is in the scene. */
  hasSmoke() {
    for (const fx of this.live) {
      if (fx.kind === 'smoke' && fx.smoke?.mesh) return true;
    }
    return false;
  }

  /**
   * ...and true only while one is actually IN FRONT of `camera`.
   *
   * What the smoke pass should ask, because the pass is not free to run for
   * nothing: it redraws the whole map into the wall-clip target (on Nuke, 393
   * draws and 3.7M triangles) and then marches a full-screen quad, and it did
   * both of those every frame for a cloud behind the player's back. Walking
   * away from your own smoke cost as much as standing in it.
   *
   * The boxes are axis-aligned and already known, so this is the standard
   * frustum-vs-AABB test and nothing more; the march's own culling cannot do
   * the job because the cost is incurred before it draws.
   */
  smokeInView(camera) {
    if (!camera) return this.hasSmoke();
    camera.updateMatrixWorld();
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
    for (const fx of this.live) {
      const box = fx.kind === 'smoke' && fx.smoke?.mesh ? fx.smoke.box : null;
      if (!box) continue;
      const h = box.s / 2;
      _viewBox.min.set(box.cx - h, box.cy - h, box.cz - h);
      _viewBox.max.set(box.cx + h, box.cy + h, box.cz + h);
      if (_frustum.intersectsBox(_viewBox)) return true;
    }
    return false;
  }

  /** The grenade collision set, for ground probes, sun traces and sight lines. */
  _tracer() {
    const c = this.getCollider();
    if (c !== this._collider) {
      this._collider = c;
      this._world = c ? createHullWorld(c, 'nade') : null;
    }
    return this._world;
  }

  /**
   * Is there a map to trace against yet?
   *
   * A flash solved with no collision has no occlusion at all — everyone in
   * range is blinded through every wall — so a caller that CACHES its flash
   * solutions (demoNades.js does) has to know not to keep that answer.
   */
  hasCollider() {
    return !!this.getCollider();
  }

  /**
   * Flash LOS: a ray, not a hull, over the light band. Doors come from movers
   * because their static hulls are masked out of the BVH.
   */
  _flashRay() {
    const c = this.getCollider();
    const m = this.getMovers() || null;
    if (c !== this._flashCollider || m !== this._flashMovers) {
      this._flashCollider = c;
      this._flashMovers = m;
      this._flashWorld = c ? createRayWorld(c, m, { flash: true, Ray: THREE.Ray }) : null;
    }
    return this._flashWorld;
  }

  _flashTrace() {
    const world = this._flashRay();
    if (!world) return null;
    return (from, to) => {
      const hit = world.trace(from, to);
      if (!hit) return { fraction: 1, endpos: { x: to.x, y: to.y, z: to.z } };
      const far = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      const fraction = far > 0 ? Math.min(1, hit.distance / far) : 1;
      return { fraction, endpos: hit.point };
    };
  }

  /** The world as shared/sim3d/smokeVolume.js wants it. */
  _smokeWorld() {
    const world = this._tracer();
    if (!world) return null;
    return {
      solidAt: (x, y, z, half) => {
        // `boxSolid` is the startsolid half of a zero-length trace, which is
        // exactly the question — and it stops at the first triangle that
        // answers it instead of ranking every one in the box for a normal
        // nothing here reads.
        _solidAt.x = x;
        _solidAt.y = y;
        _solidAt.z = z - half;
        return world.boxSolid(_solidAt, half * 0.9, half * 1.8);
      }
    };
  }

  /**
   * ...and as shared/sim3d/fireSpread.js wants it: from 48 above the seat's
   * parent, down 160, which is the window CS2's own walk spread searches.
   */
  _fireWorld() {
    const world = this._tracer();
    if (!world) return null;
    return {
      groundAt: (x, y, z) => {
        const t = world.traceHull({ x, y, z: z + 48 }, { x, y, z: z - 112 }, 2, 2);
        if (t.fraction >= 1 || !t.normal || t.normal.z < 0.5) return null;
        return { x: t.endpos.x, y: t.endpos.y, z: t.endpos.z };
      }
    };
  }

  /**
   * Build one instanced layer. Returns null while the pack is still loading,
   * which every caller treats as "draw nothing this frame".
   */
  _layer(sheetKey, mvKey, count, look, ramp = null) {
    const sheet = this.fx?.sheets?.[sheetKey];
    if (!sheet || !count) return null;
    const batch = new SpriteCardBatch({
      sheet,
      mv: mvKey ? this.fx.sheets[mvKey] || null : null,
      ramp,
      count,
      ...look,
      feather: this.depthFeather ? look.feather : 0
    });
    batch.setLight(this._light);
    this.root.add(batch.mesh);
    return batch;
  }

  /** Layers are built lazily, so an effect thrown during the load still draws. */
  _ensureLayers(fx) {
    if (fx.layers || !this.fx) return fx.layers;
    fx.layers = fx.build.call(this, fx) || [];
    return fx.layers;
  }

  /**
   * @param {object} o
   * @param {string} o.type
   * @param {{x,y,z}} o.pos     Source frame
   * @param {{x,y,z}|null} [o.normal]  the surface it went off against
   * @param {{x,y,z}|null} [o.vel]     the velocity it arrived with
   * @param {string} [o.side]          who threw it
   */
  spawn({ type, pos, normal = null, vel = null, side = null, driven = false }) {
    let fx = null;
    if (type === 'smokegrenade') fx = this._smoke(pos, side || this.getSide());
    else if (type === 'molotov' || type === 'incgrenade') fx = this._fire(pos, vel, type);
    else if (type === 'hegrenade') fx = this._he(pos);
    else if (type === 'flashbang') fx = this._flash(pos);
    else if (type === 'decoy') fx = this._decoy(pos);
    if (fx && driven) {
      fx.driven = true;
      if (fx.blast) fx.blast.driven = true;
    }
    return fx;
  }

  /**
   * Put an effect at an exact age, instead of letting the clock carry it there.
   *
   * Everything drawn here is already a pure function of `fx.age` — the fire
   * poses from it, the blast poses from it, and a smoke cell's opacity is
   * `cellOpacity(vol, idx)` over `vol.age`. Nothing integrates. So a caller
   * that knows what time it is can simply say so, and that is what makes demo
   * playback work: the utility in a replayed round is derived from the
   * playhead every frame, so scrubbing backwards costs nothing and lands on
   * exactly the frame it should.
   *
   * Only the smoke has any state that is not a function of age — the holes an
   * HE punched in it, which decay on their own timers — so forward motion is
   * handed to `stepSmokeVolume` as a delta and those decay with it. Going
   * backwards, the caller is expected to have rebuilt the cloud (see
   * demoNades.js): there is no undo for a hole.
   *
   * @param {object} fx  a handle from `spawn`
   * @param {number} age seconds since detonation
   */
  setAge(fx, age) {
    if (!fx) return;
    const prev = fx.age;
    fx.age = age;
    if (fx.kind === 'smoke') {
      const delta = age - prev;
      if (delta > 0) stepSmokeVolume(fx.vol, delta);
      else fx.vol.age = age;
      this._poseSmoke(fx);
    } else if (fx.kind === 'fire') this._poseFire(fx);
    else if (fx.kind === 'he') {
      // The blast's displacement of any smoke it went off inside ages with it.
      if (fx.blast) fx.blast.age = age;
      this._stepHe(fx);
    } else if (fx.kind === 'decoy') this._stepDecoy(fx);
  }

  /** Take one effect out, without waiting for its life to run out. */
  remove(fx) {
    const i = this.live.indexOf(fx);
    if (i < 0) return;
    this.live.splice(i, 1);
    // A driven blast is exempt from the clock's ageing, so nothing else would
    // ever take it out of the displacement list.
    const b = fx.blast ? this._hes.indexOf(fx.blast) : -1;
    if (b >= 0) this._hes.splice(b, 1);
    this._dispose(fx);
  }

  // ---- smoke ---------------------------------------------------------------

  _smoke(pos, side) {
    const vol = buildSmokeVolume({ origin: pos, world: this._smokeWorld() });

    // The box the march runs in: cubic, centred on the fill, big enough to hold
    // it with a cell of slack all round. Cubic because the lighting reads
    // `normalize(uvw - 0.5)` as the direction out of the cloud, and stretching
    // one axis would shade the volume as an ellipsoid.
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const c of vol.cells) {
      const p = sourceToScene(c.x, c.y, c.z);
      for (let i = 0; i < 3; i++) {
        if (p[i] < lo[i]) lo[i] = p[i];
        if (p[i] > hi[i]) hi[i] = p[i];
      }
    }
    const smoke = new SmokeCards();
    smoke.setCells(vol);
    // On the world root, not a scene of its own: these are ordinary
    // transparent meshes now, and being in the scene pass is exactly what
    // gets them depth-tested against the map and run through its grade.
    this.smokeRoot.add(smoke.mesh);
    // The fill's own bounds, for smokeInView.
    smoke.box = {
      cx: (lo[0] + hi[0]) / 2,
      cy: (lo[1] + hi[1]) / 2,
      cz: (lo[2] + hi[2]) / 2,
      s: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + SMOKE_CELL * 2
    };

    const fx = {
      kind: 'smoke',
      vol,
      smoke,
      side,
      age: 0,
      life: SMOKE_SECONDS,
      pos,
      layers: [],
      /** Set once an HE has actually punched the fill, so it re-lays once. */
      holed: false
    };
    this._poseSmoke(fx);
    this.live.push(fx);
    return fx;
  }

  _poseSmoke(fx) {
    const { smoke, vol } = fx;
    if (!smoke) return;

    // The cards only move when an HE is involved. Everything else about the
    // cloud's life is a curve over a static set of them.
    //
    // Two separate things have to be over before this stops: the fill has to
    // have knitted shut (`vol.cleared`) AND the displacement has to have let
    // go. The pull outlasts the hole, so keying off the hole alone would snap
    // the cloud back to its seats mid-breath.
    const pulls = this._smokePulls();
    if (fx.holed || pulls) {
      // Only the knit-back: the per-cell arrival is `grow`'s job and the
      // end-of-life thinning is the alpha curve's, and folding either in here
      // would apply it twice.
      smoke.setCells(
        vol,
        (i) => {
          const cleared = vol.cleared.get(i);
          return cleared === undefined ? 1 : Math.max(0, 1 - Math.min(1, cleared / SMOKE_KNIT));
        },
        pulls,
        this._smokeHoles()
      );
      if (!vol.cleared.size) fx.holed = false;
    }

    const c = smokeCurves(fx.age, fx.life);
    _tint.setHex(SMOKE_TINT[fx.side] ?? SMOKE_TINT.none, THREE.SRGBColorSpace);
    smoke.setFrame({
      grow: c.grow,
      // One curve now, not four: birth × death × the long greying.
      alpha: c.birthDeath * c.alphaFade,
      tint: _tint
    });
  }

  /**
   * An HE went off: blow a hole in every smoke it reaches.
   *
   * TWO things happen and they are not the same thing. The march does the hole
   * you can SEE — `uHE` drags the sample point in towards the blast and then
   * heals it over about six seconds, which is CS2's own displacement and is
   * why the smoke visibly rushes inward and then closes. This call does the
   * hole the GAME can see: it clears the fill, so `smokedAt` stops reporting
   * cover through the gap and a bot cannot hide in a hole that is not there.
   */
  pushSmokes(at, radius = SMOKE_PUSH_RADIUS) {
    let hit = 0;
    for (const fx of this.live) {
      if (fx.kind !== 'smoke') continue;
      if (pushSmoke(fx.vol, at, radius)) {
        fx.holed = true;
        hit++;
      }
    }
    return hit;
  }

  /**
   * The open holes, SCENE units, as spheres the cards must not reach into.
   *
   * Shrinking with the knit: the fill stays fully open for SMOKE_HOLD, then
   * closes from the rim inwards over SMOKE_KNIT. The drawn boundary has to
   * follow that or the cards would snap back across a gap the sim still owns.
   */
  _smokeHoles() {
    let out = null;
    const closeFor = SMOKE_KNIT + HE_PULL_SECONDS;
    for (const he of this._hes) {
      if (he.age >= SMOKE_HOLD + closeFor) continue;
      const knitAge = Math.max(0, he.age - SMOKE_HOLD);
      const shut = Math.max(0, 1 - knitAge / closeFor);
      const p = sourceToScene(he.x, he.y, he.z);
      (out ||= []).push({ x: p[0], y: p[1], z: p[2], r: SMOKE_PUSH_RADIUS * shut });
    }
    return out;
  }

  /**
   * Recent blasts as the cards want them: SCENE units, with their age, and
   * only while they are still displacing anything. `null` once they are done,
   * which is what lets `_poseSmoke` stop re-laying every frame.
   */
  _smokePulls() {
    let out = null;
    for (const he of this._hes) {
      if (he.age >= HE_PULL_SECONDS) continue;
      const p = sourceToScene(he.x, he.y, he.z);
      (out ||= []).push({ x: p[0], y: p[1], z: p[2], age: he.age });
    }
    return out;
  }

  /** Does standing smoke cover this point? For sight lines and bots. */
  smokedAt(x, y, z) {
    for (const fx of this.live) {
      if (fx.kind === 'smoke' && smokeBlocks(fx.vol, x, y, z)) return true;
    }
    return false;
  }

  // ---- fire ----------------------------------------------------------------

  _fire(pos, vel, type) {
    const flames = buildFireSpread({ origin: pos, dir: vel, type, world: this._fireWorld() });
    // Per-card jitter, once. It never changes, and `_poseFire` runs every frame
    // over a hundred-odd cards, so recomputing four sines per card is waste.
    const n = flames.length * CARDS_PER_FLAME;
    const seed = {
      phase: new Float32Array(n),
      rise: new Float32Array(n),
      offset: new Float32Array(n),
      size: new Float32Array(n),
      ox: new Float32Array(n),
      oz: new Float32Array(n),
      frame: new Float32Array(n)
    };
    for (let i = 0; i < n; i++) {
      seed.phase[i] = hash(i) * 6.283;
      seed.rise[i] = 0.55 + hash(i + 5) * 0.5;
      seed.offset[i] = hash(i + 9);
      seed.size[i] = 1.15 + hash(i + 1) * 0.5;
      seed.ox[i] = (hash(i + 2) - 0.5) * FLAME_SPACING * 0.85;
      seed.oz[i] = (hash(i + 3) - 0.5) * FLAME_SPACING * 0.85;
      seed.frame[i] = hash(i + 13) * 32;
    }
    const fx = {
      kind: 'fire',
      flames,
      seed,
      type,
      age: 0,
      life: type === 'incgrenade' ? FIRE_SECONDS_INC : FIRE_SECONDS,
      pos,
      layers: null,
      build: this._buildFire
    };
    this._ensureLayers(fx);
    this._poseFire(fx);
    this.live.push(fx);
    return fx;
  }

  /**
   * The mark a molotov leaves, one patch per seat, in two passes.
   *
   * The old version was a single dark disc over the whole puddle, painted over
   * the floor with ordinary alpha, and it read as exactly what it was: a grey
   * shadow, darkest in the middle, perfectly round, hiding the concrete instead
   * of marking it. Three things are wrong with that and all three are fixed
   * here.
   *
   *   IT MULTIPLIES, IT DOES NOT PAINT.  A burn does not replace the floor, it
   *   darkens it — the aggregate, the paint lines, the grime all still read
   *   through a scorch mark. `MultiplyBlending` against a colour near 0.3
   *   leaves every bit of that visible; a near-black quad over the top leaves
   *   none of it, which is why it looked like a sticker.
   *
   *   ONE PER SEAT.  The fire burns in the sixteen places `buildFireSpread`
   *   put it, not over the circle that contains them, and each patch gets its
   *   own rotation and size off a hash of its index — which is what CS2 does
   *   with `decals_molotovscorch` (`0.8 + hash * 0.4`, random Z rotation).
   *
   *   IT IS NOT DARKER WHILE IT BURNS.  An additive ember pass sits on top of
   *   the scorch and flickers with the flames, so the ground under a live
   *   molotov is LIT. It is written past white on purpose, so look.js's effects
   *   bloom catches the floor as well as the flames.
   *
   * `[guessed]` in one respect: the shape is procedural rather than the game's
   * decal texture, which is in the VPK and not in the pack. Two lobes of
   * different frequency around the rim are enough to stop it reading as a
   * circle, and a decal that needs nothing fetched cannot arrive late.
   */
  _fireGround(fx) {
    const geo = (this._geo.decal ||= new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const burn = uniform(0);
    const heat = uniform(0);

    // Distance from the middle of the quad, 0 in the centre and 1 at the rim.
    // Off the geometry rather than the uv set: the quad is a unit plane laid
    // flat, so its own x/z already run -0.5..0.5 from the middle, and that
    // needs no attribute to exist and no guess about which way the uvs run.
    const r = positionGeometry.xz.length().mul(2).clamp(0, 1);
    const th = positionGeometry.z.atan2(positionGeometry.x);
    const wobble = th.mul(5).sin().mul(0.11).add(th.mul(11).add(2.3).sin().mul(0.06));
    const edge = r.div(wobble.add(1)).clamp(0, 1);
    const mask = edge.oneMinus().pow(1.35);

    // Soot at the centre, a browner scorch towards the rim, and white — a
    // multiply no-op — everywhere outside it.
    const scorchMat = new THREE.NodeMaterial();
    const soot = mix(vec3(0.3, 0.27, 0.25), vec3(0.62, 0.5, 0.42), edge);
    scorchMat.colorNode = vec4(mix(vec3(1), soot, mask.mul(burn)), 1);
    scorchMat.transparent = true;
    scorchMat.blending = THREE.MultiplyBlending;
    scorchMat.depthWrite = false;
    scorchMat.polygonOffset = true;
    scorchMat.polygonOffsetFactor = -4;

    const emberMat = new THREE.NodeMaterial();
    emberMat.colorNode = vec4(vec3(1.6, 0.55, 0.14).mul(heat).mul(mask), 1);
    emberMat.transparent = true;
    emberMat.blending = THREE.AdditiveBlending;
    emberMat.depthWrite = false;
    emberMat.polygonOffset = true;
    emberMat.polygonOffsetFactor = -6;

    const group = new THREE.Group();
    for (let i = 0; i < fx.flames.length; i++) {
      const f = fx.flames[i];
      const [x, y, z] = sourceToScene(f.x, f.y, f.z);
      const s = FLAME_SPACING * 1.9 * (0.8 + hash(i * 7 + 3) * 0.4);
      const spin = hash(i * 7 + 11) * Math.PI * 2;
      // Scorch under ember: the mark is on the floor and the light is on top of
      // it. The other way round paints soot over the light.
      for (const [mat, lift, order] of [
        [scorchMat, 1.5, 7],
        [emberMat, 2.5, 8]
      ]) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y + lift, z);
        m.rotation.y = spin;
        m.scale.set(s, 1, s);
        m.renderOrder = order;
        m.frustumCulled = false;
        group.add(m);
      }
    }
    this.root.add(group);
    fx.ground = { group, mats: [scorchMat, emberMat], burn, heat };
  }

  _buildFire(fx) {
    if (!fx.ground) this._fireGround(fx);
    const n = fx.flames.length * CARDS_PER_FLAME;
    const ramps = this.fx?.ramps?.[fx.type] || this.fx?.ramps?.molotov || null;
    // The body is orange for both types; what tells a molotov from an
    // incendiary in CS2 is the fringe around it, and that is the `edge` ramp —
    // violet for one, cyan for the other. Putting it on the additive glow pass
    // is where it lands in the game too: a rim, not the colour of the flame.
    const body = this._layer('fire', 'fire_mv', n, LOOK.fire, ramps?.body || null);
    const glow = this._layer('fire', 'fire_mv', n, LOOK.fireGlow, ramps?.edge || ramps?.body || null);
    return [body, glow].filter(Boolean);
  }

  _poseFire(fx) {
    const layers = this._ensureLayers(fx);
    const { flames, seed, age } = fx;

    let alight = 0;
    for (let f = 0; f < flames.length; f++) {
      const flame = flames[f];
      const [fxp, fyp, fzp] = sourceToScene(flame.x, flame.y, flame.z);
      // Each seat has its own clock now: it catches at `at` and goes out at
      // `out`, last-lit first, which is `buildFireSpread`'s whole point.
      const lit = Math.min(1, (age - flame.at) / 0.35);
      const dying = Math.min(1, Math.max(0, (flame.out - age) / 0.8));
      if (lit > 0 && dying > 0) alight++;
      // A molotov is tall where the bottle broke and low everywhere the burning
      // fuel ran to. Drawing every seat the same height gives a flat-topped
      // wall of fire, which is the one thing a real one never looks like.
      const fromCentre = Math.min(1, flame.d / FIRE_RANGE);
      const tall = 1 - FIRE_EDGE_DROP * fromCentre * fromCentre;

      for (let k = 0; k < CARDS_PER_FLAME; k++) {
        const i = f * CARDS_PER_FLAME + k;
        if (!layers?.length) continue;
        if (age < flame.at || age > flame.out) {
          for (const l of layers) l.hide(i);
          continue;
        }

        // Each card sits a little off its seat and rises on its own clock, so
        // a patch of fire churns instead of pulsing as one.
        const ph = seed.phase[i];
        const flick = 0.72 + 0.28 * Math.sin(age * 9.5 + ph) + 0.1 * Math.sin(age * 23 + ph * 2);
        const climb = (age * seed.rise[i] + seed.offset[i]) % 1;
        const w = FLAME_SPACING * seed.size[i] * lit * dying * tall;
        // Fire cards do not roll: a flame has an up, and spinning it reads as
        // a pinwheel. They only ever get taller and thinner as they climb, and
        // fade at both ends of the climb so nothing pops in or out.
        const rise = climb * FLAME_SPACING * 1.5 * tall;
        const fade = Math.min(1, climb * 6) * (1 - climb) ** 0.65;
        const frame = seed.frame[i] + age * FIRE_FPS;

        for (const l of layers) {
          l.set(
            i,
            fxp + seed.ox[i],
            fyp + rise + w * 0.35,
            fzp + seed.oz[i],
            w * (1.05 - climb * 0.25),
            w * (0.9 + flick * 0.35),
            0,
            frame,
            fade * dying * lit,
            null
          );
        }
      }
    }
    for (const l of layers || []) {
      l.prepare(this.camera);
      l.flush();
    }

    if (fx.ground) {
      // The burn builds over the first couple of seconds and then stays —
      // a scorch mark does not fade while the thing that made it is burning —
      // and the ember on top of it breathes with the fire and dies with it.
      const flicker = 0.82 + 0.18 * Math.sin(age * 6.3) + 0.08 * Math.sin(age * 17.1);
      fx.ground.burn.value = 0.9 * Math.min(1, age / 1.6);
      fx.ground.heat.value = 0.55 * flicker * Math.min(1, age / 0.4) * Math.min(1, alight / 3);
    }
  }

  /** Is a point standing in this fire? */
  burningAt(x, y, z) {
    for (const fx of this.live) {
      if (fx.kind !== 'fire') continue;
      for (const f of fx.flames) {
        if (f.at > fx.age || f.out < fx.age) continue;
        if (Math.abs(f.z - z) < 72 && Math.hypot(f.x - x, f.y - y) < FLAME_SPACING * 0.75) return true;
      }
    }
    return false;
  }

  // ---- HE ------------------------------------------------------------------

  _he(pos) {
    const fx = { kind: 'he', age: 0, life: HE_SMOKE, pos, layers: null, build: this._buildHe };
    this._ensureLayers(fx);
    this.live.push(fx);
    // The march's displacement wants it in scene space, with an age.
    const [x, y, z] = sourceToScene(pos.x, pos.y, pos.z);
    const blast = { x, y, z, age: 0, driven: false };
    this._hes.unshift(blast);
    if (this._hes.length > HE_SLOTS) this._hes.length = HE_SLOTS;
    // Kept on the fx so `setAge` can carry the two together.
    fx.blast = blast;
    // ...and it opens up any smoke it went off inside, for the sim's sake.
    this.pushSmokes(pos);
    this._stepHe(fx);
    return fx;
  }

  _buildHe(fx) {
    const ball = this._layer('fire', 'fire_mv', HE_BALLS, LOOK.heFire);
    const smoke = this._layer('smoke', 'smoke_mv', HE_PUFFS, LOOK.heSmoke);
    // The blast smoke is nearly all diffuse (selfIllum 0.12), so without an
    // ambient it would be a black hole punched in the frame.
    if (smoke) {
      const amb = this._light?.ambient;
      const top = _c.copy(amb || new THREE.Color(0.35, 0.35, 0.35)).multiplyScalar(2.6);
      for (let i = 0; i < HE_PUFFS; i++) smoke.setEnv(i, top, top);
    }
    return [ball, smoke].filter(Boolean);
  }

  /**
   * An HE, and the whole of it is over in a second and a half.
   *
   * The old version eased everything: the ball grew for four tenths of a second
   * and the smoke swelled in behind it over two and a half. That is a molotov's
   * timing, not a blast's. A grenade going off is INSTANTANEOUS — the fire is
   * at full reach on the frame it detonates and gone a tenth of a second later,
   * the flash it leaves is what the bloom smears across the frame, and the
   * smoke does not billow in afterwards, it is already there and already
   * thinning. All three beats start on the same frame and the fire and the
   * flash end together, which is what makes them read as one event.
   */
  _stepHe(fx) {
    const layers = this._ensureLayers(fx);
    if (!layers?.length) return;
    const [ball, smoke] = layers;
    const t = fx.age;
    const [ox, oy, oz] = sourceToScene(fx.pos.x, fx.pos.y, fx.pos.z);

    if (ball) {
      // Linear, from 1 to 0 over a tenth of a second, and nothing in front of
      // it: no ramp in, no ease out. The cards are at full reach on frame one.
      const life = Math.max(0, 1 - t / HE_FLAME);
      for (let i = 0; i < HE_BALLS; i++) {
        if (life <= 0) {
          ball.hide(i);
          continue;
        }
        // `C_INIT_RingWave` in explosion_hegrenade_e and _h: the fire does not
        // sit in a ball and swell, it is FLUNG. Because the whole beat is a
        // tenth of a second there is no time to watch it travel, so the throw
        // is resolved on the first frame and what is left is the shape — a
        // ragged star, which is what a blast looks like in a single frame.
        const a = hash(i) * 6.283;
        const dy = (hash(i + 11) - 0.5) * 0.9;
        const dx = Math.cos(a) * (1 - Math.abs(dy) * 0.4);
        const dz = Math.sin(a) * (1 - Math.abs(dy) * 0.4);
        const speed = HE_RING_SPEED[0] + hash(i + 31) * (HE_RING_SPEED[1] - HE_RING_SPEED[0]);
        // First-frame throw only. Growing with (1 - life) made the fire walk
        // outward as it faded; it should sit still while the alpha drops.
        const reach = speed * HE_FLAME_THROW * 0.55;
        const w = HE_RADIUS * (0.1 + hash(i + 41) * 0.1);
        ball.set(
          i,
          ox + dx * reach,
          oy + dy * reach,
          oz + dz * reach,
          w,
          w,
          a,
          hash(i + 61) * 40 + t * HE_FPS,
          Math.min(1, life * 1.6),
          null
        );
      }
      // The flash goes on the OVERBRIGHT, not the alpha: the sprite card clamps
      // alpha to 1 (it is coverage, and more than full coverage means nothing),
      // and what look.js's effects bloom keys off is how far past white the
      // colour is written. Four times over for the first seventy milliseconds,
      // and gone before the fire is, so the two read as one event.
      const flash = t < HE_FLASH ? 1 + (1 - t / HE_FLASH) * 3 : 1;
      ball.uniforms.overbright.value = LOOK.heFire.overbright * flash;
      ball.prepare(this.camera);
      ball.flush();
    }

    if (smoke) {
      // Full extent on frame one, thinning from frame one. The only thing that
      // moves is a slow drift up and out as it goes, which is the smoke being
      // carried by the blast it is already the tail of.
      const life = Math.max(0, 1 - t / HE_SMOKE);
      const drift = 1 - life;
      for (let i = 0; i < HE_PUFFS; i++) {
        if (life <= 0) {
          smoke.hide(i);
          continue;
        }
        const dx = (hash(i) - 0.5) * 2;
        const dy = 0.2 + hash(i + 11) * 0.35;
        const dz = (hash(i + 21) - 0.5) * 2;
        const reach = 32 + 10 * drift;
        const w = (40 + hash(i + 31) * 36) * (1 + 0.1 * drift);
        smoke.set(
          i,
          ox + dx * reach,
          oy + dy * reach + drift * 14,
          oz + dz * reach,
          w,
          w,
          hash(i + 41) * 6.283 + t * (hash(i + 51) - 0.5) * 0.5,
          hash(i + 61) * 64 + t * SMOKE_FPS,
          // Dim on spawn and thinning from there. Full alpha read as a second
          // smoke, not blast soot.
          life * 0.22,
          null
        );
      }
      smoke.uniforms.desaturate.value = 0.35;
      smoke.prepare(this.camera);
      smoke.flush();
    }
  }

  // ---- flashbang -----------------------------------------------------------

  _flash(pos) {
    const fx = { kind: 'flash', layers: [], age: 0, life: 0.25, pos };
    this.live.push(fx);
    return fx;
  }

  /**
   * How blind a viewer at `eye` looking along `dir` (scene frame) is left by a
   * flash at `pos` (Source frame). Overlay duration, seconds — leak Blind
   * stores fadeTime/1.4, not hold+fade.
   */
  flashSeconds(pos, eye, dir) {
    return this.flashAt(pos, eye, dir)?.overlayDuration || 0;
  }

  /**
   * Leak RadiusFlash for one viewer. `eye` and `dir` are scene-frame.
   */
  flashAt(pos, eye, dir) {
    const [ex, ey, ez] = sceneToSource(eye.x, eye.y, eye.z);
    const [fx, fy, fz] = sceneToSource(dir.x, dir.y, dir.z);
    return radiusFlashForPlayer({
      origin: pos,
      eye: { x: ex, y: ey, z: ez },
      forward: { x: fx, y: fy, z: fz },
      trace: this._flashTrace()
    });
  }

  /** Apply a RadiusFlash hit to the camera overlay. */
  applyFlash(pos, eye, dir, now) {
    const hit = this.flashAt(pos, eye, dir);
    if (!hit) return 0;
    this._flashState = applyBlind(this._flashState, hit, now);
    if (hit.deafen > 0) {
      this._deafenAmount = Math.max(this._deafenAmount, hit.deafen);
      this._deafenUntil = Math.max(this._deafenUntil, this._flashState.flashBangTime);
    }
    return hit.overlayDuration;
  }

  /** Blind the camera for `seconds` of overlay, taking the worse of this and any current. */
  blind(seconds, now) {
    if (!(seconds > 0)) return;
    this._flashState = applyBlind(this._flashState, { fadeHold: seconds * 0.5, fadeTime: seconds * 1.4 }, now);
  }

  // ---- decoy ---------------------------------------------------------------

  _decoy(pos) {
    const g = new THREE.Group();
    const [x, y, z] = sourceToScene(pos.x, pos.y, pos.z);
    g.position.set(x, y + 4, z);
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0x9ad47f, transparent: true, opacity: 0.9, depthWrite: false });
    const blip = new THREE.Mesh(this._geo.blip, mat);
    blip.frustumCulled = false;
    g.add(blip);
    this.root.add(g);
    const fx = { kind: 'decoy', group: g, mat, blip, layers: [], age: 0, life: DECOY_SECONDS, pos };
    this.live.push(fx);
    return fx;
  }

  // ---- the clock -----------------------------------------------------------

  /**
   * @param {number} dt
   * @param {number} now  seconds, monotonic
   * @param {THREE.Camera} [camera]  overrides the one given at construction
   */
  update(dt, now = performance.now() / 1000, camera = null) {
    if (camera) this.camera = camera;
    this._time += dt;

    // Blasts age for the smoke march whether or not their own effect is still
    // drawing: the hole one leaves outlives the fire by several seconds.
    for (let i = this._hes.length - 1; i >= 0; i--) {
      // Driven blasts are aged by their owner, the same as driven effects.
      if (this._hes[i].driven) continue;
      this._hes[i].age += dt;
      if (this._hes[i].age > HE_MEMORY) this._hes.splice(i, 1);
    }

    for (let i = this.live.length - 1; i >= 0; i--) {
      const fx = this.live[i];
      // A driven effect has an owner that sets its age from somewhere else
      // (demoNades.js, from the playhead). The clock must not touch it — not
      // its age, not its pose, and above all not its lifetime, or a replayed
      // smoke would expire on wall-clock time while the demo was paused.
      if (fx.driven) continue;
      fx.age += dt;
      if (fx.kind === 'smoke') {
        stepSmokeVolume(fx.vol, dt);
        this._poseSmoke(fx);
      } else if (fx.kind === 'fire') this._poseFire(fx);
      else if (fx.kind === 'he') this._stepHe(fx);
      else if (fx.kind === 'decoy') this._stepDecoy(fx);
      if (fx.age >= fx.life) {
        this._dispose(fx);
        this.live.splice(i, 1);
      }
    }
    if (this._flashState) {
      this.flash = flashOverlayAlpha(this._flashState, now);
      if (!(this.flash > 0)) this._flashState = null;
    } else {
      this.flash = 0;
    }
    if (this._deafenUntil > now) this.deafen = this._deafenAmount;
    else {
      this.deafen = 0;
      this._deafenUntil = 0;
      this._deafenAmount = 0;
    }
  }

  _stepDecoy(fx) {
    const on = Math.sin(fx.age * 9) > 0.55;
    fx.blip.visible = on;
    fx.blip.scale.setScalar(on ? 1 + Math.sin(fx.age * 40) * 0.3 : 1);
    fx.mat.opacity = 0.9 * Math.max(0, 1 - fx.age / fx.life);
  }

  _dispose(fx) {
    // Anything holding a handle to this (demoNades.js keeps one per event) has
    // to be able to tell that it is gone — `clear()` on a map change or a
    // practice reset takes effects out from under those owners.
    fx.disposed = true;
    for (const l of fx.layers || []) l.dispose();
    fx.layers = null;
    fx.smoke?.mesh?.removeFromParent();
    fx.smoke?.dispose();
    fx.smoke = null;
    fx.lpv = null;
    if (fx.ground) {
      for (const m of fx.ground.mats) m.dispose();
      fx.ground.group.removeFromParent();
      fx.ground = null;
    }
    if (!fx.group) return;
    fx.group.traverse((o) => {
      if (o.isMesh) o.material?.dispose?.();
    });
    fx.group.removeFromParent();
  }

  /** Everything gone: map change, respawn, demo load. */
  clear() {
    for (const fx of this.live) this._dispose(fx);
    this.live.length = 0;
    this._hes.length = 0;
    this.flash = 0;
    this.deafen = 0;
    this._flashState = null;
    this._deafenUntil = 0;
    this._deafenAmount = 0;
  }

  dispose() {
    this.clear();
    for (const g of Object.values(this._geo)) g.dispose();
    this.root.removeFromParent();
  }
}
