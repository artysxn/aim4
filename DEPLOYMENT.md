# Deployment

AIM4.io is a static Vite client (Three.js) plus a Node backend (HTTP config-share
API + a `/ws` WebSocket for 128-tick multiplayer). The two can run as **one
origin** (LAN/host mode) or be **split** across two hosts (recommended for
production: Vercel for the client, Fly.io for the backend).

## Environment variables

See [`.env.example`](.env.example) for the authoritative list. Summary:

| Variable | Side | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_API_URL` | Client (build-time) | _empty_ | Backend origin for the REST API **and** multiplayer WS/status. Empty = same origin (dev/LAN). Set it for split deploys. |
| `AIM4_HOST` | Server | `127.0.0.1` | Bind interface. Use `0.0.0.0` on Fly.io / LAN. |
| `AIM4_API_PORT` | Server | `3784` | HTTP + WS port. `PORT` is honored as a fallback (PaaS convention). |
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
`npm run host` / `start-host.bat` (build + serve everything on `0.0.0.0` for LAN
or port-forwarded internet play).

## Production: Vercel (client) + Fly.io (backend)

Deploy the **backend first** so you know its URL, then point the Vercel client at
it via `VITE_API_URL`.

### 1. Backend on Fly.io

A ready-to-use [`fly.toml`](fly.toml) is committed at the repo root. It deploys
`server/index.js` as a persistent Node process via Fly's **Node buildpack** — no
Dockerfile required. Key settings already baked in:

- `[processes] app = "node server/index.js"` — the run command.
- `AIM4_HOST = "0.0.0.0"` and `AIM4_API_PORT = "8080"` (matches `internal_port`).
- `auto_stop_machines = "off"` + `min_machines_running = 1` — keep one machine up
  so live WebSocket matches aren't dropped and players don't hit cold starts.
- `[http_service.concurrency] type = "connections"` — correct unit for long-lived
  WS sockets.
- A `GET /health` check (the server returns `{ "ok": true }`).

```bash
# One-time: install flyctl and log in
fly auth login

# Create the app from the existing fly.toml (don't deploy yet).
# Edit the `app` name in fly.toml first if "aim4-backend" is taken.
fly launch --no-deploy --copy-config

# Deploy
fly deploy

# Verify
curl https://<your-fly-app>.fly.dev/health        # -> {"ok":true}
curl https://<your-fly-app>.fly.dev/api/mp/status  # -> {"ok":true,"ws":"/ws",...}
```

Do **not** set `AIM4_SERVE_STATIC` on Fly — the client is served by Vercel. The
WebSocket shares the HTTP port at path `/ws`; Fly's `http_service` upgrades
`wss://` automatically, so no extra service or port is needed.

To override an env var without editing `fly.toml`: `fly secrets set NAME=value`
(secrets/env both land in `process.env`; `fly.toml [env]` is fine for non-secret
config like these).

### 2. Client on Vercel

Import the repo in Vercel. [`vercel.json`](vercel.json) pins the Vite build:

- Framework: Vite · Build: `npm run build` · Output: `dist`
- **Add a Project Environment Variable:** `VITE_API_URL=https://<your-fly-app>.fly.dev`
  (Production scope; no trailing slash). Because Vite inlines this at build time,
  **redeploy the Vercel project after setting/changing it.**

The client derives everything from that one origin: REST calls hit
`$VITE_API_URL/api/...` and multiplayer connects to `wss://<fly-host>/ws`
(HTTPS pages automatically upgrade `ws` → `wss`).

## Known gotchas

- **`VITE_API_URL` is build-time.** Changing the backend URL requires a client
  rebuild/redeploy, not just a server restart.
- **CORS is already open.** `server/index.js` sends `Access-Control-Allow-Origin: *`
  on API responses, so a cross-origin Vercel client works out of the box. Lock
  this down to the Vercel origin if you want stricter CORS later.
- **Bind address.** Forgetting `AIM4_HOST=0.0.0.0` on Fly.io makes the app bind
  to loopback and fail health checks. (Locally the default `127.0.0.1` is fine.)
- **Port must match.** The process must listen on `internal_port` (8080). The
  committed `fly.toml` sets `AIM4_API_PORT=8080` to guarantee this — if you change
  one, change both.
- **Auto-stop drops WebSockets.** Fly's default `auto_stop_machines` will idle the
  machine, killing active matches and adding cold-start lag on reconnect. The
  committed config disables it and keeps `min_machines_running = 1`. Scaling to
  more than one machine needs sticky sessions or shared lobby state — the lobby
  store is currently in-process (single machine is correct for now).
- **WebSocket on Fly needs no special config**, but it *does* require an
  `http_service` (not a raw `tcp_service`) so the `wss://` upgrade is proxied —
  that's what `fly.toml` uses.
- **Public-IP lookup.** `server/network.js` calls `api.ipify.org` to print an
  invite banner in host mode. It's best-effort and harmless on Fly.io, but the
  printed "invite link" logic is meant for self-hosting; on a PaaS your public
  URL is the platform domain.
- **Bundle size.** `npm run build` warns the JS chunk is >500 kB (Three.js). This
  is expected and gzips to ~150 kB; no action needed for Phase 0.
- **Persistence.** Config share-codes are stored under `server/data/` (see
  [`server/store.js`](server/store.js)). On Fly.io that path is ephemeral unless
  you attach a volume — fine for Phase 0, revisit if codes must survive restarts.
