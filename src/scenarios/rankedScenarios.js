// Scenarios whose Competitive variant submits to cloud leaderboards.
export const RANKED_SCENARIOS = new Set(['survival']);

export function isRankedScenario(scenario) {
  return RANKED_SCENARIOS.has(scenario);
}

export function isLeaderboardEligible(scenario, variant) {
  return variant === 'competitive' && isRankedScenario(scenario);
}
