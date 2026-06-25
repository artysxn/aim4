-- AIM4.io — wipe all leaderboard scores and reset ranked Elo to 1000
-- Supabase SQL Editor → New query → paste → Run
--
-- Does NOT delete accounts, profiles, usernames, or cloud settings.
-- Irreversible — export/backup first if you might need the data.

-- All scenario leaderboard rows (Gridshot, Pasu, Survival, etc.)
truncate table public.scores restart identity;

-- Ranked 1v1 Elo (stored on profiles; default for new users is 1000)
update public.profiles set elo = 1000;
