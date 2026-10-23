// Boots the server the aim4 desktop app carries for everyone (scripts/build-pack.mjs).
//
// No database key and no .env file: accounts, plans and the demo library come
// from the online aim4 (AIM4_UPSTREAM), and while it cannot be reached this
// PC's own library and the last login stand in (server/offline.js). The pages
// come from the online aim4 too, so the window shows the current site, and this
// pack's own build of the client is the one it shows offline.
//
// It listens on this PC only: it is the back end of one person's window.
process.env.AIM4_LOCAL = '0';
process.env.VITE_LOCAL_MODE = '0';
process.env.AIM4_UPSTREAM ||= 'https://aim4.io';
process.env.AIM4_UPSTREAM_SITE ||= '1';
process.env.AIM4_SERVE_STATIC = '1';
process.env.AIM4_HOST ||= '127.0.0.1';
process.env.AIM4_DIST_DIR ||= 'dist-account';
// The desktop app's own server: Similar Rounds scans run here (server/similar).
process.env.AIM4_DESKTOP ||= '1';
await import('./index.js');
