-- 00615: pay the driver-referral bonus on the referred driver's first completed ride,
-- not on approval.
--
-- Why (prod, 2026-10-06): trg_referral_reward_on_driver_approved pays
-- referral_bonus_driver_cup (1000) the moment an admin approves the referred driver.
-- All 19 referral bonuses paid so far went through that path, and 18 of those 19
-- drivers have never completed a ride. The launch plan for 2026-10-15 adds a
-- "chofer invita chofer" push and a prize for the top referrers, which would pay
-- for signing up drivers who never drive.
--
-- What changes:
--   1. New trigger trg_referral_reward_on_driver_first_ride (AFTER UPDATE ON rides,
--      on the transition to 'completed'). It pays the referrer of the ride's DRIVER
--      when that ride is the driver's first completed ride. Rides requested by the
--      referrer or by the driver himself do not count, and do not use up the
--      "first ride": the first ride with any other customer pays.
--      Mirrors the rider rule in trg_referral_reward_on_complete: a code applied
--      after the driver has already completed rides never pays.
--   2. The approval trigger is dropped. Its function stays, marked DEPRECATED, so a
--      rollback is a single CREATE TRIGGER.
--
-- The money block (amounts, wallets, ledger rows, idempotency keys, welcome bonus,
-- EXCEPTION guard) keeps the logic of the live trg_referral_reward_on_driver_approved
-- (md5(prosrc) 18ba26bd32bd10f5f9ce43aab8cb9849); only the lookup of the referral and
-- the comments differ. Same idempotency key
-- ('referral_bonus_driver:<referral id>'), so a referral already paid on approval
-- can never be paid again.
--
-- Unchanged: the rider path (trg_referral_reward_on_complete) and admin_reward_referral.
-- Known race, as before 00483: a referee who completes a ride as a PASSENGER before
-- driving consumes the referral at the passenger amount (first trigger wins).
--
-- Rehearsal: supabase/tests/00615/run.sh

-- 1. The new payer.
CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_driver_first_ride()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_driver_user_id UUID;
  v_ref RECORD;
  v_qualifying_rides INTEGER;
  v_flag_enabled BOOLEAN := false;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_welcome_trc INTEGER;
  v_referee_account_id UUID;
  v_referee_balance INTEGER;
  v_welcome_txn_id UUID;
