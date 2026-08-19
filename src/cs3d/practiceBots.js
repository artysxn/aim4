// ---------------------------------------------------------------------------
// src/cs3d/practiceBots.js
// Frozen practice dummies on the map explorer. J plants one at your feet, H
// plants one and stands you on it, K deletes whoever is under the crosshair.
// They wear the other side's agent model, hold still, and come back at the
// same origin and view they had when they died.
//
// Collision is a standing hull so H is a real boost, not a teleport into air
// that falls through. Hits are an AABB, not the packed bone capsules: a dummy
// that never moves does not need them, and the solver already stops a bullet
// on the first player (shared/sim3d/penetration.js hitTargets).
// ---------------------------------------------------------------------------

import { sourceToScene, sceneToSource, sourceYawFromCamera, HULL } from '../../shared/sim3d/units.js';
import { HULL_HALF_WIDE, HULL_STAND, TICK_DT } from '../../shared/sim3d/constants.js';
import { boxTriangles } from '../../shared/sim3d/hullTrace.js';
import { blastFalloff } from '../../shared/sim3d/interactives.js';

const HEAD_Z = 62;
const CHEST_Z = 40;
const RESPAWN_MS = 2000;
const BOT_HP = 100;

/** The side a dummy wears when you are on `side`. */
export function oppositeSide(side) {
  return side === 'CT' ? 'T' : 'CT';
}

export function hitgroupFromHeight(localZ) {
  if (localZ >= HEAD_Z) return 'head';
  if (localZ >= CHEST_Z) return 'chest';
  return 'legs';
}

/**
 * First hit of a Source-frame segment against an AABB. `t` is 0..1 along
 * `from` → `to`. Null when it misses.
 */
export function rayAabb(from, to, min, max) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  let t0 = 0;
  let t1 = 1;
  const p = [from.x, from.y, from.z];
  const d = [dx, dy, dz];
  const lo = [min.x, min.y, min.z];
  const hi = [max.x, max.y, max.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-8) {
      if (p[k] < lo[k] || p[k] > hi[k]) return null;
      continue;
    }
    let a = (lo[k] - p[k]) / d[k];
    let b = (hi[k] - p[k]) / d[k];
    if (a > b) {
      const s = a;
      a = b;
      b = s;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return null;
  }
  if (t0 < 0 || t0 > 1) return null;
  const dist = Math.hypot(dx, dy, dz) * t0;
  return {
    t: t0,
    distance: dist,
    point: { x: from.x + dx * t0, y: from.y + dy * t0, z: from.z + dz * t0 }
  };
}

export function botBox(origin) {
  return {
    min: { x: origin.x - HULL_HALF_WIDE, y: origin.y - HULL_HALF_WIDE, z: origin.z },
    max: { x: origin.x + HULL_HALF_WIDE, y: origin.y + HULL_HALF_WIDE, z: origin.z + HULL_STAND }
  };
}

/** Source-frame pose of the explorer: walk uses the sim, fly drops feet under the camera. */
export function poseFromPlayer(player) {
  if (player.mode === 'walk' && player.sim) {
    return {
      origin: { x: player.sim.pos.x, y: player.sim.pos.y, z: player.sim.pos.z },
      yaw: sourceYawFromCamera(player.yaw),
      pitch: -player.pitch * (180 / Math.PI)
    };
  }
  const cam = player.camera.position;
  const src = sceneToSource(cam.x, cam.y - HULL.standEye, cam.z);
  return {
    origin: { x: src[0], y: src[1], z: src[2] },
    yaw: sourceYawFromCamera(player.yaw),
    pitch: -player.pitch * (180 / Math.PI)
  };
}

/** Scene feet to stand on a dummy at `origin`. */
export function boostFeet(origin) {
  const [x, y, z] = sourceToScene(origin.x, origin.y, origin.z + HULL_STAND);
  return { x, y, z };
}

function weaponFor(side) {
  return side === 'CT' ? 'm4a1_silencer' : 'ak47';
}

export class PracticeBots {
    /**
     * @param {object} o
     * @param {import('./playerModels.js').PlayerModels} o.playerModels
     * @param {() => import('three').Object3D|null} o.getRoot
     * @param {(bot: object) => void} [o.onDied]
     */
  constructor({ playerModels, getRoot, onDied } = {}) {
    this.playerModels = playerModels;
    this.getRoot = getRoot;
    this.onDied = onDied || null;
    this.list = [];
    this._nextId = 1;
    this._tris = [];
  }

  get count() {
    return this.list.length;
  }

  alive() {
    return this.list.filter((b) => b.alive);
  }

  /**
   * Plant a frozen dummy at the explorer. `boost` also returns the scene feet
   * to teleport onto its head.
   */
  place(player, side, { boost = false } = {}) {
    const pose = poseFromPlayer(player);
    const botSide = oppositeSide(side);
    const bot = {
      id: this._nextId++,
      side: botSide,
      origin: { ...pose.origin },
      yaw: pose.yaw,
      pitch: pose.pitch,
      hp: BOT_HP,
      alive: true,
      respawnAt: 0,
      weapon: weaponFor(botSide),
      body: null
    };
    this.list.push(bot);
    this._ensureBody(bot);
    this._poseBody(bot, 0);
    return boost ? { bot, feet: boostFeet(bot.origin), yaw: player.yaw, pitch: player.pitch } : { bot };
  }

