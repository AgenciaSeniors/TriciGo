-- 00534_partner_coupon_rpcs.sql
--
-- ── What `anon` can reach in this file, and why ───────────────────────
-- Exactly two functions are granted to anon:
--   validate_partner_coupon(p_token, p_code)
--   redeem_partner_coupon(p_token, p_code)
-- They are login-free on purpose: the person at the counter is a bakery
-- employee who has no TriciGo account and never will. Everything else here is
-- authenticated-only or revoked outright.
--
-- Both take the business's secret validation token (00532) as their FIRST
-- argument, because that token — not the caller's IP — is the identity of the
-- validator. That single decision is what this file is shaped around:
--
--   * Rate limiting keys on the RESOLVED partner_place_id (a UUID). Bounded
--     cardinality, not client-controllable, and one bucket per business, so
--     the many partner businesses sharing a single CGNAT egress IP — which in
--     Cuba is very nearly all of them — no longer share a budget.
--   * A coupon only validates AT THE BUSINESS THAT ISSUED IT. A bakery's
--     coupon presented at a cafe is `not_found`, indistinguishable from a code
--     that never existed.
--   * Brute-forcing a coupon code requires knowing a business token first.
--   * Tokens that do not resolve all share ONE bucket, so guessing at tokens
--     cannot inflate rate_limits cardinality.
--
-- This REPLACES a per-IP limiter that keyed on the leftmost element of
-- X-Forwarded-For. That element is supplied by the client — Supabase's edge
-- APPENDS the real address on the right — so it was bypassable by varying the
-- header (three requests with two forged headers produced three separate
-- buckets), it let an attacker lock a specific shop out by forging that shop's
-- IP 30 times, and every forged value minted a rate_limits row keyed on
-- arbitrary caller-controlled TEXT. The derivation is deleted rather than kept
-- as a fallback: it was the vulnerability, and a fallback would restore it.

-- ── Discovery ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_nearby_partner_places(
  p_lat   DOUBLE PRECISION,
  p_lng   DOUBLE PRECISION,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, name TEXT, benefit_title TEXT, benefit_description TEXT,
  terms TEXT, photo_url TEXT, category TEXT, address TEXT,
  municipality TEXT, phone TEXT, hours TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  distance_m DOUBLE PRECISION, has_active_coupon BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_origin GEOGRAPHY;
  v_radius NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN;
  END IF;

  v_origin := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius := public.get_platform_config_numeric('partner_places_discovery_radius_m', 15000);

  RETURN QUERY
  SELECT pp.id, pp.name, pp.benefit_title, pp.benefit_description,
         pp.terms, pp.photo_url, pp.category, pp.address,
         pp.municipality, pp.phone, pp.hours,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         ST_Distance(pp.location, v_origin),
         EXISTS (
           SELECT 1 FROM public.partner_coupons pc
           WHERE pc.partner_place_id = pp.id
             -- THIS LINE IS THE DATA-ISOLATION BOUNDARY. The function is
             -- SECURITY DEFINER, so RLS is bypassed and nothing else stops one
             -- passenger from being told about another's coupons.
             AND pc.user_id = auth.uid()
             AND pc.redeemed_at IS NULL
             AND pc.expires_at > now()
         )
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_origin, v_radius)
  ORDER BY ST_Distance(pp.location, v_origin)
  -- Floor AND ceiling: p_limit arrives from the client, and without the LEAST
  -- a single call could ask for the whole table.
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
END;
$$;

