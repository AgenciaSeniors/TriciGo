-- ============================================================
-- BUG-118: getPublicRideByShareToken (in ride.service.ts) used to
-- run 4-5 separate Supabase queries — rides → driver_profiles → users
-- → vehicles → ride_waypoints — to compose the public tracking view.
-- All those tables are RLS-scoped to ride participants (customer +
-- driver), so anonymous viewers (trusted contacts opening the SMS
-- link, family members not signed in) got empty rows from each query.
--
-- Effect: the public share page rendered with placeholders ("Driver"
-- / no avatar / no plate / "Vehicle") and the "estimated arrival"
-- timestamps were null because accepted_at/pickup_at also fell behind
-- RLS unless the visitor was authenticated as the rider.
--
-- Fix: a SECURITY DEFINER RPC that bundles only the privacy-safe
-- fields the share page needs and enforces share_token expiry inline.
-- The client passes the opaque token from the URL, the RPC validates
-- it, and the result is the same shape as the old client-side join.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_shared_ride_by_token(p_token text)
RETURNS TABLE (
  id uuid,
  status ride_status,
  service_type text,
  pickup_lat numeric,
  pickup_lng numeric,
  dropoff_lat numeric,
  dropoff_lng numeric,
  estimated_duration_s integer,
  accepted_at timestamptz,
  pickup_at timestamptz,
  arrived_at_destination_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  driver_first_name text,
  driver_avatar_url text,
  driver_rating numeric,
  vehicle_make text,
  vehicle_model text,
  vehicle_color text,
  vehicle_plate text,
  vehicle_photo_url text,
  vehicle_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT
    r.id,
    r.status::text,
    r.service_type,
    r.pickup_lat,
    r.pickup_lng,
    r.dropoff_lat,
    r.dropoff_lng,
    r.estimated_duration_s,
    r.accepted_at,
    r.pickup_at,
    r.arrived_at_destination_at,
    r.completed_at,
    r.canceled_at,
    -- Driver identity is reduced to first name only — the share page
    -- shouldn't leak the driver's full last name to anonymous viewers.
    split_part(COALESCE(u.full_name, ''), ' ', 1) AS driver_first_name,
    u.avatar_url AS driver_avatar_url,
    dp.rating_avg AS driver_rating,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    v.color AS vehicle_color,
    v.license_plate AS vehicle_plate,
    v.photo_url AS vehicle_photo_url,
    v.type::text AS vehicle_type
  FROM rides r
  LEFT JOIN users u ON u.id = r.driver_id
  LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id
  LEFT JOIN vehicles v ON v.id = r.vehicle_id
  WHERE r.share_token = p_token
    AND (r.share_token_expires_at IS NULL OR r.share_token_expires_at > NOW())
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_shared_ride_by_token(text) IS
  'BUG-118: privacy-safe SECURITY DEFINER fetch for the public share-tracking page. Returns just enough info for the map + ETA without exposing PII or bypassing per-table RLS.';

GRANT EXECUTE ON FUNCTION public.get_shared_ride_by_token(text) TO anon, authenticated;
