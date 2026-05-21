-- ============================================================
-- Migration 00282: Auto-cancel stuck post-search active rides
--
-- Problem: PR #135 + migration 00269_persistent_ride_search closed
-- the cleanup gap for `searching` rides (rider-heartbeat-driven
-- cleanup_orphan_searching_rides cron). But ZERO auto-cleanup
-- exists for the remaining active statuses:
--   accepted, driver_en_route, arrived_at_pickup, in_progress,
--   arrived_at_destination
--
-- Confirmed in prod (2026-05-21): a test ride sat in `in_progress`
-- for 2 days because the trip never closed cleanly. App kill-9,
-- lost connectivity, driver/rider walk-away all leave the ride
-- pinned in an active status forever, blocking the
-- one-active-ride-per-customer guard (00231) from letting either
-- side start a new trip.
--
-- Fix: cleanup_stale_active_rides() scans the 4 post-search active
-- statuses and cancels by timeout per phase using the timestamp
-- that marked entry into that phase. Thresholds are tunable via
-- platform_config; defaults are generous so legitimate long waits
-- / long Cuban-distance trips aren't killed.
--
-- NOT covered (intentional, owned by sibling crons):
--   - `searching`            — cleanup_orphan_searching_rides (00269)
--   - ride_offers expiry     — expire-ride-offers (00120)
--
-- Wallet / payment safety: rides settle in complete_ride_and_pay
-- (post-completion). Pre-completion cancels do NOT touch wallets,
-- so this auto-cancel does NOT need to refund — there's nothing to
-- refund. Cash rides have no wallet effect either. Verified by
-- inspection: only complete_ride_and_pay writes ledger entries
-- against a ride.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_stale_active_rides()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_pre_pickup_min   int;   -- 'accepted' / 'driver_en_route' max age since accepted_at
  v_arrived_min      int;   -- 'arrived_at_pickup' max age since driver_arrived_at
  v_in_progress_min  int;   -- 'in_progress' hard cap since pickup_at
  v_destination_min  int;   -- 'arrived_at_destination' max wait for tap-Finalizar

  v_pre_pickup   int := 0;
  v_arrived      int := 0;
  v_in_progress  int := 0;
  v_destination  int := 0;
BEGIN
  -- Thresholds (minutes). Defaults chosen to be loose on purpose.
  SELECT ((value #>> '{}')::int) INTO v_pre_pickup_min
  FROM platform_config WHERE key = 'stale_pre_pickup_minutes';
  v_pre_pickup_min := COALESCE(v_pre_pickup_min, 30);

  SELECT ((value #>> '{}')::int) INTO v_arrived_min
  FROM platform_config WHERE key = 'stale_arrived_pickup_minutes';
  v_arrived_min := COALESCE(v_arrived_min, 20);

  SELECT ((value #>> '{}')::int) INTO v_in_progress_min
  FROM platform_config WHERE key = 'stale_in_progress_minutes';
  v_in_progress_min := COALESCE(v_in_progress_min, 360);  -- 6h

  SELECT ((value #>> '{}')::int) INTO v_destination_min
  FROM platform_config WHERE key = 'stale_destination_minutes';
  v_destination_min := COALESCE(v_destination_min, 60);

  -- 1) accepted / driver_en_route — driver assigned/moving, never reached pickup
  WITH stale AS (
    SELECT id FROM public.rides
    WHERE status IN ('accepted', 'driver_en_route')
      AND accepted_at IS NOT NULL
      AND accepted_at < now() - (v_pre_pickup_min || ' minutes')::interval
      AND driver_arrived_at IS NULL
      AND pickup_at IS NULL
  )
  UPDATE public.rides
  SET status = 'canceled',
      cancellation_reason = 'stale_pre_pickup_auto_canceled',
      canceled_at = now()
  WHERE id IN (SELECT id FROM stale);
  GET DIAGNOSTICS v_pre_pickup = ROW_COUNT;

  -- 2) arrived_at_pickup — driver arrived but trip never started (no-show)
  WITH stale AS (
    SELECT id FROM public.rides
    WHERE status = 'arrived_at_pickup'
      AND driver_arrived_at IS NOT NULL
      AND driver_arrived_at < now() - (v_arrived_min || ' minutes')::interval
      AND pickup_at IS NULL
  )
  UPDATE public.rides
  SET status = 'canceled',
      cancellation_reason = 'stale_arrived_pickup_no_pickup',
      canceled_at = now()
  WHERE id IN (SELECT id FROM stale);
  GET DIAGNOSTICS v_arrived = ROW_COUNT;

  -- 3) in_progress — trip in flight too long without arriving at destination
  WITH stale AS (
    SELECT id FROM public.rides
    WHERE status = 'in_progress'
      AND pickup_at IS NOT NULL
      AND pickup_at < now() - (v_in_progress_min || ' minutes')::interval
      AND arrived_at_destination_at IS NULL
      AND completed_at IS NULL
  )
  UPDATE public.rides
  SET status = 'canceled',
      cancellation_reason = 'stale_in_progress_auto_canceled',
      canceled_at = now()
  WHERE id IN (SELECT id FROM stale);
  GET DIAGNOSTICS v_in_progress = ROW_COUNT;

  -- 4) arrived_at_destination — driver forgot to tap "Finalizar viaje"
  WITH stale AS (
    SELECT id FROM public.rides
    WHERE status = 'arrived_at_destination'
      AND arrived_at_destination_at IS NOT NULL
      AND arrived_at_destination_at < now() - (v_destination_min || ' minutes')::interval
      AND completed_at IS NULL
  )
  UPDATE public.rides
  SET status = 'canceled',
      cancellation_reason = 'stale_destination_not_completed',
      canceled_at = now()
  WHERE id IN (SELECT id FROM stale);
  GET DIAGNOSTICS v_destination = ROW_COUNT;

  RETURN jsonb_build_object(
    'pre_pickup_canceled',     v_pre_pickup,
    'arrived_pickup_canceled', v_arrived,
    'in_progress_canceled',    v_in_progress,
    'destination_canceled',    v_destination,
    'total',                   v_pre_pickup + v_arrived + v_in_progress + v_destination
  );
END;
$$;

-- Cron-only (mirrors auto_cancel_stale_searching_rides lockdown from 00212):
-- no client should ever invoke this — bulk row mutator on production rides.
REVOKE EXECUTE ON FUNCTION public.cleanup_stale_active_rides() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cleanup_stale_active_rides() TO service_role;

COMMENT ON FUNCTION public.cleanup_stale_active_rides() IS
  'Auto-cancels rides stuck in non-searching active phases. Cron-driven, 5-min interval. Thresholds tunable via platform_config keys: stale_pre_pickup_minutes (def 30), stale_arrived_pickup_minutes (def 20), stale_in_progress_minutes (def 360), stale_destination_minutes (def 60). Pairs with cleanup_orphan_searching_rides (00269) to fully cover the active-ride lifecycle.';

-- Schedule via pg_cron (idempotent — unschedule before re-creating)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('cleanup_stale_active_rides') WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'cleanup_stale_active_rides'
    );
    PERFORM cron.schedule(
      'cleanup_stale_active_rides',
      '*/5 * * * *',
      $job$SELECT public.cleanup_stale_active_rides();$job$
    );
  END IF;
END $$;
