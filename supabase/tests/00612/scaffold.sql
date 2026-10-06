-- Scaffold for the 00612 rehearsal: ride_splits, driver_documents and the users.is_test
-- column with the columns, constraints, policies and grants read from prod on 2026-10-06,
-- and the LIVE bodies of auth.uid(), current_user_role() and is_admin() (00592), byte-exact
-- from the 00611 scaffold. No Supabase stack: auth.uid() reads request.jwt.claim.sub like
-- PostgREST. A NON-superuser role (prod: postgres) owns everything; run.sh applies the
-- migration as that role. rides and driver_profiles carry only what the policies read.
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
ALTER SCHEMA auth OWNER TO tricigo_owner;

SET ROLE tricigo_owner;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.document_type AS ENUM ('national_id', 'drivers_license', 'vehicle_registration',
  'selfie', 'vehicle_photo', 'operating_license');

CREATE TABLE auth.users (id uuid PRIMARY KEY);

-- public.users: only the columns this migration and its tests touch.
-- LIVE grants: anon/authenticated hold table-wide UPDATE (rwdDxtm, no INSERT since 00605).
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role public.user_role NOT NULL DEFAULT 'customer',
  full_name text,
  is_test boolean NOT NULL DEFAULT false
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.users TO anon, authenticated;
GRANT ALL ON public.users TO service_role;

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
$function$
;

-- LIVE policies on users (users_update_own has no WITH CHECK; no admin UPDATE policy)
CREATE POLICY users_select_own ON public.users FOR SELECT USING ((id = ( SELECT auth.uid() AS uid)) OR is_admin());
CREATE POLICY users_update_own ON public.users FOR UPDATE USING ((id = ( SELECT auth.uid() AS uid)));

-- rides: only what the ride_splits policies read
CREATE TABLE public.rides (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  driver_id uuid,
  status public.ride_status NOT NULL DEFAULT 'searching',
  payment_method text NOT NULL DEFAULT 'cash',
  is_split boolean NOT NULL DEFAULT false
);
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.rides TO authenticated;
GRANT ALL ON public.rides TO service_role;
CREATE POLICY rides_select_party ON public.rides FOR SELECT USING (customer_id = auth.uid() OR is_admin());

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
);
ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.driver_profiles TO authenticated;
GRANT ALL ON public.driver_profiles TO service_role;
CREATE POLICY dp_select_own ON public.driver_profiles FOR SELECT USING (user_id = auth.uid() OR is_admin());

-- LIVE ride_splits DDL, constraints, policies and grants
CREATE TABLE public.ride_splits (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id uuid NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  share_pct numeric(5,2) NOT NULL DEFAULT 0,
  amount_trc integer,
  payment_status text NOT NULL DEFAULT 'pending',
  invited_by uuid NOT NULL REFERENCES auth.users(id),
  accepted_at timestamp with time zone,
  paid_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ride_splits_amount_trc_nonneg CHECK (amount_trc IS NULL OR amount_trc >= 0),
  CONSTRAINT ride_splits_ride_id_user_id_key UNIQUE (ride_id, user_id)
);
ALTER TABLE public.ride_splits ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.ride_splits TO anon, authenticated, service_role;
CREATE POLICY split_select ON public.ride_splits FOR SELECT USING (((user_id = auth.uid()) OR (ride_id IN ( SELECT rides.id
   FROM rides
  WHERE (rides.customer_id = auth.uid()))) OR is_admin()));
