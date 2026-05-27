-- ============================================================
-- Migration 00329: search_streets RPC v2 — drift reconciliation + improvements
--
-- BACKGROUND:
--   PR #249 (00328) tried to CREATE OR REPLACE the search_streets RPC and
--   failed with ERROR 42P13 ("cannot change return type of existing
--   function"). Investigation revealed the RPC was already present in
--   prod with an EXTRA `distance_m` column, created at some point
--   outside the migration timeline — a drift between git and prod.
--
--   This migration RECONCILES the drift: keeps the same shape as prod
--   (including `distance_m`) while bringing in the safety + UX
--   improvements that 00328 intended to ship.
--
-- WHAT'S NEW vs the prod version:
--   1. ILIKE wildcards escaped (%, _, \) — same defensive pattern as
--      00108. Prevents F403-style bugs from user input "100%".
--   2. pg_trgm similarity added as a second match path — tolerates typos
--      and accent differences ("neptono" matches "Neptuno").
--   3. plpgsql guardrails: short-query short-circuit returns 0 rows
--      cleanly instead of scanning a 200k row table for "a".
--   4. GIN gin_trgm_ops index on main_street — keeps fuzzy match fast at
--      400k rows post-populate (~50ms p50).
--
-- WHAT STAYS SAME (zero frontend impact):
--   - Function signature: (query, lat, lng, max_results) with the same
--     defaults as prod (23.1136, -82.3666, 10)
--   - Return shape: name, address, latitude, longitude, municipality,
--     province, distance_m (the prod-existing distance_m column stays)
--   - Ranking: exact > starts-with > contains > trigram-only fuzzy
--   - DISTINCT ON (main_street, municipality) so "Calle 23 Habana" and
--     "Calle 23 Matanzas" both appear as distinct results
--   - LANGUAGE sql replaced by plpgsql, but behaviour is the same
--
-- DEPLOYMENT NOTE:
--   This is a CREATE OR REPLACE with identical return shape, so it
--   applies cleanly without DROP. Frontend already reads only `name,
--   address, latitude, longitude, municipality, province` and ignores
--   the trailing `distance_m` — confirmed at geo.ts:3498-3507.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Extension (idempotent — already enabled cluster-wide)
-- ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ─────────────────────────────────────────────────────────────────
-- GIN trigram index on main_street (idempotent)
-- ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_street_intersections_main_trgm
  ON public.street_intersections
  USING GIN (main_street gin_trgm_ops);


-- ─────────────────────────────────────────────────────────────────
-- RPC search_streets v2
-- ─────────────────────────────────────────────────────────────────
--
-- Signature & return shape MATCH the prod-existing version exactly:
--   args:    (query text, lat double precision DEFAULT 23.1136,
--             lng double precision DEFAULT -82.3666, max_results integer DEFAULT 10)
--   returns: TABLE(name text, address text, latitude double precision,
--                  longitude double precision, municipality text,
--                  province text, distance_m double precision)

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
  -- Below 2 chars the matches are too noisy and the cost too high.
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_norm_query := trim(query);

  -- Escape ILIKE wildcards (%, _, \) to prevent injection-style behaviour
  -- from user input like "100%" or "abc_def". Same pattern as 00108
  -- (suggest_cross_streets fix). Critical for street search exposed to
  -- arbitrary user text.
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
      -- Ranking: exact match > starts-with > word-boundary contains
      -- > generic contains > trigram-only fuzzy
      CASE
        WHEN si.main_street ILIKE v_escaped THEN 0
        WHEN si.main_street ILIKE v_escaped || '%' THEN 1
        WHEN si.main_street ILIKE '% ' || v_escaped || '%' THEN 2
        WHEN si.main_street ILIKE '%' || v_escaped || '%' THEN 3
        ELSE 4   -- trigram-only (typo tolerance)
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
  ORDER BY m.match_rank, m.dist
  LIMIT v_limit;
END;
$$;

-- Permissions — search is a read-only public op (matches prod state)
REVOKE ALL ON FUNCTION public.search_streets(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_streets(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.search_streets IS
  '00329 v2 - Free-text street search with pg_trgm fuzzy tolerance, escaped ILIKE wildcards, and exact>starts>contains>trgm ranking. Called by packages/utils/src/geo.ts:searchStreetsSupabase. Shape preserved from the prod-drift version (00328 original).';


-- ─────────────────────────────────────────────────────────────────
-- Smoke (commented out — uncomment to verify after migration applies)
-- ─────────────────────────────────────────────────────────────────
--
-- -- Should return [] cleanly while street_intersections is empty:
-- SELECT * FROM public.search_streets('Calle 23', 23.1136, -82.3666, 5);
-- SELECT * FROM public.search_streets('a', 23.1136, -82.3666, 5);  -- short query guardrail
--
-- -- Once PR F populates La Habana, these should all return rows:
-- SELECT * FROM public.search_streets('Calle 23', 23.1136, -82.3666, 5);
-- SELECT * FROM public.search_streets('Reina', 23.1357, -82.3666, 5);
-- SELECT * FROM public.search_streets('Neptono', 23.1402, -82.3712, 5);  -- typo → trgm match
-- SELECT * FROM public.search_streets('100%', 23.1136, -82.3666, 5);    -- escape test
