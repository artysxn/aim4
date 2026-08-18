// ---------------------------------------------------------------------------
// src/cs3d/projectiles.js
// Thrown grenades in the world: the entity that owns a flying model, steps
// shared/sim3d/grenade.js at a fixed 64 Hz, and hands the detonation to
// src/cs3d/nadeEffects.js.
//
// The physics lives in shared/sim3d and knows nothing about three.js; this file
// is the body around it. Two things it is careful about:
//
//   The collision set. A grenade is stopped by `grenadeclip` and passes THROUGH
//   `playerclip`, which is the opposite of the player on both counts, so the
//   tracer comes from createHullWorld(collider, 'nade') and not from the one
//   the walking body uses. Getting this wrong is invisible until a nade bounces
//   off nothing in the middle of a doorway.
//
//   Frames. The sim is Source (z up, units); the scene is y-up. Nothing here
//   does that conversion by hand — shared/sim3d/units.js owns it.
//
// Rendering is interpolated: the sim steps 64 times a second and the frame
// draws between the last two states, so a grenade does not stutter at 144 Hz.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createGrenade, stepGrenade, releaseState, GRENADE_SPEC } from '../../shared/sim3d/grenade.js';
import { TICK_DT } from '../../shared/sim3d/constants.js';
import { sourceToScene } from '../../shared/sim3d/units.js';
import { createHullWorld } from './hullWorld.js';

/** How long a flight's trail stays after it goes off, seconds. 0 disables. */
const TRAIL_LINGER = 2.5;
/** Points a trail keeps. A 7-second smoke at 64 Hz is 448 ticks; this thins it. */
const TRAIL_STRIDE = 2;
const TRAIL_MAX = 512;

/** Trail colour per type — the same family the radar and demo view use. */
const TRAIL_COLOR = {
  hegrenade: 0xd8503a,
  flashbang: 0xfff0a8,
  smokegrenade: 0xc8ccd0,
  molotov: 0xe87a28,
  incgrenade: 0xe87a28,
  decoy: 0x7fc46a
};

/**
 * A grenade the world can see. One per thrown projectile; disposed once its
 * effect has finished with it.
 */
class Projectile {
  constructor(type, release, model) {
    this.type = type;
    this.sim = createGrenade(release.pos, release.vel, type);
    /** Previous tick's position, for the render-time interpolation. */
    this.prev = { x: release.pos.x, y: release.pos.y, z: release.pos.z };
    this.group = new THREE.Group();
    this.group.name = `nade:${type}`;
    if (model) this.group.add(model);
    // A thrown grenade tumbles. The axis is fixed at release and the rate
    // follows the release speed, which is what makes a short toss read as a
    // lob and a full throw as a whipped ball.
    const sp = Math.hypot(release.vel.x, release.vel.y, release.vel.z);
    this.spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.spinRate = 0.006 * sp + 4;
    this.spin = 0;
    this.trail = [];
    /** Ticks this projectile has been alive, for the trail's stride. */
    this.ticks = 0;
    this.lastBounces = 0;
    this.age = 0;
    this.done = false;
  }
}

