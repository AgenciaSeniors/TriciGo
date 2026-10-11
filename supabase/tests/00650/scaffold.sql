-- Scaffold for the 00650 rehearsal. Live bodies read from prod on 2026-10-10
-- (md5/length checked by S0): tg_driver_profiles_protect_admin_fields,
-- tg_driver_profiles_protect_insert, tg_driver_profiles_inactive_stays_offline,
-- tg_driver_profiles_shift_intent, tg_driver_documents_protect_review,
-- find_best_drivers, notify_offline_drivers_for_searching_rides, cron_http_post,
-- get_platform_config_numeric, get_service_role_key, current_user_role and
-- is_admin. driver_profiles, vehicles, driver_documents, selfie_checks and
-- driver_contracts carry prod's columns (those the bodies read), RLS policies,
-- triggers and grants (ALL to anon and authenticated, as in prod). net.http_post
-- records what it would send; vault holds a fake service key. A NON-superuser
-- role (prod: postgres) owns everything; run.sh applies the migration as that role.
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
CREATE SCHEMA IF NOT EXISTS vault;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER SCHEMA net OWNER TO tricigo_owner;
ALTER SCHEMA vault OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');
CREATE TYPE public.vehicle_type AS ENUM ('triciclo', 'moto', 'auto', 'confort');

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
$function$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- net.http_post records the request instead of sending it.
CREATE TABLE net.sent (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net.sent (url, headers, body) VALUES (url, headers, body) RETURNING id
$f$;
CREATE VIEW vault.decrypted_secrets AS SELECT 'service_role_key'::text AS name, 'sb_secret_test'::text AS decrypted_secret;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb);
GRANT ALL ON public.platform_config TO service_role;

CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY, jobname text NOT NULL, url text, called_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cities (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.corporate_accounts (id uuid PRIMARY KEY, is_fleet_owner boolean NOT NULL DEFAULT false);
CREATE TABLE public.driver_fleets (id uuid PRIMARY KEY, corporate_account_id uuid);
CREATE TABLE public.fleet_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fleet_id uuid, driver_id uuid, status text);
CREATE TABLE public.user_blocks (blocker_id uuid, blocked_id uuid);
CREATE TABLE public.driver_reactivation_pushes (driver_profile_id uuid PRIMARY KEY, last_pushed_at timestamptz NOT NULL);

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
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
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

CREATE OR REPLACE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_key text;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;
  RETURN v_key;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$;

CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());

-- driver_profiles: prod's columns (2026-10-10), policies and grants.
CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean NOT NULL DEFAULT false,
  current_location geography,
  current_heading numeric,
  rating_avg numeric DEFAULT 5.00,
  total_rides integer DEFAULT 0,
  total_rides_completed integer DEFAULT 0,
  zone_id uuid,
  approved_at timestamptz,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_financially_eligible boolean NOT NULL DEFAULT true,
  negative_balance_since timestamptz,
  match_score numeric DEFAULT 50.0,
  acceptance_rate numeric DEFAULT 100.0,
  total_rides_offered integer DEFAULT 0,
  custom_per_km_rate_cup integer,
  city_id uuid,
  is_on_break boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz,
  identity_number text,
  address text,
  province text,
  municipality text,
  has_criminal_record boolean,
  criminal_record_details text,
  auto_accept_enabled boolean DEFAULT false,
  grace_trips_remaining integer,
  quota_blocked boolean DEFAULT false,
  preferences jsonb,
  terms_accepted_at timestamptz,
  auto_offline_at timestamptz
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_admin_select ON public.driver_profiles FOR SELECT USING (is_admin());
CREATE POLICY dp_insert ON public.driver_profiles FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY dp_update_own ON public.driver_profiles FOR UPDATE USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
GRANT ALL ON public.driver_profiles TO anon, authenticated, service_role;

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  driver_id uuid,
  status public.ride_status NOT NULL DEFAULT 'searching',
  service_type text,
  pickup_location geography,
  is_scheduled boolean DEFAULT false,
  scheduled_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_select ON public.rides FOR SELECT USING ((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin());
GRANT ALL ON public.rides TO anon, authenticated, service_role;

CREATE TABLE public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  type public.vehicle_type NOT NULL,
  make text NOT NULL DEFAULT 'X',
  model text NOT NULL DEFAULT 'Y',
  year integer NOT NULL DEFAULT 2015,
  color text NOT NULL DEFAULT 'rojo',
  plate_number text NOT NULL DEFAULT 'P000000',
  capacity integer NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  max_cargo_length_cm integer,
  max_cargo_width_cm integer,
  max_cargo_height_cm integer,
  accepted_cargo_categories text[] DEFAULT '{}'::text[],
  accepts_cargo boolean DEFAULT false,
  max_cargo_weight_kg numeric
);
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
CREATE POLICY v_admin_select ON public.vehicles FOR SELECT USING (is_admin());
CREATE POLICY v_insert ON public.vehicles FOR INSERT WITH CHECK ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY v_select ON public.vehicles FOR SELECT USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR (driver_id IN ( SELECT r.driver_id
   FROM rides r
  WHERE (r.customer_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));
CREATE POLICY v_update ON public.vehicles FOR UPDATE USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));
GRANT ALL ON public.vehicles TO anon, authenticated, service_role;

