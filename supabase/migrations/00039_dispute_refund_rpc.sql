-- ============================================================================
-- Migration 00039: Dispute Refund RPC + Feature Flag
-- ============================================================================
-- Atomic refund processing for dispute resolution.
-- Credits customer wallet, debits platform revenue through ledger.
-- ============================================================================

CREATE OR REPLACE FUNCTION process_dispute_refund(
  p_dispute_id UUID,
  p_admin_id UUID,
  p_refund_amount_trc INTEGER,
  p_resolution TEXT,
  p_resolution_notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_dispute RECORD;
  v_ride RECORD;
  v_customer_account_id UUID;
  v_platform_account_id UUID;
  v_customer_balance INTEGER;
  v_platform_balance INTEGER;
  v_txn_id UUID;
  v_platform_user_id UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
  -- 1. Lock and validate dispute
  SELECT * INTO v_dispute
  FROM ride_disputes
  WHERE id = p_dispute_id
  FOR UPDATE;

  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found: %', p_dispute_id;
  END IF;

  IF v_dispute.status IN ('resolved', 'denied', 'closed') THEN
    RAISE EXCEPTION 'Dispute % is already resolved (status: %)', p_dispute_id, v_dispute.status;
  END IF;

  -- 2. Lock and validate ride
  SELECT * INTO v_ride
  FROM rides
  WHERE id = v_dispute.ride_id
  FOR UPDATE;

  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found for dispute: %', v_dispute.ride_id;
  END IF;

  -- 3. Validate refund amount
  IF p_refund_amount_trc < 0 THEN
    RAISE EXCEPTION 'Refund amount cannot be negative';
  END IF;

  IF p_refund_amount_trc > COALESCE(v_ride.final_fare_trc, 0) THEN
    RAISE EXCEPTION 'Refund (%) exceeds ride fare (%)',
      p_refund_amount_trc, COALESCE(v_ride.final_fare_trc, 0);
  END IF;

  -- 4. Process refund through double-entry ledger (if amount > 0)
  IF p_refund_amount_trc > 0 THEN
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance
    FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;

    SELECT balance INTO v_platform_balance
    FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    INSERT INTO ledger_transactions (
      id, idempotency_key, type, status, reference_type, reference_id,
      description, created_by
    ) VALUES (
      gen_random_uuid(),
      'dispute_refund:' || p_dispute_id::TEXT,
      'adjustment', 'posted', 'ride', v_ride.id,
      'Reembolso disputa viaje #' || LEFT(v_ride.id::TEXT, 8),
      p_admin_id
    )
    RETURNING id INTO v_txn_id;

    -- Credit customer
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_customer_account_id, p_refund_amount_trc,
            v_customer_balance + p_refund_amount_trc);

    -- Debit platform revenue
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -p_refund_amount_trc,
            v_platform_balance - p_refund_amount_trc);

    UPDATE wallet_accounts
    SET balance = balance + p_refund_amount_trc
    WHERE id = v_customer_account_id;

    UPDATE wallet_accounts
    SET balance = balance - p_refund_amount_trc
    WHERE id = v_platform_account_id;
  END IF;

  -- 5. Resolve the dispute
  UPDATE ride_disputes SET
    status = 'resolved',
    resolution = p_resolution,
    resolution_notes = p_resolution_notes,
    refund_amount_trc = p_refund_amount_trc,
    refund_transaction_id = v_txn_id,
    resolved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_dispute_id;

  -- 6. Restore ride status if it was disputed
  IF v_ride.status = 'disputed' THEN
    UPDATE rides SET status = 'completed', updated_at = NOW()
    WHERE id = v_ride.id;
  END IF;

  RETURN COALESCE(v_txn_id, '00000000-0000-0000-0000-000000000000'::UUID);
END;
$$;

-- ============================================================
-- Feature flag
-- ============================================================
INSERT INTO feature_flags (key, value, description) VALUES
  ('formal_disputes_enabled', false, 'Habilitar sistema formal de disputas de viajes')
ON CONFLICT (key) DO NOTHING;
