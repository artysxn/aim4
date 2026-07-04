// ---------------------------------------------------------------------------
// playTime.js — total play-time tracking on profiles
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';

/** Add finished-run seconds to the user's profile total (fire-and-forget). */
export async function incrementPlayTime(userId, seconds) {
  if (!supabaseConfigured() || !userId) return;
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return;
  const sb = getSupabase();
  const { error } = await sb.rpc('increment_play_time', {
    p_user_id: userId,
    p_seconds: sec
  });
  if (error) console.warn('[playTime] increment failed', error.message);
}

/** Human-readable play time: minutes under 1 h, else hours with one decimal. */
export function formatPlayTime(seconds) {
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return '0 min';
  const hours = sec / 3600;
  if (hours >= 1) return `${hours.toFixed(1)} hrs`;
  return `${Math.max(1, Math.round(sec / 60))} min`;
}
