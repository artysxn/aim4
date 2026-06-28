-- AIM4.io — allow viewing other users' replays (leaderboard → account page)
-- Run as a NEW query in Supabase SQL Editor. Safe to re-run.

-- Metadata: anyone can list/read replay rows; only the owner can write.
drop policy if exists "read own replays" on public.replays;
drop policy if exists "read all replays" on public.replays;
create policy "read all replays" on public.replays
  for select to anon, authenticated using (true);

grant select on public.replays to anon, authenticated;

-- Storage payloads: public read on the replays bucket; owner-only writes.
drop policy if exists "replay objects read own" on storage.objects;
drop policy if exists "replay objects read all" on storage.objects;
create policy "replay objects read all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'replays');
