# AIM4 Accounts, Tiers, Entitlements & Admin Plan

Status: proposal. Nothing in here is built yet.

This document covers six pieces of work that all depend on one shared foundation:

1. Gate every feature behind account type (the pricing matrix)
2. Define the tier system with a billing-shaped hole left open
3. Admin / dev panel with impersonation, user browsing, and manual grants
4. "My Account" page
5. Remove username/email registration, Google sign-in only
6. Free 7 day trial that converts to Premium, cancellable

The foundation is the **entitlements engine** in Phase 1. Items 2 to 6 are all
consumers of it. Building any of them before it means building them twice.

---

## 0. Where the code is today

Understanding the current shape matters because the enforcement story is split
across two runtimes and they do not share a database.

### 0.1 What already exists

| Piece | Location | State |
|---|---|---|
| Supabase auth (email + password, Google OAuth) | `src/core/AuthManager.js` | Working, both providers live |
| Profiles / settings / scores / aim stats | `supabase/schema.sql` | Working, RLS enabled |
| Auth UI (sign in / register modal) | `src/site/site.js:139-235`, markup in `index.html` | Working |
| Public profile modal | `src/site/profileModal.js` | Read-only, other players |
| Server-side token verification | `server/replays/identity.js` | Working, verifies against `/auth/v1/user`, 60s cache |
| Demo library, visibility, teams, stratbook | `server/replays/*` | Working, **JSON files on disk**, not Postgres |
| Admin concept | `server/replays/identity.js:31` `adminUsernames()` | **Insecure, see 0.3** |
| Upload cap | `server/replays/routes.js:275` `MAX_DEMOS_PER_USER` (default 5) | Single global cap, not tier-aware |
| Demo visibility rules | `server/replays/visibility.js` | Working, already admin-aware |
| SPA routing | `src/site/site.js:284-338` `ROUTES` + `vercel.json` rewrites | Any new page needs an entry in **both** |

### 0.2 The two enforcement surfaces

This is the single most important architectural fact in this document.

```
                      ┌──────────────────────────────┐
   browser ──────────▶│ Supabase (Postgres + RLS)    │  profiles, scores,
                      │  direct from client via      │  settings, aim stats,
                      │  @supabase/supabase-js       │  replays metadata
                      └──────────────────────────────┘

                      ┌──────────────────────────────┐
   browser ──────────▶│ Node server (server/)        │  demo files, parsed
      Bearer token    │  verifies token via          │  ticks, teams.json,
                      │  identity.whoami()           │  stratbook, documents
                      └──────────────────────────────┘
```

A tier check written only in the client is decoration. A tier check written only
in RLS does not protect the demo API. A tier check written only in the Node
server does not protect direct table reads. **Every capability must be enforced
on whichever surface actually serves its data, and the client only ever mirrors
that decision for UI purposes.**

Mapping of capability to enforcement surface is given per-capability in section
2.3.

### 0.3 Security defect to fix as part of this work

`server/replays/identity.js` resolves admin like this:

```js
export function adminUsernames() {
  return new Set(
    String(process.env.AIM4_ADMIN_USERNAMES || 'artysan,player_73b35f71')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
}
// ...
admin: adminUsernames().has(username.toLowerCase())
```

And `AuthManager.updateUsername()` lets any signed-in user set their own
username to any unclaimed value. If `artysan` ever frees up, or if an admin
username in that env list is not currently registered, **any user can claim it
and become site admin.** `player_73b35f71` in particular looks like an
auto-generated placeholder that may not be registered at all.

Fix in Phase 3: admin is resolved by **immutable `auth.users.id` (UUID)**, never
by username. Username-based admin is deleted entirely, not deprecated.

---

## 1. Phase 1 — The entitlements engine

### 1.1 Design principle

One function answers every question in the product:

```js
can(user, 'demos.upload', { current: 12 })   // → { allowed: false, reason, limit, tier }
```

No feature code ever reads `tier === 'elite'`. Reading the tier name directly is
how you end up with 40 places to edit when a plan changes, and how the pricing
page drifts from what the code does. Feature code reads **capability keys**. The
mapping from tier to capability lives in exactly one table.

### 1.2 Capability catalogue

Derived directly from the pricing matrix. Four value shapes:

- **boolean** — has it or does not
- **limit** — an integer cap, `-1` meaning unlimited
- **quota** — N uses per rolling 24h (only meaningful on lower tiers)
- **enum** — a named mode, e.g. drawing board `none | nosave | limited | full`

```
demos.ads_free              bool    free:0  prem:1  team:1  elite:1
demos.full_recent_access    bool    free:0  prem:1  team:1  elite:1   (<1mo demos: first half only on free)
demos.viewer                bool    free:1  prem:1  team:1  elite:1
demos.macro_viewer          quota   free:1/24h  prem:∞  team:∞  elite:∞
demos.upload_limit          limit   free:3  prem:50  team:-1  elite:-1
demos.map_control           quota   free:0  prem:0  team:1/24h  elite:∞
demos.round_win_prediction  quota   free:0  prem:0  team:1/24h  elite:∞
demos.duel_win_prediction   quota   free:0  prem:0  team:1/24h  elite:∞
demos.auto_coach            quota   free:1/24h  prem:4/24h  team:∞  elite:∞
demos.teamspeak_sync        bool    free:0  prem:0  team:0  elite:1
demos.comms_coach           bool    free:0  prem:0  team:0  elite:1
drawing_board               enum    free:none  prem:nosave  team:limited(5/map)  elite:full

stats.single_game           bool    free:0  prem:0  team:1  elite:1
stats.team_statistics       bool    free:0  prem:0  team:1  elite:1
stats.metrics_player_full   bool    free:0  prem:1  team:1  elite:1   (PSDT, DT, Accuracy)
stats.metrics_team_full     bool    free:0  prem:0  team:0  elite:1   (PRW, Poss%)
stats.filters_full          bool    free:0  prem:1  team:1  elite:1
analytics.charts            quota   free:3/24h (limited controls)  prem+:∞
analytics.pattern_finder    quota   free:3/24h (limited controls)  prem+:∞

team.create_limit           limit   free:0  prem:0  team:1  elite:2
team.join                   bool    free:0  prem:1  team:1  elite:1
team.seat_capacity          limit   free:0  prem:1  team:7  elite:14
team.documents              limit   free:0  prem:10  team:10  elite:-1
team.roles_positions        bool    free:0  prem:1  team:1  elite:1
team.stratbook_access       bool    free:0  prem:1  team:1  elite:1
team.stratbook_limit        limit   free:0  prem:40/map  team:40/map  elite:-1
team.utility_archive        limit   free:0  prem:50/map  team:50/map  elite:-1
team.strategy_creator_2d    limit   free:0  prem:2/map  team:2/map  elite:-1
team.auto_round_winrates    bool    free:0  prem:0  team:0  elite:1

aim.trainer                 bool    free:1  prem:1  team:1  elite:1
aim.routines                bool    free:1  prem:1  team:1  elite:1
aim.advanced_analytics      bool    free:0  prem:1  team:1  elite:1
aim.replays                 enum    free:none  prem:best_and_recent  team:best_plus_10  elite:full
aim.custom_routines         limit   free:0  prem:3  team:10  elite:-1
aim.cosmetics               enum    free:none  prem:presets  team:presets  elite:full
```

