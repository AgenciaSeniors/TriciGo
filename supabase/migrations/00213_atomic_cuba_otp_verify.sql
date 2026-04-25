-- ============================================================
-- BUG-184 (CRITICAL): the verify-otp Edge Function had a race
-- condition + off-by-one on the attempts counter, allowing OTP
-- brute force.
--
-- Original code path:
--   1. SELECT latest OTP for phone
--   2. UPDATE attempts = attempts + 1
--   3. IF otpRecord.attempts >= 5 THEN return 'too many'   ← uses OLD value
--   4. IF code != provided THEN return 'invalid'
--
-- Off-by-one: step 3 checks the OLD value, so attempts={0,1,2,3,4,5}
-- all pass — 6 attempts instead of the intended 5.
--
-- Race: steps 1-3 are not atomic. N concurrent requests all see
-- attempts=4, all increment to 5, all pass the < 5 check (using
-- their stale OLD value), all proceed to code comparison. With a
-- 6-digit OTP space (10^6) and a botnet, this collapses to
-- ~minutes for full brute force.
--
-- Fix: atomic SECDEF RPC `verify_cuba_otp(phone, code)` that locks
-- the OTP row (SELECT ... FOR UPDATE) and increments + checks in a
-- single transaction. Restricted to service_role (only the EF calls
-- it).
--
-- Also adds a CHECK constraint on otp_codes.attempts as belt-and-
-- suspenders so a future EF bug can't cause unbounded increment.
-- ============================================================

CREATE OR REPLACE FUNCTION public.verify_cuba_otp(p_phone text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_otp_id     UUID;
  v_attempts   INTEGER;
  v_stored_code TEXT;
  v_now        TIMESTAMPTZ := now();
BEGIN
  -- Lock the latest unverified, non-expired OTP for this phone.
  SELECT id, attempts, code INTO v_otp_id, v_attempts, v_stored_code
  FROM otp_codes
  WHERE phone = p_phone
    AND verified_at IS NULL
    AND expires_at > v_now
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_otp_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_active_code');
  END IF;

  -- Check attempts BEFORE incrementing — fixes the off-by-one.
  IF v_attempts >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  END IF;

  -- Always increment the attempt counter (atomic with the lock above).
  UPDATE otp_codes SET attempts = v_attempts + 1 WHERE id = v_otp_id;

  IF v_stored_code IS DISTINCT FROM p_code THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invalid_code',
      'attempts_remaining', GREATEST(0, 5 - (v_attempts + 1))
    );
  END IF;

  -- Code matches under the limit — mark verified.
  UPDATE otp_codes SET verified_at = v_now WHERE id = v_otp_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- service_role-only (the verify-otp EF is the only legitimate caller).
REVOKE EXECUTE ON FUNCTION public.verify_cuba_otp(text, text) FROM PUBLIC, anon, authenticated;

-- Defense in depth: cap attempts at 10 (well above the 5 limit). If
-- a future EF refactor reintroduces unbounded increment, the DB
-- rejects it instead of silently allowing forever-incrementing rows.
ALTER TABLE public.otp_codes
  ADD CONSTRAINT otp_codes_attempts_capped
  CHECK (attempts >= 0 AND attempts <= 10) NOT VALID;
ALTER TABLE public.otp_codes VALIDATE CONSTRAINT otp_codes_attempts_capped;
