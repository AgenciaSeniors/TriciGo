-- ============================================================
-- Migration 00266: sms_deliveries — track SMS delivery receipts
--
-- Populated in two phases:
--   1. send-sms-otp inserts a row with status='sent' immediately
--      after D7 Networks acknowledges the message (capturing the
--      request_id that D7 echoes in its response).
--   2. process-sms-dlr edge function upserts the same row when
--      D7 calls back via its DLR webhook with the final carrier
--      status (delivered / un_delivered / expired / failed / etc).
--
-- The webhook is configured in D7 dashboard (SMS → Settings):
--   Report URL: https://<project>.supabase.co/functions/v1/process-sms-dlr?secret=<value>
--   Report URL Secret: <value> (D7 also sends X-Webhook-Secret header)
--
-- Useful for admin to verify delivery rate in real time:
--   SELECT recipient, status, EXTRACT(EPOCH FROM (delivered_at - sent_at)) AS delivery_seconds
--   FROM sms_deliveries WHERE created_at > NOW() - INTERVAL '24 hours';
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL UNIQUE,
  msg_id text,
  recipient text NOT NULL,
  originator text,
  provider text NOT NULL DEFAULT 'd7',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','scheduled','delivered','un_delivered','expired','failed','rejected','unknown')),
  tag text,
  raw_dlr jsonb,
  sent_at timestamptz,
  delivered_at timestamptz,
  last_event_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sms_deliveries_recipient_idx ON sms_deliveries(recipient);
CREATE INDEX IF NOT EXISTS sms_deliveries_status_idx ON sms_deliveries(status);
CREATE INDEX IF NOT EXISTS sms_deliveries_created_at_idx ON sms_deliveries(created_at DESC);

ALTER TABLE sms_deliveries ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT. No INSERT/UPDATE/DELETE policies — only service_role writes via edge fns.
DROP POLICY IF EXISTS sms_deliveries_admin_select ON sms_deliveries;
CREATE POLICY sms_deliveries_admin_select ON sms_deliveries
  FOR SELECT
  USING (is_admin());

COMMENT ON TABLE sms_deliveries IS
  'SMS delivery receipts. send-sms-otp inserts row with status=sent at initial send; '
  'process-sms-dlr edge function upserts via D7 webhook with delivered/un_delivered/etc.';
