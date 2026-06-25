// ---------------------------------------------------------------------------
// lib/cloudScores.js — account leaderboard reads + score submission
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import { GridshotScenario } from '../scenarios/GridshotScenario.js';

function isMissingColumnError(error) {
  const msg = error?.message || '';
  return /column|Could not find|schema cache|PGRST204/i.test(msg);
}

function finiteNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Gridshot boards are keyed by run duration; include legacy long keys too. */
function gridshotConfigKeys(configKey, runDuration) {
  const keys = new Set();
  if (configKey) keys.add(configKey);
  if (runDuration != null) keys.add(`d${runDuration}`);
  return [...keys];
}

function usernameFor(userId, profileMap) {
  if (profileMap?.[userId]) return profileMap[userId];
  return `player_${String(userId).replace(/-/g, '').slice(0, 8)}`;
}

function compareGridshot(a, b) {
  const ta = a.time_played ?? 0;
  const tb = b.time_played ?? 0;
  if (tb !== ta) return tb - ta;
  const ka = a.kpm ?? 0;
  const kb = b.kpm ?? 0;
  if (kb !== ka) return kb - ka;
  const la = a.kills ?? 0;
  const lb = b.kills ?? 0;
  if (lb !== la) return lb - la;
  const aa = a.accuracy ?? 0;
  const ab = b.accuracy ?? 0;
  if (ab !== aa) return ab - aa;
  return new Date(a.achieved_at).getTime() - new Date(b.achieved_at).getTime();
}

function compareDefault(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return new Date(a.achieved_at).getTime() - new Date(b.achieved_at).getTime();
}

function isBetterRun(scenario, row, prev) {
  if (!prev) return true;
  return scenario === 'gridshot'
    ? compareGridshot(row, prev) < 0
    : compareDefault(row, prev) < 0;
}

function normalizeRow(row, profileMap) {
  return {
    user_id: row.user_id,
    username: row.username || usernameFor(row.user_id, profileMap),
    score: row.score,
    accuracy: row.accuracy,
    crit_ratio: row.crit_ratio,
    kills: row.kills,
    time_played: row.time_played ?? null,
    kpm: row.kpm ?? (row.time_played > 0 && row.kills != null
      ? row.kills / (row.time_played / 60)
      : null),
    achieved_at: row.achieved_at || row.created_at
  };
}

async function fetchProfiles(sb, userIds) {
  if (!userIds.length) return {};
  const { data, error } = await sb.from('profiles').select('id, username').in('id', userIds);
  if (error) {
    console.warn('[cloudScores] profile lookup failed', error.message);
    return {};
  }
  return Object.fromEntries((data || []).map((p) => [p.id, p.username]));
}

async function selectScores(sb, scenario, configKey, fullSelect, baseSelect) {
  let data = null;
  let error = null;

  ({ data, error } = await sb
    .from('scores')
    .select(fullSelect)
    .eq('scenario', scenario)
    .eq('config_key', configKey));

  if (error && isMissingColumnError(error)) {
    ({ data, error } = await sb
      .from('scores')
      .select(baseSelect)
      .eq('scenario', scenario)
      .eq('config_key', configKey));
  }

  return { data, error };
}

/** Direct table read when RPC is missing or failing (works with base SETUP.md schema). */
async function fetchLeaderboardDirect(sb, scenario, configKey, limit) {
  const fullSelect =
    'user_id, score, accuracy, crit_ratio, kills, hits, shots, time_played, kpm, created_at';
  const baseSelect = 'user_id, score, accuracy, crit_ratio, kills, created_at';

  const runDuration =
    scenario === 'gridshot' ? GridshotScenario.runDurationFromKey(configKey) : null;
  const configKeys = scenario === 'gridshot'
    ? gridshotConfigKeys(configKey, runDuration)
    : [configKey];

  let data = [];
  let error = null;

  for (const key of configKeys) {
    const res = await selectScores(sb, scenario, key, fullSelect, baseSelect);
    error = res.error;
    if (error && !isMissingColumnError(error)) break;
    if (res.data?.length) data.push(...res.data);
  }

  // Legacy gridshot keys: s0.55_mclicking_…_d60 — match any board for this duration.
  if (
    scenario === 'gridshot' &&
    !data.length &&
    runDuration != null &&
    (!error || isMissingColumnError(error))
  ) {
    let legacy = null;
    let legacyErr = null;
    ({ data: legacy, error: legacyErr } = await sb
      .from('scores')
      .select(fullSelect)
      .eq('scenario', 'gridshot')
      .like('config_key', `%\\_d${runDuration}`));
    if (legacyErr && isMissingColumnError(legacyErr)) {
      ({ data: legacy, error: legacyErr } = await sb
        .from('scores')
        .select(baseSelect)
        .eq('scenario', 'gridshot')
        .like('config_key', `%\\_d${runDuration}`));
    }
    if (legacy?.length) {
      data = legacy;
      error = null;
    } else if (legacyErr) {
      error = legacyErr;
    }
  }

  if (error && !isMissingColumnError(error)) {
    console.warn('[cloudScores] direct leaderboard query failed', error.message);
    return { list: [], error: error.message };
  }
  if (!data.length) return { list: [], error: null };

  const profileMap = await fetchProfiles(sb, [...new Set(data.map((r) => r.user_id))]);
  const bestByUser = new Map();

  for (const row of data) {
    const normalized = normalizeRow(
      { ...row, achieved_at: row.created_at },
      profileMap
    );
    const prev = bestByUser.get(row.user_id);
    if (isBetterRun(scenario, normalized, prev)) {
      bestByUser.set(row.user_id, normalized);
    }
  }

  const sorted = [...bestByUser.values()].sort((a, b) =>
    scenario === 'gridshot' ? compareGridshot(a, b) : compareDefault(a, b)
  );

  return { list: sorted.slice(0, limit), error: null };
}

