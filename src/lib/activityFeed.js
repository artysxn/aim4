// ---------------------------------------------------------------------------
// lib/activityFeed.js
// Fetching the two halves of the activity calendar and merging them.
//
// They come from different backends and that is not incidental. Trainer runs
// live in Supabase (`scores`, publicly readable, which is what makes the
// calendar public per account); demos live on the replay API behind the same
// visibility rules the library uses. So this module talks to both and folds
// them into one day map, and either half failing leaves the other standing.
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import { accessToken } from '../replays/api.js';
import { addToDay } from './activityCalendar.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trainer runs for one account over the window.
 *
 * `scores` carries one row per finished run with the seconds it actually took,
 * so this is measured time rather than a run count multiplied by a guess.
 * Playlist rows are skipped: their `time_played` is the sum of the modes
 * inside them, which are already rows of their own, and counting both would
 * double every routine.
 */
export async function fetchTrainerActivity(userId, days = 90) {
  if (!supabaseConfigured() || !userId) return [];
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const sb = getSupabase();
  const { data, error } = await sb
    .from('scores')
    .select('created_at,time_played,scenario')
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(5000);
  if (error) {
    console.warn('[activity] trainer runs failed', error.message);
    return [];
  }
  return (data || [])
    .filter((row) => row.scenario !== 'playlist')
    .map((row) => ({
      at: Date.parse(row.created_at),
      seconds: Math.max(0, Number(row.time_played) || 0)
    }))
    .filter((r) => Number.isFinite(r.at));
}

/**
 * Matches one demo-side player appeared in over the window.
 *
 * Signed in, the token goes with the request so demos only this viewer may
 * read are counted too. Signed out it still answers, over the public library,
 * which is what makes the calendar public per account.
 */
export async function fetchDemoActivity(playerId, days = 90) {
  if (!playerId) return [];
  try {
    const token = await accessToken().catch(() => null);
    const res = await fetch(
      `${API_BASE}/api/replays/activity?player=${encodeURIComponent(playerId)}&days=${days}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined }
    );
    if (!res.ok) return [];
    const body = await res.json();
    return Array.isArray(body?.matches) ? body.matches : [];
  } catch {
    // Offline, or the replay API is not reachable from this page. The trainer
    // half still draws a calendar.
    return [];
  }
}

/**
 * Both halves, as the day map buildCalendar consumes.
 *
 * Each half is awaited independently so one backend being down does not blank
 * the whole panel; a calendar with only trainer squares is still true.
 *
 * @returns {Promise<Map<string, object>>}
 */
export async function fetchActivity({ userId = null, playerId = null, days = 90 } = {}) {
  const [trainer, demos] = await Promise.all([
    userId ? fetchTrainerActivity(userId, days).catch(() => []) : Promise.resolve([]),
    playerId ? fetchDemoActivity(playerId, days).catch(() => []) : Promise.resolve([])
  ]);

  const map = new Map();
  for (const run of trainer) {
    addToDay(map, run.at, { trainSeconds: run.seconds, trainRuns: 1 });
  }
  for (const match of demos) {
    addToDay(map, Number(match.at), {
      demoSeconds: Math.max(0, Number(match.seconds) || 0),
      demoMatches: 1
    });
  }
  return map;
}
