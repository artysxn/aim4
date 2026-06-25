// Leaderboard ranking + competitive config keys.

export const COMPETITIVE_CONFIG_KEY = 'competitive';

/** Competitive runs submit to cloud leaderboards (Practice does not). */
export const RANKED_SCENARIOS = new Set([
  'gridshot',
  'pasu',
  'spidershot',
  'survival',
  'arena',
  'duels',
  'range'
]);

/** Ranked by total kills in the best timed run. */
export const KILL_LEADERBOARD_SCENARIOS = new Set([
  'gridshot',
  'pasu',
  'spidershot',
  'arena',
  'duels',
  'range'
]);

export function isRankedScenario(scenario) {
  return RANKED_SCENARIOS.has(scenario);
}

export function isLeaderboardEligible(scenario, variant) {
  return variant === 'competitive' && isRankedScenario(scenario);
}

export function isKillLeaderboardScenario(scenario) {
  return KILL_LEADERBOARD_SCENARIOS.has(scenario);
}

export function configKeyForVariant(variant) {
  return variant === 'competitive' ? COMPETITIVE_CONFIG_KEY : null;
}
