-- ===========================================================================
-- 0006_account_data.sql
-- Retention, deletion and export state.
--
-- The pricing FAQ already promises users that on downgrade their over-cap
-- content is kept but inaccessible for 90 days and then deleted, and that they
-- can export it during that window. Nothing implemented either, so the promise
-- was load-bearing on code that did not exist.
-- ===========================================================================

-- When a paid plan lapsed. Starts the 90 day retention clock.
alter table public.subscriptions
  add column if not exists lapsed_at timestamptz;

create index if not exists subscriptions_lapsed_idx
  on public.subscriptions (lapsed_at)
  where lapsed_at is not null;

-- Deletion is a request with a grace period, not an immediate drop: an account
-- deleted by a moment of frustration is the single most common support reversal.
alter table public.profiles
  add column if not exists deletion_requested_at timestamptz;

create index if not exists profiles_deletion_requested_idx
  on public.profiles (deletion_requested_at)
  where deletion_requested_at is not null;

-- ---------------------------------------------------------------------------
-- Over-cap content is locked rather than deleted when a plan lapses. The user
-- picks which N to keep before they may create or edit again.
-- ---------------------------------------------------------------------------
alter table public.replays
  add column if not exists locked_at timestamptz;

create index if not exists replays_locked_idx
  on public.replays (user_id) where locked_at is not null;

-- ---------------------------------------------------------------------------
-- Export jobs. The row is the receipt: it records that the user asked, what
-- was produced, and when the download expires.
-- ---------------------------------------------------------------------------
create table if not exists public.account_exports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending',  -- pending | ready | failed | expired
  token        text unique,
  path         text,
  size_bytes   bigint,
  error        text,
  requested_at timestamptz not null default now(),
  ready_at     timestamptz,
  expires_at   timestamptz,
  constraint account_exports_status_check
    check (status in ('pending','ready','failed','expired'))
);

create index if not exists account_exports_user_idx
  on public.account_exports (user_id, requested_at desc);

alter table public.account_exports enable row level security;

drop policy if exists "read own exports" on public.account_exports;
create policy "read own exports" on public.account_exports
  for select using (auth.uid() = user_id);
