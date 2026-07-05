// ---------------------------------------------------------------------------
// PitRifleScenario.js  ("Pit (Rifle)")
//
// Ring pit quickscope drill with the rifle — same arena as Pit (AWP) but
// standard post-kill spawn timing (no extra AWP delay).
// ---------------------------------------------------------------------------

import { SniperQuickscopesScenario } from './SniperQuickscopesScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

export class PitRifleScenario extends SniperQuickscopesScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'rifle';
    this.postKillSpawnExtra = 0;
  }

  get name() {
    return 'pitrifle';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.pitrifle ?? DEFAULTS.pitrifle;
    return `r${c.rowCount}_b${c.coverPerRow}_d${settings.data.runDuration}`;
  }

  configKey() {
    return PitRifleScenario.configKeyFor(this.settings, this.variant);
  }
}
