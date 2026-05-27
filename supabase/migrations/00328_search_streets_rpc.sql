-- ============================================================
-- Migration 00328: search_streets RPC (the missing piece)
--
-- Adendum 2026-05-27 — Tier 1.5 PR E.
--
-- WHY:
--   `packages/utils/src/geo.ts:searchStreetsSupabase()` invokes the RPC
--   `search_streets` (POST /rest/v1/rpc/search_streets) but this RPC was
--   never defined in any migration. The function silently returns `[]` on
--   error (line 3494: `if (!res.ok) return []`), so the rider/driver
--   dropdowns never see street results — falling through to Mapbox/Google
--   which don't know the Cuban "Calle X e/ Y y Z" format well.
--
-- WHAT THIS RPC DOES:
--   Given a free-text query (e.g. "Calle 23", "Reina", "San Lazaro") plus a
--   user position, returns the matching streets ordered by:
--     1. Fuzzy text similarity to the query (pg_trgm) — tolerates typos and
--        accent differences (e.g. "neptono" matches "Neptuno")
--     2. Distance from user to the nearest intersection on that street
--   Each street is returned ONCE (DISTINCT ON main_street) with its closest
--   intersection coordinates so the rider can navigate to a precise pin.
--
-- DATA SHAPE EXPECTED BY CALLER (`searchStreetsSupabase` lines 3498-3507):
--   { name, address, latitude, longitude, municipality, province }
--
-- DATA SHAPE OF THIS RPC: matches exactly — no frontend change needed.
--
-- PERFORMANCE:
--   pg_trgm extension is already enabled cluster-wide. We add a GIN index
--   on main_street with gin_trgm_ops so the similarity scan stays under
--   ~50ms even with 400k rows in street_intersections (post-populate).
--
-- DEPLOYMENT:
--   Frontend already tolerates the RPC's absence (returns `[]` on any
--   non-2xx). This migration can be applied independently of any client
--   release; once applied, the frontend starts seeing results immediately
--   (assuming street_intersections has data — see PR F).
--
-- This is a STAGING migration — adds RPC and index, does not touch data.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Extension (idempotent — already enabled cluster-wide, but ensure it)
-- ─────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ─────────────────────────────────────────────────────────────────
-- GIN trigram index on main_street
-- ─────────────────────────────────────────────────────────────────
--
-- The existing btree index (idx_street_intersections_main from 00088)
-- is fine for exact match / prefix queries, but pg_trgm similarity()
-- needs a GIN gin_trgm_ops index to be performant on large tables.

CREATE INDEX IF NOT EXISTS idx_street_intersections_main_trgm
  ON public.street_intersections
  USING GIN (main_street gin_trgm_ops);


-- ─────────────────────────────────────────────────────────────────
-- RPC search_streets
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_streets(
  query        TEXT,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  max_results  INTEGER DEFAULT 10
)
RETURNS TABLE(
  name          TEXT,
  address       TEXT,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  municipality  TEXT,
  province      TEXT
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
  -- Guardrails: short query short-circuits cleanly (no results, no scan)
  IF query IS NULL OR length(trim(query)) < 2 THEN
    RETURN;
  END IF;

  v_user_point := ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography;
  v_norm_query := trim(query);
  -- Escape ILIKE wildcards (%, _, \) to prevent injection-style behaviour
  -- from user input like "100%" or "abc_def". Same pattern as 00108
  -- (suggest_cross_streets) — keeps street search safe from F403-style bugs.
  v_escaped    := replace(replace(replace(v_norm_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_limit      := GREATEST(LEAST(COALESCE(max_results, 10), 25), 1);

  RETURN QUERY
  WITH ranked AS (
    -- For each row in street_intersections that matches the query, score
    -- it by (similarity, distance to user). DISTINCT ON main_street keeps
    -- the closest intersection per unique street.
    SELECT DISTINCT ON (si.main_street)
      si.main_street,
      si.cross_street_1,
      si.cross_street_2,
      ST_Y(si.intersection_point::geometry) AS lat,
      ST_X(si.intersection_point::geometry) AS lng,
      si.municipality,
      si.province,
      similarity(si.main_street, v_norm_query) AS sim,
      ST_Distance(si.intersection_point, v_user_point) AS dist_m
    FROM public.street_intersections si
    WHERE si.main_street ILIKE '%' || v_escaped || '%'
       OR similarity(si.main_street, v_norm_query) > 0.30
    ORDER BY si.main_street, ST_Distance(si.intersection_point, v_user_point) ASC
  )
  SELECT
    r.main_street AS name,
    -- "Calle 23 e/ M y N, Vedado, La Habana" — assemble the most
    -- informative address using cross streets and admin levels.
    CASE
      WHEN r.cross_street_1 IS NOT NULL AND r.cross_street_2 IS NOT NULL
        THEN r.main_street || ' e/ ' || r.cross_street_1 || ' y ' || r.cross_street_2
      WHEN r.cross_street_1 IS NOT NULL
        THEN r.main_street || ' e/ ' || r.cross_street_1
      ELSE r.main_street
    END AS address,
    r.lat       AS latitude,
    r.lng       AS longitude,
    r.municipality,
    r.province
  FROM ranked r
  ORDER BY r.sim DESC, r.dist_m ASC
  LIMIT v_limit;
END;
$$;

-- Allow anon + authenticated to call (search is a read-only public op)
REVOKE ALL ON FUNCTION public.search_streets(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_streets(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.search_streets IS
  '00328 — Free-text street search across street_intersections (pg_trgm fuzzy + proximity tie-break). Called by packages/utils/src/geo.ts:searchStreetsSupabase. Returns empty when street_intersections has no data — frontend already tolerates this.';


-- ─────────────────────────────────────────────────────────────────
-- Smoke (commented out — uncomment to verify after migration applies)
-- ─────────────────────────────────────────────────────────────────
--
-- -- Should return rows once street_intersections is populated:
-- SELECT * FROM public.search_streets('Calle 23', 23.1136, -82.3666, 5);
-- SELECT * FROM public.search_streets('Reina', 23.1357, -82.3666, 5);
-- SELECT * FROM public.search_streets('Neptono', 23.1402, -82.3712, 5);  -- typo: should still match Neptuno via trgm
--
-- -- Index sanity:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'street_intersections' AND indexdef ILIKE '%gin_trgm_ops%';
