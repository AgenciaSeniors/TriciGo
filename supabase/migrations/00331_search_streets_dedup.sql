-- ============================================================
-- Migration 00331: search_streets v4 — dedup by main_street only
--
-- WHY:
--   00330's smoke against prod revealed duplicate rows in the dropdown:
--
--     query "Galiano" from Capitolio →
--       1. Avenida de Italia (Galiano)  municipality=Cojimar    400m
--       2. Galiano                      municipality=Cojimar    700m
--       3. Galiano                      municipality=Dragones   700m  ← duplicate of #2
--
--   Same street name, same physical intersection, but OSM tagged it with
--   two different `municipality` strings (Cojimar + Dragones). With
--   `DISTINCT ON (main_street, municipality)` both survive — wasting two
--   slots of the 5-7 row dropdown on the same street.
--
-- WHAT THIS DOES:
--   Drop municipality from the DISTINCT ON: now `DISTINCT ON (main_street)`
--   so each unique street name appears EXACTLY ONCE in results. The
--   ORDER BY clause inside the CTE already picks the closest intersection
--   per street, so the row that survives is the most useful one.
--
-- CROSS-PROVINCE TRADE-OFF:
--   "Calle 23" exists in Habana, Cienfuegos, Camagüey, etc. With this
--   change, only the closest one (by distance bucket) appears. This is
--   the intended UX: dropdown shows "the street near you", not "every
--   street with this name in Cuba". The proximity-aware ranking from
--   00330 ensures the right one shows up for each user location.
--
-- WHAT STAYS:
--   - Same shape (name, address, latitude, longitude, municipality,
--     province, distance_m)
--   - Same trigram tolerance
--   - Same wildcard escape
--   - Same proximity buckets (25/100/300 km)
-- ============================================================

CREATE OR REPLACE FUNCTION public.search_streets(
  query        TEXT,
  lat          DOUBLE PRECISION DEFAULT 23.1136,
  lng          DOUBLE PRECISION DEFAULT -82.3666,
  max_results  INTEGER          DEFAULT 10
)
RETURNS TABLE(
  name          TEXT,
  address       TEXT,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  municipality  TEXT,
  province      TEXT,
  distance_m    DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_user_point  GEOGRAPHY(POINT, 4326);
  v_norm_query  TEXT;
  v_escaped     TEXT;
  v_limit       INTEGER;
BEGIN
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_norm_query := trim(query);
  v_escaped := replace(replace(replace(v_norm_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);

  RETURN QUERY
  WITH matches AS (
    -- DISTINCT ON main_street only — one row per unique street name.
    -- The inner ORDER BY picks the closest intersection on that street
    -- so the surviving row is the most useful one for this user.
    SELECT DISTINCT ON (si.main_street)
      si.main_street,
      si.cross_street_1,
      si.municipality,
      si.province,
      si.intersection_point,
      ST_Distance(si.intersection_point, v_user_point) AS dist,
      CASE
        WHEN si.main_street ILIKE v_escaped THEN 0
        WHEN si.main_street ILIKE v_escaped || '%' THEN 1
        WHEN si.main_street ILIKE '% ' || v_escaped || '%' THEN 2
        WHEN si.main_street ILIKE '%' || v_escaped || '%' THEN 3
        ELSE 4
      END AS match_rank
    FROM public.street_intersections si
    WHERE si.main_street ILIKE '%' || v_escaped || '%'
       OR similarity(si.main_street, v_norm_query) > 0.30
    ORDER BY si.main_street, ST_Distance(si.intersection_point, v_user_point) ASC
  )
  SELECT
    m.main_street AS name,
    m.main_street || COALESCE(' e/ ' || m.cross_street_1, '') AS address,
    ST_Y(m.intersection_point::geometry) AS latitude,
    ST_X(m.intersection_point::geometry) AS longitude,
    COALESCE(m.municipality, '') AS municipality,
    COALESCE(m.province, '') AS province,
    m.dist AS distance_m
  FROM matches m
  ORDER BY
    -- Distance bucket dominates (carried from 00330)
    CASE
      WHEN m.dist <= 25000  THEN 0
      WHEN m.dist <= 100000 THEN 1
      WHEN m.dist <= 300000 THEN 2
      ELSE 3
    END,
    m.match_rank,
    m.dist
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.search_streets IS
  '00331 v4 - Dedup by main_street only (one row per unique street name). Combined with proximity-aware ranking from 00330. Fixes duplicate rows when OSM tagged the same street under multiple municipality strings.';
