-- AIM4.io — add replay storage to an existing Supabase project
-- Run in SQL Editor if your database was created before replays were added.
-- Safe to re-run (uses IF NOT EXISTS / DROP POLICY IF EXISTS).

-- Metadata: one row per (account, scenario, variant, slot) — `last` or `best`
create table if not exists public.replays (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  scenario text not null,
  config_key text not null,
  variant text not null,
  slot text not null,
  score integer,
  accuracy real,
  kills integer,
  duration real,
  tick_rate integer not null default 128,
  byte_size integer,
  replay_file_path text not null,
  created_at timestamptz default now(),
  unique (user_id, scenario, variant, slot)
);
create index if not exists replays_user_idx on public.replays (user_id);

alter table public.replays enable row level security;

drop policy if exists "read own replays" on public.replays;
drop policy if exists "insert own replays" on public.replays;
drop policy if exists "update own replays" on public.replays;
drop policy if exists "delete own replays" on public.replays;
create policy "read own replays" on public.replays
  for select using (auth.uid() = user_id);
create policy "insert own replays" on public.replays
  for insert with check (auth.uid() = user_id);
create policy "update own replays" on public.replays
  for update using (auth.uid() = user_id);
create policy "delete own replays" on public.replays
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.replays to authenticated;

insert into storage.buckets (id, name, public)
values ('replays', 'replays', false)
on conflict (id) do nothing;

drop policy if exists "replay objects read own" on storage.objects;
drop policy if exists "replay objects insert own" on storage.objects;
drop policy if exists "replay objects update own" on storage.objects;
drop policy if exists "replay objects delete own" on storage.objects;
create policy "replay objects read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replay objects insert own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replay objects update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "replay objects delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'replays' and (storage.foldername(name))[1] = auth.uid()::text);
