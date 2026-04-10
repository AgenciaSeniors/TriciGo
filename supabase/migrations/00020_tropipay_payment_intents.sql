-- ============================================================
-- Migration 00020: TropiPay Payment Intents
-- Tracks payment links created via TropiPay for wallet recharges.
-- Automates the manual recharge approval flow with webhook callbacks.
-- ============================================================

-- 1. Payment intents table
CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  -- TropiPay-specific fields
  tropipay_id TEXT,                    -- TropiPay's internal payment card ID
  payment_url TEXT,                    -- The full payment URL
  short_url TEXT,                      -- Short URL for sharing

  -- Financial fields
  amount_cup INTEGER NOT NULL,         -- Amount in whole CUP units
  amount_usd NUMERIC(10,2),           -- Equivalent USD amount (computed at creation)
  exchange_rate NUMERIC(10,2),         -- USD/CUP rate used at creation

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'completed', 'failed', 'expired', 'refunded')),

  -- Linkage to existing ledger
  recharge_request_id UUID,            -- Optional link to wallet_recharge_requests
  transaction_id UUID,                 -- FK set when payment completes

  -- Metadata
  tropipay_reference TEXT UNIQUE,      -- Our idempotency reference sent to TropiPay
  tropipay_response JSONB,             -- Raw response from TropiPay API
  webhook_payload JSONB,               -- Raw webhook notification payload
  error_message TEXT,

  -- Timestamps
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON payment_intents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON payment_intents(status) WHERE status IN ('created', 'pending');
CREATE INDEX IF NOT EXISTS idx_payment_intents_reference ON payment_intents(tropipay_reference);

-- 2. RLS policies
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pi_own_select" ON payment_intents;
CREATE POLICY "pi_own_select" ON payment_intents FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

DROP POLICY IF EXISTS "pi_own_insert" ON payment_intents;
CREATE POLICY "pi_own_insert" ON payment_intents FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "pi_admin_all" ON payment_intents;
CREATE POLICY "pi_admin_all" ON payment_intents FOR ALL
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- 3. Platform config entries for TropiPay
INSERT INTO platform_config (key, value) VALUES
  ('tropipay_client_id', '""'),
  ('tropipay_client_secret', '""'),
  ('tropipay_server_mode', '"Development"'),
  ('tropipay_webhook_secret', '""'),
  ('tropipay_min_recharge_cup', '500'),
  ('tropipay_max_recharge_cup', '50000')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- process_tropipay_payment: Atomically credit a user's wallet
-- when a TropiPay payment is confirmed.
--
-- Follows the same pattern as transfer_wallet_p2p (migration 00009):
-- - SECURITY DEFINER for edge function access
-- - Creates ledger_transaction + ledger_entry
-- - Updates wallet_accounts.balance
-- - Idempotent: re-calling with a completed intent returns existing txn_id
-- ============================================================
CREATE OR REPLACE FUNCTION process_tropipay_payment(
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
  v_current_balance INTEGER;
  v_txn_id UUID;
BEGIN
  -- Lock the payment intent row
  SELECT * INTO v_intent
  FROM payment_intents
  WHERE id = p_payment_intent_id
  FOR UPDATE;

  IF v_intent IS NULL THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  -- Idempotent: if already completed, return existing transaction
  IF v_intent.status = 'completed' THEN
    RETURN v_intent.transaction_id;
  END IF;

  IF v_intent.status NOT IN ('created', 'pending') THEN
    RAISE EXCEPTION 'Payment intent % has invalid status for completion: %',
      p_payment_intent_id, v_intent.status;
  END IF;

  -- Ensure wallet account exists
  v_account_id := ensure_wallet_account(v_intent.user_id, 'customer_cash');

  -- Lock wallet row and get current balance
  SELECT balance INTO v_current_balance
  FROM wallet_accounts
  WHERE id = v_account_id
  FOR UPDATE;

  -- Create ledger transaction
  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, reference_id,
    description, created_by
  ) VALUES (
    'tropipay:' || p_payment_intent_id,
    'recharge',
    'posted',
    'payment_intent',
    p_payment_intent_id,
    'Recarga TropiPay #' || LEFT(p_payment_intent_id::TEXT, 8),
    v_intent.user_id
  )
  RETURNING id INTO v_txn_id;

  -- Credit user's wallet
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_account_id, v_intent.amount_cup, v_current_balance + v_intent.amount_cup);

  -- Update wallet balance
  UPDATE wallet_accounts
  SET balance = v_current_balance + v_intent.amount_cup, updated_at = NOW()
  WHERE id = v_account_id;

  -- Update payment intent status
  UPDATE payment_intents
  SET status = 'completed',
      paid_at = NOW(),
      transaction_id = v_txn_id,
      webhook_payload = COALESCE(p_webhook_payload, webhook_payload),
      updated_at = NOW()
  WHERE id = p_payment_intent_id;

  RETURN v_txn_id;
END;
$$;
