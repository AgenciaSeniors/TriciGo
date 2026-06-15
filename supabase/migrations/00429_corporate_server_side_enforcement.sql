-- 00429_corporate_server_side_enforcement.sql
-- ============================================================================
-- CORP-01 + CORP-02 (P0, audit 2026-06-14): ALL corporate policy enforcement
-- (employee membership, monthly budget, per-ride cap) lived ONLY in client-side
-- TypeScript (corporateService.validateCorporateRide). The rides INSERT RLS only
-- checks customer_id=auth.uid(), so any authenticated user could insert a ride
-- with payment_method='corporate' + corporate_account_id=<any approved corp's
-- UUID>, and on completion handle_corporate_ride_completion debits that
-- company's corporate_cash to pay the attacker's ride — direct theft of
-- corporate funds, and unbounded overspend (no budget/cap gate).
--
-- Fix: enforce it server-side with a BEFORE INSERT/UPDATE trigger on rides:
--   * the BILLED customer must be an ACTIVE EMPLOYEE of the corporate account;
--   * the account must be 'approved';
--   * the ride fare must be within per_ride_cap_trc (0 = unlimited);
--   * the account's month-to-date spend + this ride must be within
--     monthly_budget_trc (0 = unlimited). Spend is derived from the completed
--     corporate_rides ledger over the America/Havana calendar month, so it needs
--     NO reset cron (this also sidesteps CORP-03's missing reset).
--   * a non-corporate ride may not claim payment_method='corporate'.
--
-- CORP-04: a self-registered corporate owner could not be linked as their own
-- first admin employee (RLS blocked the bootstrap insert), which — once the
-- membership check above exists — would lock them out of booking on their own
-- account. Add a narrow INSERT policy letting the account's created_by add
-- THEMSELVES as the first active admin employee.
-- ============================================================================

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
BEGIN
  -- Non-corporate ride must not claim corporate payment.
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

  -- Membership: the BILLED customer must be an active employee of the account.
  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'customer % is not an active employee of corporate account %',
      NEW.customer_id, NEW.corporate_account_id;
  END IF;

  -- Per-ride cap (0 = unlimited, intentional).
  IF COALESCE(v_per_ride_cap, 0) > 0
     AND COALESCE(NEW.estimated_fare_trc, 0) > v_per_ride_cap THEN
    RAISE EXCEPTION 'ride fare % exceeds corporate per-ride cap %',
      NEW.estimated_fare_trc, v_per_ride_cap;
  END IF;

  -- Monthly budget (0 = unlimited). Month-to-date spend from the completed
  -- corporate_rides ledger over the Havana calendar month (no reset cron needed).
  IF TG_OP = 'INSERT' AND COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    IF v_month_spent + COALESCE(NEW.estimated_fare_trc, 0) > v_monthly_budget THEN
      RAISE EXCEPTION 'corporate account % would exceed its monthly budget (spent % + ride % > budget %)',
        NEW.corporate_account_id, v_month_spent, NEW.estimated_fare_trc, v_monthly_budget;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_rides_validate_corporate ON public.rides;
CREATE TRIGGER trg_rides_validate_corporate
  BEFORE INSERT OR UPDATE OF corporate_account_id, payment_method, estimated_fare_trc ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.tg_rides_validate_corporate();

-- CORP-04: let the account's created_by bootstrap THEMSELVES as the first active
-- admin employee (additive policy; the existing corp-admin INSERT policy then
-- handles adding further employees).
DROP POLICY IF EXISTS corporate_employees_bootstrap_creator ON public.corporate_employees;
CREATE POLICY corporate_employees_bootstrap_creator ON public.corporate_employees
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND role = 'admin'
    AND is_active = true
    AND EXISTS (
      SELECT 1 FROM corporate_accounts ca
      WHERE ca.id = corporate_account_id AND ca.created_by = (SELECT auth.uid())
    )
    AND NOT EXISTS (
      SELECT 1 FROM corporate_employees e
      WHERE e.corporate_account_id = corporate_employees.corporate_account_id
    )
  );
