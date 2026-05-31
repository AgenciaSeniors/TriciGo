-- ============================================================
-- Migration 00359: get_destination_suggestions RPC
--
-- WHY:
--   Destination "predictions" were computed 100% client-side, with two
--   near-duplicate hooks (apps/client + apps/web) each fetching ~100 rides
--   and clustering them in JS. The driver app had no suggestions at all,
--   and there was no way to blend in global popularity for riders with
--   little history.
--
-- WHAT THIS DOES:
--   A single server-side RPC the three apps consume identically. It blends:
--     1. PERSONAL — the rider's own completed-ride dropoffs, clustered by a
--        ~111 m grid cell and scored exactly like the JS destinationPredictor
--        (frequency*2 + hourCount*5 + dayCount*3 + recencyBonus), keeping
--        only score >= 3.
--     2. POPULAR (fallback) — global completed-ride dropoffs near the rider,
--        used to fill the remaining slots when personal history is sparse.
--
--   Hour-of-day / day-of-week are evaluated in America/Havana to match the
--   device-local logic of the JS heuristic.
--
-- SELF-CONTAINED:
--   Popularity is computed directly from `rides`. The legacy
--   `popular_locations` materialized view was repurposed (now
--   usage_count/location_type/label) and is currently empty, so it is NOT
--   relied upon here.
--
-- PRIVACY:
--   SECURITY DEFINER (bypasses RLS to read rides) gated so a rider can only
--   read their OWN suggestions; admins (is_admin()) may read any.
--
-- CLIENT TOLERANCE:
--   Ships in git ahead of being applied to prod (MCP guard). The unified
--   useDestinationPredictions hook calls this RPC first and silently falls
--   back to the JS destinationPredictor heuristic when it is absent/errors.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_destination_suggestions(
  p_user_id  uuid,
  p_lat      double precision DEFAULT NULL,
  p_lng      double precision DEFAULT NULL,
  p_hour     integer          DEFAULT NULL,
  p_limit    integer          DEFAULT 5
)
RETURNS TABLE(
  address    text,
  latitude   double precision,
  longitude  double precision,
  score      double precision,
  reason     text,
  source     text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_hour  int := COALESCE(p_hour, EXTRACT(hour FROM now() AT TIME ZONE 'America/Havana')::int);
  v_dow   int := EXTRACT(dow  FROM now() AT TIME ZONE 'America/Havana')::int;
  v_limit int := GREATEST(LEAST(COALESCE(p_limit, 5), 10), 1);
BEGIN
  -- Privacy gate: caller's own suggestions only (admins may read any).
  IF p_user_id IS NULL OR NOT (COALESCE(auth.uid() = p_user_id, false) OR public.is_admin()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH personal_cells AS (
    SELECT
      count(*)                                                    AS frequency,
      count(*) FILTER (
        WHERE EXTRACT(hour FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_hour
      )                                                           AS hour_count,
      count(*) FILTER (
        WHERE EXTRACT(dow FROM r.created_at AT TIME ZONE 'America/Havana')::int = v_dow
      )                                                           AS day_count,
      max(r.created_at)                                           AS last_visited,
      avg(r.dropoff_lat)                                          AS lat,
      avg(r.dropoff_lng)                                          AS lng,
      (array_agg(r.dropoff_address ORDER BY r.created_at DESC))[1] AS addr
    FROM public.rides r
    WHERE r.customer_id = p_user_id
      AND r.status = 'completed'
      AND r.dropoff_lat IS NOT NULL
      AND r.dropoff_lng IS NOT NULL
      AND r.dropoff_address IS NOT NULL
    GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
  ),
  personal_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END)::double precision AS score,
      CASE WHEN pc.day_count >= 2 AND pc.hour_count >= 2 THEN 'time_pattern'
           WHEN pc.hour_count >= 2                       THEN 'time_pattern'
           WHEN pc.frequency  >= 3                       THEN 'frequent'
           ELSE 'recent' END AS reason,
      'personal'::text AS source
    FROM personal_cells pc
    WHERE (pc.frequency * 2 + pc.hour_count * 5 + pc.day_count * 3
        + CASE WHEN pc.last_visited >= now() - interval '7 days'  THEN 3
               WHEN pc.last_visited >= now() - interval '30 days' THEN 1
               ELSE 0 END) >= 3
    ORDER BY score DESC
    LIMIT v_limit
  ),
  popular_top AS (
    SELECT
      pc.addr AS address,
      pc.lat,
      pc.lng,
      pc.frequency::double precision AS score,
      'popular'::text AS reason,
      'popular'::text AS source
    FROM (
      SELECT
        (array_agg(r.dropoff_address ORDER BY r.created_at DESC))[1] AS addr,
        avg(r.dropoff_lat) AS lat,
        avg(r.dropoff_lng) AS lng,
        count(*)           AS frequency
      FROM public.rides r
      WHERE r.status = 'completed'
        AND r.created_at >= now() - interval '90 days'
        AND r.dropoff_lat IS NOT NULL
        AND r.dropoff_lng IS NOT NULL
        AND r.dropoff_address IS NOT NULL
        AND (
          p_lat IS NULL OR p_lng IS NULL
          OR ST_DWithin(
               r.dropoff_location,
               ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
               15000
             )
        )
      GROUP BY round(r.dropoff_lat::numeric, 3), round(r.dropoff_lng::numeric, 3)
      HAVING count(*) >= 3
    ) pc
    -- Don't repeat a destination the rider already gets as a personal hit.
    WHERE NOT EXISTS (
      SELECT 1 FROM personal_top pt
      WHERE abs(pt.lat - pc.lat) < 0.0015
        AND abs(pt.lng - pc.lng) < 0.0015
    )
    ORDER BY pc.frequency DESC
    LIMIT v_limit
  )
  SELECT s.address, s.lat AS latitude, s.lng AS longitude, s.score, s.reason, s.source
  FROM (
    SELECT address, lat, lng, score, reason, source, 0 AS tier FROM personal_top
    UNION ALL
    SELECT address, lat, lng, score, reason, source, 1 AS tier FROM popular_top
  ) s
  ORDER BY s.tier, s.score DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.get_destination_suggestions IS
  '00359 - Server-side destination suggestions: personal ride-history clustering (freq/hour/day/recency, mirrors destinationPredictor) + global popular-nearby fallback computed from rides. Gated to the caller (or admin).';

GRANT EXECUTE ON FUNCTION public.get_destination_suggestions(uuid, double precision, double precision, integer, integer) TO authenticated;
