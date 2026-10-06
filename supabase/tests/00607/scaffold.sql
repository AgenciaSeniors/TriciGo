-- Scaffold for the 00607 rehearsal: the LIVE production shapes a client INSERT
-- into public.ride_disputes, public.customer_profiles and public.rides goes
-- through, transcribed from pg_get_functiondef, pg_policies, pg_constraint,
-- pg_trigger and pg_class.relacl on 2026-10-05 (00605 and the other 00606 already applied).
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST sets it.
--
-- Only the columns, constraints, policies and triggers involved are modelled.
-- rides in prod has ~40 more triggers (dispatch, pricing, notifications). None
-- writes wallet_ratio; enforce_ride_update_columns (00290) reads it and refuses
-- a rider's change, so in prod a rider's UPDATE fails there before the new
-- CHECK is reached (W4 runs as the service role for that reason). They are
-- left out. Do not reuse this scaffold as a complete copy of any of the three
-- tables.
--
-- Ownership mirrors prod: tables and SECURITY DEFINER functions belong to a role
-- that is NOT a superuser (prod: postgres) and run.sh applies the migration as
-- that role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;

-- LIVE auth.uid()
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

CREATE TABLE auth.users (id uuid PRIMARY KEY, email varchar(255));

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress',
                                        'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.payment_method AS ENUM ('tricicoin', 'cash', 'mixed', 'stripe', 'tropipay', 'corporate');

-- public.users: only what current_user_role() reads
CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT ''::text,
  role public.user_role NOT NULL DEFAULT 'customer'::public.user_role,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id)
);

-- LIVE current_user_role()
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

-- LIVE is_admin() (00592)
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
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;

-- LIVE update_updated_at_column()
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$function$;