BEGIN
  IF NEW.status <> 'completed' OR OLD.status = 'completed' OR NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT (value::TEXT)::BOOLEAN INTO v_flag_enabled
    FROM feature_flags WHERE key = 'referral_program_enabled';
  EXCEPTION WHEN OTHERS THEN
    v_flag_enabled := false;
    RAISE WARNING 'feature_flags.referral_program_enabled cast failed, treating as false';
  END;

  IF NOT COALESCE(v_flag_enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles WHERE id = NEW.driver_id;

  IF v_driver_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = v_driver_user_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  -- A ride requested by the referrer, or by the driver himself, proves nothing.
  IF NEW.customer_id IS NULL
     OR NEW.customer_id = v_ref.referrer_id
     OR NEW.customer_id = v_ref.referee_id THEN
    RETURN NEW;
  END IF;

  -- Only the driver's first qualifying completed ride pays (this one included:
  -- the trigger runs AFTER the update).
  SELECT COUNT(*) INTO v_qualifying_rides
  FROM rides
  WHERE driver_id = NEW.driver_id
    AND status = 'completed'
    AND customer_id IS NOT NULL
    AND customer_id <> v_ref.referrer_id
    AND customer_id <> v_ref.referee_id;

  IF v_qualifying_rides <> 1 THEN
    RETURN NEW;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(GREATEST((CASE WHEN get_platform_config_numeric('referral_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_bonus_cup', 500) END), 0)::integer, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- Defensive money block: a referral-reward failure must NEVER roll back the
  -- ride completion that fired this trigger.
  BEGIN
    v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, _gift_wallet_type(v_ref.referrer_id));
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

    SELECT balance INTO v_platform_balance
      FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;
    SELECT balance INTO v_referrer_balance
      FROM wallet_accounts WHERE id = v_referrer_account_id FOR UPDATE;

    BEGIN
      INSERT INTO ledger_transactions (
        id, idempotency_key, type, status,
        reference_type, reference_id,
        description, created_by
      ) VALUES (
        gen_random_uuid(),
        'referral_bonus_driver:' || v_ref.id::TEXT,
        'promo_credit', 'posted',
        'referral', v_ref.id,
        'Bono de referido conductor - codigo ' || v_ref.code,
        v_ref.referrer_id
      )
      RETURNING id INTO v_txn_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN NEW;
    END;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

    UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
    UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

    UPDATE referrals
    SET status = 'rewarded',
        bonus_amount = v_bonus_trc,
        rewarded_at = NOW(),
        transaction_id = v_txn_id
    WHERE id = v_ref.id;

    -- Optional welcome bonus for the referred driver (off while the config is 0).
    v_welcome_trc := cup_to_trc_centavos(GREATEST((CASE WHEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) > 0 THEN get_platform_config_numeric('referral_welcome_bonus_driver_cup', 0) ELSE get_platform_config_numeric('referral_welcome_bonus_cup', 0) END), 0)::integer, v_exchange_rate);
    IF v_welcome_trc > 0 THEN
      v_referee_account_id := ensure_wallet_account(v_ref.referee_id, _gift_wallet_type(v_ref.referee_id));
      SELECT balance INTO v_referee_balance
        FROM wallet_accounts WHERE id = v_referee_account_id FOR UPDATE;
      SELECT balance INTO v_platform_balance
        FROM wallet_accounts WHERE id = v_platform_account_id;

      BEGIN
        INSERT INTO ledger_transactions (
          id, idempotency_key, type, status,
          reference_type, reference_id,
          description, created_by
        ) VALUES (
          gen_random_uuid(),
          'referral_welcome:' || v_ref.id::TEXT,
          'promo_credit', 'posted',
          'referral', v_ref.id,
          'Bono de bienvenida por referido - codigo ' || v_ref.code,
          v_ref.referee_id
        )
        RETURNING id INTO v_welcome_txn_id;

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_welcome_txn_id, v_platform_account_id, -v_welcome_trc, v_platform_balance - v_welcome_trc);

        INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
        VALUES (v_welcome_txn_id, v_referee_account_id, v_welcome_trc, v_referee_balance + v_welcome_trc);

        UPDATE wallet_accounts SET balance = balance - v_welcome_trc WHERE id = v_platform_account_id;
        UPDATE wallet_accounts SET balance = balance + v_welcome_trc WHERE id = v_referee_account_id;
      EXCEPTION WHEN unique_violation THEN
        NULL; -- welcome bonus already paid (idempotent)
      END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'referral reward (on_driver_first_ride) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

-- Trigger functions cannot be called through the API, but a new function is born
-- executable by PUBLIC (and by anon/authenticated through Supabase's defaults).
DO $grants$
DECLARE r text;
BEGIN
  REVOKE ALL ON FUNCTION public.trg_referral_reward_on_driver_first_ride() FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.trg_referral_reward_on_driver_first_ride() FROM %I', r);
    END IF;
  END LOOP;
END $grants$;

DROP TRIGGER IF EXISTS trg_referral_reward_on_driver_first_ride ON public.rides;
CREATE TRIGGER trg_referral_reward_on_driver_first_ride
  AFTER UPDATE ON public.rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed'::ride_status AND OLD.status <> 'completed'::ride_status)
  EXECUTE FUNCTION public.trg_referral_reward_on_driver_first_ride();

-- 2. Stop paying on approval.
DROP TRIGGER IF EXISTS trg_referral_reward_on_driver_approved ON public.driver_profiles;

DO $deprecate$
BEGIN
  COMMENT ON FUNCTION public.trg_referral_reward_on_driver_approved() IS
    '00615 DEPRECATED: no trigger calls it. The driver-referral bonus is paid on the referred driver''s first completed ride (trg_referral_reward_on_driver_first_ride).';
EXCEPTION WHEN undefined_function THEN
  NULL;
END $deprecate$;

-- 3. Assert the result: one payer on rides, none on driver approval.
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE t.tgname = 'trg_referral_reward_on_driver_first_ride'
      AND c.oid = 'public.rides'::regclass AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '00615: trg_referral_reward_on_driver_first_ride is missing on rides';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'trg_referral_reward_on_driver_approved' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '00615: a trigger still pays the driver-referral bonus on approval';
  END IF;
END $assert$;
