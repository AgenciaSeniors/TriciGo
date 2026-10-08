-- Scaffold for the 00646 rehearsal (local Postgres 16, no Supabase stack needed).
-- Generated on 2026-10-08 from prod (pg_get_functiondef, information_schema, cron.job):
--   * role postgres: NOT a superuser, BYPASSRLS. It owns every function and table
--     here and applies the migration, as in prod.
--   * byte for byte the prod bodies of retry_dispatch_expired_rides (the one 00646
--     patches), log_rpc_attempt and cron_sql_failures_now (check_cron_sql_failures'
--     read-only helper); run.sh S0 compares md5(prosrc) with the values read from prod.
--   * dispatch_ride and notify_offline_drivers_for_searching_rides are STUBS: the
--     real ones need PostGIS, drivers and pushes, and what 00646 changes is only how
--     retry_dispatch_expired_rides handles their errors. The dispatch_ride stub
--     re-dispatches a ride (new pending offer, dispatch_round + 1) unless the ride
--     id is listed in the session setting test.poison: then it first inserts a
--     partial offer and raises, so a test can check that the partial work rolls back.
--     The push stub raises when test.push_fails = '1'.
--   * rides and ride_offers carry only the columns these functions use; rpc_attempt_log
--     carries prod's columns.
--   * pg_cron: cron.job, cron.job_run_details and named-signature stubs of
--     cron.schedule / cron.unschedule (same as supabase/tests/00640).
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

-- ── pg_cron ──────────────────────────────────────────────────────────────────
CREATE SCHEMA cron;
CREATE SEQUENCE cron.jobid_seq;
CREATE SEQUENCE cron.runid_seq;

CREATE TABLE cron.job (
  jobid    bigint  NOT NULL DEFAULT nextval('cron.jobid_seq'),
  schedule text    NOT NULL,
  command  text    NOT NULL,
  nodename text    NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT inet_server_port(),
  database text    NOT NULL DEFAULT current_database(),
  username text    NOT NULL DEFAULT CURRENT_USER,
  active   boolean NOT NULL DEFAULT true,
  jobname  text
);
CREATE UNIQUE INDEX job_pkey ON cron.job (jobid);
CREATE UNIQUE INDEX jobname_username_uniq ON cron.job (jobname, username);

CREATE TABLE cron.job_run_details (
  jobid          bigint,
  runid          bigint NOT NULL DEFAULT nextval('cron.runid_seq'),
  job_pid        integer,
  database       text,
  username       text,
  command        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
);
CREATE UNIQUE INDEX job_run_details_pkey ON cron.job_run_details (runid);

ALTER TABLE cron.job ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron.job_run_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY cron_job_policy ON cron.job USING (username = CURRENT_USER);
CREATE POLICY cron_job_run_details_policy ON cron.job_run_details USING (username = CURRENT_USER);
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL ON cron.job, cron.job_run_details TO postgres;
GRANT USAGE, SELECT ON SEQUENCE cron.jobid_seq, cron.runid_seq TO postgres;

-- ── public: tables (owned by postgres, as in prod) ──────────────────────────
SET ROLE postgres;

CREATE TYPE public.ride_status AS ENUM ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
  'in_progress', 'arrived_at_destination', 'completed', 'canceled', 'disputed');

-- Only the columns these functions use.
CREATE TABLE public.rides (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status             public.ride_status NOT NULL DEFAULT 'searching',
  ride_mode          text NOT NULL DEFAULT 'passenger',
  dispatch_round     integer NOT NULL DEFAULT 0,
  last_dispatched_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.ride_offers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id    uuid NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL
);

