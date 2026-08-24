// ---------------------------------------------------------------------------
// doorsPlayback.js
// One recorded CT round, played back inside the Doors gamemode.
//
// The data is a stored round exactly as the replay library keeps it: the meta
// (players, events, sides) plus the fixed-width tick buffer
// (src/replays/shared/tickFormat.js). Nothing is re-simulated — the chosen CT
// bots are POSED from the ticks every frame, their grenades fly the recorded
// path and detonate where the demo says they did, and their shots play as a
// muzzle sound plus a tracer along the recorded view angles. A re-sim would
// only ever be a guess that disagrees with what the round actually looked
// like; the recording is the truth and the playhead just walks it.
//
// The playhead runs forward only, in real time, from the freeze end. That is
// the whole difference from the 3D viewer's DemoNades/DemoView machinery,
// which must survive scrubbing and therefore derives everything from the
// playhead each frame. Here a round is watched once and then thrown away, so
// effects age by dt like everything else in the trainer.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js?three-webgl';
import { sharedWeaponAssets } from '../agents/weaponAssets.js';
import {
  readHeader,
  HEADER_BYTES,
  RECORD_BYTES,
  TICK_BYTES,
  POS_SCALE,
  ANGLE_SCALE,
  DUCK_SHIFT,
  DUCK_MAX,
  SIDE_MASK,
  FLAG_ALIVE,
  FLAG_AIRBORNE
} from '../replays/shared/tickFormat.js';
import { UNIT_M, DEG, sourceAnglesToForward } from '../../shared/sim3d/units.js';
import { TRAIL_COLOR } from '../../shared/sim3d/nadeStats.js';
import { bareWeapon, isGrenade, isKnife } from '../replays/viewer/equipmentIcons.js';
import { worldImpactNormal } from '../utils/bulletImpact.js';

/** A tracer with nothing to stop it ends this far out (metres). */
const SHOT_MISS_DEPTH = 150;

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _ray = new THREE.Raycaster();

/** Source (x, y, z units) → the trainer's metres, y-up. */
export function sourceToTrainer(x, y, z) {
  return [x * UNIT_M, z * UNIT_M, -y * UNIT_M];
}

/** Source yaw (degrees) → rotation.y for a bot whose forward is +z at zero. */
export function botYawFromSource(yawDeg) {
  return yawDeg * DEG + Math.PI / 2;
}

/**
 * A stored round's tick buffer, readable by (tick, slot).
 *
 * Rows are fixed-width, so a demo tick maps to a byte offset arithmetically.
 * `sample` interpolates between the two rows around a fractional playhead —
 * at stride 1 that is between two real 64 Hz states, which is exactly the
 * render interpolation the game itself does.
 */
export class RoundTicks {
  /** @param {ArrayBuffer} buffer  a tickFormat v1 buffer, stride 1 */
  constructor(buffer) {
    this.header = readHeader(new DataView(buffer));
    this.dv = new DataView(buffer);
  }

  get tickRate() {
    return this.header.tickRate || 64;
  }

  /** Clamped row index for a demo tick. */
  rowFor(tick) {
    const r = Math.floor((tick - this.header.firstTick) / this.header.stride);
    return Math.max(0, Math.min(this.header.tickCount - 1, r));
  }

  /** One slot's raw record at a row. Source units and degrees. */
  state(row, slot) {
    const at = HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
    const dv = this.dv;
    const flags = dv.getUint8(at + 13);
    const sideDuck = dv.getUint8(at + 15);
    return {
      x: dv.getInt16(at, true) / POS_SCALE,
      y: dv.getInt16(at + 2, true) / POS_SCALE,
      z: dv.getInt16(at + 4, true) / POS_SCALE,
      yaw: dv.getInt16(at + 6, true) / ANGLE_SCALE,
      pitch: dv.getInt16(at + 8, true) / ANGLE_SCALE,
      health: dv.getUint8(at + 10),
      weapon: dv.getUint8(at + 12),
      alive: (flags & FLAG_ALIVE) !== 0,
      airborne: (flags & FLAG_AIRBORNE) !== 0,
      side: sideDuck & SIDE_MASK,
      duck: ((sideDuck >> DUCK_SHIFT) & 0x0f) / DUCK_MAX
    };
  }

  /** One slot's state at a fractional demo tick, interpolated. */
  sample(tick, slot) {
    const r0 = this.rowFor(Math.floor(tick));
    const r1 = Math.min(this.header.tickCount - 1, r0 + 1);
    const a = this.state(r0, slot);
    if (r1 === r0) return a;
    const b = this.state(r1, slot);
    // A death or a teleport between two rows is not something to slide through.
    if (!a.alive || !b.alive) return a;
    const t0 = this.header.firstTick + r0 * this.header.stride;
    const t = Math.max(0, Math.min(1, (tick - t0) / this.header.stride));
    const dyaw = ((b.yaw - a.yaw + 540) % 360) - 180;
    const dpitch = b.pitch - a.pitch;
    return {
      ...a,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      yaw: a.yaw + dyaw * t,
      pitch: a.pitch + dpitch * t,
      duck: a.duck + (b.duck - a.duck) * t,
      airborne: t < 0.5 ? a.airborne : b.airborne
    };
  }
}

