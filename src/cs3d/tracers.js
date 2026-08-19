// ---------------------------------------------------------------------------
// src/cs3d/tracers.js
// The streak a bullet leaves in the air, as CS2 draws it.
//
// Everything here is off `particles/weapons/cs_weapon_fx/weapon_tracers_*.vpcf`,
// which is a one-particle system moved between two control points, and the
// numbers in it are more specific than they look:
//
//   20500 u/s      `C_INIT_MoveBetweenPoints`. A tracer crosses A-long on Dust
//                  in about 0.15 s, which is why a spray reads as a stream of
//                  separate streaks and not a laser.
//   1200 units     `C_OP_RenderTrails.m_flMaxLength`. The streak is a TAIL,
//                  not a line from the muzzle: it is at most 1200 units long
//                  and the rest of the path behind it has already gone.
//   0.2 → 0.3      `C_OP_FadeAndKillForTracers` fades the thing IN over the
//                  first fifth of its flight. A bullet does not flash in your
//                  own face; it appears once it is away from you. Same op
//                  fades it out over the last 5%.
//   0.8 → 1.2      `C_OP_DistanceToTransform` scales the radius with how far
//                  the particle is from the camera, out to 8400 units, so a
//                  tracer down a long sightline does not shrink to nothing.
//   every Nth      `m_nTracerFrequency` on the weapon — 3 on the rifles, 1 on
//                  the pistols and the AWP, 0 on the silenced weapons, which is
//                  why an MP5-SD leaves none at all. CS2 then overrides it: see
//                  FREQUENCY_OVERRIDE.
//
// The ribbon is built on the CPU, once a frame, for every live tracer: at most
// a few dozen quads, camera-facing, into one buffer and one draw. Doing it in
// a shader would need a per-instance path and buy nothing at this count.
//
// The one number with no source behind it is the ribbon's WIDTH. The particle
// system's `m_flMinSize` / `m_flMaxSize` (0.00075 / 0.002) are the renderer's
// screen-space clamp rather than a world size, and the radius the particle
// carries is set by an operator chain this does not evaluate. `RADIUS` below
// is dialled to the streak CS2 draws and marked `[verify]`.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { attribute, texture, uv } from 'three/webgpu';
import { sourceToScene } from '../../shared/sim3d/units.js';

/** How many streaks may be in the air at once. */
const MAX_TRACERS = 64;

/**
 * `cl_tracer_frequency_override`, and the one place CS2 and CS:GO differ here.
 *
 * CS:GO left it at −1, so a rifle drew a streak on every third bullet and the
 * first shot of a spray never had one. CS2 ships it at 1: EVERY bullet is a
 * tracer, from every weapon that has one at all. That is a visible change and
 * it is the game being replicated, so 1 it is; −1 falls back to the weapon's
 * own `m_nTracerFrequency` and gives the old behaviour.
 */
const FREQUENCY_OVERRIDE = 1;

/** [verify] Ribbon half-width, Source units. See the header. */
const RADIUS = 1.2;

/**
 * Floor on that width, as a fraction of the frame's HEIGHT at the tracer's own
 * distance — `C_OP_RenderTrails.m_flMinSize`. Without it a streak 3000 units
 * out is thinner than a pixel and strobes as it moves.
 *
 * A fraction of the frame rather than a pixel count, so it needs the field of
 * view and the distance but not the resolution: the same streak covers the
 * same share of the screen at 1080p and at 4K, which is what the particle
 * system's own units mean.
 */
const MIN_SCREEN = 0.0009;

const _camPos = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _head = new THREE.Vector3();
const _tail = new THREE.Vector3();
const _mid = new THREE.Vector3();

/**
 * Bullet streaks.
 *
 * @example
 *   const tracers = new Tracers({ assets, camera });
 *   tracers.attach(pack.world);
 *   tracers.fire({ from: muzzleSource, to: impactSource, weapon, shotIndex });
 *   tracers.update(dt);
 */