-- prod's columns
CREATE TABLE public.rpc_attempt_log (
  id         bigserial PRIMARY KEY,
  rpc_name   text NOT NULL,
  caller_uid uuid,
  target_id  uuid,
  outcome    text NOT NULL,
  metadata   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- STUB (see the header).
CREATE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
BEGIN
  IF p_ride_id::text = ANY (string_to_array(COALESCE(current_setting('test.poison', true), ''), ',')) THEN
    INSERT INTO ride_offers (ride_id, expires_at) VALUES (p_ride_id, now() + interval '60 seconds');
    RAISE EXCEPTION 'stub: dispatch_ride failed for ride %', p_ride_id USING ERRCODE = '23514';
  END IF;
  UPDATE rides SET dispatch_round = dispatch_round + 1, last_dispatched_at = now() WHERE id = p_ride_id;
  INSERT INTO ride_offers (ride_id, expires_at) VALUES (p_ride_id, now() + interval '60 seconds');
  RETURN jsonb_build_object('ok', true);
END $$;

-- STUB (see the header).
CREATE FUNCTION public.notify_offline_drivers_for_searching_rides() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS $$
BEGIN
  IF current_setting('test.push_fails', true) = '1' THEN
    RAISE EXCEPTION 'stub: reactivation push failed';
  END IF;
  RETURN 0;
END $$;

-- ── LIVE function bodies (pg_get_functiondef, prod, 2026-10-08) ─────────────
CREATE OR REPLACE FUNCTION public.log_rpc_attempt(p_rpc_name text, p_caller_uid uuid, p_target_id uuid, p_outcome text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  INSERT INTO rpc_attempt_log (rpc_name, caller_uid, target_id, outcome, metadata)
  VALUES (p_rpc_name, p_caller_uid, p_target_id, p_outcome, p_metadata);
EXCEPTION WHEN OTHERS THEN
  NULL;
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

CREATE OR REPLACE FUNCTION public.cron_sql_failures_now()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_window_days constant integer := 14;
  c_min_streak  constant integer := 3;
  v_found       jsonb;
BEGIN
  WITH runs AS (
    SELECT d.jobid, d.start_time, d.status, d.return_message
    FROM cron.job_run_details d
    WHERE d.start_time > now() - make_interval(days => c_window_days)
      AND d.status IN ('succeeded', 'failed')
      -- 00597: a failed run counts only if the job's SQL raised ('ERROR: ...') or
      -- pg_cron refused its command ('COPY not supported'). Any other failure is
      -- pg_cron not being able to run the job, or losing its connection while it
      -- ran (job startup timeout, server restarted, connection failed,
      -- connection lost, job canceled).
      AND (d.status = 'succeeded'
           OR COALESCE(d.return_message, '') LIKE 'ERROR:%'
           OR d.return_message = 'COPY not supported')
  ), per_job AS (
    SELECT jobid, count(*) AS runs,
           max(start_time) FILTER (WHERE status = 'succeeded') AS last_ok
    FROM runs
    GROUP BY jobid
  ), streaks AS (
    -- Every counted run after the last success is a failure: that is the
    -- current streak.
    SELECT r.jobid, count(*) AS failures, min(r.start_time) AS failing_since,
           (array_agg(r.return_message ORDER BY r.start_time DESC))[1] AS last_error
    FROM runs r
    JOIN per_job p ON p.jobid = r.jobid
    WHERE r.status = 'failed' AND (p.last_ok IS NULL OR r.start_time > p.last_ok)
    GROUP BY r.jobid
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'job',      COALESCE(j.jobname, 'job ' || j.jobid),
           'jobid',    j.jobid,
           'schedule', j.schedule,
           'failures', s.failures,
           'since',    s.failing_since,
           'last_ok',  p.last_ok,
           'error',    left(COALESCE(s.last_error, ''), 400))
         ORDER BY COALESCE(j.jobname, 'job ' || j.jobid)), '[]'::jsonb)
    INTO v_found
  FROM streaks s
  JOIN per_job p ON p.jobid = s.jobid
  JOIN cron.job j ON j.jobid = s.jobid
  WHERE j.active
    AND s.failures >= LEAST(c_min_streak, p.runs);

  RETURN v_found;
END;
$function$
;


