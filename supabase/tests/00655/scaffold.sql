-- Scaffold for the 00655 rehearsal. Tables with prod's columns, RLS policies and
-- grants (read from prod on 2026-10-11) for rides, ride_waypoints, reviews,
-- delivery_details and recurring_rides, plus the corporate tables the ride gate
-- reads. The live functions that 00655 patches or that sit next to it are
-- copied byte for byte from pg_get_functiondef in prod (md5 of each body noted
-- next to it), with their prod trigger names so they fire in prod's order.
-- _ride_context_for_caller is 00653's. A NON-superuser role (prod: postgres)
-- owns everything; run.sh applies the migration as that role.
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

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

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

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text
);
GRANT SELECT ON public.users TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS public.user_role
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
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id)
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT USING (user_id = auth.uid() OR is_admin());
GRANT SELECT ON public.driver_profiles TO anon, authenticated, service_role;

CREATE TABLE public.service_type_configs (
  slug text PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true,
  base_fare_cup integer, per_km_rate_cup integer, per_minute_rate_cup integer, min_fare_cup integer
);
GRANT SELECT ON public.service_type_configs TO anon, authenticated, service_role;
CREATE TABLE public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_type text, is_active boolean NOT NULL DEFAULT true,
  base_fare_cup integer, per_km_rate_cup integer, per_minute_rate_cup integer, min_fare_cup integer
);
GRANT SELECT ON public.pricing_rules TO anon, authenticated, service_role;

CREATE TABLE public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value boolean NOT NULL DEFAULT false
);
GRANT SELECT ON public.feature_flags TO anon, authenticated, service_role;

-- What tg_rides_validate_corporate reads.
CREATE TABLE public.corporate_accounts (
  id uuid PRIMARY KEY, status text, created_by uuid,
  per_ride_cap_trc integer, monthly_budget_trc integer
);
CREATE TABLE public.corporate_employees (
  corporate_account_id uuid, user_id uuid, is_active boolean DEFAULT true
);
CREATE TABLE public.wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, account_type text,
  balance integer DEFAULT 0, held_balance integer DEFAULT 0
);
CREATE TABLE public.corporate_rides (
  corporate_account_id uuid, fare_trc integer, created_at timestamptz DEFAULT now()
);

CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method public.payment_method NOT NULL DEFAULT 'cash',
  service_type text NOT NULL,
  ride_mode text NOT NULL DEFAULT 'passenger',
  corporate_account_id uuid,
  pickup_location geography, dropoff_location geography,
  pickup_address text NOT NULL, dropoff_address text NOT NULL,
  pickup_lat double precision, pickup_lng double precision,
  dropoff_lat double precision, dropoff_lng double precision,
  estimated_fare_cup integer NOT NULL DEFAULT 0,
  estimated_fare_trc integer,
  estimated_distance_m integer NOT NULL DEFAULT 0,
  estimated_duration_s integer NOT NULL DEFAULT 0,
  surge_multiplier numeric NOT NULL DEFAULT 1.0,
  scheduled_at timestamptz,
  is_scheduled boolean NOT NULL DEFAULT false,
  scheduled_notified boolean DEFAULT false,
  final_fare_cup integer, final_fare_trc integer,
  accepted_at timestamptz, completed_at timestamptz, canceled_at timestamptz,
  driver_arrived_at timestamptz, pickup_at timestamptz, arrived_at_destination_at timestamptz,
  actual_distance_m integer, actual_duration_s integer,
  driver_custom_rate_cup integer, wait_time_charge_cup integer DEFAULT 0,
  passenger_count integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_insert ON public.rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));
CREATE POLICY r_select_customer ON public.rides FOR SELECT USING ((customer_id = (SELECT auth.uid())) OR is_admin());
CREATE POLICY r_select_driver ON public.rides FOR SELECT USING (
  driver_id IN (SELECT driver_profiles.id FROM driver_profiles WHERE driver_profiles.user_id = (SELECT auth.uid())));
CREATE POLICY r_update ON public.rides FOR UPDATE USING (
  (customer_id = (SELECT auth.uid()))
  OR (driver_id IN (SELECT driver_profiles.id FROM driver_profiles WHERE driver_profiles.user_id = (SELECT auth.uid())))
  OR is_admin());