-- driver_documents: prod's columns (document_type is an enum in prod; text here).
CREATE TABLE public.driver_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  document_type text NOT NULL,
  storage_path text NOT NULL,
  file_name text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  is_verified boolean NOT NULL DEFAULT false,
  verified_by uuid,
  verified_at timestamptz,
  rejection_reason text,
  verification_notes text,
  face_match_score real,
  liveness_passed boolean,
  mime_type text
);
ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY dd_admin_insert ON public.driver_documents FOR INSERT WITH CHECK (is_admin());
CREATE POLICY dd_admin_select ON public.driver_documents FOR SELECT USING (is_admin());
CREATE POLICY dd_insert ON public.driver_documents FOR INSERT WITH CHECK ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY dd_select ON public.driver_documents FOR SELECT USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));
CREATE POLICY dd_update ON public.driver_documents FOR UPDATE USING (is_admin());
GRANT ALL ON public.driver_documents TO anon, authenticated, service_role;

CREATE TABLE public.selfie_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL,
  storage_path text,
  face_match_score real,
  liveness_passed boolean,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz
);
ALTER TABLE public.selfie_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY sc_admin_select ON public.selfie_checks FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY selfie_checks_driver_insert ON public.selfie_checks FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM driver_profiles
  WHERE ((driver_profiles.id = selfie_checks.driver_id) AND (driver_profiles.user_id = auth.uid())))));
CREATE POLICY selfie_checks_driver_read ON public.selfie_checks FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM driver_profiles
  WHERE ((driver_profiles.id = selfie_checks.driver_id) AND (driver_profiles.user_id = auth.uid())))));
CREATE POLICY selfie_checks_driver_update ON public.selfie_checks FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM driver_profiles
  WHERE ((driver_profiles.id = selfie_checks.driver_id) AND (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM driver_profiles
  WHERE ((driver_profiles.id = selfie_checks.driver_id) AND (driver_profiles.user_id = ( SELECT auth.uid() AS uid))))) AND (status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text])) AND (face_match_score IS NULL) AND (liveness_passed IS NULL) AND (completed_at IS NULL)));
GRANT ALL ON public.selfie_checks TO anon, authenticated, service_role;

CREATE TABLE public.driver_contracts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), driver_id uuid NOT NULL);
ALTER TABLE public.driver_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY driver_contracts_admin_read ON public.driver_contracts FOR SELECT USING (is_admin());
CREATE POLICY driver_contracts_driver_read ON public.driver_contracts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM driver_profiles dp
  WHERE ((dp.id = driver_contracts.driver_id) AND (dp.user_id = auth.uid())))));
