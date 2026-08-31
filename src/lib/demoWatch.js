// ---------------------------------------------------------------------------
// lib/demoWatch.js
// The page-wide watch clock, and its two ends.
//
// One clock for the whole tab (openViewer can be called more than once in a
// session, and two clocks would double-count). The local store is authoritative
// for the running total because it works signed out; flushing to Supabase is
// what makes the number public per account.
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import { createWatchClock, watchDays } from './watchClock.js';
import { dayKey } from './activityCalendar.js';

/** Do not re-send a day whose total has not moved. */
const sent = new Map();
let clock = null;
let currentUserId = null;

/** Push today's total. Fire-and-forget: the local copy is the real record. */
async function flush(days) {
  if (!supabaseConfigured() || !currentUserId) return;
  const today = dayKey(Date.now());
  const seconds = Math.round(Number(days?.[today]) || 0);
  if (!seconds || sent.get(today) === seconds) return;
  sent.set(today, seconds);
  try {
    const sb = getSupabase();
    const { error } = await sb.rpc('set_demo_watch_time', { p_day: today, p_seconds: seconds });
    if (error) {
      // Let the next flush try again rather than treating this total as sent.
      sent.delete(today);
      console.warn('[watch] flush failed', error.message);
    }
  } catch {
    sent.delete(today);
  }
}

function ensure() {
  if (!clock) clock = createWatchClock({ onFlush: flush });
  return clock;
}

/** Tell the clock which account to publish under. Safe to call repeatedly. */
export function setWatchUser(userId) {
  currentUserId = userId || null;
}

/** A demo went on screen. `label` is the surface: 'timeline' or 'analyzer'. */
export function startWatching(label) {
  ensure().start(label);
}

/** The viewer closed. */
export function stopWatching() {
  clock?.stop();
}

/** Local per-day watch seconds, for the calendar when it is your own page. */
export function localWatchDays() {
  return watchDays();
}

/**
 * One account's watch seconds by day, from the public table.
 * @returns {Promise<Array<{at: number, seconds: number}>>}
 */
export async function fetchWatchActivity(userId, days = 90) {
  if (!supabaseConfigured() || !userId) return [];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceDay = dayKey(since.getTime());
  const sb = getSupabase();
  const { data, error } = await sb
    .from('demo_watch_time')
    .select('day,seconds')
    .eq('user_id', userId)
    .gte('day', sinceDay)
    .limit(400);
  if (error) {
    // The table arrives by hand (0017). Until it does, the calendar simply has
    // no watch half, which is better than a broken page.
    console.warn('[watch] history unavailable', error.message);
    return [];
  }
  return (data || [])
    .map((row) => ({
      // Midday local, so the calendar's own local-day bucketing cannot land it
      // on the wrong side of midnight.
      at: new Date(`${row.day}T12:00:00`).getTime(),
      seconds: Math.max(0, Number(row.seconds) || 0)
    }))
    .filter((r) => Number.isFinite(r.at));
}
