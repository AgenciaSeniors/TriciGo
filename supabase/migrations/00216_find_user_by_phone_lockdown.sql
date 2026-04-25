-- ============================================================
-- BUG-195: find_user_by_phone(p_phone) is SECURITY DEFINER, granted
-- EXECUTE to anon AND authenticated. Returns the full {id, full_name,
-- phone} of any user whose phone matches. Anyone with internet can
-- iterate phone numbers and:
--   - Enumerate the entire TriciGo user base by phone
--   - Pair each phone with the user's full_name (PII leak)
--   - Build a phone→name dictionary for targeted phishing/scams
--
-- Original purpose: app-side P2P transfer flow ("look up recipient
-- before sending"). Authenticated-only is enough — anon should never
-- need this. Plus add a per-caller rate limit via check_rate_limit.
--
-- Fix:
--   1. Revoke EXECUTE from anon.
--   2. Add a per-caller rate limit (30 lookups per user per hour).
--   3. Require authenticated context (auth.uid() must not be null).
-- ============================================================

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
  -- Require authenticated context (no anonymous enumeration).
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Forbidden: authentication required';
  END IF;

  -- Per-caller rate limit: 30 lookups per hour. Defends against an
  -- authenticated user who tries to scrape the user base.
  SELECT * INTO v_rl
  FROM check_rate_limit(
    'find_user_by_phone:' || v_caller::text,
    30,
    3600
  );
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
