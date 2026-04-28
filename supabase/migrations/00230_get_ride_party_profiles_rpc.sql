-- BUG-250: driver couldn't read rider's full_name/avatar_url because RLS on
-- public.users only allows users to SELECT their own row (users_select_own).
-- The rating sheet then falls back to the literal "Pasajero". Same applies to
-- rider rating UI on the client side seeing "Conductor".
--
-- This SECURITY DEFINER function returns the minimum public profile needed
-- for the rating screen, gated by membership in the ride: the caller must be
-- the rider OR the driver of the ride passed in. No other rows are exposed.

CREATE OR REPLACE FUNCTION public.get_ride_party_profiles(p_ride_id uuid)
RETURNS TABLE (
  rider_id uuid,
  rider_name text,
  rider_avatar_url text,
  rider_rating numeric,
  driver_id uuid,
  driver_name text,
  driver_avatar_url text,
  driver_rating numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_rider uuid;
  v_driver_user uuid;
  v_driver_profile uuid;
BEGIN
  -- Look up the participants of the ride. We need both the rider's user id
  -- (rides.customer_id) and the driver's user id (joined via driver_profiles).
  SELECT r.customer_id, dp.user_id, r.driver_id
    INTO v_rider, v_driver_user, v_driver_profile
  FROM rides r
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;

  IF v_rider IS NULL THEN
    RAISE EXCEPTION 'ride_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Authorization: caller must be either the rider or the driver of the ride.
  IF v_caller IS DISTINCT FROM v_rider AND v_caller IS DISTINCT FROM v_driver_user THEN
    RAISE EXCEPTION 'not_authorized_for_ride' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    v_rider                                                                AS rider_id,
    COALESCE(NULLIF(ru.full_name, ''), 'Pasajero')                          AS rider_name,
    ru.avatar_url                                                          AS rider_avatar_url,
    COALESCE(cp.rating_avg, 5.0)::numeric                                  AS rider_rating,
    v_driver_profile                                                       AS driver_id,
    COALESCE(NULLIF(du.full_name, ''), 'Conductor')                        AS driver_name,
    du.avatar_url                                                          AS driver_avatar_url,
    COALESCE(dp2.rating_avg, 5.0)::numeric                                 AS driver_rating
  FROM (SELECT 1) one
  LEFT JOIN users ru               ON ru.id = v_rider
  LEFT JOIN customer_profiles cp   ON cp.user_id = v_rider
  LEFT JOIN users du               ON du.id = v_driver_user
  LEFT JOIN driver_profiles dp2    ON dp2.id = v_driver_profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_ride_party_profiles(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_ride_party_profiles(uuid)
  IS 'Returns rider+driver display profiles for a ride. Caller must be rider or driver. Bypasses RLS via SECURITY DEFINER but enforces ride membership.';
