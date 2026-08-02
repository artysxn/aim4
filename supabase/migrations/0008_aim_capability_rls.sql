-- ===========================================================================
-- 0008_aim_capability_rls.sql
-- The capabilities the browser reads straight from Postgres.
--
-- aim_run_stats, replays and routines are fetched by the client with the anon
-- key, so the Node server never sees those requests and cannot gate them. RLS
-- is the only enforcement surface that exists for them.
--
-- Every policy reads profiles.effective_capabilities, written by
-- recomputeUser(). Nothing here re-implements resolve.js, which is the point:
-- two copies of the merge logic would drift, and the SQL copy would be the one
-- nobody noticed was wrong.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- aim.advanced_analytics: the detailed per-run breakdown.
--
-- Own rows stay readable on every tier. A free account can always see its own
-- scores; what the capability gates is reading the detailed stats of others,
-- which is what the analytics view is for.
-- ---------------------------------------------------------------------------
drop policy if exists "read all aim stats" on public.aim_run_stats;

create policy "read own aim stats" on public.aim_run_stats
  for select using (auth.uid() = user_id);

create policy "read others aim stats with analytics" on public.aim_run_stats
  for select using (public.has_capability('aim.advanced_analytics'));

-- ---------------------------------------------------------------------------
-- aim.replays: none | best_and_recent | best_plus_10 | full
--
-- The enum decides how much history is readable, so the policy compares
-- against the stored value rather than asking "is it on".
-- ---------------------------------------------------------------------------
drop policy if exists "read all replays" on public.replays;

create policy "read own replays" on public.replays
  for select using (auth.uid() = user_id);

create policy "read replays by tier" on public.replays
  for select using (
    coalesce(public.capability_value('aim.replays') #>> '{}', 'none') <> 'none'
  );

-- ---------------------------------------------------------------------------
-- aim.custom_routines
--
-- The table does not exist yet: routines are still a "coming soon" page. The
-- guard is written now so that when the table lands it is created gated rather
-- than created open and gated later, which is the ordering that leaks.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.aim_routines') is not null then
    execute 'alter table public.aim_routines enable row level security';

    execute 'drop policy if exists "read own routines" on public.aim_routines';
    execute $p$
      create policy "read own routines" on public.aim_routines
        for select using (auth.uid() = user_id)
    $p$;

    execute 'drop policy if exists "create routines by tier" on public.aim_routines';
    execute $p$
      create policy "create routines by tier" on public.aim_routines
        for insert with check (
          auth.uid() = user_id
          and public.has_capability('aim.custom_routines')
        )
    $p$;

    execute 'drop policy if exists "update own routines" on public.aim_routines';
    execute $p$
      create policy "update own routines" on public.aim_routines
        for update using (auth.uid() = user_id)
    $p$;

    execute 'drop policy if exists "delete own routines" on public.aim_routines';
    execute $p$
      create policy "delete own routines" on public.aim_routines
        for delete using (auth.uid() = user_id)
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The per-account cap on custom routines cannot be expressed in a WITH CHECK
-- clause without counting, so it is a trigger. Free is 0, Premium 3, Team 10,
-- Elite unlimited (-1).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_routine_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit int;
  v_count int;
begin
  select coalesce((p.effective_capabilities ->> 'aim.custom_routines')::int, 0)
    into v_limit
    from public.profiles p
   where p.id = new.user_id;

  if public.is_site_admin(new.user_id) or v_limit = -1 then
    return new;
  end if;

  select count(*) into v_count from public.aim_routines r where r.user_id = new.user_id;

  if v_count >= coalesce(v_limit, 0) then
    raise exception 'routine_limit_reached'
      using hint = 'Upgrade for more custom routines.';
  end if;
  return new;
end $$;

do $$
begin
  if to_regclass('public.aim_routines') is not null then
    execute 'drop trigger if exists enforce_routine_limit on public.aim_routines';
    execute $p$
      create trigger enforce_routine_limit
        before insert on public.aim_routines
        for each row execute function public.enforce_routine_limit()
    $p$;
  end if;
end $$;
