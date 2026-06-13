-- 00407_ride_flow_p1_fixes.sql
-- Ride-flow audit — Fase 1 (P1 bloqueantes). Read-only audit verified each issue
-- against the LIVE prod function bodies (not migration files). See plan:
-- ~/.claude/plans/haz-un-analisis-para-dapper-conway.md
--
-- Fixes in this migration:
--   #1  Customer cannot cancel during 'driver_en_route' (valid_transitions gap).
--   #2  Corporate ride driver earnings credited to the dead 'driver_cash' wallet
--       instead of 'tricicoin' (handle_corporate_ride_completion missed the 00340
--       consolidation). + #6 make that trigger defensive so a corporate-payment
--       problem never rolls back ride completion.
--   #3  Scheduled / recurring rides auto-canceled ~3 min after creation and never
--       properly dispatched (conflict between cleanup_orphan_searching_rides,
--       on_ride_insert_dispatch and activate_scheduled_rides).

-- ============================================================================
-- #1 — Allow the customer to cancel a ride while the driver is en route.
-- valid_transitions had driver_en_route->canceled for {driver,admin,super_admin}
-- only, while accepted->canceled and arrived_at_pickup->canceled DO include
-- customer. The UI shows the Cancel button during driver_en_route, so tapping it
-- hit enforce_ride_transition's RAISE and aborted cancel_ride (no EXCEPTION block).
-- ============================================================================
DELETE FROM valid_transitions
 WHERE from_status = 'driver_en_route' AND to_status = 'canceled';
INSERT INTO valid_transitions (from_status, to_status, allowed_roles)
VALUES ('driver_en_route', 'canceled',
        ARRAY['customer','driver','admin','super_admin']::user_role[]);

-- ============================================================================
-- #2 + #6 — Corporate ride completion: pay the driver in 'tricicoin' (Gen B,
-- the wallet the driver app actually reads), and make the whole payment block
-- defensive so it can NEVER roll back the ride's completion. This trigger is the
-- ONLY money path for corporate rides (complete_ride_and_pay does NULL for
-- payment_method='corporate'). Reproduced verbatim from prod with: driver wallet
-- 'driver_cash' -> 'tricicoin', and hard RAISEs converted to RAISE WARNING +
-- graceful RETURN NEW inside a BEGIN ... EXCEPTION wrapper.
-- ============================================================================
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
BEGIN
  IF NEW.payment_method <> 'corporate' THEN RETURN NEW; END IF;
  IF NEW.status <> 'completed' OR OLD.status = 'completed' THEN RETURN NEW; END IF;

  -- 00407: defensive — a corporate-payment problem must NEVER roll back ride
  -- completion. Any guard failure or error logs a WARNING and leaves the ride
  -- completed; the corporate payment is reconciled out-of-band.
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

    SELECT (value #>> '{}')::NUMERIC INTO v_commission_rate FROM platform_config WHERE key = 'commission_rate';
    v_commission_rate := COALESCE(v_commission_rate, 0.15);
    v_commission_amount := ROUND(v_final_fare_trc * v_commission_rate);
    v_driver_earnings := v_final_fare_trc - v_commission_amount;

    v_customer_account_id := ensure_wallet_account(v_corp_owner_id, 'corporate_cash');
    -- 00407 FIX: driver earnings go to 'tricicoin' (Gen B), not the dead
    -- 'driver_cash' wallet. The driver app reads 'tricicoin'.
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

-- ============================================================================
-- #3 — Scheduled / recurring rides lifecycle.
-- Root cause: rides are inserted with status='searching', is_scheduled=true,
-- scheduled_at in the future, searching_seen_at=now(). Then:
--   * cleanup_orphan_searching_rides cancels them after 180s (no scheduled guard);
--   * on_ride_insert_dispatch dispatches them immediately (24h early);
--   * activate_scheduled_rides only push-notifies, never creates ride_offers,
--     so even surviving scheduled rides can't be accepted (no pending offer).
-- ============================================================================

-- 3.1 — Do not abandon a scheduled ride before its time. For scheduled rides with
-- a scheduled_at, the abandonment clock runs from scheduled_at (not creation), so
-- they survive until ~180s after their scheduled time, then abandon like any ride.
CREATE OR REPLACE FUNCTION public.cleanup_orphan_searching_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_count   INTEGER;
  v_abandon INTEGER;
BEGIN
  SELECT ((value #>> '{}')::INTEGER) INTO v_abandon
  FROM platform_config WHERE key = 'searching_abandon_seconds';
  v_abandon := COALESCE(v_abandon, 180);

  UPDATE rides
  SET status = 'canceled',
      cancellation_reason = 'searching_abandoned',
      canceled_at = now()
  WHERE status = 'searching'
    AND CASE
          WHEN is_scheduled = TRUE AND scheduled_at IS NOT NULL
            THEN scheduled_at     < now() - (v_abandon || ' seconds')::interval
          ELSE     searching_seen_at < now() - (v_abandon || ' seconds')::interval
        END;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- 3.2 — Do not dispatch a future scheduled ride at insert time. Immediate rides
-- (and scheduled rides already due) dispatch right away; future scheduled rides
-- are dispatched by activate_scheduled_rides when their time arrives.
CREATE OR REPLACE FUNCTION public.on_ride_insert_dispatch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status = 'searching'
     AND (NEW.is_scheduled IS NOT TRUE
          OR NEW.scheduled_at IS NULL
          OR NEW.scheduled_at <= now()) THEN
    PERFORM dispatch_ride(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$;

-- 3.3 — When a scheduled ride becomes due, actually DISPATCH it (create the
-- authoritative ride_offers, which fire trg_notify_driver_new_offer push to each
-- matched driver) instead of only sending a one-off push. Same dispatch path used
-- by retry_dispatch_expired_rides. The previous manual http_post push loop is
-- removed (dispatch_ride's offer-insert trigger handles driver notification).
CREATE OR REPLACE FUNCTION public.activate_scheduled_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_activated INTEGER := 0;
BEGIN
  FOR v_ride IN
    SELECT r.id
    FROM rides r
    WHERE r.is_scheduled = true
      AND r.scheduled_notified = false
      AND r.status = 'searching'
      AND r.scheduled_at IS NOT NULL
      AND r.scheduled_at <= NOW() + interval '10 minutes'
      AND r.scheduled_at >  NOW() - interval '15 minutes'
  LOOP
    UPDATE rides SET scheduled_notified = true WHERE id = v_ride.id;
    -- Creates ride_offers + fires trg_notify_driver_new_offer push.
    PERFORM dispatch_ride(v_ride.id);
    v_activated := v_activated + 1;
  END LOOP;

  RETURN v_activated;
END;
$function$;
