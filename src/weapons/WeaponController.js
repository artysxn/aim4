// ---------------------------------------------------------------------------
// weapons/WeaponController.js
// Drives firing for scenarios that opt in (scenario.usesWeapon). Owns the
// magazine/reload state, the fire cadence (frame-rate independent), the recoil
// index and the view-punch impulse. The active weapon is resolved from the
// scenario's weaponId via the registry, so each weapon supplies its own model:
//   - Rifle  → full-auto, deterministic recoil pattern, sustained bloom.
//   - Pistol → semi-auto (one click = one bullet), no pattern, consecutive bloom.
//
// Hit registration, tracers and networking live in the scenario's shoot(); this
// class only decides WHEN a bullet leaves the barrel and with WHICH recoil/bloom.
// ---------------------------------------------------------------------------

import { getWeapon } from './index.js';

const LAND_WINDOW = 0.15; // seconds after landing where shots are penalised

export class WeaponController {
  constructor({ engine, input, settings, sceneManager, viewmodel }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.sceneManager = sceneManager;
    this.viewmodel = viewmodel;
    this.spec = getWeapon();
    this.reset();
  }

  reset() {
    // Pick up the active scenario's weapon (defaults to rifle outside a run).
    this.spec = getWeapon(this.sceneManager?.current?.weaponId);
    this.viewmodel?.setWeapon(this.spec);

    this.magSize = this.spec.magSize;
    this.ammo = this.magSize;
    this.reloading = false;
    this._reloadEndsAt = 0;
    this._shotIndex = 0; // consecutive-shot counter (drives bloom/punch + pattern)
    this._sustainLevel = 0; // automatic-only: decaying sustained-spray level
    this._firing = false;
    this._wasFireHeld = false;
    this._wasAirborne = false;
    this._landedUntil = 0;
    this._lastShotAt = 0; // wall-clock of the last bullet — enforces the fire-rate cap

    // Scope state (sniper): zoom level, hold-to-cycle and post-shot rescope timers.
    this.scopeLevel = 0;
    this._scopeChangedAt = 0;
    this._rescopeAt = 0; // wall-clock to re-scope after a shot (0 = none pending)
    this._rescopeLevel = 0;
    this._lastZoomCycleAt = 0;
    this._applyScope();
    // Scenarios may spawn the player already scoped in (Sniper Flicks/Tracking).
    const startScoped = this.sceneManager?.current?.startScoped;
    if (this.spec.zoom && startScoped > 0) this.setScope(startScoped);
  }

  // ---- Scope (sniper) -------------------------------------------------------
  /** Set the zoom level (0 = unscoped) and push FOV/sens/speed side effects. */
  setScope(level) {
    const z = this.spec?.zoom;
    if (!z) return;
    level = Math.max(0, Math.min(z.fovs.length, Math.round(level)));
    if (level === this.scopeLevel) return;
    this.scopeLevel = level;
    this._scopeChangedAt = performance.now();
    this._applyScope();
  }

  /** Right-click: step unscoped → zoom 1 → zoom 2 → unscoped. */
  cycleScope() {
    const z = this.spec?.zoom;
    if (!z || !this._active()) return;
    this._rescopeAt = 0; // manual zoom overrides a pending post-shot rescope
    this._lastZoomCycleAt = performance.now();
    this.setScope((this.scopeLevel + 1) % (z.fovs.length + 1));
  }

  /** Instant unscope ("3" / "Q" by default — rebindable in settings). */
  unscope() {
    if (!this.spec?.zoom) return;
    this._rescopeAt = 0;
    this.setScope(0);
  }

  _applyScope() {
    const z = this.spec?.zoom;
    const hFov = z && this.scopeLevel > 0 ? z.fovs[this.scopeLevel - 1] : null;
    this.engine.setZoomFov?.(hFov);
    // CS zoomed sensitivity (zoom_sensitivity_ratio 1): look speed scales with
    // the linear FOV ratio — 2.25× slower at 40°, 9× slower at 10° (90° hip).
    const hip = Number(this.settings.activeSettings()?.hFov) || 90;
    this.input.lookScale = hFov ? hFov / hip : 1;
    this.input.scopeLevel = this.scopeLevel; // recorded into the replay bitmask
  }

  /** Movement cap the PlayerController should honour (null = no override). */
  get moveSpeedCap() {
    const z = this.spec?.zoom;
    if (!z || !this._active()) return null;
    return this.scopeLevel > 0 ? z.scopedSpeed : (z.runSpeed ?? null);
  }

  /** 0..1 accuracy settle since the last scope-in (1 = fully settled). */
  scopeSettle(now = performance.now()) {
    const z = this.spec?.zoom;
    if (!z || this.scopeLevel === 0) return 1;
    const settleMs = (z.settleTime ?? 0.35) * 1000;
    return Math.max(0, Math.min(1, (now - this._scopeChangedAt) / settleMs));
  }

  /** Augment a movement-accuracy state blob with the live scope fields. */
  _withScopeState(state, now = performance.now()) {
    if (!this.spec?.zoom) return state;
    state.scopeLevel = this.scopeLevel;
    state.scopeSettle = this.scopeSettle(now);
    return state;
  }

  /** Player pressed R (or the mag ran dry). */
  reload() {
    if (this._infiniteAmmo()) return;
    if (this.reloading || this.ammo >= this.magSize) return;
    this.reloading = true;
    this._reloadEndsAt = performance.now() + this.spec.reloadTime * 1000;
    this._firing = false;
    // Reloading a scoped weapon drops the scope (CS behaviour).
    if (this.spec.zoom) this.unscope();
  }

