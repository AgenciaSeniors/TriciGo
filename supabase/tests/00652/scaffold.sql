-- Scaffold for the 00652 rehearsal: the tables check_copy_voseo() reads (only the
-- columns it uses), platform_config, a minimal cron schema, and stubs for
-- get_service_role_key() and cron_http_post() (same signature as prod; it records
-- each e-mail in public.sent_mail instead of sending it).

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END
$roles$;

CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid    bigserial PRIMARY KEY,
  jobname  text UNIQUE,
  schedule text NOT NULL,
  command  text NOT NULL,
  active   boolean NOT NULL DEFAULT true
);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid;
$$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
  DELETE FROM cron.job WHERE jobname = job_name RETURNING true;
$$;

CREATE TABLE public.platform_config (key text PRIMARY KEY, value jsonb, updated_at timestamptz DEFAULT now());

CREATE TABLE public.sent_mail (id bigserial PRIMARY KEY, label text, recipient text, subject text, html text);

CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $$ SELECT 'test-service-key'::text $$;

CREATE FUNCTION public.cron_http_post(
  p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 30000
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.sent_mail (label, recipient, subject, html)
  VALUES (p_jobname, body ->> 'recipient_email', body ->> 'subject', body ->> 'template')
  RETURNING id;
$$;

CREATE TABLE public.cms_content (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, title_es text, body_es text);
CREATE TABLE public.blog_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, title_es text, excerpt_es text, body_es text,
  is_published boolean DEFAULT false
);
CREATE TABLE public.home_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title_es text, body_es text, cta_label_es text
);
CREATE TABLE public.promotions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text, title_es text, body_es text);
CREATE TABLE public.driver_quests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title_es text, description_es text);
CREATE TABLE public.review_tag_definitions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tag_key text, label_es text);
CREATE TABLE public.trip_insurance_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_type text, coverage_description_es text
);
CREATE TABLE public.service_type_configs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, name_es text);
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, message_title text, message_body text, sent_at timestamptz
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, title text, body text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.sms_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text, message_body text, created_at timestamptz DEFAULT now()
);
