-- ============================================================
-- 00625 — corporate rides are prepaid; the company sets its own budget and cap
--
-- WHY (measured in prod on 2026-10-07)
--   1. Nothing checked the company's balance. tg_rides_validate_corporate
--      checks approval, employment, the per-ride cap and the monthly budget,
--      and handle_corporate_ride_completion then charges the creator's
--      corporate_cash wallet without looking at it: an empty company could
--      run up a debt as large as its employees wanted.
--   2. The company could not set its budget or its per-ride cap. The client
--      app and the web offer both fields to the company's admins, and
--      tg_corporate_accounts_protect_admin_fields reverted them for every
--      JWT that is not a platform admin, with no error: the screen said
--      "Guardado" and nothing changed.
--   3. corporate_accounts.current_month_spent never goes back to 0. The
--      completion trigger adds each ride to it and the cron that reset it
--      (00027) is gone, so the client and web budget bars, and their
--      pre-check before asking a ride, used the spend of the whole history.
--   4. Every rejection was in English with internal ids ("corporate account
--      <uuid> is not approved (status=pending)"), and the apps showed it as is.
--   There are 0 corporate accounts in prod today.
--
-- WHAT
--   tg_rides_validate_corporate (same checks, plus):
--     - A ride paid by a company (payment_method = 'corporate') is accepted
--       only if the wallet that funds it covers its estimated fare: the
--       creator's corporate_cash balance, minus held_balance, minus the
--       estimates of the other in-flight corporate rides of every company of
--       that creator (they share the wallet). The wallet row is locked first,
--       so two rides asked at the same time cannot both spend the same money.
--       A company with no wallet has nothing to spend.
--     - The monthly budget also counts the company's in-flight rides, not
--       only the completed ones.
--     - Both run when a ride starts being charged to a company (INSERT, or an
--       UPDATE that changes the company or the payment method) and when its
--       estimate goes up, and only while the ride is in flight. A status
--       change never fires this trigger, so a ride that already started is
--       never stopped by it. Completion can still charge more than the
--       estimate (waiting time): prepaid covers the estimate, not every peso.
--     - Every rejection has a Spanish MESSAGE and a DETAIL code that starts
--       with corporate_ (PostgREST returns it as error.details).
--   tg_corporate_accounts_protect_admin_fields: an admin of the company may
--     now change monthly_budget_trc and per_ride_cap_trc (0 = no limit). The
--     rest is protected as before, and the completion path (trusted flag)
--     still cannot touch them. Both columns must be >= 0.
--   refresh_corporate_month_spend(): sets current_month_spent to the
--     company's completed corporate rides of the current month in Havana.
--     Runs now and every hour at minute 2 (cron refresh-corporate-month-spend),
--     so the month rolls over 2 minutes after midnight.
-- ============================================================

SET lock_timeout = '5s';

DO $pre$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_rides_validate_corporate()');
  IF v_md5 IS DISTINCT FROM 'a638a60e8f3e244c3136846a3ea4bbe0' -- before 00625
     AND v_md5 IS DISTINCT FROM '17bd1b28f1cf42550da942a102f008ba' THEN -- 00625 validate
    RAISE EXCEPTION '00625: unexpected body of tg_rides_validate_corporate (md5 %), not replacing it', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_corporate_accounts_protect_admin_fields()');
  IF v_md5 IS DISTINCT FROM '6516f2cfecb1374af6295a28b61c8aef' -- before 00625
     AND v_md5 IS DISTINCT FROM 'f84d5d8db97c7d07dbc46061ce5e5055' THEN -- 00625 protect
    RAISE EXCEPTION '00625: unexpected body of tg_corporate_accounts_protect_admin_fields (md5 %), not replacing it', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.refresh_corporate_month_spend()');
  IF v_md5 IS NOT NULL AND v_md5 <> '868268ee2d6988b4f6493e6ed4305779' THEN -- 00625 refresh
    RAISE EXCEPTION '00625: unexpected body of refresh_corporate_month_spend (md5 %), not replacing it', v_md5;
  END IF;
END
$pre$;

-- 1. The ride gate. ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  v_creator uuid;
  v_per_ride_cap integer;
  v_monthly_budget integer;
  v_month_spent integer;
  v_in_flight integer;
  v_fare integer;
  v_wallet_id uuid;
  v_balance integer;
  v_held integer;
  v_check_money boolean;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    IF NEW.payment_method = 'corporate' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Elige la empresa que paga el viaje.',
        DETAIL = 'corporate_account_required';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, created_by, per_ride_cap_trc, monthly_budget_trc
    INTO v_status, v_creator, v_per_ride_cap, v_monthly_budget
  FROM corporate_accounts WHERE id = NEW.corporate_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa que paga el viaje no existe.',
      DETAIL = 'corporate_not_found';
  END IF;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La cuenta de la empresa no está habilitada para pagar viajes.',
      DETAIL = 'corporate_not_approved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No eres empleado activo de esta empresa.',
      DETAIL = 'corporate_not_employee';
  END IF;

  v_fare := COALESCE(NULLIF(NEW.estimated_fare_trc, 0), NULLIF(NEW.estimated_fare_cup, 0), 0);
  IF TG_OP = 'INSERT' AND v_fare <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No se pudo calcular el precio del viaje. Vuelve a intentarlo.',
      DETAIL = 'corporate_fare_required';
  END IF;

  IF COALESCE(v_per_ride_cap, 0) > 0 AND v_fare > v_per_ride_cap THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('El viaje cuesta %s CUP y la empresa paga hasta %s CUP por viaje.', v_fare, v_per_ride_cap),
      DETAIL = 'corporate_over_ride_cap';
  END IF;

  -- Money: only while the company starts paying this ride or its estimate goes
  -- up, and only for a ride in flight.
  v_check_money := NEW.payment_method = 'corporate'
    AND NEW.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
    AND (TG_OP = 'INSERT'
         OR NEW.corporate_account_id IS DISTINCT FROM OLD.corporate_account_id
         OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
         OR v_fare > COALESCE(NULLIF(OLD.estimated_fare_trc, 0), NULLIF(OLD.estimated_fare_cup, 0), 0));
  IF v_check_money IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Lock the wallet that funds the company (its creator's) before reading what
  -- is already committed against it, so concurrent rides queue here.
  SELECT id, balance, held_balance INTO v_wallet_id, v_balance, v_held
  FROM wallet_accounts
  WHERE user_id = v_creator AND account_type = 'corporate_cash'
  FOR UPDATE;

  IF COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
      INTO v_in_flight
    FROM rides r
    WHERE r.corporate_account_id = NEW.corporate_account_id
      AND r.payment_method = 'corporate'
      AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
      AND r.id <> NEW.id;
    IF v_month_spent + v_in_flight + v_fare > v_monthly_budget THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('El viaje cuesta %s CUP y al presupuesto mensual de la empresa le quedan %s CUP.',
                         v_fare, GREATEST(v_monthly_budget - v_month_spent - v_in_flight, 0)),
        DETAIL = 'corporate_over_monthly_budget';
    END IF;
  END IF;

  -- Prepaid: every company of the creator spends from the same wallet.
  SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
    INTO v_in_flight
  FROM rides r
  JOIN corporate_accounts ca ON ca.id = r.corporate_account_id
  WHERE ca.created_by = v_creator
    AND r.payment_method = 'corporate'
    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination')
    AND r.id <> NEW.id;
  IF v_wallet_id IS NULL OR v_fare > v_balance - v_held - v_in_flight THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa no tiene saldo suficiente para este viaje. Pídele a un administrador de la empresa que la recargue.',
      DETAIL = 'corporate_insufficient_balance';
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. The company sets its budget and cap. -------------------------------
CREATE OR REPLACE FUNCTION public.tg_corporate_accounts_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF current_setting('app.trusted_corporate_update', true) = '1' THEN
    NEW.status              := OLD.status;
    NEW.commission_percent  := OLD.commission_percent;
    NEW.monthly_budget_trc  := OLD.monthly_budget_trc;
    NEW.per_ride_cap_trc    := OLD.per_ride_cap_trc;
    NEW.is_fleet_owner      := OLD.is_fleet_owner;
    NEW.approved_at         := OLD.approved_at;
    NEW.suspended_at        := OLD.suspended_at;
    NEW.suspended_reason    := OLD.suspended_reason;
    NEW.created_by          := OLD.created_by;
    NEW.id                  := OLD.id;
    NEW.created_at          := OLD.created_at;
    RETURN NEW;
  END IF;

  -- 00625: monthly_budget_trc and per_ride_cap_trc are the company's to set
  -- (RLS lets only its active admins update the row).
  NEW.status              := OLD.status;
  NEW.commission_percent  := OLD.commission_percent;
  NEW.current_month_spent := OLD.current_month_spent;
  NEW.is_fleet_owner      := OLD.is_fleet_owner;
  NEW.approved_at         := OLD.approved_at;
  NEW.suspended_at        := OLD.suspended_at;
  NEW.suspended_reason    := OLD.suspended_reason;
  NEW.created_by          := OLD.created_by;
  NEW.id                  := OLD.id;
  NEW.created_at          := OLD.created_at;
  RETURN NEW;
END;
$function$;

DO $checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.corporate_accounts'::regclass
                   AND conname = 'corporate_accounts_monthly_budget_nonneg') THEN
    ALTER TABLE public.corporate_accounts
      ADD CONSTRAINT corporate_accounts_monthly_budget_nonneg CHECK (monthly_budget_trc >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.corporate_accounts'::regclass
                   AND conname = 'corporate_accounts_per_ride_cap_nonneg') THEN
    ALTER TABLE public.corporate_accounts
      ADD CONSTRAINT corporate_accounts_per_ride_cap_nonneg CHECK (per_ride_cap_trc >= 0);
  END IF;
END
$checks$;

-- 3. This month's spend. ------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_corporate_month_spend()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_month_start timestamptz :=
    date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana';
  v_changed integer;
BEGIN
  UPDATE corporate_accounts ca
     SET current_month_spent = s.spent
    FROM (SELECT a.id,
                 COALESCE((SELECT SUM(cr.fare_trc) FROM corporate_rides cr
                           WHERE cr.corporate_account_id = a.id
                             AND cr.created_at >= v_month_start), 0)::integer AS spent
          FROM corporate_accounts a) s
   WHERE ca.id = s.id
     AND ca.current_month_spent IS DISTINCT FROM s.spent;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_corporate_month_spend() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_corporate_month_spend() TO service_role;

SELECT public.refresh_corporate_month_spend();

SELECT cron.unschedule('refresh-corporate-month-spend')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-corporate-month-spend');
SELECT cron.schedule('refresh-corporate-month-spend', '2 * * * *',
  'SELECT public.refresh_corporate_month_spend();');

-- Assert the end state.
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_validate_corporate()'::regprocedure)
     <> '17bd1b28f1cf42550da942a102f008ba' -- 00625 validate
  THEN RAISE EXCEPTION '00625: tg_rides_validate_corporate is not the 00625 body'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_corporate_accounts_protect_admin_fields()'::regprocedure)
     <> 'f84d5d8db97c7d07dbc46061ce5e5055' -- 00625 protect
  THEN RAISE EXCEPTION '00625: tg_corporate_accounts_protect_admin_fields is not the 00625 body'; END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_corporate_month_spend()'::regprocedure)
     <> '868268ee2d6988b4f6493e6ed4305779' -- 00625 refresh
  THEN RAISE EXCEPTION '00625: refresh_corporate_month_spend is not the 00625 body'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.rides'::regclass AND tgname = 'trg_rides_validate_corporate'
                   AND tgfoid = 'public.tg_rides_validate_corporate()'::regprocedure AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '00625: trg_rides_validate_corporate is missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.corporate_accounts'::regclass
                   AND tgname = 'trg_corporate_accounts_protect_admin_fields'
                   AND tgfoid = 'public.tg_corporate_accounts_protect_admin_fields()'::regprocedure
                   AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '00625: trg_corporate_accounts_protect_admin_fields is missing or disabled';
  END IF;

  IF has_function_privilege('anon', 'public.refresh_corporate_month_spend()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refresh_corporate_month_spend()', 'EXECUTE') THEN
    RAISE EXCEPTION '00625: refresh_corporate_month_spend must not be callable by clients';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job
                 WHERE jobname = 'refresh-corporate-month-spend' AND schedule = '2 * * * *'
                   AND command = 'SELECT public.refresh_corporate_month_spend();') THEN
    RAISE EXCEPTION '00625: the refresh-corporate-month-spend cron job is not scheduled';
  END IF;
END
$check$;

RESET lock_timeout;
