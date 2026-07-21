// ---------------------------------------------------------------------------
// server/static.js
// Minimal static file server for the Vite `dist/` build. Used when hosting so
// friends can open http://<your-ip>:<port> in a browser — same origin as /ws.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DIST_DIR = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

export function distExists() {
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}

// Extension-less page aliases — mirrors the vercel.json rewrites.
const PAGE_ALIASES = {
  '/train': '/train.html',
  '/tools/editvalues': '/tools/editvalues.html',
  '/tools/level-editor': '/tools/level-editor.html'
};

// Paths owned by the site shell (index.html): its menu views live here.
const SITE_VIEW_PATHS = new Set(['/tools', '/training', '/leaderboards', '/football']);

/**
 * Try to serve a file from dist/. Returns true if handled.
 * SPA fallback: "/" and the site view paths → index.html (site shell), every
 * other unknown path (gamemode deep links, /train) → train.html (the trainer).
 */
export function tryServeStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (PAGE_ALIASES[rel]) rel = PAGE_ALIASES[rel];

  const filePath = path.normalize(path.join(DIST_DIR, rel));
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    const fallback = rel === '/index.html' || SITE_VIEW_PATHS.has(rel) ? 'index.html' : 'train.html';
    target = path.join(DIST_DIR, fallback);
    if (!fs.existsSync(target)) target = path.join(DIST_DIR, 'index.html');
    if (!fs.existsSync(target)) return false;
  }

  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(target);

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(target).pipe(res);
  return true;
}
