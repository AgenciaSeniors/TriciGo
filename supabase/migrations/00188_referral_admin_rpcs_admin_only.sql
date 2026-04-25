-- ============================================================
-- BUG-131: admin_reward_referral and admin_invalidate_referral are
-- SECURITY DEFINER, granted EXECUTE to authenticated, with NO
-- admin authorization check. Same shape as BUG-130 on
-- process_dispute_refund.
--
-- admin_reward_referral exploit: a malicious user as the referrer
-- on a pending referral can directly call this RPC to credit the
-- referral bonus to their own customer_cash wallet, debiting
-- platform_promotions, without any admin approval. The function
-- only checks "status = 'pending'" — but the trigger
-- trg_referral_reward_on_complete already creates pending rows
-- when the referee finishes their first ride. So an attacker
-- gaming the referral flow could harvest bonuses that admin would
-- otherwise vet for fraud.
--
-- admin_invalidate_referral exploit: any authenticated user can
-- invalidate any pending referral by id, denying-of-service the
-- referral payout for legitimate referrers.
--
-- Fix: add is_admin() gate at the top of both functions, mirroring
-- the BUG-130 fix on process_dispute_refund.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_reward_referral(p_referral_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
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
  v_caller_is_admin BOOLEAN;
BEGIN
  -- BUG-131: caller must be admin/super_admin
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

COMMENT ON FUNCTION public.admin_reward_referral(uuid) IS
  'BUG-131: now requires the caller (auth.uid()) to be admin/super_admin.';


CREATE OR REPLACE FUNCTION public.admin_invalidate_referral(p_referral_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_caller_is_admin BOOLEAN;
BEGIN
  -- BUG-131: caller must be admin/super_admin
  SELECT (role IN ('admin','super_admin'))
    INTO v_caller_is_admin
  FROM users WHERE id = auth.uid();
  IF NOT COALESCE(v_caller_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to invalidate referrals';
  END IF;

  UPDATE referrals
  SET status = 'invalidated'
  WHERE id = p_referral_id AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral not found or not pending: %', p_referral_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_invalidate_referral(uuid) IS
  'BUG-131: now requires the caller (auth.uid()) to be admin/super_admin.';
