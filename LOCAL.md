# Running AIM4 locally

One machine, one process, one port. This is the whole deployment.

```bash
npm install
npm run build
npm start
```

Open <http://localhost:3784>. No `.env` is required: the server boots signed in
as a single owner with every entitlement, and the client is served from the same
origin it calls, so `/api` and `/ws` need no proxy and no CORS.

`npm start` binds `0.0.0.0`, so another machine on the LAN can open
`http://<your-lan-ip>:3784`. Open the port in the firewall if you want it
reachable.

## The scripts

| Command | What it does |
| --- | --- |
| `npm run build` | esbuild the client into `dist/` |
| `npm start` | serve `dist/` + API + WebSocket on `0.0.0.0:3784` |
| `npm run dev` | build without minifying, then serve. Use while editing |
| `npm run server` | API + WebSocket only, on `127.0.0.1` |
| `npm run smoke` | drive every page in Chrome and report what broke |
| `npm test` | the full suite |
| `npm run cs3d:fetch -- <slug>` | pull one asset pack from the published bucket |

There is no watch mode and no dev server. `npm run dev` rebuilds once and then
runs the same server you would run in production, so what you test is what you
ship.

## One account, no sign-in

`server/local/mode.js` answers the questions the hosted deployment spends its
effort asking:

| Question | Local answer |
| --- | --- |
| who is calling | always the owner, whatever token arrived or did not |
| what may they do | everything, on the top plan |
| which database | `server/data/local/profile.json` |

The client learns about this in one place, `src/lib/localClient.js`, which
stands in for the Supabase client instead of pretending to be unreachable. That
is why there is nothing to sign in to.

Set `AIM4_LOCAL=0` to turn the server side off, and `VITE_LOCAL_MODE=0` to turn
the client side off. Both are there so the hosted path is one flag away and
nothing in `server/local/` is load-bearing for it.

## What is off, and why

These are hosted services, so they cannot run on a machine with no public
address. They fail closed and say so rather than pretending:

| Feature | State |
| --- | --- |
| Billing and subscriptions | Paddle is a hosted checkout. The subscription page shows local plan state. |
| Steam sign-in and profile linking | Steam OpenID needs a public callback URL. |
| HLTV / FACEIT demo ingestion | Both fetch over the internet. The ingest jobs do not start. |
| Impersonation ("view as") | Single user, so there is nobody to become. |
| Remote asset fill | Off by default; see below. |

## Asset packs

3D map packs, weapon models and the `fx` / `players` / `bullets` packs are read
from disk:

```
server/data/cs3d/pack/<slug>/...
```

served by the same process at `/api/cs3d/<slug>/...`. A file that is not there
is a 404 that names the path it tried. Nothing is silently fetched to cover a
hole, which is the change from the hosted version: `packFetch` used to rewrite
every miss onto the public bucket.

To populate a fresh install from the published bucket, once, on purpose:

```bash
npm run cs3d:fetch -- weapons
npm run cs3d:fetch -- dust2
```

Set `CS3D_FETCH_BASE` to a base URL if you want the server-side fill back.

## Where state lives

| What | Where |
| --- | --- |
| Uploaded demos, parsed rounds, zones, notes | `server/data/replays` (`AIM4_REPLAY_DIR`) |
| Map and weapon asset packs | `server/data/cs3d/pack` (`CS3D_PACK_DIR`) |
| The owner's profile | `server/data/local/profile.json` (`AIM4_LOCAL_DIR`) |
| The built client | `dist/` |

`AIM4_REPLAY_DIR` wants a **case-sensitive** volume. Round ids differ only by
case (`HBq` vs `hbQ`), so on NTFS or APFS they silently overwrite each other. On
Windows the closest thing is a WSL2 volume or a VHD mounted through WSL. The
server warns at boot when it detects a case-insensitive filesystem.

## Verifying a change

```bash
npm run build
npm start
npm run smoke
```

`smoke` drives Chrome over 25 pages (including the path-routed deep links) and
fails on console errors and failed requests. Three responses are expected and
listed with their reasons in `build/smoke.mjs`:

- `404 /api/replays/models/{duel,round}` — no champion weights trained on this
  machine, so the server says "no trained model" and the client falls back to
  the bundled params.
- `503 /api/replays/aggregate` — the hot statistics store builds in the
  background after a cold start and answers 503 until it lands.
- `404 /api/cs3d/<map>/post/lut.binundefined` — a pre-existing bug, not a local
  one. `loadPostLut` reads `pack.v` before `mapLoader.load()` assigns it, so the
  URL literally ends in "undefined". The map grade has never loaded, here or on
  the hosted site.

## If you put it back online

`AIM4_LOCAL=0` plus real Supabase credentials, and `VITE_API_URL` pointing at
the backend if the client ends up on a different host. `VITE_API_URL` is
build-time, so changing it needs a rebuild. The Vercel config and the Vite build
have been removed; nothing in the codebase depends on either.