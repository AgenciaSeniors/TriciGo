-- ============================================================
-- Fix get_nearest_cross_streets to return 2 cross-streets
-- instead of 1, enabling the Cuban address format:
-- "Retiro e/ Santa Marta y Clavel, D'Beche, La Habana"
--
-- Algorithm: find the street that appears in the 2 closest
-- intersections to the pin = main street. Return both cross-streets.
-- ============================================================

CREATE OR REPLACE FUNCTION get_nearest_cross_streets(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_m INTEGER DEFAULT 200
)
RETURNS TABLE(
  main_street TEXT,
  cross_streets TEXT[],
  municipality TEXT,
  province TEXT
)
LANGUAGE sql STABLE AS $$
  WITH nearby AS (
    -- Deduplicate: one row per (main_street, cross_street_1) pair, closest distance
    SELECT DISTINCT ON (si.main_street, si.cross_street_1)
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
    ORDER BY si.main_street, si.cross_street_1, dist
  ),
  -- The street with 2+ nearby intersections AND closest min distance = main street
  street_rank AS (
    SELECT n.main_street, COUNT(*) as cnt, MIN(n.dist) as min_dist
    FROM nearby n
    GROUP BY n.main_street
    HAVING COUNT(*) >= 2
    ORDER BY min_dist ASC, cnt DESC
    LIMIT 1
  ),
  -- Get the 2 closest cross-streets for the main street
  crosses AS (
    SELECT n.cross_street_1, n.municipality, n.province, n.dist
    FROM nearby n
    JOIN street_rank sr ON n.main_street = sr.main_street
    ORDER BY n.dist
    LIMIT 2
  )
  SELECT
    sr.main_street,
    (SELECT array_agg(c.cross_street_1 ORDER BY c.dist) FROM crosses c),
    (SELECT c.municipality FROM crosses c ORDER BY c.dist LIMIT 1),
    (SELECT c.province FROM crosses c ORDER BY c.dist LIMIT 1)
  FROM street_rank sr;
$$;
