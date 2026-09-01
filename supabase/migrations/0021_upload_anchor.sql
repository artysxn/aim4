-- ===========================================================================
-- 0021_upload_anchor.sql
-- Vouching for an account that has no Google and no Steam behind it.
--
-- Writing demos into the shared library requires one real identity per account
-- (0010): a Google identity, or a verified Steam link. That rule exists
-- because username registration is free and instant, and free registration
-- plus upload rights is an invitation to fill the store anonymously.
--
-- It also blocks two accounts that are not anonymous at all: a test account,
-- and a seat for someone who cannot use either provider. Both were already
-- contemplated by scripts/create-account.mjs, and neither had any way to
-- upload short of being made a site admin, which hands over the whole panel.
--
-- This column is that way. It is deliberately NOT a plan, a tier or a
-- capability: it answers "is somebody accountable for these bytes", which is a
-- different question from "what has this account paid for". Folding it into
-- the entitlement ladder would mean a future pricing change could hand out
-- upload rights to strangers as a side effect.
--
-- Written only through the service role, exactly like steam_id. `anon` and
-- `authenticated` hold select on public.profiles and nothing else, so the
-- browser cannot set its own flag even though the "update own profile" policy
-- would otherwise allow the row. If a blanket update grant is ever added to
-- profiles, this column and steam_id both need a column-level restriction.
-- ===========================================================================

alter table public.profiles
  add column if not exists upload_anchored boolean not null default false;

comment on column public.profiles.upload_anchored is
  'Server-set only: this account may upload demos with no Google or Steam link.';

-- Small and highly selective: almost every row is false, and the only reader
-- is a per-account lookup that already fetches steam_id from the same row.
create index if not exists profiles_upload_anchored_idx
  on public.profiles (id) where upload_anchored;
