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
    const sc = this.sceneManager?.current;
    this._loadoutEnabled = !!sc?.allowWeaponSwap;
    this._loadoutSlot = 'sniper';

    const initialId = this._loadoutEnabled
      ? 'sniper'
      : (sc?.weaponId || 'rifle');
    const startDeploy = getWeapon(initialId).deployMs > 0;
    this._equip(initialId, { deploy: startDeploy });

    this.reloading = false;
    this._reloadEndsAt = 0;
    this._shotIndex = 0;
    this._sustainLevel = 0;
    this._firing = false;
    this._wasFireHeld = false;
    this._wasAltHeld = false;
    this._wasAirborne = false;
    this._landedUntil = 0;
    this._lastShotAt = 0;
    this._attackType = 'quick';

    this.scopeLevel = 0;
    this.scopeVisualLevel = 0;
    this._scopeChangedAt = 0;
    this._rescopeAt = 0;
    this._rescopeStartedAt = 0;
    this._rescopeLevel = 0;
    this._lastZoomCycleAt = 0;
    this._lastScopeInAt = 0;
    this._inspectEndsAt = 0;
    this._applyScope();

    const startScoped = sc?.startScoped;
    if (this.spec.zoom && startScoped > 0) this.setScope(startScoped);
  }

  // ---- Loadout (sniping modes) -----------------------------------------------
  switchToSlot(slot) {
    if (!this._loadoutEnabled) return;
    const id = slot === 3 || slot === 'knife' ? 'knife' : 'sniper';
    if (this.spec.id === id) return;
    this._equip(id, { deploy: true });
  }

  toggleLoadout() {
    if (!this._loadoutEnabled) return;
    this.switchToSlot(this.spec.id === 'knife' ? 'sniper' : 'knife');
  }

  inspect() {
    if (!this.spec.melee || !this._active()) return;
    if (this.isDeploying()) return;
    const ms = this.spec.inspectMs ?? 2500;
    this._inspectEndsAt = performance.now() + ms;
    this.viewmodel?.beginInspect?.(ms);
  }

  isInspecting(now = performance.now()) {
    return now < this._inspectEndsAt;
  }

  inspectProgress(now = performance.now()) {
    if (!this.isInspecting(now)) return 0;
    const ms = this.spec.inspectMs ?? 2500;
    const left = this._inspectEndsAt - now;
    return 1 - left / ms;
  }

  _equip(id, { deploy = false } = {}) {
    this.spec = getWeapon(id);
    this._loadoutSlot = id === 'knife' ? 'knife' : 'sniper';
    this.viewmodel?.setWeapon(this.spec);
    this.magSize = this.spec.magSize;
    this.ammo = this.spec.magSize;
    this.reloading = false;
    this._shotIndex = 0;
    this._sustainLevel = 0;
    this._inspectEndsAt = 0;

    if (this.spec.zoom && this.scopeLevel > 0) {
      this._rescopeAt = 0;
      this._rescopeStartedAt = 0;
      this.scopeLevel = 0;
      this.scopeVisualLevel = 0;
      this._scopeChangedAt = 0;
    }

    if (deploy && this.spec.deployMs > 0) {
      this._deployEndsAt = performance.now() + this.spec.deployMs;
      this._deployStartedAt = performance.now();
    } else {
      this._deployEndsAt = 0;
      this._deployStartedAt = 0;
    }
    this._applyScope();
  }

  isDeploying(now = performance.now()) {
    return this._deployEndsAt > 0 && now < this._deployEndsAt;
  }

  deployProgress(now = performance.now()) {
    if (!this.isDeploying(now)) return 1;
    const total = this.spec?.deployMs || 1;
    return Math.max(0, Math.min(1, (now - this._deployStartedAt) / total));
  }

  // ---- Scope (sniper) -------------------------------------------------------
  isBoltCycling(now = performance.now()) {
    return this._rescopeAt > 0 && now < this._rescopeAt;
  }

  boltCycleProgress(now = performance.now()) {
    if (!this.isBoltCycling(now)) return 0;
    const total = this.spec?.zoom?.rescopeMs ?? 1250;
    const start = this._rescopeStartedAt || (this._rescopeAt - total);
    return Math.max(0, Math.min(1, (now - start) / total));
  }

  setScope(level) {
    const z = this.spec?.zoom;
    if (!z) return;
    if (level > 0 && this.isBoltCycling()) return;
    level = Math.max(0, Math.min(z.fovs.length, Math.round(level)));
    if (level === this.scopeLevel) return;
    const wasScoped = this.scopeLevel > 0;
    this.scopeLevel = level;
    if (level > 0 && !wasScoped) {
      this._scopeChangedAt = performance.now();
    } else if (level === 0) {
      this._scopeChangedAt = 0;
    }
    this._applyScope();
  }

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

  unscope() {
    if (!this.spec?.zoom) return;
    this._rescopeAt =  0;
    this._rescopeStartedAt = 0;
    this.setScope(0);
  }

  _applyScope(now = performance.now()) {
    const z = this.spec?.zoom;
    let visualLevel = this.scopeLevel;
    if (z && visualLevel > 0) {
      const settling = this._scopeChangedAt > 0 && this.scopeSettle(now) < 1;
      if (settling || this.isDeploying(now)) visualLevel = 0;
    }
    this.scopeVisualLevel = visualLevel;

    const hFov = z && visualLevel > 0 ? z.fovs[visualLevel - 1] : null;
    this.engine.setZoomFov?.(hFov);
    const hip = Number(this.settings.activeSettings()?.hFov) || 90;
    this.input.lookScale = hFov ? hFov / hip : 1;
    this.input.scopeLevel = this.scopeLevel;
  }

  get moveSpeedCap() {
    if (!this._active()) return null;
    if (this.spec.runSpeed != null) return this.spec.runSpeed;
    const z = this.spec?.zoom;
    if (!z) return null;
    return this.scopeLevel > 0 ? z.scopedSpeed : (z.runSpeed ?? null);
  }

  getMoveSpeedCap({ walkHeld = false, crouchAmt = 0 } = {}) {
    const z = this.spec?.zoom;
    if (!z || !this._active() || this.scopeLevel === 0) return null;
    const stand = z.scopedSpeed;
    const walk = z.scopedWalkSpeed ?? stand;
    const crouch = z.scopedCrouchSpeed ?? stand;
    const standCap = walkHeld ? walk : stand;
    return lerp(standCap, crouch, crouchAmt);
  }

  scopeSettle(now = performance.now()) {
    const z = this.spec?.zoom;
    if (!z || this.scopeLevel === 0) return 1;
    const settleMs = (z.settleTime ?? 0.35) * 1000;
    return Math.max(0, Math.min(1, (now - this._scopeChangedAt) / settleMs));
  }

  isScopeReady(now = performance.now()) {
    if (!this.spec?.zoom || this.scopeLevel === 0) return true;
    if (this.isDeploying(now)) return false;
    if (this._scopeChangedAt > 0 && this.scopeSettle(now) < 1) return false;
    return true;
  }

  _withScopeState(state, now = performance.now()) {
    if (!this.spec?.zoom) return state;
    state.scopeLevel = this.scopeVisualLevel;
    state.scopeSettle = this.scopeSettle(now);
    return state;
  }

  reload() {
    if (this.spec.melee || this._infiniteAmmo()) return;
    if (this.reloading || this.ammo >= this.magSize) return;
    this.reloading = true;
    this._reloadEndsAt = performance.now() + this.spec.reloadTime * 1000;
    this._firing = false;
    if (this.spec.zoom) this.unscope();
  }

  get reloadProgress() {
    if (!this.reloading) return 1;
    const left = (this._reloadEndsAt - performance.now()) / (this.spec.reloadTime * 1000);
    return 1 - Math.max(0, Math.min(1, left));
  }

  _effectiveLevel(now) {
    if (this.spec.automatic) return this._sustainLevel;
    if (now - this._lastShotAt > this.spec.burstBreakMs) return 0;
    return this._shotIndex;
  }

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
    return !!this._active()?.infiniteAmmo || !!this.spec.melee;
  }

  _canAttack(now) {
    if (this.isDeploying(now) || this.isInspecting(now)) return false;
    if (!this.reloading && (this._infiniteAmmo() || this.ammo > 0)) {
      if (this.spec.zoom && this.scopeLevel > 0 && !this.isScopeReady(now)) return false;
      return true;
    }
    return false;
  }

  update(dt) {
    const sc = this._active();
    if (!sc) {
      this._firing = false;
      this._wasFireHeld = this.input.fireHeld;
      this._wasAltHeld = this.input.altHeld;
      if (this.scopeLevel > 0 && !this.sceneManager.current) this.unscope();
      return;
    }

    if (!sc.allowWeaponSwap && sc.weaponId && sc.weaponId !== this.spec.id) this.reset();

    const now = performance.now();
    const spec = this.spec;
    const shotIntervalMs = spec.shotInterval * 1000;
    const heavyIntervalMs = (spec.heavyShotInterval ?? spec.shotInterval * 2) * 1000;

    const player = this.engine.player;
    const onGround = player ? player.onGround : true;
    if (this._wasAirborne && onGround) this._landedUntil = now + LAND_WINDOW * 1000;
    this._wasAirborne = !onGround;

    if (this.reloading && now >= this._reloadEndsAt) {
      this.reloading = false;
      this.ammo = this.magSize;
      this._shotIndex = 0;
      this._sustainLevel = 0;
    }

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
      // Commit deferred scope zoom once settle / deploy completes.
      if (this.scopeLevel > 0) this._applyScope(now);
    }

    const canFire = this._canAttack(now);
    const graceBlock =
      (this.sceneManager.current?.name === 'deathmatch' ||
        this.sceneManager.current?.isDeathmatch) &&
      this.input.spawnGraceRemaining > 0;
    const held = this.input.fireHeld;
    const altHeld = this.input.altHeld;

    if (spec.melee) {
      const fireRising = held && !this._wasFireHeld;
      const altRising = altHeld && !this._wasAltHeld;
      if (fireRising && canFire && !graceBlock && now - this._lastShotAt >= shotIntervalMs) {
        if (now - this._lastShotAt > spec.burstBreakMs) this._shotIndex = 0;
        this._attackType = 'quick';
        this._lastShotAt = now;
        this._fireOne(sc);
      } else if (altRising && canFire && !graceBlock && now - this._lastShotAt >= heavyIntervalMs) {
        if (now - this._lastShotAt > spec.burstBreakMs) this._shotIndex = 0;
        this._attackType = 'heavy';
        this._lastShotAt = now;
        this._fireOne(sc);
      }
    } else if (spec.automatic) {
      const wantFire = held && canFire && !graceBlock;

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
      const rising = held && !this._wasFireHeld;
      if (rising && canFire && !graceBlock && now - this._lastShotAt >= shotIntervalMs) {
        if (now - this._lastShotAt > spec.burstBreakMs) this._shotIndex = 0;
        this._lastShotAt = now;
        this._fireOne(sc);
      }
    }

    this._wasFireHeld = held;
    this._wasAltHeld = altHeld;
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

    if (this.spec.melee) {
      this.viewmodel?.slash?.(this._attackType);
    }

    sc.shoot(offset, bloom, idx, punch);

    if (this.spec.zoom && this.scopeLevel > 0) {
      this._rescopeLevel = this.scopeLevel;
      const t0 = performance.now();
      this._rescopeStartedAt = t0;
      this._rescopeAt = t0 + this.spec.zoom.rescopeMs;
      this.setScope(0);
    }

    if (!sc.infiniteAmmo && !this.spec.melee) this.ammo--;
    this._shotIndex++;
  }
}
