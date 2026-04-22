-- ============================================================
-- Migration 00149: batch fix for JSONB → numeric/integer casts
--
-- Audit via pg_proc found 3 more functions with the same antipattern
-- that migrations 00146 + 00148 fixed for `complete_ride_and_pay`
-- and `get_driver_earnings_by_zone` respectively:
--   `SELECT (value::TYPE) FROM platform_config WHERE key = '...'`
-- Postgres cannot cast JSONB directly to numeric/integer, so every
-- call raises 22023. These three are dormant right now (scheduled
-- jobs / admin-only RPCs), but they WILL fire:
--
--   1. auto_cancel_stale_searching_rides
--      → reads `search_timeout_seconds` for the stale-ride cancel job.
--   2. deduct_driver_quota
--      → reads `quota_deduction_rate`, `quota_grace_trips`,
--        `quota_warning_threshold_pct` during driver-quota accounting
--        (called on ride completion paths that use the quota model).
--   3. get_platform_earnings
--      → reads `commission_rate` for the admin dashboard stats.
--
-- Fix: replace every `(value::TYPE)` / `pc.value::TYPE` with
-- `(value #>> '{}')::TYPE`, which extracts the JSONB scalar as text
-- first. Zero behavior change otherwise.
-- ============================================================

-- 1) auto_cancel_stale_searching_rides — 1 cast
CREATE OR REPLACE FUNCTION public.auto_cancel_stale_searching_rides()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE v_timeout INTEGER; v_count INTEGER;
BEGIN
  SELECT ((value #>> '{}')::INTEGER) INTO v_timeout FROM platform_config WHERE key = 'search_timeout_seconds';
  v_timeout := COALESCE(v_timeout, 120);
  UPDATE rides SET status='canceled', canceled_at=NOW(), cancellation_reason='search_timeout'
  WHERE status = 'searching' AND created_at < NOW() - (v_timeout || ' seconds')::INTERVAL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- 2) deduct_driver_quota — 3 casts
CREATE OR REPLACE FUNCTION public.deduct_driver_quota(
  p_driver_user_id uuid,
  p_ride_id uuid,
  p_fare_amount integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_quota_account_id UUID; v_platform_account_id UUID; v_quota_balance INTEGER;
  v_deduction_rate NUMERIC; v_deduction_amount INTEGER;
  v_grace_trips INTEGER; v_max_grace INTEGER; v_tx_id UUID; v_new_balance INTEGER;
  v_warning_threshold NUMERIC; v_total_recharged INTEGER; v_warning_active BOOLEAN;
BEGIN
  SELECT ((value #>> '{}')::NUMERIC) INTO v_deduction_rate FROM platform_config WHERE key = 'quota_deduction_rate';
  v_deduction_rate := COALESCE(v_deduction_rate, 0.15);
  v_deduction_amount := ROUND(p_fare_amount * v_deduction_rate);
  IF v_deduction_amount <= 0 THEN RETURN jsonb_build_object('deduction', 0, 'balance', 0, 'blocked', false); END IF;

  SELECT id, balance INTO v_quota_account_id, v_quota_balance
  FROM wallet_accounts WHERE user_id = p_driver_user_id AND account_type = 'driver_quota' FOR UPDATE;
  IF v_quota_account_id IS NULL THEN RAISE EXCEPTION 'Driver quota account not found for user %', p_driver_user_id; END IF;

  SELECT id INTO v_platform_account_id FROM wallet_accounts WHERE account_type = 'platform_revenue' FOR UPDATE LIMIT 1;
  IF v_platform_account_id IS NULL THEN RAISE EXCEPTION 'Platform revenue account not found'; END IF;

  v_tx_id := gen_random_uuid();
  INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES (v_tx_id, 'quota_deduct_' || p_ride_id::TEXT, 'quota_deduction', 'posted', 'ride', p_ride_id, 'Quota deduction', p_driver_user_id);

  v_new_balance := v_quota_balance - v_deduction_amount;
  UPDATE wallet_accounts SET balance = v_new_balance WHERE id = v_quota_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_quota_account_id, -v_deduction_amount, v_new_balance);
  UPDATE wallet_accounts SET balance = balance + v_deduction_amount WHERE id = v_platform_account_id;
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_tx_id, v_platform_account_id, v_deduction_amount, (SELECT balance FROM wallet_accounts WHERE id = v_platform_account_id));

  UPDATE rides SET quota_deduction_amount = v_deduction_amount WHERE id = p_ride_id;

  IF v_new_balance <= 0 THEN
    SELECT ((value #>> '{}')::INTEGER) INTO v_max_grace FROM platform_config WHERE key = 'quota_grace_trips';
    v_max_grace := COALESCE(v_max_grace, 3);
    SELECT grace_trips_remaining INTO v_grace_trips FROM driver_profiles WHERE user_id = p_driver_user_id;
    IF v_grace_trips IS NULL OR v_grace_trips = 0 THEN
      v_grace_trips := v_max_grace - 1;
    ELSE
      v_grace_trips := v_grace_trips - 1;
    END IF;
    UPDATE driver_profiles SET grace_trips_remaining = v_grace_trips, quota_blocked = (v_grace_trips <= 0) WHERE user_id = p_driver_user_id;
  END IF;

  SELECT ((value #>> '{}')::NUMERIC) INTO v_warning_threshold FROM platform_config WHERE key = 'quota_warning_threshold_pct';
  v_warning_threshold := COALESCE(v_warning_threshold, 0.20);
  SELECT COALESCE(SUM(ABS(amount)), 0) INTO v_total_recharged
  FROM ledger_entries le JOIN ledger_transactions lt ON lt.id = le.transaction_id
  WHERE le.account_id = v_quota_account_id AND lt.type = 'quota_recharge' AND le.amount > 0;
  v_warning_active := v_total_recharged > 0 AND v_new_balance > 0 AND (v_new_balance::NUMERIC / v_total_recharged) <= v_warning_threshold;

  RETURN jsonb_build_object(
    'deduction', v_deduction_amount, 'balance', GREATEST(v_new_balance, 0), 'balance_raw', v_new_balance,
    'grace_trips_remaining', COALESCE((SELECT grace_trips_remaining FROM driver_profiles WHERE user_id = p_driver_user_id), 0),
    'blocked', COALESCE((SELECT quota_blocked FROM driver_profiles WHERE user_id = p_driver_user_id), false),
    'warning_active', v_warning_active, 'deduction_rate', v_deduction_rate
  );
END;
$function$;

-- 3) get_platform_earnings — 1 cast
CREATE OR REPLACE FUNCTION public.get_platform_earnings()
RETURNS TABLE(platform_balance bigint, earnings_today bigint, earnings_this_week bigint, earnings_this_month bigint, commission_rate numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    COALESCE((
      SELECT wa.balance FROM wallet_accounts wa
      WHERE wa.user_id = '00000000-0000-0000-0000-000000000001'
      AND wa.account_type = 'platform_revenue'
    ), 0)::BIGINT AS platform_balance,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= CURRENT_DATE
    ), 0)::BIGINT AS earnings_today,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= CURRENT_DATE - 7
    ), 0)::BIGINT AS earnings_this_week,

    COALESCE((
      SELECT SUM(rps.commission_amount)
      FROM ride_pricing_snapshots rps
      JOIN rides r ON r.id = rps.ride_id
      WHERE r.status = 'completed'
      AND rps.snapshot_type = 'final'
      AND r.completed_at >= date_trunc('month', CURRENT_DATE)
    ), 0)::BIGINT AS earnings_this_month,

    COALESCE((
      SELECT (pc.value #>> '{}')::NUMERIC FROM platform_config pc WHERE pc.key = 'commission_rate'
    ), 0.15) AS commission_rate;
$function$;
