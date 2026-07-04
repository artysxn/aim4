-- AIM4.io — Supabase schema (single file; run in SQL Editor)
-- Safe to re-run on new or existing projects.
--
-- Auth setup:
--   • Keep "Confirm email" ON under Auth → Providers → Email.
--   • Add https://aim4.io and http://localhost:5173 to Auth → URL Configuration redirect URLs.

-- ===========================================================================
-- Tables
-- ===========================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  elo integer not null default 1000,
  country_code text, -- ISO 3166-1 alpha-2 (e.g. US, GB) for account flag
  created_at timestamptz default now()
);

create table if not exists public.scores (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  scenario text not null, -- gridshot | stars | microflicks | tracking | pasu | …
                          -- 'playlist' rows store a combined score; config_key is
                          -- a stable hash of the playlist's ordered modes. No
                          -- schema change needed — the score-ranked RPC branch
                          -- (below) already handles any non-kill scenario.
  config_key text not null,
  score integer not null,
  accuracy real,
  crit_ratio real,
  kills integer,
  hits integer,
  shots integer,
  time_played real, -- gridshot: active seconds in mode (excludes pause); not run-duration setting
  kpm real,
  created_at timestamptz default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Replay metadata (payloads live in the `replays` Storage bucket).
-- At most one row per (account, scenario, variant, slot): `last` or `best`.
create table if not exists public.replays (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  scenario text not null,
  config_key text not null,
  variant text not null,                 -- practice | competitive
  slot text not null,                    -- last | best
  score integer,
  accuracy real,
  kills integer,
  duration real,
  tick_rate integer not null default 128,
  byte_size integer,
  replay_file_path text not null,        -- path inside the `replays` bucket
  created_at timestamptz default now(),
  unique (user_id, scenario, variant, slot)
);

-- ===========================================================================
-- Column upgrades (existing deployments)
-- ===========================================================================

alter table public.scores add column if not exists hits integer;
alter table public.scores add column if not exists shots integer;
alter table public.scores add column if not exists time_played real;
alter table public.scores add column if not exists kpm real;
alter table public.profiles add column if not exists elo integer not null default 1000;
alter table public.profiles add column if not exists country_code text;
alter table public.profiles add column if not exists play_time_sec real not null default 0;
alter table public.profiles add column if not exists overall_aim_rating real;

-- Replay aim-analytics aggregates (measured per run; nullable for old rows).
alter table public.replays add column if not exists flicks_accurate integer;
alter table public.replays add column if not exists flicks_over integer;
alter table public.replays add column if not exists flicks_under integer;
alter table public.replays add column if not exists clicks_early integer;
alter table public.replays add column if not exists clicks_accurate integer;
alter table public.replays add column if not exists clicks_late integer;
alter table public.replays add column if not exists click_early_ms real;
alter table public.replays add column if not exists click_late_ms real;
alter table public.replays add column if not exists tension_pct real;
alter table public.replays add column if not exists flick_speed_ms real;
alter table public.replays add column if not exists flick_accuracy_pct real;

-- Raise PostgREST's default 1000-row response cap so full-table leaderboard
-- aggregation (and large account/replay reads) never silently truncates.
alter role authenticator set pgrst.db_max_rows = '100000';
notify pgrst, 'reload config';

-- ===========================================================================
-- Indexes
-- ===========================================================================

create index if not exists scores_scenario_config_score_idx
  on public.scores (scenario, config_key, score desc);
create index if not exists scores_user_id_idx on public.scores (user_id);
create index if not exists replays_user_idx on public.replays (user_id);

-- Permanent shared replays (immutable copies; linked via ?replay=uuid).
create table if not exists public.shared_replays (
  id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  username text not null,
  scenario text not null,
  config_key text not null,
  variant text not null,
  score integer,
  accuracy real,
  kills integer,
  duration real,
  tick_rate integer not null default 128,
  byte_size integer,
  replay_file_path text not null unique,
  settings jsonb not null default '{}',
  created_at timestamptz default now()
);
create index if not exists shared_replays_user_idx on public.shared_replays (user_id);

-- Replay aim-analytics aggregates on shared copies (nullable for old rows).
alter table public.shared_replays add column if not exists flicks_accurate integer;
alter table public.shared_replays add column if not exists flicks_over integer;
alter table public.shared_replays add column if not exists flicks_under integer;
alter table public.shared_replays add column if not exists clicks_early integer;
alter table public.shared_replays add column if not exists clicks_accurate integer;
alter table public.shared_replays add column if not exists clicks_late integer;
alter table public.shared_replays add column if not exists click_early_ms real;
alter table public.shared_replays add column if not exists click_late_ms real;
alter table public.shared_replays add column if not exists tension_pct real;
alter table public.shared_replays add column if not exists flick_speed_ms real;
alter table public.shared_replays add column if not exists flick_accuracy_pct real;

-- Per-run aim analytics log (one row per COMPETITIVE run, never overwritten) so
-- flick speed / accuracy / tension can be compared across players and filtered
-- by recency. Distinct from `replays`, which keeps only last/best slots.
create table if not exists public.aim_run_stats (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  scenario text not null,
  config_key text,
  variant text not null default 'competitive',
  flick_speed_ms real,
  flick_accuracy_pct real,
  flicks_measured integer,
  flicks_accurate integer,
  flicks_over integer,
  flicks_under integer,
  clicks_early integer,
  clicks_accurate integer,
  clicks_late integer,
  click_early_ms real,
  click_late_ms real,
  tension_pct real,
  created_at timestamptz default now()
);

-- Reworked radar stats (added later — migrates existing tables in place).
alter table public.aim_run_stats add column if not exists tracking_pct real;
alter table public.aim_run_stats add column if not exists reaction_ms real;
alter table public.aim_run_stats add column if not exists adjustments_per_target real;
alter table public.aim_run_stats add column if not exists speed_deg_s real;
alter table public.aim_run_stats add column if not exists run_overall_rating real;

create index if not exists aim_run_stats_user_idx on public.aim_run_stats (user_id, created_at desc);
create index if not exists aim_run_stats_scenario_idx on public.aim_run_stats (scenario, created_at desc);

alter table public.aim_run_stats enable row level security;
drop policy if exists "read all aim stats" on public.aim_run_stats;
drop policy if exists "insert own aim stats" on public.aim_run_stats;
create policy "read all aim stats" on public.aim_run_stats
  for select using (true);
create policy "insert own aim stats" on public.aim_run_stats
  for insert with check (auth.uid() = user_id);
drop policy if exists "delete own aim stats" on public.aim_run_stats;
create policy "delete own aim stats" on public.aim_run_stats
  for delete using (auth.uid() = user_id);
grant select on public.aim_run_stats to anon, authenticated;
grant insert, delete on public.aim_run_stats to authenticated;

-- Accumulate total seconds played on a profile (called after each finished run).
drop function if exists public.increment_play_time(uuid, real);
create or replace function public.increment_play_time(p_user_id uuid, p_seconds real)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or p_seconds is null or p_seconds <= 0 then
    return;
  end if;
  update public.profiles
  set play_time_sec = coalesce(play_time_sec, 0) + p_seconds
  where id = p_user_id;
end;
$$;
grant execute on function public.increment_play_time(uuid, real) to authenticated;

-- Client-computed combined Aim4 Rating (average across rated gamemodes).
-- Also mirrored on each aim_run_stats row as run_overall_rating for leaderboard SQL.
drop function if exists public.update_overall_aim_rating(uuid, real);
create or replace function public.update_overall_aim_rating(p_user_id uuid, p_rating real)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null or auth.uid() is distinct from p_user_id then
    return;
  end if;
  update public.profiles
  set overall_aim_rating = p_rating
  where id = p_user_id;
end;
$$;
grant execute on function public.update_overall_aim_rating(uuid, real) to authenticated;

-- Per-user overall scores from logged runs (duels / range / deathmatch excluded).
-- Requires >= 3 distinct rated gamemodes; best run per mode, then averaged.
-- Keep OVERALL_AIM_MIN_MODES (3) in sync with src/lib/aim4Ratings.js.
drop function if exists public.aim_rating_user_scores();
create or replace function public.aim_rating_user_scores()
returns table (user_id uuid, overall_aim_rating real, rated_modes bigint)
language sql
stable
as $$
  with mode_best as (
    select r.user_id, r.scenario, max(r.run_overall_rating) as best
    from public.aim_run_stats r
    where r.scenario not in ('duels', 'range', 'deathmatch')
      and r.variant = 'competitive'
      and r.run_overall_rating is not null
    group by r.user_id, r.scenario
  )
  select
    user_id,
    avg(best)::real as overall_aim_rating,
    count(*)::bigint as rated_modes
  from mode_best
  group by user_id
  having count(*) >= 3;
$$;
grant execute on function public.aim_rating_user_scores() to anon, authenticated;

drop function if exists public.get_aim_rating_leaderboard(int);
create or replace function public.get_aim_rating_leaderboard(p_limit int default 500)
returns table (
  user_id uuid,
  username text,
  country_code text,
  overall_aim_rating real,
  rank bigint
)
language sql
stable
as $$
  with scored as (
    select
      s.user_id,
      s.overall_aim_rating,
      rank() over (order by s.overall_aim_rating desc nulls last) as rank
    from public.aim_rating_user_scores() s
  )
  select
    p.id as user_id,
    p.username,
    p.country_code,
    sc.overall_aim_rating,
    sc.rank
  from scored sc
  join public.profiles p on p.id = sc.user_id
  order by sc.overall_aim_rating desc
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
$$;
grant execute on function public.get_aim_rating_leaderboard(int) to anon, authenticated;

drop function if exists public.get_aim_rating_rank(uuid);
create or replace function public.get_aim_rating_rank(p_user_id uuid)
returns table (rank bigint, total bigint, overall_aim_rating real)
language sql
stable
as $$
  with scored as (
    select
      s.user_id,
      s.overall_aim_rating,
      rank() over (order by s.overall_aim_rating desc nulls last) as rnk,
      count(*) over () as cnt
    from public.aim_rating_user_scores() s
  )
  select rnk, cnt, overall_aim_rating
  from scored
  where user_id = p_user_id;
$$;
grant execute on function public.get_aim_rating_rank(uuid) to anon, authenticated;

-- Aggregate aim stats with optional filters:
--   p_user_id  — null = every player (global baseline), else one account
--   p_scenario — null = all scenarios
--   p_last_n   — null = no game cap, else only the most recent N runs
--   p_since    — null = no time floor, else runs at/after this timestamp
drop function if exists public.get_aim_stats(uuid, text, int, timestamptz);
create or replace function public.get_aim_stats(
  p_user_id uuid default null,
  p_scenario text default null,
  p_last_n int default null,
  p_since timestamptz default null
)
returns table (
  games bigint,
  flick_speed_ms real,
  flick_accuracy_pct real,
  tension_pct real,
  flicks_accurate bigint,
  flicks_over bigint,
  flicks_under bigint,
  clicks_early bigint,
  clicks_accurate bigint,
  clicks_late bigint,
  tracking_pct real,
  reaction_ms real,
  adjustments_per_target real,
  speed_deg_s real
)
language sql
stable
as $$
  with filtered as (
    select *
    from public.aim_run_stats r
    where (p_user_id is null or r.user_id = p_user_id)
      and (p_scenario is null or r.scenario = p_scenario)
      and (p_since is null or r.created_at >= p_since)
    order by r.created_at desc
    limit case when p_last_n is null then null else greatest(1, p_last_n) end
  )
  select
    count(*)::bigint as games,
    avg(flick_speed_ms)::real as flick_speed_ms,
    avg(flick_accuracy_pct)::real as flick_accuracy_pct,
    avg(tension_pct)::real as tension_pct,
    coalesce(sum(flicks_accurate), 0)::bigint as flicks_accurate,
    coalesce(sum(flicks_over), 0)::bigint as flicks_over,
    coalesce(sum(flicks_under), 0)::bigint as flicks_under,
    coalesce(sum(clicks_early), 0)::bigint as clicks_early,
    coalesce(sum(clicks_accurate), 0)::bigint as clicks_accurate,
    coalesce(sum(clicks_late), 0)::bigint as clicks_late,
    avg(tracking_pct)::real as tracking_pct,
    avg(reaction_ms)::real as reaction_ms,
    avg(adjustments_per_target)::real as adjustments_per_target,
    avg(speed_deg_s)::real as speed_deg_s
  from filtered;
$$;
grant execute on function public.get_aim_stats(uuid, text, int, timestamptz) to anon, authenticated;

-- ===========================================================================
-- Data migrations
-- ===========================================================================

update public.profiles set elo = 1000 where elo is null;

insert into public.profiles (id, username, elo)
select
  u.id,
  coalesce(
    nullif(lower(trim(u.raw_user_meta_data->>'username')), ''),
    'player_' || substr(replace(u.id::text, '-', ''), 1, 8)
  ),
  1000
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- Migrate saved settings: cm360 + dpi → unified sensitivity (linear scale).
-- 35 × 1200 CPI → 0.86 (2.58 ÷ 3); default 0.833… (2.5 ÷ 3).
update public.user_settings us
set
  settings = (coalesce(us.settings, '{}'::jsonb) - 'cm360' - 'dpi')
    || jsonb_build_object(
      'sensitivity',
      coalesce(
        case
          when us.settings ? 'sensitivity'
            and (us.settings->>'sensitivity') ~ '^[0-9]+(\.[0-9]+)?$'
            and (us.settings->>'sensitivity')::double precision > 0
          then (us.settings->>'sensitivity')::double precision
          when us.settings ? 'cm360'
            and us.settings ? 'dpi'
            and (us.settings->>'cm360') ~ '^[0-9]+(\.[0-9]+)?$'
            and (us.settings->>'dpi') ~ '^[0-9]+(\.[0-9]+)?$'
            and (us.settings->>'cm360')::double precision > 0
            and (us.settings->>'dpi')::double precision > 0
          then (us.settings->>'cm360')::double precision
               * (us.settings->>'dpi')::double precision
               * 0.86 / 42000.0
          else 2.5 / 3.0
        end,
        2.5 / 3.0
      )
    ),
  updated_at = now()
where us.settings ? 'cm360'
   or us.settings ? 'dpi'
   or not us.settings ? 'sensitivity'
   or coalesce(us.settings->>'sensitivity', '') = '';

-- Rescale pre-v2 unified sensitivity (stored values were 3× larger; ÷3 preserves feel).
update public.user_settings us
set
  settings = coalesce(us.settings, '{}'::jsonb)
    || jsonb_build_object(
      'sensitivity',
      case
        when us.settings ? 'sensitivity'
          and (us.settings->>'sensitivity') ~ '^[0-9]+(\.[0-9]+)?$'
          and (us.settings->>'sensitivity')::double precision >= 1
        then (us.settings->>'sensitivity')::double precision / 3.0
        else coalesce((us.settings->>'sensitivity')::double precision, 2.5 / 3.0)
      end,
      'settingsVersion', 2
    ),
  updated_at = now()
where coalesce((us.settings->>'settingsVersion')::int, 0) < 2;

-- ===========================================================================
-- Row level security — profiles, scores, settings
-- ===========================================================================

alter table public.profiles enable row level security;
alter table public.scores enable row level security;
alter table public.user_settings enable row level security;

drop policy if exists "read profiles" on public.profiles;
drop policy if exists "read scores" on public.scores;
drop policy if exists "read own scores" on public.scores;
drop policy if exists "Users can read own scores" on public.scores;
drop policy if exists "scores_select_own" on public.scores;
drop policy if exists "Enable read access for all users" on public.scores;

create policy "read profiles" on public.profiles
  for select to anon, authenticated using (true);
create policy "read scores" on public.scores
  for select to anon, authenticated using (true);

grant select on public.profiles to anon, authenticated;
grant select on public.scores to anon, authenticated;

drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "insert own score" on public.scores;
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);
create policy "insert own score" on public.scores
  for insert with check (auth.uid() = user_id);
