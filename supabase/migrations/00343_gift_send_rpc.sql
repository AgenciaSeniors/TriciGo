-- ============================================================
-- Migration 00343: "Regalo" — internal closed-loop P2P gift (send)
--
-- Reintroduces user-to-user value transfer (removed in 00274),
-- reframed as a "Regalo" (gift) and kept closed-loop:
--   - recipient must be an active TriciGo user
--   - gifted balance is spend-only (rides), never withdrawable to fiat
--   - admin can reverse a gift (00345) and freeze wallets (00013)
--
-- Mechanics mirror the removed transfer_wallet_p2p (00211) with one
-- change: the account_type is resolved per the user's ROLE instead of
-- a fixed customer_cash — driver -> tricicoin, everyone else ->
-- customer_cash (the wallet each role sees in its app). Cross-type
-- gifts are value-preserving (both denominated 1:1 in CUP/TC).
--
-- Adds:
--   1. _gift_wallet_type(user) helper.
--   2. wallet_transfers: kind + reversal-tracking columns; from_user_id
--      made nullable (admin/platform-originated gifts in 00345).
--   3. send_gift(...) RPC — atomic double-entry gift, caller-gated.
--
-- Per product decision: ONLY basic validations (positive amount, not
-- self, active + non-frozen recipient/sender, sufficient balance). No
-- amount/daily caps. The 00013 fraud trigger on wallet_transfers stays
-- as passive observability (it logs fraud_alerts, never blocks).
-- ============================================================

-- 1) Helper: the spendable wallet for a user's role.
CREATE OR REPLACE FUNCTION public._gift_wallet_type(p_user_id uuid)
RETURNS wallet_account_type
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN u.role = 'driver' THEN 'tricicoin'::wallet_account_type
              ELSE 'customer_cash'::wallet_account_type END
  FROM users u WHERE u.id = p_user_id;
$$;

-- 2) wallet_transfers: gift metadata + reversal tracking.
--    from_user_id becomes nullable so admin/platform gifts (00345) can
--    record a sender-less origin.
ALTER TABLE wallet_transfers ALTER COLUMN from_user_id DROP NOT NULL;
ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'gift';
ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES users(id);
ALTER TABLE wallet_transfers ADD COLUMN IF NOT EXISTS reversal_of UUID REFERENCES wallet_transfers(id);

-- Historical rows (pre-00274 P2P transfers) are transfers, not gifts.
UPDATE wallet_transfers SET kind = 'transfer' WHERE reversal_of IS NULL AND created_at < NOW();

-- 3) RPC: send_gift — atomic double-entry user-to-user gift.
CREATE OR REPLACE FUNCTION public.send_gift(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount integer,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_from_type wallet_account_type;
  v_to_type   wallet_account_type;
  v_from_account_id UUID;
  v_to_account_id   UUID;
  v_from_balance INTEGER;
  v_to_balance   INTEGER;
  v_from_frozen  BOOLEAN;
  v_to_active    BOOLEAN;
  v_txn_id UUID;
  v_transfer_id UUID;
BEGIN
  -- Caller gate: you can only gift from your own wallet. Admins may act
  -- on behalf of a user (rare; e.g. support flows).
  IF NOT is_admin() AND auth.uid() <> p_from_user_id THEN
    RAISE EXCEPTION 'Forbidden: can only gift from your own wallet';
  END IF;

  -- Basic validations (no amount/daily caps by product decision).
  IF p_amount <= 0 THEN RAISE EXCEPTION 'Gift amount must be positive'; END IF;
  IF p_from_user_id = p_to_user_id THEN RAISE EXCEPTION 'Cannot gift to yourself'; END IF;

  SELECT is_active INTO v_to_active FROM users WHERE id = p_to_user_id;
  IF NOT COALESCE(v_to_active, false) THEN
    RAISE EXCEPTION 'Recipient not found or inactive';
  END IF;

  v_from_type := _gift_wallet_type(p_from_user_id);
  v_to_type   := _gift_wallet_type(p_to_user_id);

  PERFORM ensure_wallet_account(p_from_user_id, v_from_type);
  PERFORM ensure_wallet_account(p_to_user_id, v_to_type);

  SELECT id, balance, is_frozen INTO v_from_account_id, v_from_balance, v_from_frozen
    FROM wallet_accounts
    WHERE user_id = p_from_user_id AND account_type = v_from_type FOR UPDATE;
  IF COALESCE(v_from_frozen, false) THEN
    RAISE EXCEPTION 'Your wallet is frozen';
  END IF;
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_from_balance, p_amount;
  END IF;

  SELECT id, balance INTO v_to_account_id, v_to_balance FROM wallet_accounts
    WHERE user_id = p_to_user_id AND account_type = v_to_type FOR UPDATE;

  INSERT INTO ledger_transactions (
    idempotency_key, type, status, reference_type, description, metadata, created_by
  )
  VALUES (
    'gift:' || gen_random_uuid()::TEXT, 'transfer_out', 'posted', 'wallet_transfer',
    COALESCE(p_note, 'Regalo'), jsonb_build_object('kind', 'gift'), p_from_user_id
  )
  RETURNING id INTO v_txn_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_from_account_id, -p_amount, v_from_balance - p_amount);
  UPDATE wallet_accounts SET balance = v_from_balance - p_amount, updated_at = NOW()
    WHERE id = v_from_account_id;

  INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_to_account_id, p_amount, v_to_balance + p_amount);
  UPDATE wallet_accounts SET balance = v_to_balance + p_amount, updated_at = NOW()
    WHERE id = v_to_account_id;

  INSERT INTO wallet_transfers (from_user_id, to_user_id, amount, note, transaction_id, kind)
    VALUES (p_from_user_id, p_to_user_id, p_amount, p_note, v_txn_id, 'gift')
  RETURNING id INTO v_transfer_id;

  RETURN v_transfer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.send_gift(uuid, uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_gift(uuid, uuid, integer, text) TO authenticated;

COMMENT ON FUNCTION public._gift_wallet_type(uuid) IS
  '00343: resolves the spendable wallet for a user role (driver=tricicoin, else customer_cash).';
COMMENT ON FUNCTION public.send_gift(uuid, uuid, integer, text) IS
  '00343: closed-loop "Regalo". Atomic double-entry user-to-user gift; role-based wallet. Caller-gated. Reintroduces value transfer removed in 00274, kept closed-loop (spend-only, active recipient, admin-reversible, frozen-aware).';
