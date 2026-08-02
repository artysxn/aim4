-- ===========================================================================
-- 0002_entitlements.sql
-- Plans, subscriptions, seats, grants, quota counters, admins, audit log.
--
-- supabase/schema.sql stays the canonical consolidated schema. Numbered
-- migrations start here so a production change is replayable rather than a
-- diff someone has to eyeball. Safe to re-run.
--
-- Read alongside shared/entitlements/catalogue.js: the `capabilities` jsonb on
-- plans is *derived* from that file by scripts/sync-plan-capabilities.mjs and
-- must never be hand-edited.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Plans: the catalogue. Rows here are product definitions, not user state.
-- ---------------------------------------------------------------------------
create table if not exists public.plans (
  id                  text primary key,           -- free | premium | team_premium | team_elite
  name                text not null,
  rank                int  not null,              -- 0 | 10 | 20 | 30, used by resolve()
  seat_capacity       int  not null default 0,    -- seats this plan may lend out
  team_capacity       int  not null default 0,    -- teams this plan may create
  capabilities        jsonb not null default '{}'::jsonb,
  -- Billing hole. Null until a provider is wired up; the pricing page reads
  -- these so the marketing copy and the enforcement share one source.
  price_month_cents   int,
  price_quarter_cents int,
  price_year_cents    int,
  billing_provider    text,                       -- 'stripe' | 'paddle' | null
  provider_price_ids  jsonb not null default '{}'::jsonb,
  is_public           bool not null default true, -- false hides it from pricing
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Subscriptions: one row per paying account. Free users have no row.
-- Rows are never deleted; trial eligibility is derived from their existence.
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  plan_id              text not null references public.plans(id),
  status               text not null,   -- trialing | active | past_due | cancelled | expired
  term                 text not null,   -- month | quarter | year | lifetime
  current_period_start timestamptz not null default now(),
  current_period_end   timestamptz,     -- null = never expires (admin / lifetime)
  cancel_at_period_end bool not null default false,
  -- Trial
  trial_started_at     timestamptz,
  trial_ends_at        timestamptz,
  -- Billing hole
  provider                 text,
  provider_customer_id     text,
  provider_subscription_id text,
  provider_status          text,
  -- Provenance: how this subscription came to exist
  source               text not null default 'admin', -- admin | trial | billing | migration
  granted_by           uuid references auth.users(id),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint subscriptions_status_check
    check (status in ('trialing','active','past_due','cancelled','expired')),
  constraint subscriptions_term_check
    check (term in ('month','quarter','year','lifetime')),
  constraint subscriptions_source_check
    check (source in ('admin','trial','billing','migration'))
);

-- One live subscription per account. Lapsed rows stay for history and for
-- trial eligibility, so the index is partial rather than a plain unique.
create unique index if not exists subscriptions_one_active_per_user
  on public.subscriptions (user_id)
  where status in ('trialing', 'active', 'past_due');

create index if not exists subscriptions_period_end_idx
  on public.subscriptions (current_period_end)
  where status in ('trialing', 'active');

create index if not exists subscriptions_trial_end_idx
  on public.subscriptions (trial_ends_at)
  where status = 'trialing';

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Seats: a subscription lends its capabilities to other accounts.
-- Capacity is per *subscription*, not per team, so Team Elite's 14 seats are
-- pooled across the 2 teams it may create rather than fixed at 7 each.
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_seats (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  user_id         uuid references auth.users(id) on delete set null, -- null = empty seat
  team_id         text,                    -- mirrors the id in teams.json
  assigned_at     timestamptz,
  released_at     timestamptz,             -- kept after removal, for the cooldown
  created_at      timestamptz not null default now()
);

create unique index if not exists subscription_seats_one_per_user_per_sub
  on public.subscription_seats (subscription_id, user_id)
  where user_id is not null and released_at is null;

create index if not exists subscription_seats_user_idx
  on public.subscription_seats (user_id) where released_at is null;

