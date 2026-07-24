# AIM4.io — production setup runbook

Manual console/DNS steps to wire **Supabase (DB + auth)**, the **backend host**,
and **Vercel (frontend)** behind the domain **aim4.io**. Work top to bottom —
Supabase first, because its URL + key become Vercel environment variables.

Your fixed values (already filled in below):

| Thing | Value |
| --- | --- |
| Domain | `aim4.io` |
| Supabase URL | `https://srzzubymegwzmmqzdgpv.supabase.co` |
| Backend origin | `https://api.aim4.io` |

> Code note: these steps make the three platforms *reachable* and *configured*.
> The actual app integration (Supabase client, login UI, cloud leaderboards) is
> code I'll add separately — see the last section.

---

## Phase A — Supabase

### A1. Rotate the leaked secret key
- [ ] API Keys → **Secret keys** → `⋮` on `default` → **Roll** (it was pasted in
  chat). Save the new `sb_secret_…` somewhere safe — only the backend uses it.

### A2. Collect the two public values for Vercel
- [ ] `VITE_SUPABASE_URL` = `https://srzzubymegwzmmqzdgpv.supabase.co`
- [ ] `VITE_SUPABASE_ANON_KEY` = your **publishable** key (`sb_publishable_…`,
  API Keys → Publishable key → copy)

### A3. Auth → URL Configuration
- [ ] **Site URL:** `https://aim4.io`
- [ ] **Redirect URLs** (add each):
  - `https://aim4.io/**`
  - `https://www.aim4.io/**`
  - `http://localhost:5173/**`   ← local dev
- [ ] Auth → **Providers**: enable Email (and Google/GitHub if you want OAuth).

### A4. Create the schema (SQL Editor → New query → paste → Run)
- [ ] Paste the full contents of [`supabase/schema.sql`](supabase/schema.sql) and run it.
  Safe to re-run on an existing project (idempotent upgrades).
- [ ] Confirm under Table Editor that `profiles`, `scores`, `user_settings`, and `replays` exist with RLS on.

---

## Phase B — Backend custom domain (`api.aim4.io`)

The server is deployed separately; this just puts it behind a branded HTTPS
subdomain.

- [ ] Point `api.aim4.io` at the backend using whatever record your host asks
      for (an **A**/**AAAA** pair for a fixed IP, or a **CNAME** for a managed
      hostname). Add the same record to the Phase D table.
- [ ] Add the domain in the host's dashboard so it issues a TLS cert for it.
- [ ] Verify: `https://api.aim4.io/health` → `{"ok":true}`

WebSockets need no extra config — `wss://api.aim4.io/ws` rides the same cert,
as long as the host proxies upgrades instead of terminating them.

---

## Phase C — Vercel frontend

### C1. Add the domains
- [ ] Project → Settings → **Domains** → add `aim4.io` and `www.aim4.io`.
- [ ] Note the records Vercel shows (apex **A**, and **CNAME** for `www`) for Phase D.

### C2. Environment variables (Settings → Environment Variables, **Production**)
- [ ] `VITE_API_URL` = `https://api.aim4.io`
- [ ] `VITE_SUPABASE_URL` = `https://srzzubymegwzmmqzdgpv.supabase.co`
- [ ] `VITE_SUPABASE_ANON_KEY` = your `sb_publishable_…` key

### C3. Redeploy
- [ ] Trigger a new deployment (Vite inlines `VITE_*` at **build time**, so the
  vars only take effect after a rebuild).

---

## Phase D — DNS records (at your domain registrar)

| Host | Type | Value | Purpose |
| --- | --- | --- | --- |
| `aim4.io` | A | value Vercel shows (commonly `76.76.21.21`) | Frontend |
| `www` | CNAME | `cname.vercel-dns.com` | Frontend |
| `api` | A / AAAA / CNAME | value your backend host shows | Backend |

DNS can take minutes to a couple of hours. Vercel and most backend hosts
auto-issue HTTPS certs once the records resolve.

---

## Phase E — End-to-end verification

- [ ] `https://aim4.io` loads the game (Vercel).
- [ ] `https://api.aim4.io/health` → `{"ok":true}` (backend).
- [ ] In the game, multiplayer connects (DevTools → Network → WS shows
  `wss://api.aim4.io/ws` open).
- [ ] Supabase Auth: a test sign-up appears under Authentication → Users.

---

## Environment variable reference

**Frontend — Vercel (build-time, must be `VITE_`-prefixed):**
| Name | Value |
| --- | --- |
| `VITE_API_URL` | `https://api.aim4.io` |
| `VITE_SUPABASE_URL` | `https://srzzubymegwzmmqzdgpv.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` |

**Backend (runtime env, set in your host's dashboard or secrets store):**

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://srzzubymegwzmmqzdgpv.supabase.co` |
| `SUPABASE_SECRET_KEY` | `<new sb_secret_… after rotation>` |
| `SUPABASE_JWKS_URL` | `https://srzzubymegwzmmqzdgpv.supabase.co/auth/v1/.well-known/jwks.json` |
| `AIM4_REPLAY_DIR` | path on the mounted volume, e.g. `/data/replays` |

**Local dev (`.env`, gitignored):** leave `VITE_API_URL` empty (Vite proxies
`/api` + `/ws` to `127.0.0.1:3784`); set the two `VITE_SUPABASE_*` for auth testing.

---

## What I'll do in code (not manual — tell me when Phase A is done)

1. `npm install @supabase/supabase-js`; add `VITE_SUPABASE_*` to `.env.example`.
2. `src/lib/supabase.js` — the browser client.
3. Login / sign-up UI + username → `profiles`.
4. Cloud leaderboards: write to `scores` on run-finish, read top-N per
   scenario/config (keep `localStorage` as offline fallback).
5. (Later) server-side multiplayer score submission from the backend using the secret
   key + the JWKS endpoint to verify players — forge-proof competitive scores.
