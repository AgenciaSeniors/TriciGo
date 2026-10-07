-- Scaffold for the 00626 rehearsal: realtime.messages with prod's columns, grants,
-- RLS and the two live private-topic policies (rider-location 00433, ride-search 00440),
-- realtime.topic() and public.is_ride_party() as LIVE in prod on 2026-10-07, plus the
-- minimum of rides and driver_profiles that is_ride_party reads.
-- No Supabase stack: auth.uid() reads request.jwt.claim.sub like PostgREST, and the test
-- sets realtime.topic the way Realtime does when it authorizes a private join.
-- In prod realtime.messages belongs to supabase_realtime_admin and postgres (not a member)
-- may still manage its policies through supautils.policy_grants. Here the migration's
-- non-superuser owner (tricigo_owner) gets that role to stand in for it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tricigo_owner') THEN CREATE ROLE tricigo_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, tricigo_owner TO pgtest;
GRANT anon, authenticated, service_role TO tricigo_owner;
GRANT supabase_realtime_admin TO tricigo_owner;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS realtime;
GRANT USAGE ON SCHEMA public, auth, realtime TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO tricigo_owner;
ALTER SCHEMA auth OWNER TO tricigo_owner;
ALTER SCHEMA realtime OWNER TO supabase_realtime_admin;

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

-- realtime.messages (prod: partitioned by day on inserted_at) and realtime.topic().
SET ROLE supabase_realtime_admin;
CREATE TABLE realtime.messages (
  topic text NOT NULL,
  extension text NOT NULL,
  payload jsonb,
  event text,
  private boolean DEFAULT false,
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  inserted_at timestamp without time zone NOT NULL DEFAULT now(),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  binary_payload bytea,
  skip_broadcast boolean NOT NULL DEFAULT false
) PARTITION BY RANGE (inserted_at);
CREATE TABLE realtime.messages_default PARTITION OF realtime.messages DEFAULT;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON realtime.messages TO anon, authenticated;

CREATE OR REPLACE FUNCTION realtime.topic()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
select nullif(current_setting('realtime.topic', true), '')::text;
$function$
;
RESET ROLE;

SET ROLE tricigo_owner;

CREATE TABLE public.driver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
CREATE TABLE public.rides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  driver_id uuid REFERENCES public.driver_profiles(id)
);
CREATE TABLE public.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id uuid NOT NULL REFERENCES public.rides(id),
  driver_profile_id uuid NOT NULL REFERENCES public.driver_profiles(id),
  expires_at timestamptz
);

CREATE OR REPLACE FUNCTION public.is_ride_party(p_ride_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM rides r
    WHERE r.id = p_ride_id
      AND (
        r.customer_id = auth.uid()
        OR r.driver_id IN (SELECT dp.id FROM driver_profiles dp WHERE dp.user_id = auth.uid())
      )
  );
$function$
;
GRANT EXECUTE ON FUNCTION public.is_ride_party(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_access_ride_search(p_ride_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM rides r WHERE r.id = p_ride_id AND r.customer_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM ride_offers ro
      JOIN driver_profiles dp ON dp.id = ro.driver_profile_id
      WHERE ro.ride_id = p_ride_id
        AND dp.user_id = auth.uid()
        AND (ro.expires_at IS NULL OR ro.expires_at > now())
    );
$function$
;
GRANT EXECUTE ON FUNCTION public.can_access_ride_search(uuid) TO authenticated;

-- The live private-topic policies (00433, 00440).
CREATE POLICY rider_location_broadcast_read ON realtime.messages FOR SELECT TO authenticated
  USING (extension = 'broadcast' AND realtime.topic() ~ '^rider-location:[0-9a-fA-F-]{36}$'
         AND public.is_ride_party(substring(realtime.topic() FROM 16)::uuid));
CREATE POLICY rider_location_broadcast_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (extension = 'broadcast' AND realtime.topic() ~ '^rider-location:[0-9a-fA-F-]{36}$'
              AND public.is_ride_party(substring(realtime.topic() FROM 16)::uuid));
CREATE POLICY ride_search_realtime_read ON realtime.messages FOR SELECT TO authenticated
  USING (extension IN ('broadcast', 'presence') AND realtime.topic() ~ '^ride-search:[0-9a-fA-F-]{36}$'
         AND public.can_access_ride_search(substring(realtime.topic() FROM 13)::uuid));
CREATE POLICY ride_search_realtime_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (extension IN ('broadcast', 'presence') AND realtime.topic() ~ '^ride-search:[0-9a-fA-F-]{36}$'
              AND public.can_access_ride_search(substring(realtime.topic() FROM 13)::uuid));

-- Seed: ride R (rider RITA, driver DAVID), ride S (rider SOFIA, driver DORA),
-- ride Q still searching (rider RITA, no driver). OMAR is nobody's party.
INSERT INTO public.driver_profiles (id, user_id) VALUES
  ('d1000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000da'),
  ('d2000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000db');
INSERT INTO public.rides (id, customer_id, driver_id) VALUES
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '00000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000d1'),
  ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', '00000000-0000-4000-8000-0000000000a2', 'd2000000-0000-4000-8000-0000000000d2'),
  ('cccccccc-3333-4333-8333-cccccccccccc', '00000000-0000-4000-8000-0000000000a1', NULL);
RESET ROLE;
