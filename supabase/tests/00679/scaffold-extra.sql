-- What the 00679 rehearsal needs on top of the 00650 scaffold + migration 00650.
-- run.sh loads this after checking that find_best_drivers and
-- notify_offline_drivers_for_searching_rides carry today's live bodies.
-- Live bodies copied verbatim (md5 of prosrc checked by run.sh S0):
--   _driver_can_serve_ride 733f31677b6c4c146efa6434976180a8 (00628)
--   _vehicle_types_for_service 5299ab645064c495257109e7e53c6e4e (00669)
--   is_super_admin (00291)
-- Stubs: recompute_cup_from_usd_prices (min fares only, at 330 CUP/USD),
-- _user_id_by_verified_phone (one confirmed account per number, or nothing).
-- The test schema tst holds the PASS/FAIL helper and is not part of prod.
SET ROLE tricigo_owner;

-- ── Columns prod has and the 00650 scaffold does not ──────────
ALTER TABLE public.users ADD COLUMN phone text;
ALTER TABLE public.rides
  ADD COLUMN ride_mode text DEFAULT 'passenger',
  ADD COLUMN corporate_account_id uuid,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN final_fare_cup integer,
  ADD COLUMN completed_at timestamptz;
-- prod: riders create their own rides (the guard of 00679 fires before this check).
CREATE POLICY r_insert ON public.rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));

-- vault with a removable key (T18).
CREATE TABLE vault.secret_store (name text PRIMARY KEY, decrypted_secret text);
INSERT INTO vault.secret_store VALUES ('service_role_key', 'sb_secret_test');
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT name, decrypted_secret FROM vault.secret_store;

CREATE TABLE auth.users (id uuid PRIMARY KEY, phone text, phone_confirmed_at timestamptz);

-- ── Price tables (00480 CHECKs) ───────────────────────────────
CREATE TABLE public.service_type_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name_es text,
  name_en text,
  base_fare_cup integer NOT NULL DEFAULT 0,
  per_km_rate_cup integer NOT NULL DEFAULT 0,
  per_minute_rate_cup integer NOT NULL DEFAULT 0,
  min_fare_cup integer NOT NULL DEFAULT 0,
  max_passengers integer,
  icon_name text,
  is_active boolean NOT NULL DEFAULT true,
  per_wait_minute_rate_cup integer,
  free_wait_minutes integer,
  base_fare_usd numeric,
  per_km_rate_usd numeric,
  per_minute_rate_usd numeric,
  min_fare_usd numeric,
  per_wait_minute_rate_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_type_configs_fares_nonnegative_chk CHECK (
    base_fare_cup >= 0
    AND per_km_rate_cup >= 0
    AND per_minute_rate_cup >= 0
    AND min_fare_cup >= 0
    AND (per_wait_minute_rate_cup IS NULL OR per_wait_minute_rate_cup >= 0)
    AND (base_fare_usd IS NULL OR base_fare_usd >= 0)
    AND (per_km_rate_usd IS NULL OR per_km_rate_usd >= 0)
    AND (per_minute_rate_usd IS NULL OR per_minute_rate_usd >= 0)
    AND (min_fare_usd IS NULL OR min_fare_usd >= 0)
    AND (per_wait_minute_rate_usd IS NULL OR per_wait_minute_rate_usd >= 0)
  )
);
ALTER TABLE public.service_type_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY stc_select ON public.service_type_configs FOR SELECT USING (true);
GRANT SELECT ON public.service_type_configs TO anon, authenticated;
GRANT ALL ON public.service_type_configs TO service_role;

CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id uuid,
  service_type text NOT NULL,
  base_fare_cup integer NOT NULL DEFAULT 0,
  per_km_rate_cup integer NOT NULL DEFAULT 0,
  per_minute_rate_cup integer NOT NULL DEFAULT 0,
  min_fare_cup integer NOT NULL DEFAULT 0,
  time_window_start time,
  time_window_end time,
  day_of_week integer[],
  is_active boolean NOT NULL DEFAULT true,
  city_id uuid,
  base_fare_usd numeric,
  per_km_rate_usd numeric,
  per_minute_rate_usd numeric,
  min_fare_usd numeric,
  per_wait_minute_rate_cup integer,
  per_wait_minute_rate_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_fares_nonnegative_chk CHECK (
    base_fare_cup >= 0
    AND per_km_rate_cup >= 0
    AND per_minute_rate_cup >= 0
    AND min_fare_cup >= 0
    AND (base_fare_usd IS NULL OR base_fare_usd >= 0)
    AND (per_km_rate_usd IS NULL OR per_km_rate_usd >= 0)
    AND (per_minute_rate_usd IS NULL OR per_minute_rate_usd >= 0)
    AND (min_fare_usd IS NULL OR min_fare_usd >= 0)
  )
);
ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY pr_select ON public.pricing_rules FOR SELECT USING (true);
GRANT SELECT ON public.pricing_rules TO anon, authenticated;
GRANT ALL ON public.pricing_rules TO service_role;

