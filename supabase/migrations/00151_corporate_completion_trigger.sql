-- ============================================================
-- Restore corporate payment completion bookkeeping
-- ============================================================
--
-- Context: migration 00055_corporate_payment.sql added a full
-- `payment_method = 'corporate'` branch to `complete_ride_and_pay`
-- that debited the corporate_cash wallet, credited driver + platform,
-- inserted into `corporate_rides`, and advanced
-- `corporate_accounts.current_month_spent` — all in the same
-- transaction as the ride completion.
--
-- Migration 00112_mixed_payment.sql rewrote `complete_ride_and_pay`
-- to handle the new mixed-payment cash/wallet flow but silently
-- dropped the corporate branch. The function hasn't known how to
-- bill a corporate ride since then. The audit on 2026-04-23 proved
-- this is a latent regression: no corporate rides exist in the DB,
-- but any corporate ride created post-00112 would complete without
-- updating `current_month_spent` and without creating a corporate
-- ledger entry — budgets would go permanently stale.
--
-- We restore the behavior via an AFTER UPDATE trigger on `rides`
-- instead of reopening the 20KB RPC body. Benefits:
--   * runs in the same transaction as the ride UPDATE, so atomic
--     guarantees are identical to 00055
--   * idempotent by idempotency_key on ledger_transactions
--   * doesn't risk regressing the cash / mixed-payment logic we
--     already trust
--
-- Scope: only fires when payment_method = 'corporate' AND the row
-- transitions to status='completed'. All other payment methods are
-- untouched.

CREATE OR REPLACE FUNCTION handle_corporate_ride_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'extensions', 'pg_catalog'
AS $$
DECLARE
  v_corp_owner_id UUID;
  v_driver_user_id UUID;
  v_platform_user_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  v_customer_account_id UUID;
  v_driver_account_id UUID;
  v_platform_account_id UUID;
  v_customer_balance NUMERIC;
  v_driver_balance NUMERIC;
  v_platform_balance NUMERIC;
  v_final_fare_trc NUMERIC;
  v_commission_amount NUMERIC;
  v_driver_earnings NUMERIC;
  v_commission_rate NUMERIC;
  v_txn_id UUID;
BEGIN
  -- Only corporate rides transitioning to completed.
  IF NEW.payment_method <> 'corporate' THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;
  IF NEW.corporate_account_id IS NULL THEN
    -- Safety: a corporate payment without an account_id is malformed.
    -- Log and bail rather than silently ignoring the accounting miss.
    RAISE WARNING 'Corporate ride % has NULL corporate_account_id — skipping corporate bookkeeping', NEW.id;
    RETURN NEW;
  END IF;

  -- Resolve the corporate account owner (their corporate_cash wallet
  -- is the debited account).
  SELECT created_by INTO v_corp_owner_id
  FROM corporate_accounts
  WHERE id = NEW.corporate_account_id;

  IF v_corp_owner_id IS NULL THEN
    RAISE EXCEPTION 'Corporate account % not found for ride %', NEW.corporate_account_id, NEW.id;
  END IF;

  -- Resolve the driver's user_id (NEW.driver_id is driver_profiles.id).
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles
  WHERE id = NEW.driver_id;

  IF v_driver_user_id IS NULL THEN
    RAISE EXCEPTION 'Driver profile % not found for ride %', NEW.driver_id, NEW.id;
  END IF;

  -- Idempotency guard: bail if this ride already has a corporate
  -- ledger transaction (trigger re-runs shouldn't double-post).
  IF EXISTS (
    SELECT 1 FROM ledger_transactions
    WHERE idempotency_key = 'corporate_ride_payment:' || NEW.id::TEXT
  ) THEN
    RETURN NEW;
  END IF;

  v_final_fare_trc := NEW.final_fare_trc;
  IF v_final_fare_trc IS NULL OR v_final_fare_trc <= 0 THEN
    RAISE EXCEPTION 'Corporate ride % has invalid final_fare_trc=% — expected positive', NEW.id, v_final_fare_trc;
  END IF;

  -- Commission rate from platform_config (same pattern used by the
  -- main RPC; 00148 fixed the cast to `#>> '{}'`).
  SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate
  FROM platform_config WHERE key = 'commission_rate';
  v_commission_rate := COALESCE(v_commission_rate, 0.15);

  v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
  v_driver_earnings := v_final_fare_trc - v_commission_amount;

  -- Resolve / create the three wallet accounts we need.
  v_customer_account_id := ensure_wallet_account(v_corp_owner_id, 'corporate_cash');
  v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'driver_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

  -- Lock and read balances (FOR UPDATE prevents concurrent corporate
  -- rides from double-spending the same budget slice).
  SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
  SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id FOR UPDATE;
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

  -- Post the triple-entry ledger transaction.
  INSERT INTO ledger_transactions (
    id, idempotency_key, type, status, reference_type, reference_id, description, created_by
  ) VALUES (
    gen_random_uuid(),
    'corporate_ride_payment:' || NEW.id::TEXT,
    'ride_payment', 'posted', 'ride', NEW.id,
    'Pago corporativo viaje #' || LEFT(NEW.id::TEXT, 8),
    v_corp_owner_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES
    (v_txn_id, v_customer_account_id, -v_final_fare_trc, v_customer_balance - v_final_fare_trc),
    (v_txn_id, v_driver_account_id,   v_driver_earnings, v_driver_balance + v_driver_earnings),
    (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

  UPDATE wallet_accounts SET balance = balance - v_final_fare_trc WHERE id = v_customer_account_id;
  UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
  UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

  -- Record the corporate-specific tracking row + advance the monthly
  -- budget counter. Both live in the same transaction as the ride
  -- UPDATE so a failure here rolls everything back.
  INSERT INTO corporate_rides (corporate_account_id, ride_id, employee_user_id, fare_trc)
  VALUES (NEW.corporate_account_id, NEW.id, NEW.customer_id, v_final_fare_trc);

  UPDATE corporate_accounts
  SET current_month_spent = current_month_spent + v_final_fare_trc
  WHERE id = NEW.corporate_account_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_corporate_ride_completion ON rides;

CREATE TRIGGER trg_corporate_ride_completion
AFTER UPDATE ON rides
FOR EACH ROW
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.payment_method = 'corporate')
EXECUTE FUNCTION handle_corporate_ride_completion();

COMMENT ON FUNCTION handle_corporate_ride_completion IS
  'Atomic corporate ride bookkeeping. Runs as an AFTER UPDATE trigger when a ride transitions to completed with payment_method=corporate. Debits corporate_cash, credits driver + platform, logs corporate_rides row, and advances corporate_accounts.current_month_spent. Idempotent via ledger_transactions.idempotency_key.';
