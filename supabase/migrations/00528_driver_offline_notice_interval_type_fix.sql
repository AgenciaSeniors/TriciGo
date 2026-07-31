-- 00528_driver_offline_notice_interval_type_fix.sql
--
-- HOTFIX for 00527, applied minutes after it: `auto_offline_stale_drivers()`
-- threw 42883 on every run, so cron 10 was failing and stale drivers were
-- never being taken off line.
--
--   make_interval(mins => v_after_min)  -- v_after_min was NUMERIC
--   ERROR: function make_interval(mins => numeric) does not exist
--
-- Only `secs` in make_interval is double precision; every other field
-- (years, months, weeks, days, hours, mins) is INT, and NUMERIC does not
-- implicitly resolve to INT. The sibling functions in 00524-00526 got away
-- with `make_interval(secs => …)` because their variables were INT and INT
-- widens to double precision implicitly — this one used `mins` and NUMERIC.
--
-- Same trap class as the `RAISE ... USING MESSAGE` bug in 00519: plpgsql does
-- not type-check the SQL inside a function body at CREATE time, so the
-- function is created happily and only explodes when that line executes.
-- CREATE succeeding is NOT evidence that a plpgsql function runs. It was
-- caught by executing the function in a rolled-back transaction right after
-- applying 00527 — the verification, not the deploy, is what found it.
--
-- Fix: declare the threshold as INT, which is what make_interval(mins) wants.

CREATE OR REPLACE FUNCTION public.auto_offline_stale_drivers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_after_min   INT;
  v_user_ids    JSONB;
  v_count       INT := 0;
  v_enabled     TEXT;
  v_service_key TEXT;
BEGIN
  v_after_min := GREATEST(1, get_platform_config_numeric('driver_offline_after_minutes', 10))::int;

  -- Same rows the bare cron command used to touch. RETURNING gives us the
  -- affected drivers in one pass, so there is no second scan and no race
  -- with a driver who reconnects between the UPDATE and the push.
  WITH stale AS (
    UPDATE driver_profiles dp
    SET is_online = false
    WHERE dp.is_online = true
      AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
    RETURNING dp.user_id
  )
  SELECT COALESCE(jsonb_agg(user_id), '[]'::jsonb), COUNT(*)
    INTO v_user_ids, v_count
  FROM stale;

  IF v_count = 0 THEN
    RETURN 0;
  END IF;

  -- Kill switch. Read via #>> '{}' so it matches both a jsonb boolean and a
  -- quoted string (the platform_config jsonb trap).
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'driver_offline_notice_enabled';
  IF v_enabled IN ('false', 'f') THEN
    RETURN v_count;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN v_count;
  END IF;

  -- The notice must never be able to undo the disconnection: the UPDATE above
  -- is the job's actual contract, the push is a courtesy on top.
  BEGIN
    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey',        v_service_key
      ),
      body    := jsonb_build_object(
        'user_ids', v_user_ids,
        'title',    'Quedaste fuera de línea',
        'body',     'Tu app dejó de reportar tu ubicación, así que dejaste de recibir viajes. Abrí TriciGo Conductor y volvé a conectarte.',
        'category', 'system',
        'data', jsonb_build_object('reason', 'stale_heartbeat_auto_offline')
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[auto_offline_stale_drivers] notice failed: % %', SQLSTATE, SQLERRM;
  END;

  RETURN v_count;
END;
$function$;
