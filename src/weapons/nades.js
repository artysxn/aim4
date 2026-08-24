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
import { SMOKE_RADIUS, SMOKE_SECONDS, SMOKE_SQUAT } from '../../shared/sim3d/smokeVolume.js';
import {
  HE_RADIUS,
  HE_DAMAGE,
  FIRE_RANGE,
  FIRE_RANGE_INC,
  FIRE_SECONDS,
  FIRE_SECONDS_INC,
  FIRE_DPS,
  TRAIL_COLOR
} from '../../shared/sim3d/nadeStats.js';
import { U_PER_M } from '../utils/simWorld.js';

export { HE_RADIUS, HE_DAMAGE, FIRE_DPS };

/** Metres, for the renderer. The sim's own numbers are units. */
const HE_RADIUS_M = HE_RADIUS * UNIT_M;
const SMOKE_RADIUS_M = SMOKE_RADIUS * UNIT_M;

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
 * Is a segment blocked by a smoke? Smoke is wider than it is tall
 * (SMOKE_SQUAT), so the test runs in a space where the ellipsoid is a sphere.
 *
 * The explorer answers this out of a marched volume that knows about the walls
 * it grew against (shared/sim3d/smokeVolume.js `smokeBlocks`). This is the
 * shape without the walls: same radius, same squash, but it does not pour down
 * a stairwell or stop at a doorframe.
 */
