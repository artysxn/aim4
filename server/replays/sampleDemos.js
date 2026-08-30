// ---------------------------------------------------------------------------
// replays/sampleDemos.js
// Local .aim4replay files in sampledemos/, served without a library import.
//
// Host (`npm run host`) also overlays them onto GET /api/replays/demos and
// the round/package routes so the 2D viewer and 3D Import round see the same
// records. Vite serves /api/sampledemos so `npm run dev` works without the
// replay library backend. Production stays out unless AIM4_SAMPLE_DEMOS=1.
// ---------------------------------------------------------------------------

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const zstdDecompress = promisify(zlib.zstdDecompress);
import { fileURLToPath } from 'node:url';

import { decodeReplayPackage, PACKAGE_EXT } from '../../src/replays/shared/replayPackage.js';
import { sliceStride } from '../../src/replays/shared/tickFormat.js';
import { decodeTickzAsync, decodeTickzStrideAsync, isTickz } from './tickCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_SAMPLE_DIR = path.join(__dirname, '../../sampledemos');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

const SAMPLE_OWNER = { id: 'system:sample', username: 'sample' };

/** @type {{ dirMtime: number, dir: string, items: SampleItem[] } | null} */
let cache = null;

/**
 * @typedef {object} SampleItem
 * @property {string} id
 * @property {string} file
 * @property {Buffer} bytes
 * @property {Map<string, Uint8Array>} pack
 * @property {object} record
 */

export function sampleDir() {
  return process.env.AIM4_SAMPLE_DIR || REPO_SAMPLE_DIR;
}

function flag() {
  return String(process.env.AIM4_SAMPLE_DEMOS || '').toLowerCase();
}

/** Serve /api/sampledemos when the folder has packages, unless explicitly off. */
export function sampleDemosEnabled() {
  const f = flag();
  if (f === 'off' || f === '0' || f === 'false') return false;
  return true;
}

/**
 * Fold samples into the real /api/replays library.
 *
 * On for `npm run host` (AIM4_SERVE_STATIC) or AIM4_SAMPLE_DEMOS=1. Off in
 * replay-route tests, which isolate AIM4_REPLAY_DIR and would otherwise see
 * the repo corpus as extra public demos.
 */
export function sampleLibraryOverlayEnabled() {
  const f = flag();
  if (f === 'off' || f === '0' || f === 'false') return false;
  if (f === '1' || f === 'true' || f === 'on') return true;
  return process.env.AIM4_SERVE_STATIC === '1' || process.env.AIM4_SERVE_STATIC === 'true';
}

function stamp(manifest, file) {
  return {
    ...manifest,
    status: manifest.status || 'ready',
    visibility: 'public',
    source: manifest.source || 'sample',
    uploaderId: SAMPLE_OWNER.id,
    uploaderName: SAMPLE_OWNER.username,
    sampleFile: path.basename(file)
  };
}

function asArrayBuffer(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function loadIndex() {
  if (!sampleDemosEnabled()) return [];
  const dir = sampleDir();
  let mtime = 0;
  try {
    mtime = (await fsp.stat(dir)).mtimeMs;
  } catch {
    cache = { dirMtime: 0, dir, items: [] };
    return cache.items;
  }
  if (cache && cache.dir === dir && cache.dirMtime === mtime) return cache.items;

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    cache = { dirMtime: mtime, dir, items: [] };
    return cache.items;
  }

  const items = [];
  for (const name of names.filter((n) => n.endsWith(PACKAGE_EXT)).sort()) {
    const file = path.join(dir, name);
    try {
      const bytes = await fsp.readFile(file);
      const { files: pack } = decodeReplayPackage(bytes);
      const manifestBytes = pack.get('manifest.json');
      if (!manifestBytes) continue;
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      if (!manifest?.id) continue;
      items.push({ id: String(manifest.id), file, bytes, pack, record: stamp(manifest, file) });
    } catch (err) {
      console.warn(`sampledemos: skip ${name}: ${err?.message || err}`);
    }
  }
  cache = { dirMtime: mtime, dir, items };
  return items;
}

/** Test helper: drop the in-memory index so the next call re-reads disk. */
export function resetSampleDemoCache() {
  cache = null;
}

export async function listSampleRecords() {
  return (await loadIndex()).map((item) => item.record);
}

export async function getSampleRecord(id) {
  const key = String(id || '');
  const item = (await loadIndex()).find((it) => it.id === key);
  return item?.record || null;
}

export async function getSamplePackageBytes(id) {
  const key = String(id || '');
  const item = (await loadIndex()).find((it) => it.id === key);
  return item ? item.bytes : null;
}

