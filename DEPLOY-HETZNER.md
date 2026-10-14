# Deploying AIM4 to Hetzner

The whole site runs as **one container** on the Hetzner box (Coolify): the built
client, the API and the WebSockets on one origin. Vercel is gone, so aim4.io
itself now points at Hetzner, not just api.aim4.io.

```
aim4.io / www.aim4.io / api.aim4.io  ──►  Coolify proxy (Traefik)  ──►  node server/index.js
                                                                         ├─ dist/      (the client)
                                                                         ├─ /api/*     (API)
                                                                         └─ /ws, /football (WebSockets)
```

Local `npm start` is unchanged and still single-owner. The hosted switches are
already in the repo, so the host only has to provide secrets and domains.

## What the repo already does

| File | Hosted behaviour |
| --- | --- |
| `nixpacks.toml` | **The build Coolify uses.** Sets `AIM4_LOCAL=0`, `VITE_LOCAL_MODE=0`, `AIM4_SERVE_STATIC=1`, `AIM4_HOST=0.0.0.0`, runs `npm run build`, starts with a 3 GB heap. |
| `Dockerfile` | A working alternative if the build pack is switched to Dockerfile. Same runtime, multi-stage. |
| `server/local/mode.js` | Under `NODE_ENV=production`, local mode is OFF unless `AIM4_LOCAL=1` is set explicitly. A missing variable can no longer make every visitor the owner. |
| `build/build.mjs` | A hosted build (`VITE_LOCAL_MODE=0`) fails without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. |
| `server/index.js` | A hosted production boot exits without `SUPABASE_URL` + `SUPABASE_ANON_KEY`, so Coolify keeps the old container instead of going live with sign-in broken. |
| `server/replays/sampleDemos.js` | The `sampledemos/` overlay stays local-only, so the hosted library does not list those matches twice. |

## Coolify: the existing API app

Reuse the app that serves api.aim4.io today. It already has the volume and most
of the secrets.

**Build pack:** leave it on Nixpacks.

**Volume:** unchanged, mounted at `/app/server/data` (replays, cs3d packs, stats
snapshot, GeoIP db). Do not let it go: the library is the only state that
cannot be rebuilt.

**Domains:** add `https://aim4.io` and `https://www.aim4.io` next to
`https://api.aim4.io`. Keep api.aim4.io: FACEIT webhooks, Steam return URLs, the
desktop recorder's update feed and any old tab still call it.

**Gzip:** make sure compression is on for the app (Advanced → "Enable Gzip
Compression"). The node static server sends files uncompressed, and the site
bundle is ~8.7 MB of JS before compression. Vercel used to do this for free.

### Environment variables

Build variables are inlined into the client bundle. In Coolify, tick
**"Build Variable"** on them or the build stops with an error.

| Variable | Build? | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | **yes** | `https://<project>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | **yes** | the publishable/anon key |
| `VITE_API_URL` | yes | **empty / unset.** The client calls the origin it was loaded from. If it is still `https://api.aim4.io` from the Vercel days, delete it. |
| `SUPABASE_URL` | | same as above |
| `SUPABASE_ANON_KEY` | | same as above |
| `SUPABASE_SERVICE_ROLE_KEY` | | server only, never `VITE_` |
| `AIM4_SITE_URL` | | `https://aim4.io` (where Steam sends the browser back) |
| `AIM4_PUBLIC_URL` | | `https://aim4.io` |
| `AIM4_TRUST_PROXY` | | `1` (it is behind Traefik) |
| `PORT` | | whatever the app's port is set to in Coolify (the old image used 8080) |

Everything else (Paddle, FACEIT, Steam API key, GeoIP, `AIM4_ADMIN_USER_IDS`,
parse limits) is the same as before. See `.env.example`.

Do **not** set `AIM4_LOCAL=1` on this box. It means no sign-in and admin for
everyone.

## Outside Coolify

1. **Supabase → Auth → URL configuration.** Site URL `https://aim4.io`, and the
   redirect list has `https://aim4.io` and `https://www.aim4.io`. Add
   `https://api.aim4.io` while testing on it (step 1 of the cutover), then
   remove it.
2. **Traefik read timeout.** The proxy kills any request whose body takes over
   60 s (measured 2026-08-28, a 499). Every demo upload now goes through it, from
   the main site too. In Coolify → Servers → Proxy, raise
   `entrypoints.https.transport.respondingTimeouts.readTimeout` (for example
   `1800s`, matching the server's own 30 min `requestTimeout`) and restart the
   proxy.
3. **DNS.** Point the `aim4.io` and `www` A records at the Hetzner box
   (91.99.170.235) instead of Vercel. Coolify issues the certificates once the
   records resolve.
4. **Privacy page.** `src/site/legalView.js` still says the website is delivered
   by Vercel. That is your copy to change.

## Cutover order

1. Push and deploy. api.aim4.io now serves the full site as well as the API.
   Open `https://api.aim4.io/` and sign in there. That tests everything before
   any DNS changes.
2. Check:
   ```bash
   curl -s https://api.aim4.io/health
   ```
   ```bash
   curl -s https://api.aim4.io/api/replays/diag | grep -o '"heapLimitMb":[0-9]*'
   ```
   The second should say 3072 or more.
3. Switch DNS for aim4.io and www. Leave the Vercel project in place, without
   deleting it, until aim4.io has worked for a day: pointing DNS back is the
   rollback.
4. Upload a demo larger than ~100 MB from aim4.io. If it dies at about a
   minute, the Traefik timeout is not raised yet.

## Known, not changed

- **cs3d packs** come from the volume. A missing file is fetched from the r2.dev
  bucket in hosted mode, and that bucket is rate limited (see
  `CS3D-RENDERER.md`). A custom domain in front of the bucket is still the real
  fix.
- **Asset 404s serve HTML.** A missing `/assets/x.js` gets `train.html` with a
  200 (the SPA fallback in `server/static.js` does not exclude paths with an
  extension). It only matters for a tab that loaded an old `index.html` across a
  deploy.
