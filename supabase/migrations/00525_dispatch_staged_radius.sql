-- 00525_dispatch_staged_radius.sql
--
-- Staged dispatch radius: give nearby drivers a real head start before the
-- offer opens to everyone.
--
-- WHY. 00524 removed the distance ceiling so a ride would always reach
-- somebody. Measured against real completed rides in Havana, travel to the
-- pickup runs at ~3 min/km (accepted offers historically averaged 1.2 km →
-- 4-10 min wait; the two long ones on record: 9.7 km → 33 min, completed;
-- 6.9 km → 21 min, canceled). With no ceiling at all, the only driver who
-- answers could be 20 km out — a ~60 min wait — and by then the rider is
-- already committed: they stopped searching and their only exit is to cancel
-- and start over.
--
-- WHAT. The radius now depends on the ride's AGE, not on the caller:
--   * first `dispatch_stage1_seconds` (45s, one full offer round): only
--     drivers within `dispatch_stage1_radius_m` (8 km ≈ 24 min) — the nearby
--     driver gets a genuine first shot;
--   * after that: `dispatch_max_radius_m` (0 = unlimited, the 00524 default).
-- Set either stage-1 key to 0 to disable staging and restore 00524 behavior.
--
-- The 45s default is deliberate: it equals `offer_ttl_seconds`, so stage 1
-- covers exactly one offer round and the first retry-cron tick after it
-- (the cron runs every minute, and only re-dispatches when no offer is
-- pending) already opens the search. A stage-1 window LONGER than the TTL
-- would waste a whole cron tick on a no-op round.
--
-- Untouched: the reactivation push to offline drivers still fires at 60s
-- regardless of distance — waking a driver who is 10 blocks away is exactly
-- what should happen during the stage-1 window. Re-offers, vehicle-type
-- matching, the low-rating gate (which overrides the radius afterwards) and
-- every other filter are unchanged.

-- ============================================================
-- Config
-- ============================================================
INSERT INTO platform_config (key, value) VALUES
  ('dispatch_stage1_seconds',  '45'::jsonb),
  ('dispatch_stage1_radius_m', '8000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Patch dispatch_ride IN PLACE.
--
-- Canonical pattern for editing a live RPC (CLAUDE.md): read the LIVE body
-- and rewrite one unique fragment, instead of re-emitting the whole function.
-- Starting from the live source makes it impossible to silently drop a
-- feature added by an earlier migration (the 00124 regression class).
--
-- Target verified unique before writing this migration: the fragment occurs
-- exactly once in dispatch_ride and zero times anywhere else
-- (dispatch_searching_rides_for_driver uses a different variable name).
-- ============================================================
DO $patch$
DECLARE
  v_src    text;
  v_target text := 'v_eff_radius := GREATEST(0, get_platform_config_numeric(''dispatch_max_radius_m'', 0))::int;';
  v_new    text := 'v_eff_radius := CASE'
    || ' WHEN get_platform_config_numeric(''dispatch_stage1_seconds'', 45) > 0'
    || '  AND get_platform_config_numeric(''dispatch_stage1_radius_m'', 8000) > 0'
    || '  AND v_ride.created_at > now() - make_interval(secs => get_platform_config_numeric(''dispatch_stage1_seconds'', 45))'
    || ' THEN GREATEST(0, get_platform_config_numeric(''dispatch_stage1_radius_m'', 8000))::int'
    || ' ELSE GREATEST(0, get_platform_config_numeric(''dispatch_max_radius_m'', 0))::int'
    || ' END;';
BEGIN
  SELECT pg_get_functiondef('public.dispatch_ride(uuid, integer)'::regprocedure) INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '00525: dispatch_ride absent; skipping';
    RETURN;
  END IF;

  -- Idempotent: a second run finds the marker and does nothing.
  IF position('dispatch_stage1_seconds' IN v_src) > 0 THEN
    RAISE NOTICE '00525: staged radius already applied; skipping';
    RETURN;
  END IF;

  IF position(v_target IN v_src) = 0 THEN
    RAISE EXCEPTION '00525: expected fragment not found in live dispatch_ride — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_src, v_target, v_new);
  RAISE NOTICE '00525: dispatch_ride patched with staged radius';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00525: dispatch_ride absent; skipping';
END $patch$;
