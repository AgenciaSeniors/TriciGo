-- 00561_partner_places_rpcs.sql
--
-- Recrea las tres RPCs que 00558 dropeó, sobre el modelo de descuento.
-- 00558 las eliminó porque devolvían o consumían columnas que dejaron de existir;
-- aplicar esta migración inmediatamente después: en el medio el panel no lista.

-- ─────────────────────────────────────────────────────────────────────
-- Descubrimiento: el carrusel del pasajero
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_nearby_partner_places(
  p_lat   DOUBLE PRECISION,
  p_lng   DOUBLE PRECISION,
  p_limit INT DEFAULT 10
)
RETURNS TABLE (
  id UUID, name TEXT, discount_percent NUMERIC, tagline TEXT,
  photo_url TEXT, category TEXT, address TEXT, municipality TEXT,
  phone TEXT, hours TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  distance_m DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_origin GEOGRAPHY;
  v_radius NUMERIC;
BEGIN
  IF auth.uid() IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN;
  END IF;

  v_origin := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  v_radius := get_platform_config_numeric('partner_places_discovery_radius_m', 15000);

  RETURN QUERY
  SELECT pp.id, pp.name, pp.discount_percent, pp.tagline,
         pp.photo_url, pp.category, pp.address, pp.municipality,
         pp.phone, pp.hours,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         ST_Distance(pp.location, v_origin)
  FROM public.partner_places pp
  WHERE pp.is_active
    AND (pp.valid_until IS NULL OR pp.valid_until > now())
    AND ST_DWithin(pp.location, v_origin, v_radius)
  ORDER BY ST_Distance(pp.location, v_origin)
  LIMIT GREATEST(COALESCE(p_limit, 10), 1);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Admin: listado con lo que mide el costo real del acuerdo
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_partner_places()
RETURNS TABLE (
  id UUID, name TEXT, category TEXT, address TEXT, municipality TEXT, province TEXT,
  photo_url TEXT, tagline TEXT, discount_percent NUMERIC,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  radius_m INT, is_active BOOLEAN, valid_until TIMESTAMPTZ,
  phone TEXT, hours TEXT, created_at TIMESTAMPTZ,
  rides_count BIGINT, discount_given_cup BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;

  RETURN QUERY
  SELECT pp.id, pp.name, pp.category, pp.address, pp.municipality, pp.province,
         pp.photo_url, pp.tagline, pp.discount_percent,
         ST_Y(pp.location::geometry), ST_X(pp.location::geometry),
         pp.radius_m, pp.is_active, pp.valid_until,
         pp.phone, pp.hours, pp.created_at,
         COALESCE(c.n, 0), COALESCE(c.cup, 0)
  FROM public.partner_places pp
  LEFT JOIN LATERAL (
    -- Solo viajes completados: un viaje cancelado no le costó nada a nadie.
    SELECT count(*) AS n, SUM(r.partner_discount_cup)::BIGINT AS cup
    FROM public.rides r
    WHERE r.partner_place_id = pp.id AND r.status = 'completed'
  ) c ON true
  ORDER BY pp.is_active DESC, pp.created_at DESC;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Admin: alta y edición
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_upsert_partner_place(
  p_id UUID,
  p_name TEXT,
  p_category TEXT,
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_discount_percent NUMERIC,
  p_tagline TEXT,
  p_photo_url TEXT,
  p_address TEXT,
  p_municipality TEXT,
  p_province TEXT,
  p_phone TEXT,
  p_hours TEXT,
  p_radius_m INT,
  p_is_active BOOLEAN,
  p_valid_until TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  v_id  UUID;
  v_loc GEOGRAPHY;
  v_pct NUMERIC;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin only', DETAIL = 'not_admin';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'Marca el lugar en el mapa antes de guardar.', DETAIL = 'missing_coordinates';
  END IF;

  -- No se topea acá a propósito: el tope depende de la comisión del VIAJE, que
  -- puede ser menor en corporativo y puede cambiar mañana. Guardar el porcentaje
  -- tal cual y topear al aplicarlo (00559) evita que un cambio de comisión deje
  -- lugares con valores congelados y desalineados.
  v_pct := COALESCE(p_discount_percent, 10);
  IF v_pct <= 0 OR v_pct > 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'El descuento debe estar entre 1 y 100.', DETAIL = 'invalid_discount_percent';
  END IF;

  v_loc := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;

  IF p_id IS NULL THEN
    INSERT INTO public.partner_places (
      name, category, location, discount_percent, tagline,
      photo_url, address, municipality, province, phone, hours,
      radius_m, is_active, valid_until, created_by
    ) VALUES (
      p_name, COALESCE(p_category, 'other'), v_loc, v_pct, p_tagline,
      p_photo_url, p_address, p_municipality, p_province, p_phone, p_hours,
      COALESCE(p_radius_m, 80), COALESCE(p_is_active, true), p_valid_until, auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.partner_places SET
      name = p_name, category = COALESCE(p_category, 'other'), location = v_loc,
      discount_percent = v_pct, tagline = p_tagline,
      photo_url = p_photo_url, address = p_address,
      municipality = p_municipality, province = p_province, phone = p_phone, hours = p_hours,
      radius_m = COALESCE(p_radius_m, 80),
      is_active = COALESCE(p_is_active, true), valid_until = p_valid_until,
      updated_at = now()
    WHERE id = p_id
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_list_partner_places() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_partner_place(
  UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_nearby_partner_places(DOUBLE PRECISION, DOUBLE PRECISION, INT)
  TO authenticated;
-- Las dos de admin quedan accesibles al rol `authenticated` y se gatean adentro
-- con is_admin(): en este proyecto los admin son usuarios `authenticated`
-- comunes, no un rol de Postgres aparte.
GRANT EXECUTE ON FUNCTION public.admin_list_partner_places() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_partner_place(
  UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, NUMERIC, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, INT, BOOLEAN, TIMESTAMPTZ) TO authenticated;
