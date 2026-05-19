-- ============================================================
-- Migration 00278: Payment compliance controls (Phase B4-B7)
--
-- Phase B compliance controls for the card-payment flow:
--   §1 (B5) — audit trail on payment_intents
--   §2 (B6) — device-metadata columns on payment_intents
--   §3 (B7) — build_chargeback_evidence RPC
-- (B4 — forcing 3-D Secure — is an edge-function change, no SQL.)
-- ============================================================

-- ─── 1. B5: AUDIT TRAIL ON payment_intents ────────────────────
-- payment_intents was not audited. Attach the existing record_audit()
-- trigger (00001) so every insert/update lands in audit_log, exactly
-- like rides / wallet_accounts / driver_profiles already do.
DROP TRIGGER IF EXISTS audit_payment_intents ON payment_intents;
CREATE TRIGGER audit_payment_intents
  AFTER INSERT OR UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION record_audit();

-- ─── 2. B6: DEVICE METADATA COLUMNS ───────────────────────────
-- Each recharge records the payer's IP, user-agent and a
-- client-computed device fingerprint, for fraud analysis and
-- chargeback evidence. Nullable: historical rows stay NULL, and the
-- create-stripe-payment-intent edge function fills them best-effort.
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS client_ip          text,
  ADD COLUMN IF NOT EXISTS user_agent         text,
  ADD COLUMN IF NOT EXISTS device_fingerprint text;

-- ─── 3. B7: CHARGEBACK EVIDENCE RPC ───────────────────────────
-- Assembles the "compelling evidence" bundle for a disputed card
-- recharge: the recharge record, the account, the wallet credit, and
-- the rides the resulting credits funded (proof the service was
-- delivered). Admin-gated; returns jsonb.
CREATE OR REPLACE FUNCTION build_chargeback_evidence(p_payment_intent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_pi          payment_intents%ROWTYPE;
  v_user        users%ROWTYPE;
  v_credited    integer;
  v_rides_count integer;
  v_rides_fare  bigint;
  v_first_ride  timestamptz;
  v_last_ride   timestamptz;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin role required';
  END IF;

  SELECT * INTO v_pi FROM payment_intents WHERE id = p_payment_intent_id;
  IF v_pi.id IS NULL THEN
    RAISE EXCEPTION 'Payment intent not found: %', p_payment_intent_id;
  END IF;

  SELECT * INTO v_user FROM users WHERE id = v_pi.user_id;

  -- Wallet credit posted by this recharge. payment_intents.transaction_id
  -- is set to the ledger transaction when the payment completes.
  SELECT COALESCE(SUM(le.amount), 0) INTO v_credited
  FROM ledger_entries le
  WHERE le.transaction_id = v_pi.transaction_id AND le.amount > 0;

  -- Rides the user took after the recharge — proof the service was delivered.
  SELECT COUNT(*), COALESCE(SUM(final_fare_cup), 0), MIN(created_at), MAX(created_at)
  INTO v_rides_count, v_rides_fare, v_first_ride, v_last_ride
  FROM rides
  WHERE customer_id = v_pi.user_id
    AND created_at >= v_pi.created_at;

  RETURN jsonb_build_object(
    'generated_at', NOW(),
    'recharge', jsonb_build_object(
      'payment_intent_id', v_pi.id,
      'status', v_pi.status,
      'amount_cup', v_pi.amount_cup,
      'amount_usd', v_pi.amount_usd,
      'stripe_payment_intent_id', v_pi.stripe_payment_intent_id,
      'created_at', v_pi.created_at,
      'paid_at', v_pi.paid_at,
      'client_ip', v_pi.client_ip,
      'user_agent', v_pi.user_agent,
      'device_fingerprint', v_pi.device_fingerprint
    ),
    'account', jsonb_build_object(
      'user_id', v_user.id,
      'account_created_at', v_user.created_at,
      'account_age_days', (CURRENT_DATE - v_user.created_at::date),
      'phone', v_user.phone,
      'is_active', v_user.is_active
    ),
    'credit', jsonb_build_object(
      'ledger_transaction_id', v_pi.transaction_id,
      'credited_amount', v_credited
    ),
    'service_delivered', jsonb_build_object(
      'rides_after_recharge', v_rides_count,
      'rides_total_fare_cup', v_rides_fare,
      'first_ride_at', v_first_ride,
      'last_ride_at', v_last_ride
    )
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION build_chargeback_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION build_chargeback_evidence(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION build_chargeback_evidence(uuid) IS
  'Phase B7: assembles the compelling-evidence bundle (recharge + account + wallet credit + service-delivered rides) for a disputed card payment. Admin-gated.';
