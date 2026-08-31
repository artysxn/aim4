-- ---------------------------------------------------------------------------
-- 0020_aim_category_leaderboards.sql
-- A leaderboard per aiming category, not one board for the average of them.
--
-- The overall Aim rating is the mean of seven categories, and a mean hides
-- exactly the thing a player wants from a board: whether anyone is actually
-- better than them at TRACKING. Two players on the same overall rating can be
-- opposites, and the single board says they are equal.
--
-- The client already computes all seven per run (calculateAim4Ratings) and
-- throws six of them away, keeping only the average as run_overall_rating.
-- They are stored per run now, which is the same shape the overall board
-- already reads and needs no second sync path: a run that has been logged is
-- on the board.
--
-- Boards are built the same way the overall one is, so nobody appears on a
-- category board under rules they do not appear on the main board under: best
-- run per gamemode, averaged across gamemodes, and at least three rated
-- gamemodes. Keep the 3 in step with OVERALL_AIM_MIN_MODES in
-- src/lib/aim4Ratings.js.
-- ---------------------------------------------------------------------------

alter table public.aim_run_stats add column if not exists rating_precision real;
alter table public.aim_run_stats add column if not exists rating_speed real;
alter table public.aim_run_stats add column if not exists rating_flicks real;
alter table public.aim_run_stats add column if not exists rating_adjustments real;
alter table public.aim_run_stats add column if not exists rating_reaction real;
alter table public.aim_run_stats add column if not exists rating_tension real;
alter table public.aim_run_stats add column if not exists rating_tracking real;

drop function if exists public.get_aim_category_leaderboard(text, int);
create or replace function public.get_aim_category_leaderboard(
  p_category text,
  p_limit int default 500
)
returns table (
  user_id uuid,
  username text,
  country_code text,
  rating real,
  rated_modes bigint,
  rank bigint
)
language sql
stable
as $$
  with per_run as (
    select
      r.user_id,
      r.scenario,
      case p_category
        when 'precision'   then r.rating_precision
        when 'speed'       then r.rating_speed
        when 'flicks'      then r.rating_flicks
        when 'adjustments' then r.rating_adjustments
        when 'reaction'    then r.rating_reaction
        when 'tension'     then r.rating_tension
        when 'tracking'    then r.rating_tracking
      end as value
    from public.aim_run_stats r
    where r.scenario not in ('duels', 'range', 'deathmatch')
      and r.variant = 'competitive'
  ),
  mode_best as (
    select user_id, scenario, max(value) as best
    from per_run
    where value is not null
    group by user_id, scenario
  ),
  scored as (
    select user_id, avg(best)::real as rating, count(*)::bigint as rated_modes
    from mode_best
    group by user_id
    having count(*) >= 3
  )
  select
    p.id as user_id,
    p.username,
    p.country_code,
    s.rating,
    s.rated_modes,
    rank() over (order by s.rating desc nulls last) as rank
  from scored s
  join public.profiles p on p.id = s.user_id
  order by s.rating desc nulls last
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;
grant execute on function public.get_aim_category_leaderboard(text, int) to anon, authenticated;
