-- Full-text POI search with spatial filtering.
-- Called by searchPoisSupabase() in geo.ts.
-- Uses name_normalized for accent-insensitive matching + ILIKE for fuzzy search.

CREATE OR REPLACE FUNCTION search_pois(
  query TEXT,
  lat DOUBLE PRECISION DEFAULT 23.1136,
  lng DOUBLE PRECISION DEFAULT -82.3666,
  radius_m INTEGER DEFAULT 30000,
  max_results INTEGER DEFAULT 10
)
RETURNS TABLE(
  name TEXT,
  address TEXT,
  neighborhood TEXT,
  city TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  category TEXT,
  subcategory TEXT,
  distance_m DOUBLE PRECISION
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.name,
    COALESCE(p.address, '') as address,
    COALESCE(p.neighborhood, '') as neighborhood,
    COALESCE(p.city, '') as city,
    ST_Y(p.location::geometry) as latitude,
    ST_X(p.location::geometry) as longitude,
    p.category,
    p.subcategory,
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) as distance_m
  FROM cuba_pois p
  WHERE ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_m)
    AND (
      p.name ILIKE '%' || query || '%'
      OR p.name_normalized ILIKE '%' || query || '%'
      OR p.address ILIKE '%' || query || '%'
    )
  ORDER BY
    CASE WHEN p.name ILIKE query THEN 0
         WHEN p.name ILIKE query || '%' THEN 1
         WHEN p.name_normalized ILIKE query || '%' THEN 2
         WHEN p.name ILIKE '%' || query || '%' THEN 3
         ELSE 4
    END,
    distance_m
  LIMIT max_results;
$$;
