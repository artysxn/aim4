// ---------------------------------------------------------------------------
// replays/routes.js
// /api/replays/* — the demo library and the round collector.
//
//   GET    /api/replays/status                   parser + quota
//   GET    /api/replays/demos                    library listing
//   POST   /api/replays/demos                    upload (raw .dem body)
//   GET    /api/replays/demos/:id                one demo + parse progress
//   POST   /api/replays/demos/:id/parse          re-run a failed parse
//   DELETE /api/replays/demos/:id                remove demo + its rounds
//   GET    /api/replays/rounds?...               filter by name, no file reads
//   GET    /api/replays/rounds/:file             round meta + events
//   GET    /api/replays/rounds/:file/ticks       tick buffer, ?stride=N
//
// Uploads stream straight to disk: a demo is hundreds of megabytes and must
// never be buffered in memory or pass through the JSON body reader.
// ---------------------------------------------------------------------------

import { parserStatus } from '../demoparser/index.js';
import {
  MAX_BYTES,
  MAX_DEMOS,
  checkQuota,
  deleteDemo,
  findRounds,
  listDemos,
  newDemoId,
  readRecord,
  readRoundMeta,
  readRoundTicks,
  saveUpload,
  usage,
  writeRecord
} from './demoStore.js';
import { allJobs, enqueueParse, jobStatus } from './jobs.js';
import { authStatus, identify } from './auth.js';

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
