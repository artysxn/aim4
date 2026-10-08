# AIM4 website content rules

Rules for any text written on the aim4.io site (landing page, tools pages, in-game UI copy).

1. **Never use em dashes (—) in design-type text.** Headings, subtitles, tooltips, hint
   text, button labels — none of it. Use a period, comma, colon, or plain hyphen instead.
2. **Never add descriptive/marketing filler under a heading or on a card.** No tagline
   sentences explaining what a section "is" or "does" (e.g. "Browser-based FPS training",
   "Everything on the site, one click away", "Built with Three.js"). A title, a label, or a
   button stands on its own — it does not need a caption underneath it.

These apply to new copy going forward. Functional instructional text (level editor
tooltips, keybind hints, football's in-match prompts) is not "filler" and can stay — it
just should not use em dashes either.

Control / filter UI (fields, switches, buttons, rounding, anti-label habits): see
`.cursor/rules/aim4-ui-controls.mdc`.

# Build and run

Local deployment. `npm run build && npm start` is the whole thing; see `LOCAL.md`.

- **The build is `build/build.mjs` (esbuild only).** Not Vite. It reproduces what the
  source relies on, and each piece is commented where it is handled: `?url` / `?raw`
  asset imports, `import.meta.glob()` (one call site, `src/sky/skyboxCatalog.js`),
  `import.meta.env`, module workers (pre-built, then the `new URL(...)` call site is
  rewritten), and the two Three.js instances, which are esbuild namespaces rather than
  Vite's dual resolve.
- **Code splitting is deliberately off.** Every page is one JS file and one CSS file.
  esbuild emits a dynamic chunk's CSS but nothing loads it, and the app has no runtime
  CSS loader, so splitting would let a lazy view arrive with no styles.
- **`server/static.js` is the only routing table.** `vercel.json` and `vite.config.js`
  are gone; `server/staticRoutes.test.js` now checks the table against the pages the
  build actually emits. Do not reintroduce a second copy of that decision.
- **`VITE_`-prefixed env vars are inlined at build time** by `build/build.mjs`. Anything
  server-side must not use that prefix.

# Hosted services

`server/local/mode.js` is ON by default: one account, no sign-in, every entitlement,
profile in a JSON file. The client stand-in for Supabase is `src/lib/localClient.js`.

Genuinely unavailable offline, failing closed rather than pretending: Paddle billing,
Steam OpenID, HLTV/FACEIT ingestion, impersonation. Remote asset fill is off by default
(`CS3D_FETCH_BASE`) — a missing pack file is a 404 naming the path, never a silent fetch.

Both halves are one flag away from the hosted path: `AIM4_LOCAL=0` (server),
`VITE_LOCAL_MODE=0` (client).

# Gotchas

- **`npm test` does not run on Windows.** The script is a single `&&` chain of ~250 node
  invocations and blows the 8191-character command-line limit. Run the affected
  `*.test.js` files directly.
- **`/api/replays/models/{duel,round}` 404s by design** until you train a champion;
  the client falls back to the bundled params. The same for `503
  /api/replays/aggregate` while the hot store builds. Both are allowlisted with reasons
  in `build/smoke.mjs`.
- **The map colour grade has never loaded** — `loadPostLut` in `src/cs3d/look.js` reads
  `pack.v` before `mapLoader.load()` assigns it, so it requests `lut.binundefined`.
  One-line fix in `fetchManifest`, not taken because it changes map colour output.
- **`AIM4_REPLAY_DIR` wants a case-sensitive volume.** Round ids differ only by case and
  overwrite each other on NTFS/APFS. The server warns at boot.