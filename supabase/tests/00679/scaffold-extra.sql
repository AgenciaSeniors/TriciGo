-- What the 00679 rehearsal needs on top of the 00650 scaffold + migration 00650.
-- run.sh loads this after checking that find_best_drivers and
-- notify_offline_drivers_for_searching_rides carry today's live bodies.
-- Live bodies copied verbatim (md5 of prosrc checked by run.sh S0):
--   _driver_can_serve_ride 733f31677b6c4c146efa6434976180a8 (00628)
--   admin_ride_assist_candidates c97a27059673affa5f75bc024e09f6bb (00677)
--   _ride_service_change_error a0796f7df0430c7bafa9d4621b82eae8 (00628)
--   _vehicle_types_for_service 5299ab645064c495257109e7e53c6e4e (00669)
--   is_super_admin (00291)
-- Stubs: recompute_cup_from_usd_prices (min fares only, at 330 CUP/USD),
-- _user_id_by_verified_phone (one confirmed account per number, or nothing), is_ops_staff,
-- driver_can_afford_commission, _users_blocked.
-- The test schema tst holds the PASS/FAIL helper and is not part of prod.
SET ROLE tricigo_owner;

-- ── Columns prod has and the 00650 scaffold does not ──────────
ALTER TABLE public.users ADD COLUMN phone text;
ALTER TABLE public.rides
  ADD COLUMN ride_mode text DEFAULT 'passenger',
  ADD COLUMN corporate_account_id uuid,
  ADD COLUMN cancellation_reason text,
  ADD COLUMN final_fare_cup integer,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN payment_method text NOT NULL DEFAULT 'cash',
  ADD COLUMN estimated_fare_cup integer,
  ADD COLUMN passenger_count integer DEFAULT 1;
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

-- ── Support (assist page) objects 00679 patches ──────────────
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL,
  driver_profile_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz
);
CREATE TABLE public.ride_splits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL);
CREATE TABLE public.ride_waypoints (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), ride_id uuid NOT NULL);
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  account_type text NOT NULL,
  balance numeric NOT NULL DEFAULT 0,
  held_balance numeric DEFAULT 0
);

-- Stubs: ops staff = admin or super_admin here (the scaffold's role enum has no operator);
-- every driver can afford the commission; blocks from user_blocks.
CREATE OR REPLACE FUNCTION public.is_ops_staff() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN public.current_user_role() IN ('admin', 'super_admin');
END;
$function$;
CREATE OR REPLACE FUNCTION public.driver_can_afford_commission(p_driver_id uuid, p_fare integer)
 RETURNS jsonb LANGUAGE sql STABLE AS $function$ SELECT '{"ok": true}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public._users_blocked(p_a uuid, p_b uuid)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_blocks
                  WHERE (blocker_id = p_a AND blocked_id = p_b) OR (blocker_id = p_b AND blocked_id = p_a))
$function$;

