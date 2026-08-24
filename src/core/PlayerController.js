// ---------------------------------------------------------------------------
// PlayerController.js
// First-person movement for the player. Since the engines were unified this is
// a body around shared/sim3d/motion.js — Source's CGameMovement pipeline in f32
// at a fixed 64 Hz, in Source units — which is the SAME mover the 3D map
// practice mode walks with (src/cs3d/player.js). One brain, two bodies.
//
// What that buys, and what it replaced. The trainer used to integrate
// SourceMovement.js by hand: friction and accelerate were faithful, and
// everything around them was not. Duck was an exponential ease toward the held
// state; the sim has CS2's duck speed, its spam penalty, its unduck trace and
// the hull swap. Jump was an impulse; the sim has stamina, the bunny-hop cap
// and the two half-tick gravity steps around the move. Ground was a downward
// probe and walls were a circle pushed out of boxes; the sim sweeps the real
// 32x72 hull, steps up 18 units, and slides along planes. None of those is
// exotic — they are just what CS2 does, and a player coming from the map
// practice mode into a gamemode should not feel a different game.
//
// It owns the camera *position* only while enabled; the InputManager still owns
// look (yaw/pitch). Movement-free scenarios (Gridshot / Arena) simply never
// enable it, so the camera stays pinned at the origin. Bounds confine the
// player to a per-scenario box (their cover area in Duels, the 5x5 m box in
// Range) and are applied on top of the sim, because they are a scenario rule
// and not a wall.
//
// Units. Everything this class exposes is METRES and the trainer's y-up frame,
// exactly as before: `pos`, `footY`, `vel`, `crouchAmt` and the camera are what
// every scenario, bot and spawn picker already reads. The sim's own state is
// Source units and z-up, and it is mirrored out once per tick. Nothing outside
// this file has to know that.
// ---------------------------------------------------------------------------

