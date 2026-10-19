-- 00666: marketing runs promotions and referral amounts, and a signup code can
-- pay new drivers (design: docs/superpowers/specs/2026-10-19-marketing-autonomy-driver-signup-bonus-design.md).
--
-- A. tg_promotions_marketing_guard: marketing creates, activates, pauses and
--    edits promotions (live ones too) with no admin approval. Its activation is
--    stamped with its own id, like an admin's. It still never writes the use
--    counter, the author or the approval stamps, and still deletes only a paused
--    promotion nothing points at (a used one keeps its history). A signup code's
--    link now counts as pointing at it (promotion_is_referenced). Admins, the
--    service role and SQL without a JWT behave as before.
-- B. set_referral_amounts(jsonb): admins and marketing set the four referral
--    amounts in platform_config (integers >= 0). tg_platform_config_audit logs
--    each change with the caller's id.
-- C. acquisition_codes.driver_bonus_cup: a driver registered with the code (applied
--    at or before the driver's first approval) gets that many CUP in the tricicoin wallet on
--    the first completed ride for another person, once per confirmed phone (claim
--    'signup_driver_bonus'). Paid from platform_promotions by trg_signup_driver_bonus,
--    in a block that never rolls back the ride; a failed payment is logged in
--    rpc_attempt_log. signup_driver_bonuses keeps one row per paid bonus;
--    admin_signup_code_stats() reports them. Every change of a code's amount is
--    audited in admin_actions with who made it. The first approval is recorded in
--    driver_first_approvals (approved_at is rewritten on every approval).

SET lock_timeout = '5s';

-- 0. What this relies on is what was read from prod on 2026-10-19.
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = to_regprocedure('public.tg_promotions_marketing_guard()');
  IF v_md5 IS DISTINCT FROM '2b4dd44a23aaf0c01a47b28d6b09cae4'
     AND v_md5 IS DISTINCT FROM '146c9ffc9df39e5f4bbf36b59a17dcb8' THEN
    RAISE EXCEPTION '00666: tg_promotions_marketing_guard() is not the body read from prod (md5 %)', v_md5;
  END IF;

  -- The body read from prod, or the one this migration leaves (a second run). Nothing else.
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = to_regprocedure('public.admin_signup_code_stats()');
  IF v_md5 IS DISTINCT FROM '22b65e286149e554225824d766ba81f5'
     AND v_md5 IS DISTINCT FROM 'c743b9103a7d1eb5b794831072b26b09' THEN
    RAISE EXCEPTION '00666: admin_signup_code_stats() is not the body read from prod (md5 %)', v_md5;
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = to_regprocedure('public.promotion_is_referenced(uuid)');
  IF v_md5 IS DISTINCT FROM 'd02d1233dcb808f809ff0dcf29818a02'
     AND v_md5 IS DISTINCT FROM 'c0a5cd8f27d85b631ca9dde4db26e2ef' THEN
    RAISE EXCEPTION '00666: promotion_is_referenced(uuid) is not the body read from prod (md5 %)', v_md5;
  END IF;

  IF to_regprocedure('public._claim_reward(uuid, text, uuid, uuid)') IS NULL
     OR to_regprocedure('public.ensure_wallet_account(uuid, public.wallet_account_type)') IS NULL
     OR to_regprocedure('public.cron_http_post(text, text, jsonb, jsonb, integer)') IS NULL
     OR to_regprocedure('public.log_rpc_attempt(text, uuid, uuid, text, jsonb)') IS NULL THEN
    RAISE EXCEPTION '00666: _claim_reward, ensure_wallet_account, cron_http_post or log_rpc_attempt is missing';
  END IF;
END
$guard$;

-- A. Promotions without approval.
CREATE OR REPLACE FUNCTION public.tg_promotions_marketing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  -- What the approval and the use counter write. Every other column is content: changing it
  -- makes a new revision.
  c_bookkeeping constant text[] := ARRAY['is_active', 'notified_at', 'pending_approval',
    'approved_by', 'approved_at', 'current_uses', 'revision', 'created_at'];
  v_marketing boolean;
BEGIN
  -- Marketing's rules bind marketing's own writes through the API, nothing else. A ride claims
  -- a promotion use (tg_rides_validate_promo_discount) and gives it back on cancel
  -- (tg_rides_rollback_promo_on_cancel) inside SECURITY DEFINER triggers, with the passenger's
  -- JWT still set. There current_user is their owner, so a marketing account rides with a
  -- promo code like anyone else.
  v_marketing := current_user IN ('anon', 'authenticated') AND public.is_marketing();

  IF TG_OP = 'DELETE' THEN
    -- Only a paused promotion that nothing points at. Deleting one that a ride, a use or a
    -- campaign still names would rewrite their history (the foreign keys set it to NULL).
    IF v_marketing AND (OLD.is_active OR OLD.current_uses > 0
                        OR public.promotion_is_referenced(OLD.id)) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'Solo se puede borrar una promoción pausada que nadie usó.',
        DETAIL = 'promo_delete_blocked';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.revision := 0;
    IF v_marketing THEN
      -- 00666: what marketing sends for is_active stands (no approval). The author, the
      -- counters and the stamps start clean; the block below stamps one born active.
      NEW.pending_approval := false;
      NEW.created_by := auth.uid();
      NEW.approved_by := NULL;
      NEW.approved_at := NULL;
      NEW.current_uses := 0;
      NEW.notified_at := NULL;
    END IF;
  ELSE
    -- Nobody writes the revision. It only counts content changes (below).
    NEW.revision := OLD.revision;
    IF v_marketing THEN
      -- 00666: marketing edits any promotion, live or paused, and turns it on or off. It
      -- never writes the use counter, the author or the approval stamps (the block below
      -- stamps a new activation), and nothing it saves waits for an admin.
      NEW.pending_approval := false;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.created_by := OLD.created_by;
      NEW.current_uses := OLD.current_uses;
    END IF;
    IF (to_jsonb(NEW) - c_bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - c_bookkeeping) THEN
      NEW.revision := OLD.revision + 1;
    END IF;
  END IF;

  -- Turning a promotion on, by anyone, ends its wait for approval. An admin's, a super_admin's
  -- or (00666) marketing's activation records who did it; the service role, cron and SQL
  -- without a JWT turn it on unstamped.
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active) THEN
    NEW.pending_approval := false;
    IF public.is_admin() OR v_marketing THEN
      NEW.approved_by := auth.uid();
      NEW.approved_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- A promotion a signup code links to (00665) is pointed at too: marketing cannot delete it, so the
