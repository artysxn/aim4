// ---------------------------------------------------------------------------
// src/weapons/bulletTracers.js
// The streak a bullet leaves in the air, as CS2 draws it — in the trainer.
//
// A port of `src/cs3d/tracers.js` onto the WebGL renderer and into metres.
// Every constant is that file's, and that file's are off
// `particles/weapons/cs_weapon_fx/weapon_tracers_*.vpcf`:
//
//   20500 u/s      `C_INIT_MoveBetweenPoints`. Fast, but not instant — which
//                  is why a spray reads as a stream of separate streaks rather
//                  than a laser, and why the old trainer tracer (a line drawn
//                  whole for 0.09 s) never could.
//   1200 units     `C_OP_RenderTrails.m_flMaxLength`. The streak is a TAIL: at
//                  most 1200 units of it exists at a time and the path behind
//                  that has already gone.
//   0.2 → 0.3      `C_OP_FadeAndKillForTracers` fades it IN over the first
//                  fifth of the flight, so a bullet does not flash in the
//                  shooter's own face, and out over the last 5%.
//   0.8 → 1.2      `C_OP_DistanceToTransform` grows the radius with distance
//                  from the camera out to 8400 units.
//   every Nth      `m_nTracerFrequency`, overridden to 1 in CS2 — every bullet
//                  from every weapon that has a tracer at all.
//
// The ribbon is rebuilt on the CPU once a frame for every live streak: a few
// dozen camera-facing quads into one buffer and one draw call.
//
// **Metres, not Source units.** The map explorer's scene IS Source units, so
// its copy uses the numbers above raw. Here every length is multiplied by
// UNIT_M once, at construction, and the rest of the file is unit-agnostic.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { UNIT_M } from '../../shared/sim3d/units.js';

/** How many streaks may be in the air at once. */
const MAX_TRACERS = 64;

/**
 * `cl_tracer_frequency_override`, and the one place CS2 and CS:GO differ.
 *
 * CS:GO left it at −1, so a rifle drew a streak on every third bullet and the
 * first shot of a spray never had one. CS2 ships it at 1: every bullet gets
 * one, from every weapon that has a tracer at all. −1 falls back to the
 * weapon's own `m_nTracerFrequency` and gives the old behaviour.
 */
const FREQUENCY_OVERRIDE = 1;

/** [verify] Ribbon half-width, Source units — see src/cs3d/tracers.js. */
const RADIUS_UNITS = 1.2;

/**
 * Floor on that width as a fraction of the frame's HEIGHT at the streak's own
 * distance (`C_OP_RenderTrails.m_flMinSize`). Without it a tracer far away is
 * thinner than a pixel and strobes as it moves. A fraction of the frame rather
 * than a pixel count, so the same streak covers the same share of the screen
 * at 1080p and at 4K.
 */
const MIN_SCREEN = 0.0009;

const _camPos = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _head = new THREE.Vector3();
const _tail = new THREE.Vector3();
const _mid = new THREE.Vector3();

