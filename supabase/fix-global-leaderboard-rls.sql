-- Fix: leaderboards only showing the logged-in user's own scores
-- Run in Supabase SQL Editor. Safe to re-run.

-- Remove restrictive SELECT policies if they were added in the dashboard
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "read scores" on public.scores;
drop policy if exists "read own scores" on public.scores;
drop policy if exists "Users can read own scores" on public.scores;
drop policy if exists "scores_select_own" on public.scores;
drop policy if exists "Enable read access for all users" on public.scores;

-- Global read: everyone sees every score + username (required for leaderboards)
create policy "read profiles" on public.profiles
  for select to anon, authenticated using (true);
create policy "read scores" on public.scores
  for select to anon, authenticated using (true);

grant select on public.profiles to anon, authenticated;
grant select on public.scores to anon, authenticated;

-- Leaderboard RPCs run as definer so they work even if RLS is misconfigured
drop function if exists public.get_leaderboard_top(text, text, int);
drop function if exists public.get_leaderboard(text, text, int);

create or replace function public.get_leaderboard(
  p_scenario text,
  p_config_key text,
  p_limit int default 10
)
returns table (
  user_id uuid,
  username text,
  score integer,
  accuracy real,
  crit_ratio real,
  kills integer,
  time_played real,
  kpm real,
  achieved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_scenario = 'gridshot' then
    return query
    select distinct on (s.user_id)
      s.user_id,
      coalesce(p.username, 'player_' || substr(replace(s.user_id::text, '-', ''), 1, 8)),
      s.score,
      s.accuracy,
      s.crit_ratio,
      s.kills,
      s.time_played,
      s.kpm,
      s.created_at as achieved_at
    from public.scores s
    left join public.profiles p on p.id = s.user_id
    where s.scenario = p_scenario
      and s.config_key = p_config_key
    order by
      s.user_id,
      coalesce(s.time_played, 0) desc,
      coalesce(s.kpm, 0) desc,
      coalesce(s.kills, 0) desc,
      coalesce(s.accuracy, 0) desc,
      s.created_at desc;
  else
    return query
    select distinct on (s.user_id)
      s.user_id,
      coalesce(p.username, 'player_' || substr(replace(s.user_id::text, '-', ''), 1, 8)),
      s.score,
      s.accuracy,
      s.crit_ratio,
      s.kills,
      s.time_played,
      s.kpm,
      s.created_at as achieved_at
    from public.scores s
    left join public.profiles p on p.id = s.user_id
    where s.scenario = p_scenario
      and s.config_key = p_config_key
    order by s.user_id, s.score desc, s.created_at desc;
  end if;
end;
$$;

create or replace function public.get_leaderboard_top(
  p_scenario text,
  p_config_key text,
  p_limit int default 10
)
returns table (
  user_id uuid,
  username text,
  score integer,
  accuracy real,
  crit_ratio real,
  kills integer,
  time_played real,
  kpm real,
  achieved_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_scenario = 'gridshot' then
    return query
    select * from (
      select * from public.get_leaderboard(p_scenario, p_config_key, 1000)
    ) ranked
    order by
      coalesce(time_played, 0) desc,
      coalesce(kpm, 0) desc,
      coalesce(kills, 0) desc,
      coalesce(accuracy, 0) desc,
      achieved_at asc
    limit greatest(1, least(p_limit, 50));
  else
    return query
    select * from (
      select * from public.get_leaderboard(p_scenario, p_config_key, 1000)
    ) ranked
    order by score desc, achieved_at asc
    limit greatest(1, least(p_limit, 50));
  end if;
end;
$$;

grant execute on function public.get_leaderboard_top(text, text, int) to anon, authenticated;

drop function if exists public.get_elo_leaderboard_top(int);

create or replace function public.get_elo_leaderboard_top(p_limit int default 50)
returns table (
  user_id uuid,
  username text,
  elo integer,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id as user_id,
    p.username,
    coalesce(p.elo, 1000) as elo,
    p.created_at as joined_at
  from public.profiles p
  order by coalesce(p.elo, 1000) desc, p.created_at asc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.get_elo_leaderboard_top(int) to anon, authenticated;
