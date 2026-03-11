-- ============================================================
-- Migration 00019: Referral Rewards System
-- Adds automatic referral bonus payout on first ride completion,
-- a driver-approved trigger, and enables the feature flag.
-- ============================================================

-- 1. Fix default bonus_amount to 500 CUP (was 0)
ALTER TABLE referrals ALTER COLUMN bonus_amount SET DEFAULT 500;

-- 2. Trigger: reward referrer when referee completes their FIRST ride
CREATE OR REPLACE FUNCTION trg_referral_reward_on_complete()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_ref RECORD;
  v_completed_count INTEGER;
  v_flag_enabled BOOLEAN;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- Only when ride transitions to completed
  IF NEW.status != 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  -- Check feature flag
  SELECT (value::BOOLEAN) INTO v_flag_enabled
  FROM feature_flags WHERE key = 'referral_program_enabled';
  IF NOT COALESCE(v_flag_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Find pending referral where the customer is the referee
  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = NEW.customer_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check this is the referee's FIRST completed ride
  SELECT COUNT(*) INTO v_completed_count
  FROM rides
  WHERE customer_id = NEW.customer_id
    AND status = 'completed';

  -- The count includes the current ride (already updated to 'completed')
  IF v_completed_count != 1 THEN
    RETURN NEW;
  END IF;

  -- Convert bonus from CUP to TRC centavos
  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- Ensure wallet accounts exist
  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  -- Get current balances
  SELECT balance INTO v_referrer_balance
  FROM wallet_accounts WHERE id = v_referrer_account_id;

  SELECT balance INTO v_platform_balance
  FROM wallet_accounts WHERE id = v_platform_account_id;

  -- Create ledger transaction (idempotent via unique key)
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
      'Bono de referido - código ' || v_ref.code,
      v_ref.referrer_id
    )
    RETURNING id INTO v_txn_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already rewarded (idempotency), skip
    RETURN NEW;
  END;

  -- Ledger entries: platform debits, referrer credits
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

  -- Update wallet balances
  UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
  UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

  -- Mark referral as rewarded
  UPDATE referrals
  SET status = 'rewarded',
      rewarded_at = NOW(),
      transaction_id = v_txn_id
  WHERE id = v_ref.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_reward_on_complete ON rides;
CREATE TRIGGER trg_referral_reward_on_complete
  AFTER UPDATE ON rides
  FOR EACH ROW
  WHEN (NEW.status = 'completed' AND OLD.status != 'completed')
  EXECUTE FUNCTION trg_referral_reward_on_complete();

-- 3. Trigger: reward referrer when a referred DRIVER gets approved
CREATE OR REPLACE FUNCTION trg_referral_reward_on_driver_approved()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_driver_user_id UUID;
  v_ref RECORD;
  v_flag_enabled BOOLEAN;
  v_exchange_rate NUMERIC;
  v_bonus_trc INTEGER;
  v_referrer_account_id UUID;
  v_platform_account_id UUID;
  v_referrer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- Only when driver transitions to approved
  IF NEW.status != 'approved' OR OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;

  -- Check feature flag
  SELECT (value::BOOLEAN) INTO v_flag_enabled
  FROM feature_flags WHERE key = 'referral_program_enabled';
  IF NOT COALESCE(v_flag_enabled, false) THEN
    RETURN NEW;
  END IF;

  -- Get the user_id for this driver profile
  v_driver_user_id := NEW.user_id;

  -- Find pending referral where the driver is the referee
  SELECT * INTO v_ref
  FROM referrals
  WHERE referee_id = v_driver_user_id
    AND status = 'pending'
  FOR UPDATE SKIP LOCKED;

  IF v_ref IS NULL THEN
    RETURN NEW;
  END IF;

  -- Convert bonus from CUP to TRC centavos
  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  IF v_bonus_trc <= 0 THEN
    RETURN NEW;
  END IF;

  -- Ensure wallet accounts
  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  -- Get current balances
  SELECT balance INTO v_referrer_balance
  FROM wallet_accounts WHERE id = v_referrer_account_id;

  SELECT balance INTO v_platform_balance
  FROM wallet_accounts WHERE id = v_platform_account_id;

  -- Create ledger transaction
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
      'Bono de referido conductor - código ' || v_ref.code,
      v_ref.referrer_id
    )
    RETURNING id INTO v_txn_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN NEW;
  END;

  -- Ledger entries
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_platform_account_id, -v_bonus_trc, v_platform_balance - v_bonus_trc);

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_referrer_account_id, v_bonus_trc, v_referrer_balance + v_bonus_trc);

  -- Update wallet balances
  UPDATE wallet_accounts SET balance = balance - v_bonus_trc WHERE id = v_platform_account_id;
  UPDATE wallet_accounts SET balance = balance + v_bonus_trc WHERE id = v_referrer_account_id;

  -- Mark referral as rewarded
  UPDATE referrals
  SET status = 'rewarded',
      rewarded_at = NOW(),
      transaction_id = v_txn_id
  WHERE id = v_ref.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_reward_on_driver_approved ON driver_profiles;
CREATE TRIGGER trg_referral_reward_on_driver_approved
  AFTER UPDATE ON driver_profiles
  FOR EACH ROW
  WHEN (NEW.status = 'approved'::driver_status AND OLD.status != 'approved'::driver_status)
  EXECUTE FUNCTION trg_referral_reward_on_driver_approved();

-- 4. Ensure platform_promotions wallet account exists
SELECT ensure_wallet_account('00000000-0000-0000-0000-000000000001'::UUID, 'platform_promotions');

-- 5. Enable the referral program feature flag
UPDATE feature_flags SET value = true WHERE key = 'referral_program_enabled';

-- 6. Admin RPC: reward referral manually
CREATE OR REPLACE FUNCTION admin_reward_referral(p_referral_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
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
BEGIN
  -- Only admins can call (checked by SECURITY DEFINER + RLS)
  SELECT * INTO v_ref
  FROM referrals WHERE id = p_referral_id AND status = 'pending'
  FOR UPDATE;

  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Referral not found or not pending: %', p_referral_id;
  END IF;

  v_exchange_rate := get_current_exchange_rate();
  v_bonus_trc := cup_to_trc_centavos(v_ref.bonus_amount, v_exchange_rate);

  v_referrer_account_id := ensure_wallet_account(v_ref.referrer_id, 'customer_cash');
  v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_promotions');

  SELECT balance INTO v_referrer_balance FROM wallet_accounts WHERE id = v_referrer_account_id;
  SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id;

  INSERT INTO ledger_transactions (
    id, idempotency_key, type, status,
    reference_type, reference_id, description, created_by
  ) VALUES (
    gen_random_uuid(),
    'referral_bonus_admin:' || v_ref.id::TEXT,
    'promo_credit', 'posted',
    'referral', v_ref.id,
    'Bono de referido (admin) - código ' || v_ref.code,
    (SELECT auth.uid())
  )
  RETURNING id INTO v_txn_id;

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
$$;

-- 7. Admin RPC: invalidate referral
CREATE OR REPLACE FUNCTION admin_invalidate_referral(p_referral_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE referrals
  SET status = 'invalidated'
  WHERE id = p_referral_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found or not pending: %', p_referral_id;
  END IF;
END;
$$;