GRANT SELECT, INSERT, UPDATE ON public.rides TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._ride_context_for_caller(p_ride_id uuid)
RETURNS TABLE (caller_role text, ride_status public.ride_status, other_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT CASE WHEN r.customer_id = auth.uid() THEN 'customer' ELSE 'driver' END,
         r.status,
         CASE WHEN r.customer_id = auth.uid() THEN dp.user_id ELSE r.customer_id END
  FROM public.rides r
  LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
  WHERE r.id = p_ride_id
    AND auth.uid() IS NOT NULL
    AND (r.customer_id = auth.uid() OR dp.user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public._ride_context_for_caller(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._ride_context_for_caller(uuid) TO authenticated, service_role;

-- prod md5 ae0ae618fc32ad8e3806f566e4341e97
CREATE OR REPLACE FUNCTION public.tg_rides_normalize_scheduling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  NEW.is_scheduled := (NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now());
  NEW.scheduled_notified := false;

  IF auth.uid() IS NOT NULL THEN
    NEW.status                    := 'searching';
    NEW.driver_id                 := NULL;
    NEW.final_fare_cup            := NULL;
    NEW.final_fare_trc            := NULL;
    NEW.accepted_at               := NULL;
    NEW.completed_at              := NULL;
    NEW.canceled_at               := NULL;
    NEW.driver_arrived_at         := NULL;
    NEW.pickup_at                 := NULL;
    NEW.arrived_at_destination_at := NULL;
    NEW.actual_distance_m         := NULL;
    NEW.actual_duration_s         := NULL;
    NEW.driver_custom_rate_cup    := NULL;
    NEW.wait_time_charge_cup      := 0;
  END IF;

  RETURN NEW;
END;
$function$;

-- prod md5 dedba4180be1ee385df85ecf86b940c4
CREATE OR REPLACE FUNCTION public.enforce_one_active_ride_per_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN (
    'searching','accepted','driver_en_route',
    'arrived_at_pickup','in_progress','arrived_at_destination'
  )
  AND NOT (COALESCE(NEW.is_scheduled, false) AND NOT COALESCE(NEW.scheduled_notified, false)) THEN
    IF EXISTS (
      SELECT 1 FROM public.rides
      WHERE customer_id = NEW.customer_id
        AND status IN (
          'searching','accepted','driver_en_route',
          'arrived_at_pickup','in_progress','arrived_at_destination'
        )
        AND NOT (COALESCE(is_scheduled, false) AND NOT COALESCE(scheduled_notified, false))
        AND (TG_OP = 'INSERT' OR id <> NEW.id)
    ) THEN
      RAISE EXCEPTION 'customer_has_active_ride'
        USING ERRCODE = 'P0001',
              HINT = 'Cancel the existing active ride before creating a new one';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- prod md5 17bd1b28f1cf42550da942a102f008ba
CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_status text;
  v_creator uuid;
  v_per_ride_cap integer;
  v_monthly_budget integer;
  v_month_spent integer;
  v_in_flight integer;
  v_fare integer;
  v_wallet_id uuid;
  v_balance integer;
  v_held integer;
  v_check_money boolean;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    IF NEW.payment_method = 'corporate' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'Elige la empresa que paga el viaje.',
        DETAIL = 'corporate_account_required';
    END IF;
    RETURN NEW;
  END IF;

  SELECT status, created_by, per_ride_cap_trc, monthly_budget_trc
    INTO v_status, v_creator, v_per_ride_cap, v_monthly_budget
  FROM corporate_accounts WHERE id = NEW.corporate_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa que paga el viaje no existe.',
      DETAIL = 'corporate_not_found';
  END IF;
  IF v_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La cuenta de la empresa no está habilitada para pagar viajes.',
      DETAIL = 'corporate_not_approved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM corporate_employees
    WHERE corporate_account_id = NEW.corporate_account_id
      AND user_id = NEW.customer_id
      AND is_active = true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No eres empleado activo de esta empresa.',
      DETAIL = 'corporate_not_employee';
  END IF;

  v_fare := COALESCE(NULLIF(NEW.estimated_fare_trc, 0), NULLIF(NEW.estimated_fare_cup, 0), 0);
  IF TG_OP = 'INSERT' AND v_fare <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'No se pudo calcular el precio del viaje. Vuelve a intentarlo.',
      DETAIL = 'corporate_fare_required';
  END IF;

  IF COALESCE(v_per_ride_cap, 0) > 0 AND v_fare > v_per_ride_cap THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = format('El viaje cuesta %s CUP y la empresa paga hasta %s CUP por viaje.', v_fare, v_per_ride_cap),
      DETAIL = 'corporate_over_ride_cap';
  END IF;

  -- Money: only while the company starts paying this ride or its estimate goes
  -- up, and only for a ride in flight.
  v_check_money := NEW.payment_method = 'corporate'
    AND NEW.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
    AND (TG_OP = 'INSERT'
         OR NEW.corporate_account_id IS DISTINCT FROM OLD.corporate_account_id
         OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
         OR v_fare > COALESCE(NULLIF(OLD.estimated_fare_trc, 0), NULLIF(OLD.estimated_fare_cup, 0), 0));
  IF v_check_money IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Lock the wallet that funds the company (its creator's) before reading what
  -- is already committed against it, so concurrent rides queue here.
  SELECT id, balance, held_balance INTO v_wallet_id, v_balance, v_held
  FROM wallet_accounts
  WHERE user_id = v_creator AND account_type = 'corporate_cash'
  FOR UPDATE;

  IF COALESCE(v_monthly_budget, 0) > 0 THEN
    SELECT COALESCE(SUM(fare_trc), 0) INTO v_month_spent
    FROM corporate_rides
    WHERE corporate_account_id = NEW.corporate_account_id
      AND created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana');
    SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
      INTO v_in_flight
    FROM rides r
    WHERE r.corporate_account_id = NEW.corporate_account_id
      AND r.payment_method = 'corporate'
      AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                       'in_progress', 'arrived_at_destination')
      AND r.id <> NEW.id;
    IF v_month_spent + v_in_flight + v_fare > v_monthly_budget THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = format('El viaje cuesta %s CUP y al presupuesto mensual de la empresa le quedan %s CUP.',
                         v_fare, GREATEST(v_monthly_budget - v_month_spent - v_in_flight, 0)),
        DETAIL = 'corporate_over_monthly_budget';
    END IF;
  END IF;

  -- Prepaid: every company of the creator spends from the same wallet.
  SELECT COALESCE(SUM(COALESCE(NULLIF(r.estimated_fare_trc, 0), NULLIF(r.estimated_fare_cup, 0), 0)), 0)
    INTO v_in_flight
  FROM rides r
  JOIN corporate_accounts ca ON ca.id = r.corporate_account_id
  WHERE ca.created_by = v_creator
    AND r.payment_method = 'corporate'
    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination')
    AND r.id <> NEW.id;
  IF v_wallet_id IS NULL OR v_fare > v_balance - v_held - v_in_flight THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'La empresa no tiene saldo suficiente para este viaje. Pídele a un administrador de la empresa que la recargue.',
      DETAIL = 'corporate_insufficient_balance';
  END IF;

  RETURN NEW;
END;
$function$;

-- prod md5 bd038e5d88e99e3377b5d8787d8f68b1
CREATE OR REPLACE FUNCTION public.tg_rides_validate_estimated_fare()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_min integer;
  v_client boolean := auth.uid() IS NOT NULL AND NOT is_admin();
  v_base numeric;
  v_per_km numeric;
  v_per_min numeric;
  v_min_fare numeric;
  v_route_km numeric;
  v_ceiling numeric;
BEGIN
  -- 00631: the only surge left is the weather one, which get_weather_surge()
  -- keeps in [1, 3]. A client may not declare more (the snapshot keeps it and
  -- the waypoint surcharge multiplies by it).
  IF v_client THEN
    NEW.surge_multiplier := LEAST(GREATEST(COALESCE(NEW.surge_multiplier, 1), 1), 3);
  END IF;

  IF NEW.estimated_fare_cup IS NULL OR NEW.estimated_fare_cup <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT min_fare_cup INTO v_min
  FROM service_type_configs
  WHERE slug = NEW.service_type AND is_active = true
  LIMIT 1;

  IF v_min IS NULL THEN
    SELECT MIN(min_fare_cup) INTO v_min
    FROM pricing_rules
    WHERE service_type = NEW.service_type AND is_active = true;
  END IF;

  IF v_min IS NOT NULL AND v_min > 0 AND NEW.estimated_fare_cup < v_min THEN
    RAISE EXCEPTION 'estimated_fare_cup % is below the minimum fare % for service % (server-side fare floor / tamper guard)',
      NEW.estimated_fare_cup, v_min, NEW.service_type;
  END IF;

  -- 00631: the ceiling. The snapshot taken after this insert is what
  -- complete_ride_and_pay charges, and a promo above the commission pays the
  -- driver a share of it, so the fare a client declares must be one the
  -- tariff could produce: the most expensive band of the service, a route of
  -- 4 x the straight distance + 5 km driven at 10 km/h (6 min per km), the
  -- surge, and 50 % on top.
  IF v_client THEN
    SELECT max(t.base_fare_cup), max(t.per_km_rate_cup), max(t.per_minute_rate_cup), max(t.min_fare_cup)
      INTO v_base, v_per_km, v_per_min, v_min_fare
    FROM (
      SELECT s.base_fare_cup, s.per_km_rate_cup, s.per_minute_rate_cup, s.min_fare_cup
      FROM service_type_configs s WHERE s.slug = NEW.service_type
      UNION ALL
      SELECT p.base_fare_cup, p.per_km_rate_cup, p.per_minute_rate_cup, p.min_fare_cup
      FROM pricing_rules p WHERE p.service_type = NEW.service_type AND p.is_active
    ) t;

    v_route_km := ST_Distance(NEW.pickup_location, NEW.dropoff_location) / 1000.0 * 4 + 5;
    v_ceiling := ceil(
      GREATEST(COALESCE(v_min_fare, 0),
               COALESCE(v_base, 0) + COALESCE(v_per_km, 0) * v_route_km
                 + COALESCE(v_per_min, 0) * v_route_km * 6)
      * NEW.surge_multiplier * 1.5);

    IF v_ceiling > 0 AND NEW.estimated_fare_cup > v_ceiling THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'No pudimos confirmar el precio de este viaje. Vuelve a calcularlo e inténtalo de nuevo.',
        DETAIL = 'fare_above_ceiling',
        HINT = format('estimated_fare_cup %s is above the ceiling %s for %s', NEW.estimated_fare_cup, v_ceiling, NEW.service_type);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER rides_normalize_scheduling BEFORE INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_normalize_scheduling();
CREATE TRIGGER trg_enforce_one_active_ride_per_customer BEFORE INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION enforce_one_active_ride_per_customer();
CREATE TRIGGER trg_rides_validate_corporate BEFORE INSERT OR UPDATE OF corporate_account_id, payment_method, estimated_fare_trc ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_corporate();
CREATE TRIGGER trg_rides_validate_estimated_fare BEFORE INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION tg_rides_validate_estimated_fare();

-- recurring_rides (prod: rr_insert, rr_select, rr_update, rr_delete, rr_admin_select)
CREATE TABLE public.recurring_rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  pickup_address text NOT NULL, pickup_latitude numeric NOT NULL, pickup_longitude numeric NOT NULL,
  dropoff_address text NOT NULL, dropoff_latitude numeric NOT NULL, dropoff_longitude numeric NOT NULL,
  service_type text NOT NULL DEFAULT 'triciclo_basico' REFERENCES public.service_type_configs(slug),
  payment_method text NOT NULL DEFAULT 'cash',
  days_of_week integer[] NOT NULL DEFAULT '{}'::integer[],
  time_of_day time without time zone NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status = ANY (ARRAY['active'::text, 'paused'::text, 'deleted'::text])),
  next_occurrence_at timestamptz,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.recurring_rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY rr_admin_select ON public.recurring_rides FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY rr_delete ON public.recurring_rides FOR DELETE USING (customer_id = (SELECT auth.uid()));
CREATE POLICY rr_insert ON public.recurring_rides FOR INSERT WITH CHECK (customer_id = (SELECT auth.uid()));
CREATE POLICY rr_select ON public.recurring_rides FOR SELECT USING (customer_id = (SELECT auth.uid()));
CREATE POLICY rr_update ON public.recurring_rides FOR UPDATE USING (customer_id = (SELECT auth.uid()));
GRANT ALL ON public.recurring_rides TO anon, authenticated, service_role;
CREATE TRIGGER set_recurring_rides_updated_at BEFORE UPDATE ON public.recurring_rides FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- prod md5 c6f9416550de49d651f5231ff8d39485
CREATE OR REPLACE FUNCTION public.compute_next_occurrence(p_days smallint[], p_time time without time zone, p_tz text DEFAULT 'America/Havana'::text, p_from timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE v_local_now TIMESTAMP; v_candidate DATE; v_dow INT; v_result TIMESTAMPTZ; i INT;
BEGIN
  v_local_now := p_from AT TIME ZONE p_tz;
  FOR i IN 0..7 LOOP
    v_candidate := (v_local_now::DATE) + i;
    v_dow := EXTRACT(ISODOW FROM v_candidate)::INT;
    IF v_dow = ANY(p_days) THEN
      IF i = 0 AND v_local_now::TIME > (p_time - interval '30 minutes') THEN CONTINUE; END IF;
      v_result := (v_candidate || ' ' || p_time)::TIMESTAMP AT TIME ZONE p_tz;
      RETURN v_result;
    END IF;
  END LOOP;
  RETURN NULL;
END; $function$;

-- prod md5 2df13e14e4e1fcaab09a76e6c6859389
CREATE OR REPLACE FUNCTION public.create_rides_for_recurring()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rec RECORD;
  v_count INT := 0;
  v_next TIMESTAMPTZ;
  v_pickup GEOGRAPHY;
  v_dropoff GEOGRAPHY;
BEGIN
  FOR v_rec IN
    SELECT * FROM recurring_rides
    WHERE status = 'active'
      AND next_occurrence_at IS NOT NULL
      AND next_occurrence_at <= NOW() + interval '24 hours'
      AND (last_triggered_at IS NULL
           OR last_triggered_at < next_occurrence_at - interval '25 hours')
  LOOP
    BEGIN
      v_pickup  := ST_SetSRID(ST_MakePoint(v_rec.pickup_longitude::float8,  v_rec.pickup_latitude::float8),  4326)::geography;
      v_dropoff := ST_SetSRID(ST_MakePoint(v_rec.dropoff_longitude::float8, v_rec.dropoff_latitude::float8), 4326)::geography;

      INSERT INTO rides (
        customer_id, service_type, payment_method,
        pickup_location, pickup_address, pickup_lat, pickup_lng,
        dropoff_location, dropoff_address, dropoff_lat, dropoff_lng,
        estimated_fare_cup, estimated_distance_m, estimated_duration_s,
        is_scheduled, scheduled_at, status
      ) VALUES (
        v_rec.customer_id, v_rec.service_type, v_rec.payment_method::payment_method,
        v_pickup, v_rec.pickup_address, v_rec.pickup_latitude::float8, v_rec.pickup_longitude::float8,
        v_dropoff, v_rec.dropoff_address, v_rec.dropoff_latitude::float8, v_rec.dropoff_longitude::float8,
        0, 0, 0, true, v_rec.next_occurrence_at, 'searching'
      );

      v_next := compute_next_occurrence(
        v_rec.days_of_week::smallint[],
        v_rec.time_of_day,
        'America/Havana'::text,
        v_rec.next_occurrence_at + interval '1 hour'
      );

      UPDATE recurring_rides
        SET last_triggered_at = NOW(),
            next_occurrence_at = v_next,
            updated_at = NOW()
      WHERE id = v_rec.id;

      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'create_rides_for_recurring: skipped recurring % : % %', v_rec.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;
  RETURN v_count;
END;
$function$;


-- reviews (prod: rev_insert, rev_select, rev_admin, rev_admin_select)
CREATE OR REPLACE FUNCTION public.can_review_ride(p_ride_id uuid, p_reviewer_id uuid, p_reviewee_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.rides r
    LEFT JOIN public.driver_profiles dp ON dp.id = r.driver_id
    WHERE r.id = p_ride_id
      AND r.status = 'completed'::ride_status
      AND (
        (r.customer_id = p_reviewer_id AND dp.user_id = p_reviewee_id)
        OR
        (dp.user_id = p_reviewer_id AND r.customer_id = p_reviewee_id)
      )
  );
$function$;
CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  reviewer_id uuid NOT NULL REFERENCES public.users(id),
  reviewee_id uuid NOT NULL REFERENCES public.users(id),
  rating smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment text,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_featured boolean NOT NULL DEFAULT false,
  UNIQUE (ride_id, reviewer_id)
);
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY rev_admin ON public.reviews FOR UPDATE USING (is_admin());
CREATE POLICY rev_admin_select ON public.reviews FOR SELECT USING (is_admin());
CREATE POLICY rev_insert ON public.reviews FOR INSERT TO authenticated WITH CHECK (
  (reviewer_id = (SELECT auth.uid())) AND (reviewer_id <> reviewee_id) AND can_review_ride(ride_id, reviewer_id, reviewee_id));
CREATE POLICY rev_select ON public.reviews FOR SELECT USING (
  (reviewer_id = (SELECT auth.uid())) OR (reviewee_id = (SELECT auth.uid())) OR is_admin());
GRANT ALL ON public.reviews TO anon, authenticated, service_role;

-- ride_waypoints (prod policies; the AFTER re-pricing trigger is left out: the
-- guards decide whether a write happens at all)
CREATE TABLE public.ride_waypoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  sort_order integer NOT NULL,
  location geography NOT NULL,
  address text NOT NULL,
  arrived_at timestamptz,
  departed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.ride_waypoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage waypoints" ON public.ride_waypoints USING (
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])));
CREATE POLICY "Users can view their ride waypoints" ON public.ride_waypoints FOR SELECT USING (
  EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND (r.customer_id = auth.uid()
    OR r.driver_id IN (SELECT driver_profiles.id FROM driver_profiles WHERE driver_profiles.user_id = auth.uid()))));
