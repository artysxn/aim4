// ---------------------------------------------------------------------------
// replays/routes.js
// /api/replays/* — the demo library and the round collector.
//
//   GET    /api/replays/diag                     public crash / memory diagnostic
//   GET    /api/replays/status                   parser + quota
//   GET    /api/replays/demos                    library listing
//   POST   /api/replays/demos                    upload (raw .dem body)
//   POST   /api/replays/import                   upload a local .aim4replay package
//   GET    /api/replays/demos/:id                one demo + parse progress
//   POST   /api/replays/demos/:id/parse          re-run a failed parse
//   DELETE /api/replays/demos/:id                remove demo + its rounds
//   GET    /api/replays/rounds?...               filter by name, no file reads
//   GET    /api/replays/rounds/:file             round meta + events
//   GET    /api/replays/rounds/:file/ticks       tick buffer, ?stride=N
//
// Uploads stream straight to disk: a demo / package is hundreds of megabytes
// and must never be buffered in memory or pass through the JSON body reader.
// ---------------------------------------------------------------------------

import os from 'node:os';
import fsSync from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parserStatus } from '../demoparser/index.js';
import {
  ROOT,
  MAX_BYTES,
  MAX_DEMOS,
  NOTE_MAX,
  checkQuota,
  deleteDemo,
  findRounds,
  listDemos,
  newDemoId,
  readPlaylists,
  readRecord,
  readRoundMeta,
  readRoundTicks,
  removePlaylist,
  renameDemoTeams,
  saveTempUpload,
  saveUpload,
  upsertPlaylist,
  usage,
  writeRecord,
  writeRoundNote
} from './demoStore.js';
import { allJobs, enqueueParse, jobStatus } from './jobs.js';
import { authStatus, identify } from './auth.js';
import { importReplayPackage } from './importPackage.js';
import { PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';

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

function binary(res, buffer) {
  const buf = Buffer.from(buffer);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': buf.length,
    // Round files are immutable: the name encodes the content, so a round can
    // be cached hard once fetched.
    'Cache-Control': 'private, max-age=31536000, immutable',
    ...CORS
  });
  res.end(buf);
}

/** Small JSON bodies only (notes, playlists, team names). Uploads never come here. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Body too large.');
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
    wonBy: url.searchParams.get('wonBy') || undefined,
    economies: nums(url, 'economies'),
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

function memorySnapshot() {
  const mem = process.memoryUsage();
  const snap = {
    serverRssMb: Math.round(mem.rss / 1024 / 1024),
    heapLimitMb: Number(process.env.AIM4_PARSE_HEAP_MB || 1024),
    batchTicks: Number(process.env.AIM4_PARSE_BATCH_TICKS || 200000)
  };
  // Inside a container the cgroup limit is what actually matters, and it is
  // usually smaller than what os.totalmem() reports.
  try {
    const v2 = fsSync.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    snap.containerLimitMb = v2 === 'max' ? 'unlimited' : Math.round(Number(v2) / 1024 / 1024);
    snap.containerUsedMb = Math.round(
      Number(fsSync.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim()) / 1024 / 1024
    );
  } catch {
    /* not cgroup v2, or not in a container */
  }
  snap.hostTotalMb = Math.round(os.totalmem() / 1024 / 1024);
  snap.hostFreeMb = Math.round(os.freemem() / 1024 / 1024);
  snap.cpus = os.cpus().length;
  return snap;
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
      uptimeSeconds: Math.round(process.uptime())
    });
    return true;
  }

  // Every route below reads or writes one account's private library, so the
  // caller is resolved once, here, and nothing downstream sees a raw header.
  const auth = await identify(req);
  if (!auth.ok) {
    json(res, auth.status || 401, { error: auth.error || 'Not authorized.' });
    return true;
  }
  const user = auth.user;

  // ---- status -------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/status') {
    json(res, 200, {
      parser: parserStatus(),
      auth: authStatus(),
      usage: await usage(user),
      limits: { maxDemos: MAX_DEMOS, maxBytes: MAX_BYTES }
    });
    return true;
  }

  // ---- library ------------------------------------------------------------
  if (req.method === 'GET' && p === '/api/replays/demos') {
    const records = await listDemos(user);
    const byId = new Set(records.map((r) => r.id));
    // A job whose record has not landed yet (upload just finished) still shows.
    const pending = allJobs(user)
      .filter((j) => !byId.has(j.demoId) && j.state !== 'done')
      .map((j) => ({
        id: j.demoId,
        status: j.state === 'error' ? 'error' : 'parsing',
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
    if (!/\.dem$/i.test(filename)) {
      json(res, 400, { error: 'Only .dem files can be uploaded.' });
      return true;
    }
    const declared = Number(req.headers['content-length'] || 0);
    const gate = await checkQuota(user, declared);
    if (!gate.ok) {
      json(res, 413, { error: gate.error, usage: gate.usage });
      return true;
    }

    const demoId = newDemoId();
    let sizeBytes = 0;
    try {
      sizeBytes = await saveUpload(user, demoId, req, gate.usage.bytesLeft);
    } catch (err) {
      json(res, 413, { error: err.message || 'Upload failed.' });
      return true;
    }
    if (!sizeBytes) {
      json(res, 400, { error: 'Empty upload.' });
      return true;
    }

    const record = {
      id: demoId,
      status: 'parsing',
      filename,
      sizeBytes,
      uploadedAt: Date.now(),
      rounds: []
    };
    await writeRecord(user, record);
    enqueueParse({ user, demoId, filename, sizeBytes });
    json(res, 201, { demo: withJob(user, record), usage: await usage(user) });
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
      const saved = await saveTempUpload(req, gate.usage.bytesLeft, 'import');
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
    const rounds = await findRounds(user, queryFromUrl(url), { limit });
    json(res, 200, { rounds, total: rounds.length });
    return true;
  }

  const ticksMatch = p.match(/^\/api\/replays\/rounds\/([A-Za-z0-9_~-]+)\/ticks$/);
  if (req.method === 'GET' && ticksMatch) {
    const stride = Number(url.searchParams.get('stride') || 1);
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
    binary(res, buf);
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
      saved = await writeRoundNote(user, noteMatch[1], body.note);
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