drop policy if exists "delete own scores" on public.scores;
create policy "delete own scores" on public.scores
  for delete using (auth.uid() = user_id);
grant delete on public.scores to authenticated;

drop policy if exists "read own settings" on public.user_settings;
drop policy if exists "read all settings" on public.user_settings;
drop policy if exists "insert own settings" on public.user_settings;
drop policy if exists "update own settings" on public.user_settings;
create policy "read all settings" on public.user_settings
  for select to anon, authenticated using (true);
create policy "insert own settings" on public.user_settings
  for insert with check (auth.uid() = user_id);
create policy "update own settings" on public.user_settings
  for update using (auth.uid() = user_id);

grant select on public.user_settings to anon, authenticated;

-- ===========================================================================
-- Row level security — replays
-- ===========================================================================

alter table public.replays enable row level security;

drop policy if exists "read own replays" on public.replays;
drop policy if exists "read all replays" on public.replays;
drop policy if exists "insert own replays" on public.replays;
drop policy if exists "update own replays" on public.replays;
drop policy if exists "delete own replays" on public.replays;
create policy "read all replays" on public.replays
  for select to anon, authenticated using (true);
create policy "insert own replays" on public.replays
  for insert with check (auth.uid() = user_id);
create policy "update own replays" on public.replays
  for update using (auth.uid() = user_id);
