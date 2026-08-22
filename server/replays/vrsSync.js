// ---------------------------------------------------------------------------
// replays/vrsSync.js
// Copy Valve Regional Standings from GitHub when a newer date is published.
//
// Valve's live tree is
//   github.com/ValveSoftware/counter-strike_regional_standings/tree/main/live
// with a folder per year (2026 now, 2027 when that season starts) and files
// named standings_<region>_<YYYY>_<MM>_<DD>.md. A scan lists those folders,
// picks the newest date per region, and writes the markdown into the live
// standings dir so ingest sees current rosters.
//
// Clock: one pass at boot, then every day at 06:00 UTC. Not GitHub Actions.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseStandingsMarkdown } from '../../src/replays/shared/teamStandings.js';
import {
  VRS_REGIONS,
  compareStandingDates,
  latestStandingFiles,
  msUntilNextDailyUtc,
  parseStandingFileName,
  remoteStandingsAreNewer,
  standingFileName,
  yearDirsFromLiveListing
} from '../../src/replays/shared/vrsStandings.js';
import { forgetOrgIndex } from '../ingest/hltv/hltvNames.js';
import {
  forgetStandingTeams,
  liveStandingsDir,
  loadStandingTeams,
  loadedStandingSnapshot
} from './teamStandingsDb.js';

const GITHUB_CONTENTS =
  'https://api.github.com/repos/ValveSoftware/counter-strike_regional_standings/contents';
const USER_AGENT = 'aim4-vrs-sync';
const FETCH_MS = 20_000;

const MIN_TEAMS = {
  europe: 20,
  americas: 10,
  asia: 5
};

let timer = null;
let stopped = false;
let inflight = null;

function defaultFetch() {
  return globalThis.fetch;
}

async function githubJson(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT
    },
    signal: AbortSignal.timeout(FETCH_MS)
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`github ${res.status} for ${url}`);
  }
  return res.json();
}

async function githubText(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_MS)
  });
  if (!res.ok) throw new Error(`github ${res.status} for ${url}`);
  return res.text();
}

/**
 * Newest standings file per region across every year folder under live/.
 * @param {(url: string, init?: RequestInit) => Promise<Response>} fetchFn
 */
export async function fetchRemoteStandingFiles(fetchFn = defaultFetch()) {
  const live = await githubJson(`${GITHUB_CONTENTS}/live`, fetchFn);
  if (!Array.isArray(live)) {
    throw new Error('github live listing was not a directory');
  }
  const years = yearDirsFromLiveListing(live);
  if (!years.length) throw new Error('github live/ has no year folders');

  const entries = [];
  for (const year of years) {
    const listing = await githubJson(`${GITHUB_CONTENTS}/live/${year}`, fetchFn);
    if (!Array.isArray(listing)) continue;
    for (const item of listing) {
      if (!item || item.type === 'dir') continue;
      const parsed = parseStandingFileName(item.name);
      if (!parsed) continue;
      entries.push({
        name: item.name,
        downloadUrl:
          item.download_url ||
          `https://raw.githubusercontent.com/ValveSoftware/counter-strike_regional_standings/main/live/${year}/${item.name}`
      });
    }
  }
  const latest = latestStandingFiles(entries);
  for (const region of VRS_REGIONS) {
    const hit = latest[region];
    if (!hit) continue;
    const entry = entries.find((e) => e.name === hit.file);
    if (entry) hit.downloadUrl = entry.downloadUrl;
  }
  return latest;
}

async function writeAtomic(filePath, body) {
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, filePath);
}

async function pruneOlderLiveFiles(dir, region, keepFile) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keepFile || name === 'manifest.json') continue;
    const parsed = parseStandingFileName(name);
    if (parsed?.region !== region) continue;
    try {
      await fsp.unlink(path.join(dir, name));
    } catch {
      /* leftover from a previous date is optional */
    }
  }
}

