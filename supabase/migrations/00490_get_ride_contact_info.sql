-- Feature: in-ride direct-call buttons (driver -> rider, rider -> driver).
--
-- Problem: RLS on public.users only allows users to SELECT their own row
-- (users_select_own = id = auth.uid() OR is_admin()). There is NO
-- ride-participant policy, so:
--   * the driver cannot read the rider's users.phone (no "Llamar al pasajero"),
--   * the rider cannot read the driver's users.phone either, which silently
--     disables the client's existing "Llamar al conductor" button.
--
-- This SECURITY DEFINER function surfaces each party's phone to the OTHER,
-- gated by BOTH ride membership AND the active-trip status window. Phones are
-- NOT retrievable once the trip reaches a terminal state (completed / canceled
-- / disputed) or while still searching (no driver yet). Full E.164 numbers are
-- returned (writes are normalized by tg_users_normalize_phone, mig 00461) so
-- the app can dial via tel:. Display masking (maskPhone) happens client-side.

CREATE OR REPLACE FUNCTION public.get_ride_contact_info(p_ride_id uuid)
RETURNS TABLE (rider_phone text, driver_phone text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_rider uuid;
  v_driver_user uuid;
  v_status text;
BEGIN
  -- Resolve the ride participants (rider = customer_id, driver user via profile).
  SELECT r.customer_id, dp.user_id, r.status::text
    INTO v_rider, v_driver_user, v_status
  FROM rides r
  LEFT JOIN driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id;

  IF v_rider IS NULL THEN
    RAISE EXCEPTION 'ride_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Membership gate: caller must be the rider OR the driver of this ride.
  IF v_caller IS DISTINCT FROM v_rider AND v_caller IS DISTINCT FROM v_driver_user THEN
    RAISE EXCEPTION 'not_authorized_for_ride' USING ERRCODE = 'P0001';
  END IF;

  -- Active-trip window ONLY. Any other state returns NULLs so phone numbers are
  -- never retrievable outside a live trip.
  IF v_status NOT IN (
    'accepted', 'driver_en_route', 'arrived_at_pickup',
    'in_progress', 'arrived_at_destination'
  ) THEN
    RETURN QUERY SELECT NULL::text, NULL::text;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    ru.phone AS rider_phone,
    du.phone AS driver_phone
  FROM (SELECT 1) one
  LEFT JOIN users ru ON ru.id = v_rider
  LEFT JOIN users du ON du.id = v_driver_user;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ride_contact_info(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ride_contact_info(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_ride_contact_info(uuid) IS
  'Returns rider+driver phone for a ride, gated by membership AND active-trip status window. SECURITY DEFINER over RLS. Powers in-ride direct-call buttons (driver->rider, rider->driver). Terminal/searching states return NULLs.';
