// ---------------------------------------------------------------------------
// GalaxyScenario.js  ("Galaxy" — challenge)
//
// Stars with challenge rules: exactly 6 dots up at once, a fixed 60-second
// clock, and a single missed shot ends the run immediately. No settings, no
// competitive split — the rules are the challenge.
// ---------------------------------------------------------------------------

import { StarsScenario } from './StarsScenario.js';

const GALAXY_COUNT = 6;
const GALAXY_DURATION = 60; // s
const GALAXY_DOT_SIZE = 0.14; // slightly larger than Stars' 200-dot swarm

export class GalaxyScenario extends StarsScenario {
  constructor(opts) {
    // Fixed rules override whatever the player has configured for Stars.
    super({
      ...opts,
      config: {
        ...opts.config,
        variant: undefined, // always practice-style; the challenge IS the rules
        targetSize: GALAXY_DOT_SIZE,
        targetCount: GALAXY_COUNT
      }
    });
    this.targetSize = GALAXY_DOT_SIZE;
    this.targetCount = GALAXY_COUNT;
    this.runDuration = GALAXY_DURATION;
    this.missLimit = 1; // one missed shot = game over
  }

  get name() {
    return 'galaxy';
  }

  static configKeyFor() {
    return 'challenge';
  }

  configKey() {
    return 'challenge';
  }
}
