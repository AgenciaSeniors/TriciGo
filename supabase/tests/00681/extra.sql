-- What the 00681 rehearsal needs beyond the 00674 base (00665 scaffold, migration 00665,
-- tests/00674/extra.sql, migration 00674), as in prod on 2026-11-14: the support tables,
-- rpc_attempt_log, the LIVE bodies of log_rpc_attempt() and _third_party_person_name() (run.sh S0
-- checks their md5), and stubs for get_service_role_key(), cron_http_post() and pg_cron.
-- Run by the test superuser.

CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  jobname text UNIQUE,
  schedule text NOT NULL,
  command text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid
$$;
CREATE FUNCTION cron.alter_job(job_id bigint, active boolean) RETURNS void
LANGUAGE sql AS $$ UPDATE cron.job SET active = $2 WHERE jobid = $1 $$;
GRANT USAGE ON SCHEMA cron TO tricigo_owner;
GRANT SELECT, INSERT, UPDATE ON cron.job TO tricigo_owner;
GRANT USAGE ON SEQUENCE cron.job_jobid_seq TO tricigo_owner;

SET ROLE tricigo_owner;

ALTER TABLE public.promotions
  ADD COLUMN notify_on_publish boolean NOT NULL DEFAULT true,
  ADD COLUMN title_es text;

CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  ride_id uuid REFERENCES public.rides(id),
  category text NOT NULL,
  subject text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text DEFAULT 'normal',
  assigned_to uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  resolved_at timestamptz
);
CREATE TABLE public.ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.users(id),
  message text NOT NULL,
  is_admin boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rpc_attempt_log (
  id bigserial PRIMARY KEY,
  rpc_name text NOT NULL,
  caller_uid uuid,
  target_id uuid,
  outcome text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What cron_http_post was asked to send (prod: pg_net + cron_http_calls).
CREATE TABLE public.test_http_calls (jobname text, url text, body jsonb);
CREATE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb,
                                      body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.test_http_calls (jobname, url, body) VALUES (p_jobname, url, body) RETURNING 1::bigint
$$;
CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'test-service-key' $$;

-- LIVE bodies (prod, 2026-11-14).
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
$function$;

CREATE OR REPLACE FUNCTION public._third_party_person_name(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH w AS (
    SELECT t.word, row_number() OVER (ORDER BY t.ord) AS n
    FROM (
      SELECT regexp_replace(s.word, '[^A-Za-zÀ-ÖØ-öø-ÿ''-]', '', 'g') AS word, s.ord
      FROM regexp_split_to_table(coalesce(p_name, ''), '\s+') WITH ORDINALITY AS s(word, ord)
    ) t
    WHERE t.word ~ '[A-Za-zÀ-ÖØ-öø-ÿ]'
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM w WHERE n = 2) THEN (SELECT left(word, 20) FROM w WHERE n = 1)
    ELSE (SELECT left(word, 20) FROM w WHERE n = 1) || ' ' || (SELECT upper(left(word, 1)) FROM w WHERE n = 2) || '.'
  END;
$function$;

RESET ROLE;
