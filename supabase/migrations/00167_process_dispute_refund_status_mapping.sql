-- ============================================================
-- BUG-108: process_dispute_refund wrote `status = 'resolved'` but the
-- chk_dispute_status_valid CHECK constraint only allows:
--   {open, under_review, resolved_rider, resolved_driver, escalated, closed}
-- Every single UPDATE from this RPC would raise:
--   "check constraint chk_dispute_status_valid violated"
-- so NO dispute has ever actually been resolvable in production.
--
-- Fix: map the `p_resolution` parameter (full_refund | partial_refund |
-- credit | no_action | warning_issued) to the canonical status:
--   - rider-favorable outcomes (full_refund / partial_refund / credit)
--     → 'resolved_rider'
--   - driver-favorable outcomes (no_action / warning_issued)
--     → 'resolved_driver'
-- Also fix the early guard: check `resolved_rider`, `resolved_driver`,
-- `closed` (the enum values) instead of the legacy 'resolved' / 'denied'.
--
-- Note: this migration does NOT touch cash/mixed/corporate payment
-- refund routing. Current RPC always credits customer_cash wallet,
-- which is an acceptable design (refund as TriciCoin credit). Tracked
-- as BUG-109/110 for future product review, not fixed here.
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
AS $function$
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
BEGIN
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
$function$;
