-- ============================================================
-- Street Intersections — Pre-computed cross-streets for all of Cuba
-- Used by reverseGeocode() for instant address resolution
-- ============================================================

CREATE TABLE IF NOT EXISTS street_intersections (
  id BIGSERIAL PRIMARY KEY,
  main_street TEXT NOT NULL,
  cross_street_1 TEXT,
  cross_street_2 TEXT,
  intersection_point GEOGRAPHY(POINT, 4326) NOT NULL,
  municipality TEXT,
  province TEXT,
  bearing SMALLINT, -- dominant bearing of main street (0-179°), for debugging
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for fast radius lookup
CREATE INDEX idx_street_intersections_geo
  ON street_intersections USING GIST(intersection_point);

-- Text index for street name lookups
CREATE INDEX idx_street_intersections_main
  ON street_intersections(main_street);

-- Enable RLS (read-only for anon)
ALTER TABLE street_intersections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "street_intersections_read"
  ON street_intersections
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- RPC for fast nearest cross-street lookup
CREATE OR REPLACE FUNCTION get_nearest_cross_streets(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_m INTEGER DEFAULT 150
)
RETURNS TABLE(
  main_street TEXT,
  cross_streets TEXT[],
  municipality TEXT,
  province TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    si.main_street,
    ARRAY_REMOVE(ARRAY[si.cross_street_1, si.cross_street_2], NULL),
    si.municipality,
    si.province
  FROM street_intersections si
  WHERE ST_DWithin(
    si.intersection_point,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_radius_m
  )
  ORDER BY ST_Distance(
    si.intersection_point,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
  )
  LIMIT 1;
$$;
