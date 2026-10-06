-- ============================================================
-- 00607: guards on what a client may INSERT into ride_disputes,
--        customer_profiles and rides.wallet_ratio; disputes can be opened again
--
-- The *_protect_* triggers on ride_disputes and customer_profiles ran BEFORE
-- UPDATE only, and their INSERT policies check only who owns the row.
-- Reproduced in prod on 2026-10-05 as real accounts, inside transactions that
-- were rolled back:
--
-- 1. No dispute could be opened at all. 00038 gave ride_disputes.priority
--    DEFAULT 'normal'; 00104 (2026-04-09) added a CHECK that only accepts
--    low/medium/high/critical. disputeService.createDispute never sends a
--    priority, so every dispute from the rider app and the web has failed with
--    23514 since April (0 rows in prod). The apps use low/normal/high/urgent
--    (DisputePriority in @tricigo/types, the admin disputes page), so the CHECK
--    moves to those values.
--
-- 2. A hand-made dispute kept every column the app never sends: status
--    'resolved_rider' (process_dispute_refund then refuses it as already
--    resolved), priority, assigned_to, admin_notes, refund_amount_trc,
--    resolution, forged created_at and SLA dates, and a respondent_id naming
--    any account, which could then read the dispute while the real other party
--    never saw it. A BEFORE INSERT trigger now resets all of that for a client,
--    derives the respondent from the ride as createDispute does, and fills the
--    fare snapshot (the admin's refund cap, the driver's respond screen) from
--    the ride instead of leaving it NULL.
--
-- 3. rides.wallet_ratio took any value up to 9.99. With payment_method 'mixed'
--    and a wallet balance above the fare, complete_ride_and_pay computes a
--    wallet share larger than the fare, a negative cash share, and fails on
--    rides_cash_amount_nonneg: the driver cannot complete the trip and is not
--    paid. The apps clamp the ratio to [0, 1] (schemas.ts, ride.store.ts), so
--    a CHECK on that range refuses nothing they send (0 rows outside it).
--    enforce_ride_update_columns (00290) already stops a rider from changing
--    it later; the CHECK covers the INSERT and every other writer.
--
-- 4. A new customer_profiles row took any rating_avg (1.23 in the repro); the
--    UPDATE guard of 00434 only covers changes. The guard now also runs on
--    INSERT and starts a client-created profile at the column default, 5.00,
--    which is what the app's own insert (ensureProfile) already gets.
--
-- Already guarded, not changed here: rides status, driver_id, fares and
-- trip timestamps are forced at INSERT by tg_rides_normalize_scheduling, and
-- the discount and partner columns by tg_rides_validate_promo_discount.
-- Out of scope: estimated_fare_cup is still the client's number, checked only
-- against the minimum fare.
--
-- Trust rule, as in the UPDATE guards: admins and calls WITHOUT a JWT (service
-- role, cron, SECURITY DEFINER code running without a user) write any column.
-- A SECURITY DEFINER RPC called by a signed-in user still has the user's JWT,
-- so its INSERT is sanitized like the client's.
--
-- Lock order (the app is live while this runs): ride_disputes, then rides,
-- then customer_profiles. createDispute and process_dispute_refund take
-- ride_disputes before rides; cancel_ride and the ride INSERT's dispatch take
-- rides before customer_profiles. Taking them in the same order avoids a
-- deadlock with live traffic. customer_profiles only needs the SHARE ROW
-- EXCLUSIVE lock of CREATE OR REPLACE TRIGGER, which does not block reads.
-- ============================================================

SET lock_timeout = '2s';

-- 1. ride_disputes.priority: the values the apps use ---------------------------
-- The old CHECK goes first: the remap writes values it does not allow.
ALTER TABLE public.ride_disputes DROP CONSTRAINT IF EXISTS chk_dispute_priority_valid;

UPDATE public.ride_disputes
SET priority = CASE priority WHEN 'medium' THEN 'normal' WHEN 'critical' THEN 'urgent' END
WHERE priority IN ('medium', 'critical');

ALTER TABLE public.ride_disputes ADD CONSTRAINT chk_dispute_priority_valid
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

-- 2. ride_disputes: what a client may set when it opens a dispute ------------
CREATE OR REPLACE FUNCTION public.tg_ride_disputes_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer    uuid;
  v_driver_user uuid;
  v_has_driver  boolean;
  v_est_trc     integer;
  v_final_trc   integer;
BEGIN
  IF auth.uid() IS NULL OR is_admin() THEN
    RETURN NEW;
  END IF;

  SELECT r.customer_id, dp.user_id, r.driver_id IS NOT NULL, r.estimated_fare_trc, r.final_fare_trc
    INTO v_customer, v_driver_user, v_has_driver, v_est_trc, v_final_trc
  FROM rides r
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = NEW.ride_id;

  -- The respondent is the other party of the ride, computed the way
  -- disputeService.createDispute does; never an account the client names.
  IF v_customer = NEW.opened_by THEN
    NEW.respondent_id := v_driver_user;
  ELSIF v_has_driver THEN
    NEW.respondent_id := v_customer;
  ELSE
    NEW.respondent_id := NULL;
  END IF;

  -- The opener supplies ride_id, reason, description and evidence_urls.
  -- Everything else a dispute starts with belongs to the platform.
  NEW.status                   := 'open';
  NEW.priority                 := 'normal';
  NEW.respondent_message       := NULL;
  NEW.respondent_evidence_urls := '{}';
  NEW.respondent_replied_at    := NULL;
  NEW.resolution               := NULL;
  NEW.resolution_notes         := NULL;
  NEW.refund_amount_trc        := NULL;
  NEW.refund_transaction_id    := NULL;
  NEW.assigned_to              := NULL;
  NEW.admin_notes              := NULL;
  NEW.support_ticket_id        := NULL;
  NEW.incident_report_id       := NULL;
  NEW.resolved_at              := NULL;
  NEW.ride_estimated_fare_trc  := v_est_trc;
  NEW.ride_final_fare_trc      := v_final_trc;
  NEW.created_at               := now();
  NEW.updated_at               := NULL;
  NEW.sla_first_response_at    := now() + interval '24 hours';
  NEW.sla_resolution_deadline  := now() + interval '72 hours';
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_ride_disputes_protect_insert() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_ride_disputes_protect_insert BEFORE INSERT ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION public.tg_ride_disputes_protect_insert();

