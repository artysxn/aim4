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

function summaryRow(userId, recording, results, slot, path, encoded) {
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
    replay_file_path: path
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

/**
 * Persist a finished run's replay. Always writes the `last` slot for the run's
 * variant; for competitive runs it also writes/overwrites `best` when the run
 * beats the stored best. Safe no-op when offline / not signed in.
 *
 * @returns {Promise<{ ok:boolean, slots?:string[], reason?:string }>}
 */
export async function saveReplay(userId, recording, results) {
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
  if (!err) err = await upsertRow(sb, summaryRow(uid, recording, results, 'last', lastPath, encoded));
  if (err) {
    console.warn('[replayStore] save last failed', err.message);
    return { ok: false, reason: err.message };
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
        bErr = await upsertRow(sb, summaryRow(uid, recording, results, 'best', bestPath, encoded));
      }
      if (bErr) console.warn('[replayStore] save best failed', bErr.message);
      else written.push('best');
    }
  }

  return { ok: true, slots: written };
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
  const { data, error } = await sb
    .from('replays')
    .select('*')
    .eq('user_id', userId);
  if (error) {
    console.warn('[replayStore] list failed', error.message);
    return [];
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
