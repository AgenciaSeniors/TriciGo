-- 00654: six admin-panel RPCs answered any signed-in user.
--
-- Measured in prod on 2026-10-11: these functions are SECURITY DEFINER, executable by
-- authenticated, and nothing in their bodies checks who calls. Anon has no EXECUTE.
--   * detect_collusion_reviews() writes: it inserts or refreshes cases in cancellation_reviews,
--     the queue admins work through on /cancellations. Any rider or driver could run it.
--   * get_peak_hours(integer): the platform's average rides per hour.
--   * get_driver_utilization(): how many approved drivers are online, busy and idle.
--   * get_auto_accept_rate(integer), get_auto_nav_rate(integer): how drivers use auto-accept and
--     auto-navigation.
--   * get_override_frequency(integer, integer): how many offers each driver rejected, by driver id.
-- get_peak_hours and get_driver_utilization feed /reports, which marketing can open. 00642 changed
-- the gate of the other /reports RPCs to "admin or marketing"; these had no gate to change,
-- because they are LANGUAGE sql. The last three feed /validation, which is admin-only.
--
-- This file:
--   1. adds an admin gate to detect_collusion_reviews(), patched in place on the live body
--      (only /cancellations calls it, and that page is admin-only);
--   2. rewrites the other five in plpgsql with the same query behind a gate: "admin or marketing"
--      (00642's) for the two /reports ones, admin-only for the three /validation ones.
-- The grants do not change: admins and marketing call these signed in, as authenticated. Without
-- a JWT (service role, cron, the SQL editor) is_admin() and is_marketing() are false, so those
-- callers get 42501 as well; nothing calls them that way.
--
-- Each function is replaced only if its body is the one read from prod (md5 of prosrc), and the
-- result is checked against the expected md5: a body that drifted aborts the file instead of
-- being overwritten. Re-running the file is a no-op. The bodies are built without depending on
-- the file's line endings, so a copy pasted from Windows (CRLF) gives the same result.
-- Rehearsal: supabase/tests/00654/run.sh.

SET lock_timeout = '10s';

-- 1. detect_collusion_reviews(): admin gate ---------------------------------------------------
DO $patch$
DECLARE
  c_fn      CONSTANT regprocedure := 'public.detect_collusion_reviews()'::regprocedure;
  c_md5_old CONSTANT text := '47ea9b9b71a38098dd07b398bdeee87d';
  c_md5_new CONSTANT text := '94558654ff2fdd4a0482099f2649b690';
  c_target  CONSTANT text := E'BEGIN\n  FOR rec IN';
  c_gated   CONSTANT text := E'BEGIN\n  IF NOT public.is_admin() THEN\n'
                             || E'    RAISE EXCEPTION ''forbidden: admin only'' USING ERRCODE = ''42501'';\n'
                             || E'  END IF;\n\n  FOR rec IN';
  v_def text;
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 = c_md5_new THEN
    RETURN;
  END IF;
  IF v_md5 <> c_md5_old THEN
    RAISE EXCEPTION '00654: % has a body this migration does not know (md5 %); patch it from the live body', c_fn, v_md5;
  END IF;
  v_def := pg_get_functiondef(c_fn);
  IF (length(v_def) - length(replace(v_def, c_target, ''))) / length(c_target) <> 1 THEN
    RAISE EXCEPTION '00654: the patch target is not in % exactly once', c_fn;
  END IF;
  EXECUTE replace(v_def, c_target, c_gated);
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = c_fn;
  IF v_md5 <> c_md5_new THEN
    RAISE EXCEPTION '00654: % was patched to md5 %, expected %', c_fn, v_md5, c_md5_new;
  END IF;
END
$patch$;

-- 2. Rewrites in plpgsql, gate first, same query as prod ---------------------------------------
-- get_peak_hours and get_driver_utilization feed /reports: admin or marketing (00642's gate).
-- get_auto_accept_rate, get_auto_nav_rate and get_override_frequency feed /validation, which is
-- admin-only; get_override_frequency lists how many offers each driver rejected.
-- In plpgsql the RETURNS TABLE columns are variables, and these queries name columns without a
-- table (driver_id, created_at): #variable_conflict use_column keeps them meaning the column, so
-- each query stays byte for byte the one prod runs today.
DO $rewrite$
DECLARE
  r     record;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.get_peak_hours(integer)', 'f05bd1924513646349e38cacd817a0e4', '29e882b3dfbf6c3f2d5ad5946d04e3d8',
       $def$CREATE OR REPLACE FUNCTION public.get_peak_hours(p_days_back integer DEFAULT 30)
 RETURNS TABLE(hour integer, avg_rides numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH hourly AS (
    SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE 'America/Havana')::INT AS hour,
           (r.created_at AT TIME ZONE 'America/Havana')::DATE AS day,
           COUNT(*) AS rides
    FROM rides r
    WHERE r.created_at >= ((((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp) AT TIME ZONE 'America/Havana')
    GROUP BY 1, 2
  )
  SELECT h.hour, ROUND(AVG(h.rides), 1) AS avg_rides FROM hourly h GROUP BY h.hour ORDER BY h.hour;
END;
$fn$$def$),
      ('public.get_driver_utilization()', '47b8b33fb8a8583b558409faeb7034b0', 'deb8280b477f4dc4ccf64acfcdd0cafa',
       $def$CREATE OR REPLACE FUNCTION public.get_driver_utilization()
 RETURNS TABLE(online integer, busy integer, idle integer, offline integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE dp.is_online = true)::INT AS online,
    COUNT(*) FILTER (WHERE dp.is_online = true AND EXISTS(
      SELECT 1 FROM rides r WHERE r.driver_id = dp.id AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS busy,
    COUNT(*) FILTER (WHERE dp.is_online = true AND NOT EXISTS(
      SELECT 1 FROM rides r WHERE r.driver_id = dp.id AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS idle,
    COUNT(*) FILTER (WHERE dp.is_online = false OR dp.is_online IS NULL)::INT AS offline
  FROM driver_profiles dp WHERE dp.status = 'approved';
END;
$fn$$def$),
      ('public.get_auto_accept_rate(integer)', '0a68bb7e05d942faaf870d066783115f', 'd287cc0735f48cb5d621d71b82bd0456',
       $def$CREATE OR REPLACE FUNCTION public.get_auto_accept_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(profit_level text, total bigint, accepted bigint, rejected bigint, accept_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    properties->>'profit_level' as profit_level,
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::bigint as accepted,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as rejected,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      1
    ) as accept_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_auto_accepted', 'driver_ride_rejected')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY properties->>'profit_level';
END;
$fn$$def$),
      ('public.get_auto_nav_rate(integer)', 'b7ee2686794168da2e8a74a5b3d0f0d0', 'ea732c6b23a1f3654f44d52077e3bd70',
       $def$CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::bigint as triggered,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as cancelled,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::numeric /
      NULLIF(COUNT(*) FILTER (WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')), 0) * 100,
      1
    ) as follow_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval;
END;
$fn$$def$),
      ('public.get_override_frequency(integer,integer)', 'cbf1219470c8402ec9c94cb956c9e682', '32d90734b10ec562591c9362b61f11a7',
       $def$CREATE OR REPLACE FUNCTION public.get_override_frequency(p_days_back integer DEFAULT 7, p_limit integer DEFAULT 20)
 RETURNS TABLE(driver_id uuid, total_overrides bigint, reject_count bigint, nav_cancel_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $fn$
#variable_conflict use_column
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    driver_id,
    COUNT(*)::bigint as total_overrides,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as reject_count,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as nav_cancel_count
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_rejected', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY driver_id
  ORDER BY total_overrides DESC
  LIMIT p_limit;
END;
$fn$$def$)
    ) AS v(fn, old_md5, new_md5, def)
  LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    CONTINUE WHEN v_md5 = r.new_md5;
    IF v_md5 <> r.old_md5 THEN
      RAISE EXCEPTION '00654: % has a body this migration does not know (md5 %); rewrite it from the live body', r.fn, v_md5;
    END IF;
    EXECUTE replace(r.def, chr(13), '');
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = r.fn::regprocedure;
    IF v_md5 <> r.new_md5 THEN
      RAISE EXCEPTION '00654: % was rewritten to md5 %, expected %', r.fn, v_md5, r.new_md5;
    END IF;
  END LOOP;
END
$rewrite$;

-- 3. Checks -----------------------------------------------------------------------------------
DO $check$
DECLARE
  r     record;
  v_out text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.detect_collusion_reviews()', '94558654ff2fdd4a0482099f2649b690', 'SELECT public.detect_collusion_reviews()::text'),
      ('public.get_peak_hours(integer)', '29e882b3dfbf6c3f2d5ad5946d04e3d8', 'SELECT count(*)::text FROM public.get_peak_hours(30)'),
      ('public.get_driver_utilization()', 'deb8280b477f4dc4ccf64acfcdd0cafa', 'SELECT count(*)::text FROM public.get_driver_utilization()'),
      ('public.get_auto_accept_rate(integer)', 'd287cc0735f48cb5d621d71b82bd0456', 'SELECT count(*)::text FROM public.get_auto_accept_rate(7)'),
      ('public.get_auto_nav_rate(integer)', 'ea732c6b23a1f3654f44d52077e3bd70', 'SELECT count(*)::text FROM public.get_auto_nav_rate(7)'),
      ('public.get_override_frequency(integer,integer)', '32d90734b10ec562591c9362b61f11a7', 'SELECT count(*)::text FROM public.get_override_frequency(7, 20)')
    ) AS v(fn, md5, probe)
  LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = r.fn::regprocedure) <> r.md5 THEN
      RAISE EXCEPTION '00654: % does not have the gated body', r.fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = r.fn::regprocedure) THEN
      RAISE EXCEPTION '00654: % must stay SECURITY DEFINER', r.fn;
    END IF;
    IF has_function_privilege('anon', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00654: % is executable by anon', r.fn;
    END IF;
    IF NOT has_function_privilege('authenticated', r.fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '00654: % is no longer executable by authenticated (admins and marketing call it signed in)', r.fn;
    END IF;

    -- Without a JWT subject nobody is an admin or marketing: the gate must refuse.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    BEGIN
      EXECUTE r.probe INTO v_out;
      RAISE EXCEPTION '00654: % answered without an admin or marketing user (%)', r.fn, v_out
        USING ERRCODE = 'P0001';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END LOOP;
END
$check$;

RESET lock_timeout;
