-- ============================================================
-- Migration 00249: Admin RPCs for POI CRUD
--
-- Phase 5 of the unified POI search spec — adds the RPCs the admin
-- panel needs:
--   • admin_list_pois(...)   — paginated list with filters + lat/lng
--   • admin_get_poi(id)      — single row with lat/lng
--   • admin_create_poi(...)  — insert from lat/lng (server builds the
--                              GEOGRAPHY value, no client SQL)
--   • admin_update_poi(...)  — partial update; flips is_admin=true
--                              so sync stops touching the row
--
-- Why RPCs instead of direct table access:
--   • cuba_pois.location is GEOGRAPHY(POINT,4326). PostgREST can return
--     it as GeoJSON, but extracting lat/lng on the client is awkward and
--     the existing search_pois / lookup_nearest_poi RPCs already use
--     ST_X / ST_Y server-side. Keeping the same pattern here.
--   • The RPCs encapsulate the rule "admin edits flip is_admin=true",
--     so the admin app can't accidentally forget to set the flag.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. admin_list_pois
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_list_pois(
  p_search        TEXT    DEFAULT NULL,
  p_category      TEXT    DEFAULT NULL,
  p_source        TEXT    DEFAULT NULL,
  p_municipality  TEXT    DEFAULT NULL,
  p_only_admin    BOOLEAN DEFAULT FALSE,
  p_only_active   BOOLEAN DEFAULT TRUE,
  p_page          INT     DEFAULT 0,
  p_page_size     INT     DEFAULT 50
)
RETURNS TABLE(
  id                BIGINT,
  name              TEXT,
  category          TEXT,
  subcategory       TEXT,
  tricigo_category  TEXT,
  address           TEXT,
  municipality      TEXT,
  province          TEXT,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  source            TEXT,
  source_ids        JSONB,
  phone             TEXT,
  website           TEXT,
  socials           JSONB,
  hours             TEXT,
  confidence        REAL,
  is_admin          BOOLEAN,
  is_active         BOOLEAN,
  importance        SMALLINT,
  synced_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ,
  total_count       BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_search_pat TEXT;
BEGIN
  -- Authorize: only admins can list (mirrors RLS but explicit so the
  -- function fails fast if a non-admin somehow gets the EXECUTE grant)
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  v_search_pat := CASE
    WHEN p_search IS NULL OR length(trim(p_search)) < 2 THEN NULL
    ELSE '%' || lower(unaccent(p_search)) || '%'
  END;

  RETURN QUERY
  WITH filtered AS (
    SELECT
      p.id, p.name, p.category, p.subcategory, p.tricigo_category,
      p.address, p.municipality, p.province,
      ST_Y(p.location::geometry) AS latitude,
      ST_X(p.location::geometry) AS longitude,
      p.source, p.source_ids,
      p.phone, p.website, p.socials, p.hours,
      p.confidence, p.is_admin, p.is_active, p.importance,
      p.synced_at, p.updated_at
    FROM cuba_pois p
    WHERE
      (NOT p_only_active OR p.is_active = TRUE)
      AND (NOT p_only_admin OR p.is_admin = TRUE)
      AND (p_category     IS NULL OR p.tricigo_category = p_category)
      AND (p_source       IS NULL OR p.source           = p_source)
      AND (p_municipality IS NULL OR p.municipality     = p_municipality)
      AND (
        v_search_pat IS NULL
        OR p.name_normalized ILIKE v_search_pat
        OR p.name            ILIKE v_search_pat
      )
  ),
  counted AS (
    SELECT COUNT(*) AS total FROM filtered
  )
  SELECT
    f.id, f.name, f.category, f.subcategory, f.tricigo_category,
    f.address, f.municipality, f.province,
    f.latitude, f.longitude,
    f.source, f.source_ids,
    f.phone, f.website, f.socials, f.hours,
    f.confidence, f.is_admin, f.is_active, f.importance,
    f.synced_at, f.updated_at,
    counted.total
  FROM filtered f
  CROSS JOIN counted
  ORDER BY f.updated_at DESC
  OFFSET (p_page * p_page_size)
  LIMIT  p_page_size;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_list_pois(TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, INT, INT)
  TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 2. admin_get_poi
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_get_poi(p_id BIGINT)
RETURNS TABLE(
  id                BIGINT,
  name              TEXT,
  category          TEXT,
  subcategory       TEXT,
  tricigo_category  TEXT,
  address           TEXT,
  municipality      TEXT,
  province          TEXT,
  latitude          DOUBLE PRECISION,
  longitude         DOUBLE PRECISION,
  source            TEXT,
  source_ids        JSONB,
  phone             TEXT,
  website           TEXT,
  socials           JSONB,
  hours             TEXT,
  confidence        REAL,
  is_admin          BOOLEAN,
  is_active         BOOLEAN,
  importance        SMALLINT,
  synced_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.name, p.category, p.subcategory, p.tricigo_category,
    p.address, p.municipality, p.province,
    ST_Y(p.location::geometry) AS latitude,
    ST_X(p.location::geometry) AS longitude,
    p.source, p.source_ids,
    p.phone, p.website, p.socials, p.hours,
    p.confidence, p.is_admin, p.is_active, p.importance,
    p.synced_at, p.updated_at
  FROM cuba_pois p
  WHERE p.id = p_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_get_poi(BIGINT) TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 3. admin_create_poi
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_create_poi(
  p_name              TEXT,
  p_tricigo_category  TEXT,
  p_lat               DOUBLE PRECISION,
  p_lng               DOUBLE PRECISION,
  p_address           TEXT DEFAULT NULL,
  p_municipality      TEXT DEFAULT NULL,
  p_province          TEXT DEFAULT NULL,
  p_phone             TEXT DEFAULT NULL,
  p_website           TEXT DEFAULT NULL,
  p_hours             TEXT DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id BIGINT;
  v_name_norm TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  IF length(trim(coalesce(p_name, ''))) = 0 THEN
    RAISE EXCEPTION 'name is required';
  END IF;
  IF p_lat IS NULL OR p_lng IS NULL THEN
    RAISE EXCEPTION 'lat/lng are required';
  END IF;
  IF p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RAISE EXCEPTION 'lat/lng out of valid range';
  END IF;

  v_name_norm := lower(unaccent(trim(p_name)));

  INSERT INTO cuba_pois (
    name, name_normalized,
    category, subcategory, tricigo_category,
    address, city, municipality, province,
    location, source, source_ids,
    phone, website, hours,
    confidence, is_admin, is_active,
    tags
  ) VALUES (
    trim(p_name), v_name_norm,
    'admin', p_tricigo_category, p_tricigo_category,
    nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_municipality, '')), ''),
    nullif(trim(coalesce(p_municipality, '')), ''),
    nullif(trim(coalesce(p_province, '')), ''),
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    'admin', '{}'::jsonb,
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_website, '')), ''),
    nullif(trim(coalesce(p_hours, '')), ''),
    1.0, TRUE, TRUE,
    '{}'::jsonb
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_create_poi(TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

-- ────────────────────────────────────────────────────────────
-- 4. admin_update_poi  (partial update — pass NULL to leave unchanged)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION admin_update_poi(
  p_id                BIGINT,
  p_name              TEXT DEFAULT NULL,
  p_tricigo_category  TEXT DEFAULT NULL,
  p_lat               DOUBLE PRECISION DEFAULT NULL,
  p_lng               DOUBLE PRECISION DEFAULT NULL,
  p_address           TEXT DEFAULT NULL,
  p_municipality      TEXT DEFAULT NULL,
  p_province          TEXT DEFAULT NULL,
  p_phone             TEXT DEFAULT NULL,
  p_website           TEXT DEFAULT NULL,
  p_hours             TEXT DEFAULT NULL,
  p_is_active         BOOLEAN DEFAULT NULL,
  p_unlock_for_sync   BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid() AND role IN ('admin','super_admin')
  ) THEN
    RAISE EXCEPTION 'forbidden: admin role required';
  END IF;

  UPDATE cuba_pois
  SET
    name             = COALESCE(NULLIF(trim(p_name), ''), name),
    name_normalized  = CASE
                         WHEN p_name IS NOT NULL AND length(trim(p_name)) > 0
                         THEN lower(unaccent(trim(p_name)))
                         ELSE name_normalized
                       END,
    tricigo_category = COALESCE(p_tricigo_category, tricigo_category),
    subcategory      = COALESCE(p_tricigo_category, subcategory),
    address          = CASE WHEN p_address IS NULL THEN address ELSE NULLIF(trim(p_address), '') END,
    city             = CASE WHEN p_municipality IS NULL THEN city ELSE NULLIF(trim(p_municipality), '') END,
    municipality     = CASE WHEN p_municipality IS NULL THEN municipality ELSE NULLIF(trim(p_municipality), '') END,
    province         = CASE WHEN p_province IS NULL THEN province ELSE NULLIF(trim(p_province), '') END,
    phone            = CASE WHEN p_phone IS NULL THEN phone ELSE NULLIF(trim(p_phone), '') END,
    website          = CASE WHEN p_website IS NULL THEN website ELSE NULLIF(trim(p_website), '') END,
    hours            = CASE WHEN p_hours IS NULL THEN hours ELSE NULLIF(trim(p_hours), '') END,
    location         = CASE
                         WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL
                         THEN ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
                         ELSE location
                       END,
    is_active        = COALESCE(p_is_active, is_active),
    -- Touching anything via this RPC marks the row admin-curated UNLESS
    -- the caller asks to unlock it (the next sync will then refresh).
    is_admin         = CASE WHEN p_unlock_for_sync THEN FALSE ELSE TRUE END,
    updated_at       = NOW()
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'POI % not found', p_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_poi(BIGINT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN)
  TO authenticated;
