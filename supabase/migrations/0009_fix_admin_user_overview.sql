-- ===========================================================================
-- 0009_fix_admin_user_overview.sql
-- admin_user_overview was created with security_invoker=true so it ran as the
-- PostgREST caller. service_role cannot SELECT auth.users that way, which made
-- /api/admin/users fail with "permission denied for table users".
--
-- Recreate it as a normal (owner) view and keep SELECT granted only to
-- service_role. Anon and authenticated still cannot read emails through this view.
-- ===========================================================================

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
