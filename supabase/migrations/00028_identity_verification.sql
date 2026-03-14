-- ============================================================
-- Migration 00028: Identity Verification (Selfie + Document)
-- Adds individual document verification, face matching scores,
-- and periodic selfie checks for drivers.
-- ============================================================

-- 1. Extend driver_documents with verification metadata
ALTER TABLE driver_documents
  ADD COLUMN IF NOT EXISTS verification_notes text,
  ADD COLUMN IF NOT EXISTS face_match_score real,
  ADD COLUMN IF NOT EXISTS liveness_passed boolean;

-- 2. Selfie checks table (periodic identity verification)
CREATE TABLE IF NOT EXISTS selfie_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES driver_profiles(id) ON DELETE CASCADE,
  storage_path text NOT NULL DEFAULT '',
  face_match_score real,
  liveness_passed boolean,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'passed', 'failed', 'expired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_selfie_checks_driver
  ON selfie_checks(driver_id, requested_at DESC);

-- 4. RLS
ALTER TABLE selfie_checks ENABLE ROW LEVEL SECURITY;

-- Drivers can read their own selfie checks
CREATE POLICY selfie_checks_driver_read ON selfie_checks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE id = selfie_checks.driver_id
      AND user_id = auth.uid()
    )
  );

-- Drivers can insert their own selfie checks
CREATE POLICY selfie_checks_driver_insert ON selfie_checks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE id = selfie_checks.driver_id
      AND user_id = auth.uid()
    )
  );

-- Drivers can update their own selfie checks (upload path, status)
CREATE POLICY selfie_checks_driver_update ON selfie_checks
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE id = selfie_checks.driver_id
      AND user_id = auth.uid()
    )
  );

-- Admins can read all selfie checks
CREATE POLICY selfie_checks_admin_read ON selfie_checks
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'super_admin'))
  );

-- Service role can update selfie checks (for Edge Function processing)
CREATE POLICY selfie_checks_service_update ON selfie_checks
  FOR UPDATE TO authenticated
  USING (true);

-- 5. Auto-expire old pending selfie checks via pg_cron
SELECT cron.schedule(
  'expire-selfie-checks',
  '*/5 * * * *',
  $$UPDATE selfie_checks SET status = 'expired' WHERE status = 'pending' AND expires_at < now();$$
);
