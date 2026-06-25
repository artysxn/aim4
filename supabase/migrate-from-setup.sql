-- AIM4.io — run AFTER the original SETUP.md schema (safe to re-run)
-- Supabase SQL Editor → New query → paste → Run

alter table public.scores add column if not exists hits integer;
alter table public.scores add column if not exists shots integer;
alter table public.scores add column if not exists time_played real;
alter table public.scores add column if not exists kpm real;

create index if not exists scores_user_id_idx on public.scores (user_id);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users on delete cascade,
  settings jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "read own settings" on public.user_settings;
create policy "read own settings" on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists "insert own settings" on public.user_settings;
create policy "insert own settings" on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own settings" on public.user_settings;
create policy "update own settings" on public.user_settings
  for update using (auth.uid() = user_id);

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
security invoker
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
security invoker
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
