-- Live bodies read from prod on 2026-10-12 (pg_get_functiondef). Do not edit by hand.
-- live _ride_short_code: md5 7dae14319bfae57a2ac8b4317e928513
CREATE OR REPLACE FUNCTION public._ride_short_code(p_ride_id uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$ SELECT upper(left(p_ride_id::text, 8)) $function$;

-- live calculate_wait_charge: md5 2c0679d1ce8600da188e4ff101ddd2ca
CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride rides%ROWTYPE;
  v_svc service_type_configs%ROWTYPE;
  v_wait_seconds NUMERIC;
  v_wait_minutes INTEGER;
  v_billable_minutes INTEGER;
  v_max_billable INTEGER;
  v_charge INTEGER;
  v_band_rate INTEGER;
  v_at_t time;
  v_at_dow int;
  result RECORD;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
  SELECT * INTO v_svc FROM service_type_configs WHERE slug = v_ride.service_type;

  IF v_ride.driver_arrived_at IS NOT NULL AND v_ride.pickup_at IS NOT NULL THEN
    v_wait_seconds := EXTRACT(EPOCH FROM (v_ride.pickup_at::timestamptz - v_ride.driver_arrived_at::timestamptz));
    v_wait_minutes := GREATEST(0, FLOOR(v_wait_seconds / 60)::INTEGER);
    v_billable_minutes := GREATEST(0, v_wait_minutes - COALESCE(v_svc.free_wait_minutes, 5));
    v_max_billable := GREATEST(0, get_platform_config_numeric('max_billable_wait_minutes', 20)::INTEGER);
    v_billable_minutes := LEAST(v_billable_minutes, v_max_billable);

    -- 00502: rate from the band the wait STARTED in (Havana time), not now().
    -- complete_ride_and_pay PERFORMs this at completion, which can land in a
    -- different band; re-running must always yield the same charge.
    BEGIN
      v_at_t   := (v_ride.driver_arrived_at AT TIME ZONE 'America/Havana')::time;
      v_at_dow := EXTRACT(dow FROM (v_ride.driver_arrived_at AT TIME ZONE 'America/Havana'))::int;
      SELECT pr.per_wait_minute_rate_cup INTO v_band_rate
      FROM public.pricing_rules pr
      WHERE pr.service_type = v_ride.service_type
        AND pr.is_active = true
        AND pr.per_wait_minute_rate_cup IS NOT NULL
        AND (pr.time_window_start IS NULL OR pr.time_window_end IS NULL OR
             CASE WHEN pr.time_window_start <= pr.time_window_end
                  THEN v_at_t >= pr.time_window_start AND v_at_t < pr.time_window_end
                  ELSE v_at_t >= pr.time_window_start OR v_at_t < pr.time_window_end END)
        AND (pr.day_of_week IS NULL OR array_length(pr.day_of_week, 1) IS NULL
             OR v_at_dow = ANY(pr.day_of_week))
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_band_rate := NULL;
    END;

    v_charge := v_billable_minutes * COALESCE(v_band_rate, v_svc.per_wait_minute_rate_cup, 0);
  ELSE
    v_wait_minutes := 0; v_billable_minutes := 0; v_charge := 0;
  END IF;

  UPDATE rides SET wait_time_minutes = v_wait_minutes, wait_time_charge_cup = v_charge WHERE id = p_ride_id;

  SELECT v_wait_minutes AS wait_minutes, v_billable_minutes AS billable_minutes, v_charge AS charge INTO result;
  RETURN result;
END;
$function$;

-- live enforce_ride_transition: md5 f806997fab31c18e7b369e69f5321c30
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
  IF v_user_role = 'marketing' THEN
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

-- live get_platform_config_numeric: md5 13d2587037eca74854cf2394ba42a90c
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

-- live log_rpc_attempt: md5 0a902c34a1148dac5686403a7c941bc0
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

-- live notify_ride_status_change: md5 b99d013d5585771cfd2be51788ae1fa4
CREATE OR REPLACE FUNCTION public.notify_ride_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_recipient_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_payload JSONB;
  v_service_key TEXT;
  v_headers JSONB;
  v_data JSONB;
BEGIN
  v_data := jsonb_build_object(
    'type', 'ride',
    'ride_id', NEW.id::text,
    'status', NEW.status::text
  );

  CASE NEW.status
    WHEN 'accepted' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor asignado';
      v_body := 'Un conductor aceptó tu viaje';

    WHEN 'driver_en_route' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor en camino';
      v_body := 'Tu conductor va en camino';

    WHEN 'arrived_at_pickup' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Conductor llegó';
      v_body := 'Tu conductor está en el punto de recogida';

    WHEN 'in_progress' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje iniciado';
      v_body := 'Tu viaje ha comenzado';

    WHEN 'arrived_at_destination' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Llegaste a tu destino';
      v_body := 'Tu conductor ha llegado al punto de destino';

    WHEN 'completed' THEN
      v_recipient_id := NEW.customer_id;
      v_title := 'Viaje completado';
      IF NEW.final_fare_cup IS NOT NULL AND NEW.final_fare_cup > 0 THEN
        v_body := 'Pago: $' || replace(to_char(NEW.final_fare_cup, 'FM999,999,999'), ',', '.') || ' CUP. ¡Gracias por viajar con TriciGo!';
        v_data := v_data || jsonb_build_object(
          'final_fare_cup', NEW.final_fare_cup,
          'payment_method', COALESCE(NEW.payment_method, 'cash')
        );
      ELSE
        v_body := 'Tu viaje ha terminado. ¡Gracias!';
      END IF;

    WHEN 'canceled' THEN
      IF NEW.canceled_by = NEW.customer_id THEN
        IF NEW.driver_id IS NOT NULL THEN
          v_recipient_id := get_driver_user_id(NEW.driver_id);
          v_title := 'Viaje cancelado';
          v_body := 'El pasajero canceló el viaje';
        ELSE
          RETURN NEW;
        END IF;
      ELSE
        v_recipient_id := NEW.customer_id;
        v_title := 'Viaje cancelado';
        v_body := 'Tu viaje fue cancelado';
      END IF;

    ELSE
      RETURN NEW;
  END CASE;

  IF v_recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  v_payload := jsonb_build_object(
    'user_id',  v_recipient_id::text,
    'title',    v_title,
    'body',     v_body,
    'category', 'ride',
    'data',     v_data
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := v_payload
  );

  IF NEW.status = 'completed' AND NEW.driver_id IS NOT NULL THEN
    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
      headers := v_headers,
      body    := jsonb_build_object(
        'user_id',  get_driver_user_id(NEW.driver_id)::text,
        'title',    'Viaje completado',
        'body',     'Viaje completado. ¡Revisa tus ganancias!',
        'category', 'ride',
        'data', jsonb_build_object(
          'type',    'ride',
          'ride_id', NEW.id::text,
          'status', 'completed'
        )
      )
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_ride_status_change] exception for ride %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;