CREATE POLICY split_insert ON public.ride_splits FOR INSERT WITH CHECK ((ride_id IN ( SELECT rides.id
   FROM rides
  WHERE ((rides.customer_id = auth.uid()) AND (rides.status = ANY (ARRAY['searching'::ride_status, 'accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status]))))));
CREATE POLICY split_update ON public.ride_splits FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY split_delete ON public.ride_splits FOR DELETE USING ((ride_id IN ( SELECT rides.id
   FROM rides
  WHERE ((rides.customer_id = auth.uid()) AND (rides.status = ANY (ARRAY['searching'::ride_status, 'accepted'::ride_status, 'driver_en_route'::ride_status, 'arrived_at_pickup'::ride_status]))))));

-- LIVE driver_documents DDL, policies and grants
CREATE TABLE public.driver_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id uuid NOT NULL REFERENCES public.driver_profiles(id) ON DELETE CASCADE,
  document_type public.document_type NOT NULL,
  storage_path text NOT NULL,
  file_name text NOT NULL DEFAULT '',
  uploaded_at timestamp with time zone NOT NULL DEFAULT now(),
  is_verified boolean NOT NULL DEFAULT false,
  verified_by uuid REFERENCES public.users(id),
  verified_at timestamp with time zone,
  rejection_reason text,
  verification_notes text,
  face_match_score real,
  liveness_passed boolean,
  mime_type text DEFAULT 'image/jpeg'
);
ALTER TABLE public.driver_documents ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.driver_documents TO anon, authenticated, service_role;
CREATE POLICY dd_insert ON public.driver_documents FOR INSERT WITH CHECK ((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY dd_select ON public.driver_documents FOR SELECT USING (((driver_id IN ( SELECT driver_profiles.id
   FROM driver_profiles
  WHERE (driver_profiles.user_id = ( SELECT auth.uid() AS uid)))) OR is_admin()));
CREATE POLICY dd_admin_insert ON public.driver_documents FOR INSERT WITH CHECK (is_admin());
CREATE POLICY dd_admin_select ON public.driver_documents FOR SELECT USING (is_admin());
CREATE POLICY dd_update ON public.driver_documents FOR UPDATE USING (is_admin());

-- Stand-in for the split loop of complete_ride_and_pay (SECURITY DEFINER, sets
-- app.trusted_driver_update at its start, then marks every accepted split paid).
CREATE OR REPLACE FUNCTION public.sim_pay_splits(p_ride_id uuid, p_fare integer, p_trusted boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF p_trusted THEN
    PERFORM set_config('app.trusted_driver_update', '1', true);
  END IF;
  UPDATE ride_splits
     SET amount_trc = ROUND(p_fare * share_pct / 100), payment_status = 'paid', paid_at = now()
   WHERE ride_id = p_ride_id AND accepted_at IS NOT NULL;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.sim_pay_splits(uuid, integer, boolean) TO authenticated;

-- Stand-in for an admin RPC that edits users (there is no admin UPDATE policy on users).
CREATE OR REPLACE FUNCTION public.sim_definer_set_is_test(p_user uuid, p_value boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  UPDATE users SET is_test = p_value WHERE id = p_user;
$function$;
GRANT EXECUTE ON FUNCTION public.sim_definer_set_is_test(uuid, boolean) TO authenticated;

-- Seed. Ana asks for rides and invites; Beto is invited and is a test account; Cora is an
-- admin; Dani drives; Eva is another customer.
INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'), ('b0000000-0000-4000-8000-000000000002'),
  ('c0000000-0000-4000-8000-000000000003'), ('d0000000-0000-4000-8000-000000000004'),
  ('e0000000-0000-4000-8000-000000000005');
INSERT INTO public.users (id, role, full_name, is_test) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'customer', 'Ana',  false),
  ('b0000000-0000-4000-8000-000000000002', 'customer', 'Beto', true),
  ('c0000000-0000-4000-8000-000000000003', 'admin',    'Cora', false),
  ('d0000000-0000-4000-8000-000000000004', 'driver',   'Dani', false),
  ('e0000000-0000-4000-8000-000000000005', 'customer', 'Eva',  false);
INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('d1000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004');
-- R1: Ana's ride with Dani, Beto invited at 50% and not answered yet. R2: Ana's ride, no splits.
INSERT INTO public.rides (id, customer_id, driver_id, status, payment_method, is_split) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'accepted', 'tricicoin', true),
  ('f2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'searching', 'tricicoin', false);
INSERT INTO public.ride_splits (id, ride_id, user_id, share_pct, invited_by) VALUES
  ('51000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000002', 50, 'a0000000-0000-4000-8000-000000000001');
INSERT INTO public.driver_documents (id, driver_id, document_type, storage_path, file_name) VALUES
  ('dd000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'national_id', 'driver-docs/d/id.jpg', 'id.jpg');

RESET ROLE;
