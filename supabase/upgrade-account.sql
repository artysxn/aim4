-- AIM4.io — account page + login profile fields (existing Supabase projects)
-- Run as a NEW query in Supabase SQL Editor. Safe to re-run.
--
-- Fixes: "column profiles.country_code does not exist" on sign-in / Google OAuth.
-- Also adds rank RPCs used by My Account statistics (1 / N format).

alter table public.profiles add column if not exists country_code text;

-- Account page: rank + board size for a scenario leaderboard (1 / N).
drop function if exists public.get_scenario_leaderboard_rank(text, text, uuid);

create or replace function public.get_scenario_leaderboard_rank(
  p_scenario text,
  p_config_key text,
  p_user_id uuid
)
returns table (
  rank int,
  total int,
  score integer,
  kills integer,
  accuracy real,
  kpm real,
  time_played real
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_kill_ranked boolean;
begin
  v_kill_ranked := p_scenario in (
    'gridshot', 'stars', 'microflicks', 'pasu', 'spidershot', 'arena', 'duels', 'range', 'deathmatch'
  );

  return query
  with board as (
    select * from public.get_leaderboard(p_scenario, p_config_key, 100000)
  ),
  ordered as (
    select
      b.user_id,
      b.score,
      b.kills,
      b.accuracy,
      b.kpm,
      b.time_played,
      row_number() over (
        order by
          case when v_kill_ranked then coalesce(b.kills, b.score, 0) else b.score end desc,
          case when v_kill_ranked then coalesce(b.accuracy, 0) else 0 end desc,
          b.achieved_at asc
      ) as rn
    from board b
  ),
  totals as (
    select count(*)::int as cnt from ordered
  )
  select
    o.rn::int,
    t.cnt,
    o.score,
    o.kills,
    o.accuracy,
    o.kpm,
    o.time_played
  from totals t
  left join ordered o on o.user_id = p_user_id;
end;
$$;

grant execute on function public.get_scenario_leaderboard_rank(text, text, uuid) to anon, authenticated;

-- Account page: global ranked Elo rank + board size.
drop function if exists public.get_elo_leaderboard_rank(uuid);

create or replace function public.get_elo_leaderboard_rank(p_user_id uuid)
returns table (
  rank int,
  total int,
  elo integer
)
language sql
stable
security definer
set search_path = public
as $$
  with ordered as (
    select
      p.id as user_id,
      coalesce(p.elo, 1000) as elo,
      row_number() over (
        order by coalesce(p.elo, 1000) desc, p.created_at asc
      ) as rn
    from public.profiles p
  ),
  totals as (
    select count(*)::int as cnt from ordered
  )
  select
    o.rn::int,
    t.cnt,
    o.elo
  from totals t
  left join ordered o on o.user_id = p_user_id;
$$;

grant execute on function public.get_elo_leaderboard_rank(uuid) to anon, authenticated;
