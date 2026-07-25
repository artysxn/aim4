# Deployment

AIM4.io is a static Vite client (Three.js) plus a Node backend (HTTP config-share
API + a `/ws` WebSocket for 128-tick multiplayer). The two can run as **one
origin** (LAN/host mode) or be **split** across two hosts (recommended for
production: a static host for the client, a Node host for the backend).

## Environment variables

See [`.env.example`](.env.example) for the authoritative list. Summary:

| Variable | Side | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_API_URL` | Client (build-time) | _empty_ | Backend origin for the REST API **and** multiplayer WS/status. Empty = same origin (dev/LAN). Set it for split deploys. |
| `AIM4_HOST` | Server | `127.0.0.1` | Bind interface. Use `0.0.0.0` when hosted or on LAN. |
| `AIM4_API_PORT` | Server | `3784` | HTTP + WS port. `PORT` is honored as a fallback, which is what most hosts inject. |
| `AIM4_REPLAY_DIR` | Server | `server/data/replays` | Demo library storage. Needs a persistent disk. |
| `AIM4_SERVE_STATIC` | Server | _off_ | `1`/`true` makes Node also serve `dist/`. Host mode only; off for split deploys. |

> Vite only exposes variables prefixed `VITE_` to the client bundle. `VITE_API_URL`
> is read at **build time**, so it must be set in the environment that runs
> `npm run build` (e.g. Vercel project env vars), not at client runtime.

## Running locally

```bash
npm install
npm run dev:mp     # Vite client (:5173) + backend (:3784) together
```

`dev:mp` starts both processes; Vite proxies `/api` and `/ws` to `127.0.0.1:3784`
(see [`vite.config.js`](vite.config.js)), so the client talks to the same origin
and `VITE_API_URL` should stay empty.

Other scripts: `npm run dev` (client only), `npm run server` (backend only),
`npm run host` (build + serve everything on `0.0.0.0` for LAN
or port-forwarded internet play).

## Production: split deploy (static client + Node backend)

Deploy the **backend first** so you know its URL, then point the client build at
it via `VITE_API_URL`.

### 1. Backend

The backend is a plain long-lived Node process. Any host that can run a
container or a Node service works; [`Dockerfile`](Dockerfile) builds it:

```bash
docker build -t aim4-backend .
docker run -p 8080:8080 \
  -e AIM4_HOST=0.0.0.0 \
  -e AIM4_API_PORT=8080 \
  -v aim4-data:/app/server/data \
  aim4-backend
```

Verify:

```bash
curl https://<your-backend>/health         # -> {"ok":true}
curl https://<your-backend>/api/mp/status  # -> {"ok":true,"ws":"/ws",...}
```

What the host has to provide:

- **One instance, always on.** Lobbies and the parse queue are in-process. More
  than one instance needs sticky sessions or shared state; idling the instance
  kills live matches and in-flight parses.
- **WebSocket support on the HTTP port.** `/ws` shares the HTTP port and
  upgrades in place, so no second port or service is needed. The host must
  proxy upgrades rather than terminate them.
- **A persistent disk**, mounted at `server/data` (or point `AIM4_REPLAY_DIR`
  and `server/store.js`'s path elsewhere). Without it, uploaded demos, parsed
  rounds and config share-codes vanish on every redeploy.
- **Enough RAM and CPU to parse.** Demo parsing runs in a worker thread and is
  the heaviest thing the process does. Budget ~2 GB RAM and a real (not
  fractional) core, or parses will be killed mid-run on large demos.
- **Room for the library.** The default quota is 50 demos / 20 GB shared across
  all visitors. Size the disk for that, or lower `AIM4_REPLAY_MAX_BYTES`.

Do **not** set `AIM4_SERVE_STATIC` in a split deploy — the client is served by
the static host.

### 2. Client

[`vercel.json`](vercel.json) pins the Vite build for Vercel; any static host
works if it applies the same rewrites (extension-less site routes to
`index.html`, everything else to `train.html`).

- Framework: Vite · Build: `npm run build` · Output: `dist`
- **Set a build environment variable:** `VITE_API_URL=https://<your-backend>`
  (no trailing slash). Vite inlines it at build time, so **rebuild after
  setting or changing it.**

The client derives everything from that one origin: REST calls hit
`$VITE_API_URL/api/...` and multiplayer connects to `wss://<backend>/ws`
(HTTPS pages automatically upgrade `ws` -> `wss`).

## Known gotchas

- **`VITE_API_URL` is build-time.** Changing the backend URL requires a client
  rebuild/redeploy, not just a server restart.
- **CORS is already open.** `server/index.js` sends `Access-Control-Allow-Origin: *`
  on API responses, so a cross-origin client works out of the box. Lock this
  down to your client origin if you want stricter CORS later.
- **Bind address.** Forgetting `AIM4_HOST=0.0.0.0` makes the app bind to
  loopback and fail health checks. (Locally the default `127.0.0.1` is fine.)
- **Port must match.** The process must listen on whatever port the host routes
  to. Set `AIM4_API_PORT`, or let the injected `PORT` win by leaving it unset.
- **Scaling past one instance** needs sticky sessions or shared lobby state; the
  lobby store is in-process, so a single instance is currently correct.
- **Public-IP lookup.** `server/network.js` calls `api.ipify.org` to print an
  invite banner in host mode. It is best-effort and only meant for self-hosting;
  on a managed host your public URL is the platform domain.
- **Bundle size.** `npm run build` warns the trainer chunk is >500 kB (Three.js).
  Expected; it gzips to ~300 kB. The replay viewer is a separate lazy chunk.
- **Persistence.** Config share-codes (`server/store.js`) and the replay library
  (`server/replays/`) both live under `server/data/`. That path must be a mounted
  volume in production.
- **The replay library is shared and public.** Every visitor uses the same
  on-disk library (default folder `local` under `AIM4_REPLAY_DIR`). No sign-in
  is required. If demos were previously stored under a per-account UUID folder,
  set `AIM4_REPLAY_LIBRARY=<that-folder-name>` so the public library points at
  the existing data.
- **The demo parser is an optional dependency.** `@laihoe/demoparser2` is a native
  module; if the host cannot install it, the site still runs and the Replays page
  reports parsing as offline. See [`server/demoparser/README.md`](server/demoparser/README.md).
