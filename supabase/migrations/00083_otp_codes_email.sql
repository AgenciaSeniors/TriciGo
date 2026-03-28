-- ============================================================
-- Add email column to otp_codes for Email OTP authentication
-- ============================================================

-- Add email column (nullable, since existing rows use phone)
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS email TEXT;

-- Make phone nullable (was NOT NULL, now either phone or email is used)
ALTER TABLE otp_codes ALTER COLUMN phone DROP NOT NULL;

-- Index for fast email + expiry lookup
CREATE INDEX IF NOT EXISTS idx_otp_email_expires ON otp_codes(email, expires_at DESC);
