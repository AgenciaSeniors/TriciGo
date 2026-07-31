-- 00535_partner_places_admin_rpcs.sql
-- Admin CRUD + the issued/redeemed counters that measure the health of a deal.
--
-- Why these are SECURITY DEFINER rather than plain table access: 00531 dropped
-- the table-wide SELECT grant on partner_places and handed back every column
-- EXCEPT validation_token, because that token IS the authorisation to redeem
-- coupons at a business and the rate-limit bucket key (00533). The admin needs
-- to read it to hand the link over when a deal is signed. A SECURITY DEFINER
-- function resolves privileges against its owner, so it reaches the column that
-- `authenticated` cannot. Do NOT "fix" a permission error on this table by
-- granting the column back — REVOKE SELECT (column) would not undo it, since
-- column privileges are additive with a table-level grant.

CREATE OR REPLACE FUNCTION public.admin_list_partner_places()
RETURNS TABLE (
  id UUID, name TEXT, category TEXT, address TEXT, municipality TEXT, province TEXT,
  photo_url TEXT, benefit_title TEXT, benefit_description TEXT, terms TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  radius_m INT, coupon_ttl_minutes INT, cooldown_days INT,
  is_active BOOLEAN, valid_until TIMESTAMPTZ, phone TEXT, hours TEXT,
  validation_token TEXT,
  created_at TIMESTAMPTZ,
  issued_count BIGINT, redeemed_count BIGINT, redeemed_by_business_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;

  -- Every reference below is table-qualified on purpose: the RETURNS TABLE
  -- column names are also plpgsql OUT variables, and an unqualified `id` or
  -- `name` here would be ambiguous.
  RETURN QUERY
  SELECT pp.id, pp.name, pp.category, pp.address, pp.municipality, pp.province,
         pp.photo_url, pp.benefit_title, pp.benefit_description, pp.terms,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         pp.radius_m, pp.coupon_ttl_minutes, pp.cooldown_days,
         pp.is_active, pp.valid_until, pp.phone, pp.hours,
         pp.validation_token, pp.created_at,
         COALESCE(c.issued, 0), COALESCE(c.redeemed, 0), COALESCE(c.by_business, 0)
  FROM public.partner_places pp
  LEFT JOIN LATERAL (
    SELECT count(*) AS issued,
           count(*) FILTER (WHERE pc.redeemed_at IS NOT NULL) AS redeemed,
           count(*) FILTER (WHERE pc.redeemed_via = 'business') AS by_business
    FROM public.partner_coupons pc WHERE pc.partner_place_id = pp.id
  ) c ON true
  ORDER BY pp.is_active DESC, pp.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_partner_place(
  p_id UUID, p_name TEXT, p_category TEXT,
  p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION,
  p_benefit_title TEXT, p_benefit_description TEXT,
  p_terms TEXT, p_photo_url TEXT, p_address TEXT,
  p_municipality TEXT, p_province TEXT, p_phone TEXT, p_hours TEXT,
  p_radius_m INT, p_coupon_ttl_minutes INT, p_cooldown_days INT,
  p_is_active BOOLEAN, p_valid_until TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_id  UUID;
  v_loc GEOGRAPHY;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Marca el lugar en el mapa antes de guardar.', DETAIL = 'missing_coordinates';
  END IF;

  v_loc := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  IF p_id IS NULL THEN
    INSERT INTO public.partner_places (
      name, category, location, benefit_title, benefit_description, terms,
      photo_url, address, municipality, province, phone, hours,
      radius_m, coupon_ttl_minutes, cooldown_days, is_active, valid_until, created_by
    ) VALUES (
      p_name, COALESCE(p_category, 'other'), v_loc, p_benefit_title, p_benefit_description, p_terms,
      p_photo_url, p_address, p_municipality, p_province, p_phone, p_hours,
      COALESCE(p_radius_m, 80), COALESCE(p_coupon_ttl_minutes, 120), COALESCE(p_cooldown_days, 0),
      COALESCE(p_is_active, true), p_valid_until, auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    -- validation_token is deliberately absent from this SET list. The business
    -- may already have the link bookmarked or printed behind the counter;
    -- rotating it on an unrelated edit (a phone number, a new photo) would
    -- silently break their ability to redeem anything.
    UPDATE public.partner_places SET
      name = p_name, category = COALESCE(p_category, 'other'), location = v_loc,
      benefit_title = p_benefit_title, benefit_description = p_benefit_description,
      terms = p_terms, photo_url = p_photo_url, address = p_address,
      municipality = p_municipality, province = p_province, phone = p_phone, hours = p_hours,
      radius_m = COALESCE(p_radius_m, 80),
      coupon_ttl_minutes = COALESCE(p_coupon_ttl_minutes, 120),
      cooldown_days = COALESCE(p_cooldown_days, 0),
      is_active = COALESCE(p_is_active, true), valid_until = p_valid_until,
      updated_at = now()
    WHERE id = p_id
    RETURNING id INTO v_id;

    -- Without this, an edit aimed at a row that no longer exists updates
    -- nothing, RETURNING sets v_id to NULL, and the caller gets a successful
    -- RPC with a null id — the admin sees "Lugar guardado." over an edit that
    -- was silently discarded. Same reasoning as the service layer's decision
    -- to throw on the admin paths rather than swallow.
    IF v_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002',
        MESSAGE = 'Ese lugar ya no existe. Actualiza la lista e intenta de nuevo.',
        DETAIL = 'partner_place_not_found';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;

-- `REVOKE ... FROM PUBLIC` alone is a silent no-op in this project: pg_default_acl
-- grants EXECUTE explicitly to anon/authenticated/service_role, so there is no
-- PUBLIC grant to remove. Naming the roles is what actually revokes.
REVOKE ALL ON FUNCTION public.admin_list_partner_places() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_partner_place(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_partner_places() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_partner_place(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.admin_list_partner_places() IS
  '00535 Admin list. SECURITY DEFINER so it can read partner_places.validation_token, which 00531 revoked from authenticated at the column level. Gated on is_admin().';
COMMENT ON FUNCTION public.admin_upsert_partner_place(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, INT, BOOLEAN, TIMESTAMPTZ) IS
  '00535 Admin insert/update. Never touches validation_token: businesses bookmark tricigo.com/v/<token> and rotating it on an edit would break redemption.';
