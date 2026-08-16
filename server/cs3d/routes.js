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
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PACK_DIR = path.resolve(process.env.CS3D_PACK_DIR || path.join(__dirname, '..', 'data', 'cs3d', 'pack'));

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
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
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
