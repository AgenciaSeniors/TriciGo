-- ============================================================
-- 00612 — three client writes that decided money or a review
--
-- WHY (each reproduced on prod on 2026-10-06, as real test accounts, inside
-- blocks that were rolled back)
--
-- 1. ride_splits. complete_ride_and_pay, for a tricicoin ride marked is_split,
--    debits the customer_cash wallet of every split with accepted_at set, by
--    share_pct of the fare, and the requester pays the rest. But:
--     - the requester inserts the split (split_insert only checks they own the
--       ride) and may set accepted_at, payment_status, paid_at, amount_trc and
--       invited_by themselves: a "pre-accepted" invite for someone who never
--       saw it;
--     - share_pct had no range (numeric(5,2), -999.99..999.99) and the shares
--       of a ride had no ceiling;
--     - the invitee may UPDATE every column of their split, not only accept.
--    Measured: a test customer invited another account at 100%, pre-accepted,
--    and a driver completed the trip. The requester paid 0 and the other
--    account paid the whole fare. 15 customer wallets held balance that day.
--    (customer_cash cannot go negative, so negative shares only move the
--    attacker's own money; shares above 100% in total still charge others.)
--    No split had ever been created, so nobody was charged.
-- 2. driver_documents. dd_insert lets a driver insert their own documents, and
--    nothing stopped them from inserting is_verified = true, verified_by = any
--    admin and verified_at. The admin page shows those documents as verified
--    and enables approval, and auto-admin approves a driver whose required
--    documents are all verified (auto_approve_drivers_enabled, off today).
--    The apps never send these columns.
-- 3. users.is_test. Any user may set it on their own row, and the collusion
--    review detector (detect_collusion_reviews) skips accounts marked as test.
--
-- WHAT
--  - ride_splits: CHECK share_pct in (0, 100]; the shares of a ride may not add
--    up to more than 100 (checked under a lock on the ride, for everyone); a
--    client insert starts pending, unaccepted, unpaid and invited by the
--    caller; a client update may only set accepted_at, once, to now().
--  - driver_documents: a client insert or update cannot set the review fields
--    (is_verified, verified_by, verified_at, rejection_reason,
--    verification_notes, face_match_score, liveness_passed).
--  - users: a client cannot change is_test.
-- "Client" means a JWT that is not an admin, as in the other protect triggers.
-- Admins, the service key (no JWT: Edge Functions, cron) and code running under
-- app.trusted_driver_update (complete_ride_and_pay sets it before it marks the
-- splits paid) keep full control. The closing block checks the end state.
--
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS, guarded constraint.
-- ============================================================

SET lock_timeout = '5s';

-- 1. ride_splits --------------------------------------------------------------

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.ride_splits'::regclass AND conname = 'ride_splits_share_pct_range') THEN
    ALTER TABLE public.ride_splits
      ADD CONSTRAINT ride_splits_share_pct_range CHECK (share_pct > 0 AND share_pct <= 100) NOT VALID;
  END IF;
END
$c$;
ALTER TABLE public.ride_splits VALIDATE CONSTRAINT ride_splits_share_pct_range;

CREATE OR REPLACE FUNCTION public.tg_ride_splits_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_trusted boolean;
  v_taken numeric;
BEGIN
  -- coalesce: an unset GUC reads as NULL, and NOT NULL would skip the guard.
  v_trusted := v_uid IS NULL
               OR public.is_admin()
               OR coalesce(current_setting('app.trusted_driver_update', true), '') = '1';

  IF NOT v_trusted THEN
    IF TG_OP = 'INSERT' THEN
      -- An invite starts unanswered; only the invitee accepts it.
      NEW.accepted_at := NULL;
      NEW.paid_at := NULL;
      NEW.amount_trc := NULL;
      NEW.payment_status := 'pending';
      NEW.invited_by := v_uid;
    ELSE
      -- The invitee may only accept, once. Everything else stays.
      NEW.id := OLD.id;
      NEW.ride_id := OLD.ride_id;
      NEW.user_id := OLD.user_id;
      NEW.invited_by := OLD.invited_by;
      NEW.share_pct := OLD.share_pct;
      NEW.amount_trc := OLD.amount_trc;
      NEW.payment_status := OLD.payment_status;
      NEW.paid_at := OLD.paid_at;
      NEW.created_at := OLD.created_at;
      IF OLD.accepted_at IS NOT NULL THEN
        NEW.accepted_at := OLD.accepted_at;
      ELSIF NEW.accepted_at IS NOT NULL THEN
        NEW.accepted_at := now();
      END IF;
    END IF;
  END IF;

  -- For everyone: the shares of one ride never add up to more than 100%,
  -- or the requester's part of the fare turns negative.
  IF TG_OP = 'INSERT'
     OR NEW.share_pct IS DISTINCT FROM OLD.share_pct
     OR NEW.ride_id IS DISTINCT FROM OLD.ride_id THEN
    PERFORM 1 FROM public.rides WHERE id = NEW.ride_id FOR UPDATE;
    SELECT coalesce(sum(s.share_pct), 0) INTO v_taken
    FROM public.ride_splits s
    WHERE s.ride_id = NEW.ride_id AND s.id IS DISTINCT FROM NEW.id;
    IF v_taken + NEW.share_pct > 100 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('Las partes de este viaje no pueden sumar más del 100%% (ya hay %s%%).', v_taken),
        DETAIL = 'split_over_100';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_ride_splits_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ride_splits_guard ON public.ride_splits;
CREATE TRIGGER trg_ride_splits_guard
  BEFORE INSERT OR UPDATE ON public.ride_splits
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_splits_guard();

-- 2. driver_documents -----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_driver_documents_protect_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_verified := false;
      NEW.verified_by := NULL;
      NEW.verified_at := NULL;
      NEW.rejection_reason := NULL;
      NEW.verification_notes := NULL;
      NEW.face_match_score := NULL;
      NEW.liveness_passed := NULL;
    ELSE
      NEW.is_verified := OLD.is_verified;
      NEW.verified_by := OLD.verified_by;
      NEW.verified_at := OLD.verified_at;
      NEW.rejection_reason := OLD.rejection_reason;
      NEW.verification_notes := OLD.verification_notes;
      NEW.face_match_score := OLD.face_match_score;
      NEW.liveness_passed := OLD.liveness_passed;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_driver_documents_protect_review() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_driver_documents_protect_review ON public.driver_documents;
CREATE TRIGGER trg_driver_documents_protect_review
  BEFORE INSERT OR UPDATE ON public.driver_documents
  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_documents_protect_review();

-- 3. users.is_test --------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_users_protect_is_test()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.is_test IS DISTINCT FROM OLD.is_test
     AND auth.uid() IS NOT NULL
     AND NOT public.is_admin() THEN
    NEW.is_test := OLD.is_test;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tg_users_protect_is_test() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_users_protect_is_test ON public.users;
CREATE TRIGGER trg_users_protect_is_test
  BEFORE UPDATE OF is_test ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_is_test();

-- Assert the end state ------------------------------------------------------------
DO $check$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(x.name, ', ') INTO v_missing
  FROM (VALUES
          ('public.ride_splits'::regclass, 'trg_ride_splits_guard', 'public.tg_ride_splits_guard()'::regprocedure, 4 | 16),
          ('public.driver_documents'::regclass, 'trg_driver_documents_protect_review', 'public.tg_driver_documents_protect_review()'::regprocedure, 4 | 16),
          ('public.users'::regclass, 'trg_users_protect_is_test', 'public.tg_users_protect_is_test()'::regprocedure, 16)
       ) AS x(rel, name, fn, events)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = x.rel AND t.tgname = x.name AND NOT t.tgisinternal
      AND t.tgenabled = 'O'
      AND (t.tgtype & 2) = 2            -- BEFORE
      AND (t.tgtype & 1) = 1            -- FOR EACH ROW
      AND (t.tgtype & (4 | 16)) = x.events
      AND t.tgfoid = x.fn);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '00612: missing or wrong trigger(s): %', v_missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.ride_splits'::regclass
                   AND conname = 'ride_splits_share_pct_range' AND convalidated) THEN
    RAISE EXCEPTION '00612: ride_splits_share_pct_range is missing or not validated';
  END IF;
END
$check$;

RESET lock_timeout;
