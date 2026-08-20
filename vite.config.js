import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { cs3dMapForPath } from './shared/cs3d/maps.js';
import { handleSampleDemoRequest } from './server/replays/sampleDemos.js';
import { SHARED_CS3D_PACKS } from './server/cs3d/routes.js';

// Paths the game-route fallback must never touch: backend proxies, the site
// shell's own views (/tools, /training, /leaderboards, /football), tool pages
// and Vite internals/assets.
const GAME_FALLBACK_SKIP = /^\/(api|ws|football|training|leaderboards|replays|tools|assets|fonts|maps|map-practice|src|public|node_modules|@|demos|playlists|database|charts|patterns|performance|uploads|routines|achievements|replay-viewer|team|account|admin|i|s2|icons)(\/|$)/;

// Dev-server twin of the vercel.json rewrites: the landing owns "/" and
// "/tools", the 3D map explorer owns /<map> (e.g. /dust2, /de_nuke), every
// other extension-less path (e.g. /train, /gridshot, /gridshot/competitive)
// is the game SPA served from train.html.
function gameRouteFallback() {
  const rewrite = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // /@vite/client, /@fs/, /@id/ are Vite's own; the skip regex's bare "@"
      // alternative never matched them (it wants "/" or end right after).
      if (
        pathname !== '/' &&
        !pathname.includes('.') &&
        !pathname.startsWith('/@') &&
        !GAME_FALLBACK_SKIP.test(pathname)
      ) {
        req.url = cs3dMapForPath(pathname) ? '/cs3d.html' : '/train.html';
      }
    }
    next();
  };
  return {
    name: 'aim4-game-route-fallback',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    }
  };
}

// Dev-only twin of server/cs3d/routes.js: serve the local map packs at
// /api/cs3d/ straight from disk so `npm run dev` needs no backend for /dust2.
// Registered before Vite's proxy, so it wins for this prefix; everything else
// under /api still goes to the backend.
function cs3dPackDev() {
  const packDir = path.resolve(process.env.CS3D_PACK_DIR || 'server/data/cs3d/pack');
  const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.ktx2': 'image/ktx2', '.hdr': 'image/vnd.radiance' };
  const serve = (req, res, next) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/api/cs3d/')) return next();
    const rel = pathname.slice('/api/cs3d/'.length);
    // Shared packs go through the host even when they exist on disk. Vite
    // serving a leftover weapons/manifest.json used to hide the host's R2
    // version refresh, so localhost never saw the bucket's newer pack.
    if (SHARED_CS3D_PACKS.has(rel.split('/')[0])) return next();
    const file = path.normalize(path.join(packDir, rel));
    if (!file.startsWith(packDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Miss: let the /api proxy (or the next middleware) try. Returning 404
      // here used to hide the host's R2 fill, so localhost had the map and
      // no weapons / interactives.
      return next();
    }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    // The texture bundle streams; the loader reads its progress off this.
    res.setHeader('Content-Length', fs.statSync(file).size);
    // Dev re-packs in place; never let the browser keep yesterday's geometry.
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'aim4-cs3d-pack-dev',
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    }
  };
}

function sampleDemosDev() {
  const serve = async (req, res, next) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith('/api/sampledemos')) return next();
    try {
      const url = new URL(req.url, 'http://localhost');
      if (await handleSampleDemoRequest(req, res, url)) return;
    } catch (err) {
      return next(err);
    }
    next();
  };
  return {
    name: 'aim4-sample-demos-dev',
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    }
  };
}

// Minimal Vite config. Three.js is bundled from node_modules so the bare
// "three" specifier resolves cleanly in dev (HMR) and production builds.
export default defineConfig({
  base: '/',
  plugins: [gameRouteFallback(), cs3dPackDev(), sampleDemosDev()],
  server: {
    host: true,
    open: false,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3784',
        changeOrigin: true
      },
      // Multiplayer WebSocket — proxied to the same backend (128-tick server).
      '/ws': {
        target: 'ws://127.0.0.1:3784',
        ws: true,
        changeOrigin: true
      },
      // Football WebSocket. Plain page loads of /football are the site shell's
      // football menu, so only WS upgrades go to the backend.
      '/football': {
        target: 'ws://127.0.0.1:3784',
        ws: true,
        changeOrigin: true,
        bypass(req) {
          if (!req.headers.upgrade) return '/index.html';
        }
      }
    }
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      input: {
        // Landing page / site shell at the root.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // The trainer SPA — served for /train and gamemode deep links.
        train: fileURLToPath(new URL('./train.html', import.meta.url)),
        // Easter-egg football — built as its own page so it reads VITE_API_URL
        // (the hosted backend) exactly like the main client's NetClient.
        football: fileURLToPath(new URL('./tools/football.html', import.meta.url)),
        zoneEditor: fileURLToPath(new URL('./tools/zone-editor.html', import.meta.url)),
        // The 3D map explorer — served for /dust2, /mirage, ... (shared/cs3d/maps.js).
        cs3d: fileURLToPath(new URL('./cs3d.html', import.meta.url))
      }
    }
  },
  appType: 'spa'
});
