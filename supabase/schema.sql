-- AIM4.io — Supabase schema (run in SQL Editor)
-- Keep "Confirm email" ON under Auth → Providers → Email.
-- Add https://aim4.io and http://localhost:5173 to Auth → URL Configuration redirect URLs.

-- ---- Upgrades (safe to re-run if tables already exist from SETUP.md) ----
alter table public.scores add column if not exists hits integer;
alter table public.scores add column if not exists shots integer;
alter table public.scores add column if not exists time_played real;
alter table public.scores add column if not exists kpm real;
alter table public.profiles add column if not exists elo integer not null default 1000;

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

-- Profile per auth user (public username shown on leaderboards)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  elo integer not null default 1000,
  created_at timestamptz default now()
);

-- Best-effort per-run scores; leaderboard RPC dedupes to one row per account.
create table if not exists public.scores (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  scenario text not null,
  config_key text not null,
  score integer not null,
  accuracy real,
  crit_ratio real,
  kills integer,
  hits integer,
  shots integer,
  time_played real,
  kpm real,
  created_at timestamptz default now()
);
create index if not exists scores_scenario_config_score_idx
  on public.scores (scenario, config_key, score desc);
create index if not exists scores_user_id_idx on public.scores (user_id);

-- Cloud-synced game settings (full SettingsManager payload as JSON)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.scores enable row level security;
alter table public.user_settings enable row level security;

-- Public reads for global leaderboards (anon + logged-in must see ALL users' rows)
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "read scores" on public.scores;
drop policy if exists "read own scores" on public.scores;
drop policy if exists "Users can read own scores" on public.scores;
drop policy if exists "scores_select_own" on public.scores;

create policy "read profiles" on public.profiles
  for select to anon, authenticated using (true);
create policy "read scores" on public.scores
  for select to anon, authenticated using (true);

grant select on public.profiles to anon, authenticated;
grant select on public.scores to anon, authenticated;

-- Users write only their own rows
create policy "insert own profile" on public.profiles
  for insert with check (auth.uid() = id);
create policy "update own profile" on public.profiles
  for update using (auth.uid() = id);
create policy "insert own score" on public.scores
  for insert with check (auth.uid() = user_id);
create policy "read own settings" on public.user_settings
  for select using (auth.uid() = user_id);
create policy "insert own settings" on public.user_settings
  for insert with check (auth.uid() = user_id);
create policy "update own settings" on public.user_settings
  for update using (auth.uid() = user_id);

-- Create profile when auth.users row is inserted (runs before email is confirmed).
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

-- Best run per account for a scenario + config (gridshot: time played, then kpm/kills/acc)
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

-- Wrapper so PostgREST can call it easily
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

-- Global ranked Elo board (one row per account; default 1000 until first ranked match)
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
