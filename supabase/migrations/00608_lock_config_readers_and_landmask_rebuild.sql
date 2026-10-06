-- ============================================================
-- 00608 — Stop the public API key from reading platform_config secrets
--         through the config helper functions
--
-- WHY
--
-- 00517 hid the secret rows of platform_config (eltoque_api_token,
-- openweather_api_key, the NETOPIA signatures, ...) from anon and from
-- non-admin users: the pc_select policy only returns them to admins. It left
-- a second path open. get_platform_config_text and get_platform_config_numeric
-- are SECURITY DEFINER, so they read platform_config as their owner and the
-- policy does not apply to them, and 00348 had kept them executable by anon
-- ("public config reads", back when the table itself was public). Measured on
-- 2026-10-06, as anon:
--
--   SELECT ... FROM platform_config WHERE key = 'openweather_api_key'  -> 0 rows
--   get_platform_config_text('openweather_api_key', NULL)              -> the 32-character key
--
-- Anyone holding the publishable key, which ships in every app build and in
-- the web bundle, can call POST /rest/v1/rpc/get_platform_config_text for any
-- key. No such call shows up in the edge logs (24 h retained), which does not
-- prove there was none.
--
-- Nothing outside the database needs these two functions: no app, web page or
-- Edge Function has ever called them over the API (git history of apps/ and
-- packages/, and supabase/functions/ on master). The 29 SQL functions that call
-- them are all SECURITY DEFINER owned by postgres, so they keep working; no
-- view, policy, column default or cron job calls them.
--
-- Two smaller ones in the same pass:
--
--   * refresh_cuba_landmask() (00575) kept the default EXECUTE for PUBLIC, so
--     anyone could empty and rebuild cuba_landmask, an ST_Union of every
--     province. Nothing calls it; it is a maintenance step for the operator.
--   * preview_cancellation_penalty(uuid) is the retired money-based preview
--     (00373). It takes any user id and returns that user's cancellations in
--     the last 24 h. Client builds from before 2026-06-03 (#387) still call it
--     with a session, so only anon and PUBLIC lose it; authenticated keeps it.
--
-- WHAT
--
-- REVOKE EXECUTE from PUBLIC, anon and authenticated (authenticated keeps
-- preview_cancellation_penalty); service_role keeps all four. The closing block
-- asserts the end state over every overload of each name, and checks as anon
-- that a SECURITY DEFINER caller (get_weather_surge) still reads its config.
--
-- Revoking does not undo what may already have been read. The secrets in
-- platform_config were readable this way, and before 00517 (2026-07-27)
-- straight from the table; none of them has been rotated since. They have to
-- be rotated by hand, at each provider.
--
-- Idempotent: REVOKE and GRANT are no-ops when repeated.
-- ============================================================

SET lock_timeout = '5s';

REVOKE EXECUTE ON FUNCTION public.get_platform_config_text(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_platform_config_numeric(text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_cuba_landmask() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.preview_cancellation_penalty(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_platform_config_text(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric(text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_cuba_landmask() TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_cancellation_penalty(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_platform_config_text(text, text) IS
  'Reads a platform_config value as its owner, bypassing the pc_select policy, so secret keys come back too. Server-side only: no EXECUTE for PUBLIC, anon or authenticated (00608).';
COMMENT ON FUNCTION public.get_platform_config_numeric(text, numeric) IS
  'Reads a numeric platform_config value as its owner, bypassing the pc_select policy. Server-side only: no EXECUTE for PUBLIC, anon or authenticated (00608).';

-- Assert the end state ----------------------------------------------------
DO $check$
DECLARE
  r record;
  v_found int := 0;
  v_surge numeric;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('get_platform_config_text', 'get_platform_config_numeric',
                        'refresh_cuba_landmask', 'preview_cancellation_penalty')
  LOOP
    v_found := v_found + 1;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00608: anon can still execute %', r.sig;
    END IF;
    IF r.proname <> 'preview_cancellation_penalty' AND has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00608: authenticated can still execute %', r.sig;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '00608: service_role lost EXECUTE on %', r.sig;
    END IF;
  END LOOP;
  IF v_found <> 4 THEN
    RAISE EXCEPTION '00608: expected 4 functions, found %', v_found;
  END IF;

  -- A SECURITY DEFINER caller run as anon still reads config: it calls
  -- get_platform_config_numeric as its owner. The block always raises, so the
  -- role change is rolled back.
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', '', true);
    SET LOCAL ROLE anon;
    v_surge := public.get_weather_surge();
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '00608_probe_ok:' || coalesce(v_surge::text, 'null');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '00608_probe_ok:%' OR SQLERRM = '00608_probe_ok:null' THEN
      RAISE EXCEPTION '00608: get_weather_surge as anon failed (%)', SQLERRM;
    END IF;
  END;
END
$check$;

RESET lock_timeout;
