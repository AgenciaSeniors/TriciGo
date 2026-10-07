-- Scaffold for the 00634 rehearsal: rides with the columns the ride RPCs and
-- the guard touch, the LIVE bodies read from prod on 2026-10-07 of
-- update_ride_status_v2 (md5 0127dfed...), enforce_ride_transition,
-- enforce_ride_update_columns, auth.uid(), auth.role(), current_user_role()
-- and is_admin() (00592), the LIVE transition table, the LIVE r_update and
-- r_select_customer policies on rides, prod's grants on rides (anon and
-- authenticated hold every table privilege) and prod's ACL on
-- update_ride_status_v2 (EXECUTE for PUBLIC and service_role).
-- Simplified on purpose: r_select_driver without its ride_offers branch, the
-- ride_disputes policies reduced to the opener's, and two SECURITY DEFINER
-- stand-ins for complete_ride_and_pay and cancel_ride that write what those
-- RPCs write on rides (status, final fare, timestamps). A NON-superuser role
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
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

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

CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$
;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'approved'
);
GRANT SELECT ON public.driver_profiles TO anon, authenticated, service_role;

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
$function$
;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

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
$function$
;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  service_type text NOT NULL DEFAULT 'triciclo_basico',
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method text NOT NULL DEFAULT 'cash',
  pickup_location public.geography(Point, 4326),
  pickup_address text,
  pickup_lat double precision,
  dropoff_location public.geography(Point, 4326),
  dropoff_address text,
  estimated_fare_cup integer,
  estimated_distance_m integer,
  estimated_duration_s integer,
  final_fare_cup integer,
  actual_distance_m integer,
  actual_duration_s integer,
  accepted_at timestamptz,
  driver_arrived_at timestamptz,
  pickup_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  canceled_by uuid,
  cancellation_reason text,
  share_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  surge_multiplier numeric DEFAULT 1,
  tip_amount integer DEFAULT 0,
  driver_custom_rate_cup integer,
  estimated_fare_trc integer,
  final_fare_trc integer,
  next_ride_id uuid,
  is_chained boolean DEFAULT false,
  insurance_premium_cup integer DEFAULT 0,
  payment_status text,
  cancellation_fee_cup integer,
  cancellation_fee_trc integer,
  is_split boolean DEFAULT false,
  arrived_at_destination_at timestamptz,
  wallet_ratio numeric,
  share_token_expires_at timestamptz,
  wait_time_charge_cup integer DEFAULT 0,
  gps_override_requested_at timestamptz,
  gps_override_confirmed_at timestamptz,
  gps_check_distance_m integer,
  driver_gps_status text,
  completed_far_from_pin boolean DEFAULT false,
  actual_dropoff_location public.geography(Point, 4326),
  pickup_notes text,
  dropoff_notes text
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.rides TO anon, authenticated, service_role;

