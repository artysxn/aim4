// ---------------------------------------------------------------------------
// SniperDuelsScenario.js — Sniper (Peeks) + Sniper (Holds)
//
// Both reuse the Duels arenas and bot, but pin the round type and hand YOU the
// AWP-style sniper while the bot keeps its rifle. One body shot drops the bot.
//
//   • Sniper (Peeks): the duels OFFENSIVE round — the bot fights in the open
//     and you must peek out of your cover to pick it off.
//   • Sniper (Holds): the duels DEFENSIVE round — you hold the open angle
//     while the bot jiggle/hold-peeks its cover.
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

export class SniperPeeksScenario extends SniperDuelsBase {
  constructor(opts) {
    super(opts);
    this.duelMode = 'offensive';
  }

  get name() {
    return 'sniperpeeks';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const d = settings.data.sniperpeeks ?? settings.data.duels;
    return duelsArenaConfigKey(ARENAS, d.arena, settings.data.runDuration);
  }

  configKey() {
    return SniperPeeksScenario.configKeyFor(this.settings, this.variant);
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