export class Tracers {
  /**
   * @param {object} o
   * @param {import('./bulletPack.js').BulletAssets} o.assets
   * @param {THREE.Camera} o.camera
   * @param {boolean} [o.enabled]
   */
  constructor({ assets, camera, enabled = true }) {
    this.assets = assets;
    this.camera = camera;
    this.enabled = enabled;
    this.root = new THREE.Group();
    this.root.name = 'tracers';
    this.live = [];
    this.mesh = null;
    this._geo = null;
    /** Rolling count of shots per weapon, for `m_nTracerFrequency`. */
    this._shots = new Map();
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
    return this;
  }

  _build() {
    if (this.mesh || !this.assets?.ready || !this.assets.manifest?.tracer) return this.mesh;
    const g = new THREE.BufferGeometry();
    // Six vertices a quad: no index, because the buffer is rewritten whole
    // every frame anyway and an index would be one more upload.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 3), 3));
    for (const a of Object.values(g.attributes)) a.setUsage(THREE.DynamicDrawUsage);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      // Additive, like every hot streak in the game: a tracer over a dark wall
      // is light added to it, and one crossing a smoke does not punch a hole.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    // Written out rather than left to `map` + `vertexColors`, because the two
    // together on a node material are a guess about which of them wins.
    // The per-vertex value is the streak's fade, and it multiplies the colour
    // rather than the alpha: under additive blending that is what makes a
    // fading tracer go dim instead of going grey.
    const tex = texture(this.assets.tracer, uv());
    mat.colorNode = tex.rgb.mul(attribute('color', 'vec3'));
    mat.opacityNode = tex.a;
    this._geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'tracers';
    this.root.add(this.mesh);
    return this.mesh;
  }

  /**
   * Does this shot get a streak?
   *
   * `m_nTracerFrequency` is a period: 3 means one bullet in three, counted per
   * weapon from the first shot fired with it, so the pattern is stable rather
   * than re-rolled. 0 means the weapon has no tracer at all.
   */
  wants(weapon) {
    // A weapon with no tracer at all still has none: the override changes the
    // PERIOD, not whether the weapon draws one.
    if (!(weapon?.tracerFrequency ?? 0)) return false;
    const freq = FREQUENCY_OVERRIDE >= 0 ? FREQUENCY_OVERRIDE : weapon.tracerFrequency;
    if (!freq) return false;
    const name = weapon.name || '?';
    const n = this._shots.get(name) || 0;
    this._shots.set(name, n + 1);
    return n % freq === 0;
  }

  /**
   * Send one down the line.
   *
   * @param {object} o
   * @param {{x,y,z}} o.from   the muzzle, SOURCE frame
   * @param {{x,y,z}} o.to     where the bullet stopped, SOURCE frame
   * @param {object} [o.weapon] the weapons-pack row, for its tracer frequency
   * @param {boolean} [o.force] draw regardless of frequency
   */
  fire({ from, to, weapon = null, force = false }) {
    if (!this.enabled) return false;
    if (!this._build()) return false;
    if (!force && weapon && !this.wants(weapon)) return false;

    const t = this.assets.manifest.tracer;
    const a = sourceToScene(from.x, from.y, from.z);
    const b = sourceToScene(to.x, to.y, to.z);
    const start = new THREE.Vector3(a[0], a[1], a[2]);
    const end = new THREE.Vector3(b[0], b[1], b[2]);
    const dist = start.distanceTo(end);
    if (!(dist > 1)) return false;

    if (this.live.length >= MAX_TRACERS) this.live.shift();
    this.live.push({
      start,
      dir: end.clone().sub(start).multiplyScalar(1 / dist),
      dist,
      t: 0,
      speed: t.speed || 20500,
      len: t.maxLength || 1200,
      fadeIn: [t.fadeInAt ?? 0.2, (t.fadeInAt ?? 0.2) + 0.1],
      fadeOut: t.fadeOutAt ?? 0.95,
      nearFade: t.nearFade ?? 0
    });
    return true;
  }

