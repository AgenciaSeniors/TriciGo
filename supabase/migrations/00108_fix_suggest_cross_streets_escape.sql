-- Fix: Escape special LIKE characters (%, _, \) in suggest_cross_streets input
-- to prevent SQL injection via ILIKE pattern matching.

CREATE OR REPLACE FUNCTION suggest_cross_streets(
  p_main TEXT,
  p_lat DOUBLE PRECISION DEFAULT 23.1136,
  p_lng DOUBLE PRECISION DEFAULT -82.3666,
  p_radius_m INTEGER DEFAULT 3000
)
RETURNS TABLE(cross_street TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_escaped TEXT;
BEGIN
  -- Escape special LIKE characters before using in ILIKE pattern
  v_escaped := replace(replace(replace(p_main, '\', '\\'), '%', '\%'), '_', '\_');

  RETURN QUERY
  SELECT DISTINCT si.cross_street_1
  FROM street_intersections si
  WHERE ST_DWithin(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    AND (si.main_street ILIKE v_escaped OR si.main_street ILIKE '%' || v_escaped || '%')
  ORDER BY si.cross_street_1
  LIMIT 10;
END;
$$;
