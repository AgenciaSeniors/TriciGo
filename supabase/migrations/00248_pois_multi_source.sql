-- ============================================================
-- Migration 00248: Multi-source POI sync support
--
-- Extends cuba_pois (currently OSM-only) to support Foursquare OS Places +
-- Overture Maps + admin-curated POIs in a unified table.
--
-- All changes are ADDITIVE: new columns are NULL-safe with sensible defaults,
-- existing rows are backfilled, and existing RPCs (nearest_poi) are kept for
-- backwards compatibility. Updated search_pois adds new fields to the return
-- shape (consumers ignore unknown columns).
--
-- Why: client/driver currently never invoke search_pois — see Phase 2 of the
-- POI unified search spec. This migration makes the backend ready so phases
-- A (UI) and B (sync pipeline) can land.
-- ============================================================

-- Required extensions (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ────────────────────────────────────────────────────────────
-- 1. New columns (additive, NULL-safe)
-- ────────────────────────────────────────────────────────────
ALTER TABLE cuba_pois
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'osm'
    CHECK (source IN ('admin','osm','overture','foursquare','merged')),
  ADD COLUMN IF NOT EXISTS source_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- TriciGo-unified taxonomy (hospital, paladar, etc.) alongside OSM-native category
  ADD COLUMN IF NOT EXISTS tricigo_category TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS socials JSONB,
  ADD COLUMN IF NOT EXISTS hours TEXT,
  ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),
  -- Admin-curated POIs are NEVER overwritten by sync (see merge-and-upsert.py)
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false,
  -- Closed places: marked false by sync (or admin) so search excludes them
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS province TEXT,
  ADD COLUMN IF NOT EXISTS municipality TEXT,
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ────────────────────────────────────────────────────────────
-- 2. Backfill source_ids for existing OSM rows
-- ────────────────────────────────────────────────────────────
UPDATE cuba_pois
SET source_ids = jsonb_build_object('osm', osm_type || '/' || osm_id::TEXT)
WHERE source_ids = '{}'::jsonb
  AND osm_id IS NOT NULL
  AND osm_type IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 3. Backfill municipality from existing city column
-- ────────────────────────────────────────────────────────────
UPDATE cuba_pois
SET municipality = city
WHERE municipality IS NULL
  AND city IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 4. Backfill tricigo_category from existing (category, subcategory)
--    First-pass mapping; the Foursquare/Overture sync pipeline will refine
--    this further when those rows arrive. Existing OSM rows get categorized
--    immediately so search_pois already returns useful results.
-- ────────────────────────────────────────────────────────────
UPDATE cuba_pois SET tricigo_category = CASE
  -- amenity branch (most diverse OSM category)
  WHEN category = 'amenity' AND subcategory IN ('hospital','clinic','doctors')      THEN 'hospital'
  WHEN category = 'amenity' AND subcategory = 'pharmacy'                              THEN 'pharmacy'
  WHEN category = 'amenity' AND subcategory IN ('school','university','college','kindergarten') THEN 'school'
  WHEN category = 'amenity' AND subcategory IN ('townhall','courthouse','post_office')THEN 'gov'
  WHEN category = 'amenity' AND subcategory = 'restaurant'                            THEN 'restaurant'
  WHEN category = 'amenity' AND subcategory IN ('cafe','ice_cream','fast_food')       THEN 'cafe'
  WHEN category = 'amenity' AND subcategory IN ('bar','pub','nightclub','biergarten') THEN 'bar'
  WHEN category = 'amenity' AND subcategory = 'bank'                                  THEN 'bank'
  WHEN category = 'amenity' AND subcategory = 'atm'                                   THEN 'atm'
  WHEN category = 'amenity' AND subcategory = 'fuel'                                  THEN 'gas_station'
  WHEN category = 'amenity' AND subcategory = 'place_of_worship'                      THEN 'religion'
  WHEN category = 'amenity' AND subcategory IN ('bus_station','ferry_terminal','taxi')THEN 'transport'
  WHEN category = 'amenity' AND subcategory = 'embassy'                               THEN 'embassy'
  -- tourism branch
  WHEN category = 'tourism' AND subcategory IN ('hotel','guest_house','hostel','motel','apartment') THEN 'hotel'
  WHEN category = 'tourism' AND subcategory = 'museum'                                THEN 'museum'
  WHEN category = 'tourism' AND subcategory IN ('attraction','viewpoint','artwork')   THEN 'museum'
  -- shop branch
  WHEN category = 'shop'    AND subcategory IN ('supermarket','convenience')          THEN 'supermarket'
  WHEN category = 'shop'                                                              THEN 'shop'
  -- leisure / natural
  WHEN category = 'leisure' AND subcategory = 'park'                                  THEN 'park'
  WHEN category = 'natural' AND subcategory = 'beach'                                 THEN 'beach'
  WHEN category = 'leisure'                                                           THEN 'park'
  -- transport tag (already grouped)
  WHEN category = 'transport'                                                         THEN 'transport'
  WHEN category = 'railway' AND subcategory IN ('station','halt')                     THEN 'transport'
  -- office tag
  WHEN category = 'office'  AND subcategory IN ('government','diplomatic')            THEN 'gov'
  WHEN category = 'office'                                                            THEN 'gov'
  -- noisy OSM categories that should never appear in search (kept but flagged)
  WHEN category IN ('highway','landuse','waterway','building','natural','railway','barrier','place','man_made') THEN NULL
  ELSE 'other'
