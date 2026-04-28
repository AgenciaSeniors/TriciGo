-- BUG-255: the column rides.driver_en_route_at does not exist; the RPC
-- update_ride_status_v2 referenced it in dead code that only fired once
-- BUG-254 unblocked the cast. The status='driver_en_route' itself plus
-- updated_at already track the transition; no consumer reads the
-- (non-existent) timestamp column. Drop the line.

CREATE OR REPLACE FUNCTION public.update_ride_status_v2(
  p_ride_id uuid,
  p_new_status text,
  p_driver_lat double precision DEFAULT NULL,
  p_driver_lng double precision DEFAULT NULL,
  p_no_gps_mode boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ride          rides%ROWTYPE;
  v_driver_user_id UUID;
  v_driver_pos    GEOGRAPHY;
  v_distance_m    DOUBLE PRECISION;
  v_target        GEOGRAPHY;
  v_target_label  TEXT;
  v_threshold_m   INTEGER := 100;
  v_bypass_max_m  INTEGER := 500;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF v_ride IS NULL THEN
    RAISE EXCEPTION 'Ride not found';
  END IF;

  SELECT user_id INTO v_driver_user_id FROM driver_profiles WHERE id = v_ride.driver_id;
  IF NOT is_admin() AND auth.uid() <> v_driver_user_id THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  IF p_new_status = 'arrived_at_pickup' THEN
    v_target := v_ride.pickup_location::geography;
    v_target_label := 'pickup';
  ELSIF p_new_status = 'arrived_at_destination' THEN
    v_target := v_ride.dropoff_location::geography;
    v_target_label := 'destination';
  ELSE
    -- BUG-254: cast text -> ride_status. BUG-255: removed the
    -- "UPDATE rides SET driver_en_route_at = ..." line because that
    -- column does not exist; status='driver_en_route' + updated_at
    -- already track the transition.
    UPDATE rides SET status = p_new_status::ride_status, updated_at = now() WHERE id = p_ride_id;
    IF p_new_status = 'in_progress' THEN
      UPDATE rides SET pickup_at = COALESCE(pickup_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status);
  END IF;

  -- BUG-246: rider consented to no-GPS mode -> skip proximity gate entirely
  IF v_ride.driver_gps_status = 'rider_consented' THEN
    UPDATE rides SET status = p_new_status::ride_status, updated_at = now() WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'gated', false,
      'new_status', p_new_status,
      'rider_consented_no_gps', true
    );
  END IF;

  -- Path B: GPS coords required
  IF p_driver_lat IS NULL OR p_driver_lng IS NULL THEN
    RAISE EXCEPTION 'gps_required'
      USING MESSAGE = 'Driver GPS coordinates required. If your GPS is broken, the system will ask the rider for consent.';
  END IF;

  v_driver_pos := ST_SetSRID(ST_MakePoint(p_driver_lng, p_driver_lat), 4326)::geography;
  v_distance_m := ST_Distance(v_driver_pos, v_target);

  -- Path B.1: GPS within threshold -> auto-allow
  IF v_distance_m <= v_threshold_m THEN
    UPDATE rides SET
      status = p_new_status::ride_status,
      gps_check_distance_m = v_distance_m::integer,
      updated_at = now()
    WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status, 'distance_m', v_distance_m::integer);
  END IF;

  -- Path B.2: rider already confirmed bypass (GPS jitter case)
  IF v_ride.gps_override_confirmed_at IS NOT NULL
     AND v_ride.gps_override_confirmed_at > now() - INTERVAL '5 minutes' THEN
    UPDATE rides SET status = p_new_status::ride_status, gps_check_distance_m = v_distance_m::integer, updated_at = now() WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, now()) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'gated', false, 'new_status', p_new_status, 'distance_m', v_distance_m::integer, 'rider_bypass_used', true);
  END IF;

  -- Path B.3: between threshold and bypass max -> request rider confirm
  IF v_distance_m <= v_bypass_max_m THEN
    UPDATE rides SET gps_override_requested_at = now(), gps_check_distance_m = v_distance_m::integer WHERE id = p_ride_id;
    RETURN jsonb_build_object('success', false, 'gated', true, 'reason', 'pending_rider_confirmation', 'distance_m', v_distance_m::integer, 'target', v_target_label, 'threshold_m', v_threshold_m);
  END IF;

  -- Path B.4: too far -> reject
  RAISE EXCEPTION 'too_far_for_bypass'
    USING MESSAGE = format('Estas a %sm del %s. Acercate mas para confirmar.', v_distance_m::integer, v_target_label);
END;
$$;
