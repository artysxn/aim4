// ---------------------------------------------------------------------------
// PasuTrackingScenario.js  ("Pasu (Tracking)")
//
// Pasu with a tracking gate: the crosshair must sit on a target for the hold
// window (default 0.5 s) before it becomes shootable (Pasu's own tracking
// mode with click-resolve). Targets are slightly smaller and drift slower
// than base Pasu.
// ---------------------------------------------------------------------------

import { PasuScenario } from './PasuScenario.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';

export class PasuTrackingScenario extends PasuScenario {
  constructor(opts) {
    // Force Pasu's tracking mode with click resolve; the hold time, size and
    // speed come from this mode's own defaults/settings (resolved by the Pasu
    // constructor via this.name → DEFAULTS.pasutracking / settings.pasutracking).
    super({
      ...opts,
      config: {
        mode: 'tracking',
        trackResolve: 'click',
        ...opts.config
      }
    });
    // The gate is non-negotiable even if an imported config says otherwise.
    this.mode = 'tracking';
    this.trackResolve = 'click';
  }

  get name() {
    return 'pasutracking';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    return `d${settings.data.runDuration}`;
  }

  configKey() {
    return PasuTrackingScenario.configKeyFor(this.settings, this.variant);
  }
}