END
WHERE tricigo_category IS NULL;

-- ────────────────────────────────────────────────────────────
-- 5. New indices on the added columns
-- ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cuba_pois_source           ON cuba_pois (source);
CREATE INDEX IF NOT EXISTS idx_cuba_pois_active           ON cuba_pois (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_cuba_pois_admin            ON cuba_pois (is_admin)  WHERE is_admin  = true;
CREATE INDEX IF NOT EXISTS idx_cuba_pois_tricigo_cat      ON cuba_pois (tricigo_category) WHERE is_active = true AND tricigo_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cuba_pois_municipality_act ON cuba_pois (municipality) WHERE is_active = true;

-- ────────────────────────────────────────────────────────────
-- 6. updated_at maintenance trigger
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cuba_pois_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cuba_pois_updated_at ON cuba_pois;
CREATE TRIGGER trg_cuba_pois_updated_at
  BEFORE UPDATE ON cuba_pois
  FOR EACH ROW EXECUTE FUNCTION cuba_pois_set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 7. Replace search_pois RPC with the version that:
--    - filters by is_active = true
--    - excludes noisy OSM categories (highway, landuse, etc.)
--    - prefers admin-curated and high-confidence rows
--    - returns the new fields (tricigo_category, phone, website, source, …)
--    - uses unaccent for accent-insensitive search ("paladar" finds "Paladár")
-- ────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS search_pois(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION search_pois(
  query TEXT,
  lat DOUBLE PRECISION DEFAULT 23.1136,
  lng DOUBLE PRECISION DEFAULT -82.3666,
  radius_m INTEGER DEFAULT 30000,
  max_results INTEGER DEFAULT 12
)
RETURNS TABLE(
  id BIGINT,
  name TEXT,
  category TEXT,
  subcategory TEXT,
  tricigo_category TEXT,
  address TEXT,
  municipality TEXT,
  province TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  phone TEXT,
  website TEXT,
  source TEXT,
  is_admin BOOLEAN,
  confidence REAL,
  distance_m DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
  WITH q AS (
    SELECT
      lower(unaccent(query))                       AS norm,
      '%' || lower(unaccent(query)) || '%'         AS like_pat
  )
  SELECT
    p.id,
    p.name,
    p.category,
    p.subcategory,
    p.tricigo_category,
    COALESCE(p.address, '')                                    AS address,
    COALESCE(p.municipality, p.city, '')                       AS municipality,
    COALESCE(p.province, '')                                   AS province,
    ST_Y(p.location::geometry)                                 AS latitude,
    ST_X(p.location::geometry)                                 AS longitude,
    p.phone,
    p.website,
    p.source,
    p.is_admin,
    p.confidence,
    ST_Distance(
      p.location,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
    )                                                           AS distance_m
  FROM cuba_pois p
  CROSS JOIN q
  WHERE p.is_active = true
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
      radius_m
    )
    AND (
      p.name_normalized ILIKE q.like_pat
      OR p.name ILIKE q.like_pat
    )
    -- Hide noisy OSM tags from search results (admins can override per-row via tricigo_category)
    AND p.category NOT IN ('highway','landuse','waterway','building','natural','barrier','place','man_made')
  ORDER BY
    -- Match quality first
    CASE
      WHEN p.name_normalized = q.norm                    THEN 0
      WHEN p.name_normalized ILIKE q.norm || '%'         THEN 1
      WHEN p.name ILIKE query || '%'                     THEN 2
      ELSE 3
    END,
    -- Prefer admin-curated rows (sticky overrides)
    p.is_admin DESC,
    -- Then by confidence score
    p.confidence DESC NULLS LAST,
    -- Then proximity to user
    distance_m
  LIMIT max_results;
$$;

GRANT EXECUTE ON FUNCTION search_pois(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER, INTEGER)
  TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 8. New lookup_nearest_poi RPC — richer return shape than legacy nearest_poi.
--    Used by reverseGeocode() to label dragged map pins with the POI name.
--    Legacy nearest_poi() is kept for backwards compat (returns 3 fields).
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lookup_nearest_poi(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_m INT DEFAULT 30
)
RETURNS TABLE(
  id BIGINT,
  name TEXT,
  category TEXT,
  subcategory TEXT,
  tricigo_category TEXT,
  address TEXT,
  source TEXT,
  is_admin BOOLEAN,
  distance_m DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.id,
    p.name,
    p.category,
    p.subcategory,
    p.tricigo_category,
    COALESCE(p.address, '')                                    AS address,
    p.source,
    p.is_admin,
    ST_Distance(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    )                                                          AS distance_m
  FROM cuba_pois p
  WHERE p.is_active = true
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    -- Same whitelist as legacy nearest_poi (user-recognizable POIs only)
    AND p.category IN ('amenity','shop','tourism','leisure','historic','office','transport')
  ORDER BY
    p.is_admin DESC,
    p.confidence DESC NULLS LAST,
    distance_m
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION lookup_nearest_poi(DOUBLE PRECISION, DOUBLE PRECISION, INT)
  TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────
-- 9. Admin write RLS policy (enables /admin/pois CRUD in Phase 5)
-- ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cuba_pois' AND policyname = 'cuba_pois_admin_write'
  ) THEN
    CREATE POLICY cuba_pois_admin_write ON cuba_pois
      FOR ALL
      TO authenticated
      USING (
        EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin'))
      )
      WITH CHECK (
        EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin','super_admin'))
      );
  END IF;
END $$;
