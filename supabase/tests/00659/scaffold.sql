-- Scaffold for the 00659 rehearsal. The tables keep prod's columns, RLS policies
-- and grants (read from prod on 2026-10-12) for ride_location_events and the
-- parts of rides, driver_profiles, users and validation_events that the
-- functions below touch. The live functions are copied byte for byte from
-- pg_get_functiondef in prod; the md5 of each body is noted next to it.
-- net.http_post and get_service_role_key are stubs: the push "sent" by
-- check_proximity_notification lands in net.calls. A NON-superuser role
-- (prod: postgres) owns everything; run.sh applies the migration as that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS net;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER SCHEMA net OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_gps_status AS ENUM ('healthy', 'unavailable', 'rider_consented');

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Push stub: what check_proximity_notification would send.
CREATE TABLE net.calls (id bigserial PRIMARY KEY, url text, body jsonb);
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
 RETURNS bigint LANGUAGE sql AS $f$ INSERT INTO net.calls (url, body) VALUES (url, body) RETURNING id $f$;
CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'k'::text $f$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  current_location geography,
  current_heading numeric
);
GRANT SELECT, UPDATE ON public.driver_profiles TO authenticated, service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  pickup_location geography NOT NULL,
  dropoff_location geography NOT NULL,
  accepted_at timestamptz,
  driver_arrived_at timestamptz,
  pickup_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  proximity_pickup_notified_at timestamptz,
  proximity_dropoff_notified_at timestamptz,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz,
  gps_check_distance_m integer,
  driver_gps_status public.driver_gps_status NOT NULL DEFAULT 'healthy',
  completed_far_from_pin boolean NOT NULL DEFAULT false,
  actual_dropoff_location geography
);
GRANT SELECT ON public.rides TO authenticated, service_role;

CREATE TABLE public.validation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid,
  event_type text NOT NULL,
  ride_id uuid,
  properties jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- ride_location_events as in prod (columns, indexes, FKs, RLS, policies, grants).
CREATE TABLE public.ride_location_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  location geography NOT NULL,
  heading numeric,
  speed numeric,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  accuracy numeric,
  client_event_id uuid,
  CONSTRAINT ride_location_events_pkey PRIMARY KEY (id),
  CONSTRAINT ride_location_events_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  CONSTRAINT ride_location_events_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES public.rides(id)
);
CREATE INDEX idx_ride_locations_ride ON public.ride_location_events USING btree (ride_id, recorded_at DESC);
CREATE INDEX idx_ride_location_events_driver_id ON public.ride_location_events USING btree (driver_id);
CREATE INDEX idx_ride_location_events_recorded_at ON public.ride_location_events USING btree (recorded_at);
CREATE UNIQUE INDEX idx_ride_location_dedup ON public.ride_location_events USING btree (ride_id, recorded_at);
CREATE UNIQUE INDEX uq_ride_location_client_event ON public.ride_location_events USING btree (ride_id, client_event_id);
ALTER TABLE public.ride_location_events ENABLE ROW LEVEL SECURITY;

-- live current_user_role: md5 cb4a7c12d4e21fe2997135833f141e25, 103 chars
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    (SELECT role FROM users WHERE id = auth.uid()),
    'customer'::user_role
  );
$function$;

-- live is_admin: md5 22cb75e91980d512498034cd33e1eda2, 285 chars
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

