-- ============================================================
-- Migration 00013: Wallet Freeze + Fraud Detection
-- Adds freeze capability to wallets and fraud alerting system.
-- ============================================================

-- Add freeze fields to wallet_accounts
ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT false;
ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE wallet_accounts
  ADD COLUMN IF NOT EXISTS frozen_by UUID REFERENCES users(id);

-- Fraud alerts table
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  details JSONB,
  resolved BOOLEAN DEFAULT false,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_user
  ON fraud_alerts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_unresolved
  ON fraud_alerts(resolved, created_at DESC) WHERE resolved = false;

-- RLS
ALTER TABLE fraud_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage fraud alerts" ON fraud_alerts;
CREATE POLICY "Admins manage fraud alerts" ON fraud_alerts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'super_admin')
    )
  );

-- ============================================================
-- freeze_wallet: Freeze a user's wallet (admin action)
-- ============================================================
CREATE OR REPLACE FUNCTION freeze_wallet(
  p_user_id UUID,
  p_reason TEXT,
  p_admin_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE wallet_accounts
  SET is_frozen = true,
      frozen_reason = p_reason,
      frozen_at = NOW(),
      frozen_by = p_admin_id
  WHERE user_id = p_user_id;

  -- Log admin action
  INSERT INTO admin_actions (admin_id, action, target_type, target_id, details)
  VALUES (p_admin_id, 'freeze_wallet', 'user', p_user_id,
    jsonb_build_object('reason', p_reason));

  RETURN true;
END;
$$;

-- ============================================================
-- unfreeze_wallet: Unfreeze a user's wallet (admin action)
-- ============================================================
CREATE OR REPLACE FUNCTION unfreeze_wallet(
  p_user_id UUID,
  p_admin_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE wallet_accounts
  SET is_frozen = false,
      frozen_reason = NULL,
      frozen_at = NULL,
      frozen_by = NULL
  WHERE user_id = p_user_id;

  -- Log admin action
  INSERT INTO admin_actions (admin_id, action, target_type, target_id)
  VALUES (p_admin_id, 'unfreeze_wallet', 'user', p_user_id);

  RETURN true;
END;
$$;

-- ============================================================
-- check_fraud_signals: Detect suspicious activity for a user
-- Returns array of alert_type strings if suspicious
-- ============================================================
CREATE OR REPLACE FUNCTION check_fraud_signals(
  p_user_id UUID
) RETURNS TABLE (
  alert_type TEXT,
  severity TEXT,
  details JSONB
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_transfer_count INTEGER;
  v_recharge_count INTEGER;
  v_cancel_rate DECIMAL;
  v_total_rides INTEGER;
  v_cancel_count INTEGER;
BEGIN
  -- 1. Check: >5 P2P transfers in the last hour
  SELECT COUNT(*) INTO v_transfer_count
  FROM wallet_transfers
  WHERE from_user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 hour';

  IF v_transfer_count > 5 THEN
    alert_type := 'unusual_transfer';
    severity := 'high';
    details := jsonb_build_object('transfers_last_hour', v_transfer_count);
    RETURN NEXT;
  END IF;

  -- 2. Check: >3 recharge requests in the last day
  SELECT COUNT(*) INTO v_recharge_count
  FROM wallet_recharge_requests
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 day';

  IF v_recharge_count > 3 THEN
    alert_type := 'rapid_recharges';
    severity := 'medium';
    details := jsonb_build_object('recharges_last_day', v_recharge_count);
    RETURN NEXT;
  END IF;

  -- 3. Check: cancellation rate > 50% (min 10 rides)
  SELECT total_rides, cancellation_count
  INTO v_total_rides, v_cancel_count
  FROM users WHERE id = p_user_id;

  IF COALESCE(v_total_rides, 0) >= 10 THEN
    v_cancel_rate := COALESCE(v_cancel_count, 0)::DECIMAL / v_total_rides;
    IF v_cancel_rate > 0.5 THEN
      alert_type := 'suspicious_cancellations';
      severity := 'medium';
      details := jsonb_build_object(
        'total_rides', v_total_rides,
        'cancellation_count', v_cancel_count,
        'cancellation_rate', round(v_cancel_rate * 100, 1)
      );
      RETURN NEXT;
    END IF;
  END IF;

  RETURN;
END;
$$;

-- ============================================================
-- auto_check_fraud_on_transfer: After P2P transfer, check signals
-- ============================================================
CREATE OR REPLACE FUNCTION trg_check_fraud_on_transfer()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_alert RECORD;
BEGIN
  FOR v_alert IN
    SELECT * FROM check_fraud_signals(NEW.from_user_id)
  LOOP
    -- Only insert if no unresolved alert of same type for this user in last 24h
    IF NOT EXISTS (
      SELECT 1 FROM fraud_alerts
      WHERE user_id = NEW.from_user_id
        AND alert_type = v_alert.alert_type
        AND resolved = false
        AND created_at > NOW() - INTERVAL '24 hours'
    ) THEN
      INSERT INTO fraud_alerts (user_id, alert_type, severity, details)
      VALUES (NEW.from_user_id, v_alert.alert_type, v_alert.severity, v_alert.details);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_fraud_on_transfer ON wallet_transfers;
CREATE TRIGGER trg_check_fraud_on_transfer
  AFTER INSERT ON wallet_transfers
  FOR EACH ROW
  EXECUTE FUNCTION trg_check_fraud_on_transfer();