import { clamp } from '../utils/MathUtils.js';
import { supportHeightAt, hasCollision } from '../utils/mapCollision.js';
import { simWorldFor, U_PER_M } from '../utils/simWorld.js';
import { createPlayerState, createInput, stepPlayer, flatWorld } from '../../shared/sim3d/motion.js';
import { TICK_DT, EYE_STAND, EYE_DUCK } from '../../shared/sim3d/constants.js';
import { UNIT_M, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { RUN_SPEED } from '../utils/SourceMovement.js';

/** The eye heights the sim uses, in metres, so the camera follows duckAmount. */
const EYE_STAND_M = EYE_STAND * UNIT_M;
const EYE_DUCK_M = EYE_DUCK * UNIT_M;

/** A frame longer than this is a tab that was in the background; do not replay it. */
const MAX_FRAME = 0.25;

export class PlayerController {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.camera = engine.camera;

    this.enabled = false;
    this.vel = { x: 0, z: 0 };
    this.pos = { x: 0, z: 0 };
    this.footY = 0;
    this.floorY = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0; // 0 = standing, 1 = fully ducked
    this.bounds = null; // { minX, maxX, minZ, maxZ } | null
    this.colliders = null; // cover/wall boxes or a ported map's hull

    /** Source-frame movement state; the fields above mirror it every tick. */
    this.sim = createPlayerState();
    this.simInput = createInput();
    /** The scenario's world as motion.js sees it, or a flat plane. */
    this.world = null;
    this._flat = flatWorld(0);
    this._acc = 0;
    /** Seconds since the last takeoff; Infinity on the ground. */
    this._jumpAge = Infinity;
  }

  getAccuracyState() {
    return {
      onGround: this.onGround,
      speedHoriz: Math.hypot(this.vel.x, this.vel.z),
      // The rest is what CS2's own accuracy model reads
      // (shared/sim3d/inaccuracy.js, via src/weapons/cs2Ballistics.js): the
      // air penalty is a function of vertical SPEED and is smallest at the
      // apex of a jump, the crouch penalty follows the body rather than the
      // key, and walking takes the movement ramp linearly instead of to the
      // quarter power — which is most of what shift buys.
      velY: this.velY,
      crouchAmt: this.crouchAmt,
      walking: !!this.input?.walkHeld
    };
  }

  /**
   * Seconds since this body last jumped, and whether it is holding the key on
   * the ground — what a jumpthrow needs to know (src/cs3d/throwing.js).
   */
  jumpState() {
    return {
      secondsSinceJump: this._jumpAge,
      jumpHeldOnGround: !!(this.onGround && this.input?.jumpHeld)
    };
  }

  /** Disable + recenter. Called on camera reset / scenario unload. */
  reset() {
    this.enabled = false;
    this.vel.x = 0;
    this.vel.z = 0;
    this.pos.x = 0;
    this.pos.z = 0;
    this.footY = 0;
    this.floorY = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0;
    this.bounds = null;
    this.colliders = null;
    this.world = null;
    this._acc = 0;
    this._jumpAge = Infinity;
    this.sim = createPlayerState();
  }

  /**
   * Place the player and take control of the camera position.
   * @param {{pos:[number,number,number], yaw?:number, bounds?:object}} opts
   */
  spawn({ pos, yaw = 0, bounds = null, colliders = null, spawnGrace = 0, floorY = 0 }) {
    this.pos.x = pos[0];
    this.pos.z = pos[2];
    this.floorY = floorY;
    this.colliders = colliders;
    const spawnY = pos[1] || 0;
    this.footY = hasCollision(colliders)
      ? Math.max(spawnY, supportHeightAt(pos[0], pos[2], colliders, spawnY, floorY))
      : spawnY;
    this.vel.x = 0;
    this.vel.z = 0;
    this.velY = 0;
    this.onGround = true;
    this.crouchAmt = 0;
    this.bounds = bounds;
    this.enabled = true;

    // The sim's world for this scenario. `floorY` is where a body that walks
    // off the map lands: the arenas have a plane at 0, a ported map has the
    // bottom of its own bounds, and the flat world is what a scenario with no
    // geometry at all (Tracking, Range) stands on.
    this.world = simWorldFor(colliders, { floorY, extent: this._extentFor(bounds) })
      || flatWorld(floorY * U_PER_M);

    const s = this.sim;
    s.pos.x = Math.fround(this.pos.x * U_PER_M);
    s.pos.y = Math.fround(-this.pos.z * U_PER_M);
    s.pos.z = Math.fround(this.footY * U_PER_M);
    s.vel.x = s.vel.y = s.vel.z = 0;
    s.onGround = true;
    s.ducking = false;
    s.ducked = false;
    s.duckAmount = 0;
    s.inDuckTransition = false;
    s.stamina = 0;
    s.jumpHeld = false;
    s.duckHeld = false;
    this._acc = 0;
    this._jumpAge = Infinity;

    if (spawnGrace > 0) this.input.beginSpawnGrace(spawnGrace);

    // Sync look so the player starts facing the given yaw.
    this.input.yaw = yaw;
    this.input.pitch = 0;
    this.camera.rotation.y = yaw;
    this.camera.rotation.x = 0;
    this.camera.position.set(this.pos.x, this.footY + EYE_STAND_M, this.pos.z);
  }

  /** How far the arena's ground quad has to reach for these bounds. */
  _extentFor(bounds) {
    if (!bounds) return 64;
    const b = bounds;
    const r = Math.max(
      Math.abs(b.minX ?? 0),
      Math.abs(b.maxX ?? 0),
      Math.abs(b.minZ ?? 0),
      Math.abs(b.maxZ ?? 0),
      b.circleRadius ?? 0
    );
    return Math.max(24, r + 8);
  }

  /**
   * The weapon's run speed in u/s, which is the only speed motion.js is told.
   *
   * Walking and crouching are NOT applied here: the sim owns both, with CS2's
   * own scales and — for a scoped sniper — the special case where a slow scoped
   * weapon does not stack the walk penalty on top. Passing a pre-blended cap
   * would have the sim scale an already-scaled number.
   */
  _maxSpeed() {
    const weapon = this.engine.weapon;
    const cap = weapon?.moveSpeedCap;
    return (cap != null ? cap : RUN_SPEED) * U_PER_M;
  }

  update(dt) {
    if (!this.enabled) return;

    this.input.tickSpawnGrace(dt);

    this._acc += Math.min(dt, MAX_FRAME);
    while (this._acc >= TICK_DT) {
      this._tick();
      this._acc -= TICK_DT;
    }

    // The duck transition is the sim's, so the eye follows duckAmount rather
    // than the key — which is what makes a crouch-peek read the same here as in
    // map practice.
    this.crouchAmt = clamp(this.sim.duckAmount || 0, 0, 1);
    const eye = this.footY + EYE_STAND_M + (EYE_DUCK_M - EYE_STAND_M) * this.crouchAmt;
    this.camera.position.set(this.pos.x, eye, this.pos.z);

    const speedHoriz = Math.hypot(this.vel.x, this.vel.z);
    this.engine.audio?.updateLocalFootsteps(dt, {
      onGround: this.onGround,
      crouchAmt: this.crouchAmt,
      walkHeld: this.input.walkHeld,
      spawnGrace: this.input.spawnGraceRemaining,
      speedHoriz
    });
  }

  /** One 64 Hz tick of the movement sim from the current keys. */
  _tick() {
    const inp = this.simInput;
    const { f, r } = this.input.moveAxis();
    inp.forward = f;
    inp.side = r;
    inp.yaw = sourceYawFromCamera(this.input.yaw);
    inp.pitch = -this.input.pitch * (180 / Math.PI);
    inp.duck = this.input.crouchHeld;
    inp.walk = this.input.walkHeld;
    inp.maxSpeed = this._maxSpeed();
    inp.scoped = (this.engine.weapon?.scopeLevel ?? 0) > 0;
    // `jumpHeld` is the key; `jumpQueued` is a press the InputManager latched
    // for us between frames. Either counts, because a tap inside one frame at
    // 240 Hz would otherwise be a jump the sim never saw.
    inp.jump = !!(this.input.jumpHeld || this.input.jumpQueued);
    this.input.jumpQueued = false;

    const s = this.sim;
    const wasGround = s.onGround;
    stepPlayer(s, inp, this.world || this._flat);
    if (wasGround && !s.onGround && inp.jump && s.vel.z > 140) {
      this._jumpAge = 0;
      this.engine.audio?.playLocalJump();
    } else if (s.onGround) {
      this._jumpAge = Infinity;
    } else if (this._jumpAge < Infinity) {
      this._jumpAge += TICK_DT;
    }

    // Source frame → the trainer's metres.
    this.pos.x = s.pos.x * UNIT_M;
    this.pos.z = -s.pos.y * UNIT_M;
    this.footY = s.pos.z * UNIT_M;
    this.vel.x = s.vel.x * UNIT_M;
    this.vel.z = -s.vel.y * UNIT_M;
    this.velY = s.vel.z * UNIT_M;
    this.onGround = s.onGround;

    this._applyBounds();

    // Fell out of a world with a hole in it: put them back on the floor rather
    // than let them accelerate forever.
    if (this.footY < this.floorY - 200) {
      this.footY = this.floorY;
      this.velY = 0;
      s.pos.z = Math.fround(this.floorY * U_PER_M);
      s.vel.x = s.vel.y = s.vel.z = 0;
    }
  }

  /**
   * The scenario's box, applied after the sim rather than inside it.
   *
   * A bound is a rule ("stay in your half of the Duels arena"), not geometry,
   * and the sim has no concept of one. Clamping the mirrored position and
   * writing it back keeps the two in step; killing the velocity component on
   * contact is what stops the player grinding along an invisible wall at full
   * speed.
   */
  _applyBounds() {
    const b = this.bounds;
    if (!b) return;
    let hit = false;
    if (b.minX != null) {
      if (this.pos.x < b.minX) {
        this.pos.x = b.minX;
        if (this.vel.x < 0) this.vel.x = 0;
        hit = true;
      } else if (this.pos.x > b.maxX) {
        this.pos.x = b.maxX;
        if (this.vel.x > 0) this.vel.x = 0;
        hit = true;
      }
    }
    if (b.minZ != null) {
      if (this.pos.z < b.minZ) {
        this.pos.z = b.minZ;
        if (this.vel.z < 0) this.vel.z = 0;
        hit = true;
      } else if (this.pos.z > b.maxZ) {
        this.pos.z = b.maxZ;
        if (this.vel.z > 0) this.vel.z = 0;
        hit = true;
      }
    }
    if (b.circleRadius != null) {
      const dist = Math.hypot(this.pos.x, this.pos.z);
      const r = b.circleRadius;
      if (dist > r) {
        const nx = this.pos.x / dist;
        const nz = this.pos.z / dist;
        this.pos.x = nx * r;
        this.pos.z = nz * r;
        const vn = this.vel.x * nx + this.vel.z * nz;
        if (vn > 0) {
          this.vel.x -= vn * nx;
          this.vel.z -= vn * nz;
        }
        hit = true;
      }
    }
    if (!hit) return;
    const s = this.sim;
    s.pos.x = Math.fround(this.pos.x * U_PER_M);
    s.pos.y = Math.fround(-this.pos.z * U_PER_M);
    s.vel.x = Math.fround(this.vel.x * U_PER_M);
    s.vel.y = Math.fround(-this.vel.z * U_PER_M);
  }
}
