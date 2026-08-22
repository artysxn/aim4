// ---------------------------------------------------------------------------
// src/weapons/cs2Ballistics.js
// Where a trainer bullet goes, decided by CS2's own numbers.
//
// This is the trainer's half of `shared/sim3d/recoil.js` and
// `shared/sim3d/inaccuracy.js` — the same two modules the 3D map practice mode
// shoots with, driven in the same order, on the same weapon rows out of the
// weapons pack. Nothing about the ballistics is reimplemented here; this file
// only holds the state, converts the trainer's units into the ones those
// modules count in, and hands back a direction.
//
// What that replaces. `src/weapons/ak47.js` carries a hand-authored 30-shot
// table with `SPRAY_STRENGTH = 0.68` over it, and says so in as many words:
// "Authored to feel like CS2 rather than copied frame-exact (the real values
// are undisclosed)". They are not undisclosed any more — CS2 generates its
// pattern at load from a per-weapon SEED, `recoil.js` is that generator, and
// its output was checked against 758 AK sprays out of six GOTV demos. So the
// AK's reverse-7 here is seed 223's, at full strength, not an impression of it.
//
// ## What the trainer keeps
//
// The magazine, the reload time and the scope behaviour stay the trainer's
// (`WeaponController`) — they are pacing, not ballistics. The FIRE RATE does
// not: the pattern is what the damped punch does when the table is fed in at
// the weapon's own cadence, so a different cycle time is a different pattern
// and `cycleTime()` below is the table's.
//
// ## Units
//
// The trainer counts metres and three's camera angles; both shared modules
// count Source units and Source view angles (pitch+ DOWN, yaw+ LEFT). The
// conversions live in `playerState()` and `direction()` and nowhere else.
// ---------------------------------------------------------------------------

import {
  createRecoilState,
  resetRecoil,
  fireRecoil,
  updateRecoil,
  updateRecoilIndex,
  aimPunch,
  cameraPunch
} from '../../shared/sim3d/recoil.js';
import {
  createAccuracyState,
  resetAccuracy,
  updateAccuracy,
  addFireInaccuracy,
  getInaccuracy,
  getSpread,
  getSpreadSeed,
  sampleCone,
  bulletDirection
} from '../../shared/sim3d/inaccuracy.js';
import { UNIT_M, sourceToScene, sourceYawFromCamera } from '../../shared/sim3d/units.js';
import { weaponNameFor } from '../agents/trainerWeapons.js';

const DEG = Math.PI / 180;

/**
 * One player's CS2 recoil and accuracy state, over one held weapon.
 *
 * Drive it with `update(dt, player)` every frame and `fire(...)` when a bullet
 * leaves. `ready` is false until the weapons pack has landed, which is the
 * signal to fall back to the trainer's own tables.
 */
export class CS2Ballistics {
  /**
   * @param {object} o
   * @param {{stats: (name: string) => object|null}} o.assets  the weapons pack.
   *   Injected rather than imported: the pack loader reaches the glTF addons
   *   through a Vite-only specifier and cannot be loaded under node, and the
   *   ballistics are exactly the part worth testing there.
   */
  constructor({ assets } = {}) {
    this.assets = assets || { stats: () => null };
    /** The weapons-pack row in hand, or null. */
    this.weapon = null;
    this.weaponName = '';
    /** 0 hip, 1 scoped — the AWP's second recoil and accuracy column. */
    this.mode = 0;
    this.recoil = createRecoilState();
    this.accuracy = createAccuracyState();
    /**
     * The shot number the cone is seeded from. CS2 masks it to 8 bits, so
     * there are 256 distinct cone patterns and this only has to be an integer
     * that moves — see `sampleCone`.
     */
    this.shotSeed = 0;
    this._aim = [0, 0, 0];
    this._cam = [0, 0, 0];
  }

  /**
   * True once there is a real weapon row to shoot with.
   *
   * Resolves lazily, because `setSpec` is called from `WeaponController.reset`
   * — which runs when a scenario starts, and on a cold page that is before the
   * weapons pack has landed. Without this the row stays null for the whole
   * session and the trainer silently never uses CS2's numbers at all.
   */
  get ready() {
    if (!this.weapon && this.weaponName) this.weapon = this.assets.stats(this.weaponName) || null;
    return !!this.weapon?.recoil;
  }

  /**
   * Hold a weapon. Takes a trainer weapon spec (`src/weapons/index.js`) and
   * maps it to the CS2 weapon it stands for, so callers never name a CS2
   * weapon themselves — that mapping has one home (weaponAssets.js).
   */
  setSpec(spec) {
    return this.setWeapon(weaponNameFor(spec));
  }

  setWeapon(name) {
    const bare = String(name || '').replace(/^weapon_/, '');
    if (bare === this.weaponName && this.weapon) return this.weapon;
    this.weaponName = bare;
    this.weapon = this.assets.stats(bare) || null;
    this.reset();
    return this.weapon;
  }

