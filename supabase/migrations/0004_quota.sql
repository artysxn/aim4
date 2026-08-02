-- ===========================================================================
-- 0004_quota.sql
-- Atomic quota consumption, and the sweep that keeps the counter table small.
--
-- Windows roll from first use: window_start is the moment of the first use in
-- the current window, and the window is open while now() < window_start +
-- p_window_seconds. Switching to a fixed daily reset later means passing a
-- truncated timestamp; nothing else changes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- consume_quota
--
-- Returns one row: whether the use was allowed, and enough state to render
-- "2 left today, resets at 14:22" without a second query.
--
-- Two things this has to get right, both of which a naive INSERT ... ON
-- CONFLICT gets wrong:
--
--  1. Concurrency. With a rolling window there is no fixed key to collide on,
--     so two requests arriving with no open window would each insert their own
--     row and both pass a limit of 1. A transaction-scoped advisory lock keyed
--     on (user, capability) serialises them.
--  2. Naming. `used` and `window_start` as OUT parameters shadow the columns of
--     the same name inside the function body, so the OUT parameters here are
--     named distinctly rather than relying on qualification everywhere.
-- ---------------------------------------------------------------------------
create or replace function public.consume_quota(
  p_user_id        uuid,
  p_capability     text,
  p_limit          int,
  p_window_seconds int default 86400
)
returns table (
  allowed          boolean,
  used_count       int,
  limit_value      int,
  window_started_at timestamptz,
  resets_at        timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := now();
  v_cutoff timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_row    public.usage_counters%rowtype;
begin
  -- Unlimited. Never write a counter row: the overwhelming majority of calls
  -- are from paid tiers, and metering them would make this table the busiest
  -- one in the database for no benefit.
  if p_limit < 0 then
    allowed := true; used_count := 0; limit_value := p_limit;
    window_started_at := null; resets_at := null;
    return next;
    return;
  end if;

  -- Not available on this tier at all.
  if p_limit = 0 then
    allowed := false; used_count := 0; limit_value := 0;
    window_started_at := null; resets_at := null;
    return next;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || p_capability, 0)
  );

  select * into v_row
    from public.usage_counters uc
   where uc.user_id = p_user_id
     and uc.capability = p_capability
     and uc.window_start > v_cutoff
   order by uc.window_start desc
   limit 1;

  if not found then
    insert into public.usage_counters (user_id, capability, window_start, used)
    values (p_user_id, p_capability, v_now, 1)
    returning * into v_row;
    allowed := true;
  elsif v_row.used < p_limit then
    update public.usage_counters uc
       set used = uc.used + 1
     where uc.user_id = v_row.user_id
       and uc.capability = v_row.capability
       and uc.window_start = v_row.window_start
    returning * into v_row;
    allowed := true;
  else
    allowed := false;
  end if;

  used_count := v_row.used;
  limit_value := p_limit;
  window_started_at := v_row.window_start;
  resets_at := v_row.window_start + make_interval(secs => p_window_seconds);
  return next;
end $$;

-- Service role only. A client that could call this directly could burn another
-- account's quota, and the limit is an argument, so it could also grant itself
-- an unlimited one.
revoke all on function public.consume_quota(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.consume_quota(uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- peek_quota: read the open window without consuming. For UI payloads.
-- ---------------------------------------------------------------------------
create or replace function public.peek_quota(
  p_user_id        uuid,
  p_capability     text,
  p_window_seconds int default 86400
)
returns table (
  used_count       int,
  window_started_at timestamptz,
  resets_at        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select uc.used,
         uc.window_start,
         uc.window_start + make_interval(secs => p_window_seconds)
    from public.usage_counters uc
   where uc.user_id = p_user_id
     and uc.capability = p_capability
     and uc.window_start > now() - make_interval(secs => p_window_seconds)
   order by uc.window_start desc
   limit 1;
$$;

revoke all on function public.peek_quota(uuid, text, int) from public, anon, authenticated;
grant execute on function public.peek_quota(uuid, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- sweep_usage_counters: drop rows whose window closed long ago.
--
-- 48h rather than 24h so a window that opened just before the sweep ran is
-- still readable for the whole of its life plus a margin.
-- ---------------------------------------------------------------------------
create or replace function public.sweep_usage_counters(p_older_than_hours int default 48)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from public.usage_counters uc
   where uc.window_start < now() - make_interval(hours => p_older_than_hours);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.sweep_usage_counters(int) from public, anon, authenticated;
grant execute on function public.sweep_usage_counters(int) to service_role;
