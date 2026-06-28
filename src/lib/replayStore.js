// ---------------------------------------------------------------------------
// lib/replayStore.js — replay sync (Supabase hybrid storage)
//
// Payload (gzipped telemetry) → Storage bucket `replays`; metadata → Postgres
// `replays` table. Paths are deterministic so each upload OVERWRITES the prior
// one (upsert): exactly one `last` per scenario+variant and one `best` per
// competitive scenario. This keeps the bucket flat — storage never grows with
// the number of runs a player completes.
// ---------------------------------------------------------------------------

import { getSupabase, supabaseConfigured } from './supabase.js';
import { encodeReplay, decodeReplay } from './replayCodec.js';
import { isKillLeaderboardScenario } from '../scenarios/leaderboardConfig.js';

const BUCKET = 'replays';

/** Deterministic, overwrite-in-place path: {uid}/{scenario}/{variant}/{slot}.rpl */
function pathFor(userId, scenario, variant, slot) {
  return `${userId}/${scenario}/${variant}/${slot}.rpl`;
}

/** True when `a` is a strictly better run than `b` (same ranking as leaderboards). */
function isBetterRun(scenario, a, b) {
  if (!b) return true;
  if (isKillLeaderboardScenario(scenario)) {
    const ka = a.kills ?? a.score ?? 0;
    const kb = b.kills ?? b.score ?? 0;
    if (ka !== kb) return ka > kb;
    return (a.accuracy ?? 0) > (b.accuracy ?? 0);
  }
  return (a.score ?? 0) > (b.score ?? 0);
}

/** Coerce the analytics aggregate into nullable DB columns (or {} when absent). */
function analyticsColumns(analytics) {
  if (!analytics || typeof analytics !== 'object') return {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    flicks_accurate: num(analytics.flicks_accurate),
    flicks_over: num(analytics.flicks_over),
    flicks_under: num(analytics.flicks_under),
    clicks_early: num(analytics.clicks_early),
    clicks_accurate: num(analytics.clicks_accurate),
    clicks_late: num(analytics.clicks_late),
    click_early_ms: num(analytics.click_early_ms),
    click_late_ms: num(analytics.click_late_ms),
    tension_pct: num(analytics.tension_pct),
    flick_speed_ms: num(analytics.flick_speed_ms),
    flick_accuracy_pct: num(analytics.flick_accuracy_pct)
  };
}

function summaryRow(userId, recording, results, slot, path, encoded, analytics) {
  return {
    user_id: userId,
    scenario: recording.scenario,
    config_key: recording.configKey,
    variant: recording.variant,
    slot,
    score: Math.round(Number(results?.score) || 0),
    accuracy: Number(results?.accuracy) || 0,
    kills: Math.round(Number(results?.kills) || 0),
    duration: encoded.summary.durationSec,
    tick_rate: 128,
    byte_size: encoded.summary.bytes,
    replay_file_path: path,
    ...analyticsColumns(analytics)
  };
}

async function uploadPayload(sb, path, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    upsert: true,
    contentType: 'application/octet-stream'
  });
  return error;
}

async function upsertRow(sb, row) {
  const { error } = await sb
    .from('replays')
    .upsert(row, { onConflict: 'user_id,scenario,variant,slot' });
  return error;
}

async function verifyReplayRow(sb, uid, scenario, variant, slot, expectedPath) {
  const { data, error } = await sb
    .from('replays')
    .select('replay_file_path')
    .eq('user_id', uid)
    .eq('scenario', scenario)
    .eq('variant', variant)
    .eq('slot', slot)
    .maybeSingle();
  if (error || !data) return false;
  return data.replay_file_path === expectedPath;
}

/**
 * Persist a finished run's replay. Always writes the `last` slot for the run's
 * variant; for competitive runs it also writes/overwrites `best` when the run
 * beats the stored best. Safe no-op when offline / not signed in.
 *
 * @returns {Promise<{ ok:boolean, slots?:string[], reason?:string }>}
 */
