-- ===========================================================================
-- reset_bot_gamemodes.sql
-- Reset ALL bot gamemodes (leaderboards, replays, aim analytics).
--
-- Bot scenarios (16): arena, snipercrossfire, duels, deathmatch, range,
-- tracking, rapidtrack, cover, coverawp, sniperholds, sniperflicks,
-- snipertracking, sniperquickscopes, pitrifle, doorsawp, peekswitchbots
--
-- Removes:
--   • public.scores
--   • public.replays + storage.objects (replays bucket payloads)
--   • public.aim_run_stats
--   • public.shared_replays
--
-- Does NOT touch: profiles (elo), user_settings, non-bot modes, or browser
-- localStorage (practiceBest pace-bar PBs).
--
-- Run in Supabase Dashboard → SQL Editor (service role / postgres).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Options — edit before running
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _reset_opts (
  target_user_id uuid,  -- NULL = every account; or one user's uuid
  dry_run boolean NOT NULL DEFAULT true  -- true = preview counts only
) ON COMMIT DROP;

INSERT INTO _reset_opts (target_user_id, dry_run)
VALUES (
  NULL,   -- e.g. 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid
  false   -- set true first to preview, then false to delete
);

CREATE TEMP TABLE _bot_scenarios (scenario text PRIMARY KEY) ON COMMIT DROP;

INSERT INTO _bot_scenarios (scenario) VALUES
  ('arena'),
  ('snipercrossfire'),
  ('duels'),
  ('deathmatch'),
  ('range'),
  ('tracking'),
  ('rapidtrack'),
  ('cover'),
  ('coverawp'),
  ('sniperholds'),
  ('sniperflicks'),
  ('snipertracking'),
  ('sniperquickscopes'),
  ('pitrifle'),
  ('doorsawp'),
  ('peekswitchbots');

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------

SELECT 'scores' AS table_name, count(*) AS rows_matched
FROM public.scores s
INNER JOIN _bot_scenarios b ON b.scenario = s.scenario
CROSS JOIN _reset_opts o
WHERE o.target_user_id IS NULL OR s.user_id = o.target_user_id

UNION ALL

SELECT 'replays', count(*)
FROM public.replays r
INNER JOIN _bot_scenarios b ON b.scenario = r.scenario
CROSS JOIN _reset_opts o
WHERE o.target_user_id IS NULL OR r.user_id = o.target_user_id

UNION ALL

SELECT 'aim_run_stats', count(*)
FROM public.aim_run_stats a
INNER JOIN _bot_scenarios b ON b.scenario = a.scenario
CROSS JOIN _reset_opts o
WHERE o.target_user_id IS NULL OR a.user_id = o.target_user_id

UNION ALL

SELECT 'shared_replays', count(*)
FROM public.shared_replays sr
INNER JOIN _bot_scenarios b ON b.scenario = sr.scenario
CROSS JOIN _reset_opts o
WHERE o.target_user_id IS NULL OR sr.user_id = o.target_user_id

UNION ALL

SELECT 'storage.objects (replays bucket)', count(*)
FROM storage.objects obj
CROSS JOIN _reset_opts o
WHERE obj.bucket_id = 'replays'
  AND obj.name IN (
    SELECT r.replay_file_path
    FROM public.replays r
    INNER JOIN _bot_scenarios b ON b.scenario = r.scenario
    WHERE o.target_user_id IS NULL OR r.user_id = o.target_user_id
    UNION
    SELECT sr.replay_file_path
    FROM public.shared_replays sr
    INNER JOIN _bot_scenarios b ON b.scenario = sr.scenario
    WHERE o.target_user_id IS NULL OR sr.user_id = o.target_user_id
  );

-- ---------------------------------------------------------------------------
-- Deletes (skipped when dry_run = true)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_dry boolean;
  v_user uuid;
BEGIN
  SELECT dry_run, target_user_id INTO v_dry, v_user FROM _reset_opts LIMIT 1;

  IF v_dry THEN
    RAISE NOTICE 'Dry run — no rows deleted. Set dry_run = false in _reset_opts to execute.';
    RETURN;
  END IF;

  -- Storage payloads first (while metadata rows still exist)
  DELETE FROM storage.objects obj
  WHERE obj.bucket_id = 'replays'
    AND obj.name IN (
      SELECT r.replay_file_path
      FROM public.replays r
      INNER JOIN _bot_scenarios b ON b.scenario = r.scenario
      WHERE v_user IS NULL OR r.user_id = v_user
      UNION
      SELECT sr.replay_file_path
      FROM public.shared_replays sr
      INNER JOIN _bot_scenarios b ON b.scenario = sr.scenario
      WHERE v_user IS NULL OR sr.user_id = v_user
    );

  DELETE FROM public.replays r
  USING _bot_scenarios b
  WHERE r.scenario = b.scenario
    AND (v_user IS NULL OR r.user_id = v_user);

  DELETE FROM public.shared_replays sr
  USING _bot_scenarios b
  WHERE sr.scenario = b.scenario
    AND (v_user IS NULL OR sr.user_id = v_user);

  DELETE FROM public.scores s
  USING _bot_scenarios b
  WHERE s.scenario = b.scenario
    AND (v_user IS NULL OR s.user_id = v_user);

  DELETE FROM public.aim_run_stats a
  USING _bot_scenarios b
  WHERE a.scenario = b.scenario
    AND (v_user IS NULL OR a.user_id = v_user);

  RAISE NOTICE 'Bot gamemode reset complete.';
END $$;

COMMIT;