  /** Scoped weapons read a second column out of both tables. */
  setMode(mode) {
    this.mode = mode ? 1 : 0;
  }

  reset() {
    resetRecoil(this.recoil);
    resetAccuracy(this.accuracy);
  }

  /**
   * Seconds between shots, from `m_flCycleTime`.
   *
   * Not a detail the caller may substitute: the pattern is the punch's
   * response to this cadence, and firing the same table faster or slower is a
   * different spray.
   */
  cycleTime() {
    const c = this.weapon?.cycleTime;
    if (Array.isArray(c)) return c[this.mode] || c[0] || 0.1;
    return c || 0.1;
  }

  /** Rounds in a magazine, from the table. */
  clipSize() {
    return this.weapon?.clip || 0;
  }

  /**
   * The trainer's player state in the frame `inaccuracy.js` reads.
   *
   * Speeds go from metres to Source units; `ducking` is the crouch amount past
   * half rather than a key, because the trainer eases into a crouch over about
   * 0.14 s and the penalty should follow the body rather than the keypress.
   */
  playerState(player) {
    const speed = (player?.speedHoriz || 0) / UNIT_M;
    return {
      speed,
      velocityZ: (player?.velY || 0) / UNIT_M,
      onGround: player?.onGround !== false,
      ducking: (player?.crouchAmt || 0) > 0.5,
      onLadder: false,
      walking: !!player?.walking,
      reloading: !!player?.reloading,
      recoilIndex: this.recoil.index
    };
  }

  /**
   * Let the punch settle and the penalty recover. Once a frame.
   *
   * @param {number} dt seconds
   * @param {object} player the trainer's accuracy state
   * @param {number} now seconds, the same clock `fire` is given
   */
  update(dt, player, now) {
    if (!this.ready) return;
    updateRecoil(this.recoil, dt);
    updateRecoilIndex(this.recoil, dt, this.cycleTime(), now);
    updateAccuracy(this.accuracy, this.weapon, this.playerState(player), dt, this.mode);
  }

  /**
   * Fire one round.
   *
   * The order is the game's, and it is the part that is easy to get wrong: the
   * bullet leaves with the CURRENT punch and the CURRENT penalty, and only
   * then do this shot's kick and this shot's penalty land — on the next one.
   * Reversing either makes the first bullet of a spray inaccurate, which is
   * the one thing every CS player knows is not true.
   *
   * @param {object} o
   * @param {number} o.yaw    three camera yaw, radians
   * @param {number} o.pitch  three camera pitch, radians (positive UP)
   * @param {object} o.player the trainer's accuracy state
   * @param {number} o.now    seconds
   * @returns {{dir: {x,y,z}, dirs: {x,y,z}[], punchPitch: number, punchYaw: number,
   *            index: number, inaccuracy: number}|null} `dir` is the first
   *   pellet in the TRAINER's frame; `dirs` is all of them.
   */
  fire({ yaw = 0, pitch = 0, player = null, now = 0 } = {}) {
    if (!this.ready) return null;
    const weapon = this.weapon;

    // The whole aim punch — bullets take 100% of it, the camera 45%.
    aimPunch(this.recoil, this._aim);
    const srcPitch = -pitch / DEG + this._aim[0];
    const srcYaw = sourceYawFromCamera(yaw) + this._aim[1];

    const inaccuracy = getInaccuracy(this.accuracy, weapon, this.playerState(player), this.mode);
    const cone = sampleCone({
      seed: this.shotSeed++,
      inaccuracy,
      spread: getSpread(weapon, this.mode),
      spreadSeed: getSpreadSeed(weapon),
      bullets: Math.max(1, weapon.bullets || 1)
    });

    const dirs = cone.map((c) => {
      const d = bulletDirection(srcPitch, srcYaw, c.x, c.y);
      const [x, y, z] = sourceToScene(d.x, d.y, d.z);
      return { x, y, z };
    });

    addFireInaccuracy(this.accuracy, weapon, this.mode);
    const kick = fireRecoil(this.recoil, weapon, { mode: this.mode, now });

    return {
      dir: dirs[0],
      dirs,
      punchPitch: this._aim[0],
      punchYaw: this._aim[1],
      index: kick ? kick.index : 0,
      inaccuracy
    };
  }

  /**
   * What the CAMERA should be showing, degrees [pitch, yaw, roll].
   *
   * The cosmetic shake in full plus 45% of the aim punch — the missing 55% is
   * the gap between the crosshair and the bullets, and reproducing it is the
   * whole reason a CS spray is learnable.
   */
  cameraPunchDeg(out = this._cam) {
    return cameraPunch(this.recoil, out);
  }

  /** The aim punch the BULLETS are taking right now, degrees. */
  aimPunchDeg(out = this._aim) {
    return aimPunch(this.recoil, out);
  }
}