Store this catalogue in one module, `shared/entitlements/catalogue.js`, imported
by both the client bundle and the Node server. It is plain data, no imports, so
it is safe to share across both runtimes.

> **Note on quotas.** The matrix has eight separate "N free every 24 hours"
> counters. Each is its own storage row, reset logic, UI state and support
> question. This plan implements them as specified, but the schema in 1.4 is
> deliberately shaped so that collapsing them into one shared daily pool later
> is a config change, not a migration. If that decision gets made before build
> starts, it removes roughly a third of the quota work.

### 1.3 Entitlement resolution order

A user's effective entitlements are computed by merging sources in this order,
last write winning per capability:

```
1. Base tier            'free' for every account, always
2. Seat grant           a seat on someone else's team plan
3. Own subscription     their own paid plan (or trial)
4. Admin grant          manual grant from the admin panel, possibly time-boxed
5. Admin override       is_admin → everything unlimited
```

Rules that fall out of this:

- A Free user seated on a Team Elite plan gets Elite capabilities while seated.
- A user with their own Premium **and** a Team seat gets the higher of the two
  per capability, resolved by tier rank, not by recency. Rank order:
  `free(0) < premium(10) < team_premium(20) < team_elite(30)`.
- Per the FAQ (#6), holding both is not refunded, but the user must never be
  *worse off* for holding both. Merging by rank guarantees that.
- An admin grant can be *lower* than a paid plan (useful for testing), so grants
  carry an explicit `mode: 'upgrade' | 'override'`. `upgrade` only applies if it
  ranks higher; `override` always applies.

Implemented as:

```js
// shared/entitlements/resolve.js
export function resolveEntitlements({ subscription, seat, grants, isAdmin, now }) {
  // → { tier, source, capabilities: {...}, expiresAt, trial: {...}|null }
}
```

Pure function, no I/O, fully unit-testable. Add
`shared/entitlements/resolve.test.js` to the `npm test` chain, which the project
already runs as a flat list of `node x.test.js` calls in `package.json`.

### 1.4 Database schema

New migration file: `supabase/migrations/0002_entitlements.sql`. The existing
`supabase/schema.sql` is a single flat file; keep it as the canonical
consolidated schema but start numbering migrations so production changes are
replayable.

```sql
-- ---------------------------------------------------------------------------
-- Plans: the catalogue. Rows here are product definitions, not user state.
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id              text primary key,           -- 'free' | 'premium' | 'team_premium' | 'team_elite'
  name            text not null,              -- 'Team Elite'
  rank            int  not null,              -- 0 | 10 | 20 | 30, used by resolve()
  seat_capacity   int  not null default 0,    -- 0 | 1 | 7 | 14
  team_capacity   int  not null default 0,    -- teams this plan may create
  capabilities    jsonb not null default '{}'::jsonb,
  -- Billing hole, left null until a provider is wired up (see Phase 2).
  price_month_cents  int,
  price_quarter_cents int,
  price_year_cents   int,
  billing_provider   text,                    -- 'stripe' | 'paddle' | null
  provider_price_ids jsonb default '{}'::jsonb, -- { "month": "price_x", "year": "price_y" }
  is_public       bool not null default true, -- false hides it from the pricing page
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Subscriptions: one row per paying account. Free users have no row.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  plan_id         text not null references public.plans(id),
  status          text not null,   -- 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'
  term            text not null,   -- 'month' | 'quarter' | 'year' | 'lifetime'
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz,           -- null = never expires (admin/lifetime)
  cancel_at_period_end bool not null default false,
  -- Trial (Phase 6)
  trial_started_at timestamptz,
  trial_ends_at    timestamptz,
  -- Billing hole
  provider              text,                 -- null while unbilled
  provider_customer_id  text,
  provider_subscription_id text,
  provider_status       text,
  -- Provenance: how did this subscription come to exist
  source          text not null default 'admin', -- 'admin' | 'trial' | 'billing' | 'migration'
  granted_by      uuid references auth.users(id),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists subscriptions_one_active_per_user
  on public.subscriptions (user_id)
  where status in ('trialing', 'active', 'past_due');

create index if not exists subscriptions_period_end_idx
  on public.subscriptions (current_period_end)
  where status in ('trialing', 'active');

-- ---------------------------------------------------------------------------
-- Seats: a subscription lends capabilities to other accounts.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_seats (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null, -- null = empty seat
  team_id         text,                     -- mirrors teams.json id, nullable
  assigned_at     timestamptz,
  released_at     timestamptz,              -- set on removal, row is kept for the cooldown
  created_at      timestamptz not null default now()
);

create unique index if not exists subscription_seats_one_per_user_per_sub
  on public.subscription_seats (subscription_id, user_id)
  where user_id is not null and released_at is null;

create index if not exists subscription_seats_user_idx
  on public.subscription_seats (user_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- Admin grants: manual, optionally time-boxed capability awards.
-- ---------------------------------------------------------------------------
create table if not exists public.entitlement_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan_id     text references public.plans(id),   -- whole-tier grant
  capability  text,                                -- or a single capability override
  value       jsonb,                               -- value for that capability
  mode        text not null default 'upgrade',     -- 'upgrade' | 'override'
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz,                         -- null = forever
  reason      text,
  granted_by  uuid not null references auth.users(id),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint grant_has_target check (plan_id is not null or capability is not null)
);

create index if not exists entitlement_grants_user_idx
  on public.entitlement_grants (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Quota counters. One row per user per capability per window.
-- Shaped so a shared pool later is just a different `capability` value.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_counters (
  user_id     uuid not null references auth.users(id) on delete cascade,
  capability  text not null,
  window_start timestamptz not null,
  used        int  not null default 0,
  primary key (user_id, capability, window_start)
);

create index if not exists usage_counters_window_idx
  on public.usage_counters (window_start);

-- ---------------------------------------------------------------------------
-- Admins. UUID-keyed, never username-keyed. See section 0.3.
-- ---------------------------------------------------------------------------
create table if not exists public.site_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  label       text,                  -- 'artysan', 'ryL' for display only
  can_impersonate bool not null default true,
  can_grant       bool not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log. Every admin action, every impersonation, every grant.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          bigserial primary key,
  actor_id    uuid not null references auth.users(id),
  action      text not null,        -- 'impersonate.start', 'grant.create', ...
  target_user uuid references auth.users(id),
  payload     jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_actor_idx on public.admin_audit_log (actor_id, created_at desc);
create index if not exists admin_audit_target_idx on public.admin_audit_log (target_user, created_at desc);
```

### 1.5 RLS policies

```sql
alter table public.plans                enable row level security;
alter table public.subscriptions        enable row level security;
alter table public.subscription_seats   enable row level security;
alter table public.entitlement_grants   enable row level security;
alter table public.usage_counters       enable row level security;
alter table public.site_admins          enable row level security;
alter table public.admin_audit_log      enable row level security;

-- Plans are public product data.
create policy "read plans" on public.plans for select using (true);

-- A user reads their own subscription and their own seats. Nothing else.
create policy "read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

create policy "read own seat" on public.subscription_seats
  for select using (auth.uid() = user_id);

create policy "read own grants" on public.entitlement_grants
  for select using (auth.uid() = user_id);

create policy "read own counters" on public.usage_counters
  for select using (auth.uid() = user_id);

-- Nobody writes any of these from the client. All writes go through the
-- service role on the server. There are deliberately no INSERT/UPDATE policies.

-- site_admins is readable only by admins, so the table cannot be used to
-- enumerate who to target.
create policy "admins read admins" on public.site_admins
  for select using (exists (select 1 from public.site_admins sa where sa.user_id = auth.uid()));

-- admin_audit_log: no client policies at all. Service role only.
```

The absence of write policies is intentional and load-bearing. Anything that
mutates entitlements must go through the Node server holding
`SUPABASE_SERVICE_ROLE_KEY`, so it can be audited in one place.

### 1.6 New environment variables

Add to `.env.example`:

```
# Server-side privileged key. NEVER exposed to the client bundle, never
# prefixed VITE_. Required for admin operations and entitlement writes.
SUPABASE_SERVICE_ROLE_KEY=

# Comma-separated auth.users UUIDs seeded into site_admins on boot.
# Bootstrap only; the table is the source of truth after first run.
AIM4_ADMIN_USER_IDS=

# Trial configuration (Phase 6)
AIM4_TRIAL_DAYS=7
AIM4_TRIAL_PLAN=premium
AIM4_TRIAL_ENABLED=1
```

Delete `AIM4_ADMIN_USERNAMES` and its default value.

Vite config note: `vite.config.js` must not leak the service role key. Confirm
the existing env handling only forwards `VITE_`-prefixed variables into the
bundle before adding this key.

### 1.7 Server module layout

```
shared/entitlements/
  catalogue.js        capability definitions and per-plan values (pure data)
  resolve.js          resolveEntitlements(), pure
  resolve.test.js
  keys.js             exported capability key constants, so typos fail loudly

server/entitlements/
  service.js          Supabase service-role client (singleton)
  load.js             loadEntitlements(userId) with a short cache
  enforce.js          requireCapability(), consumeQuota(), checkLimit()
  quota.js            rolling window arithmetic
  grants.js           create/revoke grants, admin-only
  subscriptions.js    create/cancel/expire, trial handling
  sweep.js            periodic job: expire trials & subscriptions
  enforce.test.js
```

`server/replays/identity.js` gains one field. `whoami()` currently returns
`{id, username, signedIn, admin}`. It becomes:

```js
{
  id, username, signedIn,
  admin: boolean,             // now from site_admins, by UUID
  entitlements: {             // resolved, cached with the same 60s TTL
    tier: 'team_elite',
    source: 'seat',
    capabilities: { ... },
    expiresAt: '2026-09-01T00:00:00Z',
    trial: null
  },
  impersonating: null | { actorId, actorUsername, targetId }
}
```

Because `whoami()` is already cached per-token for 60s and already called by
every replay route, this gives entitlement-awareness to the whole demo API with
one change. **Important:** the cache TTL means a grant made in the admin panel
takes up to 60 seconds to apply. Add an explicit cache-bust: the grant endpoint
calls `invalidateUser(userId)` on write, so admin actions feel instant.

### 1.8 Enforcement helpers

```js
// server/entitlements/enforce.js

/** Throws a 402-shaped error if the capability is missing. */
export async function requireCapability(user, key, opts = {})

/** For limits: returns { allowed, current, limit, remaining }. */
export async function checkLimit(user, key, currentCount)

/** For quotas: atomically consumes one use, returns { allowed, used, limit, resetsAt }. */
export async function consumeQuota(user, key)

/** Non-throwing read for building UI payloads. */
export function capability(user, key)
```

Quota consumption must be atomic. Implement as a Postgres function so two
concurrent requests cannot both pass the check:

```sql
create or replace function public.consume_quota(
  p_user_id uuid, p_capability text, p_limit int, p_window_start timestamptz
) returns table (allowed boolean, used int)
language plpgsql security definer as $$
begin
  insert into public.usage_counters (user_id, capability, window_start, used)
  values (p_user_id, p_capability, p_window_start, 1)
  on conflict (user_id, capability, window_start)
  do update set used = public.usage_counters.used + 1
     where public.usage_counters.used < p_limit
  returning true, public.usage_counters.used into allowed, used;

  if not found then
    select false, uc.used into allowed, used
      from public.usage_counters uc
     where uc.user_id = p_user_id and uc.capability = p_capability
       and uc.window_start = p_window_start;
  end if;
  return next;
end $$;
```

Window definition: **rolling from first use**, per FAQ #26. `window_start` is the
timestamp of the first use in the current window; the window is open while
`now() < window_start + 24h`. A nightly sweep deletes counter rows older than
48h. If the decision changes to a fixed daily reset, `window_start` becomes
`date_trunc('day', now() at time zone 'utc')` and nothing else changes.

### 1.9 HTTP contract for a blocked action

One shape, everywhere, so the client can render one upsell component:

```
HTTP 402 Payment Required
{
  "error": "upgrade_required",
  "capability": "demos.round_win_prediction",
  "message": "Round win prediction is available on Team Premium.",
  "currentTier": "premium",
  "requiredTier": "team_premium",
  "quota": { "used": 1, "limit": 1, "resetsAt": "2026-08-03T14:22:10Z" }  // when quota-based
}
```

402 rather than 403 so an upgrade prompt is distinguishable from a genuine
permission failure (e.g. someone else's private demo, which stays 403).

### 1.10 Client side

```
src/lib/entitlements.js      EntitlementManager, mirrors server truth
src/site/upgradeGate.js      the shared locked-feature UI
```

`EntitlementManager` hangs off `AuthManager`, refreshes on auth change, and
exposes `can(key)`, `limit(key)`, `quota(key)`, `tier`. Three UI treatments:

- **Locked** — feature is not on this tier: show it, disabled, with an upgrade
  affordance. Never hide it. Users cannot want what they cannot see.
- **Quota'd** — show remaining uses inline, e.g. `Auto coach (3 left today)`.
- **Capped** — show `40 / 40 strategies on this map` next to the create button.

Copy rules from `CLAUDE.md` apply to everything in this layer: no em dashes, no
explanatory filler under headings. Button label is `Upgrade`, not `Upgrade to
unlock more powerful analytics`.

Route guards: `ROUTES` in `src/site/site.js` gains an optional
`requires: 'capability.key'`. Guarded routes still render, showing the locked
state rather than redirecting. Redirecting away from a paid page is a bad
conversion surface and it breaks shared links.

### 1.11 Wiring the existing hard-coded limits

These are the concrete edits that replace today's constants:

| Today | Becomes |
|---|---|
| `routes.js:275` `MAX_DEMOS_PER_USER = 5` | `checkLimit(me, 'demos.upload_limit', mine.length)` |
| `routes.js:282` `if (me.admin) return ''` | Falls out of resolution order step 5 |
| `routes.js:434` `maxDemos: me.admin ? 0 : MAX_...` | `maxDemos: capability(me, 'demos.upload_limit')` |
| `teamsStore.js:18` `MAX_MEMBERS = 7` | `capability(owner, 'team.seat_capacity')` |
| `visibility.js` admin bypass | Unchanged, but `user.admin` now UUID-sourced |
| Stratbook / utility / 2D creator caps | New `checkLimit` calls at each create path |

Note `MAX_MEMBERS` is per-team but seat capacity is per-**subscription** and
Elite spans two teams. The seat check must be `count(seats on this subscription)`
not `count(members of this team)`, otherwise Elite's 14 becomes 7+7 with no
flexibility. If you later decide 7-per-team is the intended rule for Elite too,
that becomes a second capability `team.seats_per_team`, not a change to this one.

---

## 2. Phase 2 — Tiers, and the billing-shaped hole

### 2.1 Seeding the plans

`supabase/migrations/0003_seed_plans.sql` inserts the four rows. Prices as
integer cents, nullable, and **null until billing is live**. The pricing page
reads them from `plans` so there is one source of truth for both the marketing
page and what the system enforces.

```sql
insert into public.plans (id, name, rank, seat_capacity, team_capacity, capabilities)
values
  ('free',         'Free',         0,  0, 0, '{...}'::jsonb),
  ('premium',      'Premium',      10, 1, 0, '{...}'::jsonb),
  ('team_premium', 'Team Premium', 20, 7, 1, '{...}'::jsonb),
  ('team_elite',   'Team Elite',   30, 14, 2, '{...}'::jsonb)
on conflict (id) do update set
  name = excluded.name, rank = excluded.rank,
  seat_capacity = excluded.seat_capacity,
  team_capacity = excluded.team_capacity,
  capabilities = excluded.capabilities;
```

The `capabilities` blobs are generated from `shared/entitlements/catalogue.js` by
a small script (`scripts/sync-plan-capabilities.mjs`) so the JS catalogue stays
canonical and the DB copy is derived. Run it as part of deploy. Never hand-edit
the jsonb.

### 2.2 What "open end for billing" concretely means

Everything a billing provider needs already exists in the schema and is simply
unused:

- `plans.billing_provider`, `plans.provider_price_ids`
- `subscriptions.provider`, `provider_customer_id`, `provider_subscription_id`,
  `provider_status`
- `subscriptions.current_period_end`, `cancel_at_period_end`
- `subscriptions.source` distinguishes `admin` / `trial` / `billing`

Three integration points get built now as **no-op stubs with real signatures**:

```js
// server/billing/provider.js
export const provider = {
  name: null,                                  // 'stripe' when wired
  async createCheckoutSession({ userId, planId, term }) { throw new Error('billing_not_configured'); },
  async createPortalSession({ userId }) { throw new Error('billing_not_configured'); },
  async cancelSubscription({ subscriptionId, atPeriodEnd }) { /* local-only path works today */ },
  verifyWebhook(rawBody, signature) { return null; }
};
```

```
POST /api/billing/checkout    → 501 while provider.name is null
POST /api/billing/portal      → 501 while provider.name is null
POST /api/billing/webhook     → 200 no-op, logs and drops while unconfigured
```

The webhook route exists from day one so the URL can be registered with the
provider before any provider code is written, and so the raw-body handling
(which is easy to get wrong once a JSON body parser is in the chain) is proven
early. Note `server/index.js` currently caps bodies at `MAX_BODY = 64 * 1024`
and JSON-parses everything; the webhook route needs a raw-body branch **before**
that parse, because signature verification runs on exact bytes.

When billing is wired later, the only new logic is: webhook receives event →
map provider status to `subscriptions.status` → write row → `invalidateUser()`.
Every downstream consumer already works, because they read entitlements, not
Stripe.

### 2.3 Enforcement surface per capability

| Capability group | Enforced in | Why |
|---|---|---|
| `demos.*` (upload, viewer, macro, predictions, coach) | Node server, `server/replays/routes.js` | Demo bytes and parsed ticks are served by Node |
| `demos.teamspeak_sync`, `comms_coach` | Node server | Same |
| `stats.*`, `analytics.*` | Node server, `statsIndex.js` + routes | Aggregations run server-side over the access set |
| `team.*` | Node server, `teamRoutes.js` + `teamsStore.js` | teams.json is Node-owned |
| `aim.advanced_analytics`, `aim.replays` | Supabase RLS + client | `aim_run_stats` and `replays` are read directly from Postgres |
| `aim.custom_routines` | Supabase RLS | Routine rows live in Postgres |
| `aim.cosmetics`, `demos.ads_free` | Client only | Cosmetic. Worth nothing to steal, not worth a round trip |
| `drawing_board` | Node server (saving) + client (access) | Access is free-ish, persistence is the gate |

For the Supabase-enforced rows, RLS needs a helper so policies stay readable:

```sql
create or replace function public.has_capability(p_key text)
returns boolean language sql stable security definer as $$
  select coalesce(
    (select (p.capabilities -> p_key)::text not in ('false','0','null')
       from public.subscriptions s
       join public.plans p on p.id = s.plan_id
      where s.user_id = auth.uid()
        and s.status in ('trialing','active')
      order by p.rank desc limit 1),
    false)
    or exists (select 1 from public.site_admins where user_id = auth.uid());
$$;
```

This deliberately does **not** consider seats or grants, because a SQL function
duplicating `resolve.js` is exactly the drift risk this whole design avoids.
Instead: for any capability that must be enforced in RLS *and* can be granted by
seat, denormalise. Add `profiles.effective_tier text` and
`profiles.effective_capabilities jsonb`, written by the server whenever
entitlements change, and have RLS read that column. One writer, one truth, and
RLS policies become trivial:

```sql
create policy "aim replays by tier" on public.replays
  for select using (
    user_id = auth.uid()
    or (select effective_capabilities -> 'aim.replays' from public.profiles where id = auth.uid())
       is not null
  );
```

### 2.4 Recomputation triggers

`profiles.effective_*` must be recomputed on: subscription create/update/expire,
seat assign/release, grant create/revoke, trial start/end, and the nightly sweep.
Centralise in `server/entitlements/recompute.js` with a single
`recomputeUser(userId)` that all of the above call. Never write
`effective_capabilities` from anywhere else.

---

## 3. Phase 3 — Admin / dev panel

### 3.1 Access control

Two accounts only: `@artysan` and `@ryL`. Rules:

1. Admin identity is `auth.users.id`. Look both UUIDs up once, put them in
   `AIM4_ADMIN_USER_IDS`, and seed `site_admins` on boot.
2. `adminUsernames()` in `server/replays/identity.js` is **deleted**, along with
   `AIM4_ADMIN_USERNAMES`. Replaced by `isSiteAdmin(userId)` reading
   `site_admins` through the service-role client, cached 60s.
3. If `@ryL` does not have an account yet, create it before this ships. Do not
   add a username to a list and hope. Seeding by UUID means the row cannot be
   claimed by an impostor who registers the name first.
4. The admin API lives under `/api/admin/*` and every route calls
   `requireAdmin(req)` as its first statement. There is no admin capability in
   the entitlements catalogue: admin is not a tier, and mixing it into the tier
   system is how a grant accidentally becomes root.
5. The admin SPA route (`/admin`) renders nothing until `/api/admin/me` returns
   200. Client-side route hiding is cosmetic; the API is the boundary.

### 3.2 Panel structure

New files:

```
src/site/admin/adminView.js       shell + sub-navigation
src/site/admin/usersPanel.js      search, list, drill-in
src/site/admin/userDetail.js      one user: subscription, seats, grants, content
src/site/admin/grantsPanel.js     create/revoke grants and trials
src/site/admin/impersonate.js     "view as" banner and controls
src/site/admin/auditPanel.js      the audit log, filterable
server/admin/routes.js            handleAdminRequest(req, res, url)
server/admin/users.js             listing and search over auth.users + profiles
server/admin/impersonation.js     token minting, verification, revocation
```

Register `handleAdminRequest` in `server/index.js` next to the existing
`handleReplayRequest` / `handleTeamRequest` dispatch. Add `/admin` to `ROUTES` in
`src/site/site.js` **and** to `vercel.json` rewrites (both, or the deep link
404s in production while working in dev).

### 3.3 User browser

```
GET /api/admin/users?q=&tier=&status=&page=&sort=
```

Returns, per user: id, username, email, created_at, last_sign_in_at, provider(s),
effective tier and its source, subscription status, trial state, seat memberships,
team ownership, demo count and bytes, aim runs, flags. Backed by a view:

```sql
create or replace view public.admin_user_overview as
select
  u.id, u.email, u.created_at, u.last_sign_in_at,
  u.raw_app_meta_data -> 'providers' as providers,
  p.username, p.country_code, p.elo,
  p.effective_tier, p.effective_capabilities,
  s.status as subscription_status, s.plan_id, s.term,
  s.current_period_end, s.trial_ends_at, s.source as subscription_source,
  (select count(*) from public.subscription_seats ss
    where ss.user_id = u.id and ss.released_at is null) as seats_held,
  exists (select 1 from public.site_admins sa where sa.user_id = u.id) as is_admin
from auth.users u
left join public.profiles p on p.id = u.id
left join public.subscriptions s
  on s.user_id = u.id and s.status in ('trialing','active','past_due');
```

Service-role only. This view touches `auth.users` and must never be reachable
with the anon key. Confirm by testing an anon-key select against it as part of
the acceptance checks.

Demo counts and storage bytes come from the Node side (`demoStore.js`), not
Postgres, so the user detail response is a merge of a Postgres query and a
filesystem/JSON lookup. Keep them as two fields with separate loading states
rather than blocking the whole panel on the slower one.

### 3.4 Impersonation ("view as")

This is the piece with the most ways to go wrong. Design constraints:

- **Never mint a Supabase session for the target user.** Do not use the admin
  API to generate a magic link or sign in as them. That produces a real token
  indistinguishable from the user's own, it would appear in their session list,
  and it cannot be scoped or revoked cleanly.
- Instead: the admin keeps their own token, and adds a second header.

```
Authorization: Bearer <admin's own Supabase token>
X-Aim4-Impersonate: <impersonation ticket>
```

The ticket is a short-lived signed token minted by the server:

```js
// server/admin/impersonation.js
// jose is already a dependency (package.json), use it rather than adding one.
mintTicket({ actorId, targetId, ttlSeconds = 1800, readOnly = true })
verifyTicket(ticket) // → { actorId, targetId, readOnly, exp } or null
```

`whoami()` resolution becomes:

1. Verify the bearer token as today. Call this the **actor**.
2. If `X-Aim4-Impersonate` is present, verify the ticket. Reject unless
   `ticket.actorId === actor.id` **and** `isSiteAdmin(actor.id)`. Both checks,
   every request. A stolen ticket alone is useless without the admin's session.
3. Resolve the target user's entitlements and content access.
4. Return the target's identity with `impersonating: { actorId, ... }` attached.

Rules that follow:

- **Read-only by default.** `readOnly: true` on the ticket makes every non-GET
  request 403 while impersonating. Write-mode impersonation is a separate,
  explicitly-chosen mode with its own audit entry, because "I broke a customer's
  stratbook while looking at it" is a real outcome otherwise.
- Impersonation cannot target another admin. Prevents one admin account
  laundering actions through another.
- Every request served under a ticket writes an audit row. Rate-limit the
  audit writes by coalescing per minute per ticket so browsing does not write
  4,000 rows.
- Tickets expire in 30 minutes and are revocable. Keep a `revoked_tickets` set
  (or a `jti` column) so ending a session is immediate.
- A persistent, unmissable banner while impersonating. Red bar, fixed top,
  target username, elapsed time, `Exit` button. Per `CLAUDE.md`, the copy is
  `Viewing as @username` and nothing else.
- Impersonation must be visible in the target's own account page after the
  fact if you want to be transparent about it. **Decide this before shipping.**
  It is a policy call, not a technical one, and retrofitting disclosure is
  harder than including it.
- Never allow impersonation to trigger side effects: no quota consumption, no
  `last_sign_in_at` update, no play-time increment, no Elo write. Thread an
  `isImpersonating` flag through `consumeQuota()` to short-circuit.

### 3.5 Manual grants and trials

```
POST   /api/admin/grants          { userId, planId?, capability?, value?, mode, expiresAt?, reason }
DELETE /api/admin/grants/:id      revoke (sets revoked_at, keeps the row)
POST   /api/admin/subscriptions   { userId, planId, term, periodEnd?, source: 'admin' }
POST   /api/admin/trials          { userId, planId, days }
POST   /api/admin/seats           { subscriptionId, userId }
DELETE /api/admin/seats/:id
```

Covers the stated requirements directly:

- **"Grant my own team an infinite Elite subscription"** — create a subscription
  with `plan_id: 'team_elite'`, `current_period_end: null`, `source: 'admin'`,
  then assign seats to each team member. Null period end means the sweep never
  expires it. Add a one-click **Grant infinite Elite** action on the user detail
  page since it will be used constantly during development.
- **"Give certain users certain tiers for certain amounts of time as a trial"** —
  `POST /api/admin/trials` with `days`, producing a `trialing` subscription with
  `trial_ends_at` set. Same machinery as the public 7 day trial in Phase 6, so
  there is one trial code path, not two.

Every one of these writes `admin_audit_log` with actor, target, before/after
payload. Non-negotiable: the audit log is what makes an impersonation feature
defensible if a user ever asks what you looked at.

### 3.6 Manual content edits

"Manually removing / adding certain things to their account" spans both stores:

| Thing | Store | Admin action |
|---|---|---|
| Demos | Node, `demoStore.js` | Delete, change visibility, reassign uploader, exempt from cap |
| Teams / seats | Node, `teams.json` + Postgres seats | Add or remove members, transfer ownership, reset invite cooldown |
| Stratbook / utility / documents | Node, `teamsStore.js` | Delete entries, raise per-team caps |
| Aim routines, replays, scores | Postgres | Delete rows, reset Elo, clear stats |
| Profile | Postgres | Rename, set country, force username change |

Rather than a bespoke endpoint per object type, expose one audited mutation
endpoint per store with a narrow allowlist of operations:

```
POST /api/admin/content/:store/:op   store ∈ {demos, teams, profile, aim}
```

`op` is validated against a hard-coded map. No dynamic table names, no dynamic
SQL, no pass-through of arbitrary column names. The convenience of a generic
admin endpoint is exactly how an admin panel becomes an RCE.

### 3.7 Rate limiting and exposure

`/api/admin/*` gets: strict rate limit, no CORS (`Access-Control-Allow-Origin`
must not be `*` for these; `server/index.js:52` currently sets `*` globally, so
the admin dispatch needs its own header block), and `Cache-Control: no-store`.
Consider gating the whole prefix behind an additional shared secret header in
production so an auth bug alone is not sufficient to reach it.

---

## 4. Phase 4 — "My Account"

### 4.1 Route and structure

New route `account` at `/account`, added to `ROUTES` in `src/site/site.js` and to
`vercel.json` rewrites. Distinct from the existing `profileModal.js`, which is
the *public* view of *another* player and stays as it is.

```
src/site/account/accountView.js       shell, tab routing
src/site/account/overviewTab.js       identity, plan, quick actions
src/site/account/subscriptionTab.js   plan, term, renewal, cancel, trial state
src/site/account/teamsTab.js          teams owned and seats held
src/site/account/dataTab.js           usage, storage, export, deletion
src/site/account/securityTab.js       linked providers, sessions, sign out
```

Sub-paths (`/account/subscription` etc.) so links are shareable, matching the
existing `/team/*` pattern already in `ROUTES`.

### 4.2 Tab contents

**Overview** — username with rename, country flag, avatar if there is one,
member since, current tier badge with source (`Own subscription`, `Seat on
Team Vitality`, `Trial, 4 days left`, `Granted`).

**Subscription** — current plan, term, next renewal date, price paid, cancel
control, upgrade/downgrade entry points, trial banner with days remaining and
the exact date and amount of the first charge. Renders `billing_not_configured`
gracefully: show the plan and its source, hide the payment controls, do not show
a broken button.

**Teams** — teams owned (with seat usage `5 / 7`), teams seated on, and the
consequence of leaving. When a user holds both a personal Premium and a seat,
show it plainly here with the effective tier, because FAQ #6 makes this a
non-refundable situation and the account page is where it should be discoverable
rather than on a bank statement.

**Data & usage** — demos uploaded and bytes used against the cap, quota counters
with reset times, stratbook and utility counts per map against caps, export, and
account deletion.

**Security** — linked providers (Google), active sessions with sign-out-others,
and, after Phase 5, no password controls at all.

### 4.3 Data export and deletion

Both are referenced in the FAQ and neither exists.

- **Export**: `POST /api/account/export` queues a job, produces a zip of demos
  (originals), stratbook, documents, drawings, routines, and stats as JSON, and
  emails a signed link valid 24h. FAQ #1 tells users to "transfer this data
  elsewhere" during the 90 day window; without export that promise is not
  keepable.
- **Deletion**: `POST /api/account/delete` with a confirmation step. Must handle
  the case where the account owns a team with active seats: block deletion until
  ownership is transferred or the team is disbanded, and say which. Sets a
  `deletion_requested_at`, hard-deletes after a grace period, cascades through
  both stores.

### 4.4 The 90-day retention state

The FAQ commits to: on downgrade, over-cap content is retained but inaccessible
for 90 days, then deleted. Nothing implements this. It needs:

```sql
alter table public.subscriptions add column if not exists lapsed_at timestamptz;
```

Plus a `retention` module that, on downgrade or lapse:

1. Stamps `lapsed_at`.
2. Marks over-cap content `locked` rather than deleting it (a `locked_at` column
   on the relevant Node-side records and Postgres rows).
3. Surfaces the forced-selection flow from FAQ #2: before the user may create or
   edit, they must pick which N to keep. This is a real UI, not a background job:
   `src/site/account/retentionPicker.js`.
4. A nightly sweep hard-deletes locked content past 90 days, after two warning
   emails (30 days and 7 days out).

Flag: this is a meaningful chunk of work that the pricing FAQ has already
promised to users. It should not be discovered during the first downgrade.

---

## 5. Phase 5 — Google-only authentication

### 5.1 What gets deleted

In `src/core/AuthManager.js`:

- `signUp()` — delete entirely
- `signIn()` — delete entirely
- `linkGoogle()` / `canLinkGoogle` / `hasGoogleLinked` — simplify, Google is now
  the only provider, so linking is meaningless
- Keep `signInWithGoogle()`, `signOut()`, `updateUsername()`, `updateCountryCode()`

In `src/lib/supabase.js`: `validateEmail`, `validatePassword` become unused.
Keep `validateUsername`, which is still needed for the username picker.

In `src/site/site.js:139-235` and the corresponding markup in `index.html`:
remove the tab switcher, username/email/password/confirm fields, and the
submit handler. What remains is a single `Continue with Google` button.

In Supabase dashboard: disable the Email provider under Authentication →
Providers. Leaving it enabled means the API accepts signups even with no UI for
them.

### 5.2 The username problem

Today, username comes from the registration form and is written to
`user_metadata.username` at signup (`AuthManager.js:219`). Google sign-in has no
such step, so `_ensureProfile()` falls through to
`player_${user.id.slice(0,8)}` (`AuthManager.js:141`). That auto-name is
already visible on leaderboards and, notably, is the shape of the placeholder
admin entry `player_73b35f71` in the current admin list.

Google-only means a **first-run username picker** is required:

1. Google OAuth completes, session exists, profile row is created with a
   provisional username and `username_chosen = false`.
2. `AuthManager` detects `username_chosen === false` and the app opens a blocking
   modal: `Choose your username`. No dismiss, no escape, no route change until
   set. It is not optional, because the alternative is a leaderboard full of
   `player_a1b2c3d4`.
3. On submit: validate, check uniqueness, write, set `username_chosen = true`.

```sql
alter table public.profiles add column if not exists username_chosen boolean not null default true;
-- default true so existing accounts are unaffected; the trigger sets false for new ones
```

Update `public.handle_new_user()` (`supabase/schema.sql:546`) to set
`username_chosen = false` when no `user_metadata.username` is present.

### 5.3 Migrating existing password accounts

Existing email/password users must not be locked out. Order of operations:

1. Ship the username picker and Google-only UI, but **leave the email provider
   enabled** in Supabase.
2. Show a one-time prompt to password users: `Link Google to keep access`, using
   the existing `linkIdentity` path (`AuthManager.js:288`), which already handles
   the "manual linking is disabled" case.
3. Email the remainder. Give a real deadline, at least 30 days.
4. Only then disable the email provider.
5. Users who never link: their account is intact but unreachable. Keep a
   documented support path where an admin can attach a Google identity to an
   existing `auth.users` row by verified email match. Build this as an admin
   panel action in Phase 3 rather than as ad-hoc SQL at 2am.

Edge case worth deciding now: a password user whose Google account uses a
different email. `linkIdentity` handles it, but the support path matching "by
verified email" does not. Decide whether support matches on email or on a
manually confirmed identity check.

### 5.4 Knock-on effects

- `validateEmail` / `validatePassword` removal touches any import sites; grep
  before deleting.
- Password reset flows, if any exist in `index.html` markup, go too.
- The Supabase email templates for confirmation and recovery become unused.
- `AuthManager.signUp()` currently does a pre-flight username uniqueness check
  against `profiles`; that logic moves into the username picker.
- Any test or script that creates accounts via password will break. Grep
  `signInWithPassword` across `scripts/` and `tools/`.

---

## 6. Phase 6 — The 7 day free trial

### 6.1 Behaviour

Stated requirement: a free 7 day trial that activates a Premium subscription
after 7 days, cancellable.

Interpretation, stated explicitly so it can be corrected: the user starts a
trial with full Premium capabilities immediately; on day 7 it converts to a
paid Premium subscription unless cancelled first. This is a
**paid-conversion trial**, not a free-then-locked trial.

### 6.2 Eligibility

- One trial per account, ever. `subscriptions` rows are never deleted, so
  eligibility is `not exists (select 1 from subscriptions where user_id = $1 and
  trial_started_at is not null)`.
- Also one trial per **payment method** once billing exists, since account
  creation is free and unlimited. Until then, one per account plus a
  device/IP heuristic recorded but not enforced.
- Not available to users already on a paid plan or holding a seat that already
  grants Premium or better. Offering a trial of something they already have is
  a support ticket.
- Admin-granted trials (Phase 3.5) bypass eligibility, and set
  `source = 'admin'` so they are distinguishable in reporting.

### 6.3 Flow

```
POST /api/trials/start
  → eligibility check
  → require payment method IF billing configured, else skip
  → insert subscriptions row:
       plan_id: 'premium', status: 'trialing', source: 'trial',
       trial_started_at: now(), trial_ends_at: now() + 7 days,
       current_period_end: now() + 7 days
  → recomputeUser(userId), invalidateUser(userId)
  → audit
```

Conversion is handled by `server/entitlements/sweep.js`, running every 15
minutes:

```
for each subscription where status = 'trialing' and trial_ends_at <= now():
    if cancel_at_period_end:  status → 'expired',  recompute
    elif billing configured:  charge via provider; on success status → 'active'
                              and extend current_period_end by the term;
                              on failure status → 'past_due' with dunning
    else:                     status → 'expired'   (cannot charge, do not pretend)
```

That last branch matters: while billing is not wired, a trial must **expire**,
not silently become a free paid plan. Otherwise every trial user becomes a
permanent free Premium user and there is no way to tell them apart later.

### 6.4 Cancellation

`POST /api/trials/cancel` sets `cancel_at_period_end = true`. The user keeps
Premium until `trial_ends_at`, then drops to Free. Never revoke access at the
moment of cancellation; taking away paid-for or promised time is what generates
chargebacks and is the single most common cancellation antipattern.

Cancel is reachable from: the account page subscription tab, the trial banner,
and any upgrade prompt shown during the trial. Two clicks maximum. A hard-to-find
cancel button is a dark pattern and, for EU users, a legal exposure.

### 6.5 Notifications

Mandatory, not optional, given the FAQ's renewal-warning commitments:

| When | Channel | Content |
|---|---|---|
| Trial start | Email + in-app | End date, exact charge amount and date, cancel link |
| Day 5 (48h out) | Email | Same, plus one-click cancel |
| Day 7, on charge | Email | Receipt, or a clear failure notice |
| On cancel | Email | Confirms access continues until the end date |

The 48h warning is the one that prevents chargebacks. It is also legally
expected in the EU for auto-renewing subscriptions.

### 6.6 UI surfaces

- Trial CTA on any locked Premium feature: `Start 7 day trial` alongside
  `Upgrade`. Shown only if eligible; hidden entirely if not, never shown disabled
  with an explanation.
- Persistent trial banner while `status = 'trialing'`, showing days remaining and
  a cancel link. Not dismissible in the last 48 hours.
- Account page shows trial state prominently in both Overview and Subscription.

Copy per `CLAUDE.md`: `Start 7 day trial`, `4 days left`, `Cancel trial`. No
subtitles explaining what a trial is.

---

## 7. Build order

Strict dependency order. Items within a step are parallelisable.

| Step | Work | Blocks |
|---|---|---|
| 1 | Migrations 0002/0003, `shared/entitlements/*`, `resolve.test.js` | Everything |
| 2 | Service-role client, `loadEntitlements`, extend `whoami()`, UUID-based admin (fixes 0.3) | 3, 4, 5 |
| 3 | `enforce.js`, `consume_quota` SQL fn, replace `MAX_DEMOS_PER_USER` and `MAX_MEMBERS` | 6 |
| 4 | Admin API + panel, impersonation, grants, audit log | Makes 6-9 testable |
| 5 | Client `EntitlementManager`, `upgradeGate.js`, route guards | 6 |
| 6 | Gate every capability across demos, stats, analytics, teams, aim | 8 |
| 7 | Billing stubs, webhook route with raw-body handling | 9 |
| 8 | My Account page, export, deletion, retention picker | — |
| 9 | Trial: eligibility, start, sweep, notifications, banners | — |
| 10 | Google-only auth: username picker, migration prompt, delete password paths | — |

Step 4 before step 6 is deliberate. Without the ability to grant yourself any
tier on demand, testing 30-odd gated capabilities across four tiers means
manually editing rows for every single check.

Step 10 last, because it is the only step that can lock people out, and it should
land when everything else is stable.

---

## 8. Testing

Add to the `npm test` chain in `package.json` (currently a flat list of
`node *.test.js` invocations, so new files just get appended):

```
shared/entitlements/resolve.test.js     resolution order, rank merging, expiry
server/entitlements/enforce.test.js     limits, quota atomicity, 402 shape
server/entitlements/quota.test.js       rolling window boundaries, DST, clock skew
server/admin/impersonation.test.js      ticket verify, actor mismatch, admin-target refusal
server/billing/webhook.test.js          raw body, signature stub, idempotency
```

Specific cases that must be covered because they are where this class of system
usually breaks:

- User with own Premium + Elite seat resolves to Elite, not Premium.
- Grant with `mode: 'upgrade'` below current tier is ignored.
- Grant with `mode: 'override'` below current tier applies.
- Expired grant stops applying without a sweep having run (resolution is
  time-aware at read, not dependent on a job).
- Quota at exactly the limit, and two concurrent requests at limit minus one.
- Seat released then reassigned within the cooldown.
- Impersonation ticket from admin A used with admin B's bearer token: rejected.
- Impersonation of an admin: rejected.
- Non-GET while impersonating read-only: 403.
- Trial expiry with billing unconfigured: expires, does not become active.
- Anon-key select against `admin_user_overview`: denied.

Manual verification: build with `npm run build` before committing (per the
project's hosted setup, there is no local server to check against), and keep
`vercel.json` rewrites in sync with any new `ROUTES` entry. `/account` and
`/admin` both need entries in both places.

---

## 9. Open decisions

These are product calls that change the build. Worth settling before step 1.

1. **Quota model.** Eight independent daily counters as specified, or one shared
   daily pool? The shared pool removes roughly a third of Phase 1's quota work
   and most of the associated support surface.
2. **Impersonation disclosure.** Does the user see that an admin viewed their
   account? Easier to include now than to add later.
3. **Elite seat shape.** 14 seats pooled across two teams, or 7 per team fixed?
   Changes whether `team.seat_capacity` is subscription-scoped or team-scoped.
4. **Seat cooldown.** The FAQ says 5 substitutions per week. Is a released seat
   also locked for a period, or is the weekly cap the only control?
5. **Trial requires a payment method?** Without one, abuse is trivial once
   accounts are free and Google-only. With one, conversion drops but the trial
   actually converts.
6. **Downgrade retention.** 90 days is committed in the FAQ. Confirm it applies
   to demo *bytes* as well as metadata, since that is the expensive one.
7. **Email/password sunset window.** 30 days minimum, but the actual date drives
   the Phase 10 schedule.
