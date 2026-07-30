// ---------------------------------------------------------------------------
// replays/routes.js
// /api/replays/* — the demo library and the round collector.
//
//   GET    /api/replays/diag                     public crash / memory diagnostic
//   GET    /api/replays/status                   parser + quota
//   GET    /api/replays/demos                    library listing
//   POST   /api/replays/demos                    upload .dem or an archive of them
//   GET    /api/replays/uploads/:batchId         unpack + parse progress for one upload
//   POST   /api/replays/import                   upload a local .aim4replay package
//   GET    /api/replays/demos/:id                one demo + parse progress
//   POST   /api/replays/demos/:id/parse          re-run a failed parse
//   DELETE /api/replays/demos/:id                remove demo + its rounds
//   GET    /api/replays/rounds?...               filter by name, no file reads
//   GET    /api/replays/rounds/:file             round meta + events
//   GET    /api/replays/rounds/:file/ticks       tick buffer, ?stride=N&fmt=packed
//   GET    /api/replays/zones                    maps that have a zone file
//   GET    /api/replays/zones/:map               zone network for one map
//   POST   /api/replays/zones/:map               save zone polygons + names
//
// Uploads stream straight to disk: a demo / package is hundreds of megabytes
// and must never be buffered in memory or pass through the JSON body reader.
// ---------------------------------------------------------------------------

