import { defineConfig } from 'vite';

// Minimal Vite config. Three.js is bundled from node_modules so the bare
// "three" specifier resolves cleanly in dev (HMR) and production builds.
export default defineConfig({
  base: '/',
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
      }
    }
  },
  build: {
    target: 'es2020',
    sourcemap: false
  },
  appType: 'spa'
});