-- Live bodies: admin_ride_assist_candidates after 00677 (md5 c97a2705..., from
-- supabase/tests/00677/live-ops.sql + the 00677 patch) and _ride_service_change_error of 00628
-- (md5 a0796f7d...).
CREATE OR REPLACE FUNCTION public.admin_ride_assist_candidates(p_ride_id uuid, p_service_type text DEFAULT NULL::text)
 RETURNS TABLE(driver_profile_id uuid, full_name text, phone text, vehicle_type vehicle_type, vehicle_label text, is_online boolean, last_heartbeat_at timestamp with time zone, distance_m integer, busy_ride_id uuid, can_afford boolean, offer_status text, offer_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
#variable_conflict use_column
DECLARE
  v_ride  public.rides%ROWTYPE;
  v_type  text;
  v_types public.vehicle_type[];
  v_cargo boolean;
BEGIN
  IF NOT public.is_ops_staff() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_ride FROM public.rides WHERE id = p_ride_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_type  := COALESCE(p_service_type, v_ride.service_type);
  v_types := public._vehicle_types_for_service(v_type);
  v_cargo := (v_ride.ride_mode = 'cargo' OR v_type = 'mensajeria');

  RETURN QUERY
  SELECT dp.id,
         u.full_name,
         u.phone,
         v.type,
         -- A NULL or blank field drops out instead of blanking the whole label.
         concat_ws(' · ', NULLIF(concat_ws(' ', NULLIF(btrim(v.make), ''), NULLIF(btrim(v.model), '')), ''),
                   NULLIF(btrim(v.color), ''), NULLIF(btrim(v.plate_number), '')),
         dp.is_online,
         dp.last_heartbeat_at,
         ST_Distance(dp.current_location, v_ride.pickup_location)::int,
         (SELECT a.id FROM public.rides a
           WHERE a.driver_id = dp.id
             AND a.status IN ('accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination')
           LIMIT 1),
         -- 00677: on a company ride the company pays the commission, so no driver lacks the balance.
         (v_ride.payment_method::text = 'corporate' AND v_ride.corporate_account_id IS NOT NULL)
         OR COALESCE((public.driver_can_afford_commission(dp.id, v_ride.estimated_fare_cup)->>'ok')::boolean, false),
         o.status,
         o.expires_at
  FROM public.driver_profiles dp
  JOIN public.users u ON u.id = dp.user_id
  JOIN LATERAL (
    SELECT v2.* FROM public.vehicles v2
    WHERE v2.driver_id = dp.id
      AND v2.is_active
      AND (v_types IS NULL OR v2.type = ANY (v_types))
      AND (NOT v_cargo OR v2.accepts_cargo IS TRUE)
    ORDER BY v2.created_at DESC
    LIMIT 1
  ) v ON true
  LEFT JOIN public.ride_offers o ON o.ride_id = v_ride.id AND o.driver_profile_id = dp.id
  WHERE dp.status = 'approved'
    AND u.is_active
    AND (dp.is_online OR dp.last_heartbeat_at > now() - interval '7 days')
    AND NOT public._users_blocked(v_ride.customer_id, dp.user_id)
  ORDER BY dp.is_online DESC, ST_Distance(dp.current_location, v_ride.pickup_location) ASC NULLS LAST, u.full_name
  LIMIT 60;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._ride_service_change_error(p_ride public.rides, p_service_type text, p_fare_cup integer)
RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_svc public.service_type_configs%ROWTYPE;
BEGIN
  IF p_ride.status <> 'searching' THEN
    RETURN 'ride_not_searching';
  END IF;
  -- The change dispatches the ride at once, and a driver who accepts it hours early is
  -- cancelled by stale_pre_pickup (00282). The predicate of on_ride_insert_dispatch.
  IF COALESCE(p_ride.is_scheduled, false) AND p_ride.scheduled_at IS NOT NULL AND p_ride.scheduled_at > now() THEN
    RETURN 'scheduled_not_due';
  END IF;
  IF COALESCE(p_ride.ride_mode, 'passenger') <> 'passenger' THEN
    RETURN 'cargo_not_supported';
  END IF;
  IF p_ride.corporate_account_id IS NOT NULL THEN
    RETURN 'corporate_not_supported';
  END IF;
  -- A prepaid ride cannot change its amount silently. Mixed can: its wallet part is capped at
  -- the balance when the ride completes.
  IF p_ride.payment_method::text NOT IN ('cash', 'tricicoin', 'mixed') THEN
    RETURN 'payment_method_not_supported';
  END IF;
  -- An accepted invitee would be charged a share of a fare they never saw.
  IF EXISTS (SELECT 1 FROM public.ride_splits s WHERE s.ride_id = p_ride.id) THEN
    RETURN 'split_not_supported';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ride_waypoints w WHERE w.ride_id = p_ride.id) THEN
    RETURN 'waypoints_not_supported';
  END IF;
  IF NULLIF(btrim(COALESCE(p_service_type, '')), '') IS NULL THEN
    RETURN 'invalid_service_type';
  END IF;
  IF p_service_type = p_ride.service_type THEN
    RETURN 'same_service_type';
  END IF;
  -- A passenger ride only goes to a type that carries passengers: max_passengers 0 marks a
  -- cargo type (mensajeria, or triciclo_cargo from 00058 if it is ever activated).
  SELECT * INTO v_svc FROM public.service_type_configs WHERE slug = p_service_type AND is_active;
  IF NOT FOUND OR p_service_type = 'mensajeria' OR COALESCE(v_svc.max_passengers, 0) <= 0 THEN
    RETURN 'service_type_unavailable';
  END IF;
  IF COALESCE(p_ride.passenger_count, 1) > v_svc.max_passengers THEN
    RETURN 'too_many_passengers';
  END IF;
  IF p_fare_cup IS NULL OR p_fare_cup < v_svc.min_fare_cup THEN
    RETURN 'fare_below_minimum';
  END IF;
  -- A typo guard: at most five times the larger of the current fare and the new type's minimum
  -- fare. The minimum keeps the bound usable for a ride with a 0 fare and for a much pricier type.
  IF p_fare_cup > 5 * GREATEST(COALESCE(p_ride.estimated_fare_cup, 0), v_svc.min_fare_cup) THEN
    RETURN 'fare_out_of_range';
  END IF;
  -- complete_ride_and_pay charges a TriciCoin ride from the rider's customer_cash, uncapped, and
  -- that balance may not go negative: a fare the rider cannot pay would leave the driver unable
  -- to finish the ride. The rider app books it only with 1.2 times the fare.
  IF p_ride.payment_method::text = 'tricicoin' AND NOT EXISTS (
       SELECT 1 FROM public.wallet_accounts w
       WHERE w.user_id = p_ride.customer_id
         AND w.account_type = 'customer_cash'
         AND w.balance - COALESCE(w.held_balance, 0) >= ceil(p_fare_cup * 1.2)) THEN
    RETURN 'rider_balance_too_low';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._ride_service_change_error(public.rides, text, integer) FROM PUBLIC, anon, authenticated;

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
