-- ============================================================
-- Migration 00531: revoke EXECUTE on nine public RPCs that carry
-- no identity gate of their own and that no client role calls.
--
-- Context: a permissions audit (2026-07-31) started from two RPCs
-- (get_active_push_user_ids, get_delivery_details_for_ride) that
-- looked over-exposed. Both turned out to be CORRECT -- each one
-- enforces its own gate (is_admin() / customer-driver-admin match)
-- and each migration grants EXECUTE to `authenticated` on purpose,
-- because in Supabase an admin session is still the `authenticated`
-- Postgres role. Neither is touched here.
--
-- The sweep that followed found the real problem: SECURITY DEFINER
-- functions with NO gate at all, reachable by `anon` or by any
-- logged-in user. Two distinct root causes, both visible in proacl:
--
--   1. `=X/postgres`  -- an empty grantee means PUBLIC. These
--      functions were created without any REVOKE, so they kept
--      PostgreSQL's default of EXECUTE TO PUBLIC, and `anon`
--      inherits it. (auto_offline_stale_drivers,
--      notify_offline_drivers_for_searching_rides,
--      recompute_cup_from_usd_prices, refund_rate_limit,
--      revalue_anchored_wallets, get_ride_with_coords)
--
--   2. `authenticated=X/postgres` -- an explicit per-role grant
--      from pg_default_acl. Revoking PUBLIC alone does NOT clear
--      it; the role has to be named. (check_fraud_signals,
--      get_driver_weekly_summary, recalc_ride_estimate_with_waypoints)
--
-- Every REVOKE below therefore names PUBLIC, anon AND authenticated,
-- which closes both shapes regardless of which one applies.
--
-- Safety -- verified before writing this migration, not assumed:
--   * Every in-database caller is SECURITY DEFINER (owned by
--     postgres), so internal call paths keep working: inside a
--     SECDEF function the privilege check runs as the definer.
--       check_fraud_signals            <- trg_check_fraud_on_transfer (SECDEF trigger)
--       recompute_cup_from_usd_prices  <- tg_exchange_rate_recompute_prices (SECDEF trigger)
--       recalc_ride_estimate_with_waypoints <- tg_recalc_fare_on_waypoint_change (SECDEF trigger)
--       notify_offline_drivers_for_searching_rides <- retry_dispatch_expired_rides (SECDEF)
--   * cron.job entries 10, 17 and 32 run as `postgres` (the owner),
--     so auto-offline, retry-dispatch and the daily FX revaluation
--     are unaffected.
--   * refund_rate_limit is called only from
--     supabase/functions/_shared/rate-limiter.ts via
--     getServiceClient() -- service_role, which keeps EXECUTE.
--   * get_ride_with_coords and get_driver_weekly_summary have no
--     caller anywhere: not in the apps, not in packages/, not in
--     any other function body.
--   * check_fraud_signals is exported as fraudService.checkFraudSignals
--     but no admin page calls it (only unit tests). If it is ever
--     wired into the admin UI it must be called through an edge
--     function (service_role) or given an is_admin() gate first --
--     it reads another user's transfer/recharge/cancellation
--     behaviour and must not become a per-user oracle.
-- ============================================================

-- ------------------------------------------------------------
-- A. Money and pricing entry points reachable by `anon`
--
-- revalue_anchored_wallets() writes ledger_transactions and
-- ledger_entries and moves platform_fx_reserve. Its per-account
-- idempotency key is fx_reval:<account>:<YYYYMMDD> (UTC), and cron
-- job 32 runs it at 04:30 UTC. An anonymous caller could therefore
-- burn the day's idempotency slot at a moment of its choosing --
-- pinning that day's revaluation to a hand-picked exchange rate and
-- making the scheduled 04:30 run a no-op. Bounded by the daily key
-- and the 1-CUP dead-band, but it is still an outsider steering
-- when everyone's balance gets repriced.
--
-- recompute_cup_from_usd_prices() rewrites every CUP column in
-- service_type_configs and pricing_rules from the USD columns. The
-- caller cannot choose the rate, so it cannot set arbitrary prices,
-- but it can clobber any out-of-band CUP override back to the
-- USD-derived value at will.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.revalue_anchored_wallets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revalue_anchored_wallets() TO service_role;

