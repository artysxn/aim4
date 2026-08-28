// ---------------------------------------------------------------------------
// replays/routes.js
// /api/replays/* — the demo library and the round collector.
//
//   GET    /api/replays/diag                     public crash / memory diagnostic
//   GET    /api/replays/status                   parser + quota
//   GET    /api/replays/demos                    library listing (?limit=&offset=)
//   POST   /api/replays/demos                    upload .dem or an archive of them
//   GET    /api/replays/uploads/:batchId         unpack + parse progress for one upload
//   POST   /api/replays/import                   upload a local .aim4replay package
//   GET    /api/replays/demos/:id                one demo + parse progress
//   POST   /api/replays/demos/:id/teams          rename both teams
//   POST   /api/replays/demos/:id/visibility     public / unlisted / private
//   POST   /api/replays/demos/:id/parse          re-run a failed parse
//   DELETE /api/replays/demos/:id                remove demo + its rounds
//   GET    /api/replays/rounds?...               filter by name, no file reads
//   POST   /api/replays/rounds/packs             meta + ticks for many rounds
//   GET    /api/replays/rounds/:file             round meta + events
//   GET    /api/replays/rounds/:file/ticks       tick buffer, ?stride=N&fmt=packed
//   GET    /api/replays/stats                    compact per-round index
//   POST   /api/replays/stats/refresh            rebuild missing / stale indexes
//   GET    /api/replays/playlists
//   GET    /api/replays/zones                    maps that have a zone file
//   GET    /api/replays/zones/:map               zone network for one map
//   POST   /api/replays/zones/:map               save zone polygons + names
//   GET    /api/replays/coach-smokes             maps with Autocoach smoke DB
//   GET    /api/replays/coach-smokes/:map        basic smoke landing spots
//   GET    /api/replays/demos/:id/comms          attached voice comms, or null
//   GET    /api/replays/demos/:id/comms/file     the .aim4comms container
//   POST   /api/replays/demos/:id/comms          upload a .aim4comms container
//   POST   /api/replays/demos/:id/comms/attach   speaker mapping / sync nudge
//   DELETE /api/replays/demos/:id/comms          detach
//
// Uploads stream straight to disk: a demo / package is hundreds of megabytes
// and must never be buffered in memory or pass through the JSON body reader.
// ---------------------------------------------------------------------------

import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
import { parserStatus } from '../demoparser/index.js';
import { MAX_FILE_BYTES as COMMS_FILE_MAX_BYTES } from '../../shared/comms/format.js';
import {
  ROOT,
  MAX_BYTES,
  MAX_UPLOAD_BYTES,
  NOTE_MAX,
  bumpDemoViews,
  checkQuota,
  deleteDemo,
  findRounds,
  listDemos,
  listNotedRounds,
  readPlaylists,
  readRecord,
  readSavedViews,
  removeSavedView,
  savedViewByShareId,
  upsertSavedView,
  readRoundMeta,
  readRoundTicks,
  readRoundTicksPacked,
  removePlaylist,
  renameDemoTeams,
  saveTempUpload,
  setDemoTags,
  setDemoVisibility,
  upsertPlaylist,
  usage,
  userDir,
  writeRecord,
  writeRoundNotes
} from './demoStore.js';
import { cpuProbe, memorySnapshot } from './hostMemory.js';
import { forgetDemoIndex, loadStoredEntry, patchIndexTeamNames, refreshLibraryStats, scheduleStatsIndex, STATS_LIBRARY_PAGE, statsPayload } from './statsIndex.js';
import { ColumnContractError, resolveColumns } from '../../src/replays/shared/statsColumns.js';
import { getRoster, invalidateRoster, scopeRoster } from './rosterCatalogue.js';
import { peerAverages, peerAveragesHot } from './peerAverages.js';
import {
  hotBuildProgress,
  hotRefreshing,
  hotStoreStatus,
  hotMatches,
  hotTables,
  patchHotStoreTeamNames
} from './statsHotService.js';
import { isAcceptedUpload, rarSupport } from './archive.js';
import {
  allJobs,
  batchStatus,
  enqueueParse,
  forgetJob,
  getBatch,
  jobStatus,
  releaseUploads,
  reservedUploads,
  reserveUploads,
  startIngest
} from './jobs.js';
import { SHARED_LIBRARY, authStatus, identify } from './auth.js';
import { LEGACY_UPLOADER, demoUploadIdentity, isConfigured, whoami } from './identity.js';
import { UNLIMITED } from '../../shared/entitlements/catalogue.js';
import { CAP } from '../../shared/entitlements/keys.js';
import {
  can,
  capability,
  checkLimit,
  requireCapability,
  requireLimit,
  requireQuota,
  upgradeResponse
} from '../entitlements/enforce.js';
import { guardImpersonation } from '../admin/guard.js';
import { ownedTeam, teamsOf } from './teamsStore.js';
import {
  accessFor,
  canManage,
  canSee,
  normalizeVisibility,
  ownerOf,
  recordForRoundFile,
  recordIdIndex,
  roundOwnerIndex,
  visibleDemoIds,
  visibleRecords
} from './visibility.js';
import { encodeRoundPacks } from '../../src/replays/shared/roundPackWire.js';
import { importReplayPackage } from './importPackage.js';
import { readChampion } from '../training/champion.js';
import { spawnsForMap } from './spawnPoints.js';
import { PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { clusterTeams } from '../../src/replays/shared/teamClusters.js';
import { getZones, listZoneMaps, saveZones } from '../zonesStore.js';
import { getCoachSmokes, listCoachSmokeMaps } from '../coachSmokesStore.js';
import {
  sampleLibraryOverlayEnabled,
  sampleDemosEnabled,
  listSampleRecords,
  getSampleRecord,
  getSamplePackageBytes,
  getSampleRoundMeta,
  getSampleRoundTicks,
  listSampleRoundNames
} from './sampleDemos.js';
import { collectRounds } from '../../src/replays/shared/roundFilter.js';

async function readRoundMetaMaybeSample(user, file) {
  return (await readRoundMeta(user, file)) || (await getSampleRoundMeta(file));
}

async function readRoundTicksMaybeSample(user, file, stride) {
  return (await readRoundTicks(user, file, stride)) || (await getSampleRoundTicks(file, stride));
}

/** What the stats index needs from storage, without importing it back. */
const statsIo = {
  userDir,
  readRoundMeta: readRoundMetaMaybeSample,
  readRoundTicks: readRoundTicksMaybeSample,
  getZones,
  getCoachUtilities: getCoachSmokes
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, X-Aim4-User, X-Aim4-Filename, X-Aim4-Visibility'
};

/**
 * Upload ceiling for a comms container.
 *
 * The recorder aims at 2 MB and packs its audio against that budget, so this
 * is the rail rather than the target: a chatty session at the codec's floor
 * can run a little over, and anything near this limit is not a comms file.
 */
const COMMS_MAX_BYTES = COMMS_FILE_MAX_BYTES;

function json(res, status, body, extraHeaders = null) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS,
    ...(extraHeaders || {})
  });
  res.end(payload);
}

/**
 * A JSON body big enough to be worth compressing.
 *
 * `json` above stays synchronous and uncompressed: most responses here are a
 * few hundred bytes and gzip would cost more than it saves. This is for the
 * handful that are not — the roster catalogue and a non-streamed stats page,
 * both of which run to hundreds of KB or more on a real library.
 */
