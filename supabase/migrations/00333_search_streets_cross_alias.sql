-- ============================================================
-- Migration 00333: search_streets v6 — cross_street alias normalization
--
-- WHY:
--   00332 normalized the PRIMARY street name (main_street → display the
--   Cuban popular alias). But `cross_street_1` still surfaces raw:
--
--     name:    "Calle N"
--     address: "Calle N e/ 27 de Noviembre (Jovellar)"   ← raw cross
--                            ^^^^^^^^^^^^^^^^^^^^^^^^^
--
--   For consistency, the cross street should normalize the same way:
--
--     address: "Calle N e/ Jovellar (27 de Noviembre)"
--
--   Confirmed in prod: many cross_street_1 values follow the same
--   "OFFICIAL (ALIAS)" pattern (Avenida de los Presidentes (Calle G),
--   27 de Noviembre (Jovellar), Calle 23 (La Rampa), Calzada (7ma), etc.)
--
-- WHAT THIS DOES:
--   New helper `_street_full_display(text)` that:
--     - "Padre Varela (Belascoaín)"  → "Belascoaín (Padre Varela)"
--     - "Calle 23"                    → "Calle 23"
--     - NULL or empty                 → ""
--
--   The address builder in search_streets uses this helper for BOTH
--   main_street AND cross_street_1, giving a consistent "alias first,
--   official in parens" presentation throughout.
--
-- WHAT STAYS:
--   - Same shape (name, address, latitude, longitude, municipality,
--     province, distance_m)
--   - Same trigram tolerance, wildcard escape, proximity buckets, dedup
--   - The `name` field still uses _street_display_name (just the alias)
--   - Only the `address` field changes
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- Helper: full display form ("alias (official)")
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._street_full_display(s TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN s IS NULL OR s = '' THEN ''
    WHEN s ~ '^.+\s+\(([^)]+)\)\s*$' THEN
      -- "Padre Varela (Belascoaín)" → "Belascoaín (Padre Varela)"
      trim(regexp_replace(s, '^.+\s+\(([^)]+)\)\s*$', '\1'))
        || ' ('
        || trim(regexp_replace(s, '^(.+)\s+\([^)]+\)\s*$', '\1'))
        || ')'
    ELSE s
  END;
$$;

COMMENT ON FUNCTION public._street_full_display IS
  '00333 - Returns "alias (official)" form when the input has a parenthesized alias, else the raw input. Used by search_streets address builder for both main and cross streets.';


-- ─────────────────────────────────────────────────────────────────
-- search_streets v6 — uses _street_full_display for both main + cross
-- ─────────────────────────────────────────────────────────────────

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
    SELECT DISTINCT ON (public._street_normalize_key(public._street_display_name(si.main_street)))
      si.main_street AS raw_name,
      public._street_display_name(si.main_street) AS display_name,
      si.cross_street_1,
      si.municipality,
      si.province,
      si.intersection_point,
      ST_Distance(si.intersection_point, v_user_point) AS dist,
      LEAST(
        CASE
          WHEN si.main_street ILIKE v_escaped THEN 0
          WHEN si.main_street ILIKE v_escaped || '%' THEN 1
          WHEN si.main_street ILIKE '% ' || v_escaped || '%' THEN 2
          WHEN si.main_street ILIKE '%' || v_escaped || '%' THEN 3
          ELSE 4
        END,
        CASE
          WHEN public._street_display_name(si.main_street) ILIKE v_escaped THEN 0
          WHEN public._street_display_name(si.main_street) ILIKE v_escaped || '%' THEN 1
          WHEN public._street_display_name(si.main_street) ILIKE '% ' || v_escaped || '%' THEN 2
          WHEN public._street_display_name(si.main_street) ILIKE '%' || v_escaped || '%' THEN 3
          ELSE 4
        END
      ) AS match_rank
    FROM public.street_intersections si
    WHERE si.main_street ILIKE '%' || v_escaped || '%'
       OR public._street_display_name(si.main_street) ILIKE '%' || v_escaped || '%'
       OR similarity(si.main_street, v_norm_query) > 0.30
       OR similarity(public._street_display_name(si.main_street), v_norm_query) > 0.30
    ORDER BY
      public._street_normalize_key(public._street_display_name(si.main_street)),
      ST_Distance(si.intersection_point, v_user_point) ASC
  )
  SELECT
    m.display_name AS name,
    -- Address: "alias (official) e/ alias (official)" form, using the
    -- _street_full_display helper for both ends. Falls back gracefully
    -- when either side lacks an alias.
    public._street_full_display(m.raw_name)
      || COALESCE(' e/ ' || public._street_full_display(m.cross_street_1), '')
      AS address,
    ST_Y(m.intersection_point::geometry) AS latitude,
    ST_X(m.intersection_point::geometry) AS longitude,
    COALESCE(m.municipality, '') AS municipality,
    COALESCE(m.province, '') AS province,
    m.dist AS distance_m
  FROM matches m
  ORDER BY
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
  '00333 v6 - Consistent alias normalization for both main_street and cross_street_1 in the address builder. Closes Tier 1.5 street search quality work.';
