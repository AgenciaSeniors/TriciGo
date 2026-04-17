-- ============================================================
-- Migration 00125: Demand hotspots for driver map
--
-- Gives the driver app a server-side endpoint that returns the top 8
-- "hot" zones in their radius. Score combines:
--   - Historical pattern: rides in the same dow+hour bucket averaged
--     over the last 28 days (cached in a materialized view).
--   - Live pressure: rides in status='searching' in the last 10 min
--     clustered with ST_ClusterDBSCAN.
--
-- Composite intensity = 0.5 * historical_norm + 0.5 * live_norm.
-- ============================================================

-- ---- 1. Materialized view: hourly demand cells ----
-- ~500m grid (0.005 deg ≈ 550m lat / 510m lng at Havana).
DROP MATERIALIZED VIEW IF EXISTS hourly_demand_cells;
CREATE MATERIALIZED VIEW hourly_demand_cells AS
SELECT
  ST_SnapToGrid(pickup_location::geometry, 0.005) AS cell_geom,
  EXTRACT(DOW FROM created_at)::int  AS dow,
  EXTRACT(HOUR FROM created_at)::int AS hour,
  count(*)                          AS ride_count,
  ST_Centroid(ST_Collect(pickup_location::geometry))::geometry AS center_geom
FROM rides
WHERE created_at > now() - interval '28 days'
  AND status IS DISTINCT FROM 'canceled'
GROUP BY cell_geom, dow, hour
HAVING count(*) >= 3;

CREATE UNIQUE INDEX hourly_demand_cells_uniq_idx
  ON hourly_demand_cells (cell_geom, dow, hour);
CREATE INDEX hourly_demand_cells_gist_idx
  ON hourly_demand_cells USING GIST (cell_geom);
CREATE INDEX hourly_demand_cells_dow_hour_idx
  ON hourly_demand_cells (dow, hour);

-- ---- 2. Refresh cron (hourly at :15) ----
DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'refresh-hourly-demand-cells';
  IF v_jobid IS NOT NULL THEN PERFORM cron.unschedule(v_jobid); END IF;
END $$;

SELECT cron.schedule(
  'refresh-hourly-demand-cells',
  '15 * * * *',
  $cron$REFRESH MATERIALIZED VIEW CONCURRENTLY hourly_demand_cells;$cron$
);

-- ---- 3. RPC: get_demand_hotspots ----
DROP FUNCTION IF EXISTS public.get_demand_hotspots(double precision, double precision, integer);

CREATE OR REPLACE FUNCTION public.get_demand_hotspots(
  p_lat       double precision,
  p_lng       double precision,
  p_radius_m  integer DEFAULT 5000
) RETURNS TABLE (
  id                       text,
  lat                      double precision,
  lng                      double precision,
  intensity                double precision,
  live_rides_count         integer,
  historical_rides_count   integer
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
WITH
  center AS (
    SELECT
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography AS geog,
      EXTRACT(DOW FROM now())::int  AS dow,
      EXTRACT(HOUR FROM now())::int AS hour
  ),
  -- Historical cells for current hour-of-week inside radius
  hist AS (
    SELECT
      hdc.center_geom,
      hdc.ride_count AS hist_count
    FROM hourly_demand_cells hdc, center c
    WHERE hdc.dow = c.dow AND hdc.hour = c.hour
      AND ST_DWithin(hdc.center_geom::geography, c.geog, p_radius_m)
  ),
  -- Live searching rides inside radius
  live_raw AS (
    SELECT r.pickup_location::geometry AS g
    FROM rides r, center c
    WHERE r.status = 'searching'
      AND r.created_at > now() - interval '10 minutes'
      AND ST_DWithin(r.pickup_location, c.geog, p_radius_m)
  ),
  live_clustered AS (
    SELECT g, ST_ClusterDBSCAN(g, eps := 0.005, minpoints := 2) OVER () AS cid
    FROM live_raw
  ),
  live_agg AS (
    SELECT
      ST_Centroid(ST_Collect(g))::geometry AS center_geom,
      count(*)::int                        AS live_count
    FROM live_clustered
    WHERE cid IS NOT NULL
    GROUP BY cid
  ),
  -- Merge historical and live points. A single source may produce one
  -- row; merging happens via a second DBSCAN pass below.
  unioned AS (
    SELECT center_geom, hist_count, 0::int AS live_count FROM hist
    UNION ALL
    SELECT center_geom, 0::int AS hist_count, live_count FROM live_agg
  ),
  merged_raw AS (
    SELECT
      center_geom,
      hist_count,
      live_count,
      ST_ClusterDBSCAN(center_geom, eps := 0.006, minpoints := 1) OVER () AS mid
    FROM unioned
  ),
  merged AS (
    SELECT
      gen_random_uuid()::text AS id,
      ST_Y(ST_Centroid(ST_Collect(center_geom)))::double precision AS lat,
      ST_X(ST_Centroid(ST_Collect(center_geom)))::double precision AS lng,
      sum(hist_count)::int AS hist_count,
      sum(live_count)::int AS live_count
    FROM merged_raw
    WHERE mid IS NOT NULL
    GROUP BY mid
  ),
  -- Normalization bases (at least 1 to avoid div by zero)
  maxes AS (
    SELECT
      GREATEST(max(hist_count), 1) AS max_hist,
      GREATEST(max(live_count), 1) AS max_live
    FROM merged
  )
SELECT
  m.id,
  m.lat,
  m.lng,
  LEAST(
    1.0,
    0.5 * (m.hist_count::double precision / mx.max_hist)
    + 0.5 * (m.live_count::double precision / mx.max_live)
  ) AS intensity,
  m.live_count        AS live_rides_count,
  m.hist_count        AS historical_rides_count
FROM merged m, maxes mx
WHERE m.hist_count + m.live_count > 0
ORDER BY intensity DESC
LIMIT 8;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_demand_hotspots(double precision, double precision, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_demand_hotspots(double precision, double precision, integer) TO authenticated;
