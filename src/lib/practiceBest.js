// ---------------------------------------------------------------------------
// practiceBest.js — local personal-best scores for the pace bar (practice runs).
// ---------------------------------------------------------------------------

import * as Storage from '../utils/Storage.js';
import {
  isKillLeaderboardScenario,
  isLowerScoreLeaderboardScenario
} from '../scenarios/leaderboardConfig.js';

const STORAGE_KEY = 'practiceBest';

function store() {
  return Storage.read(STORAGE_KEY, {});
}

function entryKey(scenario, configKey) {
  return `${scenario}::${configKey || 'default'}`;
}

/** Score metric used for pacing / PB comparison for a scenario. */
export function paceMetric(scenario, sc) {
  if (isLowerScoreLeaderboardScenario(scenario)) return sc.score ?? 0;
  if (isKillLeaderboardScenario(scenario)) return sc.kills ?? 0;
  return sc.score ?? 0;
}

export function paceMetricFromResults(results) {
  if (isLowerScoreLeaderboardScenario(results.scenario)) return results.score ?? 0;
  if (isKillLeaderboardScenario(results.scenario)) return results.kills ?? 0;
  return results.score ?? 0;
}

export function getPracticeBest(scenario, configKey) {
  const row = store()[entryKey(scenario, configKey)];
  if (!row || !Number.isFinite(row.score)) return null;
  return row;
}

function isBetter(scenario, next, prev) {
  if (!prev || !Number.isFinite(prev.score)) return true;
  const n = Number(next);
  const p = Number(prev.score);
  if (!Number.isFinite(n)) return false;
  if (isLowerScoreLeaderboardScenario(scenario)) return n < p;
  return n > p;
}

/** Persist a new PB when the run beats the stored best. Returns the active PB row. */
export function updatePracticeBest(results) {
  const scenario = results.scenario;
  const key = entryKey(scenario, results.configKey);
  const data = store();
  const prev = data[key];
  const metric = paceMetricFromResults(results);
  if (!isBetter(scenario, metric, prev)) return prev ?? null;
  const row = {
    score: metric,
    timePlayed: results.timePlayed ?? 0,
    updatedAt: Date.now()
  };
  data[key] = row;
  Storage.write(STORAGE_KEY, data);
  return row;
}

/** True when the live metric is on pace to tie/beat the PB at this timestamp. */
export function isAheadOfPace(scenario, currentMetric, pbScore, currentTime, totalTime) {
  if (!Number.isFinite(pbScore) || pbScore <= 0 || !Number.isFinite(totalTime) || totalTime <= 0) {
    return null;
  }
  const t = Math.max(0, Math.min(currentTime, totalTime));
  const target = (pbScore / totalTime) * t;
  if (isLowerScoreLeaderboardScenario(scenario)) return currentMetric <= target;
  return currentMetric >= target;
}