-- live get_driver_user_id: md5 a11e7a77d9dcdea08e08d0c8346d9dbc, 71 chars
CREATE OR REPLACE FUNCTION public.get_driver_user_id(p_driver_profile_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT user_id FROM driver_profiles WHERE id = p_driver_profile_id;
$function$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

CREATE POLICY rl_insert ON public.ride_location_events FOR INSERT
  WITH CHECK ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY rl_select ON public.ride_location_events FOR SELECT
  USING ((is_admin() OR (ride_id IN ( SELECT rides.id
   FROM rides
  WHERE (rides.customer_id = ( SELECT auth.uid() AS uid)))) OR (ride_id IN ( SELECT r.id
   FROM rides r
  WHERE ((r.driver_id IN ( SELECT dp.id
           FROM driver_profiles dp
          WHERE (dp.user_id = ( SELECT auth.uid() AS uid)))) AND (r.status = ANY (ARRAY['accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status, 'disputed'::ride_status])))))));
-- prod: {postgres=arwdDxtm,anon=arwdDxtm,authenticated=arwdDxtm,service_role=arwdDxtm} (PG16 has no MAINTAIN)
GRANT ALL ON public.ride_location_events TO anon, authenticated, service_role;

-- live check_proximity_notification: md5 ea7ce3f2ef2cd0be8065f9b0ffabcde1, 3217 chars
CREATE OR REPLACE FUNCTION public.check_proximity_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD; v_distance_m DOUBLE PRECISION; v_rows INTEGER; v_headers JSONB; v_driver_user_id UUID;
  v_service_key TEXT;
BEGIN
  SELECT id, status, customer_id, driver_id, pickup_location, dropoff_location,
         proximity_pickup_notified_at, proximity_dropoff_notified_at
  INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF v_ride.status NOT IN ('accepted','driver_en_route','in_progress') THEN RETURN NEW; END IF;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN NEW; END IF;
  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  IF v_ride.status IN ('accepted','driver_en_route') AND v_ride.proximity_pickup_notified_at IS NULL
     AND v_ride.pickup_location IS NOT NULL THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.pickup_location);
    IF v_distance_m < 1500 THEN
      UPDATE rides SET proximity_pickup_notified_at = NOW()
      WHERE id = v_ride.id AND proximity_pickup_notified_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object('user_id',v_ride.customer_id::text,'title','Conductor cerca','body','Tu conductor está a ~2 minutos del punto de recogida','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','pickup'),'category','proximity')
        );
        v_driver_user_id := get_driver_user_id(v_ride.driver_id);
        IF v_driver_user_id IS NOT NULL THEN
          PERFORM net.http_post(
            url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
            headers := v_headers,
            body := jsonb_build_object('user_id',v_driver_user_id::text,'title','Llegando al punto de recogida','body','Estás a ~2 minutos del punto de recogida','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','pickup'),'category','proximity')
          );
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_ride.status = 'in_progress' AND v_ride.proximity_dropoff_notified_at IS NULL
     AND v_ride.dropoff_location IS NOT NULL THEN
    v_distance_m := ST_Distance(NEW.location, v_ride.dropoff_location);
    IF v_distance_m < 1500 THEN
      UPDATE rides SET proximity_dropoff_notified_at = NOW()
      WHERE id = v_ride.id AND proximity_dropoff_notified_at IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 1 THEN
        PERFORM net.http_post(
          url := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := v_headers,
          body := jsonb_build_object('user_id',v_ride.customer_id::text,'title','Llegando a destino','body','Estás a ~2 minutos de tu destino','data',jsonb_build_object('type','proximity','ride_id',v_ride.id::text,'proximity_type','dropoff'),'category','proximity')
        );
      END IF;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END; $function$;

-- live update_driver_position: md5 63dfd68a1d8b7ff1f689e3acb4ee7937, 765 chars
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

-- live update_ride_status_v2: md5 182eeb5721e458b9976c12d7318f09ac, 8423 chars
CREATE OR REPLACE FUNCTION public.update_ride_status_v2(p_ride_id uuid, p_new_status text, p_driver_lat double precision DEFAULT NULL::double precision, p_driver_lng double precision DEFAULT NULL::double precision, p_no_gps_mode boolean DEFAULT false, p_confirm_far boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT is_admin() AND auth.uid() IS DISTINCT FROM v_driver_user_id THEN
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

  -- Path B: con coordenadas, la verja de proximidad en vivo (B.1 / B.2 / B.3 / B.4).
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

    -- Path B.4 (fix viaje b428022b): pin de destino mal geocodificado. A más de
    -- v_bypass_max_m del pin, el conductor puede confirmar explícitamente que el
    -- pasajero ya llegó (p_confirm_far=true desde el modal de la app). Se guarda
    -- la posición real como actual_dropoff_location y se emite validation_event
    -- para revisión en admin y corrección del geocoder. Solo destino: en pickup
    -- el override del conductor permitiría inflar el cargo por espera.
    IF p_new_status = 'arrived_at_destination' AND p_confirm_far THEN
      UPDATE rides SET
        status = p_new_status::ride_status,
        gps_check_distance_m = v_distance_m::integer,
        completed_far_from_pin = true,
        actual_dropoff_location = v_driver_pos,
        updated_at = now()
      WHERE id = p_ride_id;
      INSERT INTO validation_events (driver_id, event_type, ride_id, properties)
      VALUES (
        v_driver_user_id,
        'arrived_far_from_pin',
        p_ride_id,
        jsonb_build_object(
          'distance_m', v_distance_m::integer,
          'driver_lat', p_driver_lat,
          'driver_lng', p_driver_lng,
          'bypass_max_m', v_bypass_max_m
        )
      );
      RETURN jsonb_build_object(
        'success', true,
        'gated', false,
        'new_status', p_new_status,
        'distance_m', v_distance_m::integer,
        'far_from_pin_override', true
      );
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
$function$;

CREATE TRIGGER trg_proximity_check AFTER INSERT ON public.ride_location_events
  FOR EACH ROW EXECUTE FUNCTION check_proximity_notification();

REVOKE ALL ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_driver_position(uuid, double precision, double precision, double precision, double precision, uuid) TO authenticated, service_role;

RESET ROLE;
