-- 00531_partner_coupon_rpcs.sql

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
             AND pc.user_id = auth.uid()
             AND pc.redeemed_at IS NULL
             AND pc.expires_at > now()
         )
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_origin, v_radius)
  ORDER BY ST_Distance(pp.location, v_origin)
  LIMIT GREATEST(COALESCE(p_limit, 10), 1);
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

-- ── Rate-limit helper for the public endpoints ────────────────────────
CREATE OR REPLACE FUNCTION public._coupon_rate_limit_ok(p_scope TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_ip      TEXT;
  v_allowed BOOLEAN;
BEGIN
  v_ip := COALESCE(
    NULLIF(split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1), ''),
    'unknown'
  );
  SELECT allowed INTO v_allowed
  FROM public.check_rate_limit(p_scope || ':' || v_ip, 30, 600);
  RETURN COALESCE(v_allowed, false);
EXCEPTION WHEN OTHERS THEN
  -- Rate limiter unavailable. Fail CLOSED on a public write endpoint.
  RETURN false;
END;
$$;

-- ── Validation (public, no login) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_partner_coupon(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_code TEXT;
  v_row  RECORD;
BEGIN
  IF NOT public._coupon_rate_limit_ok('coupon_validate') THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  SELECT pc.id, pc.expires_at, pc.redeemed_at, pc.issued_at,
         pp.name AS place_name, pp.benefit_title, pp.terms,
         u.full_name
  INTO v_row
  FROM public.partner_coupons pc
  JOIN public.partner_places pp ON pp.id = pc.partner_place_id
  JOIN public.users u           ON u.id  = pc.user_id
  WHERE pc.code = v_code;

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

-- ── Redemption by the business (public, no login) ─────────────────────
CREATE OR REPLACE FUNCTION public.redeem_partner_coupon(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_code TEXT;
  v_id   UUID;
BEGIN
  IF NOT public._coupon_rate_limit_ok('coupon_redeem') THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  v_code := public._normalize_coupon_code(p_code);
  IF length(v_code) <> 6 THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Atomic claim, same shape as the NETOPIA webhook. Two employees hitting
  -- the same code concurrently: one wins, the other is told it is used.
  UPDATE public.partner_coupons
  SET redeemed_at = now(), redeemed_via = 'business'
  WHERE code = v_code
    AND redeemed_at IS NULL
    AND expires_at > now()
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'redeemed');
  END IF;

  -- Lost the race, already used, expired, or never existed. Re-read to say which.
  RETURN public.validate_partner_coupon(p_code);
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
REVOKE ALL ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_partner_coupons() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_own_partner_coupon(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_partner_coupon(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redeem_partner_coupon(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._coupon_rate_limit_ok(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_partner_coupons() TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_own_partner_coupon(UUID) TO authenticated;
-- Deliberately anon: the shop employee has no TriciGo account and never will.
GRANT EXECUTE ON FUNCTION public.validate_partner_coupon(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_partner_coupon(TEXT)  TO anon, authenticated;

COMMENT ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT) IS
  '00531 Partner places within partner_places_discovery_radius_m of a point, nearest first, flagging the ones where the caller already holds a live coupon. Returns nothing to an anonymous caller.';
COMMENT ON FUNCTION public.get_my_partner_coupons() IS
  '00531 The calling passenger''s unredeemed, unexpired coupons, soonest to expire first.';
COMMENT ON FUNCTION public._normalize_coupon_code(TEXT) IS
  '00531 Folds what an employee types into the stored code: upper-cases, drops separators, and strips the TG display prefix only when that leaves exactly six characters (a real code may itself start with TG).';
COMMENT ON FUNCTION public._coupon_rate_limit_ok(TEXT) IS
  '00531 Per-IP budget for the login-free coupon endpoints, 30 per 10 minutes per scope. Fails CLOSED if the rate limiter is unavailable.';
COMMENT ON FUNCTION public.validate_partner_coupon(TEXT) IS
  '00531 Public, login-free verdict on a coupon code for the shop counter: valid | used | expired | not_found | rate_limited. Never reveals more than first name plus last initial.';
COMMENT ON FUNCTION public.redeem_partner_coupon(TEXT) IS
  '00531 Public, login-free single-use claim by the business. Atomic: concurrent callers get one redeemed and the rest used. Sets redeemed_via = business.';
COMMENT ON FUNCTION public.redeem_own_partner_coupon(UUID) IS
  '00531 The passenger burns their own coupon from the app ("Ya lo usé") when the shop cannot open the page. Sets redeemed_via = self, which is a claim rather than evidence.';
