-- Scaffold for the 00630 rehearsal: the LIVE production shapes of dispatch_ride, of
-- every function that calls it, and of the triggers and cron entry points that reach
-- it, transcribed from pg_get_functiondef, pg_trigger, pg_policy and proacl on
-- 2026-10-07 (00627 applied). No Supabase stack: auth.uid() reads
-- request.jwt.claim.sub like PostgREST sets it.
--
-- The owner is a NON-superuser role named postgres, as in prod. The name matters
-- here: dispatch_ride's old check compares current_user with the literal 'postgres',
-- so with any other owner the check would fire and the rehearsal would not reproduce
-- prod. The cluster's superuser is pgtest; run.sh applies the migration as postgres.
-- Also as in prod, postgres is a member of anon, authenticated and service_role and
-- inherits their privileges, so it can run dispatch_ride while any of them can.
--
-- Live bodies (run.sh S0 compares md5/length of prosrc with prod): dispatch_ride,
-- on_ride_insert_dispatch, tg_dispatch_on_delivery_details,
-- dispatch_searching_rides_near_driver, dispatch_searching_rides_for_driver,
-- tg_redispatch_searching_on_ride_freed, retry_dispatch_expired_rides,
-- activate_scheduled_rides, notify_driver_new_offer, get_platform_config_numeric,
-- is_admin, current_user_role, auth.uid.
-- Stubs, with the live signatures and ACLs:
--   * PostGIS: geography and geometry are domains over text holding 'POINT(lng lat)';
--     ST_X/ST_Y parse it and ST_DWithin is always true (every ride is "near").
--   * find_best_drivers returns every online driver with fixed scores.
--   * net.http_post records each call in net.http_request_queue (one row = one push);
--     get_service_role_key returns a constant; notify_offline_drivers_for_searching_rides
--     returns 0.
-- Not modelled: the BEFORE triggers on rides (fare floor, rate limit, scheduling
-- normalization), trg_notify_dispatch_retry (the rider's "Seguimos buscando" push on
-- rounds 2 and 3, which would add to the push counts), the ride_offers stats triggers,
-- and the policies the tests do not use.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
CREATE SCHEMA IF NOT EXISTS net AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

-- PostGIS stand-ins (prod: PostGIS 3.3.7 in public)
CREATE DOMAIN public.geography AS text;
CREATE DOMAIN public.geometry AS text;
CREATE FUNCTION public.st_x(g public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE
  AS $f$ SELECT split_part(btrim(g, 'POINT()'), ' ', 1)::double precision $f$;
CREATE FUNCTION public.st_y(g public.geometry) RETURNS double precision LANGUAGE sql IMMUTABLE
  AS $f$ SELECT split_part(btrim(g, 'POINT()'), ' ', 2)::double precision $f$;
CREATE FUNCTION public.st_dwithin(a public.geography, b public.geography, d double precision)
  RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT true $f$;

-- pg_net stand-in: one row per request instead of an HTTP call
CREATE TABLE net.http_request_queue (
  id bigserial PRIMARY KEY,
  url text NOT NULL,
  headers jsonb,
  body jsonb
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
  RETURNS bigint LANGUAGE sql
  AS $f$ INSERT INTO net.http_request_queue (url, headers, body) VALUES (url, headers, body) RETURNING id $f$;

-- Tables, with the live columns the bodies read (types as in prod)
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer'
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE TABLE public.platform_config (
  key text NOT NULL PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.customer_profiles (
  user_id uuid NOT NULL,
  rating_avg numeric NOT NULL DEFAULT 5.00
);

CREATE TABLE public.user_blocks (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  is_online boolean NOT NULL DEFAULT false,
  current_location public.geography
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.driver_profiles TO anon, authenticated;
GRANT ALL ON public.driver_profiles TO service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid,
  service_type text NOT NULL,
  status public.ride_status NOT NULL DEFAULT 'searching',
  pickup_location public.geography NOT NULL,
  pickup_address text NOT NULL,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  scheduled_at timestamp with time zone,
  is_scheduled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  scheduled_notified boolean DEFAULT false,
  corporate_account_id uuid,
  ride_mode text NOT NULL DEFAULT 'passenger',
  dispatch_round integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamp with time zone
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.rides TO anon, authenticated;
GRANT ALL ON public.rides TO service_role;

CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'superseded'::text])),
  composite_score numeric,
  distance_m double precision,
  offered_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  responded_at timestamp with time zone,
  CONSTRAINT ride_offers_ride_id_driver_profile_id_key UNIQUE (ride_id, driver_profile_id)
);
ALTER TABLE public.ride_offers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.ride_offers TO anon;   -- prod grants; no policy lets them through
GRANT SELECT ON public.ride_offers TO authenticated;