/** True for a shot event worth a tracer: a gun, not a pin pull or a knife. */
export function isGunShot(weapon) {
  const b = bareWeapon(weapon);
  if (!b || b === 'c4' || b === 'taser') return false;
  return !isGrenade(b) && !isKnife(b);
}

/**
 * The playback itself. Owns the grenade flights and the shot pointer; the
 * bots (Targets) are the scenario's, handed in as `actors` so the scenario
 * keeps deciding what a hit on one means.
 */
export class DoorsCtPlayback {
  /**
   * @param {object} o
   * @param {THREE.Object3D} o.root      where flight meshes go
   * @param {object} o.meta              the round meta (events, ticks bounds)
   * @param {RoundTicks} o.ticks
   * @param {Array<{slot: number, id: string, target: object}>} o.actors
   *   the drawn CTs; `target` is a bot Target whose `model` takes
   *   `setYaw/setPitch/update(dt, { crouch, onGround })`
   * @param {object|null} o.nades        TrainerNades, for detonation visuals
   * @param {object|null} o.audio        GameAudio, for remote shot cracks
   * @param {object|null} o.viewmodel    Viewmodel, for tracers and impacts
   * @param {THREE.Object3D[]} o.walls   what a played-back bullet can hit
   */
  constructor({ root, meta, ticks, actors, nades = null, audio = null, viewmodel = null, walls = [] }) {
    this.root = root;
    this.meta = meta;
    this.ticks = ticks;
    this.actors = actors;
    this.nades = nades;
    this.audio = audio;
    this.viewmodel = viewmodel;
    this.walls = walls;

    this.tick = meta.freezeEndTick;
    this.endTick = meta.endTick || meta.officialEndTick || Infinity;
    this.done = false;

    const drawn = new Set(actors.map((a) => a.id));
    const after = (t) => Number.isFinite(t) && t >= meta.freezeEndTick - 64;

    // Utility of the drawn CTs only. The hidden A players' smokes appearing
    // out of thin air would read as a bug, not as an off-screen teammate.
    this._grenades = (meta.events?.grenades || [])
      .filter((g) => drawn.has(g.player) && after(g.throwTick) && Array.isArray(g.path) && g.path.length >= 2)
      .sort((a, b) => a.throwTick - b.throwTick);
    this._nextGrenade = 0;
    /** grenade index → { group } while it flies. */
    this._flights = new Map();
    this._ballGeo = new THREE.SphereGeometry(0.05, 10, 8);
    this._ballMats = new Map();

    this._shots = (meta.events?.shots || [])
      .filter((s) => drawn.has(s.player) && after(s.tick) && isGunShot(s.weapon))
      .sort((a, b) => a.tick - b.tick);
    this._nextShot = 0;
  }

  /** The actor record for a Target the scenario's bullet found, or null. */
  actorFor(target) {
    return this.actors.find((a) => a.target === target) || null;
  }

  /** Stop driving one bot (the player killed it; its corpse is the Target's). */
  drop(actor) {
    actor.dead = true;
  }

  /**
   * Advance the playhead. Returns true while the round still has something to
   * show: a live drawn CT, a grenade in flight, or clock left before the
   * round was decided.
   */
  update(dt) {
    if (this.done) return false;
    this.tick += dt * this.ticks.tickRate;

    let liveBots = 0;
    for (const a of this.actors) {
      if (a.dead) continue;
      const s = this.ticks.sample(this.tick, a.slot);
      if (!s.alive) {
        // Died in the demo: the body drops where it dropped. The scenario is
        // not told — a demo death is neither the player's kill nor their miss.
        a.dead = true;
        a.target.startDying(0xffffff);
        continue;
      }
      liveBots++;
      const [x, y, z] = sourceToTrainer(s.x, s.y, s.z);
      a.target.object.position.set(x, y, z);
      const model = a.target.model;
      model.setYaw?.(botYawFromSource(s.yaw));
      model.setPitch?.(-s.pitch * DEG);
      model.update(dt, { crouch: s.duck, onGround: !s.airborne });
    }

    this._updateGrenades(dt);
    this._updateShots();

    if (this.tick >= this.endTick && !this._flights.size) this.done = true;
    if (!liveBots && !this._flights.size) this.done = true;
    return !this.done;
  }

  // ---- grenades -------------------------------------------------------------

  _detTick(g) {
    if (g.detonateTick !== null && g.detonateTick !== undefined) return g.detonateTick;
    return g.path[g.path.length - 1].tick;
  }

  _detPos(g) {
    return g.at || g.path[g.path.length - 1];
  }

