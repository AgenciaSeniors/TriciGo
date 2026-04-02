-- Reverse POI lookup: find the nearest named POI within a radius.
-- Used by reverseGeocode() to include POI names in address output.
-- Only returns user-recognizable POIs (excludes highways, bus stops, etc.)

CREATE OR REPLACE FUNCTION nearest_poi(
  p_lat double precision,
  p_lng double precision,
  p_radius_m int DEFAULT 30
)
RETURNS TABLE(name text, category text, distance_m double precision)
LANGUAGE sql STABLE AS $$
  SELECT p.name, p.category,
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) as distance_m
  FROM cuba_pois p
  WHERE ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, p_radius_m)
    AND p.category IN ('amenity', 'shop', 'tourism', 'leisure', 'historic', 'healthcare', 'office', 'sport', 'craft', 'aeroway', 'emergency')
  ORDER BY distance_m
  LIMIT 1;
$$;
