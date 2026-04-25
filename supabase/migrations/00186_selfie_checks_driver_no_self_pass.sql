-- ============================================================
-- BUG-129: selfie_checks_driver_update was an unconstrained UPDATE
-- policy. Drivers needed it to set storage_path + status='processing'
-- after the upload, but the policy let them write ANY column value.
-- A malicious driver could simply call:
--
--   supabase.from('selfie_checks').update({
--     status: 'passed',
--     face_match_score: 0.99,
--     liveness_passed: true,
--     completed_at: new Date().toISOString(),
--   }).eq('id', myCheckId);
--
-- and bypass the verify-selfie Edge Function entirely. Effect:
-- a fake driver with a stolen ID could pass KYC liveness + face
-- match without ever submitting a real selfie or going through any
-- comparison.
--
-- Verified: under SET LOCAL "request.jwt.claims" of an approved
-- driver's UUID, this exact UPDATE succeeded (status="passed",
-- face_match_score=0.99, liveness_passed=true).
--
-- Fix: rewrite the policy with a WITH CHECK that constrains what
-- the driver can write:
--   - status must be in ('pending','processing','failed')
--   - face_match_score must be NULL
--   - liveness_passed must be NULL
--   - completed_at must be NULL
-- The verify-selfie Edge Function runs as service_role, which
-- bypasses RLS, so it can still write the result fields. Drivers
-- can still update storage_path + transition to 'processing' or
-- 'failed' as the existing flow requires.
-- ============================================================

DROP POLICY IF EXISTS selfie_checks_driver_update ON public.selfie_checks;

CREATE POLICY selfie_checks_driver_update
  ON public.selfie_checks
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE driver_profiles.id = selfie_checks.driver_id
        AND driver_profiles.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM driver_profiles
      WHERE driver_profiles.id = selfie_checks.driver_id
        AND driver_profiles.user_id = (SELECT auth.uid())
    )
    AND status IN ('pending', 'processing', 'failed')
    AND face_match_score IS NULL
    AND liveness_passed IS NULL
    AND completed_at IS NULL
  );

COMMENT ON POLICY selfie_checks_driver_update ON public.selfie_checks IS
  'BUG-129: drivers can only update storage_path + transition status to processing or failed. They cannot set status=passed or write face_match_score/liveness_passed/completed_at. The verify-selfie Edge Function bypasses RLS via service_role.';