-- public.rides: the columns the dispute policy, the dispute guard and the
-- wallet_ratio check touch, with their live types, defaults and checks.
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.users(id),
  driver_id uuid REFERENCES public.driver_profiles(id),
  status public.ride_status DEFAULT 'searching'::public.ride_status,
  payment_method public.payment_method DEFAULT 'cash'::public.payment_method,
  estimated_fare_trc integer,
  final_fare_trc integer,
  wallet_ratio numeric(3,2) DEFAULT 0,
  wallet_amount_cup integer DEFAULT 0,
  cash_amount_cup integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT rides_cash_amount_nonneg CHECK (((cash_amount_cup IS NULL) OR (cash_amount_cup >= 0))),
  CONSTRAINT rides_estimated_fare_trc_nonneg CHECK (((estimated_fare_trc IS NULL) OR (estimated_fare_trc >= 0)))
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
CREATE POLICY r_insert ON public.rides FOR INSERT TO public WITH CHECK ((customer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY r_select_customer ON public.rides FOR SELECT TO public USING (((customer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
-- r_select_driver without its ride_offers branch (a driver who was only offered the ride): the
-- dispute policy reads rides as the caller, so the assigned driver must see the ride, as in prod.
CREATE POLICY r_select_driver ON public.rides FOR SELECT TO public USING ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY r_update ON public.rides FOR UPDATE TO public USING (((customer_id = ( SELECT auth.uid() AS uid)) OR (driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));

-- public.ride_disputes: every live column, default and constraint
CREATE TABLE public.ride_disputes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  reason text NOT NULL,
  description text NOT NULL,
  evidence_urls text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'open'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  respondent_id uuid,
  respondent_message text,
  respondent_evidence_urls text[] NOT NULL DEFAULT '{}'::text[],
  respondent_replied_at timestamptz,
  resolution text,
  resolution_notes text,
  refund_amount_trc integer,
  refund_transaction_id uuid,
  assigned_to uuid,
  admin_notes text,
  sla_first_response_at timestamptz,
  sla_resolution_deadline timestamptz,
  support_ticket_id uuid,
  incident_report_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  resolved_at timestamptz,
  ride_estimated_fare_trc integer,
  ride_final_fare_trc integer,
  CONSTRAINT chk_dispute_priority_valid CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
  CONSTRAINT chk_dispute_status_valid CHECK ((status = ANY (ARRAY['open'::text, 'under_review'::text, 'resolved_rider'::text, 'resolved_driver'::text, 'escalated'::text, 'closed'::text]))),
  CONSTRAINT chk_estimated_fare_non_negative CHECK (((ride_estimated_fare_trc IS NULL) OR (ride_estimated_fare_trc >= 0))),
  CONSTRAINT chk_final_fare_non_negative CHECK (((ride_final_fare_trc IS NULL) OR (ride_final_fare_trc >= 0))),
  CONSTRAINT ride_disputes_refund_nonneg CHECK (((refund_amount_trc IS NULL) OR (refund_amount_trc >= 0))),
  CONSTRAINT one_dispute_per_ride UNIQUE (ride_id),
  CONSTRAINT ride_disputes_ride_id_fkey FOREIGN KEY (ride_id) REFERENCES public.rides(id),
  CONSTRAINT ride_disputes_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES auth.users(id),
  CONSTRAINT ride_disputes_respondent_id_fkey FOREIGN KEY (respondent_id) REFERENCES auth.users(id),
  CONSTRAINT ride_disputes_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id)
);
ALTER TABLE public.ride_disputes ENABLE ROW LEVEL SECURITY;
CREATE POLICY dispute_insert ON public.ride_disputes FOR INSERT TO public WITH CHECK (((opened_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM rides
  WHERE ((rides.id = ride_disputes.ride_id) AND ((rides.customer_id = auth.uid()) OR (rides.driver_id IN ( SELECT dp.id
           FROM driver_profiles dp
          WHERE (dp.user_id = auth.uid())))) AND (rides.status = ANY (ARRAY['completed'::ride_status, 'disputed'::ride_status])))))));
CREATE POLICY dispute_select ON public.ride_disputes FOR SELECT TO public USING (((opened_by = auth.uid()) OR (respondent_id = auth.uid()) OR is_admin()));
CREATE POLICY dispute_update ON public.ride_disputes FOR UPDATE TO public USING (((respondent_id = auth.uid()) OR is_admin()));
CREATE POLICY rd_admin_select ON public.ride_disputes FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY rd_admin_update ON public.ride_disputes FOR UPDATE TO authenticated USING (is_admin());

-- LIVE tg_ride_disputes_protect_columns() (00400)
CREATE OR REPLACE FUNCTION public.tg_ride_disputes_protect_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;
  IF auth.uid() IS NULL THEN
    RETURN NEW;  -- service-role / SECDEF (e.g. process_dispute_refund)
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'under_review' THEN
    NEW.status := OLD.status;
  END IF;
  NEW.id                      := OLD.id;
  NEW.ride_id                 := OLD.ride_id;
  NEW.opened_by               := OLD.opened_by;
  NEW.reason                  := OLD.reason;
  NEW.description             := OLD.description;
  NEW.evidence_urls           := OLD.evidence_urls;
  NEW.priority                := OLD.priority;
  NEW.respondent_id           := OLD.respondent_id;
  NEW.resolution              := OLD.resolution;
  NEW.resolution_notes        := OLD.resolution_notes;
  NEW.refund_amount_trc       := OLD.refund_amount_trc;
  NEW.refund_transaction_id   := OLD.refund_transaction_id;
  NEW.assigned_to             := OLD.assigned_to;
  NEW.admin_notes             := OLD.admin_notes;
  NEW.sla_first_response_at   := OLD.sla_first_response_at;
  NEW.sla_resolution_deadline := OLD.sla_resolution_deadline;
  NEW.support_ticket_id       := OLD.support_ticket_id;
  NEW.incident_report_id      := OLD.incident_report_id;
  NEW.created_at              := OLD.created_at;
  NEW.resolved_at             := OLD.resolved_at;
  NEW.ride_estimated_fare_trc := OLD.ride_estimated_fare_trc;
  NEW.ride_final_fare_trc     := OLD.ride_final_fare_trc;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER set_ride_disputes_updated_at BEFORE UPDATE ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_ride_disputes_protect_columns BEFORE UPDATE ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION tg_ride_disputes_protect_columns();

-- public.customer_profiles: every live column
CREATE TABLE public.customer_profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id),
  default_payment_method public.payment_method DEFAULT 'cash'::public.payment_method,
  saved_locations jsonb DEFAULT '[]'::jsonb,
  emergency_contact jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  ride_preferences jsonb DEFAULT '{}'::jsonb,
  rating_avg numeric(3,2) NOT NULL DEFAULT 5.00,
  CONSTRAINT customer_profiles_user_id_key UNIQUE (user_id)
);
ALTER TABLE public.customer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY cp_insert ON public.customer_profiles FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY cp_select ON public.customer_profiles FOR SELECT TO public USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY cp_update ON public.customer_profiles FOR UPDATE TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

-- LIVE tg_customer_profiles_protect_rating() (00434)
CREATE OR REPLACE FUNCTION public.tg_customer_profiles_protect_rating()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF is_admin() THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF current_setting('app.trusted_driver_update', true) = '1' THEN RETURN NEW; END IF;

  NEW.rating_avg := OLD.rating_avg;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_customer_profiles_protect_rating BEFORE UPDATE ON public.customer_profiles FOR EACH ROW EXECUTE FUNCTION tg_customer_profiles_protect_rating();

-- LIVE grants: the three tables are fully granted to the API roles (relacl)
GRANT ALL ON public.rides, public.ride_disputes, public.customer_profiles TO anon, authenticated, service_role;
GRANT SELECT ON public.users, public.driver_profiles TO anon, authenticated, service_role;

-- Ownership like prod: a non-superuser owns the tables and every public function.
ALTER TABLE public.users OWNER TO tricigo_owner;
ALTER TABLE public.driver_profiles OWNER TO tricigo_owner;
ALTER TABLE public.rides OWNER TO tricigo_owner;
ALTER TABLE public.ride_disputes OWNER TO tricigo_owner;
ALTER TABLE public.customer_profiles OWNER TO tricigo_owner;
ALTER FUNCTION public.current_user_role() OWNER TO tricigo_owner;
ALTER FUNCTION public.is_admin() OWNER TO tricigo_owner;
ALTER FUNCTION public.update_updated_at_column() OWNER TO tricigo_owner;
ALTER FUNCTION public.tg_ride_disputes_protect_columns() OWNER TO tricigo_owner;
ALTER FUNCTION public.tg_customer_profiles_protect_rating() OWNER TO tricigo_owner;
ALTER TYPE public.user_role OWNER TO tricigo_owner;
ALTER TYPE public.ride_status OWNER TO tricigo_owner;
ALTER TYPE public.payment_method OWNER TO tricigo_owner;