-- ── Audit and logs ────────────────────────────────────────────
CREATE TABLE public.admin_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES public.users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_actions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.admin_actions TO service_role;

CREATE TABLE public.rpc_attempt_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.rpc_attempt_log ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid,
  p_outcome text, p_metadata jsonb DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO public.rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;

CREATE TABLE public.driver_heartbeat_log (
  driver_profile_id uuid NOT NULL,
  beat_at timestamptz NOT NULL,
  is_online boolean
);

-- ── Helpers prod has ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = auth.uid()
      AND role = 'super_admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.recompute_cup_from_usd_prices()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  UPDATE public.service_type_configs SET min_fare_cup = round(min_fare_usd * 330) WHERE min_fare_usd IS NOT NULL;
  UPDATE public.pricing_rules SET min_fare_cup = round(min_fare_usd * 330) WHERE min_fare_usd IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public._user_id_by_verified_phone(p_phone text)
 RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE WHEN count(*) = 1 THEN min(u.id::text)::uuid END
    FROM auth.users u
   WHERE u.phone = regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g')
     AND u.phone_confirmed_at IS NOT NULL
$function$;
REVOKE ALL ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._vehicle_types_for_service(p_service_type text)
 RETURNS vehicle_type[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN p_service_type LIKE 'triciclo%' THEN ARRAY['triciclo'::public.vehicle_type]
    WHEN p_service_type LIKE 'moto%'     THEN ARRAY['moto'::public.vehicle_type]
    -- Confort only to Confort, as find_best_drivers does since 00650.
    WHEN p_service_type = 'auto_confort' THEN ARRAY['confort'::public.vehicle_type]
    WHEN p_service_type LIKE 'auto%'     THEN ARRAY['auto'::public.vehicle_type, 'confort'::public.vehicle_type]
    WHEN p_service_type = 'mensajeria'   THEN NULL
    ELSE ARRAY['triciclo'::public.vehicle_type]
  END
$function$;

CREATE OR REPLACE FUNCTION public._driver_can_serve_ride(p_driver_id uuid, p_service_type text, p_is_delivery boolean)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND v.is_active
      AND (public._vehicle_types_for_service(p_service_type) IS NULL
           OR v.type = ANY (public._vehicle_types_for_service(p_service_type)))
      AND (NOT p_is_delivery OR v.accepts_cargo IS TRUE)
  )
