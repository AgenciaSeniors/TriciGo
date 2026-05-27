-- ============================================================
-- Migration 00330: search_streets v3 — proximity-aware ranking
--
-- WHY:
--   The 00329 RPC ranks by `(match_rank, dist)` — match rank dominates.
--   That breaks for ambiguous street names that exist in multiple
--   provinces: e.g. user in La Habana searches "Reina" →
--
--     Old ranking:
--       1. Reina (Camagüey, exact match, 497 km away) ← WRONG
--       2. Avenida Simón Bolívar (Reina) (La Habana, contains, 500 m)
--       3. Reinaldo Cruz (La Habana, contains, 4.4 km)
--
--   The exact-match street in Camagüey outranks the partial-match street
--   right next to the user. Confirmed empirically against 381,951 rows
--   in prod (see PR #251 audit). User-reported as
--   "no funciona muy bien — no se encuentran las calles cercanas".
--
-- WHAT THIS DOES:
--   Add distance buckets that DOMINATE match_rank in the ORDER BY. The
--   intuition: a partial match within walking distance beats an exact
--   match in another province almost every time.
--
--     Bucket 0: dist ≤ 25 km  (same urban area)
--     Bucket 1: dist ≤ 100 km (same metro region)
--     Bucket 2: dist ≤ 300 km (adjacent provinces)
--     Bucket 3: dist  > 300 km (faraway provinces)
--
--   Final order: distance_bucket, match_rank, dist
--
--   "Reina" search from Capitolio (23.1357, -82.3666) after this:
--     1. Avenida Simón Bolívar (Reina)  — bucket 0, rank 3, 500m
--     2. Reinaldo Cruz                  — bucket 0, rank 3, 4.4km
--     3. Reina (Camagüey)               — bucket 3, rank 0, 497km
--
--   Cross-province lookups still work: user in Camagüey searches "Reina"
--   → the Camagüey street is now in bucket 0 (close to them) → ranks
--   first as expected.
--
-- WHAT STAYS:
--   Same shape (name, address, latitude, longitude, municipality,
--   province, distance_m). Same defaults. Same trgm tolerance. Same
--   wildcard escape. Frontend reads the same fields → no client change.
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
  -- Guardrail: short query short-circuits without scanning the table.
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_norm_query := trim(query);
  -- Escape ILIKE wildcards (%, _, \) — defensive pattern from 00108
  v_escaped := replace(replace(replace(v_norm_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_limit := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);

  RETURN QUERY
  WITH matches AS (
    SELECT DISTINCT ON (si.main_street, si.municipality)
      si.main_street,
      si.cross_street_1,
      si.municipality,
      si.province,
      si.intersection_point,
      ST_Distance(si.intersection_point, v_user_point) AS dist,
      -- Match quality: exact > prefix > word-boundary contains > generic
      -- contains > trigram-only fuzzy (typo tolerance)
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
    ORDER BY si.main_street, si.municipality, dist
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
    -- 1. Distance bucket DOMINATES. A nearby partial match beats a
    --    faraway exact match almost every time — matches how a rider
    --    actually thinks about "find a street near me".
    CASE
      WHEN m.dist <= 25000  THEN 0   -- same urban area (Habana metro)
      WHEN m.dist <= 100000 THEN 1   -- same region (e.g. Habana + Matanzas)
      WHEN m.dist <= 300000 THEN 2   -- adjacent provinces
      ELSE 3                          -- faraway provinces (Camagüey from Habana)
    END,
    -- 2. Within the same distance bucket, prefer better text match
    m.match_rank,
    -- 3. Within the same match quality, prefer the closer intersection
    m.dist
  LIMIT v_limit;
END;
$$;

-- Permissions unchanged (already granted in 00329)
COMMENT ON FUNCTION public.search_streets IS
  '00330 v3 - Proximity-aware ranking. Distance buckets (25/100/300km) dominate match_rank so nearby partial matches outrank faraway exact matches. Fixes case "Reina from Habana returning Camagüey at 497km".';