  remove(id) {
    const i = this.list.findIndex((b) => b.id === id);
    if (i < 0) return false;
    this.list[i].body?.dispose();
    this.list.splice(i, 1);
    return true;
  }

  /** Closest dummy the Source-frame segment hits, or null. */
  aimHit(from, to, { dead = false } = {}) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.list) {
      if (!dead && !b.alive) continue;
      const box = botBox(b.origin);
      const hit = rayAabb(from, to, box.min, box.max);
      if (!hit || hit.distance >= bestD) continue;
      bestD = hit.distance;
      best = { bot: b, ...hit, group: hitgroupFromHeight(hit.point.z - b.origin.z) };
    }
    return best;
  }

  /** penetration.js `hitTargets`: first live dummy on the segment. */
  hitTargets(from, to) {
    const hit = this.aimHit(from, to);
    if (!hit) return null;
    return {
      id: hit.bot.id,
      group: hit.group,
      distance: hit.distance,
      point: hit.point,
      armor: 0
    };
  }

  /** Delete the dummy under the crosshair. */
  deleteAimed(from, to) {
    const hit = this.aimHit(from, to, { dead: true });
    if (!hit) return null;
    this.remove(hit.bot.id);
    return hit.bot.id;
  }

  hurt(id, damage) {
    const b = this.list.find((x) => x.id === id);
    if (!b || !b.alive) return b?.hp ?? 0;
    b.hp = Math.max(0, b.hp - damage);
    if (b.hp <= 0) {
      b.alive = false;
      b.respawnAt = performance.now() + RESPAWN_MS;
      if (b.body) b.body.set({ alive: false });
      this.onDied?.(b);
    }
    return b.hp;
  }

  blast(pos, radius, maxDmg) {
    for (const b of this.list) {
      if (!b.alive) continue;
      const d = Math.hypot(pos.x - b.origin.x, pos.y - b.origin.y, pos.z - (b.origin.z + HULL.standEye));
      const fall = blastFalloff(d, radius);
      if (fall > 0) this.hurt(b.id, maxDmg * fall);
    }
  }

  overlay(id) {
    const b = this.list.find((x) => x.id === id);
    if (!b) return null;
    return {
      hp: b.alive ? b.hp : 0,
      dead: !b.alive,
      side: b.side,
      money: 0,
      held: b.weapon,
      primary: b.weapon,
      pistol: '',
      knife: 'knife',
      nades: [],
      clip: '',
      reserve: '',
      roundKills: 0,
      name: 'Bot',
      x: b.origin.x,
      y: b.origin.y,
      z: b.origin.z,
      yaw: b.yaw
    };
  }

  update(dt) {
    const now = performance.now();
    for (const b of this.list) {
      if (!b.alive && b.respawnAt && now >= b.respawnAt) {
        b.alive = true;
        b.hp = BOT_HP;
        b.respawnAt = 0;
      }
      this._ensureBody(b);
      this._poseBody(b, dt);
    }
  }

  /**
   * Standing hulls for the walk tracer, scene-frame triangles. Same contract
   * as interactives.movers.emit.
   */
  emitWalk(minX, minY, minZ, maxX, maxY, maxZ, visit) {
    for (const b of this.list) {
      if (!b.alive) continue;
      const o = b.origin;
      const mins = [o.x - HULL_HALF_WIDE, o.y - HULL_HALF_WIDE, o.z];
      const maxs = [o.x + HULL_HALF_WIDE, o.y + HULL_HALF_WIDE, o.z + HULL_STAND];
      const sMinX = mins[0];
      const sMaxX = maxs[0];
      const sMinY = mins[2];
      const sMaxY = maxs[2];
      const sMinZ = -maxs[1];
      const sMaxZ = -mins[1];
      if (sMaxX < minX || sMinX > maxX || sMaxY < minY || sMinY > maxY || sMaxZ < minZ || sMinZ > maxZ)
        continue;
      this._tris.length = 0;
      boxTriangles(mins, maxs, this._tris);
      for (let i = 0; i < this._tris.length; i += 9) {
        visit(
          this._tris[i],
          this._tris[i + 1],
          this._tris[i + 2],
          this._tris[i + 3],
          this._tris[i + 4],
          this._tris[i + 5],
          this._tris[i + 6],
          this._tris[i + 7],
          this._tris[i + 8]
        );
      }
    }
  }

  _ensureBody(bot) {
    if (bot.body || !this.playerModels?.ready) return;
    const root = this.getRoot?.();
    if (!root) return;
    bot.body = this.playerModels.createBody(bot.side);
    root.add(bot.body.group);
  }

  _poseBody(bot, dt) {
    const body = bot.body;
    if (!body) return;
    body.set({
      speed: 0,
      moveYaw: bot.yaw,
      viewYaw: bot.yaw,
      pitch: bot.pitch,
      duck: 0,
      airborne: false,
      weapon: bot.weapon,
      alive: bot.alive
    });
    const [x, y, z] = sourceToScene(bot.origin.x, bot.origin.y, bot.origin.z);
    body.group.position.set(x, y, z);
    if (bot.alive) body.update(dt);
  }

  dispose() {
    for (const b of this.list) b.body?.dispose();
    this.list.length = 0;
  }
}

export { RESPAWN_MS, BOT_HP, TICK_DT };
