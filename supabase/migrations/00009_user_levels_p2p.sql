-- ============================================================
-- Sprint 11: User Levels + P2P Wallet Transfers
-- ============================================================

-- User levels enum
DO $$ BEGIN
  CREATE TYPE user_level AS ENUM ('bronce', 'plata', 'oro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add level columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS level user_level NOT NULL DEFAULT 'bronce';
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_rides INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_spent INTEGER NOT NULL DEFAULT 0;

-- P2P wallet transfers table
CREATE TABLE IF NOT EXISTS wallet_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID NOT NULL REFERENCES users(id),
  to_user_id UUID NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  transaction_id UUID REFERENCES ledger_transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transfers_from ON wallet_transfers(from_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_to ON wallet_transfers(to_user_id);

-- RLS for wallet_transfers
ALTER TABLE wallet_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can see own transfers" ON wallet_transfers;
CREATE POLICY "Users can see own transfers" ON wallet_transfers
  FOR SELECT USING (
    auth.uid() = from_user_id OR auth.uid() = to_user_id
  );

DROP POLICY IF EXISTS "Users can insert own transfers" ON wallet_transfers;
CREATE POLICY "Users can insert own transfers" ON wallet_transfers
  FOR INSERT WITH CHECK (auth.uid() = from_user_id);

DROP POLICY IF EXISTS "Admins full access wallet_transfers" ON wallet_transfers;
CREATE POLICY "Admins full access wallet_transfers" ON wallet_transfers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- ============================================================
-- transfer_wallet_p2p: Atomic P2P wallet transfer
-- ============================================================
CREATE OR REPLACE FUNCTION transfer_wallet_p2p(
  p_from_user_id UUID,
  p_to_user_id UUID,
  p_amount INTEGER,
  p_note TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from_account_id UUID;
  v_to_account_id UUID;
  v_from_balance INTEGER;
  v_to_balance INTEGER;
  v_txn_id UUID;
  v_transfer_id UUID;
BEGIN
  -- Validate
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  IF p_from_user_id = p_to_user_id THEN
    RAISE EXCEPTION 'Cannot transfer to yourself';
  END IF;

  -- Ensure both accounts exist
  PERFORM ensure_wallet_account(p_from_user_id, 'customer_cash');
  PERFORM ensure_wallet_account(p_to_user_id, 'customer_cash');

  -- Get sender account (lock row)
  SELECT id, balance INTO v_from_account_id, v_from_balance
  FROM wallet_accounts
  WHERE user_id = p_from_user_id AND account_type = 'customer_cash'
  FOR UPDATE;

  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;

  -- Get receiver account (lock row)
  SELECT id, balance INTO v_to_account_id, v_to_balance
  FROM wallet_accounts
  WHERE user_id = p_to_user_id AND account_type = 'customer_cash'
  FOR UPDATE;

  -- Create ledger transaction
  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type,
    description, created_by
  ) VALUES (
    'p2p:' || gen_random_uuid(),
    'transfer_out',
    'posted',
    'wallet_transfer',
    COALESCE(p_note, 'Transferencia P2P'),
    p_from_user_id
  )
  RETURNING id INTO v_txn_id;

  -- Debit sender
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);

  UPDATE wallet_accounts
  SET balance = v_from_balance - p_amount, updated_at = NOW()
  WHERE id = v_from_account_id;

  -- Credit receiver
  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
  VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);

  UPDATE wallet_accounts
  SET balance = v_to_balance + p_amount, updated_at = NOW()
  WHERE id = v_to_account_id;

  -- Record transfer
  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id)
  VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id)
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$;

-- ============================================================
-- maybe_promote_user_level: Check and promote user level
-- Called after ride completion
-- ============================================================
CREATE OR REPLACE FUNCTION maybe_promote_user_level(p_user_id UUID)
RETURNS user_level
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rides INTEGER;
  v_spent INTEGER;
  v_current_level user_level;
  v_new_level user_level;
BEGIN
  SELECT total_rides, total_spent, level
  INTO v_rides, v_spent, v_current_level
  FROM users
  WHERE id = p_user_id;

  -- Determine new level based on thresholds
  -- Oro: 100+ rides AND 200000+ centavos spent (2000 CUP)
  -- Plata: 20+ rides AND 50000+ centavos spent (500 CUP)
  -- Bronce: default
  IF v_rides >= 100 AND v_spent >= 200000 THEN
    v_new_level := 'oro';
  ELSIF v_rides >= 20 AND v_spent >= 50000 THEN
    v_new_level := 'plata';
  ELSE
    v_new_level := 'bronce';
  END IF;

  -- Only promote, never demote
  IF v_new_level > v_current_level THEN
    UPDATE users SET level = v_new_level WHERE id = p_user_id;
    RETURN v_new_level;
  END IF;

  RETURN v_current_level;
END;
$$;

-- ============================================================
-- find_user_by_phone: Helper for P2P transfer recipient lookup
-- ============================================================
CREATE OR REPLACE FUNCTION find_user_by_phone(p_phone TEXT)
RETURNS TABLE(id UUID, full_name TEXT, phone TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.full_name, u.phone
  FROM users u
  WHERE u.phone = p_phone AND u.is_active = true
  LIMIT 1;
END;
$$;