-- ── The passenger's live coupons ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_partner_coupons()
RETURNS TABLE (
  id UUID, code TEXT, place_name TEXT, benefit_title TEXT,
  benefit_description TEXT, terms TEXT, photo_url TEXT, category TEXT,
  address TEXT, phone TEXT, hours TEXT,
  issued_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT pc.id, pc.code, pp.name, pp.benefit_title, pp.benefit_description,
         pp.terms, pp.photo_url, pp.category, pp.address, pp.phone, pp.hours,
         pc.issued_at, pc.expires_at
  FROM public.partner_coupons pc
  JOIN public.partner_places pp ON pp.id = pc.partner_place_id
  -- THIS LINE IS THE DATA-ISOLATION BOUNDARY. The function is SECURITY
  -- DEFINER, so RLS is bypassed; this predicate is the only thing separating
  -- one passenger's coupon codes from every other passenger's.
  WHERE pc.user_id = auth.uid()
    AND pc.redeemed_at IS NULL
    AND pc.expires_at > now()
  ORDER BY pc.expires_at ASC;
END;
$$;

-- ── Shared code normaliser ────────────────────────────────────────────
-- The employee types what they see. Accept 'tg-k7m2qx', 'K7M2QX', 'k7 m2 qx'.
CREATE OR REPLACE FUNCTION public._normalize_coupon_code(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_catalog
AS $$
  WITH stripped AS (
    SELECT regexp_replace(upper(COALESCE(p_raw, '')), '[^A-Z0-9]', '', 'g') AS s
  )
  SELECT CASE
           -- Strip the display prefix ONLY when doing so leaves exactly six
           -- characters. Both 'T' and 'G' are in the code alphabet, so a
           -- legitimate code can itself begin "TG" (e.g. TG4K9P). Stripping
           -- unconditionally would truncate it to four characters and make
           -- roughly 1 in 961 coupons permanently unredeemable — a failure
           -- the passenger could never work around and the shop could never
           -- explain.
           WHEN length(s) = 8 AND s LIKE 'TG%' THEN substr(s, 3)
           ELSE s
         END
  FROM stripped;
$$;

-- ── Drop the superseded single-argument signatures ────────────────────
-- CREATE OR REPLACE cannot change a function's argument list — it would
-- silently create an OVERLOAD and leave the old, IP-keyed, unscoped versions
-- sitting there still granted to anon. They have to be dropped by name.
-- Dropping a function drops its grants with it.
DROP FUNCTION IF EXISTS public.validate_partner_coupon(TEXT);
DROP FUNCTION IF EXISTS public.redeem_partner_coupon(TEXT);
DROP FUNCTION IF EXISTS public._coupon_rate_limit_ok(TEXT);

-- ── Rate-limit helper for the public endpoints ────────────────────────
-- Takes the bucket key already resolved by the caller. There is deliberately
-- no IP derivation anywhere in this file.
CREATE OR REPLACE FUNCTION public._coupon_rate_limit_ok(
  p_scope    TEXT,
  p_bucket   TEXT,
  p_max      INT DEFAULT NULL,
  p_window_s INT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_max     INT;
  v_window  INT;
  v_allowed BOOLEAN;
BEGIN
  -- NULL overrides fall back to config, so the budget can be retuned during an
  -- incident without a migration. Callers pass an explicit value only where a
  -- different, tighter budget is intended (the shared bad-token bucket).
  v_max    := COALESCE(p_max,
                public.get_platform_config_numeric('coupon_validate_max_per_window', 60)::INT);
  v_window := COALESCE(p_window_s,
                public.get_platform_config_numeric('coupon_validate_window_s', 600)::INT);

  SELECT allowed INTO v_allowed
  FROM public.check_rate_limit(p_scope || ':' || p_bucket, v_max, v_window);

  RETURN COALESCE(v_allowed, false);
EXCEPTION WHEN OTHERS THEN
  -- Fail CLOSED on a public write endpoint. But SAY SO: without this warning a
  -- broken limiter is indistinguishable from ordinary throttling, and every
  -- validation on the platform silently returning rate_limited looks exactly
  -- like a busy Saturday. This codebase has twice been burned by a defensive
  -- handler that swallowed the diagnosis along with the error.
  RAISE WARNING '[_coupon_rate_limit_ok] scope=% bucket=%: % % — failing CLOSED, coupon validation is now refusing every request',
    p_scope, p_bucket, SQLSTATE, SQLERRM;
  RETURN false;
END;
$$;

-- ── Token → business ──────────────────────────────────────────────────
-- Resolves the secret in tricigo.com/v/<token> to the business it belongs to,
-- or NULL. An inactive or expired partnership stops resolving, which retires
-- its link without touching any coupon.
CREATE OR REPLACE FUNCTION public._resolve_partner_validation_token(p_token TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_place_id UUID;
BEGIN
  SELECT pp.id INTO v_place_id
  FROM public.partner_places pp
  WHERE pp.validation_token = lower(btrim(COALESCE(p_token, '')))
    AND pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now());

  RETURN v_place_id;
END;
$$;

-- ── The verdict on one code at one business ───────────────────────────
-- Shared by validate and by redeem's fallthrough. Charges no rate limit: both
-- callers have already paid for this request, and the fallthrough must not pay
-- twice (see redeem_partner_coupon).
CREATE OR REPLACE FUNCTION public._partner_coupon_verdict(
  p_place_id UUID,
  p_code     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT pc.expires_at, pc.redeemed_at, pc.issued_at,
         pp.name AS place_name, pp.benefit_title, pp.terms,
         u.full_name
  INTO v_row
  FROM public.partner_coupons pc
  JOIN public.partner_places pp ON pp.id = pc.partner_place_id
  JOIN public.users u           ON u.id  = pc.user_id
  WHERE pc.code = p_code
    -- Scoping. A live coupon belonging to a DIFFERENT business is not_found
    -- here, exactly like a code that never existed — the shop learns nothing
    -- about coupons it did not issue, and cannot burn them.
    AND pc.partner_place_id = p_place_id;

  IF NOT FOUND THEN
    -- No hint about which codes exist.
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_row.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'used', 'redeemed_at', v_row.redeemed_at);
  END IF;

  IF v_row.expires_at <= now() THEN
    RETURN jsonb_build_object('status', 'expired', 'expires_at', v_row.expires_at);
  END IF;

  RETURN jsonb_build_object(
    'status',        'valid',
    'place_name',    v_row.place_name,
    'benefit_title', v_row.benefit_title,
    'terms',         v_row.terms,
    -- First name plus last initial only. Enough to match the person at the
    -- counter, not enough to harvest identities by probing codes.
    'customer',      split_part(COALESCE(v_row.full_name, ''), ' ', 1)
                     || CASE
                          WHEN split_part(COALESCE(v_row.full_name, ''), ' ', 2) <> ''
                          THEN ' ' || left(split_part(v_row.full_name, ' ', 2), 1) || '.'
                          ELSE ''
                        END,
    'arrived_at',    v_row.issued_at,
    'expires_at',    v_row.expires_at
  );
END;
$$;

-- ── Validation (public, no login) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_partner_coupon(
  p_token TEXT,
  p_code  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_place_id UUID;
  v_code     TEXT;
BEGIN
  v_place_id := public._resolve_partner_validation_token(p_token);

  IF v_place_id IS NULL THEN
    -- ONE shared bucket for every unresolvable token, on a tight budget.
    -- Shared so that guessing at tokens cannot mint a rate_limits row per
    -- guess; tight because nobody reaches this path in normal use — a shop
    -- opens its own bookmark. The verdict is identical for every invalid
    -- token, so nothing here reveals which tokens exist.
    IF NOT public._coupon_rate_limit_ok('coupon_badtoken', 'all', 20) THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'invalid_link');
  END IF;

  IF NOT public._coupon_rate_limit_ok('coupon_validate', v_place_id::TEXT) THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  RETURN public._partner_coupon_verdict(v_place_id, v_code);
END;
$$;

-- ── Redemption by the business (public, no login) ─────────────────────
CREATE OR REPLACE FUNCTION public.redeem_partner_coupon(
  p_token TEXT,
  p_code  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_place_id UUID;
  v_code     TEXT;
  v_id       UUID;
BEGIN
  v_place_id := public._resolve_partner_validation_token(p_token);

  IF v_place_id IS NULL THEN
    IF NOT public._coupon_rate_limit_ok('coupon_badtoken', 'all', 20) THEN
      RETURN jsonb_build_object('status', 'rate_limited');
    END IF;
    RETURN jsonb_build_object('status', 'invalid_link');
  END IF;

  IF NOT public._coupon_rate_limit_ok('coupon_redeem', v_place_id::TEXT) THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Atomic claim, same shape as the NETOPIA webhook. Two employees hitting
  -- the same code concurrently: one wins, the other is told it is used.
  -- Scoped to this business, so a shop cannot burn a coupon it did not issue.
  UPDATE public.partner_coupons
  SET redeemed_at = now(), redeemed_via = 'business'
  WHERE code = v_code
    AND partner_place_id = v_place_id
    AND redeemed_at IS NULL
    AND expires_at > now()
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'redeemed');
  END IF;

  -- Lost the race, already used, expired, issued elsewhere, or never existed.
  -- Re-read to say which, REUSING the place already resolved above and
  -- charging no second budget. Previously this called validate_partner_coupon,
  -- which re-entered the *validate* scope: a shop that had spent its validate
  -- budget was told an expired coupon was rate_limited — a wrong verdict at
  -- the counter, not merely an extra cost.
  RETURN public._partner_coupon_verdict(v_place_id, v_code);
END;
$$;

-- ── "Ya lo usé" — the offline fallback ────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_own_partner_coupon(p_coupon_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthenticated');
  END IF;

  UPDATE public.partner_coupons
  SET redeemed_at = now(), redeemed_via = 'self'
  WHERE id = p_coupon_id
    AND user_id = auth.uid()
    AND redeemed_at IS NULL
    AND expires_at > now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', CASE WHEN v_id IS NULL THEN 'unavailable' ELSE 'redeemed' END);
END;
$$;

-- ── Grants ────────────────────────────────────────────────────────────
-- `FROM PUBLIC` alone would be a silent no-op on this project: pg_default_acl
-- grants EXECUTE explicitly to anon/authenticated/service_role, so the roles
-- have to be named. See the long note in 00533.
REVOKE ALL ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_partner_coupons() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_own_partner_coupon(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_partner_coupon(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_partner_coupon(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._coupon_rate_limit_ok(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
-- Not callable directly: it would be an oracle telling anyone whether a given
-- token is live, and the id it returns is the key to another shop's coupons.
REVOKE ALL ON FUNCTION public._resolve_partner_validation_token(TEXT) FROM PUBLIC, anon, authenticated;
-- Not callable directly: it is the verdict WITHOUT the token check or the rate
-- limit, i.e. precisely the unscoped endpoint this migration removes.
REVOKE ALL ON FUNCTION public._partner_coupon_verdict(UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_partner_coupons() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_own_partner_coupon(UUID) TO authenticated;
-- Deliberately anon: the shop employee has no TriciGo account and never will.
-- Reachable only with that shop's secret token, and scoped to that shop.
GRANT EXECUTE ON FUNCTION public.validate_partner_coupon(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_partner_coupon(TEXT, TEXT)  TO anon, authenticated;

COMMENT ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) IS
  '00534 Partner places within partner_places_discovery_radius_m of a point, nearest first, flagging the ones where the caller already holds a live coupon. Returns nothing to an anonymous caller. p_limit is clamped to 1..50.';
COMMENT ON FUNCTION public.get_my_partner_coupons() IS
  '00534 The calling passenger''s unredeemed, unexpired coupons, soonest to expire first.';
COMMENT ON FUNCTION public._normalize_coupon_code(TEXT) IS
  '00534 Folds what an employee types into the stored code: upper-cases, drops separators, and strips the TG display prefix only when that leaves exactly six characters (a real code may itself start with TG). Deliberately left world-executable: it is a pure string function whose only secret would be the TG- convention already printed on every coupon.';
COMMENT ON FUNCTION public._coupon_rate_limit_ok(TEXT, TEXT, INT, INT) IS
  '00534 Budget for the login-free coupon endpoints, keyed on a bucket the CALLER resolves (the partner_place_id) — never on a client-supplied IP header. Defaults read coupon_validate_max_per_window / coupon_validate_window_s. Fails CLOSED, with a WARNING, if the rate limiter is unavailable.';
COMMENT ON FUNCTION public._resolve_partner_validation_token(TEXT) IS
  '00534 Maps a tricigo.com/v/<token> secret to its active partner place, or NULL. Internal only.';
COMMENT ON FUNCTION public._partner_coupon_verdict(UUID, TEXT) IS
  '00534 Verdict on one normalised code AT ONE BUSINESS: valid | used | expired | not_found. Internal only — carries no token check and no rate limit.';
COMMENT ON FUNCTION public.validate_partner_coupon(TEXT, TEXT) IS
  '00534 Public, login-free verdict for the shop counter, authorised by the business''s own validation token: valid | used | expired | not_found | invalid_link | rate_limited. Scoped to the issuing business and rate-limited per business. Never reveals more than first name plus last initial.';
COMMENT ON FUNCTION public.redeem_partner_coupon(TEXT, TEXT) IS
  '00534 Public, login-free single-use claim by the business, authorised by its own validation token. Atomic: concurrent callers get one redeemed and the rest used. Sets redeemed_via = business. A coupon issued by another business is not_found.';
COMMENT ON FUNCTION public.redeem_own_partner_coupon(UUID) IS
  '00534 The passenger burns their own coupon from the app ("Ya lo usé") when the shop cannot open the page. Sets redeemed_via = self, which is a claim rather than evidence.';