GRANT ALL ON public.driver_contracts TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_admin_fields()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- 00491 (approval gate): an active vehicle is REQUIRED before a driver can be
  -- marked 'approved'. Placed ABOVE the is_admin()/service-role bypasses on
  -- purpose — the admin approveDriver UPDATE and the auto-admin EF must both be
  -- gated. Fires only on the transition TO approved (re-saving an already
  -- approved profile is unaffected).
  IF NEW.status::text = 'approved'
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved'
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle: cannot approve driver % without a registered active vehicle', NEW.id;
  END IF;

  -- 00491 (online gate): going online also requires an active vehicle. Approval
  -- already requires one, but a vehicle could be deactivated afterwards — this
  -- keeps a vehicle-less driver from ever appearing online (and as a car).
  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND NOT EXISTS (
       SELECT 1 FROM vehicles v WHERE v.driver_id = NEW.id AND v.is_active = true
     ) THEN
    RAISE EXCEPTION 'driver_has_no_active_vehicle_for_online: register an active vehicle before going online (driver %)', NEW.id;
  END IF;

  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_online IS DISTINCT FROM OLD.is_online
     AND NEW.is_online = true
     AND COALESCE(OLD.status::text, 'pending_verification') <> 'approved' THEN
    RAISE EXCEPTION 'driver_not_approved_for_online: status=% — cannot go online until approved by admin',
      OLD.status;
  END IF;



  IF current_setting('app.trusted_driver_update', true) = '1' THEN
    NEW.status                  := OLD.status;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.identity_number         := OLD.identity_number;
    NEW.has_criminal_record     := OLD.has_criminal_record;
    NEW.criminal_record_details := OLD.criminal_record_details;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  -- Owner during onboarding: allow them to fill their identity fields and
  -- submit for review. Only while NOT yet approved. Everything else stays
  -- protected, and once approved identity_number/status fall back to admin-only.
  IF auth.uid() = NEW.user_id
     AND OLD.status::text IN ('pending_verification', 'rejected', 'under_review') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status::text IN ('pending_verification', 'rejected')
                AND NEW.status::text = 'under_review') THEN
      NEW.status := OLD.status;
    END IF;
    NEW.is_financially_eligible := OLD.is_financially_eligible;
    NEW.negative_balance_since  := OLD.negative_balance_since;
    NEW.match_score             := OLD.match_score;
    NEW.acceptance_rate         := OLD.acceptance_rate;
    NEW.total_rides             := OLD.total_rides;
    NEW.total_rides_completed   := OLD.total_rides_completed;
    NEW.total_rides_offered     := OLD.total_rides_offered;
    NEW.rating_avg              := OLD.rating_avg;
    NEW.approved_at             := OLD.approved_at;
    NEW.suspended_at            := OLD.suspended_at;
    NEW.suspended_reason        := OLD.suspended_reason;
    NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
    NEW.quota_blocked           := OLD.quota_blocked;
    NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;
    NEW.user_id                 := OLD.user_id;
    NEW.id                      := OLD.id;
    NEW.created_at              := OLD.created_at;
    RETURN NEW;
  END IF;

  NEW.status                  := OLD.status;
  NEW.is_financially_eligible := OLD.is_financially_eligible;
  NEW.negative_balance_since  := OLD.negative_balance_since;
  NEW.match_score             := OLD.match_score;
  NEW.acceptance_rate         := OLD.acceptance_rate;
  NEW.total_rides             := OLD.total_rides;
  NEW.total_rides_completed   := OLD.total_rides_completed;
  NEW.total_rides_offered     := OLD.total_rides_offered;
  NEW.rating_avg              := OLD.rating_avg;
  NEW.approved_at             := OLD.approved_at;
  NEW.suspended_at            := OLD.suspended_at;
  NEW.suspended_reason        := OLD.suspended_reason;
  NEW.grace_trips_remaining   := OLD.grace_trips_remaining;
  NEW.quota_blocked           := OLD.quota_blocked;
  NEW.identity_number         := OLD.identity_number;
  NEW.has_criminal_record     := OLD.has_criminal_record;
  NEW.criminal_record_details := OLD.criminal_record_details;
  NEW.user_id                 := OLD.user_id;
  NEW.id                      := OLD.id;
  NEW.created_at              := OLD.created_at;
  NEW.custom_per_km_rate_cup  := OLD.custom_per_km_rate_cup;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_protect_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_driver_update', true) = '1' THEN RETURN NEW; END IF;

  NEW.status                  := 'pending_verification';
  NEW.is_online               := false;
  NEW.approved_at             := NULL;
  NEW.suspended_at            := NULL;
  NEW.suspended_reason        := NULL;
  NEW.is_financially_eligible := true;
  NEW.match_score             := 50.0;
  NEW.acceptance_rate         := 100.0;
  NEW.rating_avg              := 5.00;
  NEW.total_rides             := 0;
  NEW.total_rides_completed   := 0;
  NEW.total_rides_offered     := 0;
  NEW.quota_blocked           := false;
  NEW.custom_per_km_rate_cup  := NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_inactive_stays_offline()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.is_online AND NOT OLD.is_online
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND NOT u.is_active) THEN
    NEW.is_online := false;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_profiles_shift_intent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- auth.uid() presente = lo hizo una persona (el conductor o un admin), no el
  -- cron (service_role, auth.uid() NULL). Su intención manda: se borra la marca.
  IF NEW.is_online IS DISTINCT FROM OLD.is_online AND auth.uid() IS NOT NULL THEN
    NEW.auto_offline_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_driver_documents_protect_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_admin() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.is_verified := false;
      NEW.verified_by := NULL;
      NEW.verified_at := NULL;
      NEW.rejection_reason := NULL;
      NEW.verification_notes := NULL;
      NEW.face_match_score := NULL;
      NEW.liveness_passed := NULL;
    ELSE
      NEW.is_verified := OLD.is_verified;
      NEW.verified_by := OLD.verified_by;
      NEW.verified_at := OLD.verified_at;
      NEW.rejection_reason := OLD.rejection_reason;
      NEW.verification_notes := OLD.verification_notes;
      NEW.face_match_score := OLD.face_match_score;
      NEW.liveness_passed := OLD.liveness_passed;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_best_drivers(p_pickup_lat double precision, p_pickup_lng double precision, p_service_type text, p_limit integer DEFAULT 5, p_radius_m integer DEFAULT 5000, p_is_delivery boolean DEFAULT false, p_estimated_trip_distance_m integer DEFAULT NULL::integer, p_package_category text DEFAULT NULL::text, p_estimated_weight_kg numeric DEFAULT NULL::numeric, p_package_length_cm integer DEFAULT NULL::integer, p_package_width_cm integer DEFAULT NULL::integer, p_package_height_cm integer DEFAULT NULL::integer, p_corporate_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, user_id uuid, distance_m double precision, match_score numeric, rating numeric, acceptance_rate numeric, composite double precision)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_pickup GEOGRAPHY;
  v_vehicle_types vehicle_type[];
  v_is_long_trip BOOLEAN;
  v_use_fleet_restriction BOOLEAN := false;
  v_hb_window_s NUMERIC;
