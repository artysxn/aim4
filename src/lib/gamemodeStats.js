// ---------------------------------------------------------------------------
// lib/gamemodeStats.js — per-gamemode account statistics reset
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import { deleteScenarioReplays } from './replayStore.js';
import { syncOverallAimRating } from './aimRating.js';

/**
 * Permanently delete all logged runs, leaderboard scores, and replays for one
 * scenario on the signed-in account, then refresh the profile aim rating.
 */
export async function resetGamemodeStats(userId, scenario) {
  if (!supabaseConfigured()) {
    throw new Error('Statistics reset requires an online connection.');
  }
  if (!userId) throw new Error('Sign in to reset statistics.');
  if (!scenario) throw new Error('No gamemode selected.');

  const sb = getSupabase();

  await deleteScenarioReplays(userId, scenario);

  const { error: aimErr } = await sb
    .from('aim_run_stats')
    .delete()
    .eq('user_id', userId)
    .eq('scenario', scenario);
  if (aimErr) throw new Error(aimErr.message);

  const { error: scoreErr } = await sb
    .from('scores')
    .delete()
    .eq('user_id', userId)
    .eq('scenario', scenario);
  if (scoreErr) throw new Error(scoreErr.message);

  await syncOverallAimRating(userId);

  return { ok: true };
}
