-- ============================================================
-- Migration 00348: lock down EXECUTE on SECURITY DEFINER functions
--
-- Supabase security advisors (lints 0028 / 0029) plus a manual review
-- found that ~157 SECURITY DEFINER functions in `public` were
-- EXECUTE-able by the `anon` (unauthenticated) role through PostgREST
-- (`/rest/v1/rpc/<fn>`). 88 of them had NO internal authorization check,
-- so an UNauthenticated caller could:
--   - read admin dashboards + the platform's total money in circulation
--     (get_admin_dashboard_metrics, get_admin_wallet_stats),
--   - read ANY user's wallet balance / spend history (get_wallet_summary,
--     get_driver_quota_status),
--   - track ANY driver's live GPS (get_driver_position),
--   - harvest user emails + names (get_users_with_anniversary_today),
--   - invoke money-mutation and trigger helpers directly.
--
-- This removes that exposure WITHOUT breaking the apps:
--   - The mobile/web apps call these RPCs as the `authenticated` role, so
--     app-facing functions keep `authenticated` (and `service_role`)
--     EXECUTE; we only strip `anon` + `PUBLIC`.
--   - Trigger functions and purely-internal helpers are stripped from
--     every client role (they run as the table owner / are only called by
--     other SECURITY DEFINER functions, which also run as owner).
--   - A curated allowlist of genuinely public functions (address / POI
--     search, price estimate, public share-link readers, config reads,
--     marketing aggregate) keeps `anon` EXECUTE so logged-out web flows
--     keep working.
--
-- NOTE (Postgres gotcha): the default grant on a function is to PUBLIC,
-- which anon + authenticated inherit. To revoke anon while keeping
-- authenticated, we REVOKE FROM PUBLIC and then GRANT the roles we want
-- back explicitly.
--
-- Safe to re-run.
-- ============================================================

-- 1) Trigger functions — never meant to be callable as RPC. Revoke from
--    every client role; triggers fire as the table owner regardless.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND pg_get_function_result(p.oid) = 'trigger'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', r.sig);
  END LOOP;
END $$;

-- 2) Purely-internal SECURITY DEFINER helpers. Verified there is no
--    direct caller in the app code: they are only invoked by other
--    SECURITY DEFINER functions (which run as owner) or by Edge Functions
--    / cron via the service_role key (which we grant back below). No
--    client role needs to reach these.
DO $$
DECLARE
  r record;
  internal text[] := ARRAY[
    '_internal_api_headers',
    'fix_null_auth_tokens',             -- called by verify-otp EF (service_role)
    'cleanup_old_notifications',
    'cleanup_orphan_searching_rides',
    'cleanup_rate_limits',
    'rls_auto_enable',
    'insert_cuba_admin_area',
    'log_rpc_attempt',
    'deduct_driver_quota',              -- only called inside complete_ride_and_pay
    'apply_cancellation_fee',
    'apply_cancellation_penalty',
    'apply_cargo_bonus',
    'maybe_promote_user_level',
    'get_users_with_anniversary_today'  -- called by behavioral-emails EF (service_role)
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY(internal)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END $$;

-- 3) Every other SECURITY DEFINER function currently reachable by `anon`:
--    strip `anon` + `PUBLIC`, keep `authenticated` + `service_role`.
--    The allowlist below stays anon-callable for logged-out web flows.
DO $$
DECLARE
  r record;
  public_allow text[] := ARRAY[
    -- address / POI / vehicle search shown before login
    'search_streets','search_pois','search_pois_smart','suggest_cross_streets',
    'find_intersection_point','get_nearest_cross_streets','nearest_poi','lookup_nearest_poi',
    'pois_in_viewport','find_nearby_vehicles','count_online_drivers',
    -- price estimate on the public landing page
    'calculate_ride_distance','calculate_surge','calculate_dynamic_surge',
    'get_surge_multiplier','calculate_wait_charge','get_pricing_variant',
    'preview_cancellation_penalty',
    -- public config reads
    'get_platform_config_text','get_platform_config_numeric',
    -- public share / track links (opened by anyone holding the URL)
    'get_shared_ride_by_token','get_ride_waypoints_by_share_token',
    'get_public_delivery_by_token','get_shared_trip_state','get_ride_with_coords',
    -- marketing aggregate
    'get_global_review_stats'
  ];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND pg_get_function_result(p.oid) <> 'trigger'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND p.proname <> ALL(public_allow)
      AND p.proname NOT LIKE 'st\_%'   -- leave PostGIS extension functions untouched
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $$;