function segmentHitsSmoke(ax, ay, az, bx, by, bz, cx, cy, cz, r) {
  const s = SMOKE_SQUAT;
  const px = ax - cx;
  const py = (ay - cy) * s;
  const pz = az - cz;
  const dx = bx - ax;
  const dy = (by - ay) * s;
  const dz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < 1e-9) return px * px + py * py + pz * pz <= r * r;
  let t = -(px * dx + py * dy + pz * dz) / dd;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px + dx * t;
  const qy = py + dy * t;
  const qz = pz + dz * t;
  return qx * qx + qy * qy + qz * qz <= r * r;
}

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

    /** The map practice mode's projectile system, on the trainer's renderer. */
    this.flights = new Projectiles({ assets: null, onDetonate: (d) => this._detonate(d) });
    this.flights.attach(root);

    this.ammo = {};
    this.smokes = [];
    this.fires = [];
    this._flash = null;
    this._blast = null;
    this._materials = new Map();
    this._ball = new THREE.SphereGeometry(1, 16, 12);

    this.throwControl = new ThrowControl({
      jumpState: () =>
        this.engine.player?.jumpState?.() || { secondsSinceJump: Infinity, jumpHeldOnGround: false },
      onThrow: (t) => this._release(t)
    });

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

  _material(color, opacity) {
    const key = `${color}:${opacity}`;
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      this._materials.set(key, m);
    }
    return m;
  }

  // ---- the frame ----------------------------------------------------------

  update(dt) {
    this.throwControl.update(dt);
    this.flights.update(dt);
    this._stepSmokes(dt);
    this._stepFires(dt);
    this._stepBlast(dt);
    this._stepFlash();
  }

  /**
   * A flight ended. `pos` and `vel` are Source units, the frame the sim works
   * in; everything drawn below is metres.
   */
  _detonate({ type, pos: src }) {
    const pos = { x: src.x * UNIT_M, y: src.z * UNIT_M, z: -src.y * UNIT_M };
    if (type === 'hegrenade') {
      this._blast = { pos, t: 0, dur: 0.28, mesh: null };
      this.onBlast?.({ pos, radius: HE_RADIUS_M, damage: HE_DAMAGE });
      return;
    }
    if (type === 'flashbang') {
      this._flashPlayer(src);
      this.onFlashBang?.({ pos });
      return;
    }
    if (type === 'smokegrenade') {
      const mesh = new THREE.Mesh(this._ball, this._material(TRAIL_COLOR.smokegrenade, 0.9).clone());
      mesh.frustumCulled = false;
      // A cloud sits on the ground and rises; the centre is half its own height
      // up from where the canister came to rest.
      const centre = { x: pos.x, y: pos.y + SMOKE_RADIUS_M / SMOKE_SQUAT * 0.5, z: pos.z };
      mesh.position.set(centre.x, centre.y, centre.z);
      this.root.add(mesh);
      this.smokes.push({ pos: centre, mesh, t: 0, r: SMOKE_RADIUS_M, alpha: 0 });
      return;
    }
    if (isFireGrenade(type)) {
      const inc = type === 'incgrenade';
      const r = (inc ? FIRE_RANGE_INC : FIRE_RANGE) * UNIT_M;
      const life = inc ? FIRE_SECONDS_INC : FIRE_SECONDS;
      const mesh = new THREE.Mesh(this._ball, this._material(TRAIL_COLOR.molotov, 0.45).clone());
      mesh.frustumCulled = false;
      mesh.scale.set(r, r * 0.35, r);
      mesh.position.set(pos.x, pos.y + r * 0.2, pos.z);
      this.root.add(mesh);
      this.fires.push({ pos, mesh, t: 0, r, life });
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

  _stepBlast(dt) {
    const b = this._blast;
    if (!b) return;
    b.t += dt;
    const k = Math.min(1, b.t / b.dur);
    if (!b.mesh) {
      b.mesh = new THREE.Mesh(this._ball, this._material(TRAIL_COLOR.hegrenade, 0.5).clone());
      b.mesh.frustumCulled = false;
      b.mesh.position.set(b.pos.x, b.pos.y, b.pos.z);
      this.root.add(b.mesh);
    }
    b.mesh.scale.setScalar(HE_RADIUS_M * (0.25 + 0.75 * k));
    b.mesh.material.opacity = 0.5 * (1 - k);
    if (k >= 1) {
      b.mesh.material.dispose();
      b.mesh.removeFromParent();
      this._blast = null;
    }
  }

  _stepSmokes(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.t += dt;
      // Bloom in, hold, fade at the end — the shape SMOKE_BLOOM / SMOKE_FADE
      // describe, without the volume that fills a room properly.
      const inK = Math.min(1, s.t / 1.4);
      const outK = Math.max(0, Math.min(1, (s.t - (SMOKE_SECONDS - 1.6)) / 1.6));
      s.alpha = inK * (1 - outK);
      s.mesh.material.opacity = 0.92 * s.alpha;
      s.mesh.scale.set(s.r * inK, (s.r / SMOKE_SQUAT) * inK, s.r * inK);
      if (s.t >= SMOKE_SECONDS) {
        s.mesh.material.dispose();
        s.mesh.removeFromParent();
        this.smokes.splice(i, 1);
      }
    }
  }

  _stepFires(dt) {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      const outK = Math.max(0, Math.min(1, (f.t - (f.life - 1)) / 1));
      f.mesh.material.opacity = 0.45 * (1 - outK);
      this.onBurn?.({ pos: f.pos, radius: f.r, dps: FIRE_DPS, dt });
      if (f.t >= f.life) {
        f.mesh.material.dispose();
        f.mesh.removeFromParent();
        this.fires.splice(i, 1);
      }
    }
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
    for (const s of this.smokes) {
      if (s.alpha < 0.35) continue;
      const r = s.r * Math.min(1, s.t / 1.4);
      if (segmentHitsSmoke(ax, ay, az, bx, by, bz, s.pos.x, s.pos.y, s.pos.z, r)) return true;
    }
    return false;
  }

  /** Everything gone: scenario unload, restart, or the player died. */
  clear() {
    this.cancel();
    this.flights.clear();
    for (const s of this.smokes) {
      s.mesh.material.dispose();
      s.mesh.removeFromParent();
    }
    this.smokes.length = 0;
    for (const f of this.fires) {
      f.mesh.material.dispose();
      f.mesh.removeFromParent();
    }
    this.fires.length = 0;
    if (this._blast?.mesh) {
      this._blast.mesh.material.dispose();
      this._blast.mesh.removeFromParent();
    }
    this._blast = null;
    this._flash = null;
    this.engine.setFlashOverlay?.(0);
  }

  dispose() {
    this.clear();
    this.flights.dispose();
    this._ball.dispose();
    for (const m of this._materials.values()) m.dispose();
    this._materials.clear();
  }
}
