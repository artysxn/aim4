// ---------------------------------------------------------------------------
// weapons/WeaponController.js
// Drives full-auto firing for scenarios that opt in (scenario.usesWeapon). Owns
// the magazine/reload state, the 600-RPM cadence (frame-rate independent), the
// per-burst recoil index that walks the AK pattern, and the view-punch impulse.
//
// Hit registration, tracers and networking live in the scenario's shoot(); this
// class only decides WHEN a bullet leaves the barrel and with WHICH recoil/bloom,
// so the firing model stays in one place.
// ---------------------------------------------------------------------------

import {
  SHOT_INTERVAL,
  MAG_SIZE,
  RELOAD_TIME,
  patternOffset,
  bloomRad,
  BURST_BREAK_MS,
  SUSTAIN_CAP_SHOTS,
  SUSTAIN_RECOVERY_PER_SHOT
} from './ak47.js';

const LAND_WINDOW = 0.15; // seconds after landing where shots are penalised
const SHOT_INTERVAL_MS = SHOT_INTERVAL * 1000;

export class WeaponController {
  constructor({ engine, input, settings, sceneManager, viewmodel }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.sceneManager = sceneManager;
    this.viewmodel = viewmodel;
    this.reset();
  }

  reset() {
    this.ammo = MAG_SIZE;
    this.magSize = MAG_SIZE;
    this.reloading = false;
    this._reloadEndsAt = 0;
    this._shotIndex = 0;
    this._sustainLevel = 0;
    this._firing = false;
    this._wasAirborne = false;
    this._landedUntil = 0;
    this._lastShotAt = 0; // wall-clock of the last bullet — enforces the RPM cap
  }

  /** Player pressed R (or the mag ran dry). */
  reload() {
    if (this.reloading || this.ammo >= this.magSize) return;
    this.reloading = true;
    this._reloadEndsAt = performance.now() + RELOAD_TIME * 1000;
    this._firing = false;
  }

  get reloadProgress() {
    if (!this.reloading) return 1;
    const left = (this._reloadEndsAt - performance.now()) / (RELOAD_TIME * 1000);
    return 1 - Math.max(0, Math.min(1, left));
  }

  /** Live bloom cone half-angle (rad) for crosshair / UI — matches the next shot. */
  getBloomRad() {
    const player = this.engine.player;
    const state = player
      ? player.getAccuracyState()
      : { onGround: true, speedHoriz: 0 };
    const recentlyLanded = performance.now() < this._landedUntil;
    return bloomRad(state, this._sustainLevel, recentlyLanded);
  }

  _active() {
    const sc = this.sceneManager.current;
    return sc && sc.usesWeapon && sc.running && !sc._dead ? sc : null;
  }

  update(dt) {
    const sc = this._active();
    if (!sc) {
      this._firing = false;
      return;
    }
    const now = performance.now();

    // Track landing so a just-landed shot is penalised.
    const player = this.engine.player;
    const onGround = player ? player.onGround : true;
    if (this._wasAirborne && onGround) this._landedUntil = now + LAND_WINDOW * 1000;
    this._wasAirborne = !onGround;

    // Reload completion.
    if (this.reloading && now >= this._reloadEndsAt) {
      this.reloading = false;
      this.ammo = this.magSize;
      this._shotIndex = 0;
      this._sustainLevel = 0;
    }

    const wantFire = this.input.fireHeld && !this.reloading && this.ammo > 0;

    // Linear bloom recovery while off the trigger (not instant snap to standing accuracy).
    if (!wantFire) {
      this._firing = false;
      if (this._sustainLevel > 0) {
        this._sustainLevel = Math.max(
          0,
          this._sustainLevel - dt / SUSTAIN_RECOVERY_PER_SHOT
        );
      }
    }

    if (wantFire) {
      const sinceLast = this._lastShotAt > 0 ? now - this._lastShotAt : Infinity;

      // Long pause breaks the burst; tap-firing at weapon RPM keeps walking the pattern.
      if (sinceLast > BURST_BREAK_MS) {
        this._shotIndex = 0;
      }

      // The cadence is clocked off the real time of the last shot, so spamming
      // clicks (or a lag spike) can never fire faster than the weapon's RPM, and
      // a stale timer (first shot / returning from a tab-out) can't machine-gun
      // a backlog — we clamp it to a single pending shot.
      if (sinceLast > SHOT_INTERVAL_MS * 2) {
        this._lastShotAt = now - SHOT_INTERVAL_MS;
      }
      this._firing = true;
      while (this.ammo > 0 && !this.reloading && now - this._lastShotAt >= SHOT_INTERVAL_MS) {
        this._lastShotAt += SHOT_INTERVAL_MS;
        this._fireOne(sc);
      }
    }

    if (this.ammo === 0 && !this.reloading) this.reload();
  }

  _fireOne(sc) {
    const idx = this._shotIndex;
    const player = this.engine.player;
    const state = player ? player.getAccuracyState() : { onGround: true, speedHoriz: 0 };
    const recentlyLanded = performance.now() < this._landedUntil;
    const offset = patternOffset(idx);
    const bloom = bloomRad(state, this._sustainLevel, recentlyLanded);
    this._sustainLevel = Math.min(SUSTAIN_CAP_SHOTS, this._sustainLevel + 1);

    sc.shoot(offset, bloom, idx); // flash, kick, tracer + view-punch live in shoot()

    this.ammo--;
    this._shotIndex++;
  }
}
