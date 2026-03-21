-- ============================================================
-- OTP codes table for WhatsApp OTP verification (replaces Twilio SMS)
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0
);

-- Index for fast lookup by phone + expiry
CREATE INDEX idx_otp_phone_expires ON otp_codes(phone, expires_at DESC);

-- Auto-cleanup: delete expired codes older than 2 hours (runs every hour)
SELECT cron.schedule(
  'cleanup-expired-otp-codes',
  '0 * * * *',
  $$DELETE FROM otp_codes WHERE expires_at < NOW() - INTERVAL '2 hours'$$
);

-- RLS: only service role can access otp_codes (edge functions use service role)
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
-- No public policies — only service_role can read/write

-- Platform config for Infobip WhatsApp
INSERT INTO platform_config (key, value) VALUES
  ('infobip_api_key', '"YOUR_INFOBIP_API_KEY"'),
  ('infobip_base_url', '"https://api.infobip.com"'),
  ('infobip_whatsapp_sender', '"YOUR_WHATSAPP_NUMBER"')
ON CONFLICT (key) DO NOTHING;
