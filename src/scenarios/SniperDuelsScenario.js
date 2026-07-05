// ---------------------------------------------------------------------------
// SniperDuelsScenario.js — Duels (AWP)
//
// Reuses the Duels arenas and bot, but pins the round type and hands YOU the
// AWP while the bot keeps its rifle. One body shot drops the bot.
// ---------------------------------------------------------------------------

import { DuelsScenario, ARENAS } from './DuelsScenario.js';
import { duelsArenaConfigKey } from './duelsArenas.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

class SniperDuelsBase extends DuelsScenario {
  constructor(opts) {
    super(opts);
    this.weaponId = 'sniper';
  }
}

export class SniperHoldsScenario extends SniperDuelsBase {
  constructor(opts) {
    super(opts);
    this.duelMode = 'defensive';
  }

  get name() {
    return 'sniperholds';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const d = settings.data.sniperholds ?? settings.data.duels;
    return duelsArenaConfigKey(ARENAS, d.arena, settings.data.runDuration);
  }

  configKey() {
    return SniperHoldsScenario.configKeyFor(this.settings, this.variant);
  }
}