CREATE POLICY ride_waypoints_customer_delete ON public.ride_waypoints FOR DELETE USING (
  EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid()));
CREATE POLICY ride_waypoints_customer_insert ON public.ride_waypoints FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid()));
CREATE POLICY ride_waypoints_customer_update ON public.ride_waypoints FOR UPDATE USING (
  EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM rides r WHERE r.id = ride_waypoints.ride_id AND r.customer_id = auth.uid()));
CREATE POLICY ride_waypoints_driver_update ON public.ride_waypoints FOR UPDATE USING (
  EXISTS (SELECT 1 FROM rides r JOIN driver_profiles dp ON dp.id = r.driver_id WHERE r.id = ride_waypoints.ride_id AND dp.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM rides r JOIN driver_profiles dp ON dp.id = r.driver_id WHERE r.id = ride_waypoints.ride_id AND dp.user_id = auth.uid()));
GRANT ALL ON public.ride_waypoints TO anon, authenticated, service_role;

-- delivery_details (prod policies and its two BEFORE triggers)
CREATE TABLE public.delivery_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL UNIQUE REFERENCES public.rides(id),
  recipient_phone text, recipient_name text, delivery_photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  package_description text, package_category text,
  pickup_photo_url text, delivery_otp text, delivery_otp_validated_at timestamptz
);
ALTER TABLE public.delivery_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers create delivery details" ON public.delivery_details FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM rides WHERE rides.id = delivery_details.ride_id AND rides.customer_id = auth.uid()));
CREATE POLICY "Driver updates delivery photo" ON public.delivery_details FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM rides WHERE rides.id = delivery_details.ride_id AND rides.driver_id IS NOT NULL
    AND rides.driver_id = (SELECT driver_profiles.id FROM driver_profiles WHERE driver_profiles.user_id = auth.uid())));
