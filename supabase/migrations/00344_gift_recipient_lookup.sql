-- ============================================================
-- Migration 00344: "Regalo" — recipient lookup helpers
--
-- The gift flow needs to resolve a recipient before sending. Two
-- methods (per product decision): by shareable code/QR and by phone.
--
--   1. find_user_by_phone(text) — restored verbatim from 00216 (it was
--      dropped in 00274 together with the P2P feature). Keeps the
--      anti-enumeration hardening: authenticated-only, exact match,
--      active-only, and a per-caller rate limit (30/hour). This is a
--      SECURITY control against BUG-195 (phone→name enumeration), NOT
--      a limit on gifting.
--
--   2. find_user_by_gift_code(text) — NEW. Resolves a recipient by
--      their referral_codes.code (00319), reused as the user's public
--      shareable "gift code" (the QR payload). Same hardening.
--
-- Both return minimal PII (id + full_name) for a confirmation screen.
-- ============================================================

-- 1) Restore find_user_by_phone (verbatim from 00216, dropped in 00274).
CREATE OR REPLACE FUNCTION public.find_user_by_phone(p_phone text)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_rl     RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;

  SELECT * INTO v_rl
  FROM check_rate_limit('find_user_by_phone:' || v_caller::text, 30, 3600);
  IF NOT v_rl.allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: max 30 phone lookups per hour';
  END IF;

  RETURN QUERY
    SELECT u.id, u.full_name, u.phone
    FROM users u
    WHERE u.phone = p_phone
      AND u.is_active = true
    LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.find_user_by_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_user_by_phone(text) TO authenticated;

-- 2) New: resolve a recipient by their shareable gift code (reuses the
--    referral_codes table from 00319 — codes are public share tokens).
CREATE OR REPLACE FUNCTION public.find_user_by_gift_code(p_code text)
RETURNS TABLE(id uuid, full_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_rl     RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;

  SELECT * INTO v_rl
  FROM check_rate_limit('find_user_by_gift_code:' || v_caller::text, 30, 3600);
  IF NOT v_rl.allowed THEN
    RAISE EXCEPTION 'Rate limit exceeded: max 30 code lookups per hour';
  END IF;

  RETURN QUERY
    SELECT u.id, u.full_name
    FROM referral_codes rc
    JOIN users u ON u.id = rc.user_id
    WHERE rc.code = upper(trim(p_code))
      AND u.is_active = true
    LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.find_user_by_gift_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_user_by_gift_code(text) TO authenticated;

COMMENT ON FUNCTION public.find_user_by_phone(text) IS
  '00344: restored from 00216 (dropped in 00274). Gift recipient lookup by exact phone; authenticated-only, rate-limited 30/h (anti-enumeration, BUG-195).';
COMMENT ON FUNCTION public.find_user_by_gift_code(text) IS
  '00344: gift recipient lookup by shareable referral_codes.code (00319). Authenticated-only, rate-limited 30/h.';