  get reloadProgress() {
    if (!this.reloading) return 1;
    const left = (this._reloadEndsAt - performance.now()) / (this.spec.reloadTime * 1000);
    return 1 - Math.max(0, Math.min(1, left));
  }

  /** Effective recoil/bloom level for the NEXT shot (used by the crosshair). */
  _effectiveLevel(now) {
    if (this.spec.automatic) return this._sustainLevel;
    // Semi-auto: consecutive count, reset after a pause.
    if (now - this._lastShotAt > this.spec.burstBreakMs) return 0;
    return this._shotIndex;
  }

  /** Live bloom cone half-angle (rad) for crosshair / UI — matches the next shot. */
  getBloomRad() {
    const sc = this._active();
    if (sc?.weaponBloom === false) return 0;
    const player = this.engine.player;
    const state = player
      ? player.getAccuracyState()
      : { onGround: true, speedHoriz: 0 };
    const now = performance.now();
    this._withScopeState(state, now);
    const recentlyLanded = now < this._landedUntil;
    return this.spec.bloomRad(state, this._effectiveLevel(now), recentlyLanded);
  }

  _active() {
    const sc = this.sceneManager.current;
    return sc && sc.usesWeapon && sc.running && !sc._dead ? sc : null;
  }

  _infiniteAmmo() {
    return !!this._active()?.infiniteAmmo;
  }

  update(dt) {
    const sc = this._active();
    if (!sc) {
      this._firing = false;
      this._wasFireHeld = this.input.fireHeld; // never bank a stale rising edge
      // Drop the scope when the run is gone entirely (keep it across a pause).
      if (this.scopeLevel > 0 && !this.sceneManager.current) this.unscope();
      return;
    }

    // Defensive: if the active scenario uses a different weapon than we set up
    // for, re-initialise (also swaps the viewmodel mesh).
    if (sc.weaponId && sc.weaponId !== this.spec.id) this.reset();

    const now = performance.now();
    const spec = this.spec;
    const shotIntervalMs = spec.shotInterval * 1000;

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

    // Scope: holding right-click keeps cycling zoom levels; a pending post-shot
    // rescope fires when the bolt closes.
    if (spec.zoom) {
      if (this._rescopeAt && now >= this._rescopeAt) {
        this._rescopeAt = 0;
        if (!this.reloading) this.setScope(this._rescopeLevel);
      }
      if (this.input.altHeld && now - this._lastZoomCycleAt >= spec.zoom.cycleMs) {
        this.cycleScope();
      }
    }

    const canFire = !this.reloading && (this._infiniteAmmo() || this.ammo > 0);
    const graceBlock =
      (this.sceneManager.current?.name === 'deathmatch' ||
        this.sceneManager.current?.isDeathmatch) &&
      this.input.spawnGraceRemaining > 0;
    const held = this.input.fireHeld;

    if (spec.automatic) {
      const wantFire = held && canFire && !graceBlock;

      // Linear bloom recovery while off the trigger (not an instant snap).
      if (!wantFire) {
        this._firing = false;
        if (this._sustainLevel > 0) {
          this._sustainLevel = Math.max(
            0,
            this._sustainLevel - dt / spec.sustainRecoveryPerShot
          );
        }
      }

      if (wantFire) {
        const sinceLast = this._lastShotAt > 0 ? now - this._lastShotAt : Infinity;
        // Long pause breaks the burst; tapping at weapon RPM keeps walking the pattern.
        if (sinceLast > spec.burstBreakMs) this._shotIndex = 0;
        if (sinceLast > shotIntervalMs * 2) this._lastShotAt = now - shotIntervalMs;
        this._firing = true;
        const infinite = this._infiniteAmmo();
        while ((infinite || this.ammo > 0) && !this.reloading && now - this._lastShotAt >= shotIntervalMs) {
          this._lastShotAt += shotIntervalMs;
          this._fireOne(sc);
        }
      }
    } else {
      // Semi-auto: exactly one bullet per trigger press (rising edge), capped by
      // the fire rate. Holding the button does nothing until you release + click.
      const rising = held && !this._wasFireHeld;
      if (rising && canFire && !graceBlock && now - this._lastShotAt >= shotIntervalMs) {
        if (now - this._lastShotAt > spec.burstBreakMs) this._shotIndex = 0;
        this._lastShotAt = now;
        this._fireOne(sc);
      }
    }

    this._wasFireHeld = held;
    if (this.ammo === 0 && !this.reloading && !this._infiniteAmmo()) this.reload();
  }

  _fireOne(sc) {
    const idx = this._shotIndex;
    const player = this.engine.player;
    const state = player ? player.getAccuracyState() : { onGround: true, speedHoriz: 0 };
    this._withScopeState(state);
    const recentlyLanded = performance.now() < this._landedUntil;

    const offset = this.spec.patternOffset(idx);
    const level = this.spec.automatic ? this._sustainLevel : idx;
    const bloom =
      sc.weaponBloom === false
        ? 0
        : this.spec.bloomRad(state, level, recentlyLanded);
    const punch = this.spec.viewPunchImpulse(idx);

    if (this.spec.automatic) {
      this._sustainLevel = Math.min(this.spec.sustainCap, this._sustainLevel + 1);
    }

    sc.shoot(offset, bloom, idx, punch); // flash, kick, tracer + view-punch live in shoot()

    // Bolt cycle: a scoped shot drops the scope while the next round chambers,
    // then re-scopes to the same level automatically (CS AWP behaviour).
    if (this.spec.zoom && this.scopeLevel > 0) {
      this._rescopeLevel = this.scopeLevel;
      this._rescopeAt = performance.now() + this.spec.zoom.rescopeMs;
      this.setScope(0);
    }

    if (!sc.infiniteAmmo) this.ammo--;
    this._shotIndex++;
  }
}
