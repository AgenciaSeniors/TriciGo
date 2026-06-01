-- ============================================================
-- Migration 00363: canonical address in find_intersection_point
--
-- WHY:
--   00361 made the lookup typo/accent tolerant but still BUILT the returned
--   address from the user's raw input, so an unaccented query produced an
--   ugly echo: find_intersection_point('belascoain','san lazaro','animas')
--   → "belascoain e/ san lazaro y animas, …". Coords were right, the label
--   was not.
--
-- WHAT THIS DOES (signature unchanged — CREATE OR REPLACE):
--   Builds the address from the MATCHED street names in the DB, run through
--   the same `_street_full_display` helper search_streets uses, so the label
--   reads "Belascoaín (Padre Varela) e/ San Lázaro y Ánimas, Dragones, La
--   Habana" regardless of how the user typed it.
--
--   To do that reliably it picks the best match for EACH cross independently
--   (the previous LIMIT 2 over the union could drop one cross's name), and
--   sets coords to the midpoint of the two cross intersections when both are
--   found (falling back to the cross1 match, then the closest candidate).
--   Still returns zero rows when nothing matches. Matching itself (unaccent +
--   pg_trgm) is unchanged from 00361. Falls back to initcap(user input) for a
--   cross whose canonical name couldn't be resolved.
-- ============================================================

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
  WITH candidates AS (
    SELECT
      ST_Y(si.intersection_point::geometry) AS lat,
      ST_X(si.intersection_point::geometry) AS lng,
      si.main_street      AS m_main,
      si.cross_street_1   AS m_cross,
      si.municipality,
      si.province,
      ST_Distance(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) AS dist,
      (unaccent(si.cross_street_1) ILIKE unaccent('%' || p_cross1 || '%')
        OR similarity(unaccent(si.cross_street_1), unaccent(lower(p_cross1))) > 0.3) AS mc1,
      (p_cross2 IS NOT NULL AND (
        unaccent(si.cross_street_1) ILIKE unaccent('%' || p_cross2 || '%')
        OR similarity(unaccent(si.cross_street_1), unaccent(lower(p_cross2))) > 0.3)) AS mc2
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
  ),
  picked AS (
    SELECT
      (SELECT c.m_main  FROM candidates c ORDER BY c.dist LIMIT 1)              AS c_main,
      (SELECT c.lat     FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1)  AS lat1,
      (SELECT c.lng     FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1)  AS lng1,
      (SELECT c.m_cross FROM candidates c WHERE c.mc1 ORDER BY c.dist LIMIT 1)  AS x1,
      (SELECT c.lat     FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1)  AS lat2,
      (SELECT c.lng     FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1)  AS lng2,
      (SELECT c.m_cross FROM candidates c WHERE c.mc2 ORDER BY c.dist LIMIT 1)  AS x2,
      (SELECT c.lat     FROM candidates c ORDER BY c.dist LIMIT 1)              AS lat0,
      (SELECT c.lng     FROM candidates c ORDER BY c.dist LIMIT 1)              AS lng0,
      (SELECT c.municipality FROM candidates c WHERE c.municipality IS NOT NULL ORDER BY c.dist LIMIT 1) AS muni,
      (SELECT c.province     FROM candidates c WHERE c.province     IS NOT NULL ORDER BY c.dist LIMIT 1) AS prov,
      EXISTS (SELECT 1 FROM candidates) AS has_any
  )
  SELECT
    CASE WHEN p.lat1 IS NOT NULL AND p.lat2 IS NOT NULL THEN (p.lat1 + p.lat2) / 2.0
         WHEN p.lat1 IS NOT NULL THEN p.lat1
         ELSE p.lat0 END AS latitude,
    CASE WHEN p.lng1 IS NOT NULL AND p.lng2 IS NOT NULL THEN (p.lng1 + p.lng2) / 2.0
         WHEN p.lng1 IS NOT NULL THEN p.lng1
         ELSE p.lng0 END AS longitude,
    public._street_full_display(p.c_main)
      || CASE WHEN p_cross2 IS NOT NULL
              THEN ' e/ ' || public._street_full_display(COALESCE(p.x1, initcap(p_cross1)))
                          || ' y '  || public._street_full_display(COALESCE(p.x2, initcap(p_cross2)))
              ELSE ' y ' || public._street_full_display(COALESCE(p.x1, initcap(p_cross1))) END
      || COALESCE(', ' || p.muni, '')
      || COALESCE(', ' || p.prov, '') AS address
  FROM picked p
  WHERE p.has_any;
$function$;

COMMENT ON FUNCTION public.find_intersection_point IS
  '00363 - Resolve "X e/ Y y Z" to coords (midpoint of the two cross intersections) with unaccent + pg_trgm matching; address is built from the matched canonical street names via _street_full_display. Zero rows when nothing matches.';
