// ---------------------------------------------------------------------------
// replays/shared/vrsStandings.js
// Valve Regional Standings filenames and "which snapshot is newest".
//
// Valve publishes markdown tables at
//   github.com/ValveSoftware/counter-strike_regional_standings/tree/main/live
// under live/<year>/standings_<region>_<YYYY>_<MM>_<DD>.md. A new year folder
// appears when that season starts. Pure helpers — no fs, no fetch.
// ---------------------------------------------------------------------------

export const VRS_REGIONS = ['europe', 'americas', 'asia'];

/** Daily scan hour (UTC). Valve's tables are not timestamped to the minute. */
export const VRS_SYNC_HOUR_UTC = 6;

const FILE_RE = /^standings_(europe|americas|asia)_(\d{4})_(\d{2})_(\d{2})\.md$/;
const DATE_RE = /^(\d{4})_(\d{2})_(\d{2})$/;
const YEAR_RE = /^\d{4}$/;

/**
 * @typedef {{ region: string, date: string, year: string, file: string }} StandingFileRef
 */

export function standingFileName(region, date) {
  return `standings_${region}_${date}.md`;
}

/** @returns {StandingFileRef | null} */
export function parseStandingFileName(name) {
  const m = FILE_RE.exec(String(name || ''));
  if (!m) return null;
  return {
    region: m[1],
    date: `${m[2]}_${m[3]}_${m[4]}`,
    year: m[2],
    file: m[0]
  };
}

/** Comparable integer YYYYMMDD, or 0 if the stamp is junk. */
export function standingDateKey(date) {
  const m = DATE_RE.exec(String(date || ''));
  if (!m) return 0;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Negative if a is older, 0 if equal, positive if a is newer. */
export function compareStandingDates(a, b) {
  return standingDateKey(a) - standingDateKey(b);
}

/**
 * Year folders under live/ (2026, then 2027, …).
 * @param {Array<{ name?: string, type?: string }>} entries
 * @returns {string[]}
 */
export function yearDirsFromLiveListing(entries) {
  return (entries || [])
    .filter((e) => e && e.type === 'dir' && YEAR_RE.test(String(e.name || '')))
    .map((e) => String(e.name))
    .sort();
}

/**
 * Newest file per region from a GitHub (or directory) listing.
 * Ignores global tables and the details/ folder.
 *
 * @param {Array<{ name?: string }>} entries
 * @returns {Record<string, StandingFileRef>}
 */
export function latestStandingFiles(entries) {
  /** @type {Record<string, StandingFileRef>} */
  const best = {};
  for (const entry of entries || []) {
    const parsed = parseStandingFileName(entry?.name);
    if (!parsed) continue;
    const prev = best[parsed.region];
    if (!prev || compareStandingDates(parsed.date, prev.date) > 0) {
      best[parsed.region] = parsed;
    }
  }
  return best;
}

/**
 * True when any remote region is newer than the local snapshot for that region.
 * @param {Record<string, string | null | undefined>} localDates
 * @param {Record<string, StandingFileRef | undefined>} remoteFiles
 */
export function remoteStandingsAreNewer(localDates, remoteFiles) {
  for (const region of VRS_REGIONS) {
    const remote = remoteFiles?.[region];
    if (!remote) continue;
    if (compareStandingDates(remote.date, localDates?.[region]) > 0) return true;
  }
  return false;
}

/**
 * Milliseconds until the next daily tick at `hourUtc`:00 UTC.
 * If `now` is exactly on the hour, that run already belongs to "today" and
 * the next tick is tomorrow.
 */
export function msUntilNextDailyUtc(nowMs, hourUtc = VRS_SYNC_HOUR_UTC) {
  const now = new Date(nowMs);
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0
  );
  if (nowMs >= next) {
    return next + 24 * 60 * 60 * 1000 - nowMs;
  }
  return next - nowMs;
}
