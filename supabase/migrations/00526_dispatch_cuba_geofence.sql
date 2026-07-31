-- 00526_dispatch_cuba_geofence.sql
--
-- Never offer a Cuban ride to a driver whose GPS is outside Cuba, and put a
-- generous hard ceiling back on the open stage.
--
-- WHY. Verified in prod on 2026-07-31 while testing the staged radius of
-- 00525: the only driver online at that moment reported GPS at
-- lat -25.46 / lng -54.59 — Ciudad del Este, Paraguay — 6155 km from Havana.
-- A rolled-back dispatch confirmed the consequence: a Havana ride older than
-- the stage-1 window created a real offer for that driver, because
-- `dispatch_max_radius_m = 0` means "no ceiling at all". If such a driver
-- accepts (curiosity, misfire, stale device), the rider is assigned someone
-- who can never arrive: they stop searching and their only exit is to cancel
-- and start over.
--
-- "Unlimited" was always meant as "anywhere in the city/country", never as
-- "another continent". Two independent guards, per the user's decision:
--
--   1. GEOFENCE. A driver must report GPS inside the Cuban archipelago to be
--      eligible at all. Bounding box lat 19.3..23.7 / lng -85.2..-73.8 — the
--      SAME box already used by the search stack (see the Google Places
--      section of CLAUDE.md), kept identical on purpose so there is one
--      definition of "inside Cuba" in the codebase.
--   2. CEILING. `dispatch_max_radius_m` 0 → 50000 (50 km). Covers Havana plus
--      Mayabeque/Artemisa with room to spare, and every other Cuban city
--      comfortably, while making a 6000 km match arithmetically impossible
--      even if the geofence were somehow bypassed.
--
-- Belt and braces on purpose: the geofence catches a driver *inside* the
-- 50 km ceiling but on the wrong island; the ceiling catches a driver inside
-- the box but absurdly far (e.g. Havana ride, Guantánamo driver, ~900 km).
--
-- Also: `offer_ttl_seconds` 120 → 60. The TTL was raised to 120 by hand on
-- 2026-07-30 after a driver was left with ~11 usable seconds (the push landed
-- 19s into a 30s window). 120s over-corrected: because the retry loop will not
-- re-dispatch while an offer is still pending, a 120s TTL pushed the open
-- stage out to 2-3 minutes. 60s keeps a comfortable reaction window while
-- letting the search open on the next cron tick. `dispatch_stage1_seconds`
-- stays at 45 (< TTL, as the rule requires).

-- ============================================================
-- Config
-- ============================================================
UPDATE platform_config SET value = '50000'::jsonb WHERE key = 'dispatch_max_radius_m';
UPDATE platform_config SET value = '60'::jsonb    WHERE key = 'offer_ttl_seconds';

-- ============================================================
-- 1. find_best_drivers — geofence the offer candidates.
--
-- Patched IN PLACE from the live body (CLAUDE.md canonical pattern): starting
-- from live source makes it impossible to silently drop a filter added by an
-- earlier migration. Target fragment verified unique beforehand (1 occurrence
-- in find_best_drivers, 0 elsewhere).
-- ============================================================
DO $patch$
DECLARE
  v_src    text;
  v_target text := 'AND (p_radius_m <= 0 OR ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m))';
  v_new    text := 'AND (p_radius_m <= 0 OR ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m))'
    || ' AND ST_Y(dp.current_location::geometry) BETWEEN 19.3 AND 23.7'
    || ' AND ST_X(dp.current_location::geometry) BETWEEN -85.2 AND -73.8';
BEGIN
  SELECT pg_get_functiondef(
    'public.find_best_drivers(double precision, double precision, text, integer, integer, boolean, integer, text, numeric, integer, integer, integer, uuid)'::regprocedure
  ) INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '00526: find_best_drivers absent; skipping';
    RETURN;
  END IF;

  IF position('BETWEEN 19.3 AND 23.7' IN v_src) > 0 THEN
    RAISE NOTICE '00526: find_best_drivers geofence already applied; skipping';
    RETURN;
  END IF;

  IF position(v_target IN v_src) = 0 THEN
    RAISE EXCEPTION '00526: expected fragment not found in live find_best_drivers — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_src, v_target, v_new);
  RAISE NOTICE '00526: find_best_drivers geofenced to Cuba';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00526: find_best_drivers absent; skipping';
END $patch$;

-- ============================================================
-- 2. notify_offline_drivers_for_searching_rides — same geofence for the
-- reactivation push, so a driver abroad is not pinged about Havana rides.
--
-- NULL location passes: an approved driver who never reported GPS (fresh
-- install, permission not yet granted) is a legitimate wake-up target — the
-- geofence in find_best_drivers still gates whether they can actually be
-- offered the ride once they connect.
-- ============================================================
DO $patch$
DECLARE
  v_src    text;
  v_target text := 'AND dp.match_score > 10';
  v_new    text := 'AND dp.match_score > 10'
    || ' AND (dp.current_location IS NULL OR ('
    || '   ST_Y(dp.current_location::geometry) BETWEEN 19.3 AND 23.7'
    || '   AND ST_X(dp.current_location::geometry) BETWEEN -85.2 AND -73.8))';
BEGIN
  SELECT pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure) INTO v_src;

  IF v_src IS NULL THEN
    RAISE NOTICE '00526: reactivation function absent; skipping';
    RETURN;
  END IF;

  IF position('BETWEEN 19.3 AND 23.7' IN v_src) > 0 THEN
    RAISE NOTICE '00526: reactivation geofence already applied; skipping';
    RETURN;
  END IF;

  IF position(v_target IN v_src) = 0 THEN
    RAISE EXCEPTION '00526: expected fragment not found in live reactivation function — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_src, v_target, v_new);
  RAISE NOTICE '00526: reactivation push geofenced to Cuba';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE '00526: reactivation function absent; skipping';
END $patch$;
