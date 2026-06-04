-- 00378_relaxed_geocode_rpcs.sql
--
-- Two reverse-geocoding helper RPCs that make a dropped map pin resolve to a
-- real address far more often OUTSIDE La Habana, and surface a recognizable
-- landmark instead of a random casa particular (Bug 2a / Bug 2c).
--
-- NOT APPLIED to prod yet — committed for review (MCP apply guard). The client
-- tolerates their absence: `lookupNearestMainStreet` returns null on a 404 (the
-- reverse-geocode pipeline then falls through to locality / POI-only), and
-- `lookupNearestPoi` retries the legacy `nearest_poi` when the ranked RPC is
-- missing. Apply via `supabase db push` or the deploy pipeline in the next round.
--
-- Both are read-only (STABLE), defensive against NULL coordinates, and granted
-- to anon/authenticated/service_role like the other geo RPCs (see 00248/00264).

-- ---------------------------------------------------------------------------
-- 1) get_nearest_main_street — the single closest street name, NO requirement
--    that two intersections of the same street exist nearby. get_nearest_cross
--    _streets needs a crossing PAIR (HAVING COUNT >= 2), which is sparse outside
--    La Habana and returns nothing; this relaxed lookup still names the street.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_nearest_main_street(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer DEFAULT 200
)
RETURNS TABLE(main_street text, municipality text, province text, distance_m double precision)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    si.main_street,
    si.municipality,
    si.province,
    ST_Distance(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    ) AS distance_m
  FROM street_intersections si
  WHERE p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND si.main_street IS NOT NULL
    AND ST_DWithin(
      si.intersection_point,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
  ORDER BY distance_m
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_nearest_main_street(double precision, double precision, integer)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) lookup_nearest_poi_ranked — nearest POI ranked by QUALITY, not just
--    distance: admin-curated first, then confidence, then proximity. Keeps the
--    BROAD category whitelist (incl. healthcare/sport/aeroway/emergency/transport)
--    that the legacy `nearest_poi` had, so hospitals/gyms/stations still surface.
--    Same return shape (name, category, distance_m) as `nearest_poi`, so the
--    client consumer is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_nearest_poi_ranked(
  p_lat double precision,
  p_lng double precision,
  p_radius_m integer DEFAULT 30
)
RETURNS TABLE(name text, category text, distance_m double precision)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  SELECT
    p.name,
    p.category,
    ST_Distance(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    ) AS distance_m
  FROM cuba_pois p
  WHERE p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p.is_active = true
    AND ST_DWithin(
      p.location,
      ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
      p_radius_m
    )
    AND p.category IN (
      'amenity', 'shop', 'tourism', 'leisure', 'historic',
      'healthcare', 'office', 'sport', 'craft', 'aeroway', 'emergency', 'transport'
    )
  ORDER BY p.is_admin DESC, p.confidence DESC NULLS LAST, distance_m
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.lookup_nearest_poi_ranked(double precision, double precision, integer)
  TO anon, authenticated, service_role;
