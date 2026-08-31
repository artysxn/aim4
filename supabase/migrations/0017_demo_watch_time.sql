-- ===========================================================================
-- 0017_demo_watch_time.sql
-- Seconds spent with a demo on screen, per account per day.
--
-- The activity calendar's demo half already knew when someone PLAYED a match.
-- This is the other half of engaging with a demo: time inside the Timeline
-- viewer and the Analyzer, which is where review actually happens and which
-- nothing measured before.
--
-- One row per account per day, upserted. Days rather than sessions because a
-- day is the only granularity the calendar draws, and storing every session
-- would be a table that grows with playtime to answer a question nobody asks.
--
-- Publicly readable, like `scores`: the calendar is public per account, and a
-- daily second-count is strictly less revealing than the per-match rows the
-- Database already shows to everybody.
-- ===========================================================================

create table if not exists public.demo_watch_time (
  user_id uuid not null references auth.users on delete cascade,
  -- Local calendar day, as the browser saw it. Deliberately not a timestamp:
  -- a player's day is theirs, and re-bucketing UTC into local time on read
  -- would move sessions across midnight for anyone west of Greenwich.
  day date not null,
  seconds integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day),
  constraint demo_watch_time_seconds_check check (seconds >= 0 and seconds <= 86400)
);

create index if not exists demo_watch_time_user_idx
  on public.demo_watch_time (user_id, day desc);

alter table public.demo_watch_time enable row level security;

drop policy if exists "read demo watch time" on public.demo_watch_time;
drop policy if exists "write own demo watch time" on public.demo_watch_time;

create policy "read demo watch time" on public.demo_watch_time
  for select to anon, authenticated using (true);
create policy "write own demo watch time" on public.demo_watch_time
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select on public.demo_watch_time to anon, authenticated;
grant insert, update on public.demo_watch_time to authenticated;

-- The browser owns the running total (it works signed out and offline), so a
-- flush is "this is the day's total", not "add this much". GREATEST keeps a
-- stale flush from a second tab, or a replayed one, from walking the number
-- backwards.
create or replace function public.set_demo_watch_time(p_day date, p_seconds integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.demo_watch_time (user_id, day, seconds)
  values (auth.uid(), p_day, least(greatest(p_seconds, 0), 86400))
  on conflict (user_id, day) do update
    set seconds = greatest(public.demo_watch_time.seconds, excluded.seconds),
        updated_at = now();
end;
$$;

grant execute on function public.set_demo_watch_time(date, integer) to authenticated;

comment on table public.demo_watch_time is
  'Seconds with a demo on screen (Timeline or Analyzer), per account per day. '
  'Feeds the activity calendar.';
