// Leaderboard ranking + competitive config keys.

export const COMPETITIVE_CONFIG_KEY = 'competitive';
export const CHALLENGE_CONFIG_KEY = 'challenge';

/** Fixed-rule challenge modes (always ranked; config key is `challenge`). */
export const CHALLENGE_SCENARIOS = new Set([
  'galaxy',
  'waves',
  'sequenceultra',
  'reactiontime'
]);

/** Competitive runs submit to cloud leaderboards (Practice does not). */
export const RANKED_SCENARIOS = new Set([
  'gridshot',
  'stars',
  'threeshot',
  'bounce',
  'microflicks',
  'pasu',
  'spidershot',
  'survival',
  'arena',
  'snipercrossfire',
  'cover',
  'duels',
  'range',
  'tracking',
  'deathmatch',
  'sequence',
  'sequencespeed',
  'sequencetracking',
  'double',
  'doubletracking',
  'ball',
  'drone',
  'line',
  'bouncetracking',
  'pasutracking',
  'turn',
  'box',
  'circle',
  'sniperholds',
  'sniperquickscopes',
  'pitrifle',
  'coverawp',
  'sniperflicks',
  'snipertracking',
  'doorsawp'
]);

/** Ranked by total kills in the best timed run. */
export const KILL_LEADERBOARD_SCENARIOS = new Set([
  'gridshot',
  'stars',
  'threeshot',
  'bounce',
  'microflicks',
  'pasu',
  'spidershot',
  'arena',
  'snipercrossfire',
  'cover',
  'duels',
  'range',
  'deathmatch',
  'sequence',
  'sequencespeed',
  'sequencetracking',
  'double',
  'doubletracking',
  'bouncetracking',
  'pasutracking',
  'turn',
  'box',
  'circle',
  'sniperholds',
  'sniperquickscopes',
  'pitrifle',
  'coverawp',
  'sniperflicks',
  'snipertracking',
  'doorsawp',
  'galaxy',
  'waves',
  'sequenceultra'
]);

/** Ranked by highest score in the best timed run. */
export const SCORE_LEADERBOARD_SCENARIOS = new Set(['survival', 'tracking', 'ball', 'drone', 'line']);

/** Ranked by lowest score in the best run (reaction time avg ms). */
export const LOWER_SCORE_LEADERBOARD_SCENARIOS = new Set(['reactiontime']);

export function isRankedScenario(scenario) {
  return RANKED_SCENARIOS.has(scenario);
}

export function isChallengeScenario(scenario) {
  return CHALLENGE_SCENARIOS.has(scenario);
}

export function isLeaderboardEligible(scenario, variant) {
  if (CHALLENGE_SCENARIOS.has(scenario)) return true;
  return variant === 'competitive' && isRankedScenario(scenario);
}

export function isKillLeaderboardScenario(scenario) {
  return KILL_LEADERBOARD_SCENARIOS.has(scenario);
}

export function isScoreLeaderboardScenario(scenario) {
  return SCORE_LEADERBOARD_SCENARIOS.has(scenario);
}

export function isLowerScoreLeaderboardScenario(scenario) {
  return LOWER_SCORE_LEADERBOARD_SCENARIOS.has(scenario);
}

export function configKeyForVariant(variant) {
  return variant === 'competitive' ? COMPETITIVE_CONFIG_KEY : null;
}
