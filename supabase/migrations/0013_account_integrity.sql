-- ===========================================================================
-- 0013_account_integrity.sql
-- Account-sharing detection: login events, offenses, probation.
--
-- A solo subscription is personal. The tell for a shared one is not "the IP
-- changed" — VPNs and travel do that — it is the same *kind* of device with a
-- *different* device id signing in from a *different country* within hours of
-- the last session. One person moves between their own devices (a PC and a
-- phone); two people share the same kind of device in two countries.
--
-- The server records one login_events row per (device, ip) transition and
-- compares each new row against the previous one. A match on all three
-- conditions inside a six-hour window is an offense: the first shows a warning
-- with a 60 second cooldown, the second puts the account on probation, which
-- resolves it to the Free tier until an admin lifts it. The flag itself is
-- written to integrity_flags so both the user and an admin can see exactly
-- which two sessions tripped it.
--
-- All three tables/columns are written only by the server through the service
-- role. RLS is enabled with no policies, the admin_audit_log pattern.
-- ===========================================================================

create table if not exists public.login_events (
  id            bigserial primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  ip            inet,
  country       text,          -- ISO 3166-1 alpha-2; null when unresolvable
  device_id     text,          -- client-persisted device token
  device_type   text,          -- server-classified from the user agent
  user_agent    text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index if not exists login_events_user_idx
  on public.login_events (user_id, last_seen_at desc);

-- One row per offense, carrying both sides of the transition that fired it.
-- Denormalised into payload on purpose: the probation notice and the admin
-- panel both need "Russia on an iPhone, then Japan on an iPhone" without
-- joining login_events rows that may since have been pruned.
create table if not exists public.integrity_flags (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  offense_no  int  not null,
  payload     jsonb,           -- { prev: {country,deviceType,ip,at}, next: {...} }
  created_at  timestamptz not null default now()
);

create index if not exists integrity_flags_user_idx
  on public.integrity_flags (user_id, created_at desc);

alter table public.profiles
  add column if not exists integrity_offenses int not null default 0;
alter table public.profiles
  add column if not exists integrity_warning_at timestamptz;   -- pending first-offense warning
alter table public.profiles
  add column if not exists probation_at timestamptz;           -- null = not on probation

alter table public.login_events    enable row level security;
alter table public.integrity_flags enable row level security;
-- Deliberately no policies: the browser never reads these tables. The user
-- sees their own state through /api/me, which serves it via the service role.

-- ---------------------------------------------------------------------------
-- admin_user_overview learns about probation, so the users list can paint
-- flagged accounts red without a second query. Views cannot be altered in
-- place; recreate with the 0009 shape plus the two integrity columns.
-- ---------------------------------------------------------------------------
drop view if exists public.admin_user_overview;

create view public.admin_user_overview as
select
  u.id,
  u.email,
  u.created_at,
  u.last_sign_in_at,
  u.raw_app_meta_data -> 'providers' as providers,
  p.username,
  p.country_code,
  p.elo,
  p.effective_tier,
  p.effective_capabilities,
  p.probation_at,
  p.integrity_offenses,
  s.status              as subscription_status,
  s.plan_id,
  s.term,
  s.current_period_end,
  s.trial_ends_at,
  s.source              as subscription_source,
  s.cancel_at_period_end,
  (select count(*) from public.subscription_seats ss
    where ss.user_id = u.id and ss.released_at is null) as seats_held,
  exists (select 1 from public.site_admins sa where sa.user_id = u.id) as is_admin
from auth.users u
left join public.profiles p on p.id = u.id
left join public.subscriptions s
  on s.user_id = u.id and s.status in ('trialing', 'active', 'past_due');

revoke all on public.admin_user_overview from public, anon, authenticated;
grant select on public.admin_user_overview to service_role;
