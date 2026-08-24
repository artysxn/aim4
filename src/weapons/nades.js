// ---------------------------------------------------------------------------
// nades.js
// Grenades in the aim trainer, on the map practice mode's own code.
//
// What is SHARED, i.e. literally the same module running in both places:
//
//   the mouse      src/cs3d/throwing.js — the pin, the charge, the three throw
//                  strengths, the 6-tick release animation, the 199 ms
//                  jumpthrow window. Imported, not forked.
//   the flight     src/cs3d/projectilesCore.js over shared/sim3d/grenade.js —
//                  the projectile entity, the fixed 64 Hz step, the render
//                  interpolation, the tumble, the trails, the bounce hook.
//                  Bound to the trainer's WebGL `three` in
//                  src/weapons/trainerNadeFlight.js; the explorer binds the
//                  same core to `three/webgpu`.
//   being flashed  shared/sim3d/flash.js — the radius trace, the facing
//                  multipliers, CS2's own hold-and-fade curve.
//   the numbers    shared/sim3d/nadeStats.js, fireSpread.js, smokeVolume.js —
//                  HE range and damage, molotov range and lifetime, smoke
//                  radius and lifetime, the trail colours.
//
// What is NOT shared, and why. src/cs3d/nadeEffects.js draws the detonations,
// and it is 1,200 lines of WebGPU node materials: TSL graphs, sprite cards, a
// marched smoke volume, a flame sheet off the CDN. The trainer's renderer is
// WebGL. That file cannot run here at all, so the visuals below are the
// trainer's own and deliberately plain — a ball for a smoke, a disc for a fire,
// an expanding shell for a blast. They are stand-ins for the explorer's
// effects, sized and timed by the shared constants so they occupy the same
// space and last the same time as the real ones.
//
// One more difference, in behaviour rather than looks: a ported map carries ONE
// merged collision hull, so a grenade here is stopped by `playerclip` (which
// CS2 lets utility through) and not by `grenadeclip` (which CS2 stops it with).
// See src/weapons/trainerNadeFlight.js.
//
// Ammunition: one of each per life, refilled on respawn. The explorer hands
// them out without limit because it is a place to practise lineups; a gamemode
// is a fight, and infinite HE is not one.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { ThrowControl } from '../cs3d/throwing.js';
import { Projectiles } from './trainerNadeFlight.js';
import { perfectJumpThrowState, isFireGrenade } from '../../shared/sim3d/grenade.js';
import { UNIT_M, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { radiusFlashForPlayer, applyBlind, flashOverlayAlpha } from '../../shared/sim3d/flash.js';
import { SMOKE_CELL } from '../../shared/sim3d/smokeVolume.js';
import {
  HE_RADIUS,
  HE_DAMAGE,
  FIRE_DPS
} from '../../shared/sim3d/nadeStats.js';
import { sharedWeaponAssets } from '../agents/weaponAssets.js';
import { SmokeCloud, FirePatch, BlastFx, warmNadeVisuals } from './nadeVisuals.js';
import { U_PER_M } from '../utils/simWorld.js';

export { HE_RADIUS, HE_DAMAGE, FIRE_DPS };

/** Metres, for the renderer. The sim's own numbers are units. */
const HE_RADIUS_M = HE_RADIUS * UNIT_M;

/** The four the trainer hands out, in the order keys 4-7 select them. */
export const TRAINER_NADES = Object.freeze(['hegrenade', 'flashbang', 'smokegrenade', 'molotov']);

/** HUD labels. The colours are the shared trail colours, not a second set. */
export const NADE_LABEL = Object.freeze({
  hegrenade: 'HE',
  flashbang: 'Flash',
  smokegrenade: 'Smoke',
  molotov: 'Molotov',
  incgrenade: 'Incendiary',
  decoy: 'Decoy'
});

const _fwd = new THREE.Vector3();

/**
 * How far apart a sightline is sampled when asking a cloud whether it is
 * blocked, in Source units. Half a fill cell, so a segment cannot thread
 * between two filled cells and come out the far side reporting clear.
 */
const SMOKE_STEP = SMOKE_CELL * 0.5;

/** Reused by the smoke fill's `solidAt`; it asks thousands of times a throw. */
const _probe = { x: 0, y: 0, z: 0 };

export class TrainerNades {
  /**
   * @param {object} o
   * @param {object} o.engine
   * @param {object} o.input          the InputManager
   * @param {THREE.Object3D} o.root   where the meshes go
   */
  constructor({ engine, input, root } = {}) {
    this.engine = engine;
    this.input = input;
    this.root = root;

    /**
     * Assigned by whichever scenario is running, not passed in: a mode with no
     * bots and no map never sets them, and throwing is then just throwing.
     */
    this.onBlast = null; // ({ pos, radius, damage }) => void
    this.onFlashBang = null; // ({ pos }) => void
    this.onBurn = null; // ({ pos, radius, dps, dt }) => void

    /**
     * The map practice mode's projectile system, on the trainer's renderer.
     *
     * Handed the weapons pack, which is the same shape the explorer's own
     * viewmodel assets are (`model(name)` → a template, `stats(name)` → the
     * weapons.vdata row). That is what puts CS2's actual grenade in the air
     * instead of a coloured blip, and what makes the release speed the
     * weapon's own `m_flThrowVelocity` rather than the 750 default.
     */
    this.flights = new Projectiles({
      assets: sharedWeaponAssets(),
      onDetonate: (d) => this._detonate(d)
    });
    this.flights.attach(root);

    this.ammo = {};
    /** Standing clouds and fires — src/weapons/nadeVisuals.js. */
    this.smokes = [];
    this.fires = [];
    this._flash = null;
    this._blasts = [];

    this.throwControl = new ThrowControl({
      jumpState: () =>
        this.engine.player?.jumpState?.() || { secondsSinceJump: Infinity, jumpHeldOnGround: false },
      onThrow: (t) => this._release(t)
    });

    // The sheets are a megabyte of flipbook and every detonation wants them,
    // so the fetch starts with the thrower rather than with the first throw.
    warmNadeVisuals();
    this.refill();
  }

  /** One of each, on spawn and on respawn. */
  refill() {
    for (const t of TRAINER_NADES) this.ammo[t] = 1;
  }

  /** The world grenades bounce off, from the scenario (src/utils/simWorld.js). */
  setWorld(world) {
    this.flights.setWorld(world);
  }

  get world() {
    return this.flights.world;
  }

  /** The type in hand, or null. */
  get held() {
    return this.throwControl.type;
  }

  /** True while the mouse belongs to a grenade rather than to the gun. */
  get active() {
    return this.throwControl.active;
  }

  /**
   * Put a grenade in hand, or pass null to go back to the gun.
   * @returns {boolean} whether the switch happened (false = none left)
   */
  select(type) {
    if (!type) {
      this.throwControl.setWeapon(null);
      return true;
    }
    if (!(this.ammo[type] > 0)) return false;
    this.throwControl.setWeapon(type);
    return true;
  }

  /** Next type with ammo, for a cycle key. Null when the pocket is empty. */
  cycle() {
    const have = TRAINER_NADES.filter((t) => this.ammo[t] > 0);
    if (!have.length) return null;
    const at = have.indexOf(this.held);
    const next = have[(at + 1) % have.length];
    this.select(next);
    return next;
  }

  /**
   * A mouse button, offered to the grenade first.
   * @returns {boolean} true when it was consumed and the gun must not fire
   */
  button(which, down) {
    return this.throwControl.button(which, down);
  }

  /** Pointer lock lost, scenario over, player died. */
  cancel() {
    this.throwControl.cancel();
  }

  /** What the HUD draws: the charge state, or null. */
  status() {
    return this.throwControl.status();
  }

  // ---- throwing -----------------------------------------------------------

  /**
   * The projectile exists. Where and how fast is entirely the shared release
   * model's answer, including the perfect-jumpthrow latch: a throw released
   * within 199 ms of takeoff flies from where the body was six ticks into the
   * jump, which is the whole reason a jumpthrow is repeatable.
   */
  _release({ type, strength, perfectJumpThrow }) {
    if (!(this.ammo[type] > 0)) return;
    this.ammo[type]--;

    const player = this.engine.player;
    const cam = this.engine.camera;
    const eye = {
      x: cam.position.x * U_PER_M,
      y: -cam.position.z * U_PER_M,
      z: cam.position.y * U_PER_M
    };
    const live = player
      ? { x: player.vel.x * U_PER_M, y: -player.vel.z * U_PER_M, z: player.velY * U_PER_M }
      : null;
    const latch = perfectJumpThrow && player ? perfectJumpThrowState({ eye, vel: live }) : null;

    this.flights.spawn({
      type,
      eye: latch ? latch.eye : eye,
      yaw: sourceYawFromCamera(this.input.yaw),
      pitch: -this.input.pitch * (180 / Math.PI),
      velocity: latch ? latch.velocity : live,
      strength
    });

    // Nothing left of this type: back to the gun rather than holding a pin that
    // will never come out.
    if (!(this.ammo[type] > 0)) this.throwControl.setWeapon(null);
  }

  // ---- the world, as the shared effects want to see it ---------------------

  /**
   * shared/sim3d/smokeVolume.js's `SmokeWorld`.
   *
   * `boxSolid` is the startsolid half of a zero-length trace, which is exactly
   * the fill's question, and it stops at the first triangle that answers it.
   * Identical to src/cs3d/nadeEffects.js `_smokeWorld` — the cloud has to
   * flood the same way in both modes or the same lineup gives two clouds.
   */
  _smokeWorld() {
    const world = this.world;
    if (!world?.boxSolid) return null;
    return {
      solidAt: (x, y, z, half) => {
        _probe.x = x;
        _probe.y = y;
        _probe.z = z - half;
        return world.boxSolid(_probe, half * 0.9, half * 1.8);
      }
    };
  }

  /** ...and shared/sim3d/fireSpread.js's: the ground under a candidate seat. */
  _fireWorld() {
    const world = this.world;
    if (!world?.traceHull) return null;
    return {
      groundAt: (x, y, z) => {
        const t = world.traceHull({ x, y, z: z + 48 }, { x, y, z: z - 112 }, 2, 2);
        if (t.fraction >= 1 || !t.normal || t.normal.z < 0.5) return null;
        return { x: t.endpos.x, y: t.endpos.y, z: t.endpos.z };
      }
    };
  }

  // ---- the frame ----------------------------------------------------------

  update(dt) {
    this.throwControl.update(dt);
    this.flights.update(dt);
    this._step(this.smokes, dt);
    this._stepFires(dt);
    this._step(this._blasts, dt);
    this._stepFlash();
  }

  /**
   * Advance a list of effects, reaping the ones that have finished.
   *
   * The camera goes through because a sprite card is sorted back to front from
   * the eye and lit in view space (src/weapons/spriteCardGL.js `prepare`);
   * without it a cloud of them shows seams wherever two cross.
   */
  _step(list, dt) {
    const cam = this.engine.camera;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].update(dt, cam)) {
        list[i].dispose();
        list.splice(i, 1);
      }
    }
  }

  /**
   * Fires, plus what standing in one costs.
   *
   * `covers` is the puddle's real shape — the seats the spread actually laid,
   * on the schedule they light and go out on — so what burns is what is drawn.
   * `pos` and `radius` stay in the payload as the bounding fallback a caller
   * written before this can keep using.
   */
  _stepFires(dt) {
    const cam = this.engine.camera;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      if (!f.update(dt, cam)) {
        f.dispose();
        this.fires.splice(i, 1);
        continue;
      }
      this.onBurn?.({
        pos: f.centreM,
        radius: f.radiusM,
        dps: FIRE_DPS,
        dt,
        covers: (x, y, z) => f.covers(x * U_PER_M, -z * U_PER_M, y * U_PER_M)
      });
    }
  }

  /**
   * A flight ended. `src` is Source units, the frame the sim and every shared
   * effect works in; only the damage hooks below are handed metres, because
   * that is what the scenarios that read them are in.
   */
  _detonate({ type, pos: src, vel = null }) {
    const pos = { x: src.x * UNIT_M, y: src.z * UNIT_M, z: -src.y * UNIT_M };
    if (type === 'hegrenade') {
      const fx = new BlastFx({ pos: src });
      this.root.add(fx.object);
      this._blasts.push(fx);
      // An HE inside a cloud blows a hole in it that knits shut, the same way
      // it does in map practice — this is the whole reason a cloud is a fill
      // and not a ball.
      for (const s of this.smokes) s.push(src);
      this.onBlast?.({ pos, radius: HE_RADIUS_M, damage: HE_DAMAGE });
      return;
    }
    if (type === 'flashbang') {
      this._flashPlayer(src);
      this.onFlashBang?.({ pos });
      return;
    }
    if (type === 'smokegrenade') {
      const fx = new SmokeCloud({ pos: src, world: this._smokeWorld() });
      this.root.add(fx.object);
      this.smokes.push(fx);
      return;
    }
    if (isFireGrenade(type)) {
      const fx = new FirePatch({ pos: src, dir: vel, type, world: this._fireWorld() });
      this.root.add(fx.object);
      this.fires.push(fx);
    }
  }

  /**
   * Being flashed, by CS2's own model rather than by a guess.
   *
   * `radiusFlashForPlayer` wants the eye, the look direction and a trace, and
   * returns the hold and the fade the overlay runs. The trace is the map hull,
   * which is why a flash behind a wall does nothing and one that clears the
   * corner by a hand's width does everything.
   */
  _flashPlayer(origin) {
    const cam = this.engine.camera;
    cam.getWorldDirection(_fwd);
    const eye = {
      x: cam.position.x * U_PER_M,
      y: -cam.position.z * U_PER_M,
      z: cam.position.y * U_PER_M
    };
    const forward = { x: _fwd.x, y: -_fwd.z, z: _fwd.y };
    const world = this.world;
    const trace = world
      ? (from, to) => {
          // A sightline, so a needle rather than the player's hull: a 32-unit
          // box clipped by a doorframe would call a clear flash blocked.
          const t = world.traceHull(from, to, 0.25, 1);
          return { fraction: t.fraction, endpos: t.endpos };
        }
      : null;
    const res = radiusFlashForPlayer({ origin, eye, forward, trace });
    if (!res) return;
    this._flash = applyBlind(this._flash, res, performance.now() / 1000);
  }

  _stepFlash() {
    if (!this._flash) return;
    const a = flashOverlayAlpha(this._flash, performance.now() / 1000);
    this.engine.setFlashOverlay?.(a);
    if (a <= 0) this._flash = null;
  }

  /** How blind the player is right now, 0..1 — for a HUD or a bot's advantage. */
  get flashAmount() {
    return this._flash ? flashOverlayAlpha(this._flash, performance.now() / 1000) : 0;
  }

  /**
   * A recorded detonation (demo playback in the Doors gamemode): the same
   * standing effect, and the same flash model against the player's own eyes,
   * as a grenade the player threw — just without a flight of ours ending it.
   * `pos` is Source units, straight off the round's event.
   */
  playbackDetonate({ type, pos }) {
    this._detonate({ type, pos });
  }

  // ---- what the scenario asks ----------------------------------------------

  /**
   * Does smoke block this sightline? Metres, the trainer's frame.
   *
   * The bots' line-of-sight and the spawn picker both come through here, so a
   * bot holding an angle through a smoke stops holding it — which is the only
   * reason a smoke is worth throwing at something that shoots back.
   */
  smokeBlocks(ax, ay, az, bx, by, bz) {
    if (!this.smokes.length) return false;
    // Metres → the Source frame every cloud is filled in.
    const x0 = ax * U_PER_M;
    const y0 = -az * U_PER_M;
    const z0 = ay * U_PER_M;
    const dx = bx * U_PER_M - x0;
    const dy = -bz * U_PER_M - y0;
    const dz = by * U_PER_M - z0;
    const len = Math.hypot(dx, dy, dz);
    // Walk the line and ask the fill. A sphere test cannot answer this any
    // more: the cloud is whatever shape the room let it be, so the sightline
    // has to be sampled against the cells themselves.
    const steps = Math.max(1, Math.ceil(len / SMOKE_STEP));
    for (const s of this.smokes) {
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (s.blocksPoint(x0 + dx * t, y0 + dy * t, z0 + dz * t)) return true;
      }
    }
    return false;
  }

  /** Everything gone: scenario unload, restart, or the player died. */
  clear() {
    this.cancel();
    this.flights.clear();
    for (const list of [this.smokes, this.fires, this._blasts]) {
      for (const fx of list) fx.dispose();
      list.length = 0;
    }
    this._flash = null;
    this.engine.setFlashOverlay?.(0);
  }

  dispose() {
    this.clear();
    this.flights.dispose();
  }
}
