-- ============================================================================
-- 00461 — Canonical Cuban phone normalization (registration + gift search + fleet)
-- ============================================================================
-- PROBLEM (verified against prod): public.users.phone is stored inconsistently —
-- some rows as "+535XXXXXXX" and some as "535XXXXXXX" (no "+"). Root cause: GoTrue
-- stores auth.users.phone WITHOUT the leading "+" (e.g. "5355225837"), and the
-- handle_new_user() trigger copies that value verbatim into public.users.phone via
-- COALESCE(NEW.phone, ''). So every OTP signup lands without "+"; the "+"-prefixed
-- rows are older/seeded data written by an explicit UPDATE or the link-phone EF.
--
-- The gift recipient lookup find_user_by_phone() compares with EXACT equality, so a
-- recipient stored as "535XXXXXXX" is invisible when searched as "+535XXXXXXX".
-- The same exact-equality match also silently breaks fleet driver auto-linking.
--
-- FIX (single helper, reused everywhere):
--   a. _normalize_cuban_phone(text)  — IMMUTABLE, mirrors the TS normalizeCubanPhone.
--   b. BEFORE INSERT/UPDATE OF phone trigger on public.users — every write path
--      (handle_new_user INSERT, link-phone UPDATE, profile edits, admin edits) lands
--      canonical "+535XXXXXXX". No need to touch handle_new_user (keeps 00456 email logic).
--   c. find_user_by_phone — compare normalized on both sides (tolerant to legacy rows).
--   d. Fleet auto-link / relink — compare driver_phone normalized on both sides.
--   e. One-time backfill of the existing no-"+" public.users rows (idempotent, no collisions).
--
-- Out of scope (verified clean / unaffected): otp_codes (11/11 already "+"), the
-- edge functions (auth.users is GoTrue-managed; verify-otp dedups by synthetic email).
-- ============================================================================

-- a. Normalization helper -----------------------------------------------------
CREATE OR REPLACE FUNCTION public._normalize_cuban_phone(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_digits text;
BEGIN
  IF p_phone IS NULL THEN
    RETURN NULL;
  END IF;
  v_digits := regexp_replace(p_phone, '\D', '', 'g');          -- strip everything but digits
  IF v_digits ~ '^5\d{7}$' THEN
    RETURN '+53' || v_digits;                                  -- 5XXXXXXX   -> +535XXXXXXX
  ELSIF v_digits ~ '^53\d{8}$' THEN
    RETURN '+' || v_digits;                                    -- 535XXXXXXX -> +535XXXXXXX
  END IF;
  RETURN p_phone;                                              -- '' / admin / non-Cuban: untouched
END;
$$;

COMMENT ON FUNCTION public._normalize_cuban_phone(text) IS
  'Canonicalizes a Cuban mobile to E.164 "+535XXXXXXX". Accepts 5XXXXXXX, 535XXXXXXX or +535XXXXXXX; returns input unchanged for anything else (empty/admin/non-Cuban). Idempotent. Mirrors TS normalizeCubanPhone.';

-- b. Normalize-on-write trigger for public.users ------------------------------
CREATE OR REPLACE FUNCTION public.tg_users_normalize_phone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    NEW.phone := public._normalize_cuban_phone(NEW.phone);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_users_normalize_phone ON public.users;
CREATE TRIGGER tg_users_normalize_phone
  BEFORE INSERT OR UPDATE OF phone ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_users_normalize_phone();

-- c. Gift recipient lookup — tolerant comparison ------------------------------
-- (live body reproduced verbatim; only the WHERE clause changed)
CREATE OR REPLACE FUNCTION public.find_user_by_phone(p_phone text)
RETURNS TABLE(id uuid, full_name text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
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
    WHERE public._normalize_cuban_phone(u.phone) = public._normalize_cuban_phone(p_phone)
      AND u.is_active = true
    LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.find_user_by_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_user_by_phone(text) TO authenticated;

-- d. Fleet member auto-link / relink — tolerant comparison --------------------
-- (live bodies reproduced verbatim; only the driver_phone WHERE comparison changed)
CREATE OR REPLACE FUNCTION public.auto_link_fleet_member_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF NEW.phone IS NULL OR NEW.phone = '' THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = NEW.id,
      status = 'active',
      signed_up_at = now()
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(NEW.phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL
  RETURNING id INTO v_member_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.relink_fleet_member_for_existing_driver(p_driver_id uuid, p_phone text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: only admins can relink fleet members';
  END IF;

  PERFORM set_config('app.trusted_fleet_update', '1', true);

  UPDATE fleet_members
  SET driver_id = p_driver_id,
      status = 'active',
      signed_up_at = COALESCE(signed_up_at, now())
  WHERE public._normalize_cuban_phone(driver_phone) = public._normalize_cuban_phone(p_phone)
    AND status IN ('approved', 'pending_signup')
    AND driver_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- e. One-time backfill of existing non-canonical public.users rows ------------
-- Idempotent: only rows whose stored value differs from its normalized form are
-- touched. Empty/admin rows ('') and already-canonical rows are skipped. Verified
-- against prod: no collisions (every distinct phone normalizes to a unique value).
UPDATE public.users
SET phone = public._normalize_cuban_phone(phone)
WHERE phone <> ''
  AND phone <> public._normalize_cuban_phone(phone);
