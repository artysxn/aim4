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
import { lerp } from '../utils/MathUtils.js';
import { CS2Ballistics } from './cs2Ballistics.js';
import { sharedWeaponAssets } from '../agents/weaponAssets.js';

const LAND_WINDOW = 0.15; // seconds after landing where shots are penalised
const DEG = Math.PI / 180;

export class WeaponController {
  constructor({ engine, input, settings, sceneManager, viewmodel }) {
    this.engine = engine;
    this.input = input;
    this.settings = settings;
    this.sceneManager = sceneManager;
    this.viewmodel = viewmodel;
    this.spec = getWeapon();
    /**
     * CS2's own recoil and accuracy, over the same weapon rows the 3D map
     * practice mode shoots with. `ready` is false until the weapons pack has
     * landed; until then (and whenever the setting is off) the trainer's own
     * tables in ak47.js / pistol.js / sniper.js decide where a bullet goes.
     */
    this.cs2 = new CS2Ballistics({ assets: sharedWeaponAssets() });
    this.reset();
  }

  /**
   * Is this shot decided by CS2's numbers?
   *
   * Competitive runs are deliberately NOT special-cased: the whole point of
   * the mode is to be the game, and a leaderboard split between two different
   * spray patterns would be worse than one that moved once.
   *
   * **A scenario that turns bloom off is.** `weaponBloom === false` is a
   * clicking mode (gridshot and friends) declaring that raw aim is the whole
   * score — but this flag only zeroed the trainer's own cone, while the CS2
   * model kept baking USP spread and recoil into the shot direction and
   * capping clicks at the game's 170 ms cycle instead of the trainer's 90 ms.
   * A mode that says "no bloom" gets the trainer model, where straight
   * pistol shots actually exist; the game-faithful modes (deathmatch, doors,
   * range, duels) never set the flag and keep CS2. Both presets of a mode see
   * the same model, so no leaderboard is split by this either.
   *
   * **Multiplayer is.** The server re-derives every bullet from the aim, the
   * shooter's stance and a spread seed (`server/lobby.js` `_shoot` →
   * `resolveShotDirection`) using the TRAINER's cone, and validates the hit
   * against its own answer. A client shooting CS2's pattern would send an aim
   * the server then bends a different way — every spray bullet lands somewhere
   * else on the server than it did on screen, and hits are rejected with
   * nothing to show why. The two models have to move together, and that is a
   * protocol change, not this one.
   */
  get useCS2() {
    if (this.settings.activeSettings().weapon?.cs2Ballistics === false) return false;
    if (this.sceneManager.current?.isMultiplayer) return false;
    if (this.sceneManager.current?.weaponBloom === false) return false;
    return this.cs2.ready;
  }

  reset() {
    // Pick up the active scenario's weapon (defaults to rifle outside a run).
    this.spec = getWeapon(this.sceneManager?.current?.weaponId);
    this.viewmodel?.setWeapon(this.spec);
    this.cs2.setSpec(this.spec);

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
    this._rescopeStartedAt = 0;
    this._rescopeLevel = 0;
    this._lastZoomCycleAt = 0;
    this._lastScopeInAt = 0;
    this._applyScope();
    // Scenarios may spawn the player already scoped in (Sniper Flicks/Tracking).
    const startScoped = this.sceneManager?.current?.startScoped;
    if (this.spec.zoom && startScoped > 0) this.setScope(startScoped);
  }

  // ---- Scope (sniper) -------------------------------------------------------
  /** True while the post-shot bolt cycle is running (manual scope-in blocked). */
  isBoltCycling(now = performance.now()) {
    return this._rescopeAt > 0 && now < this._rescopeAt;
  }

  /** 0..1 progress through the bolt cycle (0 when idle). */
  boltCycleProgress(now = performance.now()) {
    if (!this.isBoltCycling(now)) return 0;
    const total = this.spec?.zoom?.rescopeMs ?? 1250;
    const start = this._rescopeStartedAt || (this._rescopeAt - total);
    return Math.max(0, Math.min(1, (now - start) / total));
  }

  /** Set the zoom level (0 = unscoped) and push FOV/sens/speed side effects. */
  setScope(level) {
    const z = this.spec?.zoom;
    if (!z) return;
    if (level > 0 && this.isBoltCycling()) return;
    level = Math.max(0, Math.min(z.fovs.length, Math.round(level)));
    if (level === this.scopeLevel) return;
    const wasScoped = this.scopeLevel > 0;
    this.scopeLevel = level;
    // Settle penalty only on fresh scope-in (0→scoped), not 1→2 zoom.
    if (level > 0 && !wasScoped) {
      this._scopeChangedAt = performance.now();
    } else if (level === 0) {
      this._scopeChangedAt = 0;
    }
    this._applyScope();
  }

  /** Right-click: step unscoped → zoom 1 → zoom 2 → unscoped. */
  cycleScope() {
    const z = this.spec?.zoom;
    if (!z || !this._active()) return;
    const now = performance.now();
    const minMs = z.minScopeInMs ?? z.cycleMs ?? 350;
    if (now - this._lastZoomCycleAt < minMs) return;
    const next = (this.scopeLevel + 1) % (z.fovs.length + 1);
    if (next > 0 && this.isBoltCycling(now)) return;
    this._lastZoomCycleAt = now;
    if (next > 0 && this.scopeLevel === 0) this._lastScopeInAt = now;
    this.setScope(next);
  }