async function downloadRegionMarkdown(region, remote, fetchFn) {
  if (!remote?.downloadUrl) throw new Error(`no download url for ${region}`);
  const md = await githubText(remote.downloadUrl, fetchFn);
  const teams = parseStandingsMarkdown(md, region);
  const min = MIN_TEAMS[region] ?? 5;
  if (teams.length < min) {
    throw new Error(`${region} snapshot parsed ${teams.length} teams (need ${min})`);
  }
  return md;
}

/**
 * Compare GitHub live/ to the on-disk snapshot. Copy any newer region files
 * into the live standings dir and drop the in-memory roster cache.
 *
 * @param {{ fetch?: typeof fetch, liveDir?: string }} [opts]
 */
export async function syncVrsStandings(opts = {}) {
  if (inflight) return inflight;
  inflight = runSync(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runSync(opts) {
  const fetchFn = opts.fetch || defaultFetch();
  const liveDir = opts.liveDir || liveStandingsDir();
  const local = loadedStandingSnapshot();
  const remote = await fetchRemoteStandingFiles(fetchFn);

  const missing = VRS_REGIONS.filter((r) => !remote[r]);
  if (missing.length) {
    console.warn(`[vrs] github listing missing ${missing.join(', ')}`);
  }
  if (!VRS_REGIONS.some((r) => remote[r])) {
    return { ok: false, updated: [], reason: 'no-remote-files' };
  }

  if (!remoteStandingsAreNewer(local, remote)) {
    const stamp = VRS_REGIONS.map((r) => `${r}=${local[r] || 'none'}`).join(' ');
    console.log(`[vrs] standings current (${stamp})`);
    return { ok: true, updated: [], snapshot: local };
  }

  await fsp.mkdir(liveDir, { recursive: true });

  const updated = [];
  const snapshot = { ...local };
  for (const region of VRS_REGIONS) {
    const hit = remote[region];
    if (!hit) continue;
    if (compareStandingDates(hit.date, local[region]) <= 0) continue;
    const md = await downloadRegionMarkdown(region, hit, fetchFn);
    const file = standingFileName(region, hit.date);
    await writeAtomic(path.join(liveDir, file), md);
    await pruneOlderLiveFiles(liveDir, region, file);
    snapshot[region] = hit.date;
    updated.push({ region, date: hit.date, file });
  }

  if (!updated.length) {
    return { ok: true, updated: [], snapshot };
  }

  const manifest = {
    fetchedAt: new Date().toISOString(),
    regions: Object.fromEntries(
      VRS_REGIONS.map((region) => [
        region,
        snapshot[region]
          ? { date: snapshot[region], file: standingFileName(region, snapshot[region]) }
          : null
      ])
    )
  };
  await writeAtomic(path.join(liveDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  forgetStandingTeams();
  forgetOrgIndex();
  loadStandingTeams();

  console.log(
    `[vrs] updated ${updated.map((u) => `${u.region} ${u.date}`).join(', ')}`
  );
  return { ok: true, updated, snapshot };
}

function nextDelayMs(nowMs = Date.now()) {
  const forced = Number(process.env.AIM4_VRS_SYNC_INTERVAL_MS || 0);
  if (forced > 0) return forced;
  return msUntilNextDailyUtc(nowMs);
}

function armTimer(delayMs) {
  timer = setTimeout(() => {
    syncVrsStandings()
      .catch((err) => {
        console.warn('[vrs] sync failed:', err?.message || err);
      })
      .finally(() => {
        if (!stopped) armTimer(nextDelayMs());
      });
  }, delayMs);
  timer.unref?.();
}

/**
 * Scan at boot, then once a day on the process clock.
 * Set AIM4_VRS_SYNC=0 to leave the bundled snapshot alone.
 */
export function startVrsSync() {
  if (timer) return null;
  if (process.env.AIM4_VRS_SYNC === '0') return null;
  stopped = false;
  const bootDelay = Number(process.env.AIM4_VRS_SYNC_BOOT_DELAY_MS || 15_000);
  armTimer(Math.max(0, bootDelay));
  return timer;
}

export function stopVrsSync() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
