-- 00386_add_tip_tricicoin_and_reconcile.sql
-- ------------------------------------------------------------------
-- BUG: tips credited the DEAD `driver_cash` wallet, not the live
-- `tricicoin` wallet the driver actually sees.
--
-- The `add_tip` RPC debits the rider's `customer_cash` correctly, but
-- credited the driver's `driver_cash` account — the Gen-A wallet that
-- was deprecated by PR #184 / migration 00300 (driver earnings + every
-- recharge now live in `tricicoin`). So a rider could tip 200 TRC, the
-- money left their wallet, and the driver never saw a cent in their
-- visible balance. Same class of silent bug CLAUDE.md documents under
-- "Wallet model — 2 generaciones coexistiendo".
--
-- This migration does two things:
--   1. CREATE OR REPLACE add_tip — credit `tricicoin` instead of
--      `driver_cash`. Body is otherwise a verbatim copy of the live
--      function (pg_get_functiondef on prod), only the driver account
--      type changes (lookup + create-if-missing).
--   2. Reconcile every tip already paid into `driver_cash` by moving
--      its amount driver_cash → tricicoin. Idempotent and scoped to
--      tips whose ORIGINAL credit actually landed in a driver_cash
--      account (verified via the ledger), so tips paid after this fix
--      — which already credit tricicoin — are never touched, even if
--      this migration is re-applied.
--
-- At write time prod has exactly 1 historical tip (200 TRC, María
-- Rodríguez → Eduardo Admin) sitting in the invisible driver_cash.
-- ------------------------------------------------------------------

-- 1) Fix forward: credit tricicoin, not driver_cash.
CREATE OR REPLACE FUNCTION public.add_tip(p_ride_id uuid, p_from_user_id uuid, p_amount integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD; v_driver_user_id UUID;
  v_from_account_id UUID; v_driver_account_id UUID;
  v_tip_id UUID; v_txn_id UUID;
BEGIN
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only tip from your own wallet';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id AND status = 'completed';
  IF v_ride IS NULL THEN RAISE EXCEPTION 'Ride not found or not completed'; END IF;

  IF NOT is_admin() AND v_ride.customer_id <> auth.uid() THEN
    RAISE EXCEPTION 'Forbidden: only the rider can tip on this ride';
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = v_ride.driver_id;
  IF v_driver_user_id IS NULL THEN RAISE EXCEPTION 'Driver not found'; END IF;

  SELECT id INTO v_from_account_id FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = 'customer_cash';
  IF v_from_account_id IS NULL THEN RAISE EXCEPTION 'Customer wallet not found'; END IF;

  IF (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for tip';
  END IF;

  -- 00386: credit the LIVE driver wallet (tricicoin), not the dead driver_cash.
  SELECT id INTO v_driver_account_id FROM wallet_accounts
    WHERE user_id = v_driver_user_id AND account_type = 'tricicoin';
  IF v_driver_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_driver_user_id, 'tricicoin', 0, 0, 'TRC', true)
    RETURNING id INTO v_driver_account_id;
  END IF;

  INSERT INTO tips (ride_id, from_user_id, to_driver_id, amount)
  VALUES (p_ride_id, p_from_user_id, v_driver_user_id, p_amount)
  RETURNING id INTO v_tip_id;

  UPDATE rides SET tip_amount = COALESCE(tip_amount, 0) + p_amount WHERE id = p_ride_id;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
  VALUES ('tip:' || v_tip_id, 'adjustment', 'posted', 'tip', v_tip_id,
          'Propina viaje #' || LEFT(p_ride_id::TEXT, 8), p_from_user_id)
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_from_account_id, -p_amount,
          (SELECT balance FROM wallet_accounts WHERE id = v_from_account_id) - p_amount);
  UPDATE wallet_accounts SET balance = balance - p_amount WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_driver_account_id, p_amount,
          (SELECT balance FROM wallet_accounts WHERE id = v_driver_account_id) + p_amount);
  UPDATE wallet_accounts SET balance = balance + p_amount WHERE id = v_driver_account_id;

  RETURN v_tip_id;
END;
$function$;

-- 2) Fix backward: move historical tips out of driver_cash into tricicoin.
DO $$
DECLARE
  rec RECORD;
  v_driver_cash_id UUID; v_dc_balance NUMERIC;
  v_tricicoin_id UUID;   v_tc_balance NUMERIC;
  v_txn_id UUID; v_idem TEXT;
BEGIN
  FOR rec IN
    SELECT t.id AS tip_id, t.to_driver_id, t.amount
    FROM tips t
    WHERE EXISTS (
      -- Only tips whose ORIGINAL credit landed in a driver_cash account
      -- (the pre-fix RPC). Tips that already credited tricicoin are
      -- skipped, making this safe to re-run after the fix ships.
      SELECT 1
      FROM ledger_transactions lt
      JOIN ledger_entries le ON le.transaction_id = lt.id
      JOIN wallet_accounts wa ON wa.id = le.account_id
      WHERE lt.idempotency_key = 'tip:' || t.id
        AND le.amount > 0
        AND wa.account_type = 'driver_cash'
    )
  LOOP
    v_idem := '00386_reconcile_tip:' || rec.tip_id;
    -- Idempotency: skip if this tip was already reconciled.
    IF EXISTS (SELECT 1 FROM ledger_transactions WHERE idempotency_key = v_idem) THEN
      CONTINUE;
    END IF;

    SELECT id, balance INTO v_driver_cash_id, v_dc_balance
      FROM wallet_accounts WHERE user_id = rec.to_driver_id AND account_type = 'driver_cash';
    IF v_driver_cash_id IS NULL THEN
      CONTINUE;  -- nothing to move from
    END IF;

    -- Ensure the destination tricicoin wallet exists.
    SELECT id, balance INTO v_tricicoin_id, v_tc_balance
      FROM wallet_accounts WHERE user_id = rec.to_driver_id AND account_type = 'tricicoin';
    IF v_tricicoin_id IS NULL THEN
      INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
      VALUES (rec.to_driver_id, 'tricicoin', 0, 0, 'TRC', true)
      RETURNING id, balance INTO v_tricicoin_id, v_tc_balance;
    END IF;

    INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (v_idem, 'adjustment', 'posted', 'tip', rec.tip_id,
            'Reconcile tip #' || LEFT(rec.tip_id::TEXT, 8) || ' driver_cash -> tricicoin', rec.to_driver_id)
    RETURNING id INTO v_txn_id;

    -- Debit driver_cash (reverse the mis-routed credit).
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_driver_cash_id, -rec.amount, v_dc_balance - rec.amount);
    UPDATE wallet_accounts SET balance = balance - rec.amount WHERE id = v_driver_cash_id;

    -- Credit tricicoin (where the tip should have gone).
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_tricicoin_id, rec.amount, v_tc_balance + rec.amount);
    UPDATE wallet_accounts SET balance = balance + rec.amount WHERE id = v_tricicoin_id;

    RAISE NOTICE '00386: reconciled tip % (% TRC) driver_cash -> tricicoin for driver %',
      rec.tip_id, rec.amount, rec.to_driver_id;
  END LOOP;
END $$;