import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { parserStatus } from '../demoparser/index.js';
import {
  ROOT,
  MAX_BYTES,
  MAX_UPLOAD_BYTES,
  NOTE_MAX,
  checkQuota,
  deleteDemo,
  findRounds,
  listDemos,
  listNotedRounds,
  readPlaylists,
  readRecord,
  readRoundMeta,
  readRoundTicks,
  readRoundTicksPacked,
  removePlaylist,
  renameDemoTeams,
  saveTempUpload,
  upsertPlaylist,
  usage,
  userDir,
  writeRecord,
  writeRoundNotes
} from './demoStore.js';
import { cpuProbe, memorySnapshot } from './hostMemory.js';
import { forgetDemoIndex, scheduleStatsIndex, statsPayload } from './statsIndex.js';
import { isAcceptedUpload, rarSupport } from './archive.js';
import { allJobs, batchStatus, enqueueParse, forgetJob, getBatch, jobStatus, startIngest } from './jobs.js';
import { SHARED_LIBRARY, authStatus, identify } from './auth.js';
import { importReplayPackage } from './importPackage.js';
import { PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { getZones, listZoneMaps, saveZones } from '../zonesStore.js';

/** What the stats index needs from storage, without importing it back. */
const statsIo = { userDir, readRoundMeta, readRoundTicks, getZones };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Aim4-User, X-Aim4-Filename'
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS
  });
  res.end(payload);
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
function binary(res, buffer, req = null) {
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
    buf = zlib.gzipSync(buf, { level: 6 });
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

  // Shared public library — identify always succeeds (no sign-in gate).
  const auth = await identify(req);
  const user = auth.user;

  // ---- status -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/status') {
    json(res, 200, {
      parser: parserStatus(),
      auth: authStatus(),
      usage: await usage(user),
      limits: { maxBytes: MAX_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES },
      // .rar needs an external extractor, so whether it works is a property of
      // the host rather than of the code.
      rar: rarSupport()
    });
    return true;
  }

  // ---- library ------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/demos') {
    const records = await listDemos(user);
    const byId = new Set(records.map((r) => r.id));
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
    json(res, 200, {
      demos: [...pending, ...records.map((r) => withJob(user, r))],
      usage: await usage(user)
    });
    return true;
  }

  if (req.method === 'POST' && p === '/api/replays/demos') {
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

    // Always land on a temp file first, even for a bare .dem. Unpacking decides
    // where the demo finally lives (a .zip produces several), and the ingest
    // pipeline adopts a lone .dem by renaming it rather than copying it.
    //
    // gate.allowed, not bytesLeft: a request with no Content-Length, or a lying
    // one, skips the check above entirely, so the per-upload cap has to be the
    // ceiling the stream is actually held to.
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
    // What comes OUT of an archive is bounded by the library quota rather than
    // the per-upload cap: 5 GB of demos can legitimately expand well past 5 GB,
    // and the quota is the limit that actually protects the disk. The archive's
    // own size is subtracted because it is still on disk at this point.
    const batch = startIngest({
      user,
      filename,
      source: saved.path,
      sizeBytes: saved.sizeBytes,
      allowedBytes: Math.max(0, gate.usage.bytesLeft - saved.sizeBytes)
    });
    json(res, 202, { batch: batchStatus(batch), usage: await usage(user) });
    return true;
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
        uploadedAt: Date.now()
      });
      scheduleStatsIndex(statsIo, user, record);
      json(res, 201, { demo: withJob(user, record), usage: await usage(user) });
    } catch (err) {
      const status = err.status || 400;
      json(res, status, { error: err.message || 'Import failed.', usage: err.usage });
    } finally {
      if (tmp) await rm(tmp, { force: true }).catch(() => {});
    }
    return true;
  }

  const demoMatch = p.match(/^\/api\/replays\/demos\/([A-Za-z0-9_-]+)$/);
  if (demoMatch) {
    const id = demoMatch[1];
    if (req.method === 'GET') {
      const record = await readRecord(user, id);
      if (!record) {
        json(res, 404, { error: 'Replay not found.' });
        return true;
      }
      json(res, 200, { demo: withJob(user, record) });
      return true;
    }
    if (req.method === 'DELETE') {
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
    const record = await renameDemoTeams(user, id, body.team1, body.team2);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    json(res, 200, { demo: withJob(user, record), usage: await usage(user) });
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

  // ---- stats --------------------------------------------------------------
  // Returns the compact per-round index, not finished tables: the client
  // re-filters and re-aggregates it locally, so changing a filter (or scrubbing
  // the viewer's live scoreboard round by round) costs no request at all.
  if (req.method === 'GET' && p === '/api/replays/stats') {
    const only = csv(url, 'demos');
    const records = (await listDemos(user)).filter((r) => (r.status || 'ready') === 'ready');
    const payload = await statsPayload(statsIo, user, records, only);
    json(res, 200, payload);
    return true;
  }

  // ---- playlists ----------------------------------------------------------
  if (p === '/api/replays/playlists') {
    if (req.method === 'GET') {
      json(res, 200, { playlists: await readPlaylists(user) });
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
      try {
        json(res, 200, { playlists: await upsertPlaylist(user, body) });
      } catch (err) {
        json(res, err.status || 400, { error: err.message || 'Could not save the playlist.' });
      }
      return true;
    }
  }

  const playlistMatch = p.match(/^\/api\/replays\/playlists\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && playlistMatch) {
    const list = await removePlaylist(user, playlistMatch[1]);
    if (!list) {
      json(res, 404, { error: 'Playlist not found.' });
      return true;
    }
    json(res, 200, { playlists: list });
    return true;
  }

  // ---- rounds -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/rounds') {
    const limit = Number(url.searchParams.get('limit') || 2000);
    const [rounds, noted] = await Promise.all([
      findRounds(user, queryFromUrl(url), { limit }),
      listNotedRounds(user)
    ]);
    json(res, 200, { rounds, total: rounds.length, noted });
    return true;
  }

  const ticksMatch = p.match(/^\/api\/replays\/rounds\/([A-Za-z0-9_~-]+)\/ticks$/);
  if (req.method === 'GET' && ticksMatch) {
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
      if (!body) {
        json(res, 404, { error: 'Round not found.' });
        return true;
      }
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

    let buf;
    try {
      buf = await readRoundTicks(user, ticksMatch[1], stride);
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!buf) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    binary(res, buf, req);
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
  if (req.method === 'GET' && p === '/api/replays/zones') {
    json(res, 200, { maps: await listZoneMaps() });
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
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!meta) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    json(res, 200, { round: meta });
    return true;
  }

  json(res, 404, { error: 'Not found' });
  return true;
}
