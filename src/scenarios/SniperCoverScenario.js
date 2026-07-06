// ---------------------------------------------------------------------------
// SniperCoverScenario.js  ("Cover (AWP)")
//
// Tiered cover gunfight with the AWP — one-shot bots and +0.7 s longer waits
// between kills than Cover (Rifle).
// ---------------------------------------------------------------------------

import { CoverScenario } from './CoverScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

export class SniperCoverScenario extends CoverScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
    this.postKillSpawnExtra = 0.7;
  }

  get name() {
    return 'coverawp';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const c = settings.data.coverawp ?? DEFAULTS.coverawp;
    return `r${c.rowCount}_b${c.coverPerRow}_l${c.losMissPenalty !== false ? 1 : 0}_d${settings.data.runDuration}`;
  }

  configKey() {
    return SniperCoverScenario.configKeyFor(this.settings, this.variant);
  }
}
