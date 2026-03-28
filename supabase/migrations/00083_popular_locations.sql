-- ============================================================
-- Migration 00083: Popular pickup/dropoff locations
-- Aggregates completed rides into clustered popular locations
-- for smart suggestions. Refreshed daily via pg_cron.
-- ============================================================

-- Materialized view: cluster completed rides by proximity
CREATE MATERIALIZED VIEW IF NOT EXISTS popular_locations AS
WITH pickup_points AS (
  SELECT
    pickup_location AS location,
    pickup_address AS address,
    'pickup' AS type,
    created_at
  FROM rides
  WHERE status = 'completed'
    AND pickup_location IS NOT NULL
    AND created_at > NOW() - INTERVAL '90 days'
),
dropoff_points AS (
  SELECT
    dropoff_location AS location,
    dropoff_address AS address,
    'dropoff' AS type,
    created_at
  FROM rides
  WHERE status = 'completed'
    AND dropoff_location IS NOT NULL
    AND created_at > NOW() - INTERVAL '90 days'
),
all_points AS (
  SELECT * FROM pickup_points
  UNION ALL
  SELECT * FROM dropoff_points
),
clustered AS (
  SELECT
    ST_Centroid(ST_Collect(location::geometry))::geography AS location,
    mode() WITHIN GROUP (ORDER BY address) AS address,
    type,
    COUNT(*) AS ride_count,
    MAX(created_at) AS last_used
  FROM all_points
  GROUP BY
    type,
    ST_ClusterDBSCAN(location::geometry, eps := 0.001, minpoints := 3) OVER ()
)
SELECT
  ROW_NUMBER() OVER (ORDER BY ride_count DESC) AS id,
  ST_Y(location::geometry) AS latitude,
  ST_X(location::geometry) AS longitude,
  location,
  address,
  type,
  ride_count,
  last_used
FROM clustered
WHERE ride_count >= 3
ORDER BY ride_count DESC
LIMIT 100;

-- Indexes on the materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_popular_locations_id
  ON popular_locations(id);

CREATE INDEX IF NOT EXISTS idx_popular_locations_geo
  ON popular_locations USING GIST(location);

-- RPC: query nearby popular locations
CREATE OR REPLACE FUNCTION get_popular_locations(
  p_lat DOUBLE PRECISION,
  p_lng DOUBLE PRECISION,
  p_radius_m INTEGER DEFAULT 5000,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE(
  id BIGINT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  address TEXT,
  type TEXT,
  ride_count BIGINT,
  distance_m DOUBLE PRECISION
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    pl.id,
    pl.latitude,
    pl.longitude,
    pl.address,
    pl.type,
    pl.ride_count,
    ST_Distance(
      pl.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    ) AS distance_m
  FROM popular_locations pl
  WHERE ST_DWithin(
    pl.location,
    ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
    p_radius_m
  )
  ORDER BY pl.ride_count DESC
  LIMIT p_limit;
$$;

-- Schedule daily refresh at 4 AM UTC
SELECT cron.schedule(
  'refresh-popular-locations',
  '0 4 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY popular_locations'
);