CREATE POLICY "Rider and admin read delivery" ON public.delivery_details FOR SELECT USING (
  (EXISTS (SELECT 1 FROM rides r WHERE r.id = delivery_details.ride_id AND r.customer_id = auth.uid())) OR is_admin());
GRANT ALL ON public.delivery_details TO anon, authenticated, service_role;
-- prod md5 e4b1722be41bfe7d25591743cd16f653
CREATE OR REPLACE FUNCTION public.generate_delivery_otp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN
  IF NEW.delivery_otp IS NULL THEN
    NEW.delivery_otp := lpad((floor(random() * 10000))::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$function$;

-- prod md5 fd38bd9b739a86d17f1affc2bc40f9d4
CREATE OR REPLACE FUNCTION public.tg_delivery_details_protect_otp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_delivery_update', true) = '1' THEN RETURN NEW; END IF;
  NEW.delivery_otp              := OLD.delivery_otp;
  NEW.delivery_otp_validated_at := OLD.delivery_otp_validated_at;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_delivery_details_generate_otp BEFORE INSERT ON public.delivery_details FOR EACH ROW EXECUTE FUNCTION generate_delivery_otp();
CREATE TRIGGER trg_delivery_details_protect_otp BEFORE UPDATE ON public.delivery_details FOR EACH ROW EXECUTE FUNCTION tg_delivery_details_protect_otp();

RESET ROLE;
