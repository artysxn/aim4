// ---------------------------------------------------------------------------
// lib/aimStats.js — cross-player aim analytics log + aggregation
//
// Every COMPETITIVE run appends one immutable row to `aim_run_stats` (flick
// speed / accuracy / tension + the flick/click tallies). Profile pages read it
// back through the `get_aim_stats` RPC, which aggregates with optional filters
// (a specific player vs the global baseline, a scenario, the last N games, or a
// time window) so players can compare their aim against everyone else's.
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';

/** Selectable recency filters for the profile aim-stats panel. */
export const AIM_STAT_FILTERS = [
  { id: 'all', label: 'All time' },
  { id: 'g10', label: 'Last 10 games', lastN: 10 },
  { id: 'g25', label: 'Last 25 games', lastN: 25 },
  { id: 'g100', label: 'Last 100 games', lastN: 100 },
  { id: 'h24', label: 'Last 24 hours', hours: 24 },
  { id: 'd7', label: 'Last 7 days', hours: 24 * 7 },
  { id: 'd30', label: 'Last 30 days', hours: 24 * 30 }
];

export function aimFilterById(id) {
  return AIM_STAT_FILTERS.find((f) => f.id === id) || AIM_STAT_FILTERS[0];
}

/** Modes where you hold fire and score per frame on target (Strafes-style). */
const HOLD_FIRE_SCENARIOS = new Set(['tracking', 'ball']);

/**
 * Append a finished competitive run's aim analytics. Fire-and-forget; safe
 * no-op when offline / not signed in / not a competitive run.
 */
export async function logAimRun(userId, recording, analytics) {
  if (!supabaseConfigured() || !userId || !recording || !analytics) return;
  if (recording.variant !== 'competitive') return;
  const sb = getSupabase();
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const row = {
    user_id: userId,
    scenario: recording.scenario,
    config_key: recording.configKey,
    variant: recording.variant,
    flick_speed_ms: n(analytics.flick_speed_ms),
    flick_accuracy_pct: n(analytics.flick_accuracy_pct),
    flicks_measured: n(analytics.flicks_measured),
    flicks_accurate: n(analytics.flicks_accurate),
    flicks_over: n(analytics.flicks_over),
    flicks_under: n(analytics.flicks_under),
    clicks_early: n(analytics.clicks_early),
    clicks_accurate: n(analytics.clicks_accurate),
    clicks_late: n(analytics.clicks_late),
    click_early_ms: n(analytics.click_early_ms),
    click_late_ms: n(analytics.click_late_ms),
    tension_pct: n(analytics.tension_pct),
    // Hold-fire modes (points per frame on target) rate tracking across the
    // whole run; everything else rates each engagement (first touch → kill).
    tracking_pct: n(
      HOLD_FIRE_SCENARIOS.has(recording.scenario) ? analytics.on_target_pct : analytics.tracking_pct
    ),
    reaction_ms: n(analytics.reaction_ms),
    adjustments_per_target: n(analytics.adjustments_per_target),
    speed_deg_s: n(analytics.speed_deg_s)
  };
  const { error } = await sb.from('aim_run_stats').insert(row);
  if (error) console.warn('[aimStats] log failed', error.message);
}

/**
 * Aggregate aim stats via the RPC.
 * @param {{ userId?:string|null, scenario?:string|null, lastN?:number|null, sinceHours?:number|null }} opts
 * @returns {Promise<object|null>} aggregated row, or null when offline/empty
 */
export async function fetchAimStats({ userId = null, scenario = null, lastN = null, sinceHours = null } = {}) {
  if (!supabaseConfigured()) return null;
  const sb = getSupabase();
  const since = sinceHours ? new Date(Date.now() - sinceHours * 3600 * 1000).toISOString() : null;
  const { data, error } = await sb.rpc('get_aim_stats', {
    p_user_id: userId,
    p_scenario: scenario,
    p_last_n: lastN ?? null,
    p_since: since
  });
  if (error) {
    console.warn('[aimStats] fetch failed', error.message);
    return null;
  }
  return (Array.isArray(data) ? data[0] : data) || null;
}

/**
 * Fetch a player's aim stats alongside the global baseline for the same filter.
 * @returns {Promise<{ player:object|null, global:object|null }>}
 */
export async function fetchAimComparison(userId, filterId = 'all', scenario = null) {
  const f = aimFilterById(filterId);
  const opts = { scenario, lastN: f.lastN ?? null, sinceHours: f.hours ?? null };
  const [player, global] = await Promise.all([
    fetchAimStats({ ...opts, userId }),
    fetchAimStats({ ...opts, userId: null })
  ]);
  return { player, global };
}
