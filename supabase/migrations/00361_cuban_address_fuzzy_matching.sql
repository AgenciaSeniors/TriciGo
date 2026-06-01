-- ============================================================
-- Migration 00361: typo/accent-tolerant Cuban address lookup
--
-- WHY:
--   The "Calle X e/ Y y Z" flow felt fragile. `suggest_cross_streets` and
--   `find_intersection_point` matched street names with **ILIKE only** — no
--   unaccent, no trigram — so an unaccented or misspelled name silently
--   failed, unlike `search_streets` (which already uses pg_trgm). Verified
--   against prod:
--     - suggest_cross_streets('belascoain')  → 0 rows (vs 10 for 'Belascoaín')
--     - find_intersection_point('belascoain','san lazaro') → coords NULL
--   `find_intersection_point` also always returned ONE row (it aggregates the
--   matches), so a no-match returned a row with NULL lat/lng + an echoed
--   address — which the client mis-handles as a resolved point.
--
-- WHAT THIS DOES (signatures unchanged — CREATE OR REPLACE):
--   1. Both RPCs match street names with unaccent + pg_trgm (similarity > 0.3),
--      mirroring search_streets v6, so 'belascoain' / 'san lasaro' / 'belas'
--      resolve. Adds 'extensions' to find_intersection_point's search_path so
--      unaccent()/similarity() resolve.
--   2. find_intersection_point returns **zero rows** when nothing matches
--      (WHERE n > 0) instead of a NULL-coord row.
--
--   Validated read-only against prod before writing:
--     - suggest_cross_streets('belascoain') → 72 candidate rows
--     - find_intersection_point('belascoain','san lazaro') → (23.1410, -82.3705)
-- ============================================================

-- ─────────────────────────────────────────────────────────────────
-- suggest_cross_streets — unaccent + trigram, ranked by similarity
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_cross_streets(
  p_main     text,
  p_lat      double precision DEFAULT 23.1136,
  p_lng      double precision DEFAULT -82.3666,
  p_radius_m integer          DEFAULT 3000
)
RETURNS TABLE(cross_street text)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_escaped TEXT;
  v_norm    TEXT;
BEGIN
  -- Escape ILIKE wildcards in the literal; normalize for the trigram side.
  v_escaped := replace(replace(replace(p_main, '\', '\\'), '%', '\%'), '_', '\_');
  v_norm    := unaccent(lower(trim(p_main)));

  RETURN QUERY
  SELECT si.cross_street_1
  FROM street_intersections si
  WHERE ST_DWithin(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    AND si.cross_street_1 IS NOT NULL
    AND (
      unaccent(si.main_street) ILIKE unaccent('%' || v_escaped || '%')
      OR similarity(unaccent(si.main_street), v_norm) > 0.3
    )
  GROUP BY si.cross_street_1
  ORDER BY max(similarity(unaccent(si.main_street), v_norm)) DESC, si.cross_street_1
  LIMIT 10;
END;
$function$;

COMMENT ON FUNCTION public.suggest_cross_streets IS
  '00361 - Cross-street suggestions with unaccent + pg_trgm matching (typo/accent tolerant), ranked by main-street similarity.';

-- ─────────────────────────────────────────────────────────────────
-- find_intersection_point — unaccent + trigram, no NULL-coord rows
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_intersection_point(
  p_main     text,
  p_cross1   text,
  p_cross2   text             DEFAULT NULL,
  p_lat      double precision DEFAULT 23.1136,
  p_lng      double precision DEFAULT -82.3666,
  p_radius_m integer          DEFAULT 5000
)
RETURNS TABLE(latitude double precision, longitude double precision, address text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  WITH matches AS (
    SELECT
      ST_Y(si.intersection_point::geometry) AS lat,
      ST_X(si.intersection_point::geometry) AS lng,
      si.municipality,
      si.province,
      ST_Distance(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) AS dist
    FROM street_intersections si
    WHERE ST_DWithin(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
        p_radius_m
      )
      AND (
        unaccent(si.main_street) ILIKE unaccent('%' || p_main || '%')
        OR similarity(unaccent(si.main_street), unaccent(lower(p_main))) > 0.3
      )
      AND (
        unaccent(si.cross_street_1) ILIKE unaccent('%' || p_cross1 || '%')
        OR similarity(unaccent(si.cross_street_1), unaccent(lower(p_cross1))) > 0.3
        OR (p_cross2 IS NOT NULL AND (
          unaccent(si.cross_street_1) ILIKE unaccent('%' || p_cross2 || '%')
          OR similarity(unaccent(si.cross_street_1), unaccent(lower(p_cross2))) > 0.3
        ))
      )
    ORDER BY dist
    LIMIT 2
  ),
  agg AS (
    SELECT
      CASE WHEN count(*) >= 2 THEN sum(m.lat) / 2.0 ELSE min(m.lat) END AS lat,
      CASE WHEN count(*) >= 2 THEN sum(m.lng) / 2.0 ELSE min(m.lng) END AS lng,
      count(*) AS n,
      (SELECT m2.municipality FROM matches m2 WHERE m2.municipality IS NOT NULL LIMIT 1) AS muni,
      (SELECT m3.province     FROM matches m3 WHERE m3.province     IS NOT NULL LIMIT 1) AS prov
    FROM matches m
  )
  SELECT
    agg.lat,
    agg.lng,
    p_main
      || CASE WHEN p_cross2 IS NOT NULL THEN ' e/ ' || p_cross1 || ' y ' || p_cross2
              ELSE ' y ' || p_cross1 END
      || COALESCE(', ' || agg.muni, '')
      || COALESCE(', ' || agg.prov, '')
  FROM agg
  WHERE agg.n > 0;
$function$;

COMMENT ON FUNCTION public.find_intersection_point IS
  '00361 - Resolve "X e/ Y y Z" to coords with unaccent + pg_trgm matching; returns zero rows (not a NULL-coord row) when nothing matches.';
