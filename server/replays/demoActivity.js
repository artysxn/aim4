// ---------------------------------------------------------------------------
// server/replays/demoActivity.js
// How much time a player has spent inside demos, by day.
//
// Real seconds, not an estimate from a round count. Every demo record carries
// its rounds with `startTick`, `endTick` and the demo's tick rate, so the
// length of a match is arithmetic over data already in memory: no round file
// is reopened and no demo is reparsed. Rounds where the ticks are missing or
// nonsensical fall back to a stated average rather than silently contributing
// zero, because a match that obviously happened should not read as no time.
//
// The day a match counts toward is its `uploadedAt`, which is the same date
// the Database filters on. It is the library's notion of when a match
// happened, and using a second one here would put a match on one day in the
// table and another day in the calendar.
// ---------------------------------------------------------------------------

/** Round length used when a round's ticks cannot be trusted. */
const FALLBACK_ROUND_SECONDS = 115;
/** Longest a single round may contribute. Guards a corrupt endTick. */
const MAX_ROUND_SECONDS = 400;

/** Seconds one round lasted, from its ticks. */
export function roundSeconds(round, demoTickRate = 64) {
  const rate = Number(round?.tickRate) || Number(demoTickRate) || 64;
  const start = Number(round?.startTick);
  // `officialEndTick` includes the post-round time players actually sit
  // through; `endTick` is the last shot fired. The former is closer to time
  // spent, so it is preferred where the parser recorded it.
  const end = Number(round?.officialEndTick ?? round?.endTick);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(rate > 0)) {
    return FALLBACK_ROUND_SECONDS;
  }
  const seconds = (end - start) / rate;
  if (!(seconds > 0)) return FALLBACK_ROUND_SECONDS;
  return Math.min(MAX_ROUND_SECONDS, seconds);
}

/** Seconds one match lasted, summed over its rounds. */
export function matchSeconds(record) {
  const rounds = Array.isArray(record?.rounds) ? record.rounds : [];
  if (!rounds.length) return 0;
  let total = 0;
  for (const r of rounds) total += roundSeconds(r, record.tickRate);
  return Math.round(total);
}

/** Was this player on the scoreboard of this match? */
export function playedIn(record, playerId) {
  const id = String(playerId || '');
  if (!id) return false;
  for (const p of record?.players || []) {
    if (String(p?.id ?? p) === id) return true;
  }
  return false;
}

/**
 * Per-day demo activity for one player.
 *
 * @param {object[]} records demo records the caller may read
 * @param {string} playerId  the demo-side player id (not an account id)
 * @param {{ sinceMs?: number }} [opts]
 * @returns {Record<string, {demoSeconds: number, demoMatches: number}>}
 *   keyed by `YYYY-MM-DD` in UTC; the browser re-buckets to local time from
 *   the timestamps it is given, so the wire format stays timezone-free.
 */
export function demoActivityFor(records, playerId, { sinceMs = 0 } = {}) {
  const out = [];
  for (const record of records || []) {
    if ((record?.status || 'ready') !== 'ready') continue;
    const at = Number(record.uploadedAt || record.parsedAt || 0);
    if (!at || at < sinceMs) continue;
    if (!playedIn(record, playerId)) continue;
    out.push({ at, seconds: matchSeconds(record) });
  }
  return out;
}
