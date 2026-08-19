// ---------------------------------------------------------------------------
// src/cs3d/droppedWeapons.js
// Guns and grenades on the floor in the map explorer. G and death spawn
// pickups; walking over them or E takes them back. Not live projectiles:
// a dropped grenade is a prop, the pin stays in.
//
// Collision is the WALK hull (playerclip + solid), so a rifle rests where a
// body stands rather than falling through a clip a nade would ignore. Gravity
// and bounce follow the grenade stepper's shape without a fuse.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createHullWorld } from './hullWorld.js';
import { itemByName } from './buyMenu.js';
import { nadeStem } from './practiceMatch.js';
import { sourceToScene } from '../../shared/sim3d/units.js';
import { GRAVITY, TICK_DT } from '../../shared/sim3d/constants.js';
import { USE_RANGE } from '../../shared/sim3d/interactives.js';

/** CS-like toss: look direction, not a teleport onto the feet. */
export const DROP_SPEED = 300;
export const DROP_FORWARD = 24;
export const DROP_UP = 40;
/** Seconds before the dropper can take it back. */
export const PICKUP_DELAY = 0.8;
const WALK_RANGE = 48;
const WALK_Z = 40;
const USE_AIM_RADIUS = 24;
const REST_SPEED = 30;
const REST_NORMAL_Z = 0.7;
const ELASTICITY = 0.35;
const BOUNCE_BACKOFF = 2;
const HULL_WIDE = 4;
const HULL_HEIGHT = 8;

let dropSeq = 1;

const FLAT = {
  traceHull(start, end) {
    return { fraction: 1, endpos: { x: end.x, y: end.y, z: end.z }, normal: null, startSolid: false };
  }
};

/**
 * Release point and velocity for a CS-like drop, Source frame.
 *
 * @param {object} o
 * @param {{x:number,y:number,z:number}} o.eye
 * @param {number} o.yaw  degrees
 * @param {number} o.pitch  degrees, negative up
 * @param {{x:number,y:number,z:number}} [o.velocity] thrower, Source frame
 * @param {number} [o.spread] extra yaw radians, death piles
 */
export function dropRelease({ eye, yaw, pitch, velocity = null, spread = 0 }) {
  const y = ((yaw || 0) + spread * (180 / Math.PI)) * (Math.PI / 180);
  const p = (pitch || 0) * (Math.PI / 180);
  const cp = Math.cos(p);
  const fx = cp * Math.cos(y);
  const fy = cp * Math.sin(y);
  const fz = -Math.sin(p);
  const k = 0.5;
  return {
    pos: {
      x: eye.x + fx * DROP_FORWARD,
      y: eye.y + fy * DROP_FORWARD,
      z: eye.z + fz * DROP_FORWARD
    },
    vel: {
      x: fx * DROP_SPEED + (velocity ? velocity.x * k : 0),
      y: fy * DROP_SPEED + (velocity ? velocity.y * k : 0),
      z: fz * DROP_SPEED + (velocity ? velocity.z * k : 0) + DROP_UP
    },
    yaw: (yaw || 0) + spread * (180 / Math.PI)
  };
}

export class DroppedWeapons {
  /**
   * @param {object} o
   * @param {import('./viewModel.js').ViewModelAssets} [o.assets]
   */
  constructor({ assets } = {}) {
    this.assets = assets || null;
    this.root = new THREE.Group();
    this.root.name = 'droppedWeapons';
    this.world = null;
    this.live = [];
    this._acc = 0;
    this._pos = new THREE.Vector3();
  }

  attach(parent) {
    if (parent && this.root.parent !== parent) parent.add(this.root);
  }

  setCollider(collider, movers = null) {
    this.movers = movers || this.movers || null;
    this.world = collider ? createHullWorld(collider, 'walk', this.movers) : null;
  }

  get count() {
    return this.live.length;
  }

  /**
   * @param {{name:string, slot?:string, ammo?:{clip:number,reserve:number}|null}} item
   * @param {{pos:{x,y,z}, vel:{x,y,z}, yaw?:number}} toss  Source frame
   */
  spawn(item, toss) {
    if (!item?.name || !toss?.pos) return null;
    const d = {
      id: dropSeq++,
      item: {
        name: item.name,
        slot: item.slot || '',
        ammo: item.ammo ? { clip: item.ammo.clip, reserve: item.ammo.reserve } : null
      },
      pos: { x: toss.pos.x, y: toss.pos.y, z: toss.pos.z },
      vel: { x: toss.vel?.x || 0, y: toss.vel?.y || 0, z: toss.vel?.z || 0 },
      yaw: toss.yaw || 0,
      resting: false,
      pickupAt: performance.now() + PICKUP_DELAY * 1000,
      proxy: false,
      group: new THREE.Group()
    };
    d.group.name = `drop:${d.item.name}`;
    this.live.push(d);
    this.root.add(d.group);
    this._place(d);
    this._loadModel(d);
    return d;
  }