create index if not exists subscription_seats_sub_idx
  on public.subscription_seats (subscription_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- Admin grants: manual, optionally time-boxed capability awards.
-- A grant is either a whole tier (plan_id) or one capability, and carries an
-- explicit mode so it can deliberately move a user *down* for testing.
-- ---------------------------------------------------------------------------
create table if not exists public.entitlement_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  plan_id     text references public.plans(id),
  capability  text,
  value       jsonb,
  mode        text not null default 'upgrade',   -- upgrade | override
  starts_at   timestamptz not null default now(),
  expires_at  timestamptz,                       -- null = forever
  reason      text,
  granted_by  uuid not null references auth.users(id),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint grant_has_target check (plan_id is not null or capability is not null),
  constraint grant_mode_check check (mode in ('upgrade','override'))
);

create index if not exists entitlement_grants_user_idx
  on public.entitlement_grants (user_id) where revoked_at is null;

create index if not exists entitlement_grants_expiry_idx
  on public.entitlement_grants (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Quota counters. One row per user per capability per window.
-- `capability` is a plain string, so collapsing the eight independent counters
-- into one shared daily pool later is a different value here, not a migration.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_counters (
  user_id      uuid not null references auth.users(id) on delete cascade,
  capability   text not null,
  window_start timestamptz not null,
  used         int  not null default 0,
  primary key (user_id, capability, window_start)
);

create index if not exists usage_counters_window_idx
  on public.usage_counters (window_start);

-- ---------------------------------------------------------------------------
-- Admins. UUID-keyed, never username-keyed.
--
-- The previous design read a comma-separated list of *usernames* from the
-- environment, while any signed-in user could rename themselves to any
-- unclaimed username. Anyone could therefore claim an admin name that was not
-- currently registered and inherit site admin. auth.users.id is immutable and
-- cannot be claimed.
-- ---------------------------------------------------------------------------
create table if not exists public.site_admins (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  label           text,                    -- display only
  can_impersonate bool not null default true,
  can_grant       bool not null default true,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log. Every admin action, every impersonation, every grant.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          bigserial primary key,
  actor_id    uuid not null references auth.users(id),
  action      text not null,             -- 'impersonate.start', 'grant.create', ...
  target_user uuid references auth.users(id),
  payload     jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_actor_idx
  on public.admin_audit_log (actor_id, created_at desc);
create index if not exists admin_audit_target_idx
  on public.admin_audit_log (target_user, created_at desc);
create index if not exists admin_audit_action_idx
  on public.admin_audit_log (action, created_at desc);

-- ===========================================================================
-- Admin predicate
--
-- A policy on site_admins that selects from site_admins recurses, and Postgres
-- rejects it at query time with "infinite recursion detected in policy". A
-- security definer function owned by the table owner is exempt from RLS, which
-- breaks the cycle. search_path is pinned so the body cannot be redirected at
-- a shadowed table by a caller-controlled search_path.
-- ===========================================================================
create or replace function public.is_site_admin(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.site_admins sa where sa.user_id = p_user);
$$;

revoke all on function public.is_site_admin(uuid) from public;
grant execute on function public.is_site_admin(uuid) to authenticated, anon, service_role;

-- ===========================================================================
-- Row level security
--
-- Reads are scoped to the caller. There are deliberately no INSERT, UPDATE or
-- DELETE policies on any table here: every mutation goes through the Node
-- server holding SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so that all
-- entitlement writes pass one audited chokepoint. Adding a write policy later
-- would quietly reopen that.
-- ===========================================================================
alter table public.plans              enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.subscription_seats enable row level security;
alter table public.entitlement_grants enable row level security;
alter table public.usage_counters     enable row level security;
alter table public.site_admins        enable row level security;
alter table public.admin_audit_log    enable row level security;

drop policy if exists "read plans" on public.plans;
create policy "read plans" on public.plans
  for select using (true);

drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "read own seat" on public.subscription_seats;
create policy "read own seat" on public.subscription_seats
  for select using (auth.uid() = user_id);

drop policy if exists "read own grants" on public.entitlement_grants;
create policy "read own grants" on public.entitlement_grants
  for select using (auth.uid() = user_id);

drop policy if exists "read own counters" on public.usage_counters;
create policy "read own counters" on public.usage_counters
  for select using (auth.uid() = user_id);

-- Readable only by admins, so the table cannot be used to enumerate who to
-- phish or target.
drop policy if exists "admins read admins" on public.site_admins;
create policy "admins read admins" on public.site_admins
  for select using (public.is_site_admin());

-- admin_audit_log gets no policies at all. Service role only.
