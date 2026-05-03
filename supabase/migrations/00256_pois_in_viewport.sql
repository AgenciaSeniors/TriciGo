-- ============================================================
-- Migration 00256: pois_in_viewport — zoom-aware + tricigo_category
--
-- The existing RPC (added in earlier migration) returned id/name/category/
-- subcategory/lat/lng/address/importance for a bbox + zoom_level. The
-- cliente now wants to render category emoji icons on the map (🏥 / 🍺
-- / ⛽ / etc.) so we need to surface `tricigo_category` too. Adding a
-- column requires DROP+CREATE since CREATE OR REPLACE refuses to change
-- the return type.
--
-- Behaviour kept identical:
--   - same param order: min_lng, min_lat, max_lng, max_lat, zoom_level, max_results
--   - same column names: lat, lng, importance
--   - same zoom→importance gating
--
-- Behaviour added:
--   - returns tricigo_category (nullable; older POIs predate the field)
--   - returns is_admin so the map layer can outline admin-curated rows
--   - filters out OSM noise tags (highway/landuse/building/...) which
--     should never render as map icons
--   - hard cap at 1500 markers (existing default) but the cliente will
--     pass 80–120 for mobile to keep render budget tight
-- ============================================================

DROP FUNCTION IF EXISTS pois_in_viewport(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  INTEGER, INTEGER
);

CREATE FUNCTION pois_in_viewport(
  min_lng     DOUBLE PRECISION,
  min_lat     DOUBLE PRECISION,
  max_lng     DOUBLE PRECISION,
  max_lat     DOUBLE PRECISION,
  zoom_level  INTEGER DEFAULT 13,
  max_results INTEGER DEFAULT 1500
)
RETURNS TABLE(
  id BIGINT,
  name TEXT,
  category TEXT,
  subcategory TEXT,
  tricigo_category TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  importance SMALLINT,
  is_admin BOOLEAN
)
LANGUAGE sql STABLE AS $$
  SELECT
    cp.id,
    cp.name,
    cp.category,
    cp.subcategory,
    cp.tricigo_category,
    ST_Y(cp.location::geometry) AS lat,
    ST_X(cp.location::geometry) AS lng,
    cp.address,
    cp.importance,
    cp.is_admin
  FROM cuba_pois cp
  WHERE cp.location && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
    AND cp.is_active
    AND cp.category NOT IN ('highway','landuse','waterway','building',
                            'natural','barrier','place','man_made')
    AND cp.importance <= CASE
      WHEN zoom_level >= 15 THEN 5
      WHEN zoom_level >= 14 THEN 4
      WHEN zoom_level >= 13 THEN 3
      WHEN zoom_level >= 12 THEN 2
      ELSE 1
    END
  ORDER BY cp.is_admin DESC, cp.importance, cp.id
  LIMIT max_results;
$$;

GRANT EXECUTE ON FUNCTION pois_in_viewport(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  INTEGER, INTEGER
) TO anon, authenticated, service_role;

COMMENT ON FUNCTION pois_in_viewport(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION,
  INTEGER, INTEGER
) IS
  'Returns active POIs inside a bbox, zoom-aware via importance bucket. Adds tricigo_category + is_admin so the cliente map can pick category emoji icons and outline admin-curated rows.';
