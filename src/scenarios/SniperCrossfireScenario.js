// ---------------------------------------------------------------------------
// SniperCrossfireScenario.js  ("Crossfire (AWP)")
//
// Crossfire with the AWP: hold the red circle to arm, bots always cross (no
// peek), spawn from either pillar at 250 u/s, one-shot kills in transit.
// ---------------------------------------------------------------------------

import { ArenaScenario } from './ArenaScenario.js';
import { beep } from './BaseScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

export class SniperCrossfireScenario extends ArenaScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.startScoped = 1;
    this.weaponBloom = true;
    this.viewmodelRecoil = true;
    this.showViewmodel = true;
    this.weaponTracers = true;
  }

  get name() {
    return 'snipercrossfire';
  }

  _allowPeek() {
    return false;
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const a = settings.data.snipercrossfire ?? DEFAULTS.snipercrossfire;
    return `col${a.columns}_cr${a.columnRadius}_r${a.ringRadius}_bd${a.botDistMin}-${a.botDistMax}_es${a.enemyScale}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SniperCrossfireScenario.configKeyFor(this.settings, this.variant);
  }

  onShoot(raycaster) {
    const colMeshes = this.columns;
    const hit = this.raycastTargets(raycaster, colMeshes);
    if (!hit) {
      this._penalizeMissShot();
      return;
    }
    const obj = hit.object;
    const tgt = obj.userData.target;
    if (!tgt) {
      this._penalizeMissShot();
      return;
    }

    if (tgt === this.circle && this.phase === 'ready') return;

    if (tgt === this.bot && this.phase === 'moving' && tgt.state !== 'dying') {
      this.crosshair?.hit();
      this.hits++;
      this.kills++;
      this.score += obj.userData.points;
      if (obj.userData.zone === 'head') this.headshots++;
      beep(1000, 0.05, 'square', 0.05);
      this._killBot();
    }
  }
}
