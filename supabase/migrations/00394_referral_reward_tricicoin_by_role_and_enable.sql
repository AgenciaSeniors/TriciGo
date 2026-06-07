-- 00394_referral_reward_tricicoin_by_role_and_enable.sql
--
-- Activate the referral program and route the referral bonus to the
-- referrer's *spendable TriciCoin* wallet.
--
-- Context (verified against prod 2026-06-07):
--   * The referral feature was fully built (tables, RPCs, triggers, UI on
--     client/driver/web/admin) but NEVER used: the master switch
--     feature_flags.referral_program_enabled did not exist as a row, so the
--     two reward triggers exited early (COALESCE(NULL,false) = false) and no
--     bonus was ever paid. 0 codes, 0 referrals.
--   * The three reward paths credited the referrer's 'customer_cash' wallet
--     regardless of role.
--
-- Changes in this migration:
--   1. Enable the program: seed feature_flags.referral_program_enabled = true.
--   2. Pay the bonus to the referrer's spendable TriciCoin, by ROLE:
--        driver  -> 'tricicoin'      (their spendable balance)
--        else    -> 'customer_cash'  (a passenger's spendable TriciCoin)
--      Resolved via the existing _gift_wallet_type(user_id) helper (the same
--      helper the "Regalo"/gift feature uses). This guarantees the bonus is
--      always spendable on rides. A flat 'tricicoin' for everyone would trap
--      a passenger's funds, because complete_ride_and_pay debits a customer
--      from 'customer_cash' only.
--   3. Make the two TRIGGERS non-blocking: wrap the money movement in a
--      defensive sub-block so that ANY referral-reward failure can NEVER roll
--      back the ride completion / driver approval that fired it. This mirrors
--      the canonical TriciGo trigger pattern (e.g. tg_rides_create_estimate_
--      snapshot: "a failed snapshot must never block ride creation").
--      The admin RPC (admin_reward_referral) deliberately KEEPS raising on
--      failure — it is invoked by an explicit admin action and the admin must
--      see the error.
--
-- The bonus amount (500 CUP, 1:1 with TriciCoin), the CUP->TRC conversion,
-- the idempotency keys, the FOR UPDATE locking order (platform then referrer),
-- and the "first completed ride" / "first approval" gates are UNCHANGED — the
-- bodies below are reproduced verbatim from the live prod functions with only
-- the referrer-credit line and the defensive wrapper modified.
--
-- platform_promotions (owned by system user ...0001) is a source account; it
-- is allowed to go negative (CHECK constrains only customer_cash >= 0), so the
-- platform debit never fails on the balance constraint.

-- ---------------------------------------------------------------------------
-- 1. Enable the referral program (idempotent, constraint-agnostic).
-- ---------------------------------------------------------------------------
UPDATE feature_flags
   SET value = true, updated_at = NOW()
 WHERE key = 'referral_program_enabled';

INSERT INTO feature_flags (key, value, description)
SELECT 'referral_program_enabled', true, 'Habilitar programa de referidos'
WHERE NOT EXISTS (
  SELECT 1 FROM feature_flags WHERE key = 'referral_program_enabled'
);

-- ---------------------------------------------------------------------------
-- 2. Passenger first completed ride -> reward the referrer.
--    Role-based wallet + defensive (non-blocking) money block.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ref RECORD;
  v_completed_count INTEGER;
  v_flag_enabled BOOLEAN := false;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
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

  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = NEW.customer_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO v_completed_count
  FROM rides
  WHERE customer_id = NEW.customer_id
    AND status = 'completed';

  IF v_completed_count != 1 THEN
    RETURN NEW;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- 00394: defensive money block — a referral-reward failure must NEVER roll
  -- back the ride completion that fired this trigger.
  BEGIN
    -- 00394: credit the referrer's spendable TriciCoin (driver->tricicoin,
    -- passenger->customer_cash) instead of a hardcoded 'customer_cash'.
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
        'referral_bonus:' || v_ref.id::TEXT,
        'promo_credit', 'posted',
        'referral', v_ref.id,
        'Bono de referido - codigo ' || v_ref.code,
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
        rewarded_at = NOW(),
        transaction_id = v_txn_id
    WHERE id = v_ref.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'referral reward (on_complete) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Referred driver approved -> reward the referrer.
--    Role-based wallet + defensive (non-blocking) money block.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_referral_reward_on_driver_approved()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_driver_user_id UUID;
  v_ref RECORD;
  v_flag_enabled BOOLEAN := false;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  IF NEW.status != 'approved' OR OLD.status = 'approved' THEN
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

  v_driver_user_id := NEW.user_id;

  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = v_driver_user_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- 00394: defensive money block — a referral-reward failure must NEVER roll
  -- back the driver approval that fired this trigger.
  BEGIN
    -- 00394: credit the referrer's spendable TriciCoin (driver->tricicoin,
    -- passenger->customer_cash) instead of a hardcoded 'customer_cash'.
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
        rewarded_at = NOW(),
        transaction_id = v_txn_id
    WHERE id = v_ref.id;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'referral reward (on_driver_approved) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Admin manual reward -> role-based wallet (KEEP raising on failure).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_reward_referral(p_referral_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ref RECORD;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
  v_caller_is_admin BOOLEAN;
BEGIN
  SELECT (role IN ('admin','super_admin'))
    INTO v_caller_is_admin
  FROM users WHERE id = auth.uid();
  IF NOT COALESCE(v_caller_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to reward referrals';
  END IF;

  SELECT * INTO v_ref
  FROM referrals WHERE id = p_referral_id AND status = 'pending'
  FOR UPDATE;

  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Referral not found or not pending: %', p_referral_id;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  -- 00394: credit the referrer's spendable TriciCoin (driver->tricicoin,
  -- passenger->customer_cash) instead of a hardcoded 'customer_cash'.
  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, _gift_wallet_type(v_ref.referrer_id));
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  SELECT balance INTO v_platform_balance
    FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;
  SELECT balance INTO v_referrer_balance
    FROM wallet_accounts WHERE id = v_referrer_account_id FOR UPDATE;

  BEGIN
    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status,
      reference_type, reference_id, description, created_by
    ) VALUES (
      gen_random_uuid(),
      'referral_bonus_admin:' || v_ref.id::TEXT,
      'promo_credit', 'posted',
      'referral', v_ref.id,
      'Bono de referido (admin) - codigo ' || v_ref.code,
      (SELECT auth.uid())
    )
    RETURNING id INTO v_txn_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'Referral % already rewarded (idempotency_key collision)', p_referral_id;
    RETURN;
  END;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

  UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
  UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

  UPDATE referrals
  SET status = 'rewarded', rewarded_at = NOW(), transaction_id = v_txn_id
  WHERE id = p_referral_id;
END;
$function$;