-- code never loses its promotion behind an admin's back. From the live body, one condition added.
CREATE OR REPLACE FUNCTION public.promotion_is_referenced(p_promotion_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN NOT (public.is_marketing() OR public.is_admin()) THEN false
    ELSE EXISTS (SELECT 1 FROM public.rides WHERE promo_code_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.promotion_uses WHERE promotion_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.campaigns WHERE promo_code_id = p_promotion_id)
      OR EXISTS (SELECT 1 FROM public.acquisition_codes WHERE promotion_id = p_promotion_id)
  END;
$function$;
REVOKE ALL ON FUNCTION public.promotion_is_referenced(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promotion_is_referenced(uuid) TO authenticated;

-- B. Referral amounts, for admins and marketing.
CREATE OR REPLACE FUNCTION public.set_referral_amounts(p_amounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_keys constant text[] := ARRAY['referral_bonus_cup', 'referral_bonus_driver_cup',
    'referral_welcome_bonus_cup', 'referral_welcome_bonus_driver_cup'];
  v_key text;
  v_val jsonb;
  v_num numeric;
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_amounts IS NULL OR jsonb_typeof(p_amounts) IS DISTINCT FROM 'object' OR p_amounts = '{}'::jsonb THEN
    RETURN jsonb_build_object('error', 'nothing_to_save');
  END IF;

  -- Everything is checked before anything is written.
  FOR v_key, v_val IN SELECT e.key, e.value FROM jsonb_each(p_amounts) AS e LOOP
    IF NOT (v_key = ANY (c_keys)) THEN
      RETURN jsonb_build_object('error', 'unknown_key', 'key', v_key);
    END IF;
    IF jsonb_typeof(v_val) IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('error', 'invalid_amount', 'key', v_key);
    END IF;
    v_num := (v_val #>> '{}')::numeric;
    -- No cap (owner, 2026-10-19), but an integer the referral triggers can read as one.
    IF v_num < 0 OR v_num <> trunc(v_num) OR v_num > 2147483647 THEN
      RETURN jsonb_build_object('error', 'invalid_amount', 'key', v_key);
    END IF;
  END LOOP;

  -- tg_platform_config_audit logs each changed value with auth.uid(); an equal value writes nothing.
  FOR v_key, v_val IN SELECT e.key, e.value FROM jsonb_each(p_amounts) AS e LOOP
    INSERT INTO public.platform_config AS pc (key, value)
    VALUES (v_key, to_jsonb((v_val #>> '{}')::numeric::bigint))
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE pc.value IS DISTINCT FROM EXCLUDED.value;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'amounts',
    (SELECT jsonb_object_agg(k.key, COALESCE(pc.value, '0'::jsonb))
       FROM unnest(c_keys) AS k(key)
       LEFT JOIN public.platform_config pc ON pc.key = k.key));
END;
$function$;
REVOKE ALL ON FUNCTION public.set_referral_amounts(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_referral_amounts(jsonb) TO authenticated, service_role;

-- C. Wallet balance for drivers who register with a signup code.
ALTER TABLE public.acquisition_codes
  ADD COLUMN IF NOT EXISTS driver_bonus_cup integer NOT NULL DEFAULT 0 CHECK (driver_bonus_cup >= 0);
COMMENT ON COLUMN public.acquisition_codes.driver_bonus_cup IS
  '00666: CUP credited to the tricicoin wallet of a driver registered with this code (applied at or before the first approval), on the first completed ride for another person, once per confirmed phone. 0 = off.';

-- Every change of a code's amount is money policy: audited with who made it, like platform_config.
CREATE OR REPLACE FUNCTION public.tg_acquisition_codes_bonus_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.driver_bonus_cup > 0 THEN
      INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
      VALUES (COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid), 'update_signup_driver_bonus',
              'acquisition_code', NEW.code, NULL, jsonb_build_object('driver_bonus_cup', NEW.driver_bonus_cup));
    END IF;
  ELSIF NEW.driver_bonus_cup IS DISTINCT FROM OLD.driver_bonus_cup THEN
    INSERT INTO public.admin_actions (admin_id, action, target_type, target_id, old_values, new_values)
    VALUES (COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid), 'update_signup_driver_bonus',
            'acquisition_code', NEW.code, jsonb_build_object('driver_bonus_cup', OLD.driver_bonus_cup),
            jsonb_build_object('driver_bonus_cup', NEW.driver_bonus_cup));
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_acquisition_codes_bonus_audit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_acquisition_codes_bonus_audit
  AFTER INSERT OR UPDATE OF driver_bonus_cup ON public.acquisition_codes
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_acquisition_codes_bonus_audit();

-- One row per paid bonus. No foreign keys on purpose (like reward_claims, 00658): the row is
-- history and survives the account's deletion; the phone claim stops a second payment.
CREATE TABLE IF NOT EXISTS public.signup_driver_bonuses (
  user_id uuid PRIMARY KEY,
  code text NOT NULL,
  amount_cup integer NOT NULL CHECK (amount_cup > 0),
  ride_id uuid,
  transaction_id uuid,
  paid_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signup_driver_bonuses_code ON public.signup_driver_bonuses (code);
ALTER TABLE public.signup_driver_bonuses ENABLE ROW LEVEL SECURITY;
-- A lock table: no policies; only SECURITY DEFINER functions read or write it.
REVOKE ALL ON public.signup_driver_bonuses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.signup_driver_bonuses TO service_role;
COMMENT ON TABLE public.signup_driver_bonuses IS
  '00666: signup-code bonuses paid to drivers (one per account). Written by trg_signup_driver_bonus.';

CREATE OR REPLACE FUNCTION public.trg_signup_driver_bonus()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_platform_user_id constant uuid := '00000000-0000-0000-0000-000000000001';
  v_driver_user uuid;
  v_code text;
  v_amount integer;
  v_code_at timestamptz;
  v_approved_at timestamptz;
  v_first_approved_at timestamptz;
  v_qualifying integer;
  v_driver_account uuid;
  v_platform_account uuid;
  v_driver_balance integer;
  v_platform_balance integer;
  v_txn uuid;
  v_key text;
BEGIN
  IF NEW.driver_id IS NULL OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT dp.user_id, u.signup_code, ac.driver_bonus_cup, u.signup_code_at, dp.approved_at, fa.first_approved_at
    INTO v_driver_user, v_code, v_amount, v_code_at, v_approved_at, v_first_approved_at
  FROM public.driver_profiles dp
  JOIN public.users u ON u.id = dp.user_id
  JOIN public.acquisition_codes ac ON ac.code = u.signup_code
  LEFT JOIN public.driver_first_approvals fa ON fa.driver_profile_id = dp.id
  WHERE dp.id = NEW.driver_id;

  -- No code, a code that pays nothing, or a ride the driver requested for themselves.
  IF v_driver_user IS NULL OR COALESCE(v_amount, 0) <= 0 OR NEW.customer_id = v_driver_user THEN
    RETURN NEW;
  END IF;

  -- For drivers who registered with the code: it was applied at or before the first approval. An
  -- approved driver who adds a code later (apply_signup_code takes one at any time) gets nothing,
  -- also after a re-approval: approved_at is rewritten on every approval, so the first one comes
  -- from driver_first_approvals (LEAST skips it when the row is missing).
  IF v_code_at IS NULL OR v_approved_at IS NULL
     OR v_code_at > LEAST(v_first_approved_at, v_approved_at) THEN
    RETURN NEW;
  END IF;

  -- Only the driver's first completed ride for another person pays (this one included: the
  -- trigger runs AFTER the update). Same rule as the driver referral bonus (00615).
  SELECT count(*) INTO v_qualifying
  FROM public.rides r
  WHERE r.driver_id = NEW.driver_id
    AND r.status = 'completed'
    AND r.customer_id IS NOT NULL
    AND r.customer_id <> v_driver_user;
  IF v_qualifying <> 1 THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM public.signup_driver_bonuses b WHERE b.user_id = v_driver_user) THEN
    RETURN NEW;
  END IF;

  -- The money block never rolls back the ride completion. The phone claim is taken inside it,
  -- so a failed payment gives it back with everything else.
  BEGIN
    -- One bonus per confirmed phone, whatever the code: no confirmed phone, or a phone already
    -- paid (also from an account deleted since), pays nothing.
    IF public._claim_reward(v_driver_user, 'signup_driver_bonus', NEW.id, NULL) IS DISTINCT FROM 'claimed' THEN
      RETURN NEW;
    END IF;

    v_driver_account := public.ensure_wallet_account(v_driver_user, 'tricicoin');
    v_platform_account := public.ensure_wallet_account(v_platform_user_id, 'platform_promotions');
    -- Platform first, then the driver: the order of the referral triggers.
    SELECT balance INTO v_platform_balance FROM public.wallet_accounts WHERE id = v_platform_account FOR UPDATE;
    SELECT balance INTO v_driver_balance FROM public.wallet_accounts WHERE id = v_driver_account FOR UPDATE;

    v_key := 'signup_driver_bonus:' || v_driver_user::text;
    INSERT INTO public.ledger_transactions (idempotency_key, type, status, reference_type, reference_id,
                                            description, created_by)
    VALUES (v_key, 'promo_credit', 'posted', 'signup_driver_bonus', NEW.id,
            'Bono de bienvenida - código ' || v_code, v_driver_user)
    RETURNING id INTO v_txn;

    INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn, v_platform_account, -v_amount, v_platform_balance - v_amount),
           (v_txn, v_driver_account, v_amount, v_driver_balance + v_amount);
    UPDATE public.wallet_accounts SET balance = balance - v_amount WHERE id = v_platform_account;
    UPDATE public.wallet_accounts SET balance = balance + v_amount WHERE id = v_driver_account;

    INSERT INTO public.signup_driver_bonuses (user_id, code, amount_cup, ride_id, transaction_id)
    VALUES (v_driver_user, v_code, v_amount, NEW.id, v_txn);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup driver bonus failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
    -- Written after the block rolled back, so the record stays. Logging must never block the ride
    -- either: log_rpc_attempt swallows its own errors, and the inner block covers it missing.
    BEGIN
      PERFORM public.log_rpc_attempt('trg_signup_driver_bonus', v_driver_user, NEW.id, 'payment_failed',
        jsonb_build_object('sqlstate', SQLSTATE, 'error', SQLERRM, 'code', v_code, 'amount_cup', v_amount));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'signup driver bonus: logging the failure of ride % failed: % %', NEW.id, SQLSTATE, SQLERRM;
    END;
    RETURN NEW;
  END;

  -- The push, in a block of its own: a failure never takes back the credit.
  BEGIN
    PERFORM public.cron_http_post('signup-driver-bonus',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || public.get_service_role_key(),
                                    'apikey', public.get_service_role_key()),
      body    := jsonb_build_object('user_id', v_driver_user::text,
                                    'title', 'Recibiste un bono de bienvenida',
                                    'body', 'Te acreditamos ' || v_amount || ' CUP en tu billetera por tu primer viaje.',
                                    'category', 'system',
                                    -- No ride_id: with one, the driver's inbox opens that trip.
                                    'data', jsonb_build_object('event', 'signup_driver_bonus', 'amount_cup', v_amount)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'signup driver bonus push failed for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_signup_driver_bonus() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_signup_driver_bonus
  AFTER UPDATE OF status ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION public.trg_signup_driver_bonus();

-- The driver's first approval, kept apart from driver_profiles.approved_at: the panel rewrites
-- approved_at on every approval (approveDriver), so a driver back from review (after a vehicle
-- change, 00650) would look approved today, after a code added later. trg_signup_driver_bonus
-- compares the code's date with the earlier of the two. A lock table: no policies; only SECURITY
-- DEFINER functions read or write it.
CREATE TABLE IF NOT EXISTS public.driver_first_approvals (
  driver_profile_id uuid PRIMARY KEY REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  first_approved_at timestamptz NOT NULL
);
ALTER TABLE public.driver_first_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.driver_first_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_first_approvals TO service_role;
COMMENT ON TABLE public.driver_first_approvals IS
  '00666: when each driver profile was first approved (approved_at is rewritten on every approval). Written by trg_driver_profiles_first_approval, read by trg_signup_driver_bonus.';

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_first_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- The first approval only: a later one finds the row and leaves it. Recording it never blocks
  -- the approval; with no row, the bonus falls back to approved_at.
  BEGIN
    INSERT INTO public.driver_first_approvals (driver_profile_id, first_approved_at)
    VALUES (NEW.id, COALESCE(NEW.approved_at, now()))
    ON CONFLICT (driver_profile_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'first approval of driver profile % not recorded: % %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_driver_profiles_first_approval() FROM PUBLIC, anon, authenticated;

-- Created under the lock_timeout set at the top: an approval in flight makes it wait 5 s at most.
CREATE OR REPLACE TRIGGER trg_driver_profiles_first_approval
  AFTER INSERT OR UPDATE OF status ON public.driver_profiles
  FOR EACH ROW
  WHEN (NEW.status = 'approved')
  EXECUTE FUNCTION public.tg_driver_profiles_first_approval();

-- Profiles approved before this migration: their approval date is the only record there is.
-- A second run keeps the rows it finds.
INSERT INTO public.driver_first_approvals (driver_profile_id, first_approved_at)
SELECT dp.id, dp.approved_at
  FROM public.driver_profiles dp
  WHERE dp.approved_at IS NOT NULL
ON CONFLICT (driver_profile_id) DO NOTHING;

-- Stats: the code's amount, how many drivers were paid and how much. Adding columns changes the
-- return type, so DROP + CREATE with the same grants.
DROP FUNCTION IF EXISTS public.admin_signup_code_stats();
CREATE FUNCTION public.admin_signup_code_stats()
 RETURNS TABLE(code text, label text, channel text, audience text, is_active boolean, created_at timestamp with time zone, signups bigint, rider_signups bigint, driver_signups bigint, drivers_approved bigint, riders_with_ride bigint, drivers_with_ride bigint, promotion_id uuid, promotion_code text, promo_rides bigint, driver_bonus_cup integer, drivers_bonus_paid bigint, driver_bonus_paid_cup bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_marketing()) THEN
    RAISE EXCEPTION 'Admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH u AS (
    SELECT u.id, u.signup_code, dp.id AS dp_id, dp.status AS dp_status
    FROM public.users u
    LEFT JOIN public.driver_profiles dp ON dp.user_id = u.id
    WHERE u.signup_code IS NOT NULL
  )
  SELECT
    ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at,
    count(u.id),
    count(u.id) FILTER (WHERE u.dp_id IS NULL),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL),
    count(u.id) FILTER (WHERE u.dp_status = 'approved'),
    count(u.id) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.rides r WHERE r.customer_id = u.id AND r.status = 'completed')),
    count(u.id) FILTER (WHERE u.dp_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.rides r WHERE r.driver_id = u.dp_id AND r.status = 'completed')),
    ac.promotion_id,
    p.code::text,
    (SELECT count(*) FROM public.rides r
       JOIN public.users ru ON ru.id = r.customer_id
      WHERE ac.promotion_id IS NOT NULL
        AND ru.signup_code = ac.code
        AND r.promo_code_id = ac.promotion_id
        AND r.status = 'completed'),
    ac.driver_bonus_cup,
    (SELECT count(*) FROM public.signup_driver_bonuses b WHERE b.code = ac.code),
    (SELECT COALESCE(sum(b.amount_cup), 0)::bigint FROM public.signup_driver_bonuses b WHERE b.code = ac.code)
  FROM public.acquisition_codes ac
  LEFT JOIN public.promotions p ON p.id = ac.promotion_id
  LEFT JOIN u ON u.signup_code = ac.code
  GROUP BY ac.code, ac.label, ac.channel, ac.audience, ac.is_active, ac.created_at, ac.promotion_id, p.code,
           ac.driver_bonus_cup
  ORDER BY count(u.id) DESC, ac.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_signup_code_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_signup_code_stats() TO authenticated, service_role;

