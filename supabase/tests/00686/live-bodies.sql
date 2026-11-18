-- Live bodies from prod, 2026-11-18 (pg_get_functiondef, byte for byte; md5 checked
-- against pg_proc.prosrc when pulled). Loaded after scaffold.sql.
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron, triggers without a user. None of
  -- them is an admin, and anon may not even call current_user_role().
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric DEFAULT NULL::numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_raw JSONB;
  v_out NUMERIC;
BEGIN
  SELECT value INTO v_raw FROM platform_config WHERE key = p_key;
  IF v_raw IS NULL THEN
    RETURN p_fallback;
  END IF;

  -- `#>> '{}'` unwraps the JSONB scalar safely whether it was written
  -- as a string ('"0.15"') or as a JSON number (0.15). Cast to NUMERIC
  -- after.
  BEGIN
    v_out := (v_raw #>> '{}')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    v_out := p_fallback;
  END;

  RETURN COALESCE(v_out, p_fallback);
END;
$function$;
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public._reopen_ride_offers(p_ride_id uuid, p_released_driver uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.ride_offers
     SET status = 'expired',
         expires_at = now() - make_interval(secs => GREATEST(0, public.get_platform_config_numeric('reoffer_cooldown_s', 120))::int + 1)
   WHERE ride_id = p_ride_id
     AND driver_profile_id IS DISTINCT FROM p_released_driver
     AND status IN ('superseded', 'expired');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_user_role user_role;
  v_transition_valid BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
    VALUES (NEW.id, OLD.status, NEW.status, NULL, 'admin');
    RETURN NEW;
  END IF;

  SELECT role INTO v_user_role FROM users WHERE id = auth.uid();

  -- Marketing rides as a passenger: its rights over a ride are a customer's
  -- (or a driver's, below, when it owns the approved driver profile).
  -- 00671: inside an ops function acting on this ride (_ops_allow), the operator moves it as
  -- an admin.
  IF v_user_role = 'operator' AND public._ops_acting_on(NEW.id) THEN
    v_user_role := 'admin';
  ELSIF v_user_role IN ('marketing', 'operator') THEN
    v_user_role := 'customer';
  END IF;

  IF v_user_role NOT IN ('admin', 'super_admin')
     AND NEW.driver_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM driver_profiles dp
       WHERE dp.id = NEW.driver_id
         AND dp.user_id = auth.uid()
         AND dp.status = 'approved'
     ) THEN
    v_user_role := 'driver';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM valid_transitions
    WHERE from_status = OLD.status
      AND to_status = NEW.status
      AND v_user_role = ANY(allowed_roles)
  ) INTO v_transition_valid;

  IF NOT v_transition_valid THEN
    RAISE EXCEPTION 'Invalid ride transition from % to % for role %',
      OLD.status, NEW.status, v_user_role;
  END IF;

  INSERT INTO ride_transitions (ride_id, from_status, to_status, actor_id, actor_role)
  VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), v_user_role);

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_caller_uid uuid;
  v_is_admin   boolean;
  v_is_customer boolean;
  v_is_driver  boolean;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RETURN NEW;
  END IF;
  -- 00671: ops staff inside an ops function acting on this ride.
  SELECT is_admin() OR public._ops_acting_on(NEW.id) INTO v_is_admin;
  IF v_is_admin THEN
    RETURN NEW;
  END IF;
  v_is_customer := (OLD.customer_id = v_caller_uid);
  v_is_driver := (OLD.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM driver_profiles WHERE id = OLD.driver_id AND user_id = v_caller_uid
  ));
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'cannot modify customer_id';
  END IF;

  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    IF OLD.driver_id IS NULL
       AND NEW.driver_id IS NOT NULL
       AND OLD.status = 'searching'
       AND NEW.status = 'accepted' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify driver_id (use accept_ride RPC)';
    END IF;
  END IF;

  IF NEW.final_fare_cup IS DISTINCT FROM OLD.final_fare_cup
     OR NEW.final_fare_trc IS DISTINCT FROM OLD.final_fare_trc THEN
    IF OLD.final_fare_cup IS NULL
       AND NEW.final_fare_cup IS NOT NULL
       AND OLD.status IN ('in_progress','arrived_at_destination')
       AND NEW.status = 'completed' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'cannot modify final_fare (use complete_ride RPC)';
    END IF;
  END IF;

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method
     AND NOT (OLD.status = 'completed' AND OLD.payment_method = 'tricicoin'
              AND NEW.payment_method = 'mixed'
              AND COALESCE(current_setting('app.ride_payment_to_mixed', true), '') = '1') THEN
    RAISE EXCEPTION 'cannot modify payment_method on active ride';
  END IF;
  IF NEW.cancellation_fee_cup IS DISTINCT FROM OLD.cancellation_fee_cup
     OR NEW.cancellation_fee_trc IS DISTINCT FROM OLD.cancellation_fee_trc THEN
    RAISE EXCEPTION 'cannot modify cancellation_fee (use cancel_ride RPC)';
  END IF;
  IF v_is_driver AND NOT v_is_customer THEN
    IF NEW.estimated_fare_cup IS DISTINCT FROM OLD.estimated_fare_cup
       OR NEW.estimated_fare_trc IS DISTINCT FROM OLD.estimated_fare_trc
       OR NEW.estimated_distance_m IS DISTINCT FROM OLD.estimated_distance_m
       OR NEW.estimated_duration_s IS DISTINCT FROM OLD.estimated_duration_s THEN
      RAISE EXCEPTION 'driver cannot modify ride estimates';
    END IF;
    IF NEW.pickup_location::text IS DISTINCT FROM OLD.pickup_location::text
       OR NEW.dropoff_location::text IS DISTINCT FROM OLD.dropoff_location::text
       OR NEW.pickup_address IS DISTINCT FROM OLD.pickup_address
       OR NEW.dropoff_address IS DISTINCT FROM OLD.dropoff_address
       OR NEW.pickup_notes IS DISTINCT FROM OLD.pickup_notes
       OR NEW.dropoff_notes IS DISTINCT FROM OLD.dropoff_notes THEN
      RAISE EXCEPTION 'driver cannot modify pickup/dropoff';
    END IF;
  END IF;
  IF v_is_customer AND NOT v_is_driver THEN
    IF NEW.driver_arrived_at IS DISTINCT FROM OLD.driver_arrived_at
       OR NEW.pickup_at IS DISTINCT FROM OLD.pickup_at
       OR NEW.arrived_at_destination_at IS DISTINCT FROM OLD.arrived_at_destination_at
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
      RAISE EXCEPTION 'customer cannot modify driver timestamps';
    END IF;
    IF NEW.actual_distance_m IS DISTINCT FROM OLD.actual_distance_m
       OR NEW.actual_duration_s IS DISTINCT FROM OLD.actual_duration_s THEN
      RAISE EXCEPTION 'customer cannot modify actuals';
    END IF;
    -- CLI-001: pricing fields used as source of truth by complete_ride_and_pay
    IF NEW.surge_multiplier IS DISTINCT FROM OLD.surge_multiplier
       OR NEW.driver_custom_rate_cup IS DISTINCT FROM OLD.driver_custom_rate_cup
       OR NEW.wallet_ratio IS DISTINCT FROM OLD.wallet_ratio
       OR NEW.insurance_premium_cup IS DISTINCT FROM OLD.insurance_premium_cup
       OR NEW.wait_time_charge_cup IS DISTINCT FROM OLD.wait_time_charge_cup THEN
      RAISE EXCEPTION 'customer cannot modify pricing fields (surge_multiplier, driver_custom_rate_cup, wallet_ratio, insurance_premium_cup, wait_time_charge_cup)';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.tg_ride_location_events_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- The server's clock, whatever the writer sent.
  NEW.received_at := now();
  -- A point belongs to a ride its driver drives. Dropped, not refused: the app
  -- uploads in batches, and one stale point (a ride reassigned while the phone
  -- was offline) must not sink the rest.
  IF NOT EXISTS (
    SELECT 1 FROM public.rides r
    WHERE r.id = NEW.ride_id AND r.driver_id = NEW.driver_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.update_driver_position(p_driver_id uuid, p_latitude double precision, p_longitude double precision, p_heading double precision DEFAULT NULL::double precision, p_speed double precision DEFAULT NULL::double precision, p_ride_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner uuid;
  v_loc geography;
BEGIN
  SELECT user_id INTO v_owner FROM driver_profiles WHERE id = p_driver_id;
  IF v_caller IS DISTINCT FROM v_owner AND NOT is_admin() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_loc := ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326)::geography;

  -- 1) Update driver profile location + heading
  UPDATE driver_profiles
  SET current_location = v_loc,
      current_heading = p_heading
  WHERE id = p_driver_id;

  -- 2) If active ride, also append to ride_location_events
  IF p_ride_id IS NOT NULL THEN
    INSERT INTO ride_location_events (ride_id, driver_id, location, heading, speed)
    VALUES (p_ride_id, p_driver_id, v_loc, p_heading, p_speed);
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.driver_heartbeat(p_driver_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_min numeric;
  v_enabled    text;
BEGIN
  IF NOT (
    is_admin()
    OR auth.uid() = (SELECT user_id FROM driver_profiles WHERE id = p_driver_id)
  ) THEN
    RAISE EXCEPTION 'Forbidden: cannot refresh another driver''s heartbeat';
  END IF;

  -- (1) El latido, siempre y primero. Es el contrato de esta función.
  UPDATE driver_profiles
  SET last_heartbeat_at = NOW()
  WHERE id = p_driver_id;

  -- (2) Restauración, aislada: si algo falla acá, el latido YA quedó escrito.
  BEGIN
    SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
    FROM platform_config WHERE key = 'driver_auto_restore_enabled';
    IF v_enabled IN ('false', 'f') THEN
      RETURN;
    END IF;

    v_window_min := COALESCE(get_platform_config_numeric('driver_auto_restore_window_min', 60), 60);

    UPDATE driver_profiles dp
    SET is_online = true
    WHERE dp.id = p_driver_id
      AND dp.is_online = false
      -- Solo lo que apagó el cron; una desconexión manual borró la marca.
      AND dp.auto_offline_at IS NOT NULL
      AND dp.auto_offline_at > now() - make_interval(mins => v_window_min::int)
      -- Precondiciones de tg_driver_profiles_protect_admin_fields: sin esto el
      -- trigger lanzaría excepción y mataría el latido.
      AND dp.status = 'approved'
      AND EXISTS (SELECT 1 FROM vehicles v WHERE v.driver_id = dp.id AND v.is_active = true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[driver_heartbeat] auto-restore failed for %: % %', p_driver_id, SQLSTATE, SQLERRM;
  END;
END;
$function$;
CREATE OR REPLACE FUNCTION public.release_rides_from_dead_drivers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_after_min   INT;
  v_enabled     TEXT;
  v_released    INT := 0;
  v_flagged     INT := 0;
  v_rider_ids   JSONB := '[]'::jsonb;
  v_service_key TEXT;
  r             RECORD;
BEGIN
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'dead_driver_ride_release_enabled';
  IF v_enabled IN ('false', 'f') THEN
    RETURN jsonb_build_object('enabled', false, 'released', 0, 'flagged', 0);
  END IF;

  -- ::int es obligatorio: get_platform_config_numeric devuelve NUMERIC y
  -- make_interval(mins => ...) solo acepta INT (revienta en runtime, no al crear).
  v_after_min := GREATEST(1, get_platform_config_numeric('dead_driver_ride_release_after_minutes', 12))::int;

  -- A) PRE-RECOGIDA → devolver a búsqueda
  FOR r IN
    SELECT rd.id, rd.customer_id, rd.driver_id, rd.status
    FROM rides rd
    JOIN driver_profiles dp ON dp.id = rd.driver_id
    WHERE rd.status IN ('accepted', 'driver_en_route')
      AND dp.last_heartbeat_at IS NOT NULL
      AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  LOOP
    -- Sacar de línea al conductor muerto ANTES de liberar. Sin esto hay una carrera:
    -- find_best_drivers filtra por is_online pero el filtro de heartbeat está desactivado
    -- por defecto (dispatch_heartbeat_window_s = 0), así que un conductor muerto todavía
    -- marcado online podría recibir de vuelta el mismo viaje que le acabamos de quitar.
    UPDATE driver_profiles
    SET is_online = false, auto_offline_at = COALESCE(auto_offline_at, now())
    WHERE id = r.driver_id AND is_online = true;

    -- searching_seen_at = now() es CRÍTICO: cleanup_orphan_searching_rides (cron cada minuto)
    -- cancela los `searching` cuyo searching_seen_at supera searching_abandon_seconds. Sin
    -- refrescarlo, el viaje liberado se cancelaría al minuto siguiente. Con el refresco arranca
    -- una ventana limpia, y si nadie lo toma, ese mismo cron lo cierra de forma ordenada.
    -- last_dispatched_at = NULL deja que retry_dispatch_expired_rides lo re-despache ya.
    UPDATE rides
    SET status             = 'searching',
        driver_id          = NULL,
        accepted_at        = NULL,
        searching_seen_at  = now(),
        last_dispatched_at = NULL,
        -- 00660: the previous driver's GPS and proximity state goes with him,
        -- as in admin_release_active_ride.
        driver_gps_status = 'healthy',
        driver_gps_unavailable_at = NULL,
        gps_override_requested_at = NULL,
        gps_override_confirmed_at = NULL,
        gps_check_distance_m = NULL,
        driver_custom_rate_cup = NULL,
        proximity_pickup_notified_at = NULL,
        updated_at         = now()
    WHERE id = r.id
      AND status = r.status;   -- guarda optimista: si el conductor revivió y avanzó, no lo pisamos

    IF FOUND THEN
      v_released := v_released + 1;
      v_rider_ids := v_rider_ids || to_jsonb(r.customer_id);

      UPDATE ride_offers
      SET status = 'expired'
      WHERE ride_id = r.id AND driver_profile_id = r.driver_id AND status = 'pending';

      -- 00660: the drivers offered the ride before he took it get it again.
      PERFORM public._reopen_ride_offers(r.id, r.driver_id);
    END IF;
  END LOOP;

  -- B) POST-RECOGIDA → solo alertar, jamás tocar el viaje
  INSERT INTO stuck_ride_alerts (ride_id, reason, details)
  SELECT rd.id, 'dead_driver_app',
         jsonb_build_object(
           'ride_status', rd.status,
           'driver_id', rd.driver_id,
           'last_heartbeat_at', dp.last_heartbeat_at,
           'minutes_silent', ROUND(EXTRACT(EPOCH FROM (now() - dp.last_heartbeat_at)) / 60)
         )
  FROM rides rd
  JOIN driver_profiles dp ON dp.id = rd.driver_id
  WHERE rd.status IN ('arrived_at_pickup', 'in_progress', 'arrived_at_destination')
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  ON CONFLICT (ride_id) DO NOTHING;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;

  -- 00555: avisar por correo. Hasta acá la fila se insertaba muda y 00538
  -- la auto-resolvía a los 5 min, así que nadie se enteraba nunca.
  -- 00640: the e-mail runs in its own cron job (notify-dead-driver-alert), so a
  -- failure there fails that job and never rolls back the releases above.

  -- C) Avisar a los pasajeros liberados. Bloque propio: un fallo de push jamás debe
  -- deshacer la liberación.
  IF v_released > 0 THEN
    BEGIN
      v_service_key := get_service_role_key();
      IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
        PERFORM public.cron_http_post('dead-driver-ride-released',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_key,
            'apikey',        v_service_key
          ),
          body    := jsonb_build_object(
            'user_ids', v_rider_ids,
            'title',    'Buscando otro conductor',
            'body',     'Tu conductor perdió la conexión y no pudo continuar. Estamos buscándote otro ahora mismo.',
            'category', 'ride',
            'data',     jsonb_build_object('reason', 'dead_driver_ride_released')
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[release_rides_from_dead_drivers] push failed: % %', SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('enabled', true, 'released', v_released, 'flagged', v_flagged);
END;
$function$;

CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION public.enforce_ride_transition();
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides FOR EACH ROW EXECUTE FUNCTION public.enforce_ride_update_columns();
CREATE TRIGGER trg_ride_location_events_guard BEFORE INSERT ON public.ride_location_events FOR EACH ROW EXECUTE FUNCTION public.tg_ride_location_events_guard();

REVOKE ALL ON FUNCTION public.update_driver_position(uuid, double precision, double precision, double precision, double precision, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_driver_position(uuid, double precision, double precision, double precision, double precision, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.driver_heartbeat(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_heartbeat(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_rides_from_dead_drivers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_rides_from_dead_drivers() TO service_role;
REVOKE ALL ON FUNCTION public._reopen_ride_offers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._reopen_ride_offers(uuid, uuid) TO service_role;

INSERT INTO public.valid_transitions (from_status, to_status, allowed_roles) VALUES
  ('disputed', 'completed', ARRAY['admin', 'super_admin']::public.user_role[]),
  ('searching', 'accepted', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('accepted', 'driver_en_route', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('driver_en_route', 'arrived_at_pickup', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('arrived_at_pickup', 'in_progress', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('in_progress', 'completed', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('in_progress', 'disputed', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('searching', 'canceled', ARRAY['customer', 'admin', 'super_admin']::public.user_role[]),
  ('accepted', 'canceled', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('arrived_at_pickup', 'canceled', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('in_progress', 'arrived_at_destination', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('arrived_at_destination', 'completed', ARRAY['driver', 'admin', 'super_admin']::public.user_role[]),
  ('arrived_at_destination', 'disputed', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('driver_en_route', 'canceled', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('completed', 'disputed', ARRAY['customer', 'driver', 'admin', 'super_admin']::public.user_role[]),
  ('arrived_at_destination', 'canceled', ARRAY['admin', 'super_admin']::public.user_role[]),
  ('in_progress', 'canceled', ARRAY['admin', 'driver', 'customer', 'super_admin']::public.user_role[]),
  ('accepted', 'searching', ARRAY['admin', 'super_admin']::public.user_role[]),
  ('driver_en_route', 'searching', ARRAY['admin', 'super_admin']::public.user_role[]),
  ('accepted', 'arrived_at_pickup', ARRAY['admin', 'super_admin']::public.user_role[]);
