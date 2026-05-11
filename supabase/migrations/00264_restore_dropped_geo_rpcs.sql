-- ============================================================
-- Migration 00264: restore find_intersection_point AND nearest_poi RPCs.
--
-- BACKGROUND
-- ----------
-- 00207_drop_dead_rpcs_and_test_cron.sql dropped two functions with the
-- comment "never called from app" — but that audit was wrong: at the
-- time of dropping, both functions were actively called via helpers in
-- packages/utils/src/geo.ts:
--
--   - find_intersection_point() — called by lookupIntersectionPoint(),
--     used in apps/web/src/components/AddressAutocomplete.tsx (3 sites)
--     and apps/client/src/components/{AddressSearchInput,WebAddressInput}
--     .tsx (3 sites). Resolves cross-street pairs to coordinates.
--
--   - nearest_poi() — called by getNearestPoiName(), used in reverse
--     geocoding to label dragged map pins with the closest POI name
--     (e.g. "near Hospital Hermanos Ameijeiras"). lookup_nearest_poi
--     (00248) is NOT a transparent replacement: its category whitelist
--     drops healthcare, sport, craft, aeroway and emergency, so
--     hospitals, gyms, fire stations etc. would silently disappear
--     from address labels. We restore the original here.
--
-- Since 00207 hit prod, both helpers have been silently logging 404s
-- in the browser console. Their defensive try/catch returns null on
-- any failure, so the user-facing UX kept working — intersections
-- never resolved, POI names never appeared — but the page was noisy
-- and labels were wrong. Surfaced in `Web.docx` (2026-05-08).
--
-- This migration restores both functions verbatim from their original
-- definitions (00091 and 00090 respectively) and re-grants execute
-- to anon/authenticated/service_role.
--
-- IDEMPOTENCY: CREATE OR REPLACE + DROP IF EXISTS in 00207 means
-- re-applying this is safe.
--
-- WHY NOT MIGRATE THE CALLERS TO THE NEW lookup_* RPC?
-- - There is no replacement for find_intersection_point;
--   street_intersections still exists, only the access function was
--   removed.
-- - lookup_nearest_poi has a smaller category whitelist than the legacy
--   function, so switching would silently change reverse-geocoding
--   behaviour for healthcare/sport/craft/aeroway/emergency POIs. We
--   keep both functions; the codebase can pick whichever whitelist
--   fits the use case.
-- ============================================================

-- ── find_intersection_point (restored from 00091) ──────────────
CREATE OR REPLACE FUNCTION find_intersection_point(
  p_main TEXT,
  p_cross1 TEXT,
  p_cross2 TEXT DEFAULT NULL,
  p_lat DOUBLE PRECISION DEFAULT 23.1136,
  p_lng DOUBLE PRECISION DEFAULT -82.3666,
  p_radius_m INTEGER DEFAULT 5000
)
RETURNS TABLE(latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, address TEXT)
LANGUAGE sql STABLE AS $$
  WITH matches AS (
    SELECT
      ST_Y(si.intersection_point::geometry) as lat,
      ST_X(si.intersection_point::geometry) as lng,
      si.main_street,
      si.cross_street_1,
      si.municipality,
      si.province,
      ST_Distance(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
      ) as dist
    FROM street_intersections si
    WHERE ST_DWithin(
        si.intersection_point,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
        p_radius_m
      )
      AND (si.main_street ILIKE p_main OR si.main_street ILIKE '%' || p_main || '%')
      AND (
        si.cross_street_1 ILIKE p_cross1
        OR si.cross_street_1 ILIKE '%' || p_cross1 || '%'
        OR (p_cross2 IS NOT NULL AND (
          si.cross_street_1 ILIKE p_cross2
          OR si.cross_street_1 ILIKE '%' || p_cross2 || '%'
        ))
      )
    ORDER BY dist
    LIMIT 2
  )
  SELECT
    CASE WHEN COUNT(*) >= 2 THEN (SUM(m.lat) / 2.0) ELSE MIN(m.lat) END,
    CASE WHEN COUNT(*) >= 2 THEN (SUM(m.lng) / 2.0) ELSE MIN(m.lng) END,
    p_main
      || CASE
           WHEN p_cross2 IS NOT NULL THEN ' e/ ' || p_cross1 || ' y ' || p_cross2
           ELSE ' y ' || p_cross1
         END
      || COALESCE(', ' || (SELECT m2.municipality FROM matches m2 WHERE m2.municipality IS NOT NULL LIMIT 1), '')
      || COALESCE(', ' || (SELECT m3.province FROM matches m3 WHERE m3.province IS NOT NULL LIMIT 1), '')
  FROM matches m;
$$;

GRANT EXECUTE ON FUNCTION find_intersection_point(TEXT, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER)
  TO anon, authenticated, service_role;

-- ── nearest_poi (restored from 00090) ──────────────────────────
-- Note: category whitelist intentionally broader than lookup_nearest_poi
-- to include healthcare, sport, craft, aeroway, emergency for reverse
-- geocoding labels.
CREATE OR REPLACE FUNCTION nearest_poi(
  p_lat double precision,
  p_lng double precision,
  p_radius_m int DEFAULT 30
)
RETURNS TABLE(name text, category text, distance_m double precision)
LANGUAGE sql STABLE AS $$
  SELECT p.name, p.category,
    ST_Distance(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) as distance_m
  FROM cuba_pois p
  WHERE ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, p_radius_m)
    AND p.category IN ('amenity', 'shop', 'tourism', 'leisure', 'historic', 'healthcare', 'office', 'sport', 'craft', 'aeroway', 'emergency')
  ORDER BY distance_m
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION nearest_poi(double precision, double precision, int)
  TO anon, authenticated, service_role;