async function jsonBig(res, status, body, req, extraHeaders = null) {
  let buf = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS,
    ...(extraHeaders || {})
  };
  const accepts = String(req?.headers['accept-encoding'] || '');
  if (/\bgzip\b/.test(accepts) && buf.length > 4096) {
    // Async on purpose, for the same reason `binary` is: this can be a
    // multi-megabyte body and gzipSync would hold the only thread through it.
    buf = await gzip(buf, { level: 1 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(buf);
}

/**
 * Tick buffers, compressed on the wire when the client says it can take it.
 *
 * These are fixed-width quantized records, so they compress well and the
 * browser undoes it transparently in the network layer: the ArrayBuffer that
 * reaches tickStore is the same either way, and no client code knows this
 * happened. Deflate rather than the stronger options on purpose, since this
 * runs per request on a two-core box and the marginal bytes are not worth the
 * CPU next to what the on-disk codec already saved.
 */
async function binary(res, buffer, req = null) {
  let buf = Buffer.from(buffer);
  const headers = {
    'Content-Type': 'application/octet-stream',
    // Round files are immutable: the name encodes the content, so a round can
    // be cached hard once fetched.
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...CORS
  };
  const accepts = String(req?.headers['accept-encoding'] || '');
  if (/\bgzip\b/.test(accepts) && buf.length > 4096) {
    // Asynchronous, deliberately. gzipSync on a 260 KB tick buffer holds the
    // only thread for long enough to matter, and the viewer asks for a whole
    // match's rounds in a burst: every one of those compressions used to block
    // every other request on the server, including the ones the rest of the
    // site was waiting on.
    buf = await gzip(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    // Caches key on this, and without it a shared cache could hand the gzipped
    // body to a client that did not ask for one.
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(200, headers);
  res.end(buf);
}

/** JSON bodies (notes, playlists, zones). Uploads never come here. */
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

function csv(url, key) {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function nums(url, key) {
  const parts = csv(url, key);
  return parts ? parts.map(Number).filter((n) => Number.isFinite(n)) : undefined;
}

function queryFromUrl(url) {
  return {
    maps: csv(url, 'maps'),
    teams: csv(url, 'teams'),
    players: csv(url, 'players'),
    playerMode: url.searchParams.get('playerMode') || 'all',
    // One team id, or several comma-separated aliases for a merged team.
    wonBy: (() => {
      const many = csv(url, 'wonBy');
      if (many?.length) return many;
      return url.searchParams.get('wonBy') || undefined;
    })(),
    wonByMode: (() => {
      const mode = url.searchParams.get('wonByMode');
      return mode === 'selected' || mode === 'opponent' ? mode : undefined;
    })(),
    economies: nums(url, 'economies'),
    econA: url.searchParams.has('econA') ? Number(url.searchParams.get('econA')) : undefined,
    econB: url.searchParams.has('econB') ? Number(url.searchParams.get('econB')) : undefined,
    hasAwpA: url.searchParams.get('hasAwpA') === '1' || url.searchParams.get('hasAwpA') === 'true',
    hasAwpB: url.searchParams.get('hasAwpB') === '1' || url.searchParams.get('hasAwpB') === 'true',
    equalBuy:
      url.searchParams.get('equalBuy') === '1' || url.searchParams.get('equalBuy') === 'true',
    teamEconomies: nums(url, 'teamEconomies'),
    teamEconomyOf: url.searchParams.get('teamEconomyOf') || undefined,
    roundMin: url.searchParams.has('roundMin') ? Number(url.searchParams.get('roundMin')) : undefined,
    roundMax: url.searchParams.has('roundMax') ? Number(url.searchParams.get('roundMax')) : undefined,
    search: url.searchParams.get('search') || undefined
  };
}

/**
 * The breadcrumb the parse process writes as it works. If it was killed
 * outright this is the only record of how far it got, and crucially it says
 * how much memory was in use at that point.
 */
async function readParseTrace() {
  try {
    const raw = await readFile(path.join(ROOT, '.parse-trace.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * What the replay volume actually delivers, read end to end.
 *
 * The parse used to re-read each demo ~8x, and whether that mattered came down
 * to a number nobody had: how fast this disk is. Rather than infer it from parse
 * times, read the largest round file that is already here and time it. Round
 * files are small, so this is cheap and repeatable; the throughput generalises
 * to the .dem reads that actually hurt.
 */
const PROBE_BUDGET_BYTES = 64 * 1024 * 1024;

async function volumeReadProbe() {
  const started = process.hrtime.bigint();
  let handle = null;
  try {
    // Prefer a .dem when one is on the volume: a big sequential read is the
    // access pattern that actually matters, and round files are far too small to
    // time meaningfully. Falls back to the largest round file otherwise.
    let target = null;
    for (const sub of ['demos', 'rounds']) {
      const dir = path.join(userDir(SHARED_LIBRARY), sub);
      const names = await readdir(dir).catch(() => []);
      for (const name of names) {
        const full = path.join(dir, name);
        const st = await stat(full).catch(() => null);
        if (st?.isFile() && (!target || st.size > target.size)) {
          target = { path: full, size: st.size };
        }
      }
      if (target && sub === 'demos') break;
    }
    if (!target) return { error: 'nothing on the volume to read' };

    // Capped so a diagnostic never turns into a few hundred MB of reads.
    const budget = Math.min(target.size, PROBE_BUDGET_BYTES);
    handle = await open(target.path, 'r');
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let read = 0;
    const t0 = process.hrtime.bigint();
    while (read < budget) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, budget - read), read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      file: path.basename(target.path),
      fileBytes: target.size,
      readBytes: read,
      ms: Math.round(ms),
      mbPerSec: ms > 0 ? Math.round(read / 1048576 / (ms / 1000)) : null,
      // A figure well above what the hardware can do means the page cache
      // served it, which is itself the answer for a file this size.
      probeMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6)
    };
  } catch (err) {
    return { error: err?.message || String(err) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Merge the stored record with live job progress. */
/**
 * Capabilities the client may spend through /api/replays/consume. An allowlist,
 * so the endpoint cannot be pointed at an arbitrary capability key.
 */
const METERED = new Set([
  CAP.DEMOS_MACRO_VIEWER,
  CAP.DEMOS_MAP_CONTROL,
  CAP.DEMOS_ROUND_WIN_PREDICTION,
  CAP.DEMOS_DUEL_WIN_PREDICTION,
  CAP.DEMOS_AUTO_COACH,
  CAP.ANALYTICS_CHARTS,
  CAP.ANALYTICS_PATTERN_FINDER,
  // Both were booleans and are quotas now: one anti-strat a day for a whole
  // Tier 3 roster, three for Tier 2. A quota nobody spends is a quota that
  // does not exist, so they belong here.
  CAP.ANALYTICS_ANTISTRAT,
  CAP.DEMOS_COMMS_COACH
]);

/**
 * Trim the stats aggregate to what the caller's tier includes.
 *
 * Free sees the basic table. Any paid plan adds the full player metrics (PSDT,
 * DT, accuracy) plus single-game and team statistics. Full team metrics (PRW,
 * possession) start at the middle band. Fields are deleted rather than zeroed
 * so a client cannot tell a withheld metric from a real zero.
 */
function gateStatsPayload(me, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };

  const strip = (rows, fields) =>
    Array.isArray(rows)
      ? rows.map((row) => {
          const copy = { ...row };
          for (const f of fields) delete copy[f];
          return copy;
        })
      : rows;

  if (!can(me, CAP.STATS_METRICS_PLAYER_FULL)) {
    out.players = strip(out.players, ['psdt', 'dt', 'accuracy', 'PSDT', 'DT', 'Accuracy']);
  }
  if (!can(me, CAP.STATS_METRICS_TEAM_FULL)) {
    out.teams = strip(out.teams, ['prw', 'possession', 'possessionPct', 'PRW', 'Poss']);
  }
  if (!can(me, CAP.STATS_TEAM_STATISTICS)) delete out.teams;
  if (!can(me, CAP.STATS_SINGLE_GAME)) delete out.perDemo;

  out.entitlements = {
    tier: me.entitlements?.tier || 'free',
    playerMetricsFull: can(me, CAP.STATS_METRICS_PLAYER_FULL),
    teamMetricsFull: can(me, CAP.STATS_METRICS_TEAM_FULL),
    teamStatistics: can(me, CAP.STATS_TEAM_STATISTICS),
    singleGame: can(me, CAP.STATS_SINGLE_GAME),
    filtersFull: can(me, CAP.STATS_FILTERS_FULL)
  };
  return out;
}

/**
 * How many demos this caller may hold at once, and whether `incoming` more fit.
 *
 * Was a single global constant with an admin bypass. It is now the
 * `demos.upload_limit` capability, so the answer differs per tier and the admin
 * bypass falls out of entitlement resolution rather than being a branch here.
 *
 * Three things count against the cap, not one:
 *   records      what is on disk under this uploader's id
 *   in-flight    queued or running parses whose record is not there to be
 *                counted, e.g. one deleted while its parse was still queued
 *   reservations uploads admitted a moment ago whose records do not exist yet
 *
 * `reserve: true` takes those places in the same breath as the check that
 * granted them. Everything from the last `await` to the reservation is
 * synchronous on purpose: that is what makes the check and the reservation one
 * step, so two requests that arrive together cannot both read the same count
 * and both be admitted. The caller owns what it reserved and must give it back.
 *
 * @param {string} library
 * @param {object} me
 * @param {{incoming?: number, reserve?: boolean}} [opts]
 * @returns {Promise<{allowed: boolean, current: number, incoming: number, limit: number,
 *                    remaining: number, accepted: number, tier: string, reserved: number}>}
 */
async function uploadCap(library, me, { incoming = 1, reserve = false } = {}) {
  const records = await listDemos(library);
  const mine = records.filter((r) => r.uploaderId === me.id);
  const counted = new Set(mine.map((r) => r.id));
  const inFlight = allJobs(library).filter(
    (j) =>
      j.uploaderId === me.id &&
      (j.state === 'queued' || j.state === 'running') &&
      !counted.has(j.demoId)
  ).length;

  const held = mine.length + inFlight + reservedUploads(me.id);
  const result = checkLimit(me, CAP.DEMOS_UPLOAD_LIMIT, held, incoming);
  const reserved = reserve && result.allowed ? reserveUploads(me.id, incoming) : 0;
  return { ...result, reserved };
}

function withJob(user, record) {
  const job = jobStatus(user, record.id);
  if (!job) {
    // Written as "parsing" but nothing is parsing it: the server restarted, or
    // the worker died, while it was mid-flight. Job state is in memory, so it
    // did not survive. Nothing will ever finish this record, and reporting it
    // as still running leaves the row spinning forever with no way out.
    if (record.status === 'parsing') {
      return {
        ...record,
        status: 'error',
        error: record.error || 'Parsing was interrupted before it finished. Retry to parse it again.'
      };
    }
    return record;
  }
  return {
    ...record,
    status: job.state === 'done' ? record.status || 'ready' : job.state === 'error' ? 'error' : 'parsing',
    progress: {
      stage: job.stage,
      round: job.round,
      total: job.total
    },
    error: job.error || record.error || null
  };
}

/**
 * @returns {Promise<boolean>} true when the request was handled here.
 */
export async function handleReplayRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/replays')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  // ---- diagnostics --------------------------------------------------------
  // Ahead of the auth gate on purpose: when a parse takes the container down
  // there is no session to speak of, and this is the one page that explains
  // why. It exposes no library contents, only how far the last parse got and
  // what memory the server has.
  if (req.method === 'GET' && p === '/api/replays/diag') {
    json(res, 200, {
      ok: true,
      parser: parserStatus(),
      auth: authStatus(),
      // Whether the box can verify Supabase sessions at all. When this is
      // false every caller is anonymous, uploads are refused, and the site
      // looks signed out however the browser feels about it.
      identity: { verifies: isConfigured() },
      lastParse: await readParseTrace(),
      memory: memorySnapshot(),
      // ?io=1 reads a real file off the replay volume to measure it. Opt-in
      // because it costs a few hundred MB of reads and evicts page cache, which
      // is not something a health check should do on its own.
      volume: url.searchParams.get('io') === '1' ? await volumeReadProbe() : undefined,
      // ?cpu=1 runs a fixed synthetic loop, ~1s. Opt-in because it deliberately
      // burns a core, which is the last thing to do to a box mid-parse unless
      // that is exactly the question being asked.
      cpu: url.searchParams.get('cpu') === '1' ? cpuProbe() : undefined,
      uptimeSeconds: Math.round(process.uptime())
    });
    return true;
  }

  // The library folder is shared; who is asking is a separate question.
  const auth = await identify(req);
  const user = auth.user;
  const me = await whoami(req);

  // A read-only "view as" session may browse the library but never change it.
  const impersonationBlock = guardImpersonation(req, url, me);
  if (impersonationBlock) {
    json(res, impersonationBlock.status, impersonationBlock.body);
    return true;
  }

  const access = await accessFor(me);

  /**
   * Records the caller may browse, with ownership stamped on for the client.
   *
   * Memoized for the life of the request. canOpenRound() calls this, and the
   * round and tick routes call canOpenRound(), so an unmemoized version
   * re-filtered the whole library several times while serving one round.
   */
  let readableOnce = null;
  const readable = async () => {
    if (!readableOnce) {
      readableOnce = (async () => {
        const records = await listDemos(user);
        if (!sampleLibraryOverlayEnabled()) {
          return { records, allowed: visibleRecords(records, access) };
        }
        const samples = await listSampleRecords();
        if (!samples.length) {
          return { records, allowed: visibleRecords(records, access) };
        }
        const ids = new Set(records.map((r) => r.id));
        const merged = [...records, ...samples.filter((s) => s.id && !ids.has(s.id))];
        return { records: merged, allowed: visibleRecords(merged, access) };
      })();
    }
    return readableOnce;
  };

  /**
   * Free accounts get the first half of a recent demo, per the pricing matrix.
   *
   * "Recent" is under a month old: older demos are fully readable on every
   * tier, which is what keeps the public library and its share links working
   * for signed-out visitors. The half is computed from the round list rather
   * than stored, so it moves as rounds are materialised.
   */
  const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

  const recentCutoffFor = (record) => {
    if (can(me, CAP.DEMOS_FULL_RECENT_ACCESS)) return Infinity;
    const uploaded = Date.parse(record?.uploadedAt || record?.createdAt || '');
    if (!Number.isFinite(uploaded) || Date.now() - uploaded > RECENT_MS) return Infinity;
    const rounds = Array.isArray(record?.rounds) ? record.rounds.length : 0;
    if (!rounds) return Infinity;
    return Math.ceil(rounds / 2);
  };

  /**
   * File → owning record, memoized per request.
   *
   * `byId` is cheap: one entry per demo, and it answers every modern round
   * name, which carry their demo id as a `~<demoId>` suffix.
   *
   * `owners` is NOT cheap and is therefore lazy. It walks every round of every
   * record — roughly 120,000 entries on this library — and only legacy names
   * from before that suffix existed need it. Building it eagerly here made a
   * scan crawl: each round the Pattern Finder fetched paid for a fresh
   * 120,000-entry Map before a byte was served, turning a three-second scan
   * into seconds per round. Almost every request now never builds it at all.
   */
  let roundLookupOnce = null;
  const roundLookup = async () => {
    if (!roundLookupOnce) {
      roundLookupOnce = (async () => {
        const { records } = await readable();
        let owners = null;
        return {
          records,
          byId: recordIdIndex(records),
          ownersLazy: () => (owners ||= roundOwnerIndex(records))
        };
      })();
    }
    return roundLookupOnce;
  };

  /**
   * May the caller open this round file? Round URLs are the link case, which
   * is exactly what "unlisted" is for: the file name is the link.
   */
  const canOpenRound = async (file) => {
    const { records, byId, ownersLazy } = await roundLookup();
    // Modern names resolve from `byId` alone and never touch the owner index.
    // Only a legacy name pays for it, and then once per request rather than
    // once per call.
    const legacy = String(file || '').lastIndexOf('~') <= 0;
    const record = recordForRoundFile(file, records, legacy ? ownersLazy() : null, byId);
    // No owning record: a round that predates materialization. Library default.
    if (!record) return true;
    if (!canSee(record, access, { viaLink: true })) return false;

    const cutoff = recentCutoffFor(record);
    if (cutoff === Infinity) return true;
    const index = (record.rounds || []).findIndex((r) => (r.file || r) === file);
    // Unknown position: allow rather than guess. Guessing here would hide
    // rounds from paying users on a data shape this did not anticipate.
    if (index < 0) return true;
    return index < cutoff;
  };

  /**
   * Playlists the caller may see: their own, plus team playlists from any team
   * they are on. Playlists made before accounts belong to the legacy uploader,
   * so they stay with the admin accounts rather than disappearing.
   */
  const playlistsFor = async () => {
    const list = await readPlaylists(user);
    const myTeams = me.signedIn ? await teamsOf(me.id) : [];
    const teamIds = new Set(myTeams.map((t) => t.id));
    return list
      .map((pl) => ({
        ...pl,
        ownerId: pl.ownerId || LEGACY_UPLOADER.id,
        ownerName: pl.ownerName || LEGACY_UPLOADER.username,
        scope: pl.scope === 'team' ? 'team' : 'private'
      }))
      .filter((pl) => {
        if (me.admin) return true;
        if (!me.signedIn) return false;
        if (pl.ownerId === me.id) return true;
        return pl.scope === 'team' && pl.teamId && teamIds.has(pl.teamId);
      })
      .map((pl) => ({ ...pl, mine: pl.ownerId === me.id || me.admin }));
  };

  /** The team a new team-scoped playlist belongs to: owned first, else first joined. */
  const playlistTeamId = async () => {
    if (!me.signedIn) return '';
    const owned = await ownedTeam(me.id);
    if (owned) return owned.id;
    const [first] = await teamsOf(me.id);
    return first?.id || '';
  };

  /** 401 unless signed in. */
  const requireUser = () => {
    if (me.signedIn) return true;
    json(res, 401, { error: 'Sign in to do that.' });
    return false;
  };

  /**
   * 402 unless the caller's plan carries this capability, in the one refusal
   * shape the client already renders. `consume: false` because these are the
   * boolean gates: opening the feature is not a use of anything.
   *
   * @param {string} key
   * @returns {Promise<boolean>} true when the request may continue.
   */
  const requireCap = async (key) => {
    try {
      await requireCapability(me, key, { consume: false });
      return true;
    } catch (err) {
      const refusal = upgradeResponse(err);
      if (!refusal) throw err;
      json(res, refusal.status, refusal.body);
      return false;
    }
  };

  // ---- status -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/status') {
    json(res, 200, {
      parser: parserStatus(),
      auth: authStatus(),
      usage: await usage(user),
      account: {
        signedIn: me.signedIn,
        id: me.id,
        username: me.username,
        admin: me.admin,
        // 0 still means "no cap" on this field, which is the contract the
        // replays view already reads. The catalogue spells unlimited as -1, so
        // it is translated here rather than at every reader.
        maxDemos: capability(me, CAP.DEMOS_UPLOAD_LIMIT) === UNLIMITED
          ? 0
          : capability(me, CAP.DEMOS_UPLOAD_LIMIT),
        // False when the backend has no SUPABASE_URL / SUPABASE_ANON_KEY: it
        // cannot verify anyone, and the client needs to say that rather than
        // telling a signed-in user to sign in.
        verifies: isConfigured()
      },
      // The client mirrors this for UI state only. Every decision it drives has
      // already been made on this side.
      entitlements: me.entitlements,
      impersonating: me.impersonating,
      limits: { maxBytes: MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES },
      // .rar needs an external extractor, so whether it works is a property of
      // the host rather than of the code.
      rar: rarSupport()
    });
    return true;
  }

  // ---- library ------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/demos') {
    const { records: allRecords, allowed } = await readable();
    // Detail records for an explicit id list — the demo browser resolving
    // library-wide filter results to row headers. One request instead of one
    // GET /demos/:id per demo, and none of the team-cluster / usage work the
    // full listing carries.
    const idsQ = csv(url, 'ids');
    if (idsQ?.length) {
      const wanted = new Set(idsQ.slice(0, 500));
      const rows = allowed
        .filter((r) => wanted.has(r.id))
        .map((r) => ({ ...withJob(user, r), owner: ownerOf(r) }));
      await jsonBig(res, 200, { demos: rows }, req);
      return true;
    }
    // `?mine=1` is the My Uploads listing: everything this account owns, in one
    // response and never paginated. It used to reuse the library's paged fetch
    // and filter client-side, which silently capped the page at the library's
    // 50 and made an account with 300 uploads look like it had 50.
    const mineOnly = url.searchParams.get('mine') === '1';
    const teamQ = String(url.searchParams.get('team') || '')
      .trim()
      .toLowerCase();
    const ownedBy = (r) => ownerOf(r).id === me.id;
    const nameKey = (n) =>
      String(n || '')
        .trim()
        .toLowerCase();
    let records = mineOnly && !me.admin ? allowed.filter(ownedBy) : allowed;
    // Team Overview only needs demos that name this roster, not the whole library.
    if (teamQ) {
      records = records.filter((r) => {
        if ((r.status || 'ready') !== 'ready' && (r.status || '') !== 'parsing') return false;
        return nameKey(r.team1?.name) === teamQ || nameKey(r.team2?.name) === teamQ;
      });
    }
    const mapQ = String(url.searchParams.get('map') || '')
      .trim()
      .toUpperCase();
    if (mapQ) {
      records = records.filter((r) => String(r.map || '').toUpperCase() === mapQ);
    }
    const byId = new Set(allRecords.map((r) => r.id));
    // Jobs whose record has not landed yet (upload just finished). Terminal
    // error/done jobs must not reappear here — otherwise deleting a failed
    // parse removes the record and the same demo pops back from memory.
    const pending = allJobs(user)
      .filter(
        (j) =>
          !byId.has(j.demoId) && (j.state === 'queued' || j.state === 'running')
      )
      .map((j) => ({
        id: j.demoId,
        status: 'parsing',
        filename: j.filename,
        sizeBytes: j.sizeBytes,
        uploadedAt: j.queuedAt,
        error: j.error,
        progress: { stage: j.stage, round: j.round, total: j.total }
      }));

    // Optional window for the library browser. Omit / limit=0 → full list
    // (status tools, migrations). Stats/analytics/charts use /stats instead.
    // `mine=1` ignores the window entirely: that page owns its own paging.
    const rawLimit = url.searchParams.get('limit');
    const limit =
      mineOnly || rawLimit === null || rawLimit === ''
        ? 0
        : Math.max(0, Math.min(5000, Number(rawLimit) || 0));
    const offset = mineOnly ? 0 : Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
    const page =
      limit > 0 ? records.slice(offset, offset + limit) : offset ? records.slice(offset) : records;
    const mapped = page.map((r) => ({ ...withJob(user, r), owner: ownerOf(r) }));
    // Pending parses always surface on the first page so uploads stay visible.
    const demos = offset === 0 ? [...pending, ...mapped] : mapped;

    // Full-library team clusters for the TEAM typeahead (page of demos alone
    // would hide orgs that only appear on later pages).
    const teams = clusterTeams(records.filter((r) => (r.status || 'ready') === 'ready'));

    // Compressed. Each record carries its full round list — one long filename
    // per round — so a page of fifty runs to ~125 KB of highly repetitive JSON,
    // and the team clusters for the typeahead span the whole library on top.
    await jsonBig(res, 200, {
      demos,
      teams,
      total: records.length,
      offset,
      limit: limit || records.length,
      hasMore: limit > 0 && offset + page.length < records.length,
      pending: pending.length,
      // What My Uploads will show, which is what the quota meter counts against.
      // Derived here because the store is one shared library: `usage.demos` is
      // the size of the whole library, not of this account's slice of it. Admins
      // manage the whole library from that page, so their count is the whole
      // readable set, matching what `mine=1` returns them.
      owned: me.signedIn ? (me.admin ? allowed.length : allowed.filter(ownedBy).length) : 0,
      usage: await usage(user)
    }, req);
    return true;
  }

  if (req.method === 'POST' && p === '/api/replays/demos') {
    if (!requireUser()) return true;
    // A username account uploads nothing until a real identity anchors it.
    // 403 with a reason, not 402: this is not a plan problem, and the client
    // routes the user to Connections rather than to pricing.
    const anchored = demoUploadIdentity(me);
    if (!anchored.ok) {
      json(res, 403, { error: anchored.error, reason: 'link_required' });
      return true;
    }
    // Admitted for one demo. An archive can hold any number, and how many is
    // not knowable until it has been opened, so the check that actually bounds
    // an archive is the one in the ingest loop. This one refuses an account
    // that is already full, and takes the place that stops a second request
    // arriving in the same moment from being admitted against the same count.
    let reserved = 0;
    try {
      const cap = await uploadCap(user, me, { incoming: 1, reserve: true });
      reserved = cap.reserved;
      if (!cap.allowed) {
        // 402, not 403: this is "not on your plan", and the client shows an
        // upgrade prompt rather than a permission error.
        try {
          requireLimit(me, CAP.DEMOS_UPLOAD_LIMIT, cap.current, cap.incoming);
        } catch (err) {
          const refusal = upgradeResponse(err);
          json(res, refusal.status, refusal.body);
          return true;
        }
      }
      const filename = String(req.headers['x-aim4-filename'] || 'match.dem').slice(0, 160);
      if (!isAcceptedUpload(filename)) {
        json(res, 400, {
          error: 'Upload a .dem file, or a .zip, .rar, .tar.gz, .gz or .zst containing one.'
        });
        return true;
      }
      const declared = Number(req.headers['content-length'] || 0);
      const gate = await checkQuota(user, declared);
      if (!gate.ok) {
        json(res, 413, { error: gate.error, usage: gate.usage });
        return true;
      }

      // Always land on a temp file first, even for a bare .dem. Unpacking
      // decides where the demo finally lives (a .zip produces several), and the
      // ingest pipeline adopts a lone .dem by renaming it rather than copying
      // it.
      //
      // gate.allowed, not bytesLeft: a request with no Content-Length, or a
      // lying one, skips the check above entirely, so the per-upload cap has to
      // be the ceiling the stream is actually held to.
      let saved;
      try {
        saved = await saveTempUpload(req, gate.allowed, 'upload');
      } catch (err) {
        json(res, 413, { error: err.message || 'Upload failed.' });
        return true;
      }
      if (!saved.sizeBytes) {
        await rm(saved.path, { force: true }).catch(() => {});
        json(res, 400, { error: 'Empty upload.' });
        return true;
      }

      // Respond as soon as the bytes are on disk. Inflating a multi-gigabyte
      // archive takes long enough that holding the response open for it is
      // exactly how an upload dies behind a proxy that is done waiting.
      //
      // What comes OUT of an archive is bounded by the library quota rather
      // than the per-upload cap: 5 GB of demos can legitimately expand well
      // past 5 GB, and the quota is the limit that actually protects the disk.
      // The archive's own size is subtracted because it is still on disk here.
      const batch = startIngest({
        user,
        filename,
        source: saved.path,
        sizeBytes: saved.sizeBytes,
        allowedBytes: Math.max(0, gate.usage.bytesLeft - saved.sizeBytes),
        owner: {
          uploaderId: me.id,
          uploaderName: me.username,
          visibility: normalizeVisibility(req.headers['x-aim4-visibility'] || 'private'),
          // The resolved caller, for the per-demo cap check inside the unpack.
          account: me
        },
        reserved
      });
      // The ingest pipeline owns the reservation from here and releases it once
      // the records it wrote can count themselves.
      reserved = 0;
      json(res, 202, { batch: batchStatus(batch), usage: await usage(user) });
      return true;
    } finally {
      // Every path that answered without starting an ingest gives its place
      // back, or a refused upload would hold it until the process restarted.
      if (reserved) releaseUploads(me.id, reserved);
    }
  }

  const batchMatch = p.match(/^\/api\/replays\/uploads\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && batchMatch) {
    const batch = await getBatch(user, batchMatch[1]);
    if (!batch) {
      json(res, 404, { error: 'That upload is no longer being tracked.' });
      return true;
    }
    json(res, 200, { batch: batchStatus(batch), usage: await usage(user) });
    return true;
  }

  // Prefer this path in production: parse on the user's PC, upload only the
  // already-named rounds. No demoparser process runs on the server.
  if (req.method === 'POST' && p === '/api/replays/import') {
    // Signed in, like every other way of putting a demo in the library. This
    // route used to accept anonymous callers, and since a package is one
    // request per demo and GET /demos/:id/package hands out a valid package for
    // any visible demo, that made it an unlimited uploader anybody could point
    // at the volume.
    if (!requireUser()) return true;
    // Same identity rule as the raw upload path.
    const anchored = demoUploadIdentity(me);
    if (!anchored.ok) {
      json(res, 403, { error: anchored.error, reason: 'link_required' });
      return true;
    }
    // One package is one demo, so this cap check is the whole of it: there is
    // no second check further down the way the archive path has one. Reserved
    // for the same reason, because the body still has to stream before the
    // record is written.
    let reserved = 0;
    try {
      const cap = await uploadCap(user, me, { incoming: 1, reserve: true });
      reserved = cap.reserved;
      if (!cap.allowed) {
        try {
          requireLimit(me, CAP.DEMOS_UPLOAD_LIMIT, cap.current, cap.incoming);
        } catch (err) {
          const refusal = upgradeResponse(err);
          json(res, refusal.status, refusal.body);
          return true;
        }
      }
      const filename = String(req.headers['x-aim4-filename'] || `match${PACKAGE_EXT}`).slice(0, 160);
      if (!filename.toLowerCase().endsWith(PACKAGE_EXT)) {
        json(res, 400, { error: `Only ${PACKAGE_EXT} packages can be imported.` });
        return true;
      }
      const declared = Number(req.headers['content-length'] || 0);
      const gate = await checkQuota(user, declared);
      if (!gate.ok) {
        json(res, 413, { error: gate.error, usage: gate.usage });
        return true;
      }

      let tmp = null;
      try {
        const saved = await saveTempUpload(req, gate.allowed, 'import');
        tmp = saved.path;
        if (!saved.sizeBytes) {
          json(res, 400, { error: 'Empty upload.' });
          return true;
        }
        const buf = await readFile(tmp);
        const record = await importReplayPackage(user, buf, {
          filename,
          uploadedAt: Date.now(),
          uploaderId: me.id,
          uploaderName: me.username,
          visibility: 'private'
        });
        scheduleStatsIndex(statsIo, user, record);
        json(res, 201, {
          demo: { ...withJob(user, record), owner: ownerOf(record) },
          usage: await usage(user)
        });
      } catch (err) {
        const status = err.status || 400;
        json(res, status, { error: err.message || 'Import failed.', usage: err.usage });
      } finally {
        if (tmp) await rm(tmp, { force: true }).catch(() => {});
      }
      return true;
    } finally {
      // Held only until the record exists, win or lose. Unlike the archive
      // path there is nothing to hand the reservation on to: by the time this
      // runs the demo is either in the library or it never will be.
      if (reserved) releaseUploads(me.id, reserved);
    }
  }

  const demoMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)$/);
  if (demoMatch) {
    const id = demoMatch[1];
    if (req.method === 'GET') {
      const record =
        (await readRecord(user, id)) ||
        (sampleDemosEnabled() ? await getSampleRecord(id) : null);
      // Named directly, so this is the link case: unlisted opens, private does not.
      if (!record || !canSee(record, access, { viaLink: true })) {
        json(res, 404, { error: 'Replay not found.' });
        return true;
      }
      json(res, 200, { demo: { ...withJob(user, record), owner: ownerOf(record) } });
      return true;
    }
    if (req.method === 'DELETE') {
      const record = await readRecord(user, id);
      if (record && !canManage(record, me)) {
        json(res, 403, { error: 'Only the uploader can delete that demo.' });
        return true;
      }
      const removed = await deleteDemo(user, id);
      forgetJob(user, id);
      await forgetDemoIndex(statsIo, user, id);
      if (!removed) {
        json(res, 404, { error: 'Replay not found.' });
        return true;
      }
      json(res, 200, { ok: true, usage: await usage(user) });
      return true;
    }
  }

  const teamsMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/teams$/);
  if (req.method === 'POST' && teamsMatch) {
    const id = teamsMatch[1];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      json(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const existing = await readRecord(user, id);
    if (existing && !canManage(existing, me)) {
      json(res, 403, { error: 'Only the uploader can rename that demo.' });
      return true;
    }
    const record = await renameDemoTeams(user, id, body.team1, body.team2);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    // Names are hashed into both the stats-index fingerprint and the hot
    // store's record key, so an unpatched rename means a lazy index rebuild
    // for this demo AND a full store rebuild for everybody — minutes of
    // background CPU to change two strings. Patch both in place instead; a
    // cold store simply reads the fresh index when it next builds. (No
    // roster propagation here on purpose: an uploader renames their own
    // demo, the admin tool is what sweeps the library.)
    await patchIndexTeamNames(statsIo, user, record);
    patchHotStoreTeamNames(statsIo, user, [record]);
    invalidateRoster(user);
    json(res, 200, { demo: withJob(user, record), usage: await usage(user) });
    return true;
  }

  const visibilityMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/visibility$/);
  if (req.method === 'POST' && visibilityMatch) {
    const id = visibilityMatch[1];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      json(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const existing = await readRecord(user, id);
    if (!existing) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    if (!canManage(existing, me)) {
      json(res, 403, { error: 'Only the uploader can change that demo’s visibility.' });
      return true;
    }
    let record;
    try {
      record = await setDemoVisibility(user, id, body.visibility);
    } catch (err) {
      json(res, 400, { error: err?.message || 'Invalid visibility.' });
      return true;
    }
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    json(res, 200, {
      demo: { ...withJob(user, record), owner: ownerOf(record) },
      usage: await usage(user)
    });
    return true;
  }

  // Tags are the uploader's own labels (scrim, faceit, an opponent name), so
  // the only thing enforced is shape; setDemoTags does that.
  // ---- voice comms --------------------------------------------------------
  // A recorded TeamSpeak session attached to one demo. The container arrives
  // finished from the desktop recorder: the server validates it, stores it,
  // and serves it back. No transcription, no audio work, nothing on the
  // request path — see shared/comms/format.js for what is in the file.
  //
  // Voice is a team feature on every team tier, so the writes are gated on
  // `team.comms` and the reads are not. The split is deliberate: a demo's
  // comms are read while a round is playing, and a 402 landing in the middle
  // of playback is worse than the sale it might make. What is gated is
  // everything that changes the library: uploading a container, attaching or
  // detaching one, and editing the identity map.
  //
  // Library-wide TeamSpeak identity memory, editable from the team
  // Communication page: uid -> roster player, applying to every session.
  if (p === '/api/replays/comms/identities') {
    const { readIdentities, setIdentity } = await import('./commsStore.js');
    if (req.method === 'GET') {
      json(res, 200, { identities: await readIdentities(user) });
      return true;
    }
    if (req.method === 'POST') {
      if (!me.signedIn) {
        json(res, 401, { error: 'Sign in to link TeamSpeak identities.' });
        return true;
      }
      // The identity map is library-wide, so one seat's edit changes what every
      // other seat sees. That is a team action whatever page it is made from.
      if (!(await requireCap(CAP.TEAM_COMMS))) return true;
      let body = {};
      try {
        body = await readJson(req, 16 * 1024);
      } catch (err) {
        json(res, 400, { error: err?.message || 'Invalid JSON body.' });
        return true;
      }
      try {
        const identities = await setIdentity(user, body.uid, {
          playerId: body.playerId,
          nickname: body.nickname
        });
        json(res, 200, { identities });
      } catch (err) {
        json(res, 400, { error: err?.message || 'Could not save the link.' });
      }
      return true;
    }
  }

  const commsMatch = p.match(
    /^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/comms(?:\/(file|attach|manifest))?$/
  );
  if (commsMatch) {
    const id = commsMatch[1];
    const sub = commsMatch[2] || '';
    const {
      deleteComms,
      readComms,
      readCommsFile,
      readIdentities,
      saveComms,
      updateCommsAttachment
    } = await import('./commsStore.js');

    const record = await readRecord(user, id);

    if (req.method === 'GET') {
      if (!record || !canSee(record, access, { viaLink: true })) {
        json(res, 404, { error: 'Replay not found.' });
        return true;
      }
      const meta = await readComms(user, id);
      if (!meta) {
        json(res, sub === 'file' ? 404 : 200, sub === 'file' ? { error: 'No comms attached.' } : { comms: null });
        return true;
      }
      if (sub === 'manifest') {
        // The transcript without the voice: the Communication page reads
        // utterance timing for a whole library of sessions, and pulling the
        // ~2 MB container per demo to get at ~200 KB of gzipped JSON would
        // make that page cost megabytes it never plays.
        const bytes = await readCommsFile(user, id);
        if (!bytes) {
          json(res, 404, { error: 'No comms attached.' });
          return true;
        }
        const { decodeComms } = await import('../../shared/comms/format.js');
        try {
          const { manifest } = await decodeComms(new Uint8Array(bytes));
          await jsonBig(res, 200, { manifest }, req, { 'Cache-Control': 'private, max-age=300' });
        } catch (err) {
          json(res, 422, { error: err?.message || 'Comms file is unreadable.' });
        }
        return true;
      }
      if (sub === 'file') {
        const bytes = await readCommsFile(user, id);
        if (!bytes) {
          json(res, 404, { error: 'No comms attached.' });
          return true;
        }
        res.writeHead(200, {
          ...CORS,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
          // Immutable for as long as it is attached: replacing a session
          // rewrites the sidecar, and the viewer asks for the meta first.
          'Cache-Control': 'private, max-age=300'
        });
        res.end(bytes);
        return true;
      }
      // Remembered identities ride along so the attach dialog can pre-fill
      // without a second request; the same five people scrim every week.
      json(res, 200, { comms: meta, identities: await readIdentities(user) });
      return true;
    }

    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!record) {
        json(res, 404, { error: 'Replay not found.' });
        return true;
      }
      if (!canManage(record, me)) {
        json(res, 403, { error: 'Only the uploader can change that demo’s comms.' });
        return true;
      }
      // Attaching, replacing, re-mapping and detaching all land here. 403 for
      // "not your demo" first, then 402 for "not on your plan": being told to
      // upgrade for something you could not do anyway reads as a shakedown.
      if (!(await requireCap(CAP.TEAM_COMMS))) return true;
    }

    if (req.method === 'DELETE') {
      await deleteComms(user, id);
      json(res, 200, { ok: true, comms: null, usage: await usage(user) });
      return true;
    }

    if (req.method === 'POST' && sub === 'attach') {
      // A mapping of five speakers and a nudge is a few hundred bytes; 64 KB
      // is generous. Without a cap this loop would buffer whatever a client
      // chose to stream at it.
      const ATTACH_MAX_BYTES = 64 * 1024;
      const chunks = [];
      let attachTotal = 0;
      for await (const chunk of req) {
        attachTotal += chunk.length;
        if (attachTotal > ATTACH_MAX_BYTES) {
          req.destroy();
          json(res, 413, { error: 'Attach body is too large.' });
          return true;
        }
        chunks.push(chunk);
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        json(res, 400, { error: 'Invalid JSON body.' });
        return true;
      }
      const meta = await updateCommsAttachment(user, id, body);
      if (!meta) {
        json(res, 404, { error: 'No comms attached.' });
        return true;
      }
      json(res, 200, { comms: meta });
      return true;
    }

    if (req.method === 'POST') {
      // Metered while it streams rather than buffered and checked after: a
      // comms file is ~2 MB, so anything wildly over is not a comms file and
      // there is no reason to hold it in memory to find that out.
      const chunks = [];
      let total = 0;
      let tooBig = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > COMMS_MAX_BYTES) {
          tooBig = true;
          break;
        }
        chunks.push(chunk);
      }
      if (tooBig) {
        req.destroy();
        json(res, 413, {
          error: `Comms file is too large (limit ${Math.round(COMMS_MAX_BYTES / 1024 / 1024)} MB).`
        });
        return true;
      }
      // Comms count toward the storage quota, so the quota also gates them —
      // counting without gating would let a full library keep growing 32 MB
      // at a time. A replace only charges the difference: the old file's
      // bytes come back the moment the new one lands.
      const existing = await readComms(user, id);
      const netNewBytes = Math.max(0, total - (existing?.sizeBytes || 0));
      const gate = await checkQuota(user, netNewBytes);
      if (!gate.ok) {
        json(res, 413, { error: gate.error, usage: gate.usage });
        return true;
      }
      let meta;
      try {
        meta = await saveComms(user, id, Buffer.concat(chunks), {
          uploadedBy: me?.id || null,
          filename: String(req.headers['x-aim4-filename'] || '')
        });
      } catch (err) {
        json(res, 400, { error: err?.message || 'That is not a comms file.' });
        return true;
      }
      json(res, 200, { comms: meta, identities: await readIdentities(user), usage: await usage(user) });
      return true;
    }
  }

  const tagsMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/tags$/);
  if (req.method === 'POST' && tagsMatch) {
    const id = tagsMatch[1];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      json(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    const existing = await readRecord(user, id);
    if (!existing) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    if (!canManage(existing, me)) {
      json(res, 403, { error: 'Only the uploader can tag that demo.' });
      return true;
    }
    const record = await setDemoTags(user, id, body.tags);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    json(res, 200, { demo: { ...withJob(user, record), owner: ownerOf(record) } });
    return true;
  }

  // One round opened in the viewer. Gated on the same read permission as the
  // rounds themselves, so a demo nobody may open cannot have its count moved.
  const viewMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/view$/);
  if (req.method === 'POST' && viewMatch) {
    const id = viewMatch[1];
    const record = await readRecord(user, id);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    if (!canSee(record, access, { viaLink: true })) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    const next = await bumpDemoViews(user, id);
    json(res, 200, { views: Number(next?.views) || 0 });
    return true;
  }

  // ---- 3D availability + the upgrade queue --------------------------------
  // What the viewer's "watch in 3D" control needs, in one call: whether this
  // demo has the movement data the 3D viewer requires (PARSER_REVISION 3 —
  // rounds below it have zeros for jump and crouch), whether the map has a
  // 3D pack on this host, and where the demo sits in the reparse queue.
  //
  // Three independent gates, reported separately rather than collapsed into
  // one boolean, because the fixes differ: a stale demo can be queued, an
  // unsupported map cannot be anything but waited for, and an unfetchable
  // demo can never be upgraded at all.
  const threeDMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/3d$/);
  if (threeDMatch && (req.method === 'GET' || req.method === 'POST')) {
    const id = threeDMatch[1];
    const stored = await readRecord(user, id);
    const record = stored || (sampleDemosEnabled() ? await getSampleRecord(id) : null);
    if (!record || !canSee(record, access, { viaLink: true })) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    const { cs3dMapByCode, hasCs3dPack } = await import('../cs3d/availability.js');
    const map = cs3dMapByCode(record.map);
    const mapReady = map ? await hasCs3dPack(map.slug) : false;

    if (!stored) {
      json(res, 200, {
        ok: true,
        demoId: id,
        dataReady: true,
        revision: record.parser?.revision || 3,
        targetRevision: record.parser?.revision || 3,
        upgradeable: false,
        mapReady,
        mapSlug: map?.slug || null,
        mapName: map?.name || record.mapName || '',
        job: null,
        url: map && mapReady ? `/${map.slug}?demo=${encodeURIComponent(id)}` : null
      });
      return true;
    }

    const { statusFor, requestUpgrade } = await import('./reparseQueue.js');

    // POST is the request; GET is the poll the button uses while it waits.
    const queue =
      req.method === 'POST' ? await requestUpgrade(user, id) : await statusFor(user, id);

    json(res, 200, {
      ok: queue.ok !== false,
      error: queue.ok === false ? queue.error : undefined,
      demoId: id,
      // Gate 1: does the stored data carry jump and crouch? (revision 3+)
      // Later parser revisions still upgrade via the queue; they do not block 3D.
      dataReady: !!queue.movementReady,
      revision: queue.revision,
      targetRevision: queue.targetRevision,
      upgradeable: !!queue.upgradeable,
      // Gate 2: is there a 3D map to put it on?
      mapReady,
      mapSlug: map?.slug || null,
      mapName: map?.name || record.mapName || '',
      // Gate 3: where in line, if anywhere.
      job: queue.job || null,
      // Only meaningful once both gates pass.
      url: queue.current && mapReady ? `/${map.slug}?demo=${encodeURIComponent(id)}` : null
    });
    return true;
  }

  // The whole match as an .aim4replay, so the 3D viewer can open a library
  // demo with the same decoder it uses for a dropped file. Read permission is
  // the demo's own; this exposes nothing the round routes do not already.
  const packageMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/package$/);
  if (req.method === 'GET' && packageMatch) {
    const id = packageMatch[1];
    const stored = await readRecord(user, id);
    const record = stored || (sampleDemosEnabled() ? await getSampleRecord(id) : null);
    if (!record || !canSee(record, access, { viaLink: true })) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    let bytes = null;
    if (stored) {
      const { buildDemoPackage } = await import('./demoStore.js');
      bytes = await buildDemoPackage(user, id);
    }
    if (!bytes) bytes = await getSamplePackageBytes(id);
    if (!bytes) {
      json(res, 404, { error: 'This demo has no stored rounds.' });
      return true;
    }
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=60'
    });
    res.end(Buffer.from(bytes));
    return true;
  }

  if (req.method === 'GET' && p === '/api/replays/3d/queue') {
    const { queueSnapshot } = await import('./reparseQueue.js');
    json(res, 200, queueSnapshot());
    return true;
  }

  const parseMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)\/parse$/);
  if (req.method === 'POST' && parseMatch) {
    const id = parseMatch[1];
    const record = await readRecord(user, id);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    await writeRecord(user, { ...record, status: 'parsing', error: null });
    const job = enqueueParse({
      user,
      demoId: id,
      filename: record.filename,
      sizeBytes: record.sizeBytes
    });
    json(res, 202, { job: { state: job.state, stage: job.stage } });
    return true;
  }

  // ---- roster catalogue ----------------------------------------------------
  // Who played in what, without opening a single stats index. Every scoped page
  // resolves its demo ids here first, then asks /stats for just those — which
  // is the difference between 4100 demos and thirty.
  if (req.method === 'GET' && p === '/api/replays/roster') {
    // Built once over the whole library, then narrowed to this caller. Caching
    // a per-caller catalogue thrashed between access levels and could collide.
    const { records: allRecords, allowed } = await readable();
    const ready = allRecords.filter((r) => (r.status || 'ready') === 'ready');
    const allowedIds = new Set(
      allowed.filter((r) => (r.status || 'ready') === 'ready').map((r) => r.id)
    );
    const full = await getRoster(statsIo, user, ready, {
      readEntry: (u, id) => loadStoredEntry(statsIo, u, id)
    });
    const roster = allowedIds.size === ready.length ? full : scopeRoster(full, allowedIds);
    await jsonBig(res, 200, roster, req, { 'Cache-Control': 'private, max-age=60' });
    return true;
  }

  if (req.method === 'GET' && p === '/api/replays/vrs') {
    const { loadGlobalRanks, loadedStandingSnapshot } = await import('./teamStandingsDb.js');
    const table = loadGlobalRanks();
    json(res, 200, {
      asOf: loadedStandingSnapshot(),
      size: table.size,
      teams: table.list
    });
    return true;
  }

  // ---- aggregate -----------------------------------------------------------
  // The player table for a filter, computed here rather than in the browser.
  //
  // The old shape of this — ship every round of every demo and let the client
  // add them up — costs ~18 s and ~740 MB on a 4100-demo library, most of it
  // spent parsing JSON twice so the browser can produce a few dozen rows. The
  // rows are what the page wanted; this returns them.
  //
  // POST takes the same thing in a body, for one reason: the `files` filter.
  // The Pattern Finder's leaderboard is "these exact rounds", and a search on a
  // busy map matches tens of thousands of them — a couple of hundred kilobytes
  // of round ids, which is well past what any URL will carry. Everything else
  // about the two is identical.
  if (
    (req.method === 'GET' || req.method === 'POST') &&
    p === '/api/replays/aggregate'
  ) {
    let body = null;
    if (req.method === 'POST') {
      try {
        // Big enough for a whole map's rounds: ~20k ids at ~14 bytes each.
        body = await readJson(req, 4 * 1024 * 1024);
      } catch (err) {
        json(res, 400, { error: err?.message || 'Invalid JSON body.' });
        return true;
      }
    }
    /** Query for GET, body for POST. Same names, same meanings. */
    const arg = (key) => (body ? body[key] : url.searchParams.get(key));
    const argList = (key) => {
      if (!body) return csv(url, key);
      const v = body[key];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    };
    const argHas = (key) => (body ? body[key] !== undefined && body[key] !== null : url.searchParams.has(key));
    /** A flag, from either transport: `?hasAwp=1` or `{ hasAwp: 1 }`. */
    const argFlag = (key) => {
      const v = arg(key);
      return v === 1 || v === true || v === '1' || v === 'true';
    };
    // The store is built from the whole library, once, for everybody. What this
    // caller may read is applied as a mask per query.
    const { records: allRecords, allowed } = await readable();
    const ready = allRecords.filter((r) => (r.status || 'ready') === 'ready');
    const allowedIds = new Set(
      allowed.filter((r) => (r.status || 'ready') === 'ready').map((r) => r.id)
    );
    const only = argList('demos');
    const scoped = only?.length ? new Set(only) : null;
    const filter = {
      maps: argList('maps') || [],
      side: arg('side') || '',
      econ: argHas('econ') ? Number(arg('econ')) : null,
      oppEcon: argHas('oppEcon') ? Number(arg('oppEcon')) : null,
      // The AWP toggles are a property of the buy digit the store already
      // holds (the legacy 5 = full buy that had an AWP), so they cost nothing
      // to honour here and are wrong to drop: a filter the client sends and
      // the server ignores repaints the same table under a changed bar.
      hasAwp: argFlag('hasAwp'),
      oppHasAwp: argFlag('oppHasAwp'),
      // Round-library calls and the round clock. The store carries the tags a
      // round was given and when each one came true, so these are answered here
      // rather than by shipping the library to the browser to be filtered.
      roundOwn: argList('roundOwn') || [],
      roundOpp: argList('roundOpp') || [],
      fromSec: argHas('fromSec') ? Number(arg('fromSec')) : null,
      toSec: argHas('toSec') ? Number(arg('toSec')) : null,
      result: arg('result') || '',
      advantage: arg('advantage') || '',
      teamName: arg('teamName') || '',
      rankOwn: arg('rankOwn') || '',
      rankOpp: arg('rankOpp') || '',
      dateFrom: arg('from') || '',
      dateTo: arg('to') || '',
      files: argList('files') || [],
      // "T:AWPer" / "CT:Anchor". Roles are stored on the index; the store
      // carries them, so this no longer forces the caller to download rounds.
      role: (() => {
        const raw = String(arg('role') || '').trim();
        if (!raw) return null;
        const [side, ...rest] = raw.split(':');
        const value = rest.join(':').trim();
        if ((side !== 'T' && side !== 'CT') || !value) return null;
        return { side, value };
      })()
    };
    // A `files` filter that matched nothing must return nothing, not the whole
    // library — an empty list here means "these rounds", and there are none.
    if (body?.files !== undefined && !filter.files.length) {
      await jsonBig(res, 200, { players: [], playersTotal: 0, teams: [], teamsTotal: 0, maps: [], offset: 0 }, req);
      return true;
    }
    // Which tables the caller wants. Teams cost an extra pass over the rounds,
    // so a page showing only players should not pay for them.
    const tabs = (arg('tables') || 'players')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const wantTeams = tabs.includes('teams');

    // This endpoint answers from a WARM store or not at all.
    //
    // The store build reads every stats index in the library, and getHotStore
    // used to hand every concurrent caller that same in-flight build promise —
    // so while it ran, nothing here returned, and when it failed, the next
    // request started it over. From a browser that is indistinguishable from
    // a dead server, and it took the rest of the site with it: the build is
    // CPU on the only thread this process has.
    //
    // requireWarm inverts that: a cold store answers 503 "still building"
    // immediately (kicking the build in the background, once, with a cooldown
    // after failures), and the client falls back to the paged /stats path,
    // which streams real progress. AIM4_HOT_STORE=off skips even the
    // background build for a box that needs its CPU back entirely.
    const storeDisabled = String(process.env.AIM4_HOT_STORE || '').toLowerCase() === 'off';
    const tables = storeDisabled
      ? null
      : await hotTables(statsIo, user, ready, filter, {
          requireWarm: true,
          teams: wantTeams,
          roles: argHas('roles') || Boolean(filter.role),
          // A demo scope narrows the mask; it never widens what may be read.
          allowedIds: scoped
            ? new Set([...allowedIds].filter((id) => scoped.has(id)))
            : allowedIds
        });

    if (!tables) {
      // Say WHERE the build is, not just that it exists. "Still loading" with
      // no number is indistinguishable from stuck; done/total/eta lets the
      // client draw a real progress line while it rides the paged fallback.
      json(res, 503, {
        error: 'Statistics are still loading. This page will fill in shortly.',
        building: true,
        ...(storeDisabled ? { disabled: true } : {}),
        progress: hotBuildProgress(user),
        demos: ready.length
      });
      return true;
    }

    const { players, teams, maps } = tables;

    // The Database hides players under its minimum-rounds bar, and that bar
    // hides MOST of the library: thousands of one-match names against a few
    // hundred regulars. Filtering here instead of the browser is most of the
    // response gone. Player rows only — team rows are few and their bar is a
    // different question.
    const minRounds = Math.max(0, Math.floor(Number(arg('minRounds')) || 0));
    const rankedPlayers =
      minRounds > 0 ? players.filter((p) => (p.rounds || 0) >= minRounds) : players;

    // Paged. The table shows a hundred rows; a library with thousands of
    // players should not ship all of them to render one screen.
    const page = (rows) => {
      if (!rows) return undefined;
      const off = Math.max(0, Math.floor(Number(arg('offset')) || 0));
      const rawLimit = arg('limit');
      if (rawLimit === null || rawLimit === undefined || rawLimit === '') return rows;
      const limit = Math.max(1, Math.min(5000, Math.floor(Number(rawLimit) || 100)));
      return rows.slice(off, off + limit);
    };
    const offset = Math.max(0, Math.floor(Number(arg('offset')) || 0));

    // A served answer can still be behind: a heal is folding freshly parsed
    // demos in, or a rebuild is running while the old store keeps answering.
    // The Database shows this as "N new demos being processed" instead of
    // silently painting numbers that are about to move.
    const refreshing = hotRefreshing(user);

    // Trimmed to the caller's tier before it leaves the process. This shape —
    // `{ players, teams }` — is exactly what gateStatsPayload was written for,
    // and unlike the streamed round payload (which carries `demos` and is
    // aggregated in the browser) the trim here actually withholds the metric:
    // a client cannot show a column it was never sent.
    await jsonBig(
      res,
      200,
      gateStatsPayload(me, {
        players: page(rankedPlayers),
        playersTotal: rankedPlayers.length,
        ...(wantTeams ? { teams: page(teams), teamsTotal: teams.length } : {}),
        maps,
        offset,
        ...(refreshing ? { refreshing } : {})
      }),
      req
    );
    return true;
  }

  // ---- per-match rows for one player or team -------------------------------
  //
  // The detail view under a name in the Database. Same store, same filters, one
  // row per match instead of one row per entity — so opening a name costs a
  // request rather than the library.
  if (
    (req.method === 'GET' || req.method === 'POST') &&
    p === '/api/replays/aggregate/matches'
  ) {
    let body = null;
    if (req.method === 'POST') {
      try {
        body = await readJson(req, 4 * 1024 * 1024);
      } catch (err) {
        json(res, 400, { error: err?.message || 'Invalid JSON body.' });
        return true;
      }
    }
    const arg = (key) => (body ? body[key] : url.searchParams.get(key));
    const argList = (key) => {
      if (!body) return csv(url, key);
      const v = body[key];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return typeof v === 'string' && v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    };
    const argHas = (key) =>
      body ? body[key] !== undefined && body[key] !== null : url.searchParams.has(key);
    const argFlag = (key) => {
      const v = arg(key);
      return v === 1 || v === true || v === '1' || v === 'true';
    };

    const playerId = String(arg('player') || '').trim();
    const teamKey = String(arg('team') || '').trim();
    if (!playerId && !teamKey) {
      json(res, 400, { error: 'Pass player= or team=.' });
      return true;
    }
    const demoIds = argList('demos') || [];
    if (!demoIds.length) {
      json(res, 200, { rows: [] });
      return true;
    }

    const { records: allRecords, allowed } = await readable();
    const ready = allRecords.filter((r) => (r.status || 'ready') === 'ready');
    const allowedIds = new Set(
      allowed.filter((r) => (r.status || 'ready') === 'ready').map((r) => r.id)
    );
    const scoped = new Set(demoIds);
    const filter = {
      maps: argList('maps') || [],
      side: arg('side') || '',
      econ: argHas('econ') ? Number(arg('econ')) : null,
      oppEcon: argHas('oppEcon') ? Number(arg('oppEcon')) : null,
      hasAwp: argFlag('hasAwp'),
      oppHasAwp: argFlag('oppHasAwp'),
      roundOwn: argList('roundOwn') || [],
      roundOpp: argList('roundOpp') || [],
      fromSec: argHas('fromSec') ? Number(arg('fromSec')) : null,
      toSec: argHas('toSec') ? Number(arg('toSec')) : null,
      result: arg('result') || '',
      advantage: arg('advantage') || '',
      rankOwn: arg('rankOwn') || '',
      rankOpp: arg('rankOpp') || '',
      dateFrom: arg('from') || '',
      dateTo: arg('to') || '',
      files: argList('files') || []
    };
    // Same warm-only rule as /aggregate: a cold store answers "still
    // building" instead of parking this request behind the build. The client
    // falls back to its payload path for the detail view.
    const rows =
      String(process.env.AIM4_HOT_STORE || '').toLowerCase() === 'off'
        ? null
        : await hotMatches(statsIo, user, ready, demoIds, filter, {
            requireWarm: true,
            allowedIds: new Set([...allowedIds].filter((id) => scoped.has(id))),
            want: teamKey ? { kind: 'team', id: teamKey } : { kind: 'player', id: playerId }
          });
    if (!rows) {
      json(res, 503, {
        error: 'Statistics are still loading. This page will fill in shortly.',
        building: true,
        progress: hotBuildProgress(user)
      });
      return true;
    }
    await jsonBig(res, 200, gateStatsPayload(me, { players: rows, rows }), req);
    return true;
  }

  // Diagnostics: what the resident store is holding.
  if (req.method === 'GET' && p === '/api/replays/aggregate/status') {
    // Diagnostics: demo, round and player counts plus resident bytes. Harmless
    // to an operator, but it is a description of the library, so it goes behind
    // the same admin check as the other status tools.
    if (!me.admin) {
      json(res, 403, { error: 'Only site admins can read store status.' });
      return true;
    }
    json(res, 200, hotStoreStatus());
    return true;
  }

  // ---- peer averages -------------------------------------------------------
  // The Performance cards compare against the whole library. When the resident
  // store is warm this is a column scan like /aggregate — milliseconds. When it
  // is cold (the hot path answers null and kicks the background build), the
  // demo-at-a-time walk still answers, slower but correct, so the cards never
  // depend on the store being up. Same accelerator-with-a-fallback contract as
  // everything else here; AIM4_HOT_STORE=off pins the walk.
  if (req.method === 'GET' && p === '/api/replays/peers') {
    const { records: allRecords, allowed } = await readable();
    const readyAll = allRecords.filter((r) => (r.status || 'ready') === 'ready');
    const records = allowed.filter((r) => (r.status || 'ready') === 'ready');
    const filter = {
      map: url.searchParams.get('map') || '',
      dateFrom: url.searchParams.get('from') || '',
      dateTo: url.searchParams.get('to') || ''
    };
    let out = null;
    if (String(process.env.AIM4_HOT_STORE || '').toLowerCase() !== 'off') {
      try {
        out = await peerAveragesHot(statsIo, user, readyAll, filter, {
          allowedIds: new Set(records.map((r) => r.id))
        });
      } catch (err) {
        // The fallback is the feature; a hot-path bug must cost speed, not the page.
        console.warn('[peers] hot path failed, walking instead:', err?.message || err);
        out = null;
      }
    }
    if (!out) out = await peerAverages(statsIo, user, records, filter);
    res.setHeader?.('Cache-Control', 'private, max-age=300');
    json(res, 200, out);
    return true;
  }

  // ---- stats --------------------------------------------------------------
  // Compact per-round index, one page at a time — sized by weight, not by demo
  // count (statsIndex.js STATS_PAGE_BYTES). The
  // client paints the first page, then asks for the next. Filtering still
  // happens in the browser against whatever has arrived so far.
  //
  // POST takes the identical arguments in a body, for one reason: the `demos`
  // scope. A per-map Pattern Finder pull names every demo on that map, and on
  // the game's most-played maps that is over a thousand ids — ~17 KB of query
  // string, past Node's 16 KB request-line-plus-headers limit, so the request
  // never reached this handler at all. It came back 431 and the map simply
  // never loaded. Everything else about the two is the same.
  if (
    (req.method === 'GET' || req.method === 'POST') &&
    p === '/api/replays/stats'
  ) {
    let body = null;
    if (req.method === 'POST') {
      try {
        // Big enough for a whole map's demo list: ~200k ids at ~17 bytes.
        body = await readJson(req, 4 * 1024 * 1024);
      } catch (err) {
        json(res, 400, { error: err?.message || 'Invalid JSON body.' });
        return true;
      }
    }
    /** Query for GET, body for POST. Same names, same meanings. */
    const arg = (key) => (body ? body[key] : url.searchParams.get(key));
    const argList = (key) => {
      if (!body) return csv(url, key);
      const v = body[key];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return typeof v === 'string' && v
        ? v.split(',').map((x) => x.trim()).filter(Boolean)
        : undefined;
    };
    const only = argList('demos');
    const { allowed } = await readable();
    const records = allowed.filter((r) => (r.status || 'ready') === 'ready');
    const streamArg = arg('stream');
    const stream =
      streamArg === '1' ||
      streamArg === 'true' ||
      streamArg === 1 ||
      streamArg === true ||
      /application\/x-ndjson/i.test(String(req.headers.accept || ''));
    const offset = Math.max(0, Math.floor(Number(arg('offset') || 0) || 0));
    const rawLimit = arg('limit');
    // No demo-count clamp here any more: `statsPayload` cuts the page by what
    // the response will WEIGH (STATS_PAGE_BYTES), using the contract's own
    // bytes-per-round and each record's round count. Clamping to 300 on top of
    // that is what made a Pattern Finder scope — a fifth the size per demo —
    // arrive in four round trips instead of one.
    const limit =
      rawLimit === null || rawLimit === undefined || rawLimit === ''
        ? only?.length || STATS_LIBRARY_PAGE
        : Math.max(1, Math.floor(Number(rawLimit) || STATS_LIBRARY_PAGE));
    // Column contract. Absent → the full set, so an old client build keeps
    // working; a bad one is a 400 rather than a silently wrong rating.
    const rawFields = arg('fields');
    const fields = Array.isArray(rawFields) ? rawFields.join(',') : rawFields;
    let pageOpts;
    try {
      pageOpts = { offset, limit, columns: fields };
      // Resolve eagerly so a contract error is a 400 and not a mid-stream abort
      // after the client has already been told the request succeeded.
      resolveColumns(fields ?? null);
    } catch (err) {
      if (err instanceof ColumnContractError) {
        json(res, 400, { error: err.message });
        return true;
      }
      throw err;
    }

    if (!stream) {
      const payload = await statsPayload(statsIo, user, records, only, pageOpts);
      // The aggregate is computed once and then trimmed to the caller's tier.
      // Trimming here rather than in the client is the point: the client cannot
      // reveal a metric it was never sent.
      await jsonBig(res, 200, gateStatsPayload(me, payload), req);
      return true;
    }

    // NDJSON progress so the Database/Analytics UIs can say which demo is
    // building or rebuilding instead of a silent spinner for minutes.
    //
    // Compressed when the caller can take it. This is the largest response the
    // server sends by orders of magnitude — a Pattern Finder pull over a 4100
    // demo library is ~297 MB of JSON, and it is repetitive numeric text, so
    // level 1 gets ~4.4x for a fraction of the CPU the higher levels cost.
    // The browser undoes it in the network layer, so fetchStats reads exactly
    // the same stream either way.
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const streamHeaders = {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      ...CORS
    };
    /** @type {import('node:zlib').Gzip | null} */
    let gz = null;
    if (acceptsGzip) {
      streamHeaders['Content-Encoding'] = 'gzip';
      // Without this a shared cache could hand a gzipped body to a client that
      // never asked for one.
      streamHeaders.Vary = 'Accept-Encoding';
      gz = zlib.createGzip({ level: 1 });
      gz.on('error', () => res.destroy());
      gz.pipe(res);
    }
    const sink = gz || res;
    res.writeHead(200, streamHeaders);

    // Deflate holds bytes back until it has a block worth emitting, which would
    // batch the per-demo progress lines into jumps of a hundred-odd demos and
    // undo the point of having them. A sync flush per line would cost ratio and
    // CPU on 600 lines a page, so flush on a timer instead: fast enough that
    // the count looks live, rare enough to be free.
    let lastFlush = 0;
    const FLUSH_MS = 50;
    const writeLine = (obj) => {
      if (res.writableEnded) return;
      sink.write(`${JSON.stringify(obj)}\n`);
      if (!gz) return;
      const now = Date.now();
      if (now - lastFlush >= FLUSH_MS) {
        lastFlush = now;
        gz.flush(zlib.constants.Z_SYNC_FLUSH);
      }
    };
    try {
      const payload = await statsPayload(statsIo, user, records, only, {
        ...pageOpts,
        onProgress: (p) => writeLine({ type: 'progress', ...p })
      });
      const total = Array.isArray(payload?.demos) ? payload.demos.length : 0;
      // Tell the client we are about to ship the body. The old protocol buried the
      // whole library inside one NDJSON line (`{"type":"done","payload":…}`), which
      // left the UI stuck on "Loaded stats · N demos" while Node stringified and the
      // browser parsed a multi‑megabyte line with no further progress.
      // libraryTotal travels with every progress line, not just the trailer:
      // a consumer must never have to infer the library size from `total`,
      // which is the size of this page.
      writeLine({
        type: 'progress',
        phase: 'packing',
        done: total,
        total,
        offset: payload.offset,
        libraryTotal: payload.total
      });
      const gated = gateStatsPayload(me, payload);
      writeLine({
        type: 'done',
        total,
        offset: payload.offset,
        libraryTotal: payload.total,
        hasMore: payload.hasMore
      });
      // Raw JSON after the NDJSON trailer — not escaped inside another JSON object.
      // The trailer must reach the client before the body starts, or the UI
      // sits on "packing" for however long the body takes to ship.
      if (gz) {
        lastFlush = Date.now();
        gz.flush(zlib.constants.Z_SYNC_FLUSH);
      }
      const body = JSON.stringify(gated);
      const chunk = 64 * 1024;
      for (let i = 0; i < body.length; i += chunk) {
        if (res.writableEnded) break;
        const slice = body.slice(i, i + chunk);
        // No per-chunk flush here: the body is one opaque blob to the client,
        // and letting deflate keep its window is most of the ratio.
        if (!sink.write(slice)) {
          await new Promise((resolve) => sink.once('drain', resolve));
        }
      }
    } catch (err) {
      writeLine({ type: 'error', error: err?.message || 'Stats failed.' });
    }
    // Ending the gzip stream flushes the tail and ends the response behind it.
    sink.end();
    return true;
  }

  /**
   * Spend one use of a quota'd capability.
   *
   * The macro viewer, auto coach, map control and the two win predictions all
   * run in the browser over data the caller is already entitled to fetch, so
   * this is the meter for them: the client asks before running, and a spent
   * quota comes back as the same 402 as everything else.
   *
   * Worth being precise about what this does and does not do. It reliably
   * meters normal use and it is what the UI reads. It is not a hard barrier
   * against someone who skips the call and runs the maths themselves on data
   * they can already download. Making it one means moving those computations
   * onto the server, which is a much larger change than metering them.
   */
  if (req.method === 'POST' && p === '/api/replays/consume') {
    if (!requireUser()) return true;
    const raw = await readJson(req).catch(() => ({}));
    const key = String(raw.capability || '');
    if (!METERED.has(key)) {
      json(res, 400, { error: 'Unknown capability.' });
      return true;
    }
    try {
      const result = await requireQuota(me, key);
      json(res, 200, { allowed: true, ...result });
    } catch (err) {
      const refusal = upgradeResponse(err);
      if (!refusal) throw err;
      json(res, refusal.status, refusal.body);
    }
    return true;
  }

  // Rebuild / enrich stats indexes that are missing or behind the current
  // schema (PRW, possession, swing, …). ?force=1 drops every index first.
  if (req.method === 'POST' && p === '/api/replays/stats/refresh') {
    if (!me.admin) {
      json(res, 403, { error: 'Only site admins can rebuild the stats index.' });
      return true;
    }
    const force =
      url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
    const records = await listDemos(user);
    try {
      const report = await refreshLibraryStats(statsIo, user, records, { force });
      json(res, 200, { ok: true, ...report });
    } catch (err) {
      json(res, 500, { error: err?.message || 'Stats refresh failed.' });
    }
    return true;
  }

  // ---- saved views --------------------------------------------------------
  //
  // Visibility mirrors playlists: yours, plus the team views of any team you
  // are on. A share id resolves without either, which is the point of it.
  const viewsFor = async () => {
    const list = await readSavedViews(user);
    if (me.admin) return list;
    const myTeams = me.signedIn ? await teamsOf(me.id) : [];
    const teamIds = new Set(myTeams.map((t) => t.id));
    return list.filter(
      (v) =>
        (v.ownerId && v.ownerId === me.id) ||
        (v.scope === 'team' && v.teamId && teamIds.has(v.teamId))
    );
  };

  if (p === '/api/replays/views') {
    if (req.method === 'GET') {
      json(res, 200, { views: await viewsFor() });
      return true;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }
      if (!requireUser()) return true;
      try {
        await upsertSavedView(user, body, {
          id: me.id,
          username: me.username,
          admin: me.admin,
          teamId: await playlistTeamId()
        });
        json(res, 200, { views: await viewsFor() });
      } catch (err) {
        json(res, err.status || 400, { error: err.message || 'Could not save that view.' });
      }
      return true;
    }
  }

  const viewShareMatch = p.match(/^\/api\/replays\/views\/share\/([A-Za-z0-9_-]{8,32})$/);
  if (req.method === 'GET' && viewShareMatch) {
    const view = await savedViewByShareId(user, viewShareMatch[1]);
    if (!view) {
      json(res, 404, { error: 'That view no longer exists.' });
      return true;
    }
    // The share link carries the spec only. Who made it and which team it
    // belongs to are not the link holder's business.
    json(res, 200, { view: { name: view.name, page: view.page, spec: view.spec } });
    return true;
  }

  const savedViewMatch = p.match(/^\/api\/replays\/views\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && savedViewMatch) {
    if (!requireUser()) return true;
    let list;
    try {
      list = await removeSavedView(user, savedViewMatch[1], {
        id: me.id,
        username: me.username,
        admin: me.admin
      });
    } catch (err) {
      json(res, err.status || 400, { error: err.message || 'Could not delete that view.' });
      return true;
    }
    if (!list) {
      json(res, 404, { error: 'View not found.' });
      return true;
    }
    json(res, 200, { views: await viewsFor() });
    return true;
  }

  // ---- playlists ----------------------------------------------------------
  if (p === '/api/replays/playlists') {
    if (req.method === 'GET') {
      json(res, 200, { playlists: await playlistsFor() });
      return true;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }
      if (!requireUser()) return true;
      // A team-scoped playlist is shared with everyone on the roster, so it is
      // a team feature. Which scope this write ends in is not always in the
      // body: leaving `scope` out of an edit keeps whatever the stored playlist
      // has, so a rename of a team playlist has to be gated too, and gating on
      // `body.scope === 'team'` alone would miss it.
      const asked =
        body?.scope === 'team' ? 'team' : body?.scope === 'private' ? 'private' : null;
      const playlistId = String(body?.id || '').replace(/[^A-Za-z0-9_-]/g, '');
      const stored = playlistId
        ? (await readPlaylists(user)).find((pl) => pl.id === playlistId)
        : null;
      const resulting = asked || (stored?.scope === 'team' ? 'team' : 'private');
      if (resulting === 'team' && !(await requireCap(CAP.TEAM_PLAYLISTS))) return true;
      try {
        await upsertPlaylist(user, body, {
          id: me.id,
          username: me.username,
          admin: me.admin,
          teamId: await playlistTeamId()
        });
        json(res, 200, { playlists: await playlistsFor() });
      } catch (err) {
        json(res, err.status || 400, { error: err.message || 'Could not save the playlist.' });
      }
      return true;
    }
  }

  const playlistMatch = p.match(/^\/api\/replays\/playlists\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && playlistMatch) {
    // Not gated on team.playlists, unlike creating and editing one. removePlaylist
    // already refuses someone else's playlist, and an account that has dropped
    // off a team plan still has to be able to clear out what it made while it
    // was on one. A gate here would leave those playlists undeletable.
    if (!requireUser()) return true;
    let list;
    try {
      list = await removePlaylist(user, playlistMatch[1], {
        id: me.id,
        username: me.username,
        admin: me.admin
      });
    } catch (err) {
      json(res, err.status || 400, { error: err.message || 'Could not delete that playlist.' });
      return true;
    }
    if (!list) {
      json(res, 404, { error: 'Playlist not found.' });
      return true;
    }
    json(res, 200, { playlists: await playlistsFor() });
    return true;
  }

  // ---- spawn points -------------------------------------------------------
  // Real starting positions for one map, sampled from the demos this caller is
  // allowed to read. The Strategy Creator paints these as its spawn choices.
  if (req.method === 'GET' && p === '/api/replays/spawns') {
    const map = String(url.searchParams.get('map') || '').toUpperCase();
    if (!map) {
      json(res, 400, { error: 'Name a map.' });
      return true;
    }
    const { allowed } = await readable();
    const spawns = await spawnsForMap(statsIo, user, allowed, map);
    json(res, 200, { map, spawns, minSeparation: 30 });
    return true;
  }

  // ---- rounds -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/rounds') {
    const limit = Number(url.searchParams.get('limit') || 2000);
    const { allowed } = await readable();
    const { records, byId, ownersLazy } = await roundLookup();
    const seen = visibleDemoIds(allowed, access);
    const [found, noted] = await Promise.all([
      findRounds(user, queryFromUrl(url), { limit }),
      listNotedRounds(user)
    ]);
    const rounds = found.filter((r) => {
      const name = r.file || r.name || r;
      // Same rule as canOpenRound: the owner index is built only if a legacy
      // name in this result set actually needs it, and then just once.
      const legacy = String(name || '').lastIndexOf('~') <= 0;
      const record = recordForRoundFile(name, records, legacy ? ownersLazy() : null, byId);
      // A round with no owning record predates materialization; treat the
      // library default (public) as the answer rather than hiding history.
      return !record || seen.has(record.id);
    });
    if (sampleLibraryOverlayEnabled()) {
      const extraNames = await listSampleRoundNames();
      if (extraNames.length) {
        const have = new Set(rounds.map((r) => r.file || r.name || r));
        const extra = collectRounds(extraNames, queryFromUrl(url), { limit }).filter(
          (r) => !have.has(r.file || r.name || r)
        );
        rounds.push(...extra);
      }
    }
    // Up to 2000 round summaries; repetitive enough to be worth the gzip.
    await jsonBig(res, 200, { rounds, total: rounds.length, noted }, req);
    return true;
  }

  // Batched round packs: meta + (optionally) ticks for many rounds in one
  // response. The shape search reads tens of thousands of rounds per map, and
  // two GETs per round through the browser's six-connection cap made that
  // phase minutes of pure round-trips. Access is the same canOpenRound the
  // per-round routes enforce; a denied or missing round comes back with a null
  // meta and the client falls back to its per-round path for it.
  /**
   * The matching projection of one round's meta.
   *
   * Top level is copied minus the known-heavy bags, so a new scalar field
   * flows to the matcher without touching this function; `events` is a
   * whitelist because that is where the weight lives (kills ~1.4 KB and
   * grenades ~2 KB stay; shots ~16 KB goes). The client asks for this
   * explicitly, so an older bundle keeps getting the full form.
   */
  const MATCH_META_DROP = new Set(['stats', 'weapons', 'parser', 'events']);
  const MATCH_EVENTS_KEEP = ['kills', 'grenades', 'bomb'];
  function matchProjection(meta) {
    if (!meta || typeof meta !== 'object') return meta;
    const out = {};
    for (const [k, v] of Object.entries(meta)) if (!MATCH_META_DROP.has(k)) out[k] = v;
    const ev = meta.events;
    if (ev && typeof ev === 'object') {
      out.events = {};
      for (const k of MATCH_EVENTS_KEEP) if (ev[k] !== undefined) out.events[k] = ev[k];
    }
    return out;
  }

  if (req.method === 'POST' && p === '/api/replays/rounds/packs') {
    let body;
    try {
      body = await readJson(req, 256 * 1024);
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    const files = (Array.isArray(body.files) ? body.files : [])
      .map((f) => String(f || ''))
      .filter((f) => /^[A-Za-z0-9_~-]+$/.test(f));
    if (!files.length) {
      json(res, 400, { error: 'Pass files: [roundFile, …].' });
      return true;
    }
    if (files.length > 400) {
      json(res, 400, { error: 'At most 400 rounds per request.' });
      return true;
    }
    const wantTicks = body.ticks !== false;
    // `meta: 'match'` asks for the MATCHING projection of each round's meta:
    // the fields the Pattern Finder's shape / phase / utility predicates read,
    // and nothing else. A full meta is ~27 KB and ~60% of it is `events.shots`
    // — every bullet of the round — which no search predicate looks at. Across
    // a 150-round batch that is megabytes of transfer whose only visible
    // effect was a ten-second gap between the client's progress bursts.
    const slimMeta = body.meta === 'match';
    const stride = Math.max(1, Math.min(1000, Number(body.stride) || 100));
    // Warm both lookups once; every canOpenRound below is then map reads.
    await roundLookup();
    const entries = new Array(files.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const idx = cursor++;
        const file = files[idx];
        const entry = { file, meta: null, ticks: null };
        entries[idx] = entry;
        try {
          if (!(await canOpenRound(file))) continue;
          entry.meta = await readRoundMetaMaybeSample(user, file);
          if (entry.meta && slimMeta) entry.meta = matchProjection(entry.meta);
          if (entry.meta && wantTicks) {
            entry.ticks = await readRoundTicksMaybeSample(user, file, stride);
          }
        } catch {
          entry.meta = null;
          entry.ticks = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
    let buf = Buffer.from(encodeRoundPacks(entries));
    const headers = {
      'Content-Type': 'application/vnd.aim4.round-packs',
      'Cache-Control': 'no-store',
      ...CORS
    };
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      buf = await gzip(buf, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = buf.length;
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  }

  const ticksMatch = p.match(/^\/api\/replays\/rounds\/([A-Za-z0-9_~-]+)\/ticks$/);
  if (req.method === 'GET' && ticksMatch) {
    if (!(await canOpenRound(ticksMatch[1]))) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    const stride = Number(url.searchParams.get('stride') || 1);
    // A client that says fmt=packed ships the varint unpack, so the columnar
    // body can go out as-is: ~75 KB instead of ~261 KB, and after the first
    // request no CPU at all. Only full detail has a packed form; the coarse
    // pass is a precomputed 10 KB file that is not worth transforming.
    const wantsPacked = url.searchParams.get('fmt') === 'packed' && stride === 1;
    if (wantsPacked && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      let body;
      try {
        body = await readRoundTicksPacked(user, ticksMatch[1]);
      } catch (err) {
        json(res, 400, { error: err.message || 'Bad round name.' });
        return true;
      }
      if (body) {
        res.writeHead(200, {
          // The magic in the body is what the client actually branches on, so a
          // proxy that rewrites this header cannot make it decode the wrong way.
          'Content-Type': 'application/vnd.aim4.ticks-packed',
          'Content-Encoding': 'gzip',
          'Content-Length': body.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
          Vary: 'Accept-Encoding',
          ...CORS
        });
        res.end(body);
        return true;
      }
    }

    let buf;
    try {
      buf = await readRoundTicks(user, ticksMatch[1], stride);
      if (!buf && sampleDemosEnabled()) buf = await getSampleRoundTicks(ticksMatch[1], stride);
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!buf) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    await binary(res, buf, req);
    return true;
  }

  const noteMatch = p.match(/^\/api\/replays\/rounds\/([A-Za-z0-9_~-]+)\/note$/);
  if (req.method === 'POST' && noteMatch) {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      json(res, 400, { error: err.message });
      return true;
    }
    let saved;
    try {
      saved = await writeRoundNotes(user, noteMatch[1], body);
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!saved) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    json(res, 200, { ...saved, maxLength: NOTE_MAX });
    return true;
  }

  // Zone networks — same shared on-disk library as notes (AIM4_REPLAY_DIR).
  // --- fitted model weights ------------------------------------------------
  // Public and unauthenticated, because every viewer needs them to draw a win
  // chart and they are derived statistics rather than anyone's data. This is
  // what lets a model trained on the server reach users without a redeploy:
  // the bundled params file is only ever the fallback.
  const modelMatch = p.match(/^\/api\/replays\/models\/(duel|round)$/);
  if (modelMatch && req.method === 'GET') {
    const champion = await readChampion(modelMatch[1]);
    if (!champion) {
      json(res, 404, { error: 'no trained model' }, { 'Cache-Control': 'public, max-age=60' });
      return true;
    }
    json(
      res,
      200,
      {
        kind: champion.kind,
        specHash: champion.specHash,
        values: champion.values,
        validLoss: champion.validLoss,
        exams: champion.exams,
        trainedOn: champion.trainedOn,
        updatedAt: champion.updatedAt
      },
      // Short enough that a promotion reaches viewers within minutes, long
      // enough that it is not fetched on every round change.
      { 'Cache-Control': 'public, max-age=300' }
    );
    return true;
  }

  if (req.method === 'GET' && p === '/api/replays/zones') {
    json(res, 200, { maps: await listZoneMaps() });
    return true;
  }

  // Private coach smoke landing spots (admin-curated). Readable so Autocoach
  // can match thrown smokes; writes stay on /api/admin/coach-smokes.
  if (req.method === 'GET' && p === '/api/replays/coach-smokes') {
    json(res, 200, { maps: await listCoachSmokeMaps() });
    return true;
  }
  const coachSmokesMatch = p.match(/^\/api\/replays\/coach-smokes\/([A-Za-z0-9]{2,4})$/i);
  if (req.method === 'GET' && coachSmokesMatch) {
    try {
      json(res, 200, { archive: await getCoachSmokes(coachSmokesMatch[1]) });
    } catch (err) {
      json(res, 400, { error: err.message || 'Invalid map code.' });
    }
    return true;
  }

  const zonesMatch = p.match(/^\/api\/replays\/zones\/([A-Za-z0-9]{2,4})$/i);
  if (zonesMatch) {
    const map = zonesMatch[1];
    if (req.method === 'GET') {
      const network = await getZones(map);
      if (!network) {
        json(res, 400, { error: 'Invalid map code.' });
        return true;
      }
      json(res, 200, { network });
      return true;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJson(req, 2 * 1024 * 1024);
      } catch (err) {
        json(res, 400, { error: err.message });
        return true;
      }
      try {
        const network = await saveZones(map, body);
        json(res, 200, { ok: true, network });
      } catch (err) {
        json(res, 400, { error: err.message || 'Invalid zones payload' });
      }
      return true;
    }
  }

  const roundMatch = p.match(/^\/api\/replays\/rounds\/([A-Za-z0-9_~-]+)$/);
  if (req.method === 'GET' && roundMatch) {
    let meta;
    try {
      meta = await readRoundMeta(user, roundMatch[1]);
      if (!meta && sampleDemosEnabled()) meta = await getSampleRoundMeta(roundMatch[1]);
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!meta || !(await canOpenRound(roundMatch[1]))) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    // Immutable for the same reason the tick buffer is: the round file name
    // encodes which round of which demo this is, and a written round is never
    // rewritten. Reopening a demo was refetching every round's meta from the
    // server; now the browser answers from its own cache.
    // Compressed: round meta is repetitive JSON — kill lists, damage events and
    // grenade paths — and the viewer pulls one per round when a demo opens,
    // which measured ~950 KB uncompressed for a 22-round match. It is immutable
    // and cached hard, so this is a first-open cost, but it is the first open
    // that people notice.
    await jsonBig(res, 200, { round: meta }, req, {
      'Cache-Control': 'private, max-age=31536000, immutable'
    });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
