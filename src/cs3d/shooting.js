// ---------------------------------------------------------------------------
// src/cs3d/shooting.js
// Pulling the trigger: the body around shared/sim3d/penetration.js, the way
// src/cs3d/projectiles.js is the body around shared/sim3d/grenade.js.
//
// It does three things with one bullet:
//
//   breaks what it hits    a window, a vent — the interactive that owns the
//                          triangle takes the damage the solver had left when
//                          it got there (src/cs3d/interactives.js)
//   draws the path         entry to exit, with the segments INSIDE a wall in
//                          their own colour, because a wallbang is otherwise a
//                          bullet that either arrives or does not and there is
//                          nothing to look at either way
//   reports the numbers    which surfaces, how thick, what damage survived
//
// The drawing and the reporting are the point as much as the damage is: the
// one constant in the solver with no measurement behind it is the scale from a
// weapon's penetration power to units of wall, and seeing "concrete 12u → 23
// dmg" on the screen is how anyone would ever notice it is wrong.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { fireBullet } from '../../shared/sim3d/penetration.js';
import { sourceToScene } from '../../shared/sim3d/units.js';
import { createRayWorld } from './rayWorld.js';

/** How long a drawn bullet path stays, seconds. */
export const TRACE_SECONDS = 4;
/** How many path segments are kept before the oldest is dropped. */
export const TRACE_MAX = 24;
/** Two verts a segment; air and wallbang each own a buffer this size. */
const TRACE_VERTS = TRACE_MAX * 2;

const AIR = [1, 224 / 255, 138 / 255];
const THROUGH = [1, 90 / 255, 60 / 255];

