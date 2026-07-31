-- 00527_driver_offline_notice.sql
--
-- Tell the driver when we take them off line. Today we do it in silence.
--
-- WHY. Measured on 7 days of `audit_log` (2026-07-31): **142 forced
-- disconnections vs 56 voluntary ones** — nearly three out of four times a
-- driver goes off line, they did not ask for it. Their app simply stopped
-- reporting (Leonardo: 45 minutes of perfect 60s heartbeats, then a clean
-- stop at 20:30:20 and nothing — no degradation, no retries, so the process
-- died rather than the network flapping) and cron 10 flipped `is_online` to
-- false 10-15 minutes later. It is systemic, not one device: 15+ drivers,
-- median dying session 37 minutes, and almost nobody uses the manual toggle
-- (William 16 forced / 0 manual, Rey 14 / 0, Leonardo 9 / 0).
--
-- The root cause of the silence is still being confirmed on a real handset
-- (most likely the "Always" background-location permission, which Android 11+
-- will not grant from the system dialog — the user must walk into Settings).
-- THIS MIGRATION DOES NOT FIX THAT. It fixes a separate, unconditional
-- defect: whatever kills the app, the driver is never told. They believe they
-- are available, wonder why no rides come in, and only find out by reopening
-- the app.
--
-- WHAT. cron 10 stops being a bare UPDATE and becomes
-- `auto_offline_stale_drivers()`, which flips the same rows and then pushes
-- the affected drivers a notice. Two knobs, no redeploy needed to tune:
--   * `driver_offline_after_minutes` (10) — the staleness threshold, until now
--     hardcoded in the cron command itself.
--   * `driver_offline_notice_enabled` (true) — kill switch for the push.
--
-- Category is `system` on purpose, and the choice is load-bearing on both
-- counts: `system` is NOT in send-push's FILTERABLE_CATEGORY_TO_PREF, so an
-- operational notice is never dropped by a marketing opt-out; and the driver
-- app's notification router maps `system` to `/(tabs)` — the home tab that
-- holds the on/off toggle, i.e. exactly where "tap to go back online" must
-- land. `ride_matching` would have been the semantic pick but it has no case
-- in that switch, so tapping it would not navigate anywhere useful.

-- ============================================================
-- Config
-- ============================================================
INSERT INTO platform_config (key, value) VALUES
  ('driver_offline_after_minutes',  '10'::jsonb),
  ('driver_offline_notice_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- The job itself
-- ============================================================
CREATE OR REPLACE FUNCTION public.auto_offline_stale_drivers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_after_min   NUMERIC;
  v_user_ids    JSONB;
  v_count       INT := 0;
  v_enabled     TEXT;
  v_service_key TEXT;
BEGIN
  v_after_min := GREATEST(1, get_platform_config_numeric('driver_offline_after_minutes', 10));

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

-- ============================================================
-- Point cron 10 at the function. pg_cron upserts by jobname, so this
-- replaces the bare UPDATE while keeping the same name and cadence.
-- ============================================================
SELECT cron.schedule(
  'auto-offline-stale-drivers',
  '*/5 * * * *',
  $cron$SELECT public.auto_offline_stale_drivers();$cron$
);
