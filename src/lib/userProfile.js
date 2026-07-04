// ---------------------------------------------------------------------------
// userProfile.js — public profile + cloud settings for other users' accounts
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';

/** Public profile row (username, flag, ELO). */
export async function fetchPublicProfile(userId) {
  if (!supabaseConfigured() || !userId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('id, username, elo, country_code, created_at, play_time_sec')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Cloud-synced settings payload for a user (null if never saved). */
export async function fetchPublicSettings(userId) {
  if (!supabaseConfigured() || !userId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('user_settings')
    .select('settings, updated_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) {
    return null;
  }
  return data.settings;
}
