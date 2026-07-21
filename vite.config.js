import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Paths the game-route fallback must never touch: backend proxies, tool pages,
// the site landing ("/" and "/tools") and Vite internals/assets.
const GAME_FALLBACK_SKIP = /^\/(api|ws|football|tools|assets|fonts|src|public|node_modules|@)(\/|$)/;

// Dev-server twin of the vercel.json rewrites: the landing owns "/" and
// "/tools", every other extension-less path (e.g. /train, /gridshot,
// /gridshot/competitive) is the game SPA served from train.html.
function gameRouteFallback() {
  const rewrite = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (
        pathname !== '/' &&
        !pathname.includes('.') &&
        !GAME_FALLBACK_SKIP.test(pathname)
      ) {
        req.url = '/train.html';
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

// Minimal Vite config. Three.js is bundled from node_modules so the bare
// "three" specifier resolves cleanly in dev (HMR) and production builds.
export default defineConfig({
  base: '/',
  plugins: [gameRouteFallback()],
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
      // Easter-egg 2D football (public/tools/football.html).
      '/football': {
        target: 'ws://127.0.0.1:3784',
        ws: true,
        changeOrigin: true
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
        football: fileURLToPath(new URL('./tools/football.html', import.meta.url))
      }
    }
  },
  appType: 'spa'
});
