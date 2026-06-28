// ---------------------------------------------------------------------------
// accountStats.js — per-account ranks across gamemodes + global Elo
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import {
  RANKED_SCENARIOS,
  COMPETITIVE_CONFIG_KEY,
  isKillLeaderboardScenario,
  isScoreLeaderboardScenario
} from '../scenarios/leaderboardConfig.js';
import { fetchLeaderboardWithMeta, fetchEloLeaderboardWithMeta } from './cloudScores.js';

function rowFromRpc(data) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    rank: row.rank != null ? Number(row.rank) : null,
    total: row.total != null ? Number(row.total) : 0,
    score: row.score ?? null,
    kills: row.kills ?? null,
    accuracy: row.accuracy ?? null,
    kpm: row.kpm ?? null,
    timePlayed: row.time_played ?? null,
    elo: row.elo ?? null
  };
}

function fallbackScenarioRank(userId, scenario, list) {
  const idx = list.findIndex((r) => r.user_id === userId);
  const row = idx >= 0 ? list[idx] : null;
  return {
    rank: idx >= 0 ? idx + 1 : null,
    total: list.length,
    score: row?.score ?? null,
    kills: row?.kills ?? null,
    accuracy: row?.accuracy ?? null,
    kpm: row?.kpm ?? null,
    timePlayed: row?.time_played ?? null
  };
}

/** Rank on a scenario competitive board — { rank, total, …best run stats }. */
export async function fetchScenarioRank(userId, scenario, configKey = COMPETITIVE_CONFIG_KEY) {
  if (!supabaseConfigured() || !userId) {
    return { rank: null, total: 0, score: null, kills: null, accuracy: null, kpm: null, timePlayed: null };
  }

  const sb = getSupabase();
  const { data, error } = await sb.rpc('get_scenario_leaderboard_rank', {
    p_scenario: scenario,
    p_config_key: configKey,
    p_user_id: userId
  });

  if (!error && data?.length) {
    const parsed = rowFromRpc(data);
    if (parsed) return parsed;
  }

  if (error) {
    console.warn('[accountStats] scenario rank RPC failed', scenario, error.message);
  }

  const { list } = await fetchLeaderboardWithMeta(scenario, configKey, 500);
  return fallbackScenarioRank(userId, scenario, list);
}

/** Global ranked Elo rank — { rank, total, elo }. */
export async function fetchEloRank(userId) {
  if (!supabaseConfigured() || !userId) {
    return { rank: null, total: 0, elo: null };
  }

  const sb = getSupabase();
  const { data, error } = await sb.rpc('get_elo_leaderboard_rank', {
    p_user_id: userId
  });

  if (!error && data?.length) {
    const parsed = rowFromRpc(data);
    if (parsed) return parsed;
  }

  if (error) {
    console.warn('[accountStats] elo rank RPC failed', error.message);
  }

  const { list } = await fetchEloLeaderboardWithMeta(500);
  const idx = list.findIndex((r) => r.user_id === userId);
  return {
    rank: idx >= 0 ? idx + 1 : null,
    total: list.length,
    elo: idx >= 0 ? list[idx].elo : null
  };
}

/** All competitive ranks for the account page. */
export async function fetchAllAccountStats(userId) {
  const scenarios = [...RANKED_SCENARIOS];
  const [elo, ...ranks] = await Promise.all([
    fetchEloRank(userId),
    ...scenarios.map((s) => fetchScenarioRank(userId, s))
  ]);
  return {
    elo,
    modes: scenarios.map((scenario, i) => ({ scenario, ...ranks[i] }))
  };
}

/** Human-readable best-stat column for a mode row. */
export function formatModeStat(scenario, row) {
  if (row.rank == null) return '—';
  if (isScoreLeaderboardScenario(scenario)) {
    return row.score != null ? `${Math.round(row.score).toLocaleString()} pts` : '—';
  }
  if (isKillLeaderboardScenario(scenario)) {
    const kills = row.kills ?? row.score;
    if (kills == null) return '—';
    const acc =
      row.accuracy != null ? ` · ${Math.round(row.accuracy * 100)}% acc` : '';
    return `${Math.round(kills).toLocaleString()} kills${acc}`;
  }
  return row.score != null ? String(row.score) : '—';
}

/** "1 / 10" rank label; em dash when not on the board. */
export function formatRankLabel(rank, total) {
  if (!total) return '—';
  const pos = rank != null ? String(rank) : '—';
  return `${pos} / ${total}`;
}
