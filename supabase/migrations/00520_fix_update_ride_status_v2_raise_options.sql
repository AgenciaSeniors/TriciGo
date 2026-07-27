-- BUG: "RAISE option already specified: MESSAGE" al tocar "Llegué al destino".
--
-- update_ride_status_v2 tenía DOS sentencias RAISE mal formadas:
--
--     RAISE EXCEPTION 'too_far_for_bypass'
--       USING MESSAGE = format('Estas a %sm del %s. ...', ...);
--
-- En plpgsql la cadena de formato de `RAISE EXCEPTION 'texto'` YA define la
-- opción MESSAGE. Agregar `USING MESSAGE = ...` la define por segunda vez y
-- Postgres aborta con 42601 "RAISE option already specified: MESSAGE" — el
-- error de la propia sentencia RAISE reemplaza al mensaje que se quería dar.
--
-- Reproducido en prod:
--   DO $$ BEGIN RAISE EXCEPTION 'gps_required' USING MESSAGE = 'x'; END $$;
--   --> ERROR: 42601: RAISE option already specified: MESSAGE
--
-- Efecto para el conductor: cada vez que caía en una de las dos ramas
-- (GPS sin coordenadas, o a más de v_bypass_max_m del punto) el toast mostraba
-- "RAISE option already specified: MESSAGE" en vez del texto accionable. Como
-- el driver DEBE pasar por arrived_at_destination para poder finalizar, el
-- viaje quedaba trabado sin ninguna pista de qué hacer.
--
-- Fix: usar la forma `RAISE EXCEPTION USING ...` (sin cadena de formato), que
-- define MESSAGE una sola vez. El código legible por máquina se conserva en
-- DETAIL, donde PostgREST lo expone como `error.details` para quien quiera
-- ramificar por código en vez de por texto.
--
-- Se aprovecha para traducir el texto: v_target_label es 'pickup'/'destination'
-- (inglés) y se interpolaba crudo dentro de una frase en español.

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
  v_target_es     TEXT;
  v_threshold_m   INTEGER := 100;
  v_bypass_max_m  INTEGER := 500;
BEGIN
  -- RLC-01 (audit round 6): reject terminal / payment-bearing transitions.
  -- complete_ride_and_pay is the ONLY path allowed to set 'completed' (it moves
  -- money + writes the final snapshot); cancel_ride owns 'canceled'/'disputed'.
  -- The FSM trigger allows in_progress->completed for role 'driver' and cannot
  -- distinguish complete_ride_and_pay's UPDATE from a raw one, so the guard must
  -- live in this RPC.
  IF p_new_status IN ('completed', 'canceled', 'disputed') THEN
    RAISE EXCEPTION 'use complete_ride_and_pay / cancel_ride for terminal transitions';
  END IF;

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
    v_target_es := 'punto de recogida';
  ELSIF p_new_status = 'arrived_at_destination' THEN
    v_target := v_ride.dropoff_location::geography;
    v_target_label := 'destination';
    v_target_es := 'destino';
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
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No pudimos leer tu GPS. Activa la ubicación e intenta de nuevo; si sigue fallando, el pasajero puede confirmar por ti.',
      DETAIL  = 'gps_required';
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
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = format('Estás a %s m del %s. Acércate más para confirmar.', v_distance_m::integer, v_target_es),
    DETAIL  = 'too_far_for_bypass';
END;
$$;
