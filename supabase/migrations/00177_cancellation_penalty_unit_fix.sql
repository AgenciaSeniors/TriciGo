-- ============================================================
-- BUG-120: apply_cancellation_penalty and preview_cancellation_penalty
-- both used 20000 / 10000 with the comment "200 CUP in centavos".
-- That comment was wrong: customer_cash wallet_accounts are denominated
-- in TRC whole units (= CUP whole units) — confirmed by:
--   - currency = 'TRC' on every customer_cash row
--   - Stripe recharge of $10 USD writes 5300 to ledger_entries
--     (consistent with ~5300 CUP, not 53 CUP)
--   - apps/client/src/hooks/useRide.ts:768
--     "// Progressive penalty (penaltyAmount is in whole CUP pesos)"
--   - The toast in CancelRideSheet shows the raw return value as CUP
--
-- Net effect: every penalty was charged at 100x the intended amount.
--   2nd cancel/24h:    intended 100 CUP, actual ledger debit 10,000 CUP
--   3rd-4th cancel/24h: intended 200 CUP, actual debit 20,000 CUP
--   5th+:               intended block + 200 CUP, actual block + 20,000 CUP
--
-- Fix: rewrite both functions with the correct scale (penalty values
-- expressed in whole CUP), so the ledger debit and the UI preview both
-- match the documented intent in migration 00010.
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_cancellation_penalty(p_user_id uuid, p_ride_id uuid)
RETURNS TABLE(penalty_amount integer, is_blocked boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_cancel_count_24h INTEGER;
  v_penalty INTEGER := 0;
  v_blocked BOOLEAN := false;
  v_account_id UUID;
BEGIN
  SELECT COUNT(*) INTO v_cancel_count_24h
  FROM cancellation_penalties
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '24 hours';

  -- Progressive penalty in whole CUP (= TRC) units
  IF v_cancel_count_24h >= 4 THEN
    v_penalty := 200; -- 5th+ cancel/24h: block + 200 CUP
    v_blocked := true;
  ELSIF v_cancel_count_24h >= 2 THEN
    v_penalty := 200; -- 3rd-4th cancel/24h: 200 CUP
  ELSIF v_cancel_count_24h >= 1 THEN
    v_penalty := 100; -- 2nd cancel/24h: 100 CUP
  ELSE
    v_penalty := 0;   -- 1st cancel/24h: free
  END IF;

  INSERT INTO cancellation_penalties (user_id, ride_id, amount, reason)
  VALUES (
    p_user_id,
    p_ride_id,
    v_penalty,
    CASE
      WHEN v_penalty = 0 THEN 'Primera cancelación del día - sin penalización'
      WHEN v_blocked THEN 'Cancelación excesiva - penalización + bloqueo temporal'
      ELSE 'Penalización por cancelación múltiple'
    END
  );

  UPDATE users
  SET cancellation_count = cancellation_count + 1,
      last_cancellation_at = NOW()
  WHERE id = p_user_id;

  IF v_penalty > 0 THEN
    SELECT id INTO v_account_id
    FROM wallet_accounts
    WHERE user_id = p_user_id
      AND account_type = 'customer_cash';

    IF v_account_id IS NOT NULL THEN
      WITH txn AS (
        INSERT INTO ledger_transactions (
          idempotency_key, type, status, reference_type, reference_id,
          description, created_by
        ) VALUES (
          'cancel_penalty:' || p_ride_id || ':' || p_user_id,
          'adjustment',
          'posted',
          'cancellation_penalty',
          p_ride_id,
          'Penalización por cancelación de viaje',
          p_user_id
        ) RETURNING id
      )
      INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
      SELECT txn.id, v_account_id, -v_penalty,
             (SELECT balance FROM wallet_accounts WHERE id = v_account_id) - v_penalty
      FROM txn;

      UPDATE wallet_accounts
      SET balance = balance - v_penalty,
          updated_at = NOW()
      WHERE id = v_account_id;
    END IF;
  END IF;

  RETURN QUERY SELECT v_penalty, v_blocked;
END;
$$;

CREATE OR REPLACE FUNCTION public.preview_cancellation_penalty(p_user_id UUID)
RETURNS TABLE(penalty_amount INTEGER, is_blocked BOOLEAN, cancel_count_24h INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_cancel_count_24h INTEGER;
  v_penalty INTEGER := 0;
  v_blocked BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_cancel_count_24h
  FROM cancellation_penalties
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '24 hours';

  IF v_cancel_count_24h >= 4 THEN
    v_penalty := 200;
    v_blocked := true;
  ELSIF v_cancel_count_24h >= 2 THEN
    v_penalty := 200;
  ELSIF v_cancel_count_24h >= 1 THEN
    v_penalty := 100;
  ELSE
    v_penalty := 0;
  END IF;

  RETURN QUERY SELECT v_penalty, v_blocked, v_cancel_count_24h;
END;
$$;

COMMENT ON FUNCTION public.apply_cancellation_penalty(uuid, uuid) IS
  'BUG-120: penalties are now expressed in whole CUP (= TRC) units, matching customer_cash wallet scale. Original 20000/10000 values with "centavos" comment were a 100x overcharge.';

COMMENT ON FUNCTION public.preview_cancellation_penalty(uuid) IS
  'BUG-120: returns penalty in whole CUP, matching apply_cancellation_penalty. Client UI shows this value directly in toast.';