  /** Instant unscope ("3" / "Q" by default — rebindable in settings). */
  unscope() {
    if (!this.spec?.zoom) return;
    this._rescopeAt = 0;
    this._rescopeStartedAt = 0;
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

  /**
   * Full movement cap including scoped shift-walk / crouch (null = use moveSpeedCap
   * + default walk/crouch blending in PlayerController).
   */
  getMoveSpeedCap({ walkHeld = false, crouchAmt = 0 } = {}) {
    const z = this.spec?.zoom;
    if (!z || !this._active() || this.scopeLevel === 0) return null;
    const stand = z.scopedSpeed;
    const walk = z.scopedWalkSpeed ?? stand;
    const crouch = z.scopedCrouchSpeed ?? stand;
    const standCap = walkHeld ? walk : stand;
    return lerp(standCap, crouch, crouchAmt);
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
    // The cadence is part of the pattern, not separate from it: the spray is
    // what the damped punch does when the table is fed in at the weapon's own
    // rate, so CS2's `m_flCycleTime` comes along with CS2's recoil or neither
    // does. (AK: 0.1 s either way. USP: 0.17 in the game against the trainer's
    // 0.09. AWP: 1.455 against 1.463.)
    const shotIntervalMs = (this.useCS2 ? this.cs2.cycleTime() : spec.shotInterval) * 1000;

    // Let the punch settle and the accuracy penalty recover, whether or not a
    // trigger is down — the recovery between sprays is the model's too.
    if (this.cs2.ready) {
      this.cs2.setMode(this.scopeLevel > 0 ? 1 : 0);
      this.cs2.update(dt, this._accuracyState(), now / 1000);
      if (this.useCS2) this._pushCameraPunch();
      // Turned off mid-run: hand the punch back to the viewmodel's own spring,
      // or it freezes at whatever the last CS2 frame wrote.
      else if (this.viewmodel?._absolutePunch) this.viewmodel.setAbsolutePunch(null);
    }

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
        this._rescopeStartedAt = 0;
        if (!this.reloading) this.setScope(this._rescopeLevel);
      }
      if (
        this.input.altHeld &&
        !this.isBoltCycling(now) &&
        now - this._lastZoomCycleAt >= (spec.zoom.minScopeInMs ?? spec.zoom.cycleMs)
      ) {
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

  /** The player's stance, for whichever accuracy model is in charge. */
  _accuracyState() {
    const player = this.engine.player;
    const state = player?.enabled ? player.getAccuracyState() : { onGround: true, speedHoriz: 0 };
    state.reloading = this.reloading;
    return state;
  }

  /**
   * Hand the camera the punch CS2 says it should be showing.
   *
   * An absolute angle every frame, not an impulse: the game's view punch is
   * state that decays on its own clock inside the recoil model, and the
   * viewmodel's own spring would be a second, different decay layered on top.
   * `Viewmodel.setAbsolutePunch` turns that spring off for as long as this is
   * being fed.
   */
  _pushCameraPunch() {
    const vm = this.viewmodel;
    if (!vm) return;
    const sc = this.sceneManager.current;
    // The scenario may suppress the kick, and so may the player: `aimpunch` is
    // checked here rather than in `Viewmodel.punch`, which this path no longer
    // goes through.
    const off = (sc && sc.viewmodelRecoil === false) || this.settings.activeSettings().weapon?.aimpunch === false;
    if (off) {
      vm.setAbsolutePunch(0, 0);
      return;
    }
    const p = this.cs2.cameraPunchDeg();
    // Source QAngle → the trainer's camera: pitch+ is DOWN there and UP here.
    vm.setAbsolutePunch(-p[0] * DEG, -p[1] * DEG);
  }

  _fireOne(sc) {
    const idx = this._shotIndex;
    const player = this.engine.player;
    const state = this._accuracyState();
    this._withScopeState(state);
    const recentlyLanded = performance.now() < this._landedUntil;

    // ---- CS2's own ballistics ---------------------------------------------
    if (this.useCS2) {
      const input = this.engine.player?.input;
      const shot = this.cs2.fire({
        yaw: input ? input.yaw : this.engine.camera.rotation.y,
        pitch: input ? input.pitch : this.engine.camera.rotation.x,
        player: state,
        now: performance.now() / 1000
      });
      if (this.spec.automatic) {
        this._sustainLevel = Math.min(this.spec.sustainCap, this._sustainLevel + 1);
      }
      sc.shoot(null, 0, idx, null, shot);
      this._pushCameraPunch();
      this._afterShot(sc);
      return;
    }

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
    this._afterShot(sc);
  }

  /** Everything a shot does after the bullet has gone, either model. */
  _afterShot(sc) {
    // Bolt cycle: a scoped shot drops the scope while the next round chambers,
    // then re-scopes to the same level automatically (CS AWP behaviour).
    if (this.spec.zoom && this.scopeLevel > 0) {
      this._rescopeLevel = this.scopeLevel;
      const t0 = performance.now();
      this._rescopeStartedAt = t0;
      this._rescopeAt = t0 + this.spec.zoom.rescopeMs;
      this.setScope(0);
    }

    if (!sc.infiniteAmmo) this.ammo--;
    this._shotIndex++;
  }
}
