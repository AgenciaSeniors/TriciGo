-- ============================================================
-- Migration 00110: Stripe Integration
-- Adds 'stripe' to payment_method enum, Stripe columns to
-- payment_intents, platform config, and wallet recharge RPCs.
-- ============================================================

-- 1. Add 'stripe' to the payment_method enum
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'stripe' BEFORE 'tropipay';

-- 2. Add Stripe columns to payment_intents
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_provider TEXT DEFAULT 'stripe',
  ADD COLUMN IF NOT EXISTS fee_usd NUMERIC(10,2) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_payment_intents_stripe_pi_id
  ON payment_intents(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- 3. Insert Stripe config into platform_config
INSERT INTO platform_config (key, value)
VALUES
  ('stripe_enabled', '"true"'),
  ('stripe_publishable_key', '"pk_test_REPLACE_WITH_YOUR_KEY"'),
  ('stripe_secret_key', '"sk_test_REPLACE_WITH_YOUR_KEY"'),
  ('stripe_webhook_secret', '"whsec_REPLACE_WITH_YOUR_KEY"'),
  ('stripe_min_recharge_cup', '500'),
  ('stripe_max_recharge_cup', '50000'),
  ('stripe_fee_usd', '2.00'),
  ('stripe_fee_type', '"fixed"'),
  ('cash_enabled', '"true"'),
  ('wallet_enabled', '"true"')
ON CONFLICT (key) DO NOTHING;

-- 4. process_stripe_recharge — credits customer wallet after Stripe confirms
CREATE OR REPLACE FUNCTION process_stripe_recharge(
  p_payment_intent_id UUID,
  p_webhook_payload JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_account_id UUID;
  v_txn_id UUID;
  v_idempotency_key TEXT;
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id; END IF;
  IF v_intent.status = 'completed' THEN RETURN v_intent.transaction_id; END IF;
  IF v_intent.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Payment intent status is %, expected pending/processing', v_intent.status;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
  WHERE user_id = v_intent.user_id AND account_type = 'customer_cash';
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_intent.user_id, 'customer_cash', 0, 0, 'TRC', true) RETURNING id INTO v_account_id;
  END IF;

  v_idempotency_key := 'stripe_recharge_' || p_payment_intent_id::TEXT;
  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = p_payment_intent_id;
    RETURN v_txn_id;
  END IF;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by)
  VALUES (v_idempotency_key, 'recharge', 'posted', 'payment_intent', p_payment_intent_id::TEXT,
    'Stripe wallet recharge: ' || v_intent.amount_cup || ' CUP (~$' || COALESCE(v_intent.amount_usd::TEXT, '?') || ' USD)',
    jsonb_build_object('payment_provider', 'stripe', 'stripe_pi_id', v_intent.stripe_payment_intent_id, 'amount_usd', v_intent.amount_usd, 'exchange_rate', v_intent.exchange_rate, 'fee_usd', v_intent.fee_usd),
    v_intent.user_id) RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_intent.amount_cup,
    (SELECT balance FROM wallet_accounts WHERE id = v_account_id) + v_intent.amount_cup);

  UPDATE wallet_accounts SET balance = balance + v_intent.amount_cup, updated_at = NOW() WHERE id = v_account_id;
  UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload), paid_at = NOW(), updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$$;

-- 5. process_stripe_driver_quota_recharge — credits driver quota after Stripe confirms
CREATE OR REPLACE FUNCTION process_stripe_driver_quota_recharge(
  p_payment_intent_id UUID,
  p_webhook_payload JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_account_id UUID;
  v_txn_id UUID;
  v_idempotency_key TEXT;
BEGIN
  SELECT * INTO v_intent FROM payment_intents WHERE id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id; END IF;
  IF v_intent.status = 'completed' THEN RETURN v_intent.transaction_id; END IF;
  IF v_intent.status NOT IN ('pending', 'processing') THEN
    RAISE EXCEPTION 'Payment intent status is %, expected pending/processing', v_intent.status;
  END IF;

  SELECT id INTO v_account_id FROM wallet_accounts
  WHERE user_id = v_intent.user_id AND account_type = 'driver_quota';
  IF v_account_id IS NULL THEN
    INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, currency, is_active)
    VALUES (v_intent.user_id, 'driver_quota', 0, 0, 'TRC', true) RETURNING id INTO v_account_id;
  END IF;

  v_idempotency_key := 'stripe_quota_' || p_payment_intent_id::TEXT;
  SELECT id INTO v_txn_id FROM ledger_transactions WHERE idempotency_key = v_idempotency_key;
  IF v_txn_id IS NOT NULL THEN
    UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = p_payment_intent_id;
    RETURN v_txn_id;
  END IF;

  INSERT INTO ledger_transactions (idempotency_key, type, status, reference_type, reference_id, description, metadata, created_by)
  VALUES (v_idempotency_key, 'quota_recharge', 'posted', 'payment_intent', p_payment_intent_id::TEXT,
    'Stripe driver quota recharge: ' || v_intent.amount_cup || ' CUP',
    jsonb_build_object('payment_provider', 'stripe', 'stripe_pi_id', v_intent.stripe_payment_intent_id, 'amount_usd', v_intent.amount_usd),
    v_intent.user_id) RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_intent.amount_cup,
    (SELECT balance FROM wallet_accounts WHERE id = v_account_id) + v_intent.amount_cup);

  UPDATE wallet_accounts SET balance = balance + v_intent.amount_cup, updated_at = NOW() WHERE id = v_account_id;
  UPDATE payment_intents SET status = 'completed', transaction_id = v_txn_id,
    webhook_payload = COALESCE(p_webhook_payload, webhook_payload), paid_at = NOW(), updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$$;

-- 6. Trigger: stripe rides get payment_status='pending' on completion
CREATE OR REPLACE FUNCTION set_ride_payment_status_for_stripe()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.payment_method = 'stripe'
     AND (NEW.payment_status IS NULL OR NEW.payment_status = 'not_applicable') THEN
    NEW.payment_status := 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ride_stripe_payment_status ON rides;
CREATE TRIGGER trg_ride_stripe_payment_status
  BEFORE UPDATE ON rides FOR EACH ROW
  WHEN (NEW.status = 'completed' AND NEW.payment_method::TEXT = 'stripe')
  EXECUTE FUNCTION set_ride_payment_status_for_stripe();

-- 7. Permissions
GRANT EXECUTE ON FUNCTION process_stripe_recharge(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION process_stripe_driver_quota_recharge(UUID, JSONB) TO service_role;
