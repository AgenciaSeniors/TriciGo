-- Scaffold for the 00654 rehearsal (local Postgres 16, no Supabase stack needed).
-- Generated on 2026-10-11 from prod (pg_get_functiondef, information_schema, pg_enum):
--   * role postgres: NOT a superuser, BYPASSRLS. It owns every function and table here
--     and applies the migration, as in prod.
--   * byte for byte the prod bodies of the six functions 00654 changes
--     (detect_collusion_reviews, get_peak_hours, get_driver_utilization, get_auto_accept_rate,
--     get_auto_nav_rate, get_override_frequency) and of what they call (is_admin,
--     is_marketing, current_user_role, auth.uid, get_platform_config_numeric); run.sh S0
--     compares md5(prosrc) with prod.
--   * their prod ACLs: the six are executable by authenticated and service_role, not anon;
--     current_user_role is not executable by anon (00517).
--   * users, driver_profiles and rides carry only the columns these functions read;
--     cancellation_reviews and validation_events carry prod's columns (and the reviews' checks
--     and pending-pair index).
--   * seed: an admin, a marketing user, two riders and four drivers. Two canceled rides
--     between rider C1 and driver DP2 after the driver arrived (one collusion case), one ride
--     in progress for DP1, one completed for DP3. In Havana time: day-1 08:10 and 08:40,
--     day-2 08:20, day-1 14:05. Peak hours: 8h -> 1.5, 14h -> 1.0. Utilization of approved
--     drivers: 2 online, 1 busy, 1 idle, 1 offline (DP4 is pending and does not count).
--     validation_events in the last 7 days: auto-accept "high" 2 accepted + 1 rejected, "low"
--     1 rejected; auto-nav 3 triggered + 1 cancelled; DP1 rejected 2 offers, DP2 cancelled one
--     navigation. One more rejection by DP1, 40 days old, is outside every 7-day window.
-- The t.* objects at the end are test helpers, not production shapes.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT anon, authenticated, service_role, postgres TO pgtest;
GRANT USAGE, CREATE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ── auth.uid(): prod's body ─────────────────────────────────────────────────
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
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
GRANT EXECUTE ON FUNCTION auth.uid() TO postgres, anon, authenticated, service_role;

-- ── public: types and tables (owned by postgres, as in prod) ────────────────
SET ROLE postgres;

CREATE TYPE public.user_role AS ENUM ('customer', 'driver', 'admin', 'super_admin', 'marketing');
CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');
CREATE TYPE public.driver_status AS ENUM ('pending_verification', 'under_review', 'approved', 'rejected', 'suspended');