export class Projectiles {
  /**
   * @param {object} o
   * @param {import('./viewModel.js').ViewModelAssets} o.assets  for the models
   * @param {(p: {type, pos, normal, sim}) => void} [o.onDetonate]
   * @param {boolean} [o.trails]  draw the flown path (CS2's sv_grenade_trajectory)
   */
  constructor({ assets, onDetonate, onBounce, trails = true } = {}) {
    this.assets = assets || null;
    this.onDetonate = onDetonate || (() => {});
    /**
     * Every bounce, before anything is drawn: a chance for the world to say
     * that what it hit was breakable and the grenade should have gone THROUGH
     * it. Returns a replacement velocity, or nothing to let the bounce stand.
     */
    this.onBounce = onBounce || (() => null);
    this.trails = trails;
    this.root = new THREE.Group();
    this.root.name = 'projectiles';
    this.world = null;
    this.live = [];
    this._acc = 0;
    this._trailMats = new Map();
    this._pos = new THREE.Vector3();
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  /**
   * The map's collision, as a GRENADE sees it — plus anything that moves, so a
   * nade bounces off a shut door and sails through an open one.
   */
  setCollider(collider, movers = null) {
    this.movers = movers || this.movers || null;
    this.world = collider ? createHullWorld(collider, 'nade', this.movers) : null;
  }

  get count() {
    return this.live.length;
  }

  /**
   * Throw one. Everything about the release — the pitch remap, the speed for
   * the strength, the 1.25 of the thrower's own velocity — is
   * shared/sim3d/grenade.js's business; this only supplies the state.
   *
   * @param {object} o
   * @param {string} o.type
   * @param {{x,y,z}} o.eye        Source frame
   * @param {number} o.yaw         degrees
   * @param {number} o.pitch       degrees, negative up
   * @param {{x,y,z}} [o.velocity] the thrower's, at release
   * @param {number} [o.strength]  0..1
   */
  async spawn({ type, eye, yaw, pitch, velocity = null, strength = 1 }) {
    if (!GRENADE_SPEC[type]) return null;
    const stats = this.assets?.stats?.(type);
    const release = releaseState({
      eye,
      yaw,
      pitch,
      velocity,
      strength,
      // The weapon's own m_flThrowVelocity when the pack carries it; 750 is the
      // value every grenade in the game's table has, so this only matters if
      // that ever stops being true.
      throwVelocity: stats?.throwVelocity || undefined
    });
    const p = new Projectile(type, release, null);
    this.live.push(p);
    this.root.add(p.group);
    this._place(p, 1);
    // The model streams in; the projectile flies with or without it.
    const template = await this.assets?.model?.(type);
    if (template && !p.done) {
      const m = cloneSkinned(template);
      m.traverse((o) => {
        if (o.isMesh) o.frustumCulled = false;
      });
      p.group.add(m);
    }
    return p;
  }

  /**
   * @param {number} dt  frame seconds
   */
  update(dt) {
    if (!this.live.length) return;
    const world = this.world || FLAT;
    this._acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this._acc >= TICK_DT && steps < 16) {
      this._acc -= TICK_DT;
      steps++;
      for (const p of this.live) {
        if (p.done) continue;
        p.prev.x = p.sim.pos.x;
        p.prev.y = p.sim.pos.y;
        p.prev.z = p.sim.pos.z;
        const wasDetonated = p.sim.detonated;
        const bouncesBefore = p.sim.bounces;
        // The velocity going IN. By the time the bounce is visible the sim has
        // already reflected it off the pane, and what a grenade that smashed
        // through a window carries on with is the direction it arrived on.
        _velIn.x = p.sim.vel.x;
        _velIn.y = p.sim.vel.y;
        _velIn.z = p.sim.vel.z;
        stepGrenade(p.sim, world);
        if (p.sim.bounces > bouncesBefore && !p.sim.detonated) {
          const through = this.onBounce({ type: p.type, pos: p.sim.pos, vel: _velIn, sim: p.sim });
          if (through) {
            p.sim.vel.x = Math.fround(through.x);
            p.sim.vel.y = Math.fround(through.y);
            p.sim.vel.z = Math.fround(through.z);
            // It did not bounce, it went through. A molotov ignites on GROUND
            // contact, so a pane it smashed must not count as one.
            p.sim.bounces = bouncesBefore;
            p.sim.hitGround = false;
          }
        }
        p.age += TICK_DT;
        p.ticks++;
        // Every TRAIL_STRIDE ticks, plus every bounce — a corner dropped by the
        // stride is the one point of the path anybody is looking at.
        if (this.trails && p.trail.length < TRAIL_MAX * 3 && !p.sim.detonated) {
          if (p.ticks === 1 || p.ticks % TRAIL_STRIDE === 0 || p.sim.bounces !== p.lastBounces) {
            p.trail.push(...sourceToScene(p.sim.pos.x, p.sim.pos.y, p.sim.pos.z));
            p.lastBounces = p.sim.bounces;
          }
        }
        if (p.sim.detonated && !wasDetonated) this._detonate(p);
      }
    }
    const alpha = this._acc / TICK_DT;
    for (const p of this.live) {
      if (!p.done) {
        this._place(p, alpha);
        p.spin += p.spinRate * dt;
        if (!p.sim.resting) p.group.quaternion.setFromAxisAngle(p.spinAxis, p.spin);
      }
    }
    // Retire finished flights once their trail has faded.
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p.done) continue;
      p.retiring = (p.retiring || 0) + dt;
      if (p.line) p.line.material.opacity = Math.max(0, 1 - p.retiring / TRAIL_LINGER);
      if (p.retiring >= TRAIL_LINGER) {
        this._dispose(p);
        this.live.splice(i, 1);
      }
    }
  }

  _place(p, alpha) {
    const s = p.sim.pos;
    const x = p.prev.x + (s.x - p.prev.x) * alpha;
    const y = p.prev.y + (s.y - p.prev.y) * alpha;
    const z = p.prev.z + (s.z - p.prev.z) * alpha;
    const [sx, sy, sz] = sourceToScene(x, y, z);
    p.group.position.set(sx, sy, sz);
  }

  _detonate(p) {
    p.done = true;
    p.retiring = 0;
    // The model goes with the grenade; the trail outlives it briefly so the
    // line a throw took is readable after it lands.
    p.group.visible = false;
    if (this.trails && p.trail.length >= 6) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p.trail, 3));
      const mat = new THREE.LineBasicMaterial({
        color: TRAIL_COLOR[p.type] ?? 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false
      });
      p.line = new THREE.Line(geo, mat);
      p.line.frustumCulled = false;
      this.root.add(p.line);
    }
    this.onDetonate({
      type: p.type,
      pos: { x: p.sim.pos.x, y: p.sim.pos.y, z: p.sim.pos.z },
      // Which way it was going when it broke. A CS2 molotov spreads downrange
      // rather than symmetrically, so the fire needs this and not just where.
      vel: { x: p.sim.vel.x, y: p.sim.vel.y, z: p.sim.vel.z },
      normal: p.sim.detonateNormal,
      bounces: p.sim.bounces,
      airtime: p.age
    });
  }

  _dispose(p) {
    // Detach only. The model is a SkeletonUtils clone, which SHARES its
    // geometry and materials with the pack's template — disposing them here
    // would empty the template and every grenade thrown after this one would
    // render nothing. Same reason viewModel.js only detaches on a weapon swap.
    p.group.removeFromParent();
    if (p.line) {
      p.line.removeFromParent();
      p.line.geometry.dispose();
      p.line.material.dispose();
    }
  }

  /** Drop everything in flight — a respawn, a map change, a demo load. */
  clear() {
    for (const p of this.live) this._dispose(p);
    this.live.length = 0;
    this._acc = 0;
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }
}

const _velIn = { x: 0, y: 0, z: 0 };

/** Nothing to hit: a grenade thrown before the collision hull arrives. */
const FLAT = {
  traceHull(start, end) {
    return { fraction: 1, endpos: { x: end.x, y: end.y, z: end.z }, normal: null, startSolid: false };
  }
};