CREATE POLICY r_select_customer ON public.rides FOR SELECT
  USING ((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY r_select_driver ON public.rides FOR SELECT
  USING (driver_id IN ( SELECT driver_profiles.id FROM driver_profiles
                         WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY r_update ON public.rides FOR UPDATE
  USING ((customer_id = ( SELECT auth.uid() AS uid)) OR (driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin());

CREATE TABLE public.ride_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  opened_by uuid NOT NULL REFERENCES public.users(id),
  respondent_id uuid,
  status text NOT NULL DEFAULT 'open'
    CHECK ((status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved_rider'::text, 'resolved_driver'::text, 'escalated'::text, 'closed'::text])))
);
ALTER TABLE public.ride_disputes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.ride_disputes TO authenticated;
GRANT ALL ON public.ride_disputes TO service_role;
CREATE POLICY dispute_select ON public.ride_disputes FOR SELECT
  USING (((opened_by = auth.uid()) OR (respondent_id = auth.uid()) OR is_admin()));
CREATE POLICY dispute_insert ON public.ride_disputes FOR INSERT WITH CHECK (opened_by = auth.uid());

CREATE TABLE public.validation_events (
  driver_id uuid, event_type text, ride_id uuid, properties jsonb
);
CREATE TABLE public.ride_location_events (
  ride_id uuid, recorded_at timestamptz, location public.geography(Point, 4326)
);

CREATE TABLE public.valid_transitions (
  from_status public.ride_status NOT NULL,
  to_status public.ride_status NOT NULL,
  allowed_roles public.user_role[] NOT NULL
);
GRANT SELECT ON public.valid_transitions TO anon, authenticated, service_role;
INSERT INTO public.valid_transitions VALUES
  ('searching', 'accepted', '{driver,admin,super_admin}'),
  ('searching', 'canceled', '{customer,admin,super_admin}'),
  ('accepted', 'searching', '{admin,super_admin}'),
  ('accepted', 'driver_en_route', '{driver,admin,super_admin}'),
  ('accepted', 'canceled', '{customer,driver,admin,super_admin}'),
  ('driver_en_route', 'searching', '{admin,super_admin}'),
  ('driver_en_route', 'arrived_at_pickup', '{driver,admin,super_admin}'),
  ('driver_en_route', 'canceled', '{customer,driver,admin,super_admin}'),
  ('arrived_at_pickup', 'in_progress', '{driver,admin,super_admin}'),
  ('arrived_at_pickup', 'canceled', '{customer,driver,admin,super_admin}'),
  ('in_progress', 'arrived_at_destination', '{driver,admin,super_admin}'),
  ('in_progress', 'completed', '{driver,admin,super_admin}'),
  ('in_progress', 'canceled', '{admin,driver,customer,super_admin}'),
  ('in_progress', 'disputed', '{customer,driver,admin,super_admin}'),
  ('arrived_at_destination', 'completed', '{driver,admin,super_admin}'),
  ('arrived_at_destination', 'canceled', '{admin,super_admin}'),
  ('arrived_at_destination', 'disputed', '{customer,driver,admin,super_admin}'),
  ('completed', 'disputed', '{customer,driver,admin,super_admin}'),
  ('disputed', 'completed', '{admin,super_admin}');

CREATE TABLE public.ride_transitions (
  ride_id uuid, from_status public.ride_status, to_status public.ride_status,
  actor_id uuid, actor_role text, created_at timestamptz DEFAULT now()
);
GRANT INSERT ON public.ride_transitions TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_ride_transition()
 RETURNS trigger
 LANGUAGE plpgsql
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
$function$
;
CREATE TRIGGER trg_enforce_ride_transition BEFORE UPDATE OF status ON public.rides
  FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION enforce_ride_transition();

CREATE OR REPLACE FUNCTION public.enforce_ride_update_columns()
 RETURNS trigger
 LANGUAGE plpgsql
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
  SELECT is_admin() INTO v_is_admin;
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

  IF NEW.payment_method IS DISTINCT FROM OLD.payment_method THEN
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
$function$
;
CREATE TRIGGER trg_enforce_ride_update_columns BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION enforce_ride_update_columns();

-- A BEFORE UPDATE trigger that rewrites NEW on every update, as prod's
-- rides_sync_coords_trg does (pickup_lat/lng from the location): if the guard
-- fired after it, every client write would look like it changed a column.
CREATE OR REPLACE FUNCTION public.scaffold_touch_coords()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  -- Stands for prod's coordinate sync, rewriting a column the client did not send.
  NEW.pickup_lat := extract(epoch FROM clock_timestamp());
  RETURN NEW;
END;
$function$;
CREATE TRIGGER rides_sync_coords_trg BEFORE INSERT OR UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION scaffold_touch_coords();

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
$function$
;
-- prod's ACL: {=X/postgres,postgres=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.update_ride_status_v2(uuid, text, double precision, double precision, boolean, boolean) TO service_role;

-- Stand-ins for the money RPCs: they write on rides what complete_ride_and_pay
-- and cancel_ride write, from inside a SECURITY DEFINER function.
CREATE OR REPLACE FUNCTION public.scaffold_complete(p_ride uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  UPDATE rides SET status = 'completed', final_fare_cup = 2000, final_fare_trc = 2000,
                   completed_at = now(), arrived_at_destination_at = COALESCE(arrived_at_destination_at, now()),
                   actual_distance_m = 2000, actual_duration_s = 600, share_token = 'rpc'
  WHERE id = p_ride;
  RETURN (SELECT status::text || '|' || final_fare_cup FROM rides WHERE id = p_ride);
END;
$function$;
CREATE OR REPLACE FUNCTION public.scaffold_cancel(p_ride uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  UPDATE rides SET status = 'canceled', canceled_at = now(), canceled_by = auth.uid(),
                   cancellation_reason = 'prueba'
  WHERE id = p_ride;
  RETURN (SELECT status::text FROM rides WHERE id = p_ride);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.scaffold_complete(uuid), public.scaffold_cancel(uuid) TO authenticated;

RESET ROLE;
