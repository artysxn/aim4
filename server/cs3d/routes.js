// ---------------------------------------------------------------------------
// server/cs3d/routes.js
// GET /api/cs3d/<slug>/<file>  → server/data/cs3d/pack/<slug>/<file>
//
// Serves the 3D map packs (scripts/cs3d-pack.mjs). Read-only, public, CORS
// open (the site is on another origin), and cached hard: every file in a pack
// except manifest.json is content-addressed or rewritten wholesale by a
// re-pack, and manifest.json is what the client revalidates.
//
// The pack directory is per host, like replays: it is not in git and not in
// the image. Point CS3D_PACK_DIR elsewhere to serve from another disk.
//
// A file that is not on this disk is fetched from the public pack bucket and
// kept beside the rest, so a host with only Nuke (or a half-fetched Cache)
// still has viewmodels, sky HDR, and the other maps. Map-pack bytes always
// win: a filled interactives.json is never replaced by the older copy on the
// bucket. Shared packs (weapons, players, fx, bullets) are the exception: if
// the bucket index is a higher version than the copy on this disk, the index
// is replaced and the rest of the pack is re-filled on demand. Otherwise a
// leftover v3 weapons/ hides v4 forever, which is what localhost was doing.
// Set CS3D_FETCH_BASE=off to disable.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACK_DIR = path.resolve(process.env.CS3D_PACK_DIR || path.join(__dirname, '..', 'data', 'cs3d', 'pack'));

/** Same public bucket scripts/cs3d-fetch.mjs and the production client use. */
const DEFAULT_FALLBACK = 'https://pub-2cbbca6c60604cc7a9fde25f012821d9.r2.dev';

export function packFallbackBase() {
  const v = process.env.CS3D_FETCH_BASE;
  if (v === '0' || v === 'off' || v === 'false') return '';
  return String(v || DEFAULT_FALLBACK).replace(/\/$/, '');
}

const filling = new Map();
/** Shared-pack slugs whose bucket index has been compared this process. */
const sharedIndexChecked = new Set();

/** Flat packs filled from the public bucket, not per-map bake output. */
export const SHARED_CS3D_PACKS = new Set(['weapons', 'players', 'fx', 'bullets']);

export function sharedPackIndexRel(slug) {
  return slug === 'fx' ? 'fx.json' : 'manifest.json';
}

/** True when the bucket copy should replace the one on this disk. */
export function remotePackNewer(local, remote) {
  const rv = Number(remote?.version);
  if (!Number.isFinite(rv)) return false;
  const lv = Number(local?.version);
  if (!Number.isFinite(lv)) return true;
  return rv > lv;
}

export function resetCs3dFallbackState() {
  filling.clear();
  sharedIndexChecked.clear();
}

/**
 * If this shared pack's on-disk index is older than the bucket's, take the
 * bucket copy and drop the rest of the directory so same-named glbs cannot
 * keep serving the previous version.
 */
async function refreshSharedIndex(slug) {
  if (!SHARED_CS3D_PACKS.has(slug) || sharedIndexChecked.has(slug)) return;
  const base = packFallbackBase();
  if (!base) {
    sharedIndexChecked.add(slug);
    return;
  }
  const rel = sharedPackIndexRel(slug);
  const file = path.join(PACK_DIR, slug, rel);
  const key = `__index/${slug}`;
  if (filling.has(key)) {
    await filling.get(key);
    return;
  }
  const job = (async () => {
    const res = await fetch(`${base}/${slug}/${rel}`, { headers: { 'user-agent': 'aim4-cs3d-host' } });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    let remote;
    try {
      remote = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    let local = null;
    try {
      local = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      local = null;
    }
    if (!remotePackNewer(local, remote)) return;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    const dir = path.dirname(file);
    const names = await fs.promises.readdir(dir);
    await Promise.all(
      names
        .filter((n) => n !== rel)
        .map((n) => fs.promises.rm(path.join(dir, n), { recursive: true, force: true }))
    );
  })();
  filling.set(key, job);
  try {
    await job;
  } catch {
    /* keep local */
  } finally {
    filling.delete(key);
    sharedIndexChecked.add(slug);
  }
}

async function fillFromFallback(file, slug, rel) {
  const base = packFallbackBase();
  if (!base) return false;
  const key = `${slug}/${rel}`;
  if (filling.has(key)) return filling.get(key);
  const job = (async () => {
    const res = await fetch(`${base}/${key}`, { headers: { 'user-agent': 'aim4-cs3d-host' } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return true;
  })();
  filling.set(key, job);
  try {
    return await job;
  } catch {
    return false;
  } finally {
    filling.delete(key);
  }
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream'
};

const SLUG_RE = /^[a-z0-9_-]+$/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

/** Returns true when handled. */
export async function handleCs3dRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/cs3d/')) return false;
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return true;
  }
  const rest = url.pathname.slice('/api/cs3d/'.length);
  const [slug, ...parts] = rest.split('/');
  if (!SLUG_RE.test(slug || '') || !parts.length) {
    res.writeHead(404);
    res.end();
    return true;
  }
  const rel = parts.map(decodeURIComponent).join('/');
  const file = path.normalize(path.join(PACK_DIR, slug, rel));
  if (!file.startsWith(PACK_DIR + path.sep) || rel.includes('..')) {
    res.writeHead(403);
    res.end();
    return true;
  }
  await refreshSharedIndex(slug);
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    if (await fillFromFallback(file, slug, rel)) {
      try {
        stat = await fs.promises.stat(file);
      } catch {
        stat = null;
      }
    } else {
      stat = null;
    }
  }
  if (!stat) {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  const isManifest = path.basename(file) === 'manifest.json';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': isManifest ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
    'Last-Modified': stat.mtime.toUTCString()
  };
  // Range: not needed by the loader today, cheap to honour for tools that ask.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return true;
    }
    headers['Content-Length'] = end - start + 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}