-- Only the columns these functions read.
CREATE TABLE public.users (
  id      uuid PRIMARY KEY,
  role    public.user_role NOT NULL DEFAULT 'customer',
  is_test boolean NOT NULL DEFAULT false
);
CREATE TABLE public.driver_profiles (
  id        uuid PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES public.users (id),
  status    public.driver_status NOT NULL DEFAULT 'pending_verification',
  is_online boolean DEFAULT false
);
CREATE TABLE public.rides (
  id                       uuid PRIMARY KEY,
  customer_id              uuid REFERENCES public.users (id),
  driver_id                uuid REFERENCES public.driver_profiles (id),
  status                   public.ride_status NOT NULL DEFAULT 'searching',
  driver_arrived_at        timestamptz,
  canceled_at              timestamptz,
  cancellation_reason_code text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_config (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- prod's columns, checks and indexes
CREATE TABLE public.cancellation_reviews (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  driver_id     uuid NOT NULL,
  customer_id   uuid NOT NULL,
  signal_type   text NOT NULL DEFAULT 'repeated_pair'::text,
  risk_score    numeric NOT NULL DEFAULT 0,
  signals       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ride_ids      uuid[] NOT NULL DEFAULT '{}'::uuid[],
  status        text NOT NULL DEFAULT 'pending'::text,
  verdict       text,
  sanction_type text,
  admin_notes   text,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT cancellation_reviews_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.users (id) ON DELETE CASCADE,
  CONSTRAINT cancellation_reviews_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.driver_profiles (id) ON DELETE CASCADE,
  CONSTRAINT cancellation_reviews_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users (id),
  CONSTRAINT cancellation_reviews_sanction_type_check CHECK ((sanction_type = ANY (ARRAY['warning'::text, 'reputation'::text]))),
  CONSTRAINT cancellation_reviews_signal_type_check CHECK ((signal_type = ANY (ARRAY['repeated_pair'::text, 'driver_rate_anomaly'::text, 'reported'::text]))),
  CONSTRAINT cancellation_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'dismissed'::text, 'sanctioned'::text]))),
  CONSTRAINT cancellation_reviews_verdict_check CHECK ((verdict = ANY (ARRAY['just'::text, 'unjust'::text])))
);
-- prod's columns
CREATE TABLE public.validation_events (
  id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id  uuid,
  event_type text NOT NULL,
  ride_id    uuid,
  properties jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX uq_cancellation_reviews_pending_pair ON public.cancellation_reviews USING btree (driver_id, customer_id) WHERE (status = 'pending'::text);

-- ── the live functions ───────────────────────────────────────────────────────
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

CREATE OR REPLACE FUNCTION public.is_marketing()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- No JWT subject: anon, service role, cron. None of them is marketing, and anon may not
  -- call current_user_role() (00517). Same early return as is_admin() (00592).
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.current_user_role() = 'marketing';
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

CREATE OR REPLACE FUNCTION public.detect_collusion_reviews()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_window_days  integer := COALESCE(get_platform_config_numeric('collusion_pair_window_days', 180), 180)::integer;
  v_min_cancels  integer := COALESCE(get_platform_config_numeric('collusion_pair_min_cancels', 2), 2)::integer;
  v_min_score    numeric := COALESCE(get_platform_config_numeric('collusion_review_min_score', 40), 40);
  v_cooldown     integer := COALESCE(get_platform_config_numeric('collusion_dismiss_cooldown_days', 30), 30)::integer;
  v_exempt       text[] := ARRAY['no_show','passenger_gone','breakdown','safety','emergency'];
  v_count        integer := 0;
  v_score        numeric;
  rec            record;
BEGIN
  FOR rec IN
    SELECT p.customer_id, p.driver_id,
           count(*)                                                          AS pair_cancel_count,
           count(*) FILTER (WHERE p.rc IS NULL OR NOT (p.rc = ANY(v_exempt))) AS nonexempt_count,
           count(*) FILTER (WHERE p.rc = ANY(v_exempt))                       AS exempt_count,
           array_agg(p.ride_id)                                              AS ride_ids
    FROM (
      SELECT r.customer_id, r.driver_id, r.id AS ride_id, r.cancellation_reason_code AS rc
      FROM rides r
      JOIN driver_profiles dp ON dp.id = r.driver_id
      JOIN users du ON du.id = dp.user_id
      JOIN users cu ON cu.id = r.customer_id
      WHERE r.status = 'canceled'
        AND r.driver_id IS NOT NULL AND r.customer_id IS NOT NULL
        AND r.driver_arrived_at IS NOT NULL
        AND r.canceled_at > now() - (v_window_days || ' days')::interval
        AND du.is_test = false AND cu.is_test = false
    ) p
    GROUP BY p.customer_id, p.driver_id
    HAVING count(*) >= v_min_cancels
  LOOP
    IF EXISTS (
      SELECT 1 FROM cancellation_reviews cr
      WHERE cr.driver_id = rec.driver_id AND cr.customer_id = rec.customer_id
        AND cr.status = 'dismissed'
        AND cr.reviewed_at > now() - (v_cooldown || ' days')::interval
    ) THEN
      CONTINUE;
    END IF;

    v_score := LEAST(100, 40 + 20 * (rec.nonexempt_count - 1) + 5 * rec.exempt_count);
    IF v_score < v_min_score THEN CONTINUE; END IF;

    INSERT INTO cancellation_reviews (driver_id, customer_id, signal_type, risk_score, signals, ride_ids, status)
    VALUES (
      rec.driver_id, rec.customer_id, 'repeated_pair', v_score,
      jsonb_build_object(
        'pair_cancel_count', rec.pair_cancel_count,
        'nonexempt_count', rec.nonexempt_count,
        'exempt_count', rec.exempt_count,
        'window_days', v_window_days
      ),
      rec.ride_ids, 'pending'
    )
    ON CONFLICT (driver_id, customer_id) WHERE status = 'pending'
    DO UPDATE SET
      risk_score  = EXCLUDED.risk_score,
      signals     = EXCLUDED.signals,
      signal_type = EXCLUDED.signal_type,
      ride_ids    = (SELECT array_agg(DISTINCT e) FROM unnest(cancellation_reviews.ride_ids || EXCLUDED.ride_ids) e),
      updated_at  = now();
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_peak_hours(p_days_back integer DEFAULT 30)
 RETURNS TABLE(hour integer, avg_rides numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH hourly AS (
    SELECT EXTRACT(HOUR FROM r.created_at AT TIME ZONE 'America/Havana')::INT AS hour,
           (r.created_at AT TIME ZONE 'America/Havana')::DATE AS day,
           COUNT(*) AS rides
    FROM rides r
    WHERE r.created_at >= ((((now() AT TIME ZONE 'America/Havana')::date - p_days_back)::timestamp) AT TIME ZONE 'America/Havana')
    GROUP BY 1, 2
  )
  SELECT h.hour, ROUND(AVG(h.rides), 1) AS avg_rides FROM hourly h GROUP BY h.hour ORDER BY h.hour;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_utilization()
 RETURNS TABLE(online integer, busy integer, idle integer, offline integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    COUNT(*) FILTER (WHERE dp.is_online = true)::INT AS online,
    COUNT(*) FILTER (WHERE dp.is_online = true AND EXISTS(
      SELECT 1 FROM rides r WHERE r.driver_id = dp.id AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS busy,
    COUNT(*) FILTER (WHERE dp.is_online = true AND NOT EXISTS(
      SELECT 1 FROM rides r WHERE r.driver_id = dp.id AND r.status IN ('accepted','driver_en_route','arrived_at_pickup','in_progress')
    ))::INT AS idle,
    COUNT(*) FILTER (WHERE dp.is_online = false OR dp.is_online IS NULL)::INT AS offline
  FROM driver_profiles dp WHERE dp.status = 'approved';
$function$;

CREATE OR REPLACE FUNCTION public.get_auto_accept_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(profit_level text, total bigint, accepted bigint, rejected bigint, accept_rate numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    properties->>'profit_level' as profit_level,
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::bigint as accepted,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as rejected,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_ride_auto_accepted')::numeric / NULLIF(COUNT(*), 0) * 100,
      1
    ) as accept_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_auto_accepted', 'driver_ride_rejected')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY properties->>'profit_level'
$function$;

CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
 RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    COUNT(*)::bigint as total,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::bigint as triggered,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as cancelled,
    ROUND(
      COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_triggered')::numeric /
      NULLIF(COUNT(*) FILTER (WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')), 0) * 100,
      1
    ) as follow_rate
  FROM public.validation_events
  WHERE event_type IN ('driver_auto_nav_triggered', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
$function$;

CREATE OR REPLACE FUNCTION public.get_override_frequency(p_days_back integer DEFAULT 7, p_limit integer DEFAULT 20)
 RETURNS TABLE(driver_id uuid, total_overrides bigint, reject_count bigint, nav_cancel_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT
    driver_id,
    COUNT(*)::bigint as total_overrides,
    COUNT(*) FILTER (WHERE event_type = 'driver_ride_rejected')::bigint as reject_count,
    COUNT(*) FILTER (WHERE event_type = 'driver_auto_nav_cancelled')::bigint as nav_cancel_count
  FROM public.validation_events
  WHERE event_type IN ('driver_ride_rejected', 'driver_auto_nav_cancelled')
    AND created_at >= now() - (p_days_back || ' days')::interval
  GROUP BY driver_id
  ORDER BY total_overrides DESC
  LIMIT p_limit
$function$;

-- prod ACLs
REVOKE ALL ON FUNCTION public.current_user_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_marketing() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric(text, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.detect_collusion_reviews() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_peak_hours(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_utilization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_collusion_reviews() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_peak_hours(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_utilization() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_auto_accept_rate(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_auto_nav_rate(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_override_frequency(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_auto_accept_rate(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_auto_nav_rate(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_override_frequency(integer, integer) TO authenticated, service_role;

-- ── seed ─────────────────────────────────────────────────────────────────────
INSERT INTO public.platform_config (key, value) VALUES
  ('collusion_pair_min_cancels', '2'), ('collusion_pair_window_days', '180'),
  ('collusion_review_min_score', '40'), ('collusion_dismiss_cooldown_days', '30');

INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'admin'),
  ('00000000-0000-4000-8000-0000000000a2', 'marketing'),
  ('00000000-0000-4000-8000-0000000000c1', 'customer'),
  ('00000000-0000-4000-8000-0000000000c2', 'customer'),
  ('00000000-0000-4000-8000-0000000000d1', 'driver'),
  ('00000000-0000-4000-8000-0000000000d2', 'driver'),
  ('00000000-0000-4000-8000-0000000000d3', 'driver'),
  ('00000000-0000-4000-8000-0000000000d4', 'driver');

INSERT INTO public.driver_profiles (id, user_id, status, is_online) VALUES
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000d1', 'approved', true),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000d2', 'approved', true),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-0000000000d3', 'approved', false),
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000d4', 'pending_verification', true);

-- t.havana(days_ago, 'HH:MI') -> that Havana wall-clock time, as timestamptz
CREATE FUNCTION pg_temp.havana(p_days integer, p_time time) RETURNS timestamptz LANGUAGE sql AS
  $h$ SELECT (((now() AT TIME ZONE 'America/Havana')::date - p_days) + p_time) AT TIME ZONE 'America/Havana' $h$;
INSERT INTO public.rides (id, customer_id, driver_id, status, driver_arrived_at, canceled_at, created_at) VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e2',
   'canceled', pg_temp.havana(1, '08:15'), pg_temp.havana(1, '08:20'), pg_temp.havana(1, '08:10')),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e2',
   'canceled', pg_temp.havana(2, '08:25'), pg_temp.havana(2, '08:30'), pg_temp.havana(2, '08:20')),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000e1',
   'in_progress', pg_temp.havana(1, '08:45'), NULL, pg_temp.havana(1, '08:40')),
  ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000e3',
   'completed', pg_temp.havana(1, '14:10'), NULL, pg_temp.havana(1, '14:05'));

INSERT INTO public.validation_events (driver_id, event_type, properties, created_at) VALUES
  ('00000000-0000-4000-8000-0000000000e1', 'driver_ride_auto_accepted', '{"profit_level": "high"}', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e1', 'driver_ride_auto_accepted', '{"profit_level": "high"}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e1', 'driver_ride_rejected', '{"profit_level": "high"}', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e1', 'driver_ride_rejected', '{"profit_level": "low"}', now() - interval '3 days'),
  ('00000000-0000-4000-8000-0000000000e1', 'driver_ride_rejected', '{"profit_level": "low"}', now() - interval '40 days'),
  ('00000000-0000-4000-8000-0000000000e2', 'driver_auto_nav_triggered', '{}', now() - interval '1 day'),
  ('00000000-0000-4000-8000-0000000000e2', 'driver_auto_nav_triggered', '{}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e1', 'driver_auto_nav_triggered', '{}', now() - interval '2 days'),
  ('00000000-0000-4000-8000-0000000000e2', 'driver_auto_nav_cancelled', '{}', now() - interval '1 day');

RESET ROLE;

-- ── test helpers ─────────────────────────────────────────────────────────────
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO PUBLIC;
-- t.outcome(sql) -> 'ok: <first column of the first row>' or 'raised <sqlstate>: <message>'
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $o$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'ok: ' || coalesce(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RETURN 'raised ' || SQLSTATE || ': ' || SQLERRM;
END $o$;
GRANT EXECUTE ON FUNCTION t.outcome(text) TO PUBLIC;
-- t.detect() / t.peak() / t.util(): the three functions as text, run as the caller (invoker)
CREATE FUNCTION t.detect() RETURNS text LANGUAGE sql AS $x$ SELECT public.detect_collusion_reviews()::text $x$;
CREATE FUNCTION t.peak() RETURNS text LANGUAGE sql AS
  $x$ SELECT string_agg(hour || '|' || avg_rides, ',' ORDER BY hour) FROM public.get_peak_hours(30) $x$;
CREATE FUNCTION t.util() RETURNS text LANGUAGE sql AS
  $x$ SELECT online || '|' || busy || '|' || idle || '|' || offline FROM public.get_driver_utilization() $x$;
GRANT EXECUTE ON FUNCTION t.detect(), t.peak(), t.util() TO PUBLIC;
-- t.cases() -> the cancellation_reviews rows, as text
CREATE FUNCTION t.cases() RETURNS text LANGUAGE sql AS
  $x$ SELECT coalesce(string_agg(right(driver_id::text, 2) || '/' || right(customer_id::text, 2) || '/' || risk_score
         || '/' || status || '/' || cardinality(ride_ids), ',' ORDER BY driver_id, customer_id), '<none>')
      FROM public.cancellation_reviews $x$;
-- t.accept() / t.nav() / t.overrides(): the three /validation functions as text, run as the caller
CREATE FUNCTION t.accept() RETURNS text LANGUAGE sql AS
  $x$ SELECT string_agg(profit_level || '|' || total || '|' || accepted || '|' || rejected || '|' || accept_rate, ','
         ORDER BY profit_level) FROM public.get_auto_accept_rate(7) $x$;
CREATE FUNCTION t.nav() RETURNS text LANGUAGE sql AS
  $x$ SELECT total || '|' || triggered || '|' || cancelled || '|' || follow_rate FROM public.get_auto_nav_rate(7) $x$;
CREATE FUNCTION t.overrides() RETURNS text LANGUAGE sql AS
  $x$ SELECT string_agg(right(driver_id::text, 2) || '|' || total_overrides || '|' || reject_count || '|' || nav_cancel_count, ','
         ORDER BY total_overrides DESC, driver_id) FROM public.get_override_frequency(7, 20) $x$;
GRANT EXECUTE ON FUNCTION t.accept(), t.nav(), t.overrides() TO PUBLIC;