  _updateGrenades(dt) {
    // Spawn flights whose throw the playhead just crossed.
    while (this._nextGrenade < this._grenades.length) {
      const g = this._grenades[this._nextGrenade];
      if (g.throwTick > this.tick) break;
      this._flights.set(this._nextGrenade, this._makeFlight(g));
      this._nextGrenade++;
    }

    for (const [i, f] of this._flights) {
      const g = this._grenades[i];
      const det = this._detTick(g);
      if (this.tick >= det) {
        this._detonate(g);
        this._disposeFlight(f);
        this._flights.delete(i);
        continue;
      }
      this._poseFlight(f, g);
    }
  }

  /**
   * The grenade in the air.
   *
   * A blip stands in only until CS2's own model arrives: the weapons pack has
   * one per grenade and it is what a thrown grenade looks like everywhere else
   * in the app, so a recorded smoke should not be the one place it is a dot.
   * The flight is drawn from the recorded waypoints either way — see
   * `_poseFlight` — so a model that never lands costs nothing.
   */
  _makeFlight(g) {
    const color = TRAIL_COLOR[g.type] ?? 0xffffff;
    let mat = this._ballMats.get(color);
    if (!mat) this._ballMats.set(color, (mat = new THREE.MeshBasicMaterial({ color })));
    const group = new THREE.Group();
    const blip = new THREE.Mesh(this._ballGeo, mat);
    blip.frustumCulled = false;
    group.add(blip);
    this.root.add(group);
    const f = { mesh: group, blip, spin: Math.random() * Math.PI * 2 };
    sharedWeaponAssets()
      .model?.(g.type)
      ?.then((template) => {
        if (!template || f.dead) return;
        const m = cloneSkinned(template);
        m.traverse((o) => {
          if (o.isMesh) o.frustumCulled = false;
        });
        // The pack's models are in SOURCE UNITS and this group is placed in the
        // trainer's metres, so without this a grenade is drawn about forty
        // times its own size.
        m.scale.setScalar(UNIT_M);
        group.add(m);
        blip.visible = false;
      })
      .catch(() => {});
    return f;
  }

  _poseFlight(f, g) {
    const path = g.path;
    const head = Math.min(this.tick, this._detTick(g));
    let k = 0;
    while (k + 2 < path.length && path[k + 1].tick <= head) k++;
    const p0 = path[k];
    const p1 = path[Math.min(k + 1, path.length - 1)];
    const span = Math.max(1, p1.tick - p0.tick);
    const t = Math.max(0, Math.min(1, (head - p0.tick) / span));
    const [x, y, z] = sourceToTrainer(
      p0.x + (p1.x - p0.x) * t,
      p0.y + (p1.y - p0.y) * t,
      p0.z + (p1.z - p0.z) * t
    );
    f.mesh.position.set(x, y, z);
    // A thrown grenade tumbles; src/cs3d/projectilesCore.js spins a live one
    // the same way, so a recorded throw should not fly rigid.
    f.spin += 0.28;
    f.mesh.rotation.set(f.spin * 0.7, f.spin, f.spin * 0.4);
  }

  _detonate(g) {
    const at = this._detPos(g);
    if (!at || !this.nades) return;
    this.nades.playbackDetonate({ type: g.type, pos: { x: at.x, y: at.y, z: at.z } });
  }

  /**
   * Detach only. The grenade model is a SkeletonUtils clone that SHARES its
   * geometry and materials with the pack's template; disposing it would empty
   * the pack for every later throw.
   */
  _disposeFlight(f) {
    f.dead = true;
    f.mesh.removeFromParent();
  }

  // ---- shots ----------------------------------------------------------------

  _updateShots() {
    while (this._nextShot < this._shots.length) {
      const s = this._shots[this._nextShot];
      if (s.tick > this.tick) break;
      this._nextShot++;
      const actor = this.actors.find((a) => a.id === s.player);
      if (!actor || actor.dead) continue;
      this._playShot(s);
    }
  }

  _playShot(s) {
    const [x, y, z] = sourceToTrainer(s.x, s.y, s.z);
    _from.set(x, y, z);
    const f = sourceAnglesToForward(s.pitch, s.yaw);
    _dir.set(f[0], f[1], f[2]);

    this.audio?.playRemoteShot(x, y, z);
    if (!this.viewmodel) return;

    let end = null;
    let normal = null;
    if (this.walls.length) {
      _ray.set(_from, _dir);
      _ray.near = 0;
      _ray.far = SHOT_MISS_DEPTH;
      const hits = _ray.intersectObjects(this.walls, false);
      if (hits.length) {
        end = hits[0].point;
        normal = worldImpactNormal(hits[0], _normal);
      }
    }
    if (!end) end = _to.copy(_from).addScaledVector(_dir, SHOT_MISS_DEPTH);
    this.viewmodel.spawnTracer(_from, end);
    if (normal) this.viewmodel.spawnBulletImpact(end, normal, { decal: true });
  }

  dispose() {
    for (const f of this._flights.values()) this._disposeFlight(f);
    this._flights.clear();
    this._ballGeo.dispose();
    for (const m of this._ballMats.values()) m.dispose();
    this._ballMats.clear();
  }
}