create policy "delete own replays" on public.replays
  for delete using (auth.uid() = user_id);

grant select on public.replays to anon, authenticated;
grant insert, update, delete on public.replays to authenticated;

-- ===========================================================================
-- Row level security — shared replays (permanent public links)
-- ===========================================================================

alter table public.shared_replays enable row level security;

drop policy if exists "read shared replays" on public.shared_replays;
drop policy if exists "insert own shared replays" on public.shared_replays;
create policy "read shared replays" on public.shared_replays
  for select to anon, authenticated using (true);
create policy "insert own shared replays" on public.shared_replays
  for insert to authenticated with check (auth.uid() = user_id);

grant select on public.shared_replays to anon, authenticated;
grant insert on public.shared_replays to authenticated;

-- ===========================================================================
-- Auth trigger — create profile on sign-up
-- ===========================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  v_username := lower(trim(new.raw_user_meta_data->>'username'));
  if v_username is null or v_username = '' then
    v_username := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  if exists (select 1 from public.profiles where username = v_username) then
    raise exception 'username_taken';
  end if;
  insert into public.profiles (id, username) values (new.id, v_username);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- RPC — leaderboards
-- ===========================================================================

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
  if p_scenario in (
    'gridshot', 'stars', 'microflicks', 'pasu', 'spidershot', 'arena', 'duels', 'range', 'deathmatch'
  ) then
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
      coalesce(s.kills, s.score, 0) desc,
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
  if p_scenario in (
    'gridshot', 'stars', 'microflicks', 'pasu', 'spidershot', 'arena', 'duels', 'range', 'deathmatch'
  ) then
    return query
    select
      ranked.user_id,
      ranked.username,
      ranked.score,
      ranked.accuracy,
      ranked.crit_ratio,
      ranked.kills,
      ranked.time_played,
      ranked.kpm,
      ranked.achieved_at
    from (
      select * from public.get_leaderboard(p_scenario, p_config_key, 1000)
    ) ranked
    order by
      coalesce(ranked.kills, ranked.score, 0) desc,
      coalesce(ranked.accuracy, 0) desc,
      ranked.achieved_at asc
    limit greatest(1, least(p_limit, 50));
  else
    return query
    select
      ranked.user_id,
      ranked.username,
      ranked.score,
      ranked.accuracy,
      ranked.crit_ratio,
      ranked.kills,
      ranked.time_played,
      ranked.kpm,
      ranked.achieved_at
    from (
      select * from public.get_leaderboard(p_scenario, p_config_key, 1000)
    ) ranked
    order by ranked.score desc, ranked.achieved_at asc
    limit greatest(1, least(p_limit, 50));
  end if;
