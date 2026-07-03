// Leaderboard ranking + competitive config keys.

export const COMPETITIVE_CONFIG_KEY = 'competitive';

/** Competitive runs submit to cloud leaderboards (Practice does not). */
export const RANKED_SCENARIOS = new Set([
  'gridshot',
  'stars',
  'bounce',
  'microflicks',
  'pasu',
  'spidershot',
  'survival',
  'arena',
  'duels',
  'range',
  'tracking',
  'deathmatch',
  'sequence',
  'double',
  'ball',
  'bouncetracking',
  'pasutracking',
  'turn'
]);

/** Ranked by total kills in the best timed run. */
export const KILL_LEADERBOARD_SCENARIOS = new Set([
  'gridshot',
  'stars',
  'bounce',
  'microflicks',
  'pasu',
  'spidershot',
  'arena',
  'duels',
  'range',
  'deathmatch',
  'sequence',
  'double',
  'bouncetracking',
  'pasutracking',
  'turn'
]);

/** Ranked by highest score in the best timed run. */
export const SCORE_LEADERBOARD_SCENARIOS = new Set(['survival', 'tracking', 'ball']);

export function isRankedScenario(scenario) {
  return RANKED_SCENARIOS.has(scenario);
}

export function isLeaderboardEligible(scenario, variant) {
  return variant === 'competitive' && isRankedScenario(scenario);
}

export function isKillLeaderboardScenario(scenario) {
  return KILL_LEADERBOARD_SCENARIOS.has(scenario);
}

export function isScoreLeaderboardScenario(scenario) {
  return SCORE_LEADERBOARD_SCENARIOS.has(scenario);
}

export function configKeyForVariant(variant) {
  return variant === 'competitive' ? COMPETITIVE_CONFIG_KEY : null;
}