REVOKE ALL ON FUNCTION public.recompute_cup_from_usd_prices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_cup_from_usd_prices() TO service_role;

-- ------------------------------------------------------------
-- B. The rate-limit control plane
--
-- refund_rate_limit(key, window_seconds) decrements the counter for
-- an arbitrary key and is reachable by `anon`. Keys in rate_limits
-- are guessable by construction -- 'send-sms-otp:<phone>',
-- 'verify-otp:<phone>', 'link-phone:<phone>' -- and the window is a
-- small search space (60/300/900/3600/86400). Draining
-- 'send-sms-otp:<phone>' turns TriciGo into an SMS pump against any
-- Cuban number (real D7 spend); draining 'verify-otp:<phone>'
-- removes the ceiling that keeps a 6-digit OTP from being brute
-- forced, which is an account-takeover path.
--
-- This is the finding with the clearest exploit in the sweep.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.refund_rate_limit(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_rate_limit(text, integer) TO service_role;

-- ------------------------------------------------------------
-- C. Readers that hand over other people's data with no gate
--
-- get_ride_with_coords(ride_id) returns to_jsonb(rides.*) plus exact
-- pickup/dropoff coordinates for ANY ride id, to `anon`, bypassing
-- RLS. Ride ids are UUIDs so this is not enumerable, but the whole
-- reason share tokens exist (get_shared_ride_by_token and friends)
-- is so that holding a ride id is not the same as holding the trip.
--
-- get_driver_weekly_summary(driver_profile_id) returns a driver's
-- email, full name, weekly completed-ride count, weekly gross fares,
-- distance and rating. rides.driver_id IS a driver_profiles.id and
-- riders can see it on their own rides, so any logged-in passenger
-- who has ridden with a driver can pull that driver's email and
-- weekly earnings.
--
-- check_fraud_signals(user_id) reports transfer velocity, recharge
-- velocity and cancellation rate for an arbitrary user id.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_ride_with_coords(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ride_with_coords(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_weekly_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_weekly_summary(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_fraud_signals(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_fraud_signals(uuid) TO service_role;

-- ------------------------------------------------------------
-- D. Mutating maintenance routines reachable directly
--
-- These are cron/trigger bodies, not APIs. Their damage is bounded
-- by their own thresholds and cooldowns, but nothing about them
-- belongs in a client's reach.
--
-- recalc_ride_estimate_with_waypoints(ride_id) recomputes and
-- rewrites the fare of any ride still in an active status. The
-- recomputation is derived from that ride's own waypoints, so a
-- caller cannot pick a number -- but it should not be possible for
-- a stranger to reprice someone else's trip at all, least of all in
-- a codebase whose pricing contract is "the snapshot is the price".
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.auto_offline_stale_drivers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_offline_stale_drivers() TO service_role;

REVOKE ALL ON FUNCTION public.notify_offline_drivers_for_searching_rides() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_offline_drivers_for_searching_rides() TO service_role;

REVOKE ALL ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_ride_estimate_with_waypoints(uuid) TO service_role;

-- ============================================================
-- Verification -- expect nine rows, every anon and auth column false.
--
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
--          has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc
--   FROM pg_proc p
--   WHERE p.pronamespace = 'public'::regnamespace
--     AND p.proname IN ('revalue_anchored_wallets','recompute_cup_from_usd_prices',
--                       'refund_rate_limit','get_ride_with_coords',
--                       'get_driver_weekly_summary','check_fraud_signals',
--                       'auto_offline_stale_drivers','recalc_ride_estimate_with_waypoints',
--                       'notify_offline_drivers_for_searching_rides')
--   ORDER BY p.proname;
--
-- Rollback for any single function, if a caller turns up that this
-- audit missed:
--   GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO authenticated;
-- ============================================================
