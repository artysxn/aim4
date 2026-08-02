-- ===========================================================================
-- 0005_effective_entitlements.sql
-- Denormalised entitlements on profiles, plus the admin overview.
--
-- Some capabilities have to be enforced in RLS rather than in Node, because the
-- rows they guard (aim_run_stats, replays, routines) are read straight from
-- Postgres by the browser. Writing a SQL function that re-implements
-- resolve.js would give two copies of the merge logic and guarantee they drift.
--
-- Instead the server writes its answer down. recomputeUser() in
-- server/entitlements/recompute.js is the only writer of these columns, and RLS
-- policies just read them. One writer, one truth.
-- ===========================================================================

alter table public.profiles
  add column if not exists effective_tier text not null default 'free';

alter table public.profiles
  add column if not exists effective_capabilities jsonb not null default '{}'::jsonb;

alter table public.profiles
  add column if not exists entitlements_updated_at timestamptz;

create index if not exists profiles_effective_tier_idx on public.profiles (effective_tier);

-- ---------------------------------------------------------------------------
-- has_capability: the RLS-side read.
--
-- Reads the denormalised column, so seats and grants are honoured without this
-- function knowing anything about them. Admins short-circuit to true.
-- ---------------------------------------------------------------------------
create or replace function public.has_capability(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (p.effective_capabilities -> p_key) is not null
        and (p.effective_capabilities ->> p_key) not in ('false', '0', 'none', 'null')
       from public.profiles p
      where p.id = auth.uid()),
    false
  ) or public.is_site_admin();
$$;

revoke all on function public.has_capability(text) from public;
grant execute on function public.has_capability(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- capability_value: for enum and limit capabilities where "is it on" is not
-- enough, e.g. aim.replays being none / best_and_recent / best_plus_10 / full.
-- ---------------------------------------------------------------------------
create or replace function public.capability_value(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.effective_capabilities -> p_key
       from public.profiles p
      where p.id = auth.uid()),
    'null'::jsonb
  );
$$;

revoke all on function public.capability_value(text) from public;
grant execute on function public.capability_value(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- admin_user_overview
--
-- Joins auth.users, so it must never be reachable with the anon key. Views run
-- with the privileges of their owner, which is exactly the exposure to avoid
-- here, so it is created with security_invoker on: a caller who is not allowed
-- to read auth.users gets nothing, rather than getting everyone's email.
-- ---------------------------------------------------------------------------
drop view if exists public.admin_user_overview;

create view public.admin_user_overview
with (security_invoker = true)
as
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
