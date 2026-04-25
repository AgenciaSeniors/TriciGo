-- ============================================================
-- BUG-164: 16 SECURITY DEFINER functions in `public` schema
-- have no explicit search_path. A malicious user with CREATE
-- privileges on any schema (or who can manipulate session-level
-- search_path before calling) can hijack unqualified function /
-- table references inside the SECDEF body and run code as the
-- function owner (postgres → bypass RLS).
--
-- Concrete attack: `SET search_path = pg_temp, public;` then call
-- admin_adjust_wallet which references `wallet_accounts` unqualified.
-- A pg_temp.wallet_accounts view with the same shape but pointing
-- at attacker-controlled data could trick the function into
-- crediting the wrong account.
--
-- Fix: ALTER FUNCTION ... SET search_path = public, pg_catalog
-- on every SECDEF in public. The pg_catalog last is intentional —
-- core types/functions (now(), uuid_generate_v4) still resolve.
-- pg_temp is intentionally NOT in search_path: temp-schema hijacks
-- are the main vector here.
--
-- Excluded: PostGIS-owned `st_estimatedextent` overloads (not ours).
-- ============================================================

ALTER FUNCTION public._internal_api_headers() SET search_path = public, pg_catalog;
ALTER FUNCTION public.admin_adjust_wallet(uuid, wallet_account_type, integer, text, uuid) SET search_path = public, pg_catalog;
ALTER FUNCTION public.admin_grant_grace_trips(uuid, integer, uuid, text) SET search_path = public, pg_catalog;
ALTER FUNCTION public.admin_refund_ride_commission(uuid, uuid, text) SET search_path = public, pg_catalog;
ALTER FUNCTION public.auto_cancel_stale_searching_rides() SET search_path = public, pg_catalog;
ALTER FUNCTION public.calculate_ride_distance(uuid) SET search_path = public, pg_catalog;
ALTER FUNCTION public.calculate_wait_charge(uuid) SET search_path = public, pg_catalog;
ALTER FUNCTION public.can_send_sms(uuid, integer) SET search_path = public, pg_catalog;
ALTER FUNCTION public.check_accept_ride_eligibility(uuid) SET search_path = public, pg_catalog;
ALTER FUNCTION public.check_proximity_notification() SET search_path = public, pg_catalog;
ALTER FUNCTION public.deduct_driver_quota(uuid, uuid, integer) SET search_path = public, pg_catalog;
ALTER FUNCTION public.enforce_ride_transition() SET search_path = public, pg_catalog;
ALTER FUNCTION public.ensure_wallet_account(uuid, wallet_account_type) SET search_path = public, pg_catalog;
ALTER FUNCTION public.increment_experiment_rides(uuid, text) SET search_path = public, pg_catalog;
ALTER FUNCTION public.increment_promo_uses(uuid) SET search_path = public, pg_catalog;
ALTER FUNCTION public.upsert_exchange_rate(text, numeric, timestamp with time zone) SET search_path = public, pg_catalog;
