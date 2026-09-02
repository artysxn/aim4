-- ===========================================================================
-- 0022_account_language.sql
-- Which language the site speaks to this account in.
--
-- The site is being translated into eleven more languages, and the choice has
-- to live somewhere. There were three candidates and only one of them is a
-- property of the person rather than of the machine they happen to be sitting
-- at:
--
--   * A URL prefix or ?lang=. Shareable, and the pitch deck already does it,
--     but it makes every link carry a language and every internal navigation
--     responsible for preserving it. Deliberately not done here.
--   * user_settings.settings, the jsonb blob AuthManager already syncs. Free,
--     but that blob is written by the browser under RLS and never read by the
--     server, and the server needs this the moment it starts writing prose
--     into notifications.
--   * A column on profiles. One more column, read on the /api/me round trip
--     that already selects username and display_name, so it costs nothing to
--     serve and the server can see it.
--
-- localStorage still holds a copy, because /api/me is a round trip and the
-- fonts depend on the answer: PP Mori has no Cyrillic and no CJK, so a page
-- that guesses wrong repaints in a different typeface. The column is the truth
-- and the mirror is the guess.
--
-- Unlike steam_id and upload_anchored (0010, 0021), this column is the user's
-- own to set. It is written through POST /api/account/language rather than
-- from the browser directly, so the value is checked once, server side, and
-- the constraint below is a second net under that.
--
-- Safe to re-run.
-- ===========================================================================

alter table public.profiles
  add column if not exists language text not null default 'en';

comment on column public.profiles.language is
  'Interface language id. Matches LANG_IDS in src/i18n/langs.js.';

-- The ids are the site's own, not BCP 47 tags: Norwegian is `no` and Chinese
-- is `zh` here, and src/i18n/langs.js maps each to the fuller tag that Intl
-- wants. They match the set shared/comms/format.js already uses for voice
-- transcription, so one account does not have its comms language spelled one
-- way and its interface language another.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_language_known'
  ) then
    alter table public.profiles
      add constraint profiles_language_known
      check (language in ('en','ru','zh','pt','es','fr','pl','ja','sv','da','no','fi'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- admin_user_overview enumerates its columns, so it does not learn about a new
-- one on its own. Recreated with the 0013 shape plus language, which lets the
-- users list answer "who is actually reading this in Portuguese" without a
-- second query. Views cannot be altered in place.
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
  p.language,
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