end;
$$;

grant execute on function public.get_leaderboard_top(text, text, int) to anon, authenticated;

-- ===========================================================================
-- RPC — Elo leaderboard
-- ===========================================================================

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

-- ===========================================================================
-- RPC — account page ranks
-- ===========================================================================

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

-- ===========================================================================
-- RPC — account replays
-- ===========================================================================

drop function if exists public.get_account_replays(uuid);

create or replace function public.get_account_replays(p_user_id uuid)
returns setof public.replays
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.replays
  where user_id = p_user_id
  order by scenario, variant, slot;
$$;

grant execute on function public.get_account_replays(uuid) to anon, authenticated;

-- ===========================================================================
-- Storage — replay payloads
-- ===========================================================================

insert into storage.buckets (id, name, public)
values ('replays', 'replays', false)
on conflict (id) do nothing;

drop policy if exists "replay objects read own" on storage.objects;
drop policy if exists "replay objects read all" on storage.objects;
drop policy if exists "replay objects insert own" on storage.objects;
drop policy if exists "replay objects update own" on storage.objects;
drop policy if exists "replay objects delete own" on storage.objects;
create policy "replay objects read all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'replays');
create policy "replay objects insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "replay objects insert shared" on storage.objects;
create policy "replay objects insert shared" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'replays' and (storage.foldername(name))[1] = 'shared');
create policy "replay objects update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replay objects delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
