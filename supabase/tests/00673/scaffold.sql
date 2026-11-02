-- Scaffold for the 00673 rehearsal (operator role, delivery 4: support, accounts and moderation).
-- Loaded as the superuser before tables.sql, base.sql, live-bodies.sql and wiring.sql.
-- Every object belongs to a NON-superuser role named postgres, as in prod, and postgres is a
-- member of anon, authenticated and service_role. No RLS and every table granted to the API roles:
-- the tests exercise the triggers and the functions, not the policies. Stubs record what the
-- functions would send (test_http_calls, test_rpc_log).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO CURRENT_USER;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

SET ROLE postgres;
-- Until 2026-10-30 Supabase grants every new function and table of public to the API roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

-- Stubs (as in supabase/tests/00668/stubs.sql).
CREATE TABLE public.test_http_calls (
  id bigserial PRIMARY KEY,
  jobname text,
  url text,
  body jsonb,
  at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE public.test_rpc_log (rpc_name text, caller uuid, target uuid, outcome text, metadata jsonb);
CREATE TABLE public.test_rate_hits (key text, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE public.test_rate_locks (key text PRIMARY KEY, n integer NOT NULL DEFAULT 1);

CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
                                      body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF current_setting('test.http_fail', true) = '1' THEN
    RAISE EXCEPTION 'test: the HTTP call failed';
  END IF;
  INSERT INTO public.test_http_calls (jobname, url, body) VALUES (p_jobname, url, body) RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;
CREATE FUNCTION public.get_service_role_key()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  SELECT CASE WHEN current_setting('test.no_key', true) = '1' THEN '' ELSE 'test-service-key' END
$function$;
CREATE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text,
                                       p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_catalog
AS $function$
BEGIN
  INSERT INTO public.test_rpc_log VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$function$;

-- More stubs. get_platform_config_numeric returns the fallback; apply_user_rating records the
-- recompute; process_dispute_refund keeps the live checks (admin role, resolved dispute, fare cap) and
-- the status writes but moves no money (the prod rehearsal runs the real one).
CREATE TABLE public.test_rating_calls (user_id uuid, at timestamptz DEFAULT clock_timestamp());
CREATE TABLE public.test_refunds (dispute_id uuid, admin_id uuid, amount integer, resolution text, txn uuid);

CREATE FUNCTION public.get_platform_config_numeric(p_key text, p_fallback numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  SELECT p_fallback
$function$;

CREATE FUNCTION public.apply_user_rating(p_user_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  INSERT INTO public.test_rating_calls (user_id) VALUES (p_user_id)
$function$;

CREATE FUNCTION public.process_dispute_refund(p_dispute_id uuid, p_admin_id uuid, p_refund_amount_trc integer,
                                              p_resolution text, p_resolution_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_dispute record;
  v_ride record;
  v_txn uuid := gen_random_uuid();
BEGIN
  IF NOT COALESCE((SELECT role IN ('admin', 'super_admin') FROM users WHERE id = auth.uid()), false) THEN
    RAISE EXCEPTION 'Forbidden: admin role required to process dispute refunds';
  END IF;
  SELECT * INTO v_dispute FROM ride_disputes WHERE id = p_dispute_id FOR UPDATE;
  IF v_dispute.status IN ('resolved_rider', 'resolved_driver', 'closed') THEN
    RAISE EXCEPTION 'Dispute % is already resolved (status: %)', p_dispute_id, v_dispute.status;
  END IF;
  SELECT * INTO v_ride FROM rides WHERE id = v_dispute.ride_id FOR UPDATE;
  IF p_refund_amount_trc > COALESCE(v_ride.final_fare_trc, 0) THEN
    RAISE EXCEPTION 'Refund (%) exceeds ride fare (%)', p_refund_amount_trc, COALESCE(v_ride.final_fare_trc, 0);
  END IF;
  INSERT INTO test_refunds VALUES (p_dispute_id, p_admin_id, p_refund_amount_trc, p_resolution, v_txn);
  UPDATE ride_disputes SET
    status = CASE WHEN p_resolution IN ('full_refund', 'partial_refund', 'credit') THEN 'resolved_rider'
                  WHEN p_resolution IN ('no_action', 'warning_issued') THEN 'resolved_driver' ELSE 'closed' END,
    resolution = p_resolution, resolution_notes = p_resolution_notes, refund_amount_trc = p_refund_amount_trc,
    refund_transaction_id = v_txn, resolved_at = now(), updated_at = now()
  WHERE id = p_dispute_id;
  IF v_ride.status = 'disputed' THEN
    UPDATE rides SET status = 'completed', updated_at = now() WHERE id = v_ride.id;
  END IF;
  RETURN v_txn;
END
$function$;
REVOKE ALL ON FUNCTION public.get_platform_config_numeric(text, numeric), public.apply_user_rating(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_dispute_refund(uuid, uuid, integer, text, text) FROM PUBLIC, anon;

-- The auth tables admin_set_user_active writes (only the columns it touches).
CREATE TABLE auth.users (id uuid PRIMARY KEY, banned_until timestamptz, phone text, phone_confirmed_at timestamptz);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, user_id text, session_id uuid);

-- The 00671 helpers, as applied in prod on 2026-11-02 (section A of 00671).
CREATE OR REPLACE FUNCTION public._ops_allow(p_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_cur text := COALESCE(pg_catalog.current_setting('app.ops_targets', true), '');
BEGIN
  PERFORM pg_catalog.set_config('app.ops_targets',
    pg_catalog.concat_ws(',', NULLIF(v_cur, ''), pg_catalog.array_to_string(p_ids, ',')), true);
END
$function$;

CREATE OR REPLACE FUNCTION public._ops_acting_on(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_targets text := COALESCE(pg_catalog.current_setting('app.ops_targets', true), '');
BEGIN
  -- The setting first: without it nobody acts on anything, and is_ops_staff() is not asked.
  IF p_id IS NULL OR v_targets = '' THEN
    RETURN false;
  END IF;
  RETURN p_id::text = ANY (pg_catalog.string_to_array(v_targets, ',')) AND public.is_ops_staff();
END
$function$;

-- Only ops functions set the list. The check is called from triggers, also from SECURITY INVOKER
-- ones in a later delivery, so every role may call it; it reads only a setting clients cannot set.
REVOKE ALL ON FUNCTION public._ops_allow(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._ops_acting_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._ops_acting_on(uuid) TO anon, authenticated, service_role;