export class Shooting {
  /**
   * @param {object} o
   * @param {() => object|null} o.getWeapon      the weapons-pack row in hand
   * @param {import('./interactives.js').Interactives} [o.interactives]
   * @param {(shot: object) => void} [o.onShot]
   * @param {(impact: object) => void} [o.onImpact]  every surface the round
   *   touched, in order — the hook the bullet holes hang off
   *   (src/cs3d/decals.js)
   * @param {(from, to) => object|null} [o.hitTargets]  first player on a
   *   segment; same shape fireBullet wants
   * @param {boolean} [o.traces]                 draw the path
   */
  constructor({ getWeapon, interactives = null, onShot = null, onImpact = null, hitTargets = null, traces = true } = {}) {
    this.getWeapon = getWeapon || (() => null);
    this.interactives = interactives;
    this.onShot = onShot || (() => {});
    this.onImpact = onImpact || null;
    this.hitTargets = hitTargets || null;
    this.traces = traces;
    this.root = new THREE.Group();
    this.root.name = 'bullets';
    this.world = null;
    this.lines = [];
    this._air = null;
    this._through = null;
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  /** The map's collision, as a BULLET sees it (src/cs3d/rayWorld.js). */
  setCollider(collider, movers = null) {
    this.movers = movers || this.movers || null;
    this.world = collider ? createRayWorld(collider, this.movers, { Ray: THREE.Ray }) : null;
  }

  /**
   * One shot from the eye along the view.
   *
   * @param {{x,y,z}} eye  SOURCE frame
   * @param {{x,y,z}} dir  unit, SOURCE frame
   * @returns {object|null} the solver's result, plus a flattened wall list
   */
  fire(eye, dir) {
    const weapon = this.getWeapon();
    if (!weapon || !this.world || weapon.grenade || weapon.melee) return null;
    const out = fireBullet({ src: eye, dir, weapon, world: this.world, hitTargets: this.hitTargets });

    // What it broke on the way. The damage used is what the solver had left at
    // that impact, so a pane at the end of a long shot through concrete takes
    // less than one at point blank — which is the same rule a player takes.
    const broken = [];
    const carved = [];
    for (const im of out.impacts) {
      // A door arrives as a mover rather than a BVH triangle, and a round
      // CARVES it rather than damaging it: the hole grows where the shots
      // land. Everything else takes the damage and breaks.
      const hit = this.interactives
        ? this.interactives.hit(im.triangle, im.damage, 'bullets', im.interactive || null, im.local || null)
        : null;
      if (hit && hit.broken) broken.push(hit);
      else if (hit) carved.push(hit);
      // The mark it leaves. A pane it SMASHED gets nothing — there is no
      // surface left to put a hole in — but a pane it merely cracked, and
      // every wall it went through, does. The direction rides along because a
      // bullet that came in flat leaves a smear rather than a hole.
      if (this.onImpact && !(hit && hit.broken)) {
        this.onImpact({ point: im.point, normal: im.normal, surface: im.surface, dir, damage: im.damage });
      }
    }

    const walls = out.impacts
      .filter((i) => i.penetrated && i.exit)
      .map((i) => ({ surface: i.surface, thickness: i.exit.thickness, damage: i.damage }));
    const shot = { ...out, walls, broken, carved, weapon: weapon.name, dir };
    if (this.traces) this._draw(eye, dir, out);
    this.onShot(shot);
    return shot;
  }

  /**
   * The path, as yellow through air and red inside a wall.
   *
   * Two LineSegments, built once: a new Line + LineBasicMaterial per segment
   * compiled a WebGPU pipeline on every shot and froze the spray.
   */
  _draw(eye, dir, out) {
    const pts = [];
    let from = eye;
    for (const im of out.impacts) {
      pts.push({ a: from, b: im.point, solid: false });
      if (!im.penetrated || !im.exit) {
        from = null;
        break;
      }
      pts.push({ a: im.point, b: im.exit.point, solid: true });
      from = im.exit.point;
    }
    // The tail after the last wall it came out of, up to wherever the solver
    // says the bullet actually stopped.
    if (from && out.end) pts.push({ a: from, b: out.end, solid: false });
    this._ensure();
    for (const seg of pts) {
      const a = sourceToScene(seg.a.x, seg.a.y, seg.a.z);
      const b = sourceToScene(seg.b.x, seg.b.y, seg.b.z);
      this.lines.push({ a, b, solid: seg.solid, age: 0 });
    }
    while (this.lines.length > TRACE_MAX) this.lines.shift();
    this._rebuild();
  }

  _ensure() {
    if (this._air) return;
    const make = (depthTest) => {
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(TRACE_VERTS * 3), 3);
      const col = new THREE.BufferAttribute(new Float32Array(TRACE_VERTS * 3), 3);
      pos.setUsage(THREE.DynamicDrawUsage);
      col.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      geo.setAttribute('color', col);
      geo.setDrawRange(0, 0);
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest
      });
      const line = new THREE.LineSegments(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 2;
      this.root.add(line);
      return { geo, mat, line, pos, col };
    };
    this._air = make(false);
    this._through = make(true);
  }

  _rebuild() {
    if (!this._air) return;
    const write = (batch, solid) => {
      const P = batch.pos.array;
      const C = batch.col.array;
      const rgb = solid ? THROUGH : AIR;
      let n = 0;
      for (const e of this.lines) {
        if (e.solid !== solid) continue;
        if (n >= TRACE_VERTS) break;
        const fade = (1 - e.age / TRACE_SECONDS) * (solid ? 1 : 0.7);
        const o = n * 3;
        P[o] = e.a[0];
        P[o + 1] = e.a[1];
        P[o + 2] = e.a[2];
        P[o + 3] = e.b[0];
        P[o + 4] = e.b[1];
        P[o + 5] = e.b[2];
        for (let k = 0; k < 6; k++) C[o + k] = rgb[k % 3] * fade;
        n += 2;
      }
      batch.pos.needsUpdate = true;
      batch.col.needsUpdate = true;
      batch.geo.setDrawRange(0, n);
    };
    write(this._air, false);
    write(this._through, true);
  }

  update(dt) {
    if (!this.traces) return;
    if (!this.lines.length) return;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const e = this.lines[i];
      e.age += dt;
      if (e.age >= TRACE_SECONDS) this.lines.splice(i, 1);
    }
    this._rebuild();
  }

  clear() {
    this.lines.length = 0;
    this._rebuild();
  }

  dispose() {
    this.clear();
    for (const batch of [this._air, this._through]) {
      if (!batch) continue;
      batch.line.removeFromParent();
      batch.geo.dispose();
      batch.mat.dispose();
    }
    this._air = this._through = null;
    this.root.removeFromParent();
  }
}
