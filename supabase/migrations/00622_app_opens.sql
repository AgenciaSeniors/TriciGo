-- ============================================================
-- 00622 — the apps report their version every time they open
--
-- WHY
--   The only record of which app version someone runs is
--   user_known_devices.app_version, written by register-login-device right
--   after an OTP login. Almost nobody logs in again after an update, so a
--   row keeps the version of its last login: on 2026-10-06 the 14 riders
--   active in the last 30 days showed versions from 1.0.5 to 1.7.3, plus
--   two with no row at all. That cannot tell when the builds that still
--   withdraw split invites with a direct DELETE (client <= 1.7.3, see 00620)
--   are gone, or answer any other "who still runs build X" question.
--   register-login-device cannot simply be called on every open: for a
--   device it has not seen it records the device and, when the account
--   already had another one, emails a "new login" alert. Opening an app
--   that logged in before devices were tracked would send that mail
--   without any login, and an open recorded before the login's own call
--   would swallow the alert of a real new login.
--
-- WHAT
--   1. app_opens: one row per account, app ('client' or 'driver') and
--      install (the per-install id the apps keep in the keychain), with the
--      version and platform of the last open and when it was. Nothing else.
--      RLS on and no policies: only report_app_open writes it, and it is
--      read with the service role or from SQL.
--   2. report_app_open(p_app, p_device_id, p_app_version, p_platform):
--      signed-in users only. Updates the caller's row for that install, or
--      records it. Never emails and never touches user_known_devices. An
--      account keeps at most 20 installs per app (each reinstall is a new
--      id); beyond that it answers 'capped' and records nothing. Answers
--      'recorded', 'updated', 'capped' or 'invalid'.
--   The apps call it when they start with a session and when they come back
--   to the foreground at least 6 hours after the last report.
--
--   Who still runs a build at most X, among those who opened an app in the
--   last 14 days:
--     SELECT app, app_version, count(*) FROM public.app_opens
--     WHERE last_opened_at > now() - interval '14 days' GROUP BY 1, 2;
--   Builds released before this one do not report: an account active in
--   that window with no row from a newer build is on an older build or on
--   the web.
--
-- New table, so GRANTs in this file (CLAUDE.md § "Tablas nuevas en public").
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.app_opens (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  app text NOT NULL CHECK (app IN ('client', 'driver')),
  device_id text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
  app_version text CHECK (length(app_version) <= 32),
  platform text CHECK (length(platform) <= 32),
  first_opened_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app, device_id)
);

CREATE INDEX IF NOT EXISTS app_opens_app_last_opened_idx
  ON public.app_opens (app, last_opened_at DESC);

ALTER TABLE public.app_opens ENABLE ROW LEVEL SECURITY;

-- Lock table: no policies, and no access for the API roles. Until
-- 2026-10-30 prod still grants every new table to anon and authenticated,
-- so take it back explicitly.
REVOKE ALL ON public.app_opens FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_opens TO service_role;

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.report_app_open(text, text, text, text)');
  IF v_md5 IS NOT NULL AND v_md5 <> '2537b264463957821eada9e48b7f59d7' THEN -- 00622 report
    RAISE EXCEPTION '00622: unexpected body of report_app_open (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.report_app_open(
  p_app text, p_device_id text, p_app_version text, p_platform text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_version text := left(nullif(btrim(p_app_version), ''), 32);
  v_platform text := left(nullif(btrim(p_platform), ''), 32);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'report_app_open needs a signed-in user';
  END IF;
  IF p_app IS NULL OR p_app NOT IN ('client', 'driver')
     OR p_device_id IS NULL OR btrim(p_device_id) = '' OR length(p_device_id) > 128 THEN
    RETURN 'invalid';
  END IF;

  UPDATE public.app_opens
  SET last_opened_at = now(), app_version = v_version, platform = v_platform
  WHERE user_id = v_uid AND app = p_app AND device_id = p_device_id;
  IF FOUND THEN
    RETURN 'updated';
  END IF;

  -- A new install. Each reinstall gets a new id, so cap how many one
  -- account keeps per app.
  IF (SELECT count(*) FROM public.app_opens WHERE user_id = v_uid AND app = p_app) >= 20 THEN
    RETURN 'capped';
  END IF;

  INSERT INTO public.app_opens (user_id, app, device_id, app_version, platform)
  VALUES (v_uid, p_app, p_device_id, v_version, v_platform)
  ON CONFLICT (user_id, app, device_id) DO UPDATE
    SET last_opened_at = now(), app_version = EXCLUDED.app_version, platform = EXCLUDED.platform;
  RETURN 'recorded';
END;
$function$;

REVOKE ALL ON FUNCTION public.report_app_open(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_app_open(text, text, text, text) TO authenticated, service_role;

-- Assert the end state.
DO $check$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_opens'::regclass) THEN
    RAISE EXCEPTION '00622: app_opens must have RLS on';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.app_opens'::regclass) THEN
    RAISE EXCEPTION '00622: app_opens must have no policies';
  END IF;
  IF has_table_privilege('anon', 'public.app_opens', 'SELECT')
     OR has_table_privilege('authenticated', 'public.app_opens', 'SELECT')
     OR has_table_privilege('authenticated', 'public.app_opens', 'INSERT')
     OR has_table_privilege('authenticated', 'public.app_opens', 'UPDATE') THEN
    RAISE EXCEPTION '00622: the API roles must have no access to app_opens';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.app_opens', 'INSERT') THEN
    RAISE EXCEPTION '00622: service_role must be able to write app_opens';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.report_app_open(text, text, text, text)'::regprocedure) THEN
    RAISE EXCEPTION '00622: report_app_open is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.report_app_open(text, text, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.report_app_open(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '00622: report_app_open must be callable by signed-in users only';
  END IF;
END
$check$;

RESET lock_timeout;