$$;
REVOKE ALL ON FUNCTION public._vehicle_types_for_service(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._driver_can_serve_ride(uuid, text, boolean) FROM PUBLIC, anon, authenticated;

-- ── Seed ──────────────────────────────────────────────────────
-- moto_standard as in prod on 2026-11-08 (USD = CUP / 330).
INSERT INTO public.service_type_configs
  (slug, name_es, name_en, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, max_passengers,
   icon_name, is_active, per_wait_minute_rate_cup, free_wait_minutes,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd, per_wait_minute_rate_usd)
VALUES
  ('moto_standard', 'Moto', 'Motorbike', 0, 388, 0, 753, 1, 'moto', true, 20, 5,
   0, 388 / 330.0, 0, 753 / 330.0, 20 / 330.0),
  ('triciclo_basico', 'Triciclo', 'Tricycle', 0, 500, 0, 1250, 3, 'triciclo', true, 20, 5,
   0, 500 / 330.0, 0, 1250 / 330.0, 20 / 330.0);
INSERT INTO public.pricing_rules
  (service_type, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup, time_window_start, time_window_end,
   base_fare_usd, per_km_rate_usd, per_minute_rate_usd, min_fare_usd, per_wait_minute_rate_cup, per_wait_minute_rate_usd)
VALUES
  ('moto_standard', 234, 477, 47, 2356, '00:00', '06:00', 234 / 330.0, 477 / 330.0, 47 / 330.0, 2356 / 330.0, 20, 20 / 330.0),
  ('moto_standard',   0, 327, 18,  753, '06:00', '12:00',   0,         327 / 330.0, 18 / 330.0,  753 / 330.0, 20, 20 / 330.0),
  ('moto_standard', 416, 226,  0,  753, '12:00', '18:00', 416 / 330.0, 226 / 330.0,  0,          753 / 330.0, 20, 20 / 330.0),
  ('moto_standard', 215, 411, 28, 1496, '18:00', '23:59:59', 215 / 330.0, 411 / 330.0, 28 / 330.0, 1496 / 330.0, 20, 20 / 330.0),
  ('triciclo_basico', 0, 500, 0, 1250, '00:00', '23:59:59', 0, 500 / 330.0, 0, 1250 / 330.0, 20, 20 / 330.0);

-- Accounts. Phones: auth.users keeps E.164 digits without '+'.
INSERT INTO public.users (id, role, full_name, phone) VALUES
  ('5a000000-0000-4000-8000-000000000001', 'super_admin', 'Susana Super', '+5355510001'),
  ('5a000000-0000-4000-8000-000000000002', 'customer',    'Rita Rider',   '+5355510002'),
  ('5a000000-0000-4000-8000-000000000003', 'customer',    'Ramon Rider',  '+5355510003'),
  ('5a000000-0000-4000-8000-000000000011', 'driver',      'Pablo Piloto', '+5355510011'),
  ('5a000000-0000-4000-8000-000000000012', 'driver',      'Mario Moto',   '+5355510012'),
  ('5a000000-0000-4000-8000-000000000013', 'driver',      'Tomas Trike',  '+5355510013');
INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('5a000000-0000-4000-8000-000000000001', '5355510001', now()),
  ('5a000000-0000-4000-8000-000000000002', '5355510002', now()),
  ('5a000000-0000-4000-8000-000000000003', '5355510003', now()),
  ('5a000000-0000-4000-8000-000000000011', '5355510011', now()),
  ('5a000000-0000-4000-8000-000000000012', '5355510012', now()),
  ('5a000000-0000-4000-8000-000000000013', '5355510013', now());
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, approved_at) VALUES
  ('5b000000-0000-4000-8000-000000000011', '5a000000-0000-4000-8000-000000000011', 'approved', false,
   ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography, now() - interval '30 days'),
  ('5b000000-0000-4000-8000-000000000012', '5a000000-0000-4000-8000-000000000012', 'approved', false,
   ST_SetSRID(ST_MakePoint(-82.3670, 23.1360), 4326)::geography, now() - interval '30 days'),
  ('5b000000-0000-4000-8000-000000000013', '5a000000-0000-4000-8000-000000000013', 'approved', true,
   ST_SetSRID(ST_MakePoint(-82.3675, 23.1365), 4326)::geography, now() - interval '30 days');
-- Both motos take parcels, so the mensajeria test (T4) means something.
INSERT INTO public.vehicles (id, driver_id, type, plate_number, accepts_cargo) VALUES
  ('5c000000-0000-4000-8000-000000000011', '5b000000-0000-4000-8000-000000000011', 'moto', 'M110011', true),
  ('5c000000-0000-4000-8000-000000000012', '5b000000-0000-4000-8000-000000000012', 'moto', 'M120012', true),
  ('5c000000-0000-4000-8000-000000000013', '5b000000-0000-4000-8000-000000000013', 'triciclo', 'P130013', false);

RESET ROLE;

-- ── Test helpers (not prod) ───────────────────────────────────
CREATE SCHEMA tst;
GRANT USAGE ON SCHEMA tst TO PUBLIC;
CREATE FUNCTION tst.t(p_name text, p_got text, p_want text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_got IS NOT DISTINCT FROM p_want THEN 'PASS  ' || p_name
              ELSE 'FAIL  ' || p_name || '  -- expected [' || COALESCE(p_want, 'NULL') || '], got [' || COALESCE(p_got, 'NULL') || ']' END
$$;
GRANT EXECUTE ON FUNCTION tst.t(text, text, text) TO PUBLIC;