-- LIVE ACLs: {postgres=X/postgres,service_role=X/postgres}.
REVOKE ALL ON FUNCTION public.retry_dispatch_expired_rides(), public.log_rpc_attempt(text, uuid, uuid, text, jsonb),
  public.cron_sql_failures_now(), public.dispatch_ride(uuid, integer), public.notify_offline_drivers_for_searching_rides() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retry_dispatch_expired_rides(), public.log_rpc_attempt(text, uuid, uuid, text, jsonb),
  public.cron_sql_failures_now(), public.dispatch_ride(uuid, integer), public.notify_offline_drivers_for_searching_rides() TO service_role;

RESET ROLE;

-- The job with prod's schedule and command, run by postgres.
INSERT INTO cron.job (schedule, command, username, jobname)
VALUES ('*/1 * * * *', 'SELECT retry_dispatch_expired_rides();', 'postgres', 'retry-dispatch-expired-rides');

-- ═════════════════════════════════════════════════════════════════════════════
-- Test helpers (not production shapes)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA t;

-- Runs a job the way pg_cron does: its command in a transaction of its own (here a
-- subtransaction), then one cron.job_run_details row: the command tag for a success,
-- the server's error text (starting with 'ERROR:') for a failure (00597).
CREATE FUNCTION t.run_job(p_jobname text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_job    cron.job%ROWTYPE;
  v_start  timestamptz := clock_timestamp();
  v_status text;
  v_msg    text;
BEGIN
  SELECT * INTO v_job FROM cron.job WHERE jobname = p_jobname;
  BEGIN
    EXECUTE v_job.command;
    v_status := 'succeeded';
    v_msg := '1 row';
  EXCEPTION WHEN OTHERS THEN
    v_status := 'failed';
    v_msg := 'ERROR:  ' || SQLERRM;
  END;
  INSERT INTO cron.job_run_details (jobid, job_pid, database, username, command, status, return_message, start_time, end_time)
  VALUES (v_job.jobid, pg_backend_pid(), v_job.database, v_job.username, v_job.command, v_status, v_msg, v_start, clock_timestamp());
  RETURN v_status || ': ' || v_msg;
END $$;

-- The jobs check_cron_sql_failures would report right now (its live helper).
CREATE FUNCTION t.flagged() RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(x ->> 'job', ',' ORDER BY x ->> 'job'), '')
  FROM jsonb_array_elements(public.cron_sql_failures_now()) AS x
$$;

-- Whether a statement returning jsonb returned (and its "ok") or raised.
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'returned ok=' || COALESCE(v ->> 'ok', 'null');
EXCEPTION WHEN OTHERS THEN
  RETURN 'raised: ' || SQLERRM;
END $$;

-- p_n eligible rides named r1..rN (searching, round 1, last dispatched 2 min ago, no
-- pending offer), plus two that must be skipped: one with a pending offer, and one
-- passenger ride in round 0 (the insert trigger dispatches those in prod).
CREATE PROCEDURE t.seed(p_n integer) LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.rides (id, dispatch_round, last_dispatched_at)
  SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 1, now() - interval '2 minutes'
  FROM generate_series(1, p_n) AS g;
  INSERT INTO public.rides (id, dispatch_round, last_dispatched_at) VALUES
    ('00000000-0000-4000-8000-0000000000aa', 1, now() - interval '2 minutes'),
    ('00000000-0000-4000-8000-0000000000bb', 0, now() - interval '2 minutes');
  INSERT INTO public.ride_offers (ride_id, expires_at)
  VALUES ('00000000-0000-4000-8000-0000000000aa', now() + interval '30 seconds');
END $$;

-- 'n:round:offers' per ride, for the rides seeded by t.seed.
CREATE FUNCTION t.state() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(right(r.id::text, 2) || ':' || r.dispatch_round || ':'
                    || (SELECT count(*) FROM public.ride_offers o WHERE o.ride_id = r.id), ',' ORDER BY r.id)
  FROM public.rides r
$$;
