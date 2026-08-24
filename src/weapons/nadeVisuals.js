// ---------------------------------------------------------------------------
// nadeVisuals.js
// The trainer's grenade detonations: CS2's own effects, on the renderer the
// trainer has.
//
// Nothing here is an impression of what a grenade looks like. Every effect is
// the map practice mode's (src/cs3d/nadeEffects.js) with the same sheets, the
// same ramps, the same particle counts and the same curves — the only thing
// rewritten is the shading language, in src/weapons/spriteCardGL.js, because
// that file's twin is TSL and the trainer draws with WebGL.
//
//   SMOKE   one flat-coloured billboard per filled cell of the shared flood
//           fill. Not a sprite sheet, and that is not a shortcut: map practice
//           swapped its own marched volume for exactly this
//           (src/cs3d/smokeCards.js) because a single colour cannot strobe
//           under sorting and because the cloud's shape should come from the
//           fill, which knows about the walls it grew against.
//
//   FIRE    CS2's `fire_small_sim_b` flipbook, motion-vector blended, coloured
//           through the game's own molotov / incendiary ramps. Six cards per
//           seat of the shared spread, each rising and fading on its own clock.
//
//   HE      the game's blast: thirty fire cards FLUNG outward on the first
//           frame and gone in a sixth of a second, over thirty-four puffs of
//           blast soot that are at full extent immediately and only thin.
//
// The simulations stay shared and headless: shared/sim3d/smokeVolume.js and
// fireSpread.js decide where the fire is and what the cloud fills, here and in
// the explorer both, so what you see is what the damage and the sightline
// checks read.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { UNIT_M } from '../../shared/sim3d/units.js';
import { packBase } from '../agents/packBase.js';
import { loadFxPackGL, SpriteCardBatchGL } from './spriteCardGL.js';
import {
  buildSmokeVolume,
  stepSmokeVolume,
  cellOpacity,
  smokeBlocks,
  pushSmoke,
  SMOKE_CELL,
  SMOKE_SECONDS,
  SMOKE_BLOOM,
  SMOKE_PUSH_RADIUS
} from '../../shared/sim3d/smokeVolume.js';
import {
  buildFireSpread,
  fireCovers,
  FLAME_SPACING,
  FIRE_RANGE,
  FIRE_SECONDS,
  FIRE_SECONDS_INC
} from '../../shared/sim3d/fireSpread.js';
import { HE_RADIUS, TRAIL_COLOR } from '../../shared/sim3d/nadeStats.js';

// ---- the fx pack ------------------------------------------------------------

let _fxPack = null;
let _fxJob = null;

/** The loaded fx pack, or null until it lands. Never throws at a caller. */
export function sharedFxPack() {
  return _fxPack;
}

/**
 * Fetch the sheets once for the page. Called at boot so the first molotov of a
 * session does not wait on a megabyte of flipbook; an effect built before it
 * lands simply builds its layers on the frame it arrives.
 */
export function warmNadeVisuals() {
  if (_fxJob) return _fxJob;
  _fxJob = loadFxPackGL(`${packBase()}/fx`)
    .then((pack) => {
      _fxPack = pack;
      return pack;
    })
    .catch((e) => {
      console.warn('aim4: fx pack unavailable, grenades draw without sheets —', e.message || e);
      return null;
    });
  return _fxJob;
}

// ---- the numbers, all of them src/cs3d/nadeEffects.js's ----------------------

/**
 * `C_OP_RenderSprites` settings per effect, straight off the particle systems.
 *
 * The overbrights on the additive passes are large on purpose: the explorer
 * renders into an HDR target and blooms everything past 3. The trainer has no
 * bloom pass, so these are what stands in for the glow — which is why the fire
 * still reads as light rather than as an orange sticker.
 */
const LOOK = Object.freeze({
  // molotov_groundfire_main_fancy.vpcf, first renderer
  fire: { color: [255, 255, 255], alphaScale: 0.62, selfIllum: 1, diffuse: 0, overbright: 1.22 },
  // molotov_groundfire_outline.vpcf, the additive second pass — the glow
  fireGlow: { color: [255, 255, 255], alphaScale: 0.34, selfIllum: 1, diffuse: 0, overbright: 1.0, additive: true, bloomOnly: true },
  // explosion_hegrenade_b.vpcf: colour scale 0,0,0, so the blast smoke is
  // nearly black and lit rather than emissive.
  heSmoke: { color: [54, 54, 57], alphaScale: 0.7, selfIllum: 0.12, diffuse: 0.9, overbright: 1, alphaOnly: true },
  heFire: { color: [255, 255, 255], alphaScale: 0.75, selfIllum: 1, diffuse: 0, overbright: 2.2, additive: true, bloomOnly: true }
});

