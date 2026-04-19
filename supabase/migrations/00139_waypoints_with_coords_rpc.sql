-- ============================================================
-- Migration 00139: get_ride_waypoints_with_coords RPC
--
-- The ride_waypoints.location column is a PostGIS GEOGRAPHY that
-- comes back from PostgREST as an opaque WKB hex string — the JS
-- client can't read lat/lng from it directly. As a result, waypoint
-- markers never rendered on the map and the route polyline never
-- re-fetched with the extra stops (user-facing: "agregar parada no
-- recalcula la ruta").
--
-- This RPC returns each waypoint with numeric latitude / longitude
-- columns extracted via ST_Y / ST_X so the client can consume the
-- coords directly.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_ride_waypoints_with_coords(p_ride_id UUID)
RETURNS TABLE(
  id UUID,
  ride_id UUID,
  address TEXT,
  sort_order INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  arrived_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    w.id,
    w.ride_id,
    w.address,
    w.sort_order,
    ST_Y(w.location::geometry)::DOUBLE PRECISION AS latitude,
    ST_X(w.location::geometry)::DOUBLE PRECISION AS longitude,
    w.arrived_at,
    w.departed_at,
    w.created_at
  FROM ride_waypoints w
  WHERE w.ride_id = p_ride_id
    -- Respect RLS semantics via join on rides + auth.uid().
    -- Rider sees their own ride's waypoints; driver sees the ride they
    -- accepted; admin sees everything.
    AND EXISTS (
      SELECT 1 FROM rides r
      WHERE r.id = w.ride_id
        AND (
          r.customer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM driver_profiles dp
            WHERE dp.id = r.driver_id AND dp.user_id = auth.uid()
          )
          OR is_admin()
        )
    )
  ORDER BY w.sort_order ASC;
$$;

-- Public-share variant: same data but by share_token (no auth).
-- Used by the web /track/share/[token] page so viewers without a
-- TriciGo account can see the waypoint stops on the shared map.
CREATE OR REPLACE FUNCTION public.get_ride_waypoints_by_share_token(p_token TEXT)
RETURNS TABLE(
  id UUID,
  address TEXT,
  sort_order INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  arrived_at TIMESTAMPTZ,
  departed_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT
    w.id,
    w.address,
    w.sort_order,
    ST_Y(w.location::geometry)::DOUBLE PRECISION AS latitude,
    ST_X(w.location::geometry)::DOUBLE PRECISION AS longitude,
    w.arrived_at,
    w.departed_at
  FROM ride_waypoints w
  JOIN rides r ON r.id = w.ride_id
  WHERE r.share_token = p_token
    AND (r.share_token_expires_at IS NULL OR r.share_token_expires_at > NOW())
  ORDER BY w.sort_order ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_ride_waypoints_with_coords(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ride_waypoints_by_share_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.get_ride_waypoints_with_coords(UUID) IS
  'Returns ride waypoints with numeric latitude/longitude (extracted from the GEOGRAPHY location column). RLS-equivalent check inline.';
COMMENT ON FUNCTION public.get_ride_waypoints_by_share_token(TEXT) IS
  'Public endpoint: returns waypoints for a ride by its share_token. Used by /track/share/[token] page.';
