-- ============================================================
-- BUG-210 (5): block ride acceptance when the driver does not
-- have enough TriciCoin balance to cover the platform commission.
--
-- Migration 00153 already added a wallet-floor gate inside
-- accept_ride_v2 by calling driver_can_afford_commission() — a
-- helper that read the driver's `driver_cash` balance and computed
-- the commission in TRC units. Both of those choices are wrong
-- after this batch:
--   • The commission is now stored / debited in CUP (BUG-211)
--   • The commission is now drained from `tricicoin`, not
--     driver_cash (BUG-210)
--
-- This migration redefines `driver_can_afford_commission()` to
-- match the new model. Because accept_ride_v2 (00153) only reads
-- `v_afford->>'ok'` plus the diagnostic fields it forwards as
-- error payload, swapping the helper is sufficient — no change
-- to accept_ride_v2's body is needed, and the {balance_trc,
-- required_trc} keys remain in the response shape so existing
-- client error-handling keeps working (the values are now in CUP
-- units; `_trc` in the key name is legacy).
-- ============================================================

CREATE OR REPLACE FUNCTION public.driver_can_afford_commission(
  p_driver_id uuid,
  p_estimated_fare_cup integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_user_id              uuid;
  v_balance_cup          integer;
  v_commission_rate      numeric;
  v_required_cup         integer;
BEGIN
  SELECT user_id INTO v_user_id FROM driver_profiles WHERE id = p_driver_id;
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_not_found');
  END IF;

  -- BUG-210: check `tricicoin` (the dedicated commission balance),
  -- not `driver_cash` (which is the driver's earnings account).
  SELECT COALESCE(balance, 0) INTO v_balance_cup
  FROM wallet_accounts
  WHERE user_id = v_user_id
    AND account_type = 'tricicoin';
  v_balance_cup := COALESCE(v_balance_cup, 0);

  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  -- BUG-211: required commission is in CUP. CEIL() rounds up by
  -- 1 cent so we don't fail the gate then succeed at completion
  -- where ROUND() may produce 1 unit higher.
  v_required_cup := CEIL(COALESCE(p_estimated_fare_cup, 0)::numeric * v_commission_rate)::int;

  RETURN jsonb_build_object(
    'ok',              v_balance_cup >= v_required_cup,
    -- Keys retain `_trc` suffix for backward-compat with frontend
    -- error handlers that read these names. The values inside are
    -- CUP, identical to TRC under the 1:1 model in this codebase.
    'balance_trc',     v_balance_cup,
    'required_trc',    v_required_cup,
    'balance_cup',     v_balance_cup,    -- alias, preferred name going forward
    'required_cup',    v_required_cup,
    'commission_rate', v_commission_rate,
    'wallet_type',     'tricicoin'
  );
END;
$$;

COMMENT ON FUNCTION public.driver_can_afford_commission(uuid, integer) IS
  'BUG-210/211: checks the driver `tricicoin` balance against the '
  'commission expected at completion (CEIL of estimated_fare * '
  'commission_rate, in CUP). Returns {ok, balance_cup, required_cup, '
  'wallet_type}. Used by accept_ride_v2 (00153) as the pre-accept '
  'gate. Replaces the previous driver_cash-in-TRC formulation.';
