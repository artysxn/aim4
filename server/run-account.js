// Boots the host with real accounts (server/accountEnv.js): local mode off,
// sign-in through the site's Supabase project, serving the dist-account/ build.
// The aim4 desktop app starts this when an aim4-local.json sits next to it.
//
// Unlike run-host.js it listens on this PC only (127.0.0.1): it is the back end
// of one person's desktop window, not a server for the LAN.
import { loadAccountEnv } from './accountEnv.js';

loadAccountEnv();
process.env.AIM4_SERVE_STATIC = '1';
process.env.AIM4_HOST ||= '127.0.0.1';
// The desktop app's own server: Similar Rounds scans run here (server/similar).
process.env.AIM4_DESKTOP ||= '1';
await import('./index.js');