/**
 * Why the numbers above are not the ones in src/cs3d/nadeEffects.js.
 *
 * The explorer's are the particle systems' own — `m_flAlphaScale` 2 on the
 * flame, `m_flOverbrightFactor` 2.4 under it, 4.5 on the additive outline, 16
 * on an HE — and they are written well past white ON PURPOSE, because that
 * renderer draws into an HDR target and look.js blooms everything past 3. The
 * overbright is not the brightness you see; it is the amount of energy handed
 * to the bloom, which spreads it and tone-maps it back down.
 *
 * The trainer is a plain WebGL forward pass: no HDR target, no bloom, no tone
 * map. Write 4.5 into that and it does not glow, it CLIPS — every texel of a
 * flame saturates to white and the puddle comes out as a flat white wall with
 * the sheet's detail burnt out of it, which is the opposite of the effect the
 * number is there to produce.
 *
 * So the values above are the same effect re-exposed for LDR: enough coverage
 * that the sheet's own structure survives, and enough headroom above the flame
 * that the hot core still reads as hotter than its edges. They were dialled by
 * eye against the explorer running the same molotov side by side. If the
 * trainer ever grows a bloom pass, take the originals back.
 */

const SMOKE_FPS = 7;
const FIRE_FPS = 24;
const HE_FPS = 30;
const CARDS_PER_FLAME = 6;
/** How much lower the fire runs at the rim of its spread than at the bottle. */
const FIRE_EDGE_DROP = 0.5;
const HE_FLAME = 0.165;
const HE_FLASH = 0.07;
const HE_SMOKE = 1.5;
const HE_FLAME_THROW = 0.11;
const HE_PUFFS = 34;
const HE_BALLS = 30;
const HE_RING_SPEED = [900, 3400];

/** src/cs3d/smokeCards.js — a card is this many fill cells across. */
const CARD_SPAN = 3.3;
const CARD_ALPHA = 1;
const EDGE_WIDTH = 0.25;
const SPRITE_PX = 256;

/** Source → the trainer's scene metres. */
const S = (x, y, z) => [x * UNIT_M, z * UNIT_M, -y * UNIT_M];

function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** The blast soot is nearly all diffuse, so without an ambient it is a hole. */
const HE_AMBIENT = new THREE.Color(0.35, 0.35, 0.35).multiplyScalar(2.6);

// ---- smoke ------------------------------------------------------------------

let _disc = null;

/**
 * A smoke card's alpha: flat to `1 - EDGE_WIDTH`, then a smoothstep to nothing.
 *
 * Procedural for the same reason the explorer bakes it procedurally — the fx
 * pack's smoke sheet is a sprite flipbook for BLAST soot, not for a standing
 * cloud, and a standing cloud is drawn from the fill instead. Confining the
 * transition to the outer quarter is what gives the cloud a silhouette rather
 * than a haze that thins until it stops.
 */
export function discTexture() {
  if (_disc) return _disc;
  const n = SPRITE_PX;
  const data = new Uint8Array(n * n);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot((x - c) / c, (y - c) / c));
      const t = Math.min(1, Math.max(0, (1 - r) / EDGE_WIDTH));
      data[y * n + x] = Math.round(255 * t * t * (3 - 2 * t));
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  _disc = tex;
  return tex;
}

const SMOKE_VERT = /* glsl */ `
attribute vec3 iCentre;
attribute float iSize;
varying vec2 vUv;
void main() {
  vUv = position.xy + 0.5;
  vec4 view = modelViewMatrix * vec4(iCentre, 1.0);
  vec2 corner = position.xy * iSize;
  gl_Position = projectionMatrix * vec4(view.x + corner.x, view.y + corner.y, view.z, view.w);
}
`;

