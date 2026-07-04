// ---------------------------------------------------------------------------
// aimRating.js — overall Aim4 Rating sync + leaderboard
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import {
  RATED_GAMEMODES,
  loadBaselines,
  syncBaselinesFromServer,
  baselinesForGamemode,
  composeRatingFromBestRuns,
  overallAimScoreFromModes,
  qualifiesForOverallAimRating
} from './aim4Ratings.js';
import { fetchAimRuns, aimFilterById } from './aimStats.js';

/** Build per-mode best-1 ratings and the combined overall score for one player. */
export async function computeOverallAimRating(userId, filterId = 'all', bestN = 1) {
  if (!userId) return null;
  await syncBaselinesFromServer();
  const config = loadBaselines();
  const f = aimFilterById(filterId);
  const opts = { lastN: f.lastN ?? null, sinceHours: f.hours ?? null };

  const perMode = await Promise.all(
    RATED_GAMEMODES.map(async (mode) => {
      const runs = await fetchAimRuns({ userId, scenario: mode, ...opts });
      if (!runs.length) return null;
      const rating = composeRatingFromBestRuns(
        runs,
        { baselines: baselinesForGamemode(mode, config) },
        bestN
      );
      if (!rating) return null;
      return { mode, rating };
    })
  );
  const usable = perMode.filter(Boolean);
  if (!qualifiesForOverallAimRating(usable)) return null;
  return overallAimScoreFromModes(usable);
}

/** Recompute and persist the signed-in user's overall rating (or clear if unqualified). */
export async function syncOverallAimRating(userId, filterId = 'all') {
  if (!supabaseConfigured() || !userId) return null;
  const score = await computeOverallAimRating(userId, filterId);
  const sb = getSupabase();
  const { error } = await sb.rpc('update_overall_aim_rating', {
    p_user_id: userId,
    p_rating: score
  });
  if (error) console.warn('[aimRating] sync failed', error.message);
  return score;
}

export async function fetchAimRatingLeaderboard(limit = 500) {
  if (!supabaseConfigured()) return [];
  const sb = getSupabase();
  const { data, error } = await sb.rpc('get_aim_rating_leaderboard', {
    p_limit: limit
  });
  if (error) {
    console.warn('[aimRating] leaderboard failed', error.message);
    return [];
  }
  return data || [];
}

/** { rank, total, overall_aim_rating } or null */
export async function fetchAimRatingRank(userId) {
  if (!supabaseConfigured() || !userId) return null;
  const sb = getSupabase();
  const { data, error } = await sb.rpc('get_aim_rating_rank', { p_user_id: userId });
  if (error) {
    console.warn('[aimRating] rank failed', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    rank: Number(row.rank),
    total: Number(row.total),
    overallAimRating: row.overall_aim_rating != null ? Number(row.overall_aim_rating) : null
  };
}

export async function lookupProfileByUsername(username) {
  if (!supabaseConfigured() || !username?.trim()) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('id, username, country_code, overall_aim_rating')
    .ilike('username', username.trim())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
