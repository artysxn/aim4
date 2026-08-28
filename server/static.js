// ---------------------------------------------------------------------------
// server/static.js
// Minimal static file server for the Vite `dist/` build. Used when hosting so
// friends can open http://<your-ip>:<port> in a browser — same origin as /ws.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cs3dMapForPath } from '../shared/cs3d/maps.js';

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
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  // Ported maps (public/maps/<slug>/<slug>.glb, scripts/gen-trainer-map.mjs).
  '.glb': 'model/gltf-binary'
};

export function distExists() {
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}

// Extension-less page aliases — mirrors the vercel.json rewrites.
const PAGE_ALIASES = {
  '/train': '/train.html',
  '/tools/editvalues': '/tools/editvalues.html',
  '/tools/level-editor': '/tools/level-editor.html',
  '/tools/zone-editor': '/tools/zone-editor.html'
};

// Paths owned by the site shell (index.html): its menu views live here.
//
// This list governs the self-hosted server only. Production is served by
// Vercel, which routes from vercel.json — a path added here and not there
// 404s (or falls through to the trainer) on aim4.io while working perfectly
// on localhost. staticRoutes.test.js fails when the two drift apart.
export const SITE_VIEW_PATHS = new Set([
  '/tools',
  // Admin-only deck; the view refuses everyone else. Without this entry the
  // deep link serves the trainer shell instead of the SPA.
  '/tools/pitchdeck',
  '/tools/pitchtalk',
  // The public, shareable copies of both decks. Open to anyone with the link.
  '/public-pitch',
  '/public-talk',
  '/training',
  '/leaderboards',
  '/football',
  '/routines',
  '/achievements',
  '/map-practice',
  '/replay-viewer',
  '/demos',
  '/playlists',
  '/database',
  '/charts',
  '/patterns',
  '/performance',
  '/changelog',
  '/docs',
  '/contact',
  // A player page is shared as /player/<id>; without these two entries the
  // link works only as an in-app navigation and a cold load falls through to
  // the trainer.
  '/player',
  '/uploads',
  '/team',
  '/account',
  '/admin',
  // Deep link only. The API answers 404 to everyone but one account, and the
  // view renders nothing until it says otherwise. This entry exists so the
  // path reaches the SPA shell instead of falling through to the trainer.
  '/sim',
  // Legacy bookmarks still land on the SPA shell (client redirects).
  '/replays',
  '/replays/playlists',
  '/replays/upload',
  '/replays/stats',
  '/replays/analytics',
  '/replays/charts'
]);

// Shell-owned subtrees: /team/*, /account/* (sub-pages), /i/* (invites),
// /s2/* (shared 2D rounds), /d/* (shared documents).
export const SITE_VIEW_PREFIXES = ['/team/', '/account/', '/i/', '/s2/', '/d/', '/player/'];

function isSiteViewPath(rel) {
  return SITE_VIEW_PATHS.has(rel) || SITE_VIEW_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Try to serve a file from dist/. Returns true if handled.
 * SPA fallback: "/" and the site view paths → index.html (site shell), the
 * 3D map routes (/dust2, /de_nuke, ...) → cs3d.html, every other unknown
 * path (gamemode deep links, /train) → train.html (the trainer).
 */
export function tryServeStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (PAGE_ALIASES[rel]) rel = PAGE_ALIASES[rel];
  else if (!rel.includes('.') && cs3dMapForPath(rel)) rel = '/cs3d.html';

  const filePath = path.normalize(path.join(DIST_DIR, rel));
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    const fallback = rel === '/index.html' || isSiteViewPath(rel) ? 'index.html' : 'train.html';
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
