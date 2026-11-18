-- ============================================================
-- 00689 — which drivers can the app open by itself on a ride offer
--
-- WHY
--   Since July 2026 (PR #807, PR #817) the Android driver app comes to the
--   front by itself when an offer arrives: send-push adds a data-only push
--   that wakes a background task, which relaunches the app. Android only
--   allows it when the driver granted "Display over other apps"
--   (SYSTEM_ALERT_WINDOW). On 2026-11-18 it reached few drivers:
--     - the app asked for the permission once; "Ahora no" was forever;
--     - Xiaomi, Redmi and POCO phones add a second permission of their own,
--       off by default and invisible to canDrawOverlays(). 57 of the 185
--       approved Android drivers with a known model (31 %) use one;
--     - nothing told the server who had the permission or whether a launch
--       reached the front. In the 30 days to 2026-11-18, 145 of the 250
--       offers sent to Android drivers expired unanswered.
--   Spec: docs/superpowers/specs/2026-11-18-driver-offer-autoopen-reach-design.md
--
-- WHAT
--   1. driver_overlay_status: one row per account and install (the per-install
--      id the app keeps in the keychain) with the phone's maker, Android and
--      app versions, whether the native module is in the binary, whether the
--      permission is granted, whether the Xiaomi step is done, and counters of
--      launch results. Lock table: RLS on, no policies, read with the service
--      role or from SQL.
--   2. report_driver_overlay(...): signed-in accounts with a driver_profiles
--      row only. A NULL launch result is a plain status report; otherwise it
--      also bumps that result's counter. An account keeps at most 20 installs;
--      beyond that it answers 'capped'. Answers 'recorded', 'updated',
--      'capped' or 'invalid'.
--   Launch results: 'foreground' (the app reached the front within 4 s),
--   'not_foreground' (it did not: blocked, or the screen was off so it opened
--   behind the lock screen; read by brand, not as proof for one phone),
--   'no_permission' (no launch: the permission is missing).
--
--   Android drivers who reported in the last 14 days, with the permission, by brand:
--     SELECT lower(coalesce(brand, manufacturer)) AS brand, count(*) AS installs,
--            count(*) FILTER (WHERE overlay_granted) AS granted
--     FROM public.driver_overlay_status
--     WHERE updated_at > now() - interval '14 days' AND module_available
--     GROUP BY 1 ORDER BY 2 DESC;
--   Do launches reach the front, by brand:
--     SELECT lower(coalesce(brand, manufacturer)) AS brand,
--            sum(launches_foreground) AS ok, sum(launches_not_foreground) AS not_seen,
--            sum(launches_no_permission) AS no_permission
--     FROM public.driver_overlay_status GROUP BY 1 ORDER BY 2 DESC;
--
-- New table, so GRANTs in this file (CLAUDE.md § "Tablas nuevas en public").
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.driver_overlay_status (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  manufacturer text CHECK (length(manufacturer) <= 64),
  brand text CHECK (length(brand) <= 64),
  os_version text CHECK (length(os_version) <= 64),
  app_version text CHECK (length(app_version) <= 64),
  module_available boolean NOT NULL,
  overlay_granted boolean NOT NULL,
  xiaomi_ok boolean NOT NULL DEFAULT false,
  launches_foreground integer NOT NULL DEFAULT 0,
  launches_not_foreground integer NOT NULL DEFAULT 0,
  launches_no_permission integer NOT NULL DEFAULT 0,
  last_launch_result text CHECK (last_launch_result IN ('foreground', 'not_foreground', 'no_permission')),
  last_launch_at timestamptz,
  first_reported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS driver_overlay_status_updated_idx
  ON public.driver_overlay_status (updated_at DESC);

ALTER TABLE public.driver_overlay_status ENABLE ROW LEVEL SECURITY;

-- Lock table: no policies, and no access for the API roles. Until
-- 2026-10-30 prod granted every new table to anon and authenticated, so
-- take it back explicitly.
REVOKE ALL ON public.driver_overlay_status FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_overlay_status TO service_role;

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text)');
  IF v_md5 IS NOT NULL AND v_md5 <> '34308e380d17999ebdb6b2f4ab127828' THEN -- 00689 report
    RAISE EXCEPTION '00689: unexpected body of report_driver_overlay (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.report_driver_overlay(
  p_device_id text, p_manufacturer text, p_brand text, p_os_version text, p_app_version text,
  p_module_available boolean, p_overlay_granted boolean, p_xiaomi_ok boolean, p_launch_result text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_manufacturer text := left(nullif(btrim(p_manufacturer), ''), 64);
  v_brand text := left(nullif(btrim(p_brand), ''), 64);
  v_os_version text := left(nullif(btrim(p_os_version), ''), 64);
  v_app_version text := left(nullif(btrim(p_app_version), ''), 64);
  v_fg integer := CASE WHEN p_launch_result = 'foreground' THEN 1 ELSE 0 END;
  v_nfg integer := CASE WHEN p_launch_result = 'not_foreground' THEN 1 ELSE 0 END;
  v_np integer := CASE WHEN p_launch_result = 'no_permission' THEN 1 ELSE 0 END;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'report_driver_overlay needs a signed-in user';
  END IF;
  IF p_device_id IS NULL OR btrim(p_device_id) = '' OR length(p_device_id) > 128
     OR p_module_available IS NULL OR p_overlay_granted IS NULL
     OR (p_launch_result IS NOT NULL
         AND p_launch_result NOT IN ('foreground', 'not_foreground', 'no_permission')) THEN
    RETURN 'invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.driver_profiles WHERE user_id = v_uid) THEN
    RETURN 'invalid';
  END IF;

  UPDATE public.driver_overlay_status
  SET manufacturer = v_manufacturer, brand = v_brand, os_version = v_os_version,
      app_version = v_app_version, module_available = p_module_available,
      overlay_granted = p_overlay_granted, xiaomi_ok = coalesce(p_xiaomi_ok, false),
      launches_foreground = launches_foreground + v_fg,
      launches_not_foreground = launches_not_foreground + v_nfg,
      launches_no_permission = launches_no_permission + v_np,
      last_launch_result = coalesce(p_launch_result, last_launch_result),
      last_launch_at = CASE WHEN p_launch_result IS NULL THEN last_launch_at ELSE now() END,
      updated_at = now()
  WHERE user_id = v_uid AND device_id = p_device_id;
  IF FOUND THEN
    RETURN 'updated';
  END IF;

  -- A new install. Each reinstall gets a new id, so cap how many one
  -- account keeps.
  IF (SELECT count(*) FROM public.driver_overlay_status WHERE user_id = v_uid) >= 20 THEN
    RETURN 'capped';
  END IF;

  INSERT INTO public.driver_overlay_status (
    user_id, device_id, manufacturer, brand, os_version, app_version, module_available,
    overlay_granted, xiaomi_ok, launches_foreground, launches_not_foreground,
    launches_no_permission, last_launch_result, last_launch_at)
  VALUES (
    v_uid, p_device_id, v_manufacturer, v_brand, v_os_version, v_app_version, p_module_available,
    p_overlay_granted, coalesce(p_xiaomi_ok, false), v_fg, v_nfg, v_np, p_launch_result,
    CASE WHEN p_launch_result IS NULL THEN NULL ELSE now() END)
  ON CONFLICT (user_id, device_id) DO UPDATE
    SET manufacturer = EXCLUDED.manufacturer, brand = EXCLUDED.brand,
        os_version = EXCLUDED.os_version, app_version = EXCLUDED.app_version,
        module_available = EXCLUDED.module_available, overlay_granted = EXCLUDED.overlay_granted,
        xiaomi_ok = EXCLUDED.xiaomi_ok,
        launches_foreground = driver_overlay_status.launches_foreground + EXCLUDED.launches_foreground,
        launches_not_foreground = driver_overlay_status.launches_not_foreground + EXCLUDED.launches_not_foreground,
        launches_no_permission = driver_overlay_status.launches_no_permission + EXCLUDED.launches_no_permission,
        last_launch_result = coalesce(EXCLUDED.last_launch_result, driver_overlay_status.last_launch_result),
        last_launch_at = coalesce(EXCLUDED.last_launch_at, driver_overlay_status.last_launch_at),
        updated_at = now();
  RETURN 'recorded';
END;
$function$;

REVOKE ALL ON FUNCTION public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text) TO authenticated, service_role;

-- Assert the end state.
DO $check$
DECLARE
  c_fn constant text := 'public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text)';
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.driver_overlay_status'::regclass) THEN
    RAISE EXCEPTION '00689: driver_overlay_status must have RLS on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.driver_overlay_status'::regclass) THEN
    RAISE EXCEPTION '00689: driver_overlay_status must have no policies';
  END IF;
  IF has_table_privilege('anon', 'public.driver_overlay_status', 'SELECT')
     OR has_table_privilege('authenticated', 'public.driver_overlay_status', 'SELECT')
     OR has_table_privilege('authenticated', 'public.driver_overlay_status', 'INSERT')
     OR has_table_privilege('authenticated', 'public.driver_overlay_status', 'UPDATE') THEN
    RAISE EXCEPTION '00689: the API roles must have no access to driver_overlay_status';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.driver_overlay_status', 'INSERT') THEN
    RAISE EXCEPTION '00689: service_role must be able to write driver_overlay_status';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = c_fn::regprocedure) THEN
    RAISE EXCEPTION '00689: report_driver_overlay is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', c_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '00689: report_driver_overlay must be callable by signed-in users only';
  END IF;
END
$check$;

RESET lock_timeout;
