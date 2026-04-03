-- Suggest cross-streets for a given main street within a radius.
-- Used by suggestCrossStreetsSupabase() for Cuban address autocomplete.
-- Replaces slow Overpass-based suggestCrossStreets() (~1-5s) with Supabase (~5ms).

CREATE OR REPLACE FUNCTION suggest_cross_streets(
  p_main TEXT,
  p_lat DOUBLE PRECISION DEFAULT 23.1136,
  p_lng DOUBLE PRECISION DEFAULT -82.3666,
  p_radius_m INTEGER DEFAULT 3000
)
RETURNS TABLE(cross_street TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT si.cross_street_1
  FROM street_intersections si
  WHERE ST_DWithin(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    AND (si.main_street ILIKE p_main OR si.main_street ILIKE '%' || p_main || '%')
  ORDER BY si.cross_street_1
  LIMIT 10;
$$;