export function smoothstep(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Bullet streaks.
 *
 * @example
 *   const tracers = new BulletTracers({ camera: engine.camera });
 *   tracers.attach(engine.scene);
 *   tracers.fire({ from: muzzle, to: impact, weapon });   // THREE.Vector3, metres
 *   tracers.update(dt);
 */
export class BulletTracers {
  /**
   * @param {object} o
   * @param {THREE.Camera} o.camera
   * @param {import('../agents/bulletAssets.js').BulletAssets} o.assets  the
   *   bullet pack. Injected rather than imported, so the geometry and the
   *   frequency rule can be tested without the loader (which reaches the glTF
   *   addons through a Vite-only specifier and will not load under node).
   * @param {number} [o.unitScale] metres per Source unit
   */
  constructor({ camera, assets = null, unitScale = UNIT_M } = {}) {
    this.camera = camera;
    this.assets = assets;
    this.unitScale = unitScale;
    this.enabled = true;
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

  get ready() {
    return !!this.assets?.ready && !!this.assets.tracer;
  }

  _build() {
    if (this.mesh || !this.ready) return this.mesh;
    const g = new THREE.BufferGeometry();
    // Six vertices a quad, no index: the buffer is rewritten whole every frame
    // anyway and an index would be one more upload.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6 * 3), 3));
    for (const a of Object.values(g.attributes)) a.setUsage(THREE.DynamicDrawUsage);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    // The per-vertex value is the streak's fade and it multiplies the COLOUR,
    // not the alpha: under additive blending that is what makes a fading tracer
    // go dim rather than go grey. A MeshBasicMaterial does exactly that —
    // `diffuseColor = color × vColor × map`, alpha straight off the texture —
    // which is the same thing the explorer's node material spells out by hand.
    const mat = new THREE.MeshBasicMaterial({
      map: this.assets.tracer,
      vertexColors: true,
      transparent: true,
      // Additive, like every hot streak in the game: a tracer over a dark wall
      // is light added to it.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
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
   * weapon from the first shot fired with it so the pattern is stable rather
   * than re-rolled. 0 means the weapon has no tracer at all — which is why a
   * silenced MP5-SD leaves none, and the override does not change that.
   */
  wants(weapon) {
    if (!(weapon?.tracerFrequency ?? 0)) return false;
    const freq = FREQUENCY_OVERRIDE >= 0 ? FREQUENCY_OVERRIDE : weapon.tracerFrequency;
    if (!freq) return false;
    const name = weapon.name || '?';
    const n = this._shots.get(name) || 0;
    this._shots.set(name, n + 1);
    return n % freq === 0;
  }

  /**
   * Send one down the line. Both points are in the trainer's world, metres.
   *
   * @param {object} o
   * @param {THREE.Vector3} o.from  the muzzle
   * @param {THREE.Vector3} o.to    where the bullet stopped
   * @param {object} [o.weapon]     weapons-pack row, for the frequency
   * @param {boolean} [o.force]     draw regardless of frequency
   */
  fire({ from, to, weapon = null, force = false }) {
    if (!this.enabled) return false;
    if (!this._build()) return false;
    if (!force && weapon && !this.wants(weapon)) return false;

    const t = this.assets.manifest.tracer;
    const start = new THREE.Vector3().copy(from);
    const end = new THREE.Vector3().copy(to);
    const dist = start.distanceTo(end);
    // Under a Source unit of travel there is nothing to draw.
    if (!(dist > this.unitScale)) return false;

    if (this.live.length >= MAX_TRACERS) this.live.shift();
    this.live.push({
      start,
      dir: end.clone().sub(start).multiplyScalar(1 / dist),
      dist,
      t: 0,
      speed: (t.speed || 20500) * this.unitScale,
      len: (t.maxLength || 1200) * this.unitScale,
      fadeIn: [t.fadeInAt ?? 0.2, (t.fadeInAt ?? 0.2) + 0.1],
      fadeOut: t.fadeOutAt ?? 0.95,
      nearFade: (t.nearFade ?? 0) * this.unitScale
    });
    return true;
  }

  /** Advance every streak and rebuild the ribbon. */
  update(dt) {
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
    if (!g) return;
    const P = g.getAttribute('position').array;
    const U = g.getAttribute('uv').array;
    const C = g.getAttribute('color').array;
    this.camera.getWorldPosition(_camPos);
    const fov = (this.camera.fov || 90) * (Math.PI / 180);
    // World units per screen fraction at a given distance.
    const perFraction = 2 * Math.tan(fov / 2);
    const radius = RADIUS_UNITS * this.unitScale;
    const growTo = 8400 * this.unitScale;

    let v = 0;
    for (const s of this.live) {
      const travelled = s.t * s.speed;
      const headAt = Math.min(travelled, s.dist);
      const tailAt = Math.max(0, Math.min(travelled - s.len, s.dist));
      if (headAt - tailAt < this.unitScale) continue;

      // Fade in over the first fifth of the flight, out over the last 5% —
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

      // Face the camera: the width runs perpendicular to both the flight and
      // the line of sight, which keeps a streak coming straight at you from
      // collapsing to a point.
      _toCam.subVectors(_camPos, _mid);
      _side.crossVectors(s.dir, _toCam);
      if (_side.lengthSq() < 1e-12) continue;
      _side.normalize();

      // `C_OP_DistanceToTransform`: 0.8 at the muzzle up to 1.2 at 8400 units.
      const grow = 0.8 + 0.4 * Math.min(1, camDist / growTo);
      const floorW = MIN_SCREEN * perFraction * camDist;
      const w = Math.max(radius * grow, floorW);
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
