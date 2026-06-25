// ---------------------------------------------------------------------------
// lib/cloudScores.js — account leaderboard reads + score submission
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';

/** Submit a finished run for the logged-in account. */
export async function submitScore(userId, results) {
  if (!supabaseConfigured() || !userId) return { ok: false, reason: 'offline' };
  const sb = getSupabase();
  const row = {
    user_id: userId,
    scenario: results.scenario,
    config_key: results.configKey,
    score: Math.round(results.score),
    accuracy: results.accuracy,
    crit_ratio: results.critRatio,
    kills: results.kills,
    hits: results.hits,
    shots: results.shots
  };
  const { error } = await sb.from('scores').insert(row);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

/**
 * Best score per verified account for a scenario/config (not per session).
 * Returns [] when Supabase is unavailable.
 */
export async function fetchAccountLeaderboard(scenario, configKey, limit = 10) {
  if (!supabaseConfigured()) return [];
  const sb = getSupabase();
  const { data, error } = await sb.rpc('get_leaderboard_top', {
    p_scenario: scenario,
    p_config_key: configKey,
    p_limit: limit
  });
  if (error) {
    console.warn('[cloudScores] leaderboard fetch failed', error.message);
    return [];
  }
  return data || [];
}

/** Rank of the user's best score on this board (1-based), or null. */
export async function fetchUserRank(userId, scenario, configKey) {
  const board = await fetchAccountLeaderboard(scenario, configKey, 50);
  const idx = board.findIndex((r) => r.user_id === userId);
  return idx === -1 ? null : idx + 1;
}