-- 3. rides.wallet_ratio stays within [0, 1] -----------------------------------
ALTER TABLE public.rides DROP CONSTRAINT IF EXISTS rides_wallet_ratio_range;
ALTER TABLE public.rides ADD CONSTRAINT rides_wallet_ratio_range
  CHECK (wallet_ratio IS NULL OR (wallet_ratio >= 0 AND wallet_ratio <= 1)) NOT VALID;
ALTER TABLE public.rides VALIDATE CONSTRAINT rides_wallet_ratio_range;

-- 4. customer_profiles.rating_avg is guarded on INSERT too -------------------
-- Refuse to replace a body this migration was not written against: the live
-- 00434 body (prod, without comments), the 00434 body as git has it, or this
-- file's own on a re-run.
DO $known$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.tg_customer_profiles_protect_rating()');
  IF v_md5 IS NOT NULL AND v_md5 NOT IN ('37b86bfe9c0c317f27cff372a4a1bd2e', '5c32f9e6012ef051b1e8b0e64bc30543',
                                         '72358ae7ebdbd6a9340a27e6a26e157f') THEN
    RAISE EXCEPTION '00607: tg_customer_profiles_protect_rating has a body this migration does not know (md5 %); start from the live body', v_md5;
  END IF;
END
$known$;

CREATE OR REPLACE FUNCTION public.tg_customer_profiles_protect_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_driver_update', true) = '1' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    -- A profile a client creates starts at the column default, like the
    -- app's own insert; apply_user_rating moves it from there.
    NEW.rating_avg := 5.00;
  ELSE
    NEW.rating_avg := OLD.rating_avg;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_customer_profiles_protect_rating BEFORE INSERT OR UPDATE ON public.customer_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_customer_profiles_protect_rating();

-- Self-test --------------------------------------------------------------------
DO $selftest$
DECLARE
  v_def   text;
  v_extra text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
  WHERE conrelid = 'public.ride_disputes'::regclass AND conname = 'chk_dispute_priority_valid';
  IF v_def IS NULL OR position('''normal''' IN v_def) = 0 OR position('''urgent''' IN v_def) = 0
     OR position('''medium''' IN v_def) > 0 OR position('''critical''' IN v_def) > 0 THEN
    RAISE EXCEPTION '00607 self-test: the ride_disputes.priority CHECK is not low/normal/high/urgent: %', v_def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.rides'::regclass AND conname = 'rides_wallet_ratio_range' AND convalidated) THEN
    RAISE EXCEPTION '00607 self-test: rides_wallet_ratio_range is missing or not validated';
  END IF;

  -- tgtype bits: 1 = row, 2 = before, 4 = insert, 16 = update
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.ride_disputes'::regclass AND tgname = 'trg_ride_disputes_protect_insert'
                   AND tgfoid = 'public.tg_ride_disputes_protect_insert()'::regprocedure
                   AND tgenabled IN ('O', 'A') AND tgtype & 7 = 7) THEN
    RAISE EXCEPTION '00607 self-test: the BEFORE INSERT guard on ride_disputes is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.customer_profiles'::regclass AND tgname = 'trg_customer_profiles_protect_rating'
                   AND tgfoid = 'public.tg_customer_profiles_protect_rating()'::regprocedure
                   AND tgenabled IN ('O', 'A') AND tgtype & 23 = 23) THEN
    RAISE EXCEPTION '00607 self-test: the rating guard on customer_profiles does not cover INSERT and UPDATE';
  END IF;

  -- A BEFORE INSERT trigger firing after a guard could write the columns back.
  SELECT string_agg(tgrelid::regclass || '.' || tgname, ', ') INTO v_extra FROM pg_trigger
  WHERE tgrelid IN ('public.ride_disputes'::regclass, 'public.customer_profiles'::regclass)
    AND NOT tgisinternal AND tgtype & 7 = 7
    AND tgname NOT IN ('trg_ride_disputes_protect_insert', 'trg_customer_profiles_protect_rating');
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION '00607 self-test: other BEFORE INSERT triggers could undo the guards: %', v_extra;
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_customer_profiles_protect_rating()'::regprocedure)
     IS DISTINCT FROM '72358ae7ebdbd6a9340a27e6a26e157f' THEN
    RAISE EXCEPTION '00607 self-test: tg_customer_profiles_protect_rating is not the 00607 body';
  END IF;
END
$selftest$;

RESET lock_timeout;
