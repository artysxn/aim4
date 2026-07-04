// ---------------------------------------------------------------------------
// ThreeshotScenario.js  ("Threeshot")
//
// Stars on a taller board: 3 tiny (0.075) dots on a canvas that extends twice
// as far vertically, so kills chain up-and-down as much as side-to-side.
// Optional horizontal drift (off by default) with a configurable max speed.
// ---------------------------------------------------------------------------

import { StarsScenario } from './StarsScenario.js';
import { competitivePresetFor } from './competitivePresets.js';
import { COMPETITIVE_CONFIG_KEY } from './leaderboardConfig.js';
import { DEFAULTS } from '../core/SettingsManager.js';

const BASE_BOUNDS_W = 9;
const BASE_BOUNDS_H = 5;
const DEFAULT_SIZE = 0.075;
const DEFAULT_COUNT = 3;
const DEFAULT_BOUNDS_SCALE_X = 2;
const DEFAULT_BOUNDS_SCALE_Y = 2; // twice as tall as Stars' board

export class ThreeshotScenario extends StarsScenario {
  constructor(opts) {
    const variant = opts.config?.variant === 'competitive' ? 'competitive' : 'practice';
    const preset = variant === 'competitive' ? competitivePresetFor('threeshot') : null;
    const t = variant === 'competitive' ? DEFAULTS.threeshot : (opts.settings?.data?.threeshot ?? {});
    const boundsScaleX =
      preset?.boundsScaleX ?? opts.config?.boundsScaleX ?? t.boundsScaleX ?? DEFAULT_BOUNDS_SCALE_X;
    const boundsScaleY =
      preset?.boundsScaleY ?? opts.config?.boundsScaleY ?? t.boundsScaleY ?? DEFAULT_BOUNDS_SCALE_Y;

    super({
      ...opts,
      // No Stars pad: the tall canvas IS the play area.
      config: { boundsPad: 0, ...opts.config, boundsScaleX, boundsScaleY }
    });

    this.targetSize = preset?.targetSize ?? this.config.targetSize ?? t.targetSize ?? DEFAULT_SIZE;
    this.targetCount = preset?.targetCount ?? this.config.targetCount ?? t.targetCount ?? DEFAULT_COUNT;
    this.floatEnabled = preset?.floatEnabled ?? this.config.floatEnabled ?? t.floatEnabled ?? false;
    this.floatSpeedMax = this.config.floatSpeedMax ?? t.floatSpeedMax ?? 2;
    this.boundsScaleX = boundsScaleX;
    this.boundsScaleY = boundsScaleY;
    this.boundsW = BASE_BOUNDS_W * this.boundsScaleX;
    this.boundsH = BASE_BOUNDS_H * this.boundsScaleY;
    this.runDuration = this.competitive
      ? (preset?.runDuration ?? 30)
      : this.settings.data.runDuration;
  }

  get name() {
    return 'threeshot';
  }

  static configKeyFor(settings, variant = 'practice') {
    if (variant === 'competitive') return COMPETITIVE_CONFIG_KEY;
    const t = settings.data.threeshot ?? {};
    return `s${t.targetSize ?? DEFAULT_SIZE}_n${t.targetCount ?? DEFAULT_COUNT}_f${t.floatEnabled ? 1 : 0}_d${settings.data.runDuration}`;
  }

  configKey() {
    return ThreeshotScenario.configKeyFor(this.settings, this.variant);
  }
}