  /** Death pile: same origin, a little yaw fan so they do not occupy one point. */
  spawnMany(items, toss) {
    const n = items?.length || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const spread = n === 1 ? 0 : ((i / (n - 1)) - 0.5) * 0.7;
      const t = dropRelease({
        eye: toss.eye || toss.pos,
        yaw: toss.yaw || 0,
        pitch: toss.pitch || 0,
        velocity: toss.velocity || toss.vel || null,
        spread
      });
      if (toss.feetZ != null) t.pos.z = Math.max(t.pos.z, toss.feetZ + 12);
      out.push(this.spawn(items[i], t));
    }
    return out;
  }

  remove(id) {
    const i = this.live.findIndex((d) => d.id === id);
    if (i < 0) return null;
    const d = this.live[i];
    this._dispose(d);
    this.live.splice(i, 1);
    return d;
  }

  /**
   * Walk-over. `tryTake(drop)` returns true when inventory accepted it.
   * @param {number} dt
   * @param {{x,y,z}|null} feet  Source frame
   * @param {(drop: object) => boolean} tryTake
   */
  update(dt, feet, tryTake) {
    if (this.live.length) {
      const world = this.world || FLAT;
      this._acc += Math.min(dt, 0.25);
      let steps = 0;
      while (this._acc >= TICK_DT && steps < 16) {
        this._acc -= TICK_DT;
        steps++;
        for (const d of this.live) {
          if (!d.resting) stepDropped(d, world);
        }
      }
      for (const d of this.live) this._place(d);
    }
    if (!feet || !tryTake) return;
    const now = performance.now();
    for (let i = this.live.length - 1; i >= 0; i--) {
      const d = this.live[i];
      if (now < d.pickupAt) continue;
      const dx = d.pos.x - feet.x;
      const dy = d.pos.y - feet.y;
      const dz = d.pos.z - feet.z;
      if (dx * dx + dy * dy > WALK_RANGE * WALK_RANGE) continue;
      if (Math.abs(dz) > WALK_Z) continue;
      if (tryTake(d)) this.remove(d.id);
    }
  }

  /**
   * E: the drop under the look ray, within use range.
   * @returns {object|null} the live drop, still in the world until remove()
   */
  tryUse(eye, dir, now = performance.now()) {
    let best = null;
    let bestT = USE_RANGE;
    for (const d of this.live) {
      if (now < d.pickupAt) continue;
      const vx = d.pos.x - eye.x;
      const vy = d.pos.y - eye.y;
      const vz = d.pos.z - eye.z;
      const t = vx * dir.x + vy * dir.y + vz * dir.z;
      if (t < 0 || t > bestT) continue;
      const px = eye.x + dir.x * t - d.pos.x;
      const py = eye.y + dir.y * t - d.pos.y;
      const pz = eye.z + dir.z * t - d.pos.z;
      if (px * px + py * py + pz * pz > USE_AIM_RADIUS * USE_AIM_RADIUS) continue;
      bestT = t;
      best = d;
    }
    return best;
  }

  clear() {
    for (const d of this.live) this._dispose(d);
    this.live.length = 0;
    this._acc = 0;
  }

  dispose() {
    this.clear();
    this.root.removeFromParent();
  }

  _place(d) {
    const [sx, sy, sz] = sourceToScene(d.pos.x, d.pos.y, d.pos.z);
    d.group.position.set(sx, sy + 3, sz);
    d.group.rotation.set(d.item.slot === 'nade' ? 0 : 0.35, (d.yaw || 0) * (Math.PI / 180), 0, 'YXZ');
  }

  async _loadModel(d) {
    const template = await this.assets?.model?.(d.item.name);
    if (!this.live.includes(d)) return;
    if (template) {
      const m = cloneSkinned(template);
      m.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      d.group.add(m);
      d.proxy = false;
      return;
    }
    d.group.add(proxyMesh(d.item.name));
    d.proxy = true;
  }

  _dispose(d) {
    d.group.removeFromParent();
    if (!d.proxy) return;
    d.group.traverse((o) => {
      o.geometry?.dispose?.();
      const mat = o.material;
      if (!mat) return;
      mat.map?.dispose?.();
      mat.dispose?.();
    });
  }
}

function stepDropped(d, world) {
  const grav = GRAVITY;
  d.vel.z -= grav * 0.5 * TICK_DT;
  const end = {
    x: d.pos.x + d.vel.x * TICK_DT,
    y: d.pos.y + d.vel.y * TICK_DT,
    z: d.pos.z + d.vel.z * TICK_DT
  };
  const t = world.traceHull(d.pos, end, HULL_WIDE, HULL_HEIGHT);
  if (t.startSolid) {
    d.pos.z += 4;
    d.vel.z = Math.max(d.vel.z, 40);
    d.vel.z -= grav * 0.5 * TICK_DT;
    return;
  }
  d.pos.x = t.endpos.x;
  d.pos.y = t.endpos.y;
  d.pos.z = t.endpos.z;
  if (t.fraction < 1 && t.normal) {
    const n = t.normal;
    const into = d.vel.x * n.x + d.vel.y * n.y + d.vel.z * n.z;
    if (into < 0) {
      d.vel.x -= n.x * into * BOUNCE_BACKOFF;
      d.vel.y -= n.y * into * BOUNCE_BACKOFF;
      d.vel.z -= n.z * into * BOUNCE_BACKOFF;
    }
    d.vel.x *= ELASTICITY;
    d.vel.y *= ELASTICITY;
    d.vel.z *= ELASTICITY;
    const sp = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
    if (n.z >= REST_NORMAL_Z && sp < REST_SPEED) {
      d.vel.x = d.vel.y = d.vel.z = 0;
      d.resting = true;
    }
  }
  d.vel.z -= grav * 0.5 * TICK_DT;
}

function proxyMesh(name) {
  const g = new THREE.Group();
  const nade = !!nadeStem(name);
  const mesh = new THREE.Mesh(
    nade ? new THREE.SphereGeometry(4, 10, 8) : new THREE.BoxGeometry(16, 3, 5),
    new THREE.MeshLambertMaterial({ color: nade ? 0x6a8f5a : 0x6a6a70 })
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  const label = itemByName(name)?.label || name;
  const sprite = labelSprite(label);
  sprite.position.y = 10;
  g.add(sprite);
  return g;
}

function labelSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2f2';
  ctx.font = '600 28px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text).slice(0, 22), 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(28, 7, 1);
  return s;
}
