-- Un conductor que llega al punto SIN CONEXIÓN queda encerrado para siempre.
--
-- Caso real (viaje 409513b3, conductor Angel Vazquez, 2026-07-27): llegó al
-- destino a las 12:04 hora Cuba, pero en ese momento no tenía datos. El toque de
-- "Llegué al destino" es una llamada en vivo que simplemente falló. Cuando
-- recuperó la conexión ya se había alejado, y la verja de proximidad lo rechazó
-- por estar a 5,3 km. Pasados los v_bypass_max_m (500 m) NO hay ninguna salida:
-- ni siquiera la confirmación del pasajero, que está topada en el mismo radio.
-- El viaje quedó trabado en in_progress y hubo que cerrarlo a mano.
--
-- La asimetría de fondo: la app driver YA sobrevive los cortes de red para el
-- GPS — bufferea los breadcrumbs y los reinyecta al reconectar (BUG-273 v2,
-- useDriverLocation.ts + locationBuffer.ts). Por eso la base SÍ tiene los puntos
-- de las 12:04 a 64 m del destino. Lo único que no tolera el corte es justo la
-- acción que el conductor necesita. La prueba de que llegó ya está guardada; la
-- verja simplemente no la mira, solo compara su posición DE AHORA.
--
-- Fix: antes de rechazar, consultar el rastro GPS del propio viaje. Si algún
-- punto registrado estuvo dentro del umbral del punto objetivo, se permite la
-- transición aunque ahora esté lejos.
--
-- Por qué NO debilita el control antifraude: el rastro es el GPS del propio
-- conductor, exactamente la misma fuente que la verja ya acepta en vivo en la
-- rama B.1. No se agrega una fuente nueva ni menos confiable; solo se deja de
-- descartar evidencia que ya estaba en la base.
--
-- Acotado en el tiempo para que no sea un agujero: para 'arrived_at_destination'
-- solo cuentan los puntos posteriores a pickup_at (el viaje ya en curso), así
-- que pasar cerca del destino camino a la recogida NO lo habilita. Para
-- 'arrived_at_pickup', solo los posteriores a accepted_at.
--
-- driver_arrived_at se estampa con la hora del PUNTO, no con now(): el cargo por
-- espera sale de (pickup_at - driver_arrived_at), así que usar now() le inflaría
-- la espera al pasajero por culpa del corte de red.

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
  v_trail_since   TIMESTAMPTZ;
  v_trail_at      TIMESTAMPTZ;
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
    v_trail_since := COALESCE(v_ride.accepted_at, v_ride.created_at);
  ELSIF p_new_status = 'arrived_at_destination' THEN
    v_target := v_ride.dropoff_location::geography;
    v_target_label := 'destination';
    v_target_es := 'destino';
    -- Solo el tramo en curso: pasar cerca del destino camino a la recogida
    -- no debe habilitar la llegada.
    v_trail_since := COALESCE(v_ride.pickup_at, v_ride.accepted_at, v_ride.created_at);
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

  -- Path B: con coordenadas, la verja de proximidad en vivo (B.1 / B.2 / B.3).
  -- Sin coordenadas se cae directo al rastro (Path C).
  IF p_driver_lat IS NOT NULL AND p_driver_lng IS NOT NULL THEN
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
  END IF;

  -- Path C: sin coordenadas, o demasiado lejos. Último recurso antes de
  -- rechazar: ¿el rastro GPS del propio viaje ya prueba que estuvo ahí?
  -- Cubre el corte de red al llegar — los breadcrumbs se bufferean y se
  -- reinyectan al reconectar, el toque de estado no.
  -- Usa idx_ride_locations_ride (ride_id, recorded_at DESC).
  SELECT MIN(le.recorded_at) INTO v_trail_at
  FROM ride_location_events le
  WHERE le.ride_id = p_ride_id
    AND le.recorded_at >= v_trail_since
    AND ST_Distance(le.location::geography, v_target) <= v_threshold_m;

  IF v_trail_at IS NOT NULL THEN
    UPDATE rides SET
      status = p_new_status::ride_status,
      gps_check_distance_m = COALESCE(v_distance_m::integer, gps_check_distance_m),
      updated_at = now()
    WHERE id = p_ride_id;
    IF p_new_status = 'arrived_at_pickup' THEN
      -- Hora real de llegada, no now(): el cargo por espera sale de
      -- (pickup_at - driver_arrived_at) y now() se la inflaría al pasajero.
      UPDATE rides SET driver_arrived_at = COALESCE(driver_arrived_at, v_trail_at) WHERE id = p_ride_id;
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'gated', false,
      'new_status', p_new_status,
      'distance_m', v_distance_m::integer,
      'offline_trail_used', true,
      'trail_arrived_at', v_trail_at
    );
  END IF;

  -- Path D: ni coordenadas en vivo ni rastro que lo respalde -> rechazar.
  IF p_driver_lat IS NULL OR p_driver_lng IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'No pudimos leer tu GPS. Activa la ubicación e intenta de nuevo; si sigue fallando, el pasajero puede confirmar por ti.',
      DETAIL  = 'gps_required';
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = format('Estás a %s m del %s. Acércate más para confirmar.', v_distance_m::integer, v_target_es),
    DETAIL  = 'too_far_for_bypass';
END;
$$;
