# AIM4.io — production setup runbook

Manual console/DNS steps to wire **Supabase (DB + auth)**, **Fly.io (backend)**,
and **Vercel (frontend)** behind the domain **aim4.io**. Work top to bottom —
Supabase first, because its URL + key become Vercel environment variables.

Your fixed values (already filled in below):

| Thing | Value |
| --- | --- |
| Domain | `aim4.io` |
| Supabase URL | `https://srzzubymegwzmmqzdgpv.supabase.co` |
| Fly app | `aim4-backend` (live at `https://aim4-backend.fly.dev`) |
| Fly IPv4 (shared) | `66.241.125.241` |
| Fly IPv6 (dedicated) | `2a09:8280:1::134:6282:0` |

> Code note: these steps make the three platforms *reachable* and *configured*.
> The actual app integration (Supabase client, login UI, cloud leaderboards) is
> code I'll add separately — see the last section.

---

## Phase A — Supabase

### A1. Rotate the leaked secret key
- [ ] API Keys → **Secret keys** → `⋮` on `default` → **Roll** (it was pasted in
  chat). Save the new `sb_secret_…` somewhere safe — it's only used by Fly later.

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

## Phase B — Fly.io backend custom domain (`api.aim4.io`)

The server is already deployed; this just adds a branded HTTPS subdomain.

- [ ] Request the cert (I can run this for you, or):
  ```bash
  fly certs add api.aim4.io -a aim4-backend
  ```
- [ ] Add the DNS records it asks for (also listed in Phase D):
  - `api` **A** → `66.241.125.241`
  - `api` **AAAA** → `2a09:8280:1::134:6282:0`
- [ ] Wait, then check it's issued:
  ```bash
  fly certs show api.aim4.io -a aim4-backend
  ```
- [ ] Verify: `https://api.aim4.io/health` → `{"ok":true}`

WebSockets need no extra config — `wss://api.aim4.io/ws` rides the same cert.

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
| `api` | A | `66.241.125.241` | Backend |
| `api` | AAAA | `2a09:8280:1::134:6282:0` | Backend |

DNS can take minutes to a couple of hours. Fly + Vercel both auto-issue HTTPS
certs once the records resolve.

---

## Phase E — End-to-end verification

- [ ] `https://aim4.io` loads the game (Vercel).
- [ ] `https://api.aim4.io/health` → `{"ok":true}` (Fly).
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

**Backend — Fly (only when we add server-side Supabase writes; runtime secrets):**
```bash
fly secrets set \
  SUPABASE_URL=https://srzzubymegwzmmqzdgpv.supabase.co \
  SUPABASE_SECRET_KEY=<new sb_secret_… after rotation> \
  -a aim4-backend
```

**Local dev (`.env`, gitignored):** leave `VITE_API_URL` empty (Vite proxies
`/api` + `/ws` to `127.0.0.1:3784`); set the two `VITE_SUPABASE_*` for auth testing.

---

## What I'll do in code (not manual — tell me when Phase A is done)

1. `npm install @supabase/supabase-js`; add `VITE_SUPABASE_*` to `.env.example`.
2. `src/lib/supabase.js` — the browser client.
3. Login / sign-up UI + username → `profiles`.
4. Cloud leaderboards: write to `scores` on run-finish, read top-N per
   scenario/config (keep `localStorage` as offline fallback).
5. (Later) server-side multiplayer score submission from Fly using the secret
   key + the JWKS endpoint to verify players — forge-proof competitive scores.