function packGet(pack, stem, ext) {
  return pack.get(`rounds/${stem}${ext}`) || pack.get(`${stem}${ext}`) || null;
}

function stemOf(file) {
  const s = String(file || '').split('.')[0];
  if (!/^[A-Za-z0-9_~-]+$/.test(s)) throw new Error('Invalid round name');
  return s;
}

function itemForRound(items, stem) {
  const cut = stem.lastIndexOf('~');
  if (cut > 0) {
    const demoId = stem.slice(cut + 1);
    const hit = items.find((it) => it.id === demoId);
    if (hit) return hit;
  }
  return items.find((it) => (it.record.rounds || []).some((r) => (r.file || r) === stem)) || null;
}

export async function getSampleRoundMeta(file) {
  const stem = stemOf(file);
  const items = await loadIndex();
  const item = itemForRound(items, stem);
  if (!item) return null;
  const zst = packGet(item.pack, stem, '.json.zst');
  const plain = packGet(item.pack, stem, '.json');
  if (!zst && !plain) return null;
  return JSON.parse(
    zst
      ? (await zstdDecompress(Buffer.from(zst))).toString('utf8')
      : new TextDecoder().decode(plain)
  );
}

export async function getSampleRoundTicks(file, stride = 1) {
  const stem = stemOf(file);
  const step = Math.max(1, Math.min(1000, Number(stride) || 1));
  const items = await loadIndex();
  const item = itemForRound(items, stem);
  if (!item) return null;

  if (step === 100) {
    const coarse = packGet(item.pack, stem, '.c100.bin');
    if (coarse) return asArrayBuffer(coarse);
  }

  const tickz = packGet(item.pack, stem, '.tickz');
  const bin = packGet(item.pack, stem, '.bin');
  const raw = tickz || bin;
  if (!raw) return null;
  if (tickz || isTickz(raw)) {
    // Request path (sample library overlay): threadpool decode like demoStore.
    return step === 1 ? decodeTickzAsync(raw) : decodeTickzStrideAsync(raw, step);
  }
  const buf = asArrayBuffer(raw);
  return step === 1 ? buf : sliceStride(buf, step);
}

export async function listSampleRoundNames() {
  const names = [];
  for (const item of await loadIndex()) {
    for (const r of item.record.rounds || []) {
      if (r?.file) names.push(r.file);
    }
  }
  return names;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...CORS
  });
  res.end(payload);
}

/**
 * GET /api/sampledemos… — listing, one demo, its package, round meta, ticks.
 * @returns {Promise<boolean>}
 */
export async function handleSampleDemoRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/sampledemos')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  if (!sampleDemosEnabled()) {
    json(res, 404, { error: 'Sample demos are disabled.' });
    return true;
  }

  if (p === '/api/sampledemos' || p === '/api/sampledemos/') {
    json(res, 200, { demos: await listSampleRecords() });
    return true;
  }

  const pkg = p.match(/^\/api\/sampledemos\/demos\/([A-Za-z0-9_-]+)\/package$/);
  if (pkg) {
    const bytes = await getSamplePackageBytes(pkg[1]);
    if (!bytes) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=60'
    });
    res.end(bytes);
    return true;
  }

  const demo = p.match(/^\/api\/sampledemos\/demos\/([A-Za-z0-9_-]+)$/);
  if (demo) {
    const record = await getSampleRecord(demo[1]);
    if (!record) {
      json(res, 404, { error: 'Replay not found.' });
      return true;
    }
    json(res, 200, {
      demo: {
        ...record,
        owner: { id: SAMPLE_OWNER.id, username: SAMPLE_OWNER.username, visibility: 'public' }
      }
    });
    return true;
  }

  const ticks = p.match(/^\/api\/sampledemos\/rounds\/([A-Za-z0-9_~-]+)\/ticks$/);
  if (ticks) {
    let buf;
    try {
      buf = await getSampleRoundTicks(ticks[1], Number(url.searchParams.get('stride') || 1));
    } catch (err) {
      json(res, 400, { error: err.message || 'Bad round name.' });
      return true;
    }
    if (!buf) {
      json(res, 404, { error: 'Round not found.' });
      return true;
    }
    const body = Buffer.from(buf);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'private, max-age=31536000, immutable',
      ...CORS
    });
    res.end(body);
    return true;
  }

  const round = p.match(/^\/api\/sampledemos\/rounds\/([A-Za-z0-9_~-]+)$/);
  if (round) {
    let meta;
    try {
      meta = await getSampleRoundMeta(round[1]);
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