CREATE TABLE public.delivery_details (
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  package_category text,
  estimated_weight_kg numeric,
  package_length_cm integer,
  package_width_cm integer,
  package_height_cm integer
);
ALTER TABLE public.delivery_details ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.delivery_details TO anon, authenticated;

-- LIVE helpers ------------------------------------------------------------
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
$function$
;

-- LIVE policies the tests go through
CREATE POLICY r_insert ON public.rides FOR INSERT
  WITH CHECK ((customer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY r_select_customer ON public.rides FOR SELECT
  USING (((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY dp_update_own ON public.driver_profiles FOR UPDATE
  USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY "Customers create delivery details" ON public.delivery_details FOR INSERT
  WITH CHECK ((EXISTS ( SELECT 1
   FROM rides
  WHERE ((rides.id = delivery_details.ride_id) AND (rides.customer_id = auth.uid())))));

-- Stubs with the live signatures ------------------------------------------
CREATE FUNCTION public.find_best_drivers(p_pickup_lat double precision, p_pickup_lng double precision,
  p_service_type text, p_limit integer DEFAULT 5, p_radius_m integer DEFAULT 5000,
  p_is_delivery boolean DEFAULT false, p_estimated_trip_distance_m integer DEFAULT NULL::integer,
  p_package_category text DEFAULT NULL::text, p_estimated_weight_kg numeric DEFAULT NULL::numeric,
  p_package_length_cm integer DEFAULT NULL::integer, p_package_width_cm integer DEFAULT NULL::integer,
  p_package_height_cm integer DEFAULT NULL::integer, p_corporate_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, distance_m double precision, match_score numeric, rating numeric,
               acceptance_rate numeric, composite double precision)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $f$
  SELECT dp.id, dp.user_id, 800::double precision, 1.0::numeric, 4.8::numeric, 0.9::numeric, 0.75::double precision
  FROM public.driver_profiles dp
  WHERE dp.is_online
  ORDER BY dp.id
$f$;

CREATE FUNCTION public.get_service_role_key()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 AS $f$ SELECT 'sb_secret_rehearsal'::text $f$;

CREATE FUNCTION public.notify_offline_drivers_for_searching_rides()
 RETURNS integer LANGUAGE sql SECURITY DEFINER
 AS $f$ SELECT 0 $f$;

-- LIVE dispatch_ride (md5 a16ae76866950dedd21d33595f345d63, length 5537) ----
CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride         rides%ROWTYPE;
  v_pickup_lat   double precision;
  v_pickup_lng   double precision;
  v_is_delivery  boolean;
  v_count        int := 0;
  v_round        int;
  v_offer_ttl_s  int;
  v_rider_rating numeric;
  v_threshold    numeric;
  v_limit        int;
  v_eff_radius   int;
  v_gated        boolean := false;
  v_reoffer_cooldown_s int;
BEGIN
  IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN
    RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only';
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','ride_not_found'); END IF;
  IF v_ride.status <> 'searching' THEN
    RETURN jsonb_build_object('error','ride_not_searching','status',v_ride.status);
  END IF;

  v_pickup_lat := ST_Y(v_ride.pickup_location::geometry);
  v_pickup_lng := ST_X(v_ride.pickup_location::geometry);
  v_is_delivery := (v_ride.ride_mode = 'cargo' OR v_ride.service_type = 'mensajeria');

  -- 00512: a cargo ride is INSERTed before its delivery_details row exists, and
  -- this runs inside the ride's own INSERT trigger. Dispatching now would mean
  -- dispatching without the package specs. Defer; trg_dispatch_on_delivery_details
  -- re-dispatches as soon as the specs land.
  IF v_is_delivery AND NOT EXISTS (
    SELECT 1 FROM delivery_details dd WHERE dd.ride_id = p_ride_id
  ) THEN
    RETURN jsonb_build_object('success', true, 'offers_created', 0,
                              'dispatch_round', v_ride.dispatch_round,
                              'deferred', 'awaiting_delivery_details');
  END IF;
  v_round := v_ride.dispatch_round + 1;

  -- 00524: radius and candidate limit come from config, not from the caller.
  -- 0 = unlimited/all (the low-supply default). The p_radius_m parameter is
  -- retained only so existing callers (insert trigger, retry cron, driver-online
  -- dispatcher) keep compiling.
  v_eff_radius := CASE WHEN get_platform_config_numeric('dispatch_stage1_seconds', 45) > 0  AND get_platform_config_numeric('dispatch_stage1_radius_m', 8000) > 0  AND v_ride.created_at > now() - make_interval(secs => get_platform_config_numeric('dispatch_stage1_seconds', 45)) THEN GREATEST(0, get_platform_config_numeric('dispatch_stage1_radius_m', 8000))::int ELSE GREATEST(0, get_platform_config_numeric('dispatch_max_radius_m', 0))::int END;
  v_limit      := GREATEST(0, get_platform_config_numeric('dispatch_offer_limit', 0))::int;
  v_reoffer_cooldown_s := GREATEST(0, get_platform_config_numeric('reoffer_cooldown_s', 120))::int;

  SELECT COALESCE((value)::int, 30) INTO v_offer_ttl_s
  FROM platform_config WHERE key = 'offer_ttl_seconds';
  IF v_offer_ttl_s IS NULL OR v_offer_ttl_s < 5 THEN v_offer_ttl_s := 30; END IF;

  -- Soft low-rating rider gate (first round only)
  v_threshold := get_platform_config_numeric('low_rating_rider_threshold', 3.0);
  IF v_round = 1 AND v_threshold > 0 THEN
    SELECT cp.rating_avg INTO v_rider_rating
      FROM customer_profiles cp WHERE cp.user_id = v_ride.customer_id;
    IF v_rider_rating IS NOT NULL AND v_rider_rating < v_threshold THEN
      v_gated := true;
      v_limit := GREATEST(1, get_platform_config_numeric('low_rating_rider_dispatch_limit', 5)::int);
      v_eff_radius := GREATEST(500, get_platform_config_numeric('low_rating_rider_radius_m', 3000)::int);
    END IF;
  END IF;

  -- 00524: EXPIRED offers past the cooldown re-arm (status back to 'pending',
  -- fresh TTL) so a distracted driver rings again while the ride keeps
  -- searching. Rejected/accepted/superseded offers are never touched.
  -- trg_notify_driver_reoffer (below) re-fires the push for re-arms.
  INSERT INTO ride_offers (ride_id, driver_profile_id, composite_score, distance_m, expires_at)
  SELECT p_ride_id, fbd.id, fbd.composite, fbd.distance_m,
         now() + (v_offer_ttl_s || ' seconds')::interval
  FROM find_best_drivers(
    v_pickup_lat,
    v_pickup_lng,
    v_ride.service_type,
    v_limit,
    v_eff_radius,
    v_is_delivery,
    v_ride.estimated_distance_m,
    (SELECT dd.package_category  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.estimated_weight_kg FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_length_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_width_cm  FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    (SELECT dd.package_height_cm FROM delivery_details dd WHERE dd.ride_id = p_ride_id),
    v_ride.corporate_account_id
  ) fbd
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_blocks ub
    WHERE (ub.blocker_id = v_ride.customer_id AND ub.blocked_id = fbd.user_id)
       OR (ub.blocker_id = fbd.user_id AND ub.blocked_id = v_ride.customer_id)
  )
  ON CONFLICT (ride_id, driver_profile_id) DO UPDATE
    SET status          = 'pending',
        expires_at      = EXCLUDED.expires_at,
        composite_score = EXCLUDED.composite_score,
        distance_m      = EXCLUDED.distance_m,
        responded_at    = NULL
    WHERE ride_offers.status = 'expired'
      AND ride_offers.expires_at < now() - make_interval(secs => v_reoffer_cooldown_s);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  UPDATE rides SET dispatch_round = v_round, last_dispatched_at = now() WHERE id = p_ride_id;

  RETURN jsonb_build_object('success', true, 'offers_created', v_count,
                            'dispatch_round', v_round, 'ttl_seconds', v_offer_ttl_s,
                            'low_rating_gated', v_gated);
END;
$function$
;

-- LIVE callers ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_ride_insert_dispatch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.status = 'searching'
     AND (NEW.is_scheduled IS NOT TRUE
          OR NEW.scheduled_at IS NULL
          OR NEW.scheduled_at <= now()) THEN
    IF NEW.is_scheduled IS TRUE AND NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at <= now() THEN
      UPDATE rides SET scheduled_notified = true WHERE id = NEW.id;
    END IF;
    PERFORM dispatch_ride(NEW.id);
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_dispatch_on_delivery_details()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status       TEXT;
  v_is_scheduled BOOLEAN;
  v_scheduled_at TIMESTAMPTZ;
BEGIN
  SELECT r.status::text, r.is_scheduled, r.scheduled_at
    INTO v_status, v_is_scheduled, v_scheduled_at
  FROM rides r WHERE r.id = NEW.ride_id;

  IF v_status = 'searching'
     AND (v_is_scheduled IS NOT TRUE
          OR v_scheduled_at IS NULL
          OR v_scheduled_at <= now()) THEN
    PERFORM dispatch_ride(NEW.ride_id);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[dispatch_on_delivery_details] ride %: % %', NEW.ride_id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_for_driver(p_driver_profile_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r     record;
  v_loc geography;
  v_max_radius_m int;
BEGIN
  SELECT current_location INTO v_loc
  FROM driver_profiles
  WHERE id = p_driver_profile_id;

  IF v_loc IS NULL THEN RETURN; END IF;

  -- 00524: same config as dispatch_ride. 0 = no distance cap.
  v_max_radius_m := GREATEST(0, get_platform_config_numeric('dispatch_max_radius_m', 0))::int;

  FOR r IN
    SELECT id FROM rides
    WHERE status = 'searching'
      AND pickup_location IS NOT NULL
      AND (v_max_radius_m <= 0 OR ST_DWithin(pickup_location, v_loc, v_max_radius_m))
  LOOP
    PERFORM dispatch_ride(r.id);
  END LOOP;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.dispatch_searching_rides_near_driver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.current_location IS NULL THEN RETURN NEW; END IF;
  PERFORM dispatch_searching_rides_for_driver(NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.tg_redispatch_searching_on_ride_freed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  PERFORM dispatch_searching_rides_for_driver(NEW.driver_id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.retry_dispatch_expired_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_processed   int := 0;
BEGIN
  FOR r IN
    SELECT id, dispatch_round
    FROM rides
    WHERE status = 'searching'
      AND (dispatch_round >= 1 OR ride_mode = 'cargo')
      AND COALESCE(last_dispatched_at, created_at) < now() - interval '30 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM ride_offers o
        WHERE o.ride_id = rides.id
          AND o.status = 'pending'
          AND o.expires_at > now()
      )
  LOOP
    -- 00524: no radius ladder — dispatch_ride resolves radius/limit from
    -- platform_config (default: unlimited / all eligible drivers).
    PERFORM dispatch_ride(r.id);
    v_processed := v_processed + 1;
  END LOOP;

  -- 00524: nudge the dormant offline network. Own exception guard — a push
  -- problem must never break the dispatch retry loop.
  BEGIN
    PERFORM notify_offline_drivers_for_searching_rides();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[retry_dispatch] reactivation push failed: % %', SQLSTATE, SQLERRM;
  END;

  RETURN v_processed;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.activate_scheduled_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ride RECORD;
  v_activated INTEGER := 0;
BEGIN
  FOR v_ride IN
    SELECT r.id
    FROM rides r
    WHERE r.is_scheduled = true
      AND r.scheduled_notified = false
      AND r.status = 'searching'
      AND r.scheduled_at IS NOT NULL
      AND r.scheduled_at <= NOW() + interval '10 minutes'
      AND r.scheduled_at >  NOW() - interval '15 minutes'
  LOOP
    BEGIN
      UPDATE rides SET scheduled_notified = true WHERE id = v_ride.id;
      PERFORM dispatch_ride(v_ride.id);
      v_activated := v_activated + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'activate_scheduled_rides: ride % no activado (%) — queda pending, reintenta', v_ride.id, SQLERRM;
    END;
  END LOOP;

  RETURN v_activated;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_driver_new_offer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_driver_user_id UUID;
  v_ride           rides%ROWTYPE;
  v_service_key    TEXT;
  v_headers        JSONB;
  v_trip_km        NUMERIC;
  v_pickup_short   TEXT;
  v_title          TEXT;
  v_body           TEXT;
  v_fare_label     TEXT;
BEGIN
  SELECT user_id INTO v_driver_user_id
  FROM driver_profiles
  WHERE id = NEW.driver_profile_id;

  IF v_driver_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_ride FROM rides WHERE id = NEW.ride_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Trip distance (pickup -> dropoff), not driver->pickup. Always
  -- populated for a real ride; never the misleading "0.0 km".
  v_trip_km := ROUND(COALESCE(v_ride.estimated_distance_m, 0)::numeric / 1000.0, 1);

  v_pickup_short := LEFT(COALESCE(v_ride.pickup_address, ''), 50);
  IF LENGTH(COALESCE(v_ride.pickup_address, '')) > 50 THEN
    v_pickup_short := v_pickup_short || '…';
  END IF;

  v_fare_label := COALESCE(v_ride.estimated_fare_cup, 0)::TEXT || ' CUP';

  v_title := 'Viaje disponible cerca';
  v_body  := 'Recogida: ' || v_pickup_short
    || CASE WHEN v_trip_km > 0 THEN ' · Viaje ' || v_trip_km || ' km' ELSE '' END
    || ' · ' || v_fare_label;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN
    RETURN NEW;
  END IF;

  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  PERFORM net.http_post(
    url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
    headers := v_headers,
    body    := jsonb_build_object(
      'user_id',  v_driver_user_id::text,
      'title',    v_title,
      'body',     v_body,
      'category', 'ride_offer',
      'data', jsonb_build_object(
        'type',       'ride_offer',
        'ride_id',    NEW.ride_id::text,
        'offer_id',   NEW.id::text,
        'expires_at', NEW.expires_at,
        'service_type', v_ride.service_type
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_driver_new_offer] exception for offer %: % %', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$
;

-- LIVE triggers (pg_get_triggerdef on 2026-10-07) --------------------------
CREATE TRIGGER trg_on_ride_insert_dispatch AFTER INSERT ON public.rides
  FOR EACH ROW EXECUTE FUNCTION on_ride_insert_dispatch();
CREATE TRIGGER trg_redispatch_searching_on_ride_freed AFTER UPDATE OF status ON public.rides
  FOR EACH ROW WHEN (((old.status = ANY (ARRAY['accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status, 'in_progress'::ride_status, 'arrived_at_destination'::ride_status])) AND (new.status = ANY (ARRAY['completed'::ride_status, 'canceled'::ride_status])) AND (new.driver_id IS NOT NULL)))
  EXECUTE FUNCTION tg_redispatch_searching_on_ride_freed();
CREATE TRIGGER trg_dispatch_on_delivery_details AFTER INSERT ON public.delivery_details
  FOR EACH ROW EXECUTE FUNCTION tg_dispatch_on_delivery_details();
CREATE TRIGGER trg_dispatch_on_driver_online AFTER UPDATE OF is_online ON public.driver_profiles
  FOR EACH ROW WHEN (((new.is_online = true) AND (old.is_online IS DISTINCT FROM new.is_online)))
  EXECUTE FUNCTION dispatch_searching_rides_near_driver();
CREATE TRIGGER trg_notify_driver_new_offer AFTER INSERT ON public.ride_offers
  FOR EACH ROW EXECUTE FUNCTION notify_driver_new_offer();
CREATE TRIGGER trg_notify_driver_reoffer AFTER UPDATE OF status ON public.ride_offers
  FOR EACH ROW WHEN (((old.status = 'expired'::text) AND (new.status = 'pending'::text)))
  EXECUTE FUNCTION notify_driver_new_offer();

-- LIVE proacl on 2026-10-07 -------------------------------------------------
-- dispatch_ride: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
REVOKE ALL ON FUNCTION public.dispatch_ride(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) TO authenticated, service_role;
-- current_user_role: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;
-- is_admin: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
-- {postgres=X/postgres,service_role=X/postgres}
DO $acl$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'public.on_ride_insert_dispatch()', 'public.retry_dispatch_expired_rides()',
    'public.activate_scheduled_rides()', 'public.dispatch_searching_rides_for_driver(uuid)',
    'public.dispatch_searching_rides_near_driver()', 'public.notify_driver_new_offer()',
    'public.get_platform_config_numeric(text, numeric)', 'public.get_service_role_key()',
    'public.notify_offline_drivers_for_searching_rides()',
    'public.find_best_drivers(double precision, double precision, text, integer, integer, boolean, integer, text, numeric, integer, integer, integer, uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', s);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', s);
  END LOOP;
END
$acl$;
-- tg_dispatch_on_delivery_details, tg_redispatch_searching_on_ride_freed:
-- {=X/postgres,postgres=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.tg_dispatch_on_delivery_details() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_redispatch_searching_on_ride_freed() TO service_role;

RESET ROLE;
