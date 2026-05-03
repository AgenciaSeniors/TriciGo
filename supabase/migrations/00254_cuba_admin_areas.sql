-- ============================================================
-- Migration 00254: cuba_admin_areas table + spatial backfill of cuba_pois
--
-- 104,157 of the 104,365 POIs ended up with NULL `province` after the
-- multi-source sync because neither OSM nor Overture populate Cuban
-- provincia/municipio fields consistently. The admin /pois filter
-- relies on those columns; without them the dropdown is useless.
--
-- This migration:
--   1. Creates `cuba_admin_areas` to hold authoritative admin-level
--      polygons (16 provincias / 168 municipios) sourced from OSM
--      relations admin_level=4 / admin_level=6, fetched via Overpass.
--   2. Loads polygon data from a separate companion file
--      (00254a_cuba_admin_areas_data.sql) — 7MB of INSERTs.
--   3. Derives `parent_province_iso` for each municipio via spatial
--      ST_Contains against the provincia polygons.
--   4. Backfills cuba_pois.province + cuba_pois.municipality from
--      the polygons via spatial JOIN.
--
-- Idempotent: re-running drops/recreates `cuba_admin_areas` and
-- re-derives the backfill. Existing admin-curated rows in cuba_pois
-- (is_admin=true) are NEVER touched.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ────────────────────────────────────────────────────────────
-- 1. Schema for admin areas (provincias + municipios)
-- ────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS cuba_admin_areas CASCADE;

CREATE TABLE cuba_admin_areas (
  id                    BIGSERIAL PRIMARY KEY,
  osm_id                BIGINT NOT NULL UNIQUE,
  admin_level           INT    NOT NULL CHECK (admin_level IN (4, 6)),
  name                  TEXT   NOT NULL,
  name_es               TEXT,
  iso_code              TEXT,        -- 'CU-XX' for provincias, NULL for municipios
  parent_province_iso   TEXT,        -- backfilled below for admin_level=6
  geom                  GEOMETRY NOT NULL,  -- POLYGON or MULTIPOLYGON, SRID 4326
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cuba_admin_areas_geom        ON cuba_admin_areas USING gist (geom);
CREATE INDEX idx_cuba_admin_areas_admin_level ON cuba_admin_areas (admin_level);
CREATE INDEX idx_cuba_admin_areas_iso_code    ON cuba_admin_areas (iso_code) WHERE iso_code IS NOT NULL;
CREATE INDEX idx_cuba_admin_areas_parent_iso  ON cuba_admin_areas (parent_province_iso) WHERE parent_province_iso IS NOT NULL;

ALTER TABLE cuba_admin_areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY cuba_admin_areas_read ON cuba_admin_areas FOR SELECT USING (true);

COMMENT ON TABLE cuba_admin_areas IS
  'Cuba admin polygons from OSM (admin_level=4 provincias, admin_level=6 municipios). Used for spatial reverse-geocoding of cuba_pois.';

-- ────────────────────────────────────────────────────────────
-- 2. Data load lives in a separate file because the WKT POLYGONs
--    push the migration to ~7MB. Run AFTER this migration, before
--    section 3:
--      psql ... -f supabase/migrations/00254a_cuba_admin_areas_data.sql
--    or via Supabase MCP execute_sql split into chunks.
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 3. Section to run AFTER the data load:
--    a) Derive parent_province_iso for municipios
--    b) Backfill cuba_pois.province + municipality
--    c) Verify counts
--
--    Wrapped as a function so it's a single re-runnable unit.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION run_cuba_admin_backfill()
RETURNS TABLE(step TEXT, rows_affected BIGINT) AS $$
DECLARE
  v_n BIGINT;
BEGIN
  -- 3a. Each municipio gets its parent provincia ISO via point-in-polygon
  -- of the municipio centroid against the provincia polygons.
  UPDATE cuba_admin_areas m
  SET parent_province_iso = p.iso_code
  FROM cuba_admin_areas p
  WHERE m.admin_level = 6
    AND p.admin_level = 4
    AND ST_Contains(p.geom, ST_Centroid(m.geom));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  step := 'municipios linked to provincia';
  rows_affected := v_n;
  RETURN NEXT;

  -- 3b. Backfill cuba_pois.province + municipality from the polygons.
  -- Uses ST_Contains on cuba_pois.location (geography → cast to geometry
  -- for the spatial test). Only updates rows that don't already have a
  -- province/municipality set (preserves admin manual edits + earlier
  -- data from Overture). Never touches is_admin=true rows.
  WITH point_to_municipio AS (
    SELECT p.id AS poi_id,
           m.name_es AS municipio,
           m.parent_province_iso AS prov_iso
    FROM cuba_pois p
    JOIN cuba_admin_areas m ON m.admin_level = 6
                            AND ST_Contains(m.geom, p.location::geometry)
    WHERE NOT p.is_admin
  ),
  point_to_province AS (
    -- Fall back to provincia-only when the POI sits in a provincia but
    -- not in any municipio (e.g. parks, water, special zones).
    SELECT p.id AS poi_id,
           pr.iso_code AS prov_iso,
           pr.name_es AS province
    FROM cuba_pois p
    JOIN cuba_admin_areas pr ON pr.admin_level = 4
                             AND ST_Contains(pr.geom, p.location::geometry)
    LEFT JOIN point_to_municipio m ON m.poi_id = p.id
    WHERE NOT p.is_admin AND m.poi_id IS NULL
  )
  UPDATE cuba_pois p
  SET municipality = COALESCE(p.municipality, src.municipality),
      province     = COALESCE(p.province, src.province)
  FROM (
    SELECT poi_id,
           municipio AS municipality,
           (SELECT name_es FROM cuba_admin_areas WHERE iso_code = pm.prov_iso AND admin_level = 4) AS province
    FROM point_to_municipio pm
    UNION ALL
    SELECT poi_id, NULL AS municipality, province
    FROM point_to_province
  ) src
  WHERE p.id = src.poi_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  step := 'cuba_pois rows backfilled';
  rows_affected := v_n;
  RETURN NEXT;

  -- 3c. Stats
  SELECT COUNT(*) INTO v_n FROM cuba_pois WHERE province IS NULL;
  step := 'cuba_pois with NULL province after backfill';
  rows_affected := v_n;
  RETURN NEXT;

  SELECT COUNT(*) INTO v_n FROM cuba_pois WHERE municipality IS NULL;
  step := 'cuba_pois with NULL municipality after backfill';
  rows_affected := v_n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION run_cuba_admin_backfill() IS
  'Run after loading cuba_admin_areas data. Derives municipio→provincia link, then backfills cuba_pois.province/municipality via ST_Contains. Returns step-by-step row counts.';