-- A copy pasted with Windows line ends puts carriage returns in the function bodies. They run the same, but
-- their md5 no longer matches git. Rebuild them from the catalog.
DO $crlf$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('tg_promotions_marketing_guard', 'set_referral_amounts', 'trg_signup_driver_bonus',
                        'admin_signup_code_stats', 'promotion_is_referenced', 'tg_acquisition_codes_bonus_audit',
                        'tg_driver_profiles_first_approval')
      AND position(chr(13) IN p.prosrc) > 0
  LOOP
    EXECUTE replace(pg_get_functiondef(r.oid), chr(13), '');
  END LOOP;
END
$crlf$;

-- What this migration promises, checked in the database it just changed.
DO $verify$
DECLARE
  r record;
  v_path text := current_setting('search_path');
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_promotions_marketing_guard()'::regprocedure)
     IS DISTINCT FROM '146c9ffc9df39e5f4bbf36b59a17dcb8' THEN
    RAISE EXCEPTION '00666 check: tg_promotions_marketing_guard has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.trg_signup_driver_bonus()'::regprocedure)
     IS DISTINCT FROM 'b2f060309058f1cd4a321a08e7acedfc' THEN
    RAISE EXCEPTION '00666 check: trg_signup_driver_bonus has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.promotion_is_referenced(uuid)'::regprocedure)
     IS DISTINCT FROM 'c0a5cd8f27d85b631ca9dde4db26e2ef' THEN
    RAISE EXCEPTION '00666 check: promotion_is_referenced has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_acquisition_codes_bonus_audit()'::regprocedure)
     IS DISTINCT FROM 'c3731384cd8f09884c1be1de4d68a2cc' THEN
    RAISE EXCEPTION '00666 check: tg_acquisition_codes_bonus_audit has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_driver_profiles_first_approval()'::regprocedure)
     IS DISTINCT FROM 'ac953cb95443b406224b24f94fc7cdef' THEN
    RAISE EXCEPTION '00666 check: tg_driver_profiles_first_approval has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.set_referral_amounts(jsonb)'::regprocedure)
     IS DISTINCT FROM 'cd6a37dea2a53f4674549af28e3c2e9a' THEN
    RAISE EXCEPTION '00666 check: set_referral_amounts has an unexpected body';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.admin_signup_code_stats()'::regprocedure)
     IS DISTINCT FROM 'c743b9103a7d1eb5b794831072b26b09' THEN
    RAISE EXCEPTION '00666 check: admin_signup_code_stats has an unexpected body';
  END IF;

  -- The guard is still the trigger on promotions, and still SECURITY INVOKER: inside a SECURITY
  -- DEFINER function current_user is the owner and marketing would never be recognised.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.promotions'::regclass AND t.tgname = 'trg_promotions_marketing_guard'
                    AND t.tgfoid = 'public.tg_promotions_marketing_guard()'::regprocedure AND t.tgenabled = 'O')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.tg_promotions_marketing_guard()'::regprocedure) THEN
    RAISE EXCEPTION '00666 check: the promotions guard is not an enabled SECURITY INVOKER trigger';
  END IF;

  -- The five functions that need the owner's rights are SECURITY DEFINER with a fixed path.
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig FROM pg_proc p
    WHERE p.oid IN ('public.set_referral_amounts(jsonb)'::regprocedure, 'public.trg_signup_driver_bonus()'::regprocedure,
                    'public.admin_signup_code_stats()'::regprocedure, 'public.tg_acquisition_codes_bonus_audit()'::regprocedure,
                    'public.tg_driver_profiles_first_approval()'::regprocedure)
  LOOP
    IF NOT (r.prosecdef AND COALESCE(r.proconfig && ARRAY['search_path=public, pg_catalog'], false)) THEN
      RAISE EXCEPTION '00666 check: % is not SECURITY DEFINER with a fixed search_path', r.fn;
    END IF;
  END LOOP;
  IF NOT COALESCE((SELECT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc
                    WHERE oid = 'public.promotion_is_referenced(uuid)'::regprocedure), false) THEN
    RAISE EXCEPTION '00666 check: promotion_is_referenced lost SECURITY DEFINER or its empty search_path';
  END IF;

  IF has_function_privilege('anon', 'public.set_referral_amounts(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_referral_amounts(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.admin_signup_code_stats()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.trg_signup_driver_bonus()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.trg_signup_driver_bonus()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_acquisition_codes_bonus_audit()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_acquisition_codes_bonus_audit()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_driver_profiles_first_approval()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_driver_profiles_first_approval()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.promotion_is_referenced(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.promotion_is_referenced(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '00666 check: wrong EXECUTE grants on the new functions';
  END IF;

  -- The three triggers as written above, enabled. pg_get_triggerdef qualifies names by search_path: pin it.
  PERFORM set_config('search_path', '', true);
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.rides'::regclass AND t.tgname = 'trg_signup_driver_bonus' AND t.tgenabled = 'O')
     IS DISTINCT FROM 'CREATE TRIGGER trg_signup_driver_bonus AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = ''completed''::public.ride_status) AND (old.status IS DISTINCT FROM ''completed''::public.ride_status))) EXECUTE FUNCTION public.trg_signup_driver_bonus()' THEN
    RAISE EXCEPTION '00666 check: trg_signup_driver_bonus is not the expected trigger on rides';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.acquisition_codes'::regclass AND t.tgname = 'trg_acquisition_codes_bonus_audit' AND t.tgenabled = 'O')
     IS DISTINCT FROM 'CREATE TRIGGER trg_acquisition_codes_bonus_audit AFTER INSERT OR UPDATE OF driver_bonus_cup ON public.acquisition_codes FOR EACH ROW EXECUTE FUNCTION public.tg_acquisition_codes_bonus_audit()' THEN
    RAISE EXCEPTION '00666 check: trg_acquisition_codes_bonus_audit is not the expected trigger on acquisition_codes';
  END IF;
  IF (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
       WHERE t.tgrelid = 'public.driver_profiles'::regclass AND t.tgname = 'trg_driver_profiles_first_approval' AND t.tgenabled = 'O')
     IS DISTINCT FROM 'CREATE TRIGGER trg_driver_profiles_first_approval AFTER INSERT OR UPDATE OF status ON public.driver_profiles FOR EACH ROW WHEN ((new.status = ''approved''::public.driver_status)) EXECUTE FUNCTION public.tg_driver_profiles_first_approval()' THEN
    RAISE EXCEPTION '00666 check: trg_driver_profiles_first_approval is not the expected trigger on driver_profiles';
  END IF;
  PERFORM set_config('search_path', v_path, true);

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_driver_bonuses'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.signup_driver_bonuses'::regclass)
     OR has_table_privilege('anon', 'public.signup_driver_bonuses', 'SELECT')
     OR has_table_privilege('authenticated', 'public.signup_driver_bonuses', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.signup_driver_bonuses', 'INSERT') THEN
    RAISE EXCEPTION '00666 check: signup_driver_bonuses is not a service-role-only lock table';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.driver_first_approvals'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.driver_first_approvals'::regclass)
     OR has_table_privilege('anon', 'public.driver_first_approvals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.driver_first_approvals', 'SELECT')
     OR has_table_privilege('authenticated', 'public.driver_first_approvals', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.driver_first_approvals', 'INSERT') THEN
    RAISE EXCEPTION '00666 check: driver_first_approvals is not a service-role-only lock table';
  END IF;
  IF EXISTS (SELECT 1 FROM public.driver_profiles dp
              WHERE dp.approved_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM public.driver_first_approvals fa WHERE fa.driver_profile_id = dp.id)) THEN
    RAISE EXCEPTION '00666 check: a driver profile with an approval date has no first-approval row';
  END IF;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'acquisition_codes' AND column_name = 'driver_bonus_cup')
     IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '00666 check: acquisition_codes.driver_bonus_cup is missing or has no 0 default';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('tg_promotions_marketing_guard', 'set_referral_amounts', 'trg_signup_driver_bonus',
                        'admin_signup_code_stats', 'promotion_is_referenced', 'tg_acquisition_codes_bonus_audit',
                        'tg_driver_profiles_first_approval')
      AND position(chr(13) IN p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION '00666 check: a function body still has a carriage return';
  END IF;
END
$verify$;

RESET lock_timeout;