BEGIN
  v_pickup := ST_SetSRID(ST_MakePoint(p_pickup_lng, p_pickup_lat), 4326)::geography;

  -- 00524: heartbeat freshness window from config. 0 (default) = no filter —
  -- with offers going to ALL candidates in parallel, a stale-GPS driver blocks
  -- nobody (the offer just expires). Setting N>0 restores the R5 hardening.
  v_hb_window_s := get_platform_config_numeric('dispatch_heartbeat_window_s', 0);

  v_vehicle_types := CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::vehicle_type, 'confort'::vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::vehicle_type]
  END;

  v_is_long_trip := COALESCE(p_estimated_trip_distance_m, 0) > 10000;

  IF p_corporate_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM corporate_accounts ca
      WHERE ca.id = p_corporate_account_id
        AND ca.is_fleet_owner = true
        AND EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = ca.id
            AND fm.status = 'active'
            AND fm.driver_id IS NOT NULL
        )
    ) INTO v_use_fleet_restriction;
  END IF;

  RETURN QUERY
  WITH eligible_drivers AS (
    SELECT
      dp.id              AS dp_id,
      dp.user_id         AS dp_user_id,
      dp.match_score     AS dp_match_score,
      dp.rating_avg      AS dp_rating,
      dp.acceptance_rate AS dp_acceptance,
      COALESCE(dp.total_rides_completed, 0) AS dp_total_rides,
      ST_Distance(dp.current_location::geography, v_pickup) AS dist_m,
      (
        SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (r.accepted_at - r.created_at))), 300)
        FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status = 'completed'
          AND r.created_at > NOW() - INTERVAL '30 days'
          AND r.accepted_at IS NOT NULL
      )::DOUBLE PRECISION AS avg_response_s
    FROM driver_profiles dp
    INNER JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    LEFT JOIN cities c ON c.id = dp.city_id
    WHERE dp.is_online = true
      AND (
        v_hb_window_s <= 0
        OR dp.last_heartbeat_at IS NULL
        OR dp.last_heartbeat_at > now() - make_interval(secs => v_hb_window_s)
      )
      AND dp.status = 'approved'
      AND dp.is_financially_eligible = true
      AND NOT dp.is_on_break
      AND dp.match_score > 10
      AND (v_vehicle_types IS NULL OR v.type = ANY(v_vehicle_types))
      AND (NOT p_is_delivery OR v.accepts_cargo = true)
      AND (
        p_package_category IS NULL
        OR (
          v.accepted_cargo_categories IS NOT NULL
          AND array_length(v.accepted_cargo_categories, 1) > 0
          AND p_package_category = ANY(v.accepted_cargo_categories::text[])
        )
      )
      AND (
        p_estimated_weight_kg IS NULL
        OR (v.max_cargo_weight_kg IS NOT NULL AND v.max_cargo_weight_kg >= p_estimated_weight_kg)
      )
      AND (
        p_package_length_cm IS NULL
        OR (v.max_cargo_length_cm IS NOT NULL AND v.max_cargo_length_cm >= p_package_length_cm)
      )
      AND (
        p_package_width_cm IS NULL
        OR (v.max_cargo_width_cm IS NOT NULL AND v.max_cargo_width_cm >= p_package_width_cm)
      )
      AND (
        p_package_height_cm IS NULL
        OR (v.max_cargo_height_cm IS NOT NULL AND v.max_cargo_height_cm >= p_package_height_cm)
      )
      AND (p_radius_m <= 0 OR ST_DWithin(dp.current_location::geography, v_pickup, p_radius_m)) AND ST_Y(dp.current_location::geometry) BETWEEN 19.3 AND 23.7 AND ST_X(dp.current_location::geometry) BETWEEN -85.2 AND -73.8
      AND (c.id IS NULL OR c.is_active = true)
      AND NOT EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = dp.id
          AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
      )
      AND (
        (dp.preferences->>'max_distance_km') IS NULL
        OR ST_Distance(dp.current_location::geography, v_pickup)
           <= ((dp.preferences->>'max_distance_km')::int * 1000)
      )
      AND (
        NOT v_is_long_trip
        OR (dp.preferences->>'accepts_long_trips') IS NULL
        OR (dp.preferences->>'accepts_long_trips')::boolean IS TRUE
      )
      AND (
        NOT v_use_fleet_restriction
        OR EXISTS (
          SELECT 1 FROM fleet_members fm
          JOIN driver_fleets df ON df.id = fm.fleet_id
          WHERE df.corporate_account_id = p_corporate_account_id
            AND fm.driver_id = dp.user_id
            AND fm.status = 'active'
        )
      )
  )
  SELECT
    ed.dp_id, ed.dp_user_id, ed.dist_m,
    ed.dp_match_score, ed.dp_rating, ed.dp_acceptance,
    (
      0.30 * (1.0 - LEAST(ed.dist_m / GREATEST(p_radius_m, 10000)::DOUBLE PRECISION, 1.0)) +
      0.25 * (COALESCE(ed.dp_match_score, 50)::DOUBLE PRECISION / 100.0) +
      0.20 * (COALESCE(ed.dp_rating, 4.0)::DOUBLE PRECISION / 5.0) +
      0.10 * (COALESCE(ed.dp_acceptance, 80)::DOUBLE PRECISION / 100.0) +
      0.10 * (1.0 - LEAST(ed.avg_response_s / 300.0, 1.0)) +
      0.05 * LEAST(ed.dp_total_rides::DOUBLE PRECISION / 100.0, 1.0)
    ) AS composite
  FROM eligible_drivers ed
  ORDER BY composite DESC
  LIMIT (CASE WHEN p_limit > 0 THEN p_limit END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_offline_drivers_for_searching_rides()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_enabled      TEXT;
  v_after_s      INT;
  v_cooldown_s   INT;
  v_service_key  TEXT;
  v_headers      JSONB;
  v_group        RECORD;
  v_user_ids     JSONB;
  v_dp_ids       UUID[];
  v_total        INT := 0;
  v_title        TEXT;
  v_body         TEXT;
BEGIN
  -- Kill switch. jsonb value read via #>> '{}' matches both boolean false and
  -- string "false" (platform_config jsonb trap).
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'reactivation_push_enabled';
  IF v_enabled IN ('false', 'f') THEN RETURN 0; END IF;

  v_after_s    := GREATEST(0, get_platform_config_numeric('reactivation_push_after_s', 60))::int;
  v_cooldown_s := GREATEST(60, get_platform_config_numeric('reactivation_push_cooldown_s', 1800))::int;

  v_service_key := get_service_role_key();
  IF v_service_key IS NULL OR v_service_key = '' THEN RETURN 0; END IF;
  v_headers := jsonb_build_object(
    'Content-Type',  'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey',        v_service_key
  );

  -- One push batch per vehicle-type label so the copy can name the service.
  -- Stamping the cooldown between groups dedupes drivers who match several
  -- searching rides of different types.
  FOR v_group IN
    SELECT
      CASE
        WHEN r.service_type LIKE 'triciclo%' THEN 'triciclo'
        WHEN r.service_type LIKE 'moto%'     THEN 'moto'
        WHEN r.service_type LIKE 'auto%'     THEN 'auto'
        WHEN r.service_type = 'mensajeria'   THEN 'mensajeria'
        ELSE 'triciclo'
      END AS label
    FROM rides r
    WHERE r.status = 'searching'
      AND r.created_at <= now() - make_interval(secs => v_after_s)
      AND NOT (COALESCE(r.is_scheduled, false) AND r.scheduled_at IS NOT NULL AND r.scheduled_at > now())
    GROUP BY 1
  LOOP
    -- Candidates: approved + OFFLINE, financially eligible, active vehicle of
    -- the requested type (auto covers confort; mensajería = any cargo vehicle),
    -- not blocked either way with ANY searching customer of this group, and
    -- outside their reactivation cooldown. No geographic filter — the user's
    -- explicit choice while the whole fleet is in Havana (conscious debt:
    -- add a radius when multi-province supply exists).
    SELECT array_agg(DISTINCT dp.id), jsonb_agg(DISTINCT dp.user_id)
      INTO v_dp_ids, v_user_ids
    FROM driver_profiles dp
    JOIN vehicles v ON v.driver_id = dp.id AND v.is_active = true
    WHERE dp.status = 'approved'
      AND dp.is_online = false
      AND dp.is_financially_eligible = true
      AND dp.match_score > 10 AND (dp.current_location IS NULL OR (   ST_Y(dp.current_location::geometry) BETWEEN 19.3 AND 23.7   AND ST_X(dp.current_location::geometry) BETWEEN -85.2 AND -73.8))
      AND (
        (v_group.label = 'triciclo'   AND v.type = 'triciclo')
        OR (v_group.label = 'moto'    AND v.type = 'moto')
        OR (v_group.label = 'auto'    AND v.type IN ('auto', 'confort'))
        OR (v_group.label = 'mensajeria' AND v.accepts_cargo = true)
      )
      AND NOT EXISTS (
        SELECT 1 FROM driver_reactivation_pushes p
        WHERE p.driver_profile_id = dp.id
          AND p.last_pushed_at > now() - make_interval(secs => v_cooldown_s)
      )
      AND EXISTS (
        SELECT 1 FROM rides r2
        WHERE r2.status = 'searching'
          AND r2.created_at <= now() - make_interval(secs => v_after_s)
          AND NOT (COALESCE(r2.is_scheduled, false) AND r2.scheduled_at IS NOT NULL AND r2.scheduled_at > now())
          AND (CASE
                 WHEN r2.service_type LIKE 'triciclo%' THEN 'triciclo'
                 WHEN r2.service_type LIKE 'moto%'     THEN 'moto'
                 WHEN r2.service_type LIKE 'auto%'     THEN 'auto'
                 WHEN r2.service_type = 'mensajeria'   THEN 'mensajeria'
                 ELSE 'triciclo'
               END) = v_group.label
          AND NOT EXISTS (
            SELECT 1 FROM public.user_blocks ub
            WHERE (ub.blocker_id = r2.customer_id AND ub.blocked_id = dp.user_id)
               OR (ub.blocker_id = dp.user_id AND ub.blocked_id = r2.customer_id)
          )
      );

    IF v_dp_ids IS NULL OR array_length(v_dp_ids, 1) IS NULL THEN
      CONTINUE;
    END IF;

    IF v_group.label = 'mensajeria' THEN
      v_title := '📦 Hay una entrega esperando conductor';
      v_body  := 'Conéctate en TriciGo para tomar la entrega.';
    ELSE
      v_title := '🚕 Un pasajero está buscando ' || v_group.label;
      v_body  := 'Conéctate en TriciGo para tomar el viaje.';
    END IF;

    BEGIN
      PERFORM public.cron_http_post('driver-reactivation-push', 
        url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
        headers := v_headers,
        body    := jsonb_build_object(
          'user_ids', v_user_ids,
          'title',    v_title,
          'body',     v_body,
          'category', 'ride_matching',
          'data', jsonb_build_object('reason', 'driver_reactivation')
        )
      );

      INSERT INTO driver_reactivation_pushes (driver_profile_id, last_pushed_at)
      SELECT unnest(v_dp_ids), now()
      ON CONFLICT (driver_profile_id) DO UPDATE SET last_pushed_at = now();

      v_total := v_total + COALESCE(array_length(v_dp_ids, 1), 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[reactivation_push] group % failed: % %', v_group.label, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN v_total;
END;
$function$;

-- prod's triggers on these tables (the ones the tests go through).
CREATE TRIGGER trg_driver_profiles_inactive_stays_offline BEFORE UPDATE OF is_online ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION tg_driver_profiles_inactive_stays_offline();
CREATE TRIGGER trg_driver_profiles_protect_admin_fields BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION tg_driver_profiles_protect_admin_fields();
CREATE TRIGGER trg_driver_profiles_protect_insert BEFORE INSERT ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION tg_driver_profiles_protect_insert();
CREATE TRIGGER trg_driver_profiles_shift_intent BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION tg_driver_profiles_shift_intent();
CREATE TRIGGER trg_driver_documents_protect_review BEFORE INSERT OR UPDATE ON public.driver_documents FOR EACH ROW EXECUTE FUNCTION tg_driver_documents_protect_review();