export async function saveReplay(userId, recording, results, analytics = null) {
  if (!supabaseConfigured()) return { ok: false, reason: 'offline' };
  if (!userId || !recording) return { ok: false, reason: 'no recording' };

  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  const uid = session?.user?.id || userId;
  if (!uid) return { ok: false, reason: 'not signed in' };

  let encoded;
  try {
    encoded = await encodeReplay(recording);
  } catch (e) {
    console.warn('[replayStore] encode failed', e);
    return { ok: false, reason: 'encode failed' };
  }

  const { scenario, variant } = recording;
  const written = [];

  // --- last slot (every run) ------------------------------------------------
  const lastPath = pathFor(uid, scenario, variant, 'last');
  let err = await uploadPayload(sb, lastPath, encoded.bytes);
  if (!err) err = await upsertRow(sb, summaryRow(uid, recording, results, 'last', lastPath, encoded, analytics));
  if (err) {
    console.warn('[replayStore] save last failed', err.message);
    return { ok: false, reason: err.message };
  }
  const lastVerified = await verifyReplayRow(sb, uid, scenario, variant, 'last', lastPath);
  if (!lastVerified) {
    console.warn('[replayStore] last replay verify failed');
    return { ok: false, reason: 'database verify failed' };
  }
  written.push('last');

  // --- best slot (competitive only, when it beats the stored best) ----------
  if (variant === 'competitive') {
    const { data: existing } = await sb
      .from('replays')
      .select('score, accuracy, kills')
      .eq('user_id', uid)
      .eq('scenario', scenario)
      .eq('variant', 'competitive')
      .eq('slot', 'best')
      .maybeSingle();

    const candidate = {
      score: Math.round(Number(results?.score) || 0),
      accuracy: Number(results?.accuracy) || 0,
      kills: Math.round(Number(results?.kills) || 0)
    };

    if (isBetterRun(scenario, candidate, existing)) {
      const bestPath = pathFor(uid, scenario, variant, 'best');
      let bErr = await uploadPayload(sb, bestPath, encoded.bytes);
      if (!bErr) {
        bErr = await upsertRow(sb, summaryRow(uid, recording, results, 'best', bestPath, encoded, analytics));
      }
      if (bErr) console.warn('[replayStore] save best failed', bErr.message);
      else {
        const bestVerified = await verifyReplayRow(sb, uid, scenario, variant, 'best', bestPath);
        if (!bestVerified) console.warn('[replayStore] best replay verify failed');
        else written.push('best');
      }
    }
  }

  return { ok: true, slots: written, verified: true, lastPath, shareMeta: {
    scenario: recording.scenario,
    config_key: recording.configKey,
    variant: recording.variant,
    score: Math.round(Number(results?.score) || 0),
    accuracy: Number(results?.accuracy) || 0,
    kills: Math.round(Number(results?.kills) || 0),
    duration: encoded.summary.durationSec,
    settings: recording.settings || {},
    ...analyticsColumns(analytics)
  } };
}

/** Fetch a replay's metadata row (or null). */
export async function fetchReplayMeta(userId, scenario, variant, slot) {
  if (!supabaseConfigured() || !userId) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('replays')
    .select('*')
    .eq('user_id', userId)
    .eq('scenario', scenario)
    .eq('variant', variant)
    .eq('slot', slot)
    .maybeSingle();
  if (error) {
    console.warn('[replayStore] meta fetch failed', error.message);
    return null;
  }
  return data;
}

/** All replay metadata rows for an account (for the My Account page). */
export async function listAccountReplays(userId) {
  if (!supabaseConfigured() || !userId) return [];
  const sb = getSupabase();

  const { data: rpcData, error: rpcError } = await sb.rpc('get_account_replays', {
    p_user_id: userId
  });
  if (!rpcError && Array.isArray(rpcData)) return rpcData;

  const { data, error } = await sb
    .from('replays')
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[replayStore] list failed', error.message);
    throw new Error(error.message);
  }
  return data || [];
}