/** Submit a finished run for the logged-in account. */
export async function submitScore(userId, results) {
  if (!supabaseConfigured()) return { ok: false, reason: 'offline' };

  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id || userId;
  if (!uid) return { ok: false, reason: 'not signed in' };

  const full = {
    user_id: uid,
    scenario: results.scenario,
    config_key: results.configKey,
    score: Math.round(finiteNum(results.score)),
    accuracy: finiteNum(results.accuracy),
    crit_ratio: finiteNum(results.critRatio),
    kills: Math.round(finiteNum(results.kills)),
    hits: Math.round(finiteNum(results.hits)),
    shots: Math.round(finiteNum(results.shots)),
    time_played: finiteNum(results.timePlayed),
    kpm: finiteNum(results.kpm)
  };

  let { error } = await sb.from('scores').insert(full);
  if (error && isMissingColumnError(error)) {
    const minimal = {
      user_id: uid,
      scenario: results.scenario,
      config_key: results.configKey,
      score: Math.round(results.score),
      accuracy: results.accuracy,
      crit_ratio: results.critRatio,
      kills: results.kills
    };
    ({ error } = await sb.from('scores').insert(minimal));
  }

  if (error) {
    console.warn('[cloudScores] submit failed', error.message, full);
    return { ok: false, reason: error.message };
  }
  return { ok: true };
}

/**
 * Best score per verified account for a scenario/config (not per session).
 * Returns { list, error } — list is empty when unavailable or no rows.
 */
export async function fetchLeaderboardWithMeta(scenario, configKey, limit = 10) {
  if (!supabaseConfigured()) {
    return { list: [], error: 'Supabase is not configured in this build.' };
  }

  const sb = getSupabase();

  // Prefer RPC (security definer on server) so reads are global even if RLS is tight.
  const { data: rpcData, error: rpcError } = await sb.rpc('get_leaderboard_top', {
    p_scenario: scenario,
    p_config_key: configKey,
    p_limit: limit
  });
  if (!rpcError && rpcData?.length) {
    return { list: rpcData, error: null };
  }

  // Direct read: required for gridshot legacy config keys; fallback when RPC missing.
  const direct = await fetchLeaderboardDirect(sb, scenario, configKey, limit);
  if (direct.list.length) return direct;

  if (rpcError) {
    console.warn('[cloudScores] leaderboard RPC failed', rpcError.message);
    return { list: [], error: rpcError.message };
  }
  return { list: [], error: direct.error };
}

/**
 * Best score per verified account for a scenario/config (not per session).
 * Returns [] when Supabase is unavailable.
 */
export async function fetchAccountLeaderboard(scenario, configKey, limit = 10) {
  const { list } = await fetchLeaderboardWithMeta(scenario, configKey, limit);
  return list;
}

/** Rank of the user's best score on this board (1-based), or null. */
export async function fetchUserRank(userId, scenario, configKey) {
  const { list } = await fetchLeaderboardWithMeta(scenario, configKey, 50);
  const idx = list.findIndex((r) => r.user_id === userId);
  return idx === -1 ? null : idx + 1;
}

/** Global ranked Elo board — every account with a profile row (default 1000). */
export async function fetchEloLeaderboardWithMeta(limit = 50) {
  if (!supabaseConfigured()) {
    return { list: [], error: 'Supabase is not configured in this build.' };
  }

  const sb = getSupabase();
  const cap = Math.max(1, Math.min(limit, 100));

  const { data: rpcData, error: rpcError } = await sb.rpc('get_elo_leaderboard_top', {
    p_limit: cap
  });
  if (!rpcError && rpcData?.length) {
    return { list: rpcData, error: null };
  }

  const { data, error } = await sb
    .from('profiles')
    .select('id, username, elo, created_at')
    .order('elo', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(cap);

  if (error) {
    console.warn('[cloudScores] elo leaderboard failed', error.message);
    return { list: [], error: rpcError?.message || error.message };
  }

  const list = (data || []).map((row) => ({
    user_id: row.id,
    username: row.username,
    elo: row.elo ?? 1000,
    joined_at: row.created_at
  }));

  return { list, error: null };
}

/** Rank on the global Elo board (1-based), or null if not on the fetched page. */
export async function fetchUserEloRank(userId, limit = 100) {
  const { list } = await fetchEloLeaderboardWithMeta(limit);
  const idx = list.findIndex((r) => r.user_id === userId);
  return idx === -1 ? null : idx + 1;
}
