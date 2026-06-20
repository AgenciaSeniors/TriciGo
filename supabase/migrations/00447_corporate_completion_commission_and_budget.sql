-- 00447_corporate_completion_commission_and_budget.sql
-- Pre-launch audit 2026-06-20 — AUD-006 + AUD-007 (corporate, 0 prod usage → latent-but-certain).
--
-- AUD-006: handle_corporate_ride_completion re-split the already-priced final_fare_trc at the
-- platform default commission_rate (0.15), IGNORING the corporate override. complete_ride_and_pay
-- already computes the corporate commission (v_corp_commission_rate = corporate_accounts.commission_percent/100
-- or the estimate snapshot's corporate_commission_rate) and persists it in the 'final' pricing snapshot
-- (commission_amount). The trigger now reads that snapshot so its split equals what was priced.
--
-- AUD-007: the corporate cap/budget was enforced only on the INSERT estimate, and fail-open when
-- estimated_fare_trc was 0 (0 > cap is false; +0 to the monthly sum). And completion debited
-- corporate_cash by final_fare_trc with no cap/budget re-check (the final can legitimately exceed the
-- estimate). Fixes: (a) the INSERT gate requires a positive fare estimate (from trc or the 1:1 cup
-- fallback) and uses it for the cap/budget checks; (b) completion re-checks cap/budget against the
-- FINAL fare and RAISES WARNING for reconciliation — never rolling back the completed ride.

-- ─────────────────────────────────────────────────────────────────────────
-- handle_corporate_ride_completion — reproduced from the live body (00407) with AUD-006 + AUD-007a.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_corporate_ride_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
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
  v_cap INTEGER;
  v_budget INTEGER;
  v_spent INTEGER;
BEGIN
  IF NEW.payment_method <> 'corporate' THEN RETURN NEW; END IF;
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;

  BEGIN
    IF NEW.corporate_account_id IS NULL THEN
      RAISE WARNING 'Corporate ride % has NULL corporate_account_id', NEW.id;
      RETURN NEW;
    END IF;

    SELECT created_by INTO v_corp_owner_id FROM corporate_accounts WHERE id = NEW.corporate_account_id;
    IF v_corp_owner_id IS NULL THEN
      RAISE WARNING 'Corporate account % not found for ride %', NEW.corporate_account_id, NEW.id;
      RETURN NEW;
    END IF;

    SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = NEW.driver_id;
    IF v_driver_user_id IS NULL THEN
      RAISE WARNING 'Driver profile % not found for ride %', NEW.driver_id, NEW.id;
      RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM ledger_transactions WHERE idempotency_key = 'corporate_ride_payment:' || NEW.id::TEXT) THEN
      RETURN NEW;
    END IF;

    v_final_fare_trc := NEW.final_fare_trc;
    IF v_final_fare_trc IS NULL OR v_final_fare_trc <= 0 THEN
      RAISE WARNING 'Corporate ride % has nothing to charge (final_fare_trc=%)', NEW.id, v_final_fare_trc;
      RETURN NEW;
    END IF;

    -- AUD-006: use the commission computed by complete_ride_and_pay (which honours the corporate
    -- override) and persisted in the 'final' pricing snapshot. Fall back to the corporate account's
    -- own commission_percent, then the platform default, only if no snapshot exists.
    SELECT commission_amount INTO v_commission_amount
      FROM ride_pricing_snapshots
      WHERE ride_id = NEW.id AND snapshot_type = 'final'
      ORDER BY created_at DESC LIMIT 1;

    IF v_commission_amount IS NULL THEN
      SELECT commission_percent / 100.0 INTO v_commission_rate
        FROM corporate_accounts WHERE id = NEW.corporate_account_id;
      IF v_commission_rate IS NULL THEN
        SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate FROM platform_config WHERE key = 'commission_rate';
        v_commission_rate := COALESCE(v_commission_rate, 0.15);
      END IF;
      v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
    END IF;

    -- Defensive clamp so the driver can never be paid negative nor more than the fare.
    v_commission_amount := GREATEST(0, LEAST(v_commission_amount, v_final_fare_trc));
    v_driver_earnings := v_final_fare_trc - v_commission_amount;

    -- AUD-007: re-check the corporate cap/budget against the FINAL fare (the INSERT gate only saw
    -- the estimate, which can be lower). Never roll back the completed ride — warn for reconciliation.
    SELECT per_ride_cap_trc, monthly_budget_trc, current_month_spent
      INTO v_cap, v_budget, v_spent
      FROM corporate_accounts WHERE id = NEW.corporate_account_id;
    IF COALESCE(v_cap, 0) > 0 AND v_final_fare_trc > v_cap THEN
      RAISE WARNING 'corporate ride % final fare % exceeds per-ride cap % — charged, needs reconciliation',
        NEW.id, v_final_fare_trc, v_cap;
    END IF;
    IF COALESCE(v_budget, 0) > 0 AND COALESCE(v_spent, 0) + v_final_fare_trc > v_budget THEN
      RAISE WARNING 'corporate ride % pushes monthly spend over budget (% + % > %) — charged, needs reconciliation',
        NEW.id, v_spent, v_final_fare_trc, v_budget;
    END IF;

    v_customer_account_id := ensure_wallet_account(v_corp_owner_id, 'corporate_cash');
    v_driver_account_id := ensure_wallet_account(v_driver_user_id, 'tricicoin');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    SELECT balance INTO v_driver_balance FROM wallet_accounts WHERE id = v_driver_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'corporate_ride_payment:' || NEW.id::TEXT, 'ride_payment', 'posted', 'ride', NEW.id,
            'Pago corporativo viaje #' || LEFT(NEW.id::TEXT, 8), v_corp_owner_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after) VALUES
      (v_txn_id, v_customer_account_id, -v_final_fare_trc, v_customer_balance - v_final_fare_trc),
      (v_txn_id, v_driver_account_id,   v_driver_earnings, v_driver_balance + v_driver_earnings),
      (v_txn_id, v_platform_account_id, v_commission_amount, v_platform_balance + v_commission_amount);

    UPDATE wallet_accounts SET balance = balance - v_final_fare_trc WHERE id = v_customer_account_id;
    UPDATE wallet_accounts SET balance = balance + v_driver_earnings WHERE id = v_driver_account_id;
    UPDATE wallet_accounts SET balance = balance + v_commission_amount WHERE id = v_platform_account_id;

    INSERT INTO corporate_rides (corporate_account_id, ride_id, employee_user_id, fare_trc)
    VALUES (NEW.corporate_account_id, NEW.id, NEW.customer_id, v_final_fare_trc);

    PERFORM set_config('app.trusted_corporate_update', '1', true);
    UPDATE corporate_accounts
    SET current_month_spent = current_month_spent + v_final_fare_trc
    WHERE id = NEW.corporate_account_id;

  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_corporate_ride_completion failed for ride %: % % — ride completion preserved; corporate payment needs reconciliation',
      NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- tg_rides_validate_corporate — reproduced from the live body (00429) with AUD-007b.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  v_per_ride_cap integer;
  v_monthly_budget integer;
  v_month_spent integer;
  v_fare integer;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    IF NEW.payment_method = 'corporate' THEN
      RAISE EXCEPTION 'corporate payment_method requires a corporate_account_id';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, per_ride_cap_trc, monthly_budget_trc
    INTO v_status, v_per_ride_cap, v_monthly_budget
  FROM corporate_accounts WHERE id = NEW.corporate_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'corporate account % not found', NEW.corporate_account_id;
  END IF;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'corporate account % is not approved (status=%)', NEW.corporate_account_id, v_status;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'customer % is not an active employee of corporate account %',
      NEW.customer_id, NEW.corporate_account_id;
  END IF;

  -- AUD-007: the cap/budget can only be enforced with a fare. estimated_fare_trc is 1:1 with
  -- estimated_fare_cup, so fall back to it; require a positive estimate on INSERT (a corporate ride
  -- with no fare would silently bypass the limits).
  v_fare := COALESCE(NULLIF(NEW.estimated_fare_trc, 0), NULLIF(NEW.estimated_fare_cup, 0), 0);
  IF TG_OP = 'INSERT' AND v_fare <= 0 THEN
    RAISE EXCEPTION 'corporate ride requires a positive fare estimate to enforce caps/budget';
  END IF;

  IF COALESCE(v_per_ride_cap, 0) > 0 AND v_fare > v_per_ride_cap THEN
    RAISE EXCEPTION 'ride fare % exceeds corporate per-ride cap %', v_fare, v_per_ride_cap;
  END IF;

  IF TG_OP = 'INSERT' AND COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    IF v_month_spent + v_fare > v_monthly_budget THEN
      RAISE EXCEPTION 'corporate account % would exceed its monthly budget (spent % + ride % > budget %)',
        NEW.corporate_account_id, v_month_spent, v_fare, v_monthly_budget;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
