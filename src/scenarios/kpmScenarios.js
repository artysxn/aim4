// Scenarios ranked by active time in mode, then KPM (not raw score).
export const KPM_SCENARIOS = new Set(['gridshot', 'pasu']);

export function isKpmScenario(scenario) {
  return KPM_SCENARIOS.has(scenario);
}
