-- ============================================================
-- Migration 00264: restore find_intersection_point RPC.
--
-- BACKGROUND
-- ----------
-- 00207_drop_dead_rpcs_and_test_cron.sql dropped find_intersection_point
-- with the comment "never called" — but that audit was wrong: at the time
-- of dropping, the function was actively called by:
--   - apps/client/src/components/AddressSearchInput.tsx
--   - apps/client/src/components/WebAddressInput.tsx (2 sites)
--   - apps/web/src/components/AddressAutocomplete.tsx (3 sites)
-- via the lookupIntersectionPoint() helper in packages/utils/src/geo.ts.
--
-- Since 00207 hit prod, all of those callers have been silently logging
-- 404s in the browser console (the helper has a defensive try/catch that
-- returns null on any failure, so the user-facing UX kept working —
-- intersections silently never resolved). Surfaced in `Web.docx` as part
-- of the booking-page error noise audit (2026-05-08).
--
-- This migration restores the function verbatim from 00091. It also
-- re-grants execute to anon/authenticated/service_role (matching the
-- original PUBLIC default).
--
-- IDEMPOTENCY: CREATE OR REPLACE FUNCTION + DROP IF EXISTS in 00207
-- means re-applying this is safe.
--
-- WHY NOT JUST USE THE NEW lookup_* RPC? There is no replacement for
-- street_intersections lookups. lookup_nearest_poi (00248) returns POIs,
-- not street-corner coordinates. The street_intersections table still
-- exists and is populated; only the access function was removed.
-- ============================================================

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