/** Download + decode a replay payload from its storage path. */
export async function loadReplayByPath(path) {
  if (!supabaseConfigured() || !path) return null;
  const sb = getSupabase();
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) {
    console.warn('[replayStore] download failed', error?.message);
    return null;
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  try {
    return await decodeReplay(bytes);
  } catch (e) {
    console.warn('[replayStore] decode failed', e);
    return null;
  }
}

/** Convenience: resolve metadata then download+decode the payload. */
export async function loadReplay(userId, scenario, variant, slot) {
  const meta = await fetchReplayMeta(userId, scenario, variant, slot);
  if (!meta) return null;
  const replay = await loadReplayByPath(meta.replay_file_path);
  return replay ? { meta, replay } : null;
}

const SHARED_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build a permanent share URL for a shared replay id. */
export function sharedReplayUrl(id) {
  const u = new URL(window.location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('replay', id);
  return u.href;
}

export function isSharedReplayId(id) {
  return SHARED_UUID_RE.test(String(id || ''));
}

async function downloadBytes(sb, path) {
  const { data, error } = await sb.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(error?.message || 'Could not read replay file.');
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Copy a replay into permanent shared storage and register a public link row.
 * Pass either `recording` (+ optional results) or `sourcePath` (+ shareMeta).
 *
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function createSharedReplay({
  userId,
  username,
  sourcePath = null,
  recording = null,
  results = null,
  shareMeta = null
}) {
  if (!supabaseConfigured()) throw new Error('Replays are not configured.');
  if (!userId) throw new Error('Sign in to share replays.');

  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user?.id) throw new Error('Sign in to share replays.');

  const id = crypto.randomUUID();
  const destPath = `shared/${id}.rpl`;
  let bytes;
  let meta = shareMeta;

  if (recording) {
    const encoded = await encodeReplay(recording);
    bytes = encoded.bytes;
    meta = {
      scenario: recording.scenario,
      config_key: recording.configKey,
      variant: recording.variant,
      score: Math.round(Number(results?.score) || 0),
      accuracy: Number(results?.accuracy) || 0,
      kills: Math.round(Number(results?.kills) || 0),
      duration: encoded.summary.durationSec,
      settings: recording.settings || {}
    };
  } else if (sourcePath) {
    bytes = await downloadBytes(sb, sourcePath);
    if (!meta?.scenario) throw new Error('Replay metadata missing.');
    if (!meta.settings || !Object.keys(meta.settings).length) {
      try {
        const decoded = await decodeReplay(bytes);
        meta = { ...meta, settings: decoded.settings || {} };
      } catch (e) {
        console.warn('[replayStore] could not read settings from replay file', e);
      }
    }
  } else {
    throw new Error('Nothing to share.');
  }

  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const { error: upErr } = await sb.storage.from(BUCKET).upload(destPath, blob, {
    upsert: false,
    contentType: 'application/octet-stream'
  });
  if (upErr) throw new Error(upErr.message);

  const row = {
    id,
    user_id: userId,
    username: username || 'Player',
    scenario: meta.scenario,
    config_key: meta.config_key,
    variant: meta.variant,
    score: meta.score ?? null,
    accuracy: meta.accuracy ?? null,
    kills: meta.kills ?? null,
    duration: meta.duration ?? null,
    tick_rate: 128,
    byte_size: bytes.length,
    replay_file_path: destPath,
    settings: meta.settings || {},
    ...analyticsColumns(meta)
  };

  const { error: insErr } = await sb.from('shared_replays').insert(row);
  if (insErr) throw new Error(insErr.message);

  return { id, url: sharedReplayUrl(id) };
}

/** Load a permanent shared replay by public id. */
export async function fetchSharedReplay(id) {
  if (!supabaseConfigured() || !isSharedReplayId(id)) return null;
  const sb = getSupabase();
  const { data, error } = await sb
    .from('shared_replays')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('[replayStore] shared meta fetch failed', error.message);
    return null;
  }
  if (!data) return null;
  const replay = await loadReplayByPath(data.replay_file_path);
  if (!replay) return null;
  return { meta: data, replay };
}
