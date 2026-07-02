-- 00477: optional WELCOME bonus for the referred user (referee).
--
-- Until now the referral bonus (referral_bonus_cup, default 500) paid ONLY
-- the referrer. For the driver-acquisition campaign the user decided
-- (2026-07-02) to add a second, admin-configurable bonus for the REFEREE:
--
--   platform_config.referral_welcome_bonus_cup  (default 0 = OFF)
--
-- When > 0, the same event that pays the referrer (referee's first completed
-- ride, or driver approval) also credits the referee's spendable wallet
-- (driver -> tricicoin, passenger -> customer_cash via _gift_wallet_type),
-- debited from platform_promotions. Idempotency key
-- 'referral_welcome:<referral_id>' is SHARED by the trigger and admin paths
-- so the welcome bonus can never double-pay.
--
-- The three function bodies below are reproduced VERBATIM from live prod
-- (captured 2026-07-02 via pg_get_functiondef — canonical "last wins"
-- pattern); the only changes are the new DECLARE vars and the blocks marked
-- with "-- 00477".

-- 1. Seed the config key (idempotent). JSON number like the other numeric
--    platform_config keys. 0 keeps the feature OFF until an admin enables it.
INSERT INTO platform_config (key, value)
SELECT 'referral_welcome_bonus_cup', '0'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE key = 'referral_welcome_bonus_cup');

-- 2. Passenger path: referee's FIRST completed ride.
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
  -- 00477: welcome bonus for the referee
  v_welcome_trc INTEGER;
  v_referee_account_id UUID;
  v_referee_balance INTEGER;
  v_welcome_txn_id UUID;
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
  v_bonus_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_bonus_cup', 500), 0)::integer, v_exchange_rate);

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

    -- 00477: optional welcome bonus for the REFEREE. Config-derived (mint-guard
    -- pattern, 00428), own idempotency key shared with the admin path. The
    -- platform row is already locked above; re-read its balance because the
    -- referrer leg just debited it.
    v_welcome_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_welcome_bonus_cup', 0), 0)::integer, v_exchange_rate);
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
    RAISE WARNING 'referral reward (on_complete) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

-- 3. Driver path: referee approved as driver.
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
  -- 00477: welcome bonus for the referee
  v_welcome_trc INTEGER;
  v_referee_account_id UUID;
  v_referee_balance INTEGER;
  v_welcome_txn_id UUID;
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
  v_bonus_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_bonus_cup', 500), 0)::integer, v_exchange_rate);

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

    -- 00477: optional welcome bonus for the REFEREE (the newly approved
    -- driver). Config-derived, idempotency key shared with the admin path.
    v_welcome_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_welcome_bonus_cup', 0), 0)::integer, v_exchange_rate);
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
    RAISE WARNING 'referral reward (on_driver_approved) failed for referral %: % %', v_ref.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  RETURN NEW;
END;
$function$;

-- 4. Admin manual path: same welcome leg, same shared idempotency key.
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
  -- 00477: welcome bonus for the referee
  v_welcome_trc INTEGER;
  v_referee_account_id UUID;
  v_referee_balance INTEGER;
  v_welcome_txn_id UUID;
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
  v_bonus_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_bonus_cup', 500), 0)::integer, v_exchange_rate);

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

  -- 00477: optional welcome bonus for the REFEREE. Same shared idempotency
  -- key as the trigger paths, so a referral rewarded by trigger then retried
  -- by an admin can never pay the welcome bonus twice.
  v_welcome_trc := cup_to_trc_centavos(GREATEST(get_platform_config_numeric('referral_welcome_bonus_cup', 0), 0)::integer, v_exchange_rate);
  IF v_welcome_trc > 0 THEN
    v_referee_account_id := ensure_wallet_account(v_ref.referee_id, _gift_wallet_type(v_ref.referee_id));
    SELECT balance INTO v_referee_balance
      FROM wallet_accounts WHERE id = v_referee_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance
      FROM wallet_accounts WHERE id = v_platform_account_id;

    BEGIN
      INSERT INTO ledger_transactions (
        id, idempotency_key, type, status,
        reference_type, reference_id, description, created_by
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
      RAISE NOTICE 'Welcome bonus for referral % already paid (idempotency)', p_referral_id;
    END;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.trg_referral_reward_on_complete() IS
  '00477: pays referrer (referral_bonus_cup) + optional referee welcome bonus (referral_welcome_bonus_cup, 0=off) on the referee''s first completed ride.';
COMMENT ON FUNCTION public.trg_referral_reward_on_driver_approved() IS
  '00477: pays referrer (referral_bonus_cup) + optional referee welcome bonus (referral_welcome_bonus_cup, 0=off) when the referred driver is approved.';
COMMENT ON FUNCTION public.admin_reward_referral(uuid) IS
  '00477: manual admin reward — same two legs and same idempotency keys as the trigger paths.';