const SMOKE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uTint;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  float cover = texture2D(uMap, vUv).r;
  float a = cover * uAlpha;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(uTint, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * One smoke: the shared flood fill, drawn as one flat card per filled cell.
 *
 * `world` is the cloud's view of the map — one `solidAt` — so a smoke thrown
 * into a doorway pours through it and one against a wall runs along it,
 * exactly as in map practice.
 */
export class SmokeCloud {
  constructor({ pos, world = null, color = TRAIL_COLOR.smokegrenade }) {
    this.vol = buildSmokeVolume({ origin: pos, world });
    this.age = 0;
    this.done = false;

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    geo.instanceCount = 0;
    quad.dispose();
    const n = this.vol.cells.length;
    this._centre = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this._size = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this._centre.setUsage(THREE.DynamicDrawUsage);
    this._size.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iCentre', this._centre);
    geo.setAttribute('iSize', this._size);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: discTexture() },
        uTint: { value: new THREE.Color(color) },
        uAlpha: { value: CARD_ALPHA }
      },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      // Depth TESTED so the world occludes the cloud; depth WRITE off so the
      // cards do not occlude each other and the stack can accumulate. A single
      // flat colour `over`-blends order-independently, so they are never
      // sorted and cannot strobe as the camera moves.
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false
    });
    this.object = new THREE.Mesh(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 6;
    this._span = this.vol.cell * CARD_SPAN * UNIT_M;
    this._lay();
  }

  /** An HE went off: blow a hole that knits shut on the shared timer. */
  push(at, radius = SMOKE_PUSH_RADIUS) {
    pushSmoke(this.vol, at, radius);
  }

  /** Does the standing cloud cover this Source-frame point? */
  blocksPoint(x, y, z) {
    return smokeBlocks(this.vol, x, y, z);
  }

  update(dt) {
    this.age += dt;
    if (!stepSmokeVolume(this.vol, dt)) this.done = true;
    this._lay();
    return !this.done;
  }

  /**
   * Every filled cell becomes a card, sized by its own opacity.
   *
   * Re-laid each frame rather than animated in the shader: `cellOpacity` is
   * where bloom-in, the HE's hole, the knit-back and the end fade all already
   * live. Shrinking a card rather than fading it is what makes a hole read as
   * a hole instead of as the cloud going translucent.
   */
  _lay() {
    const cells = this.vol.cells;
    const centre = this._centre;
    const size = this._size;
    let n = 0;
    for (let i = 0; i < cells.length; i++) {
      const w = cellOpacity(this.vol, i);
      if (!(w > 0.01)) continue;
      const c = cells[i];
      const [x, y, z] = S(c.x, c.y, c.z);
      centre.setXYZ(n, x, y, z);
      size.setX(n, this._span * Math.min(1, w));
      n++;
    }
    centre.needsUpdate = true;
    size.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  dispose() {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---- fire -------------------------------------------------------------------

/**
 * One fire: the shared ground spread, drawn with CS2's flame flipbook.
 *
 * Six cards per seat, each with its own phase, rise rate, offset and starting
 * frame, so a patch of fire churns instead of pulsing as one body. The seats
 * light and go out on `buildFireSpread`'s schedule — last lit, first out — and
 * that is the same schedule `covers` reports damage on.
 */
export class FirePatch {
  constructor({ pos, dir = null, type = 'molotov', world = null }) {
    this.type = type === 'incgrenade' || type === 'incendiary' ? 'incgrenade' : 'molotov';
    this.life = this.type === 'incgrenade' ? FIRE_SECONDS_INC : FIRE_SECONDS;
    this.flames = buildFireSpread({ origin: pos, dir, type, world });
    this.age = 0;
    this.done = false;
    this.object = new THREE.Group();
    this.layers = null;

    const [cx, cy, cz] = S(pos.x, pos.y, pos.z);
    this.centreM = { x: cx, y: cy, z: cz };
    this.radiusM =
      (this.flames.reduce((m, f) => Math.max(m, f.d || 0), 0) + FLAME_SPACING) * UNIT_M;

    // Per-card jitter, once: it never changes and `_pose` runs every frame over
    // a hundred-odd cards.
    const n = this.flames.length * CARDS_PER_FLAME;
    this.seed = {
      phase: new Float32Array(n),
      rise: new Float32Array(n),
      offset: new Float32Array(n),
      size: new Float32Array(n),
      ox: new Float32Array(n),
      oz: new Float32Array(n),
      frame: new Float32Array(n)
    };
    for (let i = 0; i < n; i++) {
      this.seed.phase[i] = hash(i) * 6.283;
      this.seed.rise[i] = 0.55 + hash(i + 5) * 0.5;
      this.seed.offset[i] = hash(i + 9);
      this.seed.size[i] = 1.15 + hash(i + 1) * 0.5;
      this.seed.ox[i] = (hash(i + 2) - 0.5) * FLAME_SPACING * 0.85;
      this.seed.oz[i] = (hash(i + 3) - 0.5) * FLAME_SPACING * 0.85;
      this.seed.frame[i] = hash(i + 13) * 32;
    }
  }

  /** Is this Source-frame point in the fire right now? */
  covers(x, y, z) {
    return fireCovers(this.flames, x, y, z, this.age);
  }

  /**
   * Build the two passes once the sheets are in hand.
   *
   * The body is orange for both types; what tells a molotov from an incendiary
   * is the FRINGE, and that is the `edge` ramp — violet for one, cyan for the
   * other — on the additive pass. Reaching for the edge ramp as the body paints
   * the whole flame magenta.
   */
  _build() {
    const pack = sharedFxPack();
    if (!pack?.sheets?.fire) return null;
    const n = this.flames.length * CARDS_PER_FLAME;
    const ramps = pack.ramps?.[this.type] || pack.ramps?.molotov || null;
    const make = (look, ramp) =>
      new SpriteCardBatchGL({
        sheet: pack.sheets.fire,
        mv: pack.sheets.fire_mv || null,
        ramp,
        count: n,
        ...look
      });
    const body = make(LOOK.fire, ramps?.body || null);
    const glow = make(LOOK.fireGlow, ramps?.edge || ramps?.body || null);
    this.layers = [body, glow];
    for (const l of this.layers) this.object.add(l.mesh);
    return this.layers;
  }

  update(dt, camera = null) {
    this.age += dt;
    if (this.age >= this.life) {
      this.done = true;
      return false;
    }
    if (!this.layers) this._build();
    if (this.layers) this._pose(camera);
    return true;
  }

  _pose(camera) {
    const layers = this.layers;
    const { flames, seed, age } = this;
    for (let f = 0; f < flames.length; f++) {
      const flame = flames[f];
      const [fxp, fyp, fzp] = S(flame.x, flame.y, flame.z);
      // Each seat has its own clock: it catches at `at` and goes out at `out`.
      const lit = Math.min(1, (age - flame.at) / 0.35);
      const dying = Math.min(1, Math.max(0, (flame.out - age) / 0.8));
      // A molotov is tall where the bottle broke and low everywhere the burning
      // fuel ran to. One height for every seat gives a flat-topped wall of
      // fire, which is the one thing a real one never looks like.
      const fromCentre = Math.min(1, flame.d / FIRE_RANGE);
      const tall = 1 - FIRE_EDGE_DROP * fromCentre * fromCentre;

      for (let k = 0; k < CARDS_PER_FLAME; k++) {
        const i = f * CARDS_PER_FLAME + k;
        if (age < flame.at || age > flame.out) {
          for (const l of layers) l.hide(i);
          continue;
        }
        // Each card sits a little off its seat and rises on its own clock, so a
        // patch of fire churns instead of pulsing as one.
        const ph = seed.phase[i];
        const flick = 0.72 + 0.28 * Math.sin(age * 9.5 + ph) + 0.1 * Math.sin(age * 23 + ph * 2);
        const climb = (age * seed.rise[i] + seed.offset[i]) % 1;
        const w = FLAME_SPACING * seed.size[i] * lit * dying * tall * UNIT_M;
        // Fire cards do not roll: a flame has an up, and spinning it reads as a
        // pinwheel. They only get taller and thinner as they climb, and fade at
        // both ends of it so nothing pops in or out.
        const rise = climb * FLAME_SPACING * 1.5 * tall * UNIT_M;
        const fade = Math.min(1, climb * 6) * (1 - climb) ** 0.65;
        const frame = seed.frame[i] + age * FIRE_FPS;
        for (const l of layers) {
          l.set(
            i,
            fxp + seed.ox[i] * UNIT_M,
            fyp + rise + w * 0.35,
            fzp + seed.oz[i] * UNIT_M,
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
    for (const l of layers) {
      l.prepare(camera);
      l.flush();
    }
  }

  dispose() {
    for (const l of this.layers || []) l.dispose();
    this.layers = null;
    this.object.removeFromParent();
  }
}

// ---- HE ---------------------------------------------------------------------

/**
 * An HE going off, and the whole of it is over in a second and a half.
 *
 * A grenade is INSTANTANEOUS: the fire is at full reach on the frame it
 * detonates and gone a tenth of a second later, and the soot does not billow in
 * afterwards — it is already there and already thinning. All three beats start
 * on the same frame, which is what makes them read as one event rather than as
 * a sequence of three.
 */
export class BlastFx {
  constructor({ pos }) {
    this.age = 0;
    this.life = HE_SMOKE;
    this.done = false;
    this.pos = { ...pos };
    this.object = new THREE.Group();
    this.layers = null;
  }

  _build() {
    const pack = sharedFxPack();
    if (!pack?.sheets?.fire || !pack?.sheets?.smoke) return null;
    const ball = new SpriteCardBatchGL({
      sheet: pack.sheets.fire,
      mv: pack.sheets.fire_mv || null,
      count: HE_BALLS,
      ...LOOK.heFire
    });
    const smoke = new SpriteCardBatchGL({
      sheet: pack.sheets.smoke,
      mv: pack.sheets.smoke_mv || null,
      count: HE_PUFFS,
      ...LOOK.heSmoke
    });
    for (let i = 0; i < HE_PUFFS; i++) smoke.setEnv(i, HE_AMBIENT, HE_AMBIENT);
    smoke.uniforms.uDesaturate.value = 0.35;
    this.layers = [ball, smoke];
    for (const l of this.layers) this.object.add(l.mesh);
    return this.layers;
  }

  update(dt, camera = null) {
    this.age += dt;
    if (this.age >= this.life) {
      this.done = true;
      return false;
    }
    if (!this.layers) this._build();
    if (this.layers) this._pose(camera);
    return true;
  }

  _pose(camera) {
    const [ball, smoke] = this.layers;
    const t = this.age;
    const [ox, oy, oz] = S(this.pos.x, this.pos.y, this.pos.z);
    const U = UNIT_M;

    // Linear from 1 to 0 over a tenth of a second, and nothing in front of it:
    // the cards are at full reach on frame one.
    const life = Math.max(0, 1 - t / HE_FLAME);
    for (let i = 0; i < HE_BALLS; i++) {
      if (life <= 0) {
        ball.hide(i);
        continue;
      }
      // `C_INIT_RingWave`: the fire does not sit in a ball and swell, it is
      // FLUNG. There is no time to watch it travel, so the throw is resolved on
      // the first frame and what is left is the shape — a ragged star.
      const a = hash(i) * 6.283;
      const dy = (hash(i + 11) - 0.5) * 0.9;
      const dx = Math.cos(a) * (1 - Math.abs(dy) * 0.4);
      const dz = Math.sin(a) * (1 - Math.abs(dy) * 0.4);
      const speed = HE_RING_SPEED[0] + hash(i + 31) * (HE_RING_SPEED[1] - HE_RING_SPEED[0]);
      const reach = speed * HE_FLAME_THROW * 0.55 * U;
      const w = HE_RADIUS * (0.1 + hash(i + 41) * 0.1) * U;
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
    // The flash goes on the OVERBRIGHT, not the alpha: alpha is coverage and
    // clamps at 1, and what reads as a flash is how far past white the colour
    // is written.
    const flash = t < HE_FLASH ? 1 + (1 - t / HE_FLASH) * 3 : 1;
    ball.uniforms.uOverbright.value = LOOK.heFire.overbright * flash;
    ball.prepare(camera);
    ball.flush();

    // Full extent on frame one, thinning from frame one. The only movement is a
    // slow drift up and out, the soot being carried by the blast it is the tail
    // of.
    const sLife = Math.max(0, 1 - t / HE_SMOKE);
    const drift = 1 - sLife;
    for (let i = 0; i < HE_PUFFS; i++) {
      if (sLife <= 0) {
        smoke.hide(i);
        continue;
      }
      const dx = (hash(i) - 0.5) * 2;
      const dy = 0.2 + hash(i + 11) * 0.35;
      const dz = (hash(i + 21) - 0.5) * 2;
      const reach = (32 + 10 * drift) * U;
      const w = (40 + hash(i + 31) * 36) * (1 + 0.1 * drift) * U;
      smoke.set(
        i,
        ox + dx * reach,
        oy + dy * reach + drift * 14 * U,
        oz + dz * reach,
        w,
        w,
        hash(i + 41) * 6.283 + t * (hash(i + 51) - 0.5) * 0.5,
        hash(i + 61) * 64 + t * SMOKE_FPS,
        // Dim on spawn and thinning. Full alpha reads as a second smoke, not
        // as blast soot.
        sLife * 0.22,
        null
      );
    }
    smoke.prepare(camera);
    smoke.flush();
  }

  dispose() {
    for (const l of this.layers || []) l.dispose();
    this.layers = null;
    this.object.removeFromParent();
  }
}

export { SMOKE_CELL, SMOKE_SECONDS, SMOKE_BLOOM };