  /** Advance every streak and rebuild the ribbon. */
  update(dt) {
    // Compile the ribbon material once lighting/assets exist, not on the
    // first shot — same hitch class as the first grenade before SmokePass.warm.
    if (!this.mesh) this._build();
    if (!this.mesh) return;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      s.t += dt;
      // Gone once the HEAD has arrived and the tail has caught up with it.
      if (s.t * s.speed > s.dist + s.len) this.live.splice(i, 1);
    }
    this._rebuild();
  }

  _rebuild() {
    const g = this._geo;
    const P = g.getAttribute('position').array;
    const U = g.getAttribute('uv').array;
    const C = g.getAttribute('color').array;
    this.camera.getWorldPosition(_camPos);
    const fov = (this.camera.fov || 90) * (Math.PI / 180);
    // World units per screen fraction, at a given distance: the ribbon's
    // minimum width in the world is whatever MIN_SCREEN works out to there.
    const perFraction = 2 * Math.tan(fov / 2);

    let v = 0;
    for (const s of this.live) {
      const travelled = s.t * s.speed;
      const headAt = Math.min(travelled, s.dist);
      const tailAt = Math.max(0, Math.min(travelled - s.len, s.dist));
      if (headAt - tailAt < 1) continue;

      // Fade in over the first fifth of the flight, out over the last 5%:
      // `C_OP_FadeAndKillForTracers`, in the units it counts in (fraction of
      // the way there).
      const u = headAt / s.dist;
      let alpha = smoothstep(s.fadeIn[0], s.fadeIn[1], u);
      if (u > s.fadeOut) alpha *= 1 - (u - s.fadeOut) / (1 - s.fadeOut);
      if (alpha <= 0.001) continue;

      _head.copy(s.start).addScaledVector(s.dir, headAt);
      _tail.copy(s.start).addScaledVector(s.dir, tailAt);
      _mid.addVectors(_head, _tail).multiplyScalar(0.5);

      // Too close to the eye to draw: the game holds its own tracer off for
      // the first `nearFade` units so it does not blind the shooter.
      const camDist = _mid.distanceTo(_camPos);
      if (s.nearFade > 0 && camDist < s.nearFade) alpha *= camDist / s.nearFade;
      if (alpha <= 0.001) continue;

      // Face the camera: the ribbon's width runs perpendicular to both the
      // flight and the line of sight, which is what keeps a streak coming
      // straight at you from collapsing to a point.
      _toCam.subVectors(_camPos, _mid);
      _side.crossVectors(s.dir, _toCam);
      if (_side.lengthSq() < 1e-8) continue;
      _side.normalize();

      // `C_OP_DistanceToTransform`: 0.8 at the muzzle up to 1.2 at 8400 units.
      const grow = 0.8 + 0.4 * Math.min(1, camDist / 8400);
      const floorW = MIN_SCREEN * perFraction * camDist;
      const w = Math.max(RADIUS * grow, floorW);
      _side.multiplyScalar(w);

      // v runs 0 at the tail to 1 at the head — the spark texture tapers at
      // one end and that end is the bullet.
      const quad = [
        [_tail, -1, 0],
        [_tail, 1, 0],
        [_head, 1, 1],
        [_tail, -1, 0],
        [_head, 1, 1],
        [_head, -1, 1]
      ];
      for (const [p, sideSign, vv] of quad) {
        P[v * 3] = p.x + _side.x * sideSign;
        P[v * 3 + 1] = p.y + _side.y * sideSign;
        P[v * 3 + 2] = p.z + _side.z * sideSign;
        U[v * 2] = sideSign > 0 ? 1 : 0;
        U[v * 2 + 1] = vv;
        C[v * 3] = alpha;
        C[v * 3 + 1] = alpha;
        C[v * 3 + 2] = alpha;
        v++;
      }
      if (v + 6 > MAX_TRACERS * 6) break;
    }

    // Everything past the last streak is collapsed to the origin, where it is
    // a zero-area triangle and costs no fragments.
    if (v < MAX_TRACERS * 6) {
      P.fill(0, v * 3);
      C.fill(0, v * 3);
    }
    g.setDrawRange(0, v);
    for (const a of Object.values(g.attributes)) a.needsUpdate = true;
  }

  clear() {
    this.live.length = 0;
    this._shots.clear();
    if (this._geo) this._geo.setDrawRange(0, 0);
  }

  dispose() {
    this.mesh?.geometry.dispose();
    this.mesh?.material.dispose();
    this.root.removeFromParent();
    this.mesh = null;
    this._geo = null;
  }
}

function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
