-- AIM4.io — allow reading other users' cloud settings (leaderboard → explore / copy)
-- Run as a NEW query in Supabase SQL Editor. Safe to re-run.

drop policy if exists "read all settings" on public.user_settings;
create policy "read all settings" on public.user_settings
  for select to anon, authenticated using (true);

grant select on public.user_settings to anon, authenticated;
