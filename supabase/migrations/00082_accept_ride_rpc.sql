-- Atomic accept_ride RPC with idempotency, active ride check, and heartbeat validation
CREATE OR REPLACE FUNCTION public.accept_ride(
  p_ride_id uuid,
  p_driver_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_ride rides%ROWTYPE;
  v_driver driver_profiles%ROWTYPE;
  v_existing_active rides%ROWTYPE;
BEGIN
  -- Lock ride row to prevent concurrent accepts
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;

  IF v_ride IS NULL THEN
    RETURN jsonb_build_object('error', 'ride_not_found');
  END IF;

  -- IDEMPOTENCY: If this driver already accepted THIS ride, return success
  IF v_ride.driver_id = p_driver_id AND v_ride.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress') THEN
    RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id, 'idempotent', true);
  END IF;

  -- Ride must be in searching status
  IF v_ride.status != 'searching' THEN
    RETURN jsonb_build_object('error', 'ride_already_taken');
  END IF;

  -- Verify driver exists, is online, and has fresh heartbeat
  SELECT * INTO v_driver FROM driver_profiles WHERE id = p_driver_id;

  IF v_driver IS NULL THEN
    RETURN jsonb_build_object('error', 'driver_not_found');
  END IF;

  IF NOT v_driver.is_online THEN
    RETURN jsonb_build_object('error', 'driver_not_online');
  END IF;

  IF v_driver.last_heartbeat_at IS NOT NULL AND v_driver.last_heartbeat_at < now() - interval '3 minutes' THEN
    RETURN jsonb_build_object('error', 'driver_stale_heartbeat');
  END IF;

  -- Check driver doesn't have another active ride
  SELECT * INTO v_existing_active FROM rides
  WHERE driver_id = p_driver_id
    AND status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress')
    AND id != p_ride_id
  LIMIT 1;

  IF v_existing_active IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'driver_has_active_ride', 'active_ride_id', v_existing_active.id);
  END IF;

  -- Atomic accept
  UPDATE rides SET
    driver_id = p_driver_id,
    status = 'accepted',
    accepted_at = now()
  WHERE id = p_ride_id AND status = 'searching';

  RETURN jsonb_build_object('success', true, 'ride_id', p_ride_id);
END;
$$;
