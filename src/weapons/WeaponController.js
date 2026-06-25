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
  getSprayTune
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

  _active() {
    const sc = this.sceneManager.current;
    return sc && sc.usesWeapon && sc.running && !sc._dead ? sc : null;
  }

  update() {
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
    }

    const wantFire = this.input.fireHeld && !this.reloading && this.ammo > 0;
    if (wantFire) {
      // The cadence is clocked off the real time of the last shot, so spamming
      // clicks (or a lag spike) can never fire faster than the weapon's RPM, and
      // a stale timer (first shot / returning from a tab-out) can't machine-gun
      // a backlog — we clamp it to a single pending shot.
      if (now - this._lastShotAt > SHOT_INTERVAL_MS * 2) this._lastShotAt = now - SHOT_INTERVAL_MS;
      if (!this._firing) {
        this._firing = true;
        this._shotIndex = 0; // a new pull on the trigger restarts the pattern
      }
      while (this.ammo > 0 && !this.reloading && now - this._lastShotAt >= SHOT_INTERVAL_MS) {
        this._lastShotAt += SHOT_INTERVAL_MS;
        this._fireOne(sc);
      }
    } else {
      // Releasing the trigger lets the recoil pattern recover to the start.
      this._firing = false;
      this._shotIndex = 0;
    }

    if (this.ammo === 0 && !this.reloading) this.reload();
  }

  _fireOne(sc) {
    const idx = this._shotIndex;
    const player = this.engine.player;
    const state = player ? player.getAccuracyState() : { onGround: true, speedHoriz: 0 };
    const recentlyLanded = performance.now() < this._landedUntil;
    const tune = getSprayTune(this.settings.data.weapon?.sprayTune);
    const offset = patternOffset(idx, tune);
    const bloom = bloomRad(state, idx, recentlyLanded);

    sc.shoot(offset, bloom, idx); // flash, kick, tracer + view-punch live in shoot()

    this.ammo--;
    this._shotIndex++;
  }
}
