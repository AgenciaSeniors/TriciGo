-- Find intersection coordinates by street names.
-- Used by enrichWithCrossStreets() to return accurate pin coordinates
-- instead of the original Mapbox coordinates (which may point to a different street).
-- Replaces slow Overpass-based findIntersection() (~1-5s) with Supabase (~5ms).
-- Uses fuzzy ILIKE matching to handle street name prefixes (e.g. "Calle Perla" matches "Perla").

CREATE OR REPLACE FUNCTION find_intersection_point(
  p_main TEXT,
  p_cross1 TEXT,
  p_cross2 TEXT DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT 23.1136,
  p_lng DOUBLE PRECISION DEFAULT -82.3666,
  p_radius_m INTEGER DEFAULT 5000
)
RETURNS TABLE(latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, address TEXT)
LANGUAGE sql STABLE AS $$
  WITH matches AS (
    SELECT
      ST_Y(si.intersection_point::geometry) as lat,
      ST_X(si.intersection_point::geometry) as lng,
      si.main_street,
      si.cross_street_1,
      si.municipality,
      si.province,
      ST_Distance(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) as dist
    FROM street_intersections si
    WHERE ST_DWithin(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
        p_radius_m
      )
      AND (si.main_street ILIKE p_main OR si.main_street ILIKE '%' || p_main || '%')
      AND (
        si.cross_street_1 ILIKE p_cross1
        OR si.cross_street_1 ILIKE '%' || p_cross1 || '%'
        OR (p_cross2 IS NOT NULL AND (
          si.cross_street_1 ILIKE p_cross2
          OR si.cross_street_1 ILIKE '%' || p_cross2 || '%'
        ))
      )
    ORDER BY dist
    LIMIT 2
  )
  SELECT
    CASE WHEN COUNT(*) >= 2 THEN (SUM(m.lat) / 2.0) ELSE MIN(m.lat) END,
    CASE WHEN COUNT(*) >= 2 THEN (SUM(m.lng) / 2.0) ELSE MIN(m.lng) END,
    p_main
      || CASE
           WHEN p_cross2 IS NOT NULL THEN ' e/ ' || p_cross1 || ' y ' || p_cross2
           ELSE ' y ' || p_cross1
         END
      || COALESCE(', ' || (SELECT m2.municipality FROM matches m2 WHERE m2.municipality IS NOT NULL LIMIT 1), '')
      || COALESCE(', ' || (SELECT m3.province FROM matches m3 WHERE m3.province IS NOT NULL LIMIT 1), '')
  FROM matches m;
$$;
