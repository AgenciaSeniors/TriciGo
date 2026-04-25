-- ============================================================
-- BUG-130: process_dispute_refund had NO admin authorization check.
-- The function is SECURITY DEFINER, granted EXECUTE to authenticated
-- (and even anon), so any logged-in user could call it directly:
--
--   supabase.rpc('process_dispute_refund', {
--     p_dispute_id: anyOpenDisputeIdYouOpenedYourself,
--     p_admin_id: '00000000-0000-0000-0000-000000000001',
--     p_refund_amount_trc: anyAmountUpToFinalFareTrc,
--     p_resolution: 'full_refund',
--     p_resolution_notes: 'whatever',
--   });
--
-- Effect:
--   1. Customer opens a dispute on their own completed ride
--      (allowed by dispute_insert policy).
--   2. Customer calls process_dispute_refund directly — no admin
--      check anywhere in the function body, p_admin_id is only
--      used as the ledger created_by for audit, not validated.
--   3. The RPC credits up to final_fare_trc to the customer's
--      customer_cash wallet, debiting platform_revenue.
--
-- Verified: under SET LOCAL "request.jwt.claims" of a regular
-- customer's UUID, called the RPC and observed customer_cash
-- balance go from 0 → 100 and platform_revenue from 13172 →
-- 13072. Wallet invariant matched but funds were drained from
-- the platform without admin review. Cleanup applied via reversal
-- ledger transaction.
--
-- Fix: add an explicit is_admin() gate at the top of the function
-- that consults auth.uid() (NOT the trusted p_admin_id parameter,
-- which a caller controls). Also mirror admin_refund_ride_commission's
-- pattern of checking the caller's role in users.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_dispute_refund(
  p_dispute_id uuid,
  p_admin_id uuid,
  p_refund_amount_trc integer,
  p_resolution text,
  p_resolution_notes text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
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
  v_new_status TEXT;
  v_caller_is_admin BOOLEAN;
BEGIN
  -- BUG-130 fix: caller must be platform admin/super_admin. We trust
  -- auth.uid() (set by Supabase from the JWT), NOT the p_admin_id
  -- argument which a malicious caller controls. p_admin_id stays as
  -- the ledger created_by for traceability when admin tools intend
  -- to attribute the action to a specific admin.
  SELECT (role IN ('admin','super_admin'))
    INTO v_caller_is_admin
  FROM users WHERE id = auth.uid();

  IF NOT COALESCE(v_caller_is_admin, false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to process dispute refunds';
  END IF;

  SELECT * INTO v_dispute FROM ride_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute IS NULL THEN
    RAISE EXCEPTION 'Dispute not found: %', p_dispute_id;
  END IF;

  IF v_dispute.status IN ('resolved_rider', 'resolved_driver', 'closed') THEN
    RAISE EXCEPTION 'Dispute % is already resolved (status: %)', p_dispute_id, v_dispute.status;
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = v_dispute.ride_id FOR UPDATE;
  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found for dispute: %', v_dispute.ride_id;
  END IF;

  IF p_refund_amount_trc < 0 THEN
    RAISE EXCEPTION 'Refund amount cannot be negative';
  END IF;

  IF p_refund_amount_trc > COALESCE(v_ride.final_fare_trc, 0) THEN
    RAISE EXCEPTION 'Refund (%) exceeds ride fare (%)',
      p_refund_amount_trc, COALESCE(v_ride.final_fare_trc, 0);
  END IF;

  IF p_refund_amount_trc > 0 THEN
    v_customer_account_id := ensure_wallet_account(v_ride.customer_id, 'customer_cash');
    v_platform_account_id := ensure_wallet_account(v_platform_user_id, 'platform_revenue');

    SELECT balance INTO v_customer_balance FROM wallet_accounts WHERE id = v_customer_account_id FOR UPDATE;
    SELECT balance INTO v_platform_balance FROM wallet_accounts WHERE id = v_platform_account_id FOR UPDATE;

    INSERT INTO ledger_transactions (id, idempotency_key, type, status, reference_type, reference_id, description, created_by)
    VALUES (gen_random_uuid(), 'dispute_refund:' || p_dispute_id::TEXT,
            'adjustment', 'posted', 'ride', v_ride.id,
            'Reembolso disputa viaje #' || LEFT(v_ride.id::TEXT, 8), p_admin_id)
    RETURNING id INTO v_txn_id;

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_customer_account_id, p_refund_amount_trc, v_customer_balance + p_refund_amount_trc);

    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (v_txn_id, v_platform_account_id, -p_refund_amount_trc, v_platform_balance - p_refund_amount_trc);

    UPDATE wallet_accounts SET balance = balance + p_refund_amount_trc WHERE id = v_customer_account_id;
    UPDATE wallet_accounts SET balance = balance - p_refund_amount_trc WHERE id = v_platform_account_id;
  END IF;

  v_new_status := CASE p_resolution
    WHEN 'full_refund'    THEN 'resolved_rider'
    WHEN 'partial_refund' THEN 'resolved_rider'
    WHEN 'credit'         THEN 'resolved_rider'
    WHEN 'no_action'      THEN 'resolved_driver'
    WHEN 'warning_issued' THEN 'resolved_driver'
    ELSE 'closed'
  END;

  UPDATE ride_disputes SET
    status = v_new_status,
    resolution = p_resolution,
    resolution_notes = p_resolution_notes,
    refund_amount_trc = p_refund_amount_trc,
    refund_transaction_id = v_txn_id,
    resolved_at = NOW(),
    updated_at = NOW()
  WHERE id = p_dispute_id;

  IF v_ride.status = 'disputed' THEN
    UPDATE rides SET status = 'completed', updated_at = NOW() WHERE id = v_ride.id;
  END IF;

  RETURN COALESCE(v_txn_id, '00000000-0000-0000-0000-000000000000'::UUID);
END;
$$;

COMMENT ON FUNCTION public.process_dispute_refund(uuid, uuid, integer, text, text) IS
  'BUG-130: now requires the caller (auth.uid()) to be admin/super_admin. The p_admin_id parameter remains for ledger audit attribution but is no longer trusted for authorization.';
