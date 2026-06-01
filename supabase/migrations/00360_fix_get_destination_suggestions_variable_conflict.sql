-- ============================================================
-- Migration 00360: fix get_destination_suggestions runtime error
--
-- WHY:
--   00359 created get_destination_suggestions with a RETURNS TABLE whose
--   OUT columns (address, latitude, longitude, score, reason, source) share
--   names with the CTE columns used inside the body. At RETURN QUERY time
--   Postgres raised:
--     ERROR: 42702 column reference "address" is ambiguous
--     DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   So the function compiled but failed on every call. Caught by live
--   end-to-end verification right after applying 00359.
--
-- FIX:
--   - Add `#variable_conflict use_column` so ambiguous names resolve to the
--     column (the idiomatic PL/pgSQL remedy for this exact error).
--   - Also qualify the final UNION ALL columns (pt.* / pp.*) so the output
--     projection is unambiguous regardless of the directive.
--
--   Body is otherwise identical to 00359. Verified live against prod for a
--   user with history (personal tier) and a low-history user (popular
--   fallback tier).
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
#variable_conflict use_column
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
    SELECT pt.address, pt.lat, pt.lng, pt.score, pt.reason, pt.source, 0 AS tier FROM personal_top pt
    UNION ALL
    SELECT pp.address, pp.lat, pp.lng, pp.score, pp.reason, pp.source, 1 AS tier FROM popular_top pp
  ) s
  ORDER BY s.tier, s.score DESC
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.get_destination_suggestions IS
  '00360 - Server-side destination suggestions (personal ride-history clustering + popular-nearby fallback). Fixes the 00359 variable/column ambiguity. Gated to the caller (or admin).';

GRANT EXECUTE ON FUNCTION public.get_destination_suggestions(uuid, double precision, double precision, integer, integer) TO authenticated;
