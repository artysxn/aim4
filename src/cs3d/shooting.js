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
const TRACE_SECONDS = 4;
/** How many paths are kept before the oldest is dropped. */
const TRACE_MAX = 24;

const AIR = 0xffe08a;
const THROUGH = 0xff5a3c;

export class Shooting {
  /**
   * @param {object} o
   * @param {() => object|null} o.getWeapon      the weapons-pack row in hand
   * @param {import('./interactives.js').Interactives} [o.interactives]
   * @param {(shot: object) => void} [o.onShot]
   * @param {boolean} [o.traces]                 draw the path
   */
  constructor({ getWeapon, interactives = null, onShot = null, traces = true } = {}) {
    this.getWeapon = getWeapon || (() => null);
    this.interactives = interactives;
    this.onShot = onShot || (() => {});
    this.traces = traces;
    this.root = new THREE.Group();
    this.root.name = 'bullets';
    this.world = null;
    this.lines = [];
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  /** The map's collision, as a BULLET sees it (src/cs3d/rayWorld.js). */
  setCollider(collider, movers = null) {
    this.movers = movers || this.movers || null;
    this.world = collider ? createRayWorld(collider, this.movers) : null;
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
    const out = fireBullet({ src: eye, dir, weapon, world: this.world });

    // What it broke on the way. The damage used is what the solver had left at
    // that impact, so a pane at the end of a long shot through concrete takes
    // less than one at point blank — which is the same rule a player takes.
    const broken = [];
    const carved = [];
    if (this.interactives) {
      for (const im of out.impacts) {
        // A door arrives as a mover rather than a BVH triangle, and a round
        // CARVES it rather than damaging it: the hole grows where the shots
        // land. Everything else takes the damage and breaks.
        const hit = this.interactives.hit(im.triangle, im.damage, 'bullets', im.interactive || null, im.local || null);
        if (hit && hit.broken) broken.push(hit);
        else if (hit) carved.push(hit);
      }
    }

    const walls = out.impacts
      .filter((i) => i.penetrated && i.exit)
      .map((i) => ({ surface: i.surface, thickness: i.exit.thickness, damage: i.damage }));
    const shot = { ...out, walls, broken, carved, weapon: weapon.name };
    if (this.traces) this._draw(eye, dir, out);
    this.onShot(shot);
    return shot;
  }

  /**
   * The path, as one line per segment: yellow through air, red inside a wall.
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
    for (const seg of pts) {
      const a = sourceToScene(seg.a.x, seg.a.y, seg.a.z);
      const b = sourceToScene(seg.b.x, seg.b.y, seg.b.z);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b], 3));
      const mat = new THREE.LineBasicMaterial({
        color: seg.solid ? THROUGH : AIR,
        transparent: true,
        opacity: seg.solid ? 1 : 0.7,
        depthWrite: false,
        depthTest: !seg.solid
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 2;
      this.root.add(line);
      this.lines.push({ line, age: 0 });
    }
    while (this.lines.length > TRACE_MAX * 3) this._drop(0);
  }

  _drop(i) {
    const e = this.lines[i];
    if (!e) return;
    e.line.removeFromParent();
    e.line.geometry.dispose();
    e.line.material.dispose();
    this.lines.splice(i, 1);
  }

  update(dt) {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const e = this.lines[i];
      e.age += dt;
      if (e.age >= TRACE_SECONDS) {
        this._drop(i);
        continue;
      }
      e.line.material.opacity = (1 - e.age / TRACE_SECONDS) * (e.line.material.depthTest ? 0.7 : 1);
    }
  }

  clear() {
    while (this.lines.length) this._drop(0);
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}
