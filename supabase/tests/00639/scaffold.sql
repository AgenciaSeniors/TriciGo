-- Scaffold for the 00639 rehearsal (local Postgres 16, no Supabase stack needed).
-- Generated on 2026-10-08 from prod (pg_get_functiondef, information_schema,
-- pg_constraint, cron.job):
--   * role postgres: NOT a superuser, BYPASSRLS. It owns every function and
--     table here and applies the migration, as in prod.
--   * the 20 function bodies below are byte for byte the ones running in prod;
--     run.sh S0 compares md5(prosrc) with the values read from prod. 14 of them
--     are the ones 00639 patches; the other 6 are what they call.
--   * the tables carry prod's columns for the ones these functions read and
--     write whole (db_health_samples, stuck_ride_alerts, sms_deliveries, ...).
--     rides, driver_profiles, users and cuba_pois carry only the columns these
--     functions use: they are wide tables in prod.
--   * pg_cron: cron.job, cron.job_run_details and named-signature stubs of
--     cron.schedule / cron.unschedule (same as supabase/tests/00597).
--   * pg_net: net.http_post records the request in net.http_request_queue
--     instead of sending it (same as supabase/tests/00597).
--   * public.get_service_role_key() is a stub (prod reads vault). PostGIS is not
--     installed: extensions.geography is a text domain so that
--     check_stuck_active_rides compiles; no test reaches its ST_ calls.
-- Not rebuilt: platform_config's audit trigger (tg_platform_config_audit).
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

CREATE SCHEMA extensions;
CREATE DOMAIN extensions.geography AS text;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

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

CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE v_id bigint;
BEGIN
  UPDATE cron.job SET schedule = $2, command = $3
   WHERE jobname = $1 AND username = CURRENT_USER
  RETURNING jobid INTO v_id;
  IF v_id IS NULL THEN
    INSERT INTO cron.job (schedule, command, jobname) VALUES ($2, $3, $1) RETURNING jobid INTO v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = $1 AND username = CURRENT_USER;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job ''%''', $1;
  END IF;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION cron.schedule(text, text, text), cron.unschedule(text) TO postgres;

-- ── pg_net ───────────────────────────────────────────────────────────────────
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (
  id                   bigserial PRIMARY KEY,
  method               text    NOT NULL,
  url                  text    NOT NULL,
  headers              jsonb,
  body                 bytea,
  timeout_milliseconds integer NOT NULL
);
CREATE TABLE net._http_response (
  id           bigint,
  status_code  integer,
  content_type text,
  headers      jsonb,
  content      text,
  timed_out    boolean,
  error_msg    text,
  created      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION net.http_post(
  url                  text,
  body                 jsonb   DEFAULT '{}'::jsonb,
  params               jsonb   DEFAULT '{}'::jsonb,
  headers              jsonb   DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', $1, $4, convert_to($2::text, 'UTF8'), $5)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
GRANT USAGE ON SCHEMA net TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA net TO postgres;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA net TO postgres;

-- ── public: tables (owned by postgres, as in prod) ──────────────────────────
SET ROLE postgres;

CREATE TABLE public.platform_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_config (key, value)
VALUES ('business_notification_email', to_jsonb('ops@example.test, dev@example.test'::text));

CREATE TABLE public.cron_http_calls (
  request_id bigint      PRIMARY KEY,
  jobname    text        NOT NULL,
  url        text        NOT NULL,
  called_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cron_http_expectations (
  jobname     text  PRIMARY KEY,
  ok_statuses int[] NOT NULL,
  note        text
);

CREATE TABLE public.db_health_samples (
  sampled_at    timestamptz NOT NULL DEFAULT now() PRIMARY KEY,
  db_size_bytes bigint  NOT NULL,
  conn_used     integer NOT NULL,
  conn_max      integer NOT NULL,
  cache_hit_pct numeric,
  dead_tuples   bigint,
  longest_tx_s  integer,
  idle_in_tx    integer,
  deadlocks     bigint,
  top_tables    jsonb
);

CREATE TABLE public.audit_log (
  id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name text NOT NULL,
  record_id  text NOT NULL,
  operation  text NOT NULL,
  old_values jsonb,
  new_values jsonb,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.driver_heartbeat_log (
  driver_profile_id uuid NOT NULL,
  beat_at           timestamptz NOT NULL,
  is_online         boolean
);

CREATE TABLE public.exchange_rates (
  id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source       text NOT NULL CHECK (source = ANY (ARRAY['eltoque_api'::text, 'eltoque_scraping'::text, 'manual'::text])),
  usd_cup_rate numeric NOT NULL CHECK (usd_cup_rate >= 100::numeric AND usd_cup_rate <= 5000::numeric),
  fetched_at   timestamptz NOT NULL,
  is_current   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.poi_sync_state (
  region         text PRIMARY KEY,
  last_sequence  bigint NOT NULL,
  last_sync_at   timestamptz NOT NULL DEFAULT now(),
  last_sync_kind text NOT NULL DEFAULT 'delta' CHECK (last_sync_kind = ANY (ARRAY['delta'::text, 'full'::text])),
  stats          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Only the column check_poi_sync_freshness reads.
CREATE TABLE public.cuba_pois (
  id        bigserial PRIMARY KEY,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE public.rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE public.sms_deliveries (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id    text NOT NULL UNIQUE,
  msg_id        text,
  recipient     text NOT NULL,
  originator    text,
  provider      text NOT NULL DEFAULT 'd7',
  status        text NOT NULL DEFAULT 'queued' CHECK (status = ANY (ARRAY['queued'::text, 'sent'::text, 'scheduled'::text,
                  'delivered'::text, 'un_delivered'::text, 'expired'::text, 'failed'::text, 'rejected'::text, 'unknown'::text])),
  tag           text,
  raw_dlr       jsonb,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  last_event_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.stuck_ride_alerts (
  ride_id     uuid PRIMARY KEY,
  reason      text NOT NULL CHECK (reason = ANY (ARRAY['complete_blocked'::text, 'stationary_chat'::text, 'dead_driver_app'::text])),
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  emailed_at  timestamptz,
  resolved_at timestamptz
);

-- Only the columns these functions use.
CREATE TABLE public.users (
  id        uuid PRIMARY KEY,
  full_name text,
  phone     text
);
CREATE TABLE public.driver_profiles (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL,
  is_online         boolean NOT NULL DEFAULT false,
  auto_offline_at   timestamptz,
  last_heartbeat_at timestamptz
);
CREATE TABLE public.rides (
  id                 uuid PRIMARY KEY,
  customer_id        uuid,
  driver_id          uuid,
  status             text NOT NULL,
  pickup_address     text,
  dropoff_address    text,
  pickup_at          timestamptz,
  accepted_at        timestamptz,
  searching_seen_at  timestamptz,
  last_dispatched_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.ride_offers (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id           uuid NOT NULL,
  driver_profile_id uuid NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  composite_score   numeric,
  distance_m        double precision,
  offered_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  responded_at      timestamptz
);
CREATE TABLE public.validation_events (
  id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id  uuid,
  event_type text NOT NULL,
  ride_id    uuid,
  properties jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.ride_messages (
  id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id    uuid NOT NULL,
  sender_id  uuid NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE TABLE public.ride_location_events (
  id              uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ride_id         uuid NOT NULL,
  driver_id       uuid NOT NULL,
  location        extensions.geography NOT NULL,
  heading         numeric,
  speed           numeric,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  accuracy        numeric,
  client_event_id uuid
);

-- Stub: prod reads vault.
CREATE FUNCTION public.get_service_role_key() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('test.service_role_key', true), 'test-service-role-key')
$$;

-- ── LIVE function bodies (pg_get_functiondef, prod, 2026-10-08) ─────────────
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
$function$
;

CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  v_url     text := url;
  v_headers jsonb := headers;
  v_body    jsonb := body;
  v_timeout integer := timeout_milliseconds;
  v_id      bigint;
BEGIN
  v_id := net.http_post(url := v_url, headers := v_headers, body := v_body,
                        timeout_milliseconds := v_timeout);
  BEGIN
    INSERT INTO public.cron_http_calls (request_id, jobname, url)
    VALUES (v_id, p_jobname, v_url)
    ON CONFLICT (request_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'cron_http_post: bookkeeping failed for % (request %): % %',
      p_jobname, v_id, SQLSTATE, SQLERRM;
  END;
  RETURN v_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public._db_health_html(p_h jsonb, p_titulo text, p_color text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_row  record;
  v_filas text := '';
  v_proy  text;
  v_mot   text := '';
  v_i     text;
BEGIN
  FOR v_row IN
    SELECT x.value ->> 't' AS tabla, (x.value ->> 'b')::bigint AS bytes
      FROM jsonb_array_elements(COALESCE(p_h -> 'top_tables', '[]'::jsonb)) AS x(value)
  LOOP
    v_filas := v_filas
      || '<tr><td style="padding:4px 6px;border-bottom:1px solid #eee">'
      -- Nombre de tabla escapado: sale de pg_stat_user_tables, pero entra a un correo.
      || replace(replace(replace(v_row.tabla, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
      || '</td><td style="padding:4px 6px;border-bottom:1px solid #eee;text-align:right">'
      || round(v_row.bytes / 1048576.0, 1) || ' MB</td></tr>';
  END LOOP;

  IF p_h ->> 'days_to_warn' IS NOT NULL THEN
    v_proy := 'Creciendo <b>' || COALESCE(p_h ->> 'growth_mb_per_day', '?') || ' MB/día</b> — al umbral de aviso ('
           || COALESCE(p_h ->> 'warn_mb', '?') || ' MB) en <b>' || (p_h ->> 'days_to_warn') || ' días</b>.';
  ELSE
    v_proy := 'Sin historial suficiente todavía para proyectar (hacen falta al menos 6 h de muestras).';
  END IF;

  FOR v_i IN SELECT jsonb_array_elements_text(COALESCE(p_h -> 'reasons', '[]'::jsonb)) LOOP
    v_mot := v_mot || '<li>' || replace(replace(v_i, '<', '&lt;'), '>', '&gt;') || '</li>';
  END LOOP;

  RETURN '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:' || p_color || ';border-bottom:2px solid ' || p_color || ';padding-bottom:8px">' || p_titulo || '</h2>'
    || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Estado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right"><b>' || upper(COALESCE(p_h ->> 'status', '?')) || '</b></td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tamaño</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_h ->> 'db_size_mb', '?') || ' MB / ' || COALESCE(p_h ->> 'warn_mb', '?') || ' MB de aviso</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Conexiones</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_h ->> 'conn_used', '?') || ' / ' || COALESCE(p_h ->> 'conn_max', '?') || ' (' || COALESCE(p_h ->> 'conn_pct', '?') || '%)</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Cache hit</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_h ->> 'cache_hit_pct', '-') || '%</td></tr>'
    || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tuplas muertas</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(p_h ->> 'dead_tuples', '-') || '</td></tr>'
    || '<tr><td style="padding:6px"><b>Transacción más larga</b></td><td style="padding:6px;text-align:right">' || COALESCE(p_h ->> 'longest_tx_s', '-') || ' s</td></tr>'
    || '</table>'
    || '<p style="background:#f6f6f6;padding:12px;border-radius:6px">' || v_proy || '</p>'
    || CASE WHEN v_mot <> '' THEN '<p><b>Motivos:</b></p><ul>' || v_mot || '</ul>' ELSE '' END
    || '<p><b>Tablas más pesadas:</b></p><table style="width:100%;border-collapse:collapse">' || v_filas || '</table>'
    || '<p style="color:#777;font-size:12px">Umbrales editables en el panel admin '
    || '(<code>db_size_warn_mb</code>, <code>db_conn_warn_pct</code>...). '
    || 'Aviso automático de operaciones. No responder.</p></body></html>';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_db_health_email(p_subject text, p_html text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_sent        int := 0;
BEGIN
  SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN RETURN 0; END IF;

  -- Cinturón: un cuerpo nulo o vacío significa que el armado del HTML falló.
  -- Mejor no mandar nada y dejar rastro en los logs que mandar 5 correos en
  -- blanco que nadie sabe interpretar.
  IF p_html IS NULL OR btrim(p_html) = '' OR p_subject IS NULL THEN
    RAISE WARNING 'send_db_health_email: cuerpo vacío, no se envía (subject=%)', p_subject;
    RETURN 0;
  END IF;

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);

  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
  LOOP
    PERFORM net.http_post(
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', p_subject,
                                    -- HTML crudo por el legacy path de resolveTemplate().
                                    'template', p_html, 'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.evaluate_database_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cur          db_health_samples%ROWTYPE;
  v_ref          db_health_samples%ROWTYPE;
  v_size_mb      numeric;
  v_warn_mb      numeric := COALESCE(get_platform_config_numeric('db_size_warn_mb', 6000), 6000);
  v_crit_mb      numeric := COALESCE(get_platform_config_numeric('db_size_crit_mb', 7500), 7500);
  v_conn_warn    numeric := COALESCE(get_platform_config_numeric('db_conn_warn_pct', 75), 75);
  v_conn_crit    numeric := COALESCE(get_platform_config_numeric('db_conn_crit_pct', 90), 90);
  v_tx_warn      numeric := COALESCE(get_platform_config_numeric('db_long_tx_warn_seconds', 300), 300);
  v_cache_warn   numeric := COALESCE(get_platform_config_numeric('db_cache_hit_warn_pct', 95), 95);
  v_conn_pct     numeric;
  v_growth_mb_d  numeric;
  v_days_left    numeric;
  v_span_days    numeric;
  v_status       text := 'ok';
  v_reasons      text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_cur FROM db_health_samples ORDER BY sampled_at DESC LIMIT 1;
  IF v_cur.sampled_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'status', 'unknown', 'error', 'sin muestras todavía');
  END IF;

  v_size_mb  := round(v_cur.db_size_bytes / 1048576.0, 1);
  v_conn_pct := round(100.0 * v_cur.conn_used / NULLIF(v_cur.conn_max, 0), 1);

  -- Referencia: la muestra más vieja dentro de 7 días. Con menos de 6 h de
  -- separación la pendiente es ruido, así que no se proyecta nada.
  SELECT * INTO v_ref FROM db_health_samples
   WHERE sampled_at >= now() - interval '7 days' ORDER BY sampled_at ASC LIMIT 1;

  IF v_ref.sampled_at IS NOT NULL THEN
    v_span_days := EXTRACT(epoch FROM v_cur.sampled_at - v_ref.sampled_at) / 86400.0;
    IF v_span_days >= 0.25 THEN
      v_growth_mb_d := round(((v_cur.db_size_bytes - v_ref.db_size_bytes) / 1048576.0) / v_span_days, 2);
      IF v_growth_mb_d > 0 THEN
        v_days_left := round((v_warn_mb - v_size_mb) / v_growth_mb_d, 1);
      END IF;
    END IF;
  END IF;

  -- ── Severidad ──
  IF v_size_mb >= v_crit_mb THEN
    v_status := 'critical';
    v_reasons := v_reasons || format('tamaño %s MB supera el umbral crítico de %s MB', v_size_mb, v_crit_mb);
  ELSIF v_size_mb >= v_warn_mb THEN
    v_status := 'warn';
    v_reasons := v_reasons || format('tamaño %s MB supera el umbral de aviso de %s MB', v_size_mb, v_warn_mb);
  END IF;

  IF v_conn_pct >= v_conn_crit THEN
    v_status := 'critical';
    v_reasons := v_reasons || format('conexiones %s/%s (%s%%) sobre el crítico de %s%%',
                                     v_cur.conn_used, v_cur.conn_max, v_conn_pct, v_conn_crit);
  ELSIF v_conn_pct >= v_conn_warn THEN
    IF v_status <> 'critical' THEN v_status := 'warn'; END IF;
    v_reasons := v_reasons || format('conexiones %s/%s (%s%%) sobre el aviso de %s%%',
                                     v_cur.conn_used, v_cur.conn_max, v_conn_pct, v_conn_warn);
  END IF;

  -- Aviso temprano por PROYECCIÓN: el tamaño todavía no cruzó nada, pero al
  -- ritmo actual lo cruza dentro de 14 días. Es literalmente el "avisame antes
  -- de que colapse" que se pidió — el resto de las reglas avisa cuando el
  -- problema YA está.
  IF v_days_left IS NOT NULL AND v_days_left <= 14 AND v_status = 'ok' THEN
    v_status := 'warn';
    v_reasons := v_reasons || format('a %s MB/día llega al umbral de aviso en %s días',
                                     v_growth_mb_d, v_days_left);
  END IF;

  IF v_cur.longest_tx_s >= v_tx_warn THEN
    IF v_status = 'ok' THEN v_status := 'warn'; END IF;
    v_reasons := v_reasons || format('transacción abierta hace %s s', v_cur.longest_tx_s);
  END IF;

  IF v_cur.cache_hit_pct IS NOT NULL AND v_cur.cache_hit_pct < v_cache_warn THEN
    IF v_status = 'ok' THEN v_status := 'warn'; END IF;
    v_reasons := v_reasons || format('cache hit %s%% por debajo de %s%%', v_cur.cache_hit_pct, v_cache_warn);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'status', v_status,
    'sampled_at', v_cur.sampled_at,
    'db_size_mb', v_size_mb, 'warn_mb', v_warn_mb, 'crit_mb', v_crit_mb,
    'conn_used', v_cur.conn_used, 'conn_max', v_cur.conn_max, 'conn_pct', v_conn_pct,
    'cache_hit_pct', v_cur.cache_hit_pct, 'dead_tuples', v_cur.dead_tuples,
    'longest_tx_s', v_cur.longest_tx_s, 'idle_in_tx', v_cur.idle_in_tx,
    'growth_mb_per_day', v_growth_mb_d, 'days_to_warn', v_days_left,
    'top_tables', v_cur.top_tables,
    'reasons', to_jsonb(v_reasons));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sample_database_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_size   bigint;
  v_used   int;
  v_max    int;
  v_cache  numeric(5,2);
  v_dead   bigint;
  v_longtx int;
  v_idletx int;
  v_dead_l bigint;
  v_top    jsonb;
  v_keep   int := COALESCE(get_platform_config_numeric('db_health_sample_retention_days', 90), 90)::int;
BEGIN
  SELECT pg_database_size(current_database()) INTO v_size;
  SELECT setting::int FROM pg_settings WHERE name = 'max_connections' INTO v_max;

  SELECT count(*),
         count(*) FILTER (WHERE state = 'idle in transaction'),
         COALESCE(max(EXTRACT(epoch FROM now() - xact_start))::int, 0)
    INTO v_used, v_idletx, v_longtx
    FROM pg_stat_activity;

  SELECT round(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2),
         COALESCE(sum(deadlocks), 0)
    INTO v_cache, v_dead_l
    FROM pg_stat_database;

  SELECT COALESCE(sum(n_dead_tup), 0) INTO v_dead FROM pg_stat_user_tables;

  -- Las 6 más pesadas: sin esto el correo dice "creció" pero no POR QUÉ.
  SELECT jsonb_agg(jsonb_build_object('t', x.rel, 'b', x.bytes) ORDER BY x.bytes DESC)
    INTO v_top
    FROM (SELECT s.relname AS rel, pg_total_relation_size(c.oid) AS bytes
            FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
           ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 6) x;

  INSERT INTO db_health_samples (sampled_at, db_size_bytes, conn_used, conn_max,
                                 cache_hit_pct, dead_tuples, longest_tx_s,
                                 idle_in_tx, deadlocks, top_tables)
  VALUES (date_trunc('hour', now()), v_size, v_used, v_max, v_cache, v_dead,
          v_longtx, v_idletx, v_dead_l, v_top)
  ON CONFLICT (sampled_at) DO UPDATE SET
    db_size_bytes = EXCLUDED.db_size_bytes, conn_used = EXCLUDED.conn_used,
    conn_max = EXCLUDED.conn_max, cache_hit_pct = EXCLUDED.cache_hit_pct,
    dead_tuples = EXCLUDED.dead_tuples, longest_tx_s = EXCLUDED.longest_tx_s,
    idle_in_tx = EXCLUDED.idle_in_tx, deadlocks = EXCLUDED.deadlocks,
    top_tables = EXCLUDED.top_tables;

  DELETE FROM db_health_samples WHERE sampled_at < now() - make_interval(days => v_keep);

  RETURN jsonb_build_object('ok', true, 'db_size_mb', round(v_size / 1048576.0, 1),
                            'conn', v_used || '/' || v_max, 'cache_hit_pct', v_cache);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sample_database_health failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_database_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_h      jsonb;
  v_status text;
  v_prev   text;
  v_sent   int := 0;
  v_color  text;
BEGIN
  PERFORM sample_database_health();
  v_h := evaluate_database_health();

  IF (v_h ->> 'ok')::boolean IS NOT TRUE THEN
    RETURN v_h;
  END IF;
  v_status := v_h ->> 'status';

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'db_health_status';

  INSERT INTO platform_config (key, value) VALUES
    ('db_health_status', to_jsonb(v_status)),
    ('db_health_at',     to_jsonb(now()::text)),
    ('db_health_detail', to_jsonb(
        (v_h ->> 'db_size_mb') || ' MB · conn ' || (v_h ->> 'conn_used') || '/' || (v_h ->> 'conn_max')
        || COALESCE(' · ' || (v_h ->> 'growth_mb_per_day') || ' MB/día', '')
        || COALESCE(' · ' || (v_h ->> 'days_to_warn') || ' días al umbral', '')))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- Solo en TRANSICIÓN: un problema que dura una semana manda 1 correo, no 168.
  IF v_prev IS DISTINCT FROM v_status THEN
    v_color := CASE v_status WHEN 'critical' THEN '#dc2626' WHEN 'warn' THEN '#d97706' ELSE '#16a34a' END;
    v_sent := send_db_health_email(
      CASE v_status
        WHEN 'critical' THEN '[TriciGo] BASE DE DATOS EN RIESGO'
        WHEN 'warn'     THEN '[TriciGo] Base de datos: atención'
        ELSE                 '[TriciGo] Base de datos: normalizada'
      END,
      _db_health_html(v_h,
        CASE v_status
          WHEN 'critical' THEN 'Base de datos en riesgo'
          WHEN 'warn'     THEN 'Base de datos: atención'
          ELSE                 'Base de datos normalizada'
        END, v_color));
  END IF;

  RETURN v_h || jsonb_build_object('previous_status', v_prev, 'emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_database_health failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.send_db_health_digest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_h     jsonb;
  v_sent  int := 0;
  v_on    boolean;
  v_color text;
BEGIN
  SELECT COALESCE((value #>> '{}') IN ('true', 't'), true) INTO v_on
    FROM platform_config WHERE key = 'db_health_digest_enabled';
  IF v_on IS FALSE THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'digest deshabilitado', 'emails_sent', 0);
  END IF;

  PERFORM sample_database_health();
  v_h := evaluate_database_health();
  IF (v_h ->> 'ok')::boolean IS NOT TRUE THEN RETURN v_h; END IF;

  v_color := CASE v_h ->> 'status' WHEN 'critical' THEN '#dc2626' WHEN 'warn' THEN '#d97706' ELSE '#16a34a' END;
  v_sent := send_db_health_email(
    '[TriciGo] Estado diario de la base — ' || (v_h ->> 'db_size_mb') || ' MB',
    _db_health_html(v_h, 'Estado diario de la base de datos', v_color));

  RETURN v_h || jsonb_build_object('emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'send_db_health_digest failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_cron_http_failures()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net', 'pg_catalog'
AS $function$
DECLARE
  c_window_min  constant integer := 90;
  c_grace_sec   constant integer := 120;
  c_min_hard    constant integer := 2;
  v_signature   text;
  v_detail      text;
  v_prev        text;
  v_status      text;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_rows        text := '';
  v_fail        RECORD;
  v_sent        integer := 0;
BEGIN
  DROP TABLE IF EXISTS _fails;
  CREATE TEMP TABLE _fails ON COMMIT DROP AS
  WITH judged AS (
    SELECT c.jobname,
           resp.status_code,
           resp.content,
           resp.error_msg,
           (resp.status_code IS NULL) AS is_timeout,
           (resp.status_code IS NOT NULL
            AND NOT (resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204])))) AS is_hard_fail,
           (resp.status_code IS NOT NULL
            AND resp.status_code = ANY (COALESCE(e.ok_statuses, ARRAY[200,201,202,204]))) AS is_ok
    FROM public.cron_http_calls c
    JOIN net._http_response resp ON resp.id = c.request_id
    LEFT JOIN public.cron_http_expectations e ON e.jobname = c.jobname
    WHERE c.called_at >  now() - make_interval(mins => c_window_min)
      AND c.called_at <  now() - make_interval(secs => c_grace_sec)
  ),
  agg AS (
    SELECT jobname,
           count(*)                             AS total,
           count(*) FILTER (WHERE is_ok)        AS oks,
           count(*) FILTER (WHERE is_hard_fail) AS hard_fails,
           count(*) FILTER (WHERE is_timeout)   AS timeouts,
           string_agg(DISTINCT status_code::text, '/') FILTER (WHERE is_hard_fail) AS codes,
           max(left(COALESCE(content, error_msg, ''), 120)) FILTER (WHERE is_hard_fail OR is_timeout) AS sample
    FROM judged GROUP BY jobname
  )
  SELECT jobname,
         (hard_fails + CASE WHEN oks = 0 THEN timeouts ELSE 0 END) AS failures,
         timeouts,
         COALESCE(codes, 'timeout') AS codes,
         sample
  FROM agg
  WHERE hard_fails >= c_min_hard
     OR (oks = 0 AND timeouts >= c_min_hard);

  SELECT string_agg(jobname, ',' ORDER BY jobname),
         string_agg(jobname || ' (' || failures || 'x ' || codes || ')', ' - ' ORDER BY jobname)
    INTO v_signature, v_detail
  FROM _fails;

  v_status := CASE WHEN v_signature IS NULL THEN 'ok' ELSE 'failing' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'cron_http_health_signature';

  INSERT INTO platform_config (key, value) VALUES
    ('cron_http_health_status',    to_jsonb(v_status)),
    ('cron_http_health_signature', to_jsonb(COALESCE(v_signature, ''))),
    ('cron_http_health_detail',    to_jsonb(COALESCE(v_detail, 'all cron HTTP calls healthy'))),
    ('cron_http_health_at',        to_jsonb(now()::text))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF COALESCE(v_signature,'') IS DISTINCT FROM COALESCE(v_prev,'') THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object('Content-Type','application/json',
                     'Authorization','Bearer ' || v_service_key, 'apikey', v_service_key);

      IF v_status = 'failing' THEN
        FOR v_fail IN SELECT * FROM _fails ORDER BY jobname LOOP
          v_rows := v_rows
            || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>' || v_fail.jobname || '</b></td>'
            || '<td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_fail.failures || 'x ' || v_fail.codes || '</td></tr>'
            || '<tr><td colspan="2" style="padding:2px 6px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px">'
            || coalesce(replace(replace(v_fail.sample,'<','&lt;'),'>','&gt;'), '') || '</td></tr>';
        END LOOP;
        v_subject := '[TriciGo] Cron -> Edge Function fallando';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Cron -> Edge Function fallando</h2>'
          || '<p>Estas llamadas HTTP de cron respondieron mal (o no respondieron nunca) en los ultimos '
          || c_window_min || ' min. <b>pg_cron las reporta como &laquo;succeeded&raquo;</b> - solo se ven aca.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">' || v_rows || '</table>'
          || '<p><b>Que revisar:</b> los logs de la Edge Function correspondiente. '
          || 'Un timeout suelto entre respuestas OK NO alerta: pg_net deja de esperar pero la funcion sigue corriendo.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico de crons HTTP. No responder.</p></body></html>';
      ELSE
        v_subject := '[TriciGo] Cron -> Edge Function recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Crons recuperados</h2>'
          || '<p>Todas las llamadas HTTP de cron vuelven a responder lo esperado.</p>'
          || '<p style="color:#777;font-size:12px">Anterior: ' || COALESCE(v_prev,'-') || '</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico de crons HTTP. No responder.</p></body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x) WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', v_subject,
                                        'template', v_html, 'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  DELETE FROM public.cron_http_calls WHERE called_at < now() - interval '24 hours';

  RETURN jsonb_build_object('status', v_status, 'prev', COALESCE(v_prev,''),
                            'failing', COALESCE(v_signature,''), 'detail', v_detail,
                            'emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_cron_http_failures failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_exchange_rate_freshness()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_rate        numeric;
  v_source      text;
  v_fetched     timestamptz;
  v_age_h       numeric;
  v_alert_h     numeric;
  v_status      text;
  v_prev        text;
  v_now         timestamptz := now();
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_age_txt     text;
  v_sent        int := 0;
BEGIN
  SELECT usd_cup_rate, source, fetched_at
    INTO v_rate, v_source, v_fetched
    FROM exchange_rates WHERE is_current = true LIMIT 1;

  SELECT (value #>> '{}')::numeric INTO v_alert_h
    FROM platform_config WHERE key = 'fx_stale_alert_hours';
  v_alert_h := COALESCE(v_alert_h, 20);

  IF v_fetched IS NULL THEN
    v_status  := 'stale';
    v_age_h   := NULL;
    v_age_txt := 'sin fila is_current';
  ELSE
    v_age_h   := round(extract(epoch FROM (v_now - v_fetched)) / 3600.0, 1);
    v_age_txt := v_age_h::text || ' h';
    v_status  := CASE WHEN v_age_h >= v_alert_h THEN 'stale' ELSE 'ok' END;
  END IF;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'fx_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  INSERT INTO platform_config (key, value) VALUES
    ('fx_health_status', to_jsonb(v_status)),
    ('fx_health_at',     to_jsonb(v_now::text)),
    ('fx_health_detail', to_jsonb(
       COALESCE(v_source, '—') || ' · ' || COALESCE(v_rate::text, '—') || ' CUP · ' || v_age_txt))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF v_prev IS DISTINCT FROM v_status
     AND (v_status = 'stale' OR (v_status = 'ok' AND v_prev = 'stale')) THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'stale' THEN
        v_subject := '[TriciGo] Tipo de cambio USD/CUP CONGELADO';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Tipo de cambio congelado</h2>'
          || '<p>La tasa USD/CUP tiene <b>' || v_age_txt || '</b> de antigüedad. '
          || '<b>Las recargas dejan de funcionar a las 24 h</b> (las Edge Functions de pago devuelven '
          || '<code>503 fx_unavailable</code> y el usuario ve &laquo;Tipo de cambio USD/CUP no disponible&raquo;).</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tasa actual</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_rate::text, '—') || ' CUP</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fuente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_source, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antigüedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_age_txt || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Tasa obtenida (UTC)</b></td><td style="padding:6px;text-align:right">' || COALESCE(v_fetched::text, 'sin fila is_current') || '</td></tr>'
          || '</table>'
          || '<p><b>Qué revisar:</b> el cuerpo de la última respuesta del cron (los logs de la Edge Function no son accesibles desde SQL): <code>SELECT r.status_code, r.content FROM cron_http_calls c JOIN net._http_response r ON r.id = c.request_id WHERE c.jobname = ''sync-exchange-rate'' ORDER BY c.called_at DESC LIMIT 5;</code> — trae <code>api_attempts</code> con el código HTTP de cada intento: <b>429</b> = tope de 1 petición/segundo de elTOQUE (se recupera solo en la siguiente corrida), <b>403</b> = desafío de Cloudflare, <b>config_*</b> = configuración nuestra. '
          || 'Si aparece <code>all_methods_failed</code>, fallaron las dos fuentes (API trmi de elTOQUE + scraping de eltoque.com). '
          || 'Si aparece <code>trmi API 200 but USD unparseable</code>, elTOQUE cambió el formato de su respuesta.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automático del tipo de cambio. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] Tipo de cambio USD/CUP recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Tipo de cambio recuperado</h2>'
          || '<p>La tasa USD/CUP volvió a actualizarse. Las recargas funcionan normalmente.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tasa actual</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_rate::text, '—') || ' CUP</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fuente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_source, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Antigüedad</b></td><td style="padding:6px;text-align:right">' || v_age_txt || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automático del tipo de cambio. No responder.</p>'
          || '</body></html>';
      END IF;

      -- business_notification_email es CSV; send-email toma un destinatario por llamada.
      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       -- HTML crudo: send-email lo acepta por el legacy path de resolveTemplate().
                       -- El guardrail solo rechaza slugs pelados (sin tags), así que esto es seguro.
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev, 'age_hours', v_age_h,
    'rate', v_rate, 'source', v_source,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_exchange_rate_freshness failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_poi_sync_freshness()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_last_at     timestamptz;
  v_last_kind   text;
  v_last_seq    bigint;
  v_age_h       numeric;
  v_age_txt     text;
  v_alert_h     numeric;
  v_status      text;
  v_prev        text;
  v_active      bigint;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_sent        int := 0;
BEGIN
  SELECT last_sync_at, last_sync_kind::text, last_sequence
    INTO v_last_at, v_last_kind, v_last_seq
    FROM poi_sync_state WHERE region = 'cuba' LIMIT 1;

  SELECT (value #>> '{}')::numeric INTO v_alert_h
    FROM platform_config WHERE key = 'poi_sync_stale_alert_hours';
  v_alert_h := COALESCE(v_alert_h, 50);

  IF v_last_at IS NULL THEN
    v_status  := 'stale';
    v_age_h   := NULL;
    v_age_txt := 'sin fila poi_sync_state';
  ELSE
    v_age_h   := round(extract(epoch FROM (v_now - v_last_at)) / 3600.0, 1);
    v_age_txt := v_age_h::text || ' h';
    v_status  := CASE WHEN v_age_h >= v_alert_h THEN 'stale' ELSE 'ok' END;
  END IF;

  SELECT count(*) INTO v_active FROM cuba_pois WHERE is_active;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'poi_sync_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  INSERT INTO platform_config (key, value) VALUES
    ('poi_sync_health_status', to_jsonb(v_status)),
    ('poi_sync_health_at',     to_jsonb(v_now::text)),
    ('poi_sync_health_detail', to_jsonb(
       COALESCE(v_last_kind, '-') || ' - seq ' || COALESCE(v_last_seq::text, '-')
       || ' - ' || v_age_txt || ' - ' || v_active::text || ' POIs activos'))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF v_prev IS DISTINCT FROM v_status
     AND (v_status = 'stale' OR (v_status = 'ok' AND v_prev = 'stale')) THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'stale' THEN
        v_subject := '[TriciGo] El sync de POIs DEJO DE CORRER';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">Sync de POIs detenido</h2>'
          || '<p>Hace <b>' || v_age_txt || '</b> que no se registra un sync de lugares exitoso. '
          || 'Los lugares del mapa y del buscador se van quedando viejos: no aparecen los negocios '
          || 'nuevos ni desaparecen los cerrados.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Ultimo sync</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_at::text, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tipo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_kind, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antiguedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_age_txt || '</td></tr>'
          || '<tr><td style="padding:6px"><b>POIs activos</b></td><td style="padding:6px;text-align:right">' || v_active::text || '</td></tr>'
          || '</table>'
          || '<p><b>Que revisar:</b> los workflows <code>sync-osm-delta.yml</code> (diario) y '
          || '<code>sync-pois.yml</code> (lunes) en GitHub Actions. Si NO figura ninguna corrida '
          || 'reciente, el schedule esta apagado -- que es justo el caso que este watchdog existe '
          || 'para atrapar, porque un workflow que no corre no puede avisar que fallo.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico del sync de POIs. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] El sync de POIs volvio a correr';
        v_html :=
             '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Sync de POIs recuperado</h2>'
          || '<p>Volvio a registrarse un sync de lugares exitoso.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Ultimo sync</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_at::text, '-') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Tipo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_last_kind, '-') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>POIs activos</b></td><td style="padding:6px;text-align:right">' || v_active::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automatico del sync de POIs. No responder.</p>'
          || '</body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM net.http_post(
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev, 'age_hours', v_age_h,
    'last_sync_at', v_last_at, 'last_kind', v_last_kind, 'active_pois', v_active,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_poi_sync_freshness failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_sms_delivery_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_k              int;
  v_muestra        int := 0;
  v_fallidas       int := 0;
  v_ultima_req     timestamptz;
  v_ultimo_sms     timestamptz;
  v_edad_sms_txt   text;
  v_afectados      int := 0;
  v_status         text;
  v_prev           text;
  v_now            timestamptz := now();
  v_service_key    text;
  v_headers        jsonb;
  v_to_raw         text;
  v_rcpt           text;
  v_subject        text;
  v_html           text;
  v_detalle        text;
  v_sent           int := 0;
BEGIN
  SELECT GREATEST(COALESCE((value #>> '{}')::int, 5), 2) INTO v_k
    FROM platform_config WHERE key = 'sms_outage_alert_consecutive';
  v_k := COALESCE(v_k, 5);

  SELECT count(*), count(*) FILTER (WHERE v_ult.intentos = 0), max(v_ult.inicio)
    INTO v_muestra, v_fallidas, v_ultima_req
    FROM (
      SELECT rl.count AS intentos, rl.window_start AS inicio
        FROM rate_limits rl
       WHERE rl.key LIKE 'send-sms-otp:phone:%'
       ORDER BY rl.window_start DESC
       LIMIT v_k
    ) AS v_ult;

  SELECT max(sd.sent_at) INTO v_ultimo_sms FROM sms_deliveries sd;

  v_edad_sms_txt := CASE
    WHEN v_ultimo_sms IS NULL THEN 'nunca'
    ELSE round(extract(epoch FROM (v_now - v_ultimo_sms)) / 3600.0, 1)::text || ' h' END;

  IF v_ultimo_sms IS NOT NULL THEN
    SELECT count(DISTINCT replace(rl.key, 'send-sms-otp:phone:', ''))
      INTO v_afectados
      FROM rate_limits rl
     WHERE rl.key LIKE 'send-sms-otp:phone:%'
       AND rl.window_start > v_ultimo_sms;
  END IF;

  -- Tres estados. 'unknown' cuando no hay evidencia suficiente: nunca emite correo,
  -- así que un apagón durante el cual la gente deja de intentar NO dispara un falso
  -- "recuperado" (con 2 estados, quedarse sin datos se leería como recuperación).
  v_status := CASE
    WHEN v_muestra < v_k OR v_ultima_req IS NULL
         OR v_ultima_req < v_now - interval '24 hours' THEN 'unknown'
    WHEN v_fallidas = v_muestra                        THEN 'down'
    ELSE 'ok' END;

  v_detalle := v_fallidas::text || '/' || v_muestra::text || ' solicitudes fallidas · '
            || 'último SMS hace ' || v_edad_sms_txt
            || CASE WHEN v_afectados > 0
                    THEN ' · ' || v_afectados::text || ' teléfonos afectados' ELSE '' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'sms_health_status';
  v_prev := COALESCE(v_prev, 'unknown');

  INSERT INTO platform_config (key, value) VALUES
    ('sms_health_status', to_jsonb(v_status)),
    ('sms_health_at',     to_jsonb(v_now::text)),
    ('sms_health_detail', to_jsonb(v_detalle))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  IF (v_status = 'down' AND v_prev <> 'down')
     OR (v_status = 'ok' AND v_prev = 'down') THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'down' THEN
        v_subject := '[TriciGo] SMS CAÍDO — nadie puede iniciar sesión';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">SMS caído</h2>'
          || '<p>Las últimas <b>' || v_muestra::text || ' solicitudes de código fallaron todas</b>. '
          || 'Mientras dure, <b>nadie puede iniciar sesión con su teléfono</b> (conductores ni pasajeros) '
          || 'y tampoco salen el <b>SOS de emergencia</b> ni el link de viaje a contactos de confianza.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último SMS enviado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_sms::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Antigüedad</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_edad_sms_txt || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Teléfonos afectados</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_afectados::text || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><b>Qué revisar, en este orden:</b></p>'
          || '<ol>'
          || '<li><b>Saldo en D7</b> (<code>app.d7networks.com</code>) — es prepago y es la causa más común. '
          || 'A ~$0.07 por SMS a Cuba, ~140 SMS por cada $10.</li>'
          || '<li><b>Token</b> <code>D7_API_TOKEN</code> en los secrets de Edge Functions, por si fue rotado o revocado.</li>'
          || '<li><b>Logs de la Edge Function</b> <code>send-sms-otp</code>: la línea <code>[d7] send:</code> trae '
          || 'el status y el payload <code>errors</code> exactos que devolvió D7.</li>'
          || '</ol>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de SMS (00556). No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] SMS recuperado';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">SMS recuperado</h2>'
          || '<p>Los códigos de verificación vuelven a salir. El inicio de sesión por teléfono funciona normalmente.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último SMS enviado</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_sms::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog automático de SMS (00556). No responder.</p>'
          || '</body></html>';
      END IF;

      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM public.cron_http_post('sms-outage-alert',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev,
    'muestra', v_muestra, 'fallidas', v_fallidas,
    'ultimo_sms', v_ultimo_sms, 'telefonos_afectados', v_afectados,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'check_sms_delivery_health failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_sms_delivery_rate()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_k             int;
  v_min_dest      int;
  v_racha         int := 0;
  v_destinatarios int := 0;
  v_primer_fallo  timestamptz;
  v_ultimo_fin    timestamptz;
  v_atascados     int := 0;
  v_req_ids       text;
  v_status        text;
  v_prev          text;
  v_now           timestamptz := now();
  v_service_key   text;
  v_headers       jsonb;
  v_to_raw        text;
  v_rcpt          text;
  v_subject       text;
  v_html          text;
  v_detalle       text;
  v_horas_txt     text;
  v_sent          int := 0;
BEGIN
  SELECT GREATEST(COALESCE((value #>> '{}')::int, 4), 2) INTO v_k
    FROM platform_config WHERE key = 'sms_delivery_fail_streak';
  v_k := COALESCE(v_k, 4);

  SELECT GREATEST(COALESCE((value #>> '{}')::int, 2), 1) INTO v_min_dest
    FROM platform_config WHERE key = 'sms_delivery_min_recipients';
  v_min_dest := COALESCE(v_min_dest, 2);

  -- Racha de fallos MÁS RECIENTES: se cuentan los un_delivered desde el final hacia
  -- atrás y se corta en la primera entrega. LIMIT 50 acota el escaneo; una racha mayor
  -- igual supera cualquier umbral razonable, así que truncar no puede ocultar nada.
  WITH v_fin AS (
    SELECT sd.status, sd.recipient, sd.sent_at, sd.request_id,
           row_number() OVER (ORDER BY sd.sent_at DESC) AS rn
      FROM sms_deliveries sd
     WHERE sd.status IN ('delivered', 'un_delivered')
     ORDER BY sd.sent_at DESC
     LIMIT 50
  ), v_corte AS (
    -- Posición de la entrega más reciente; sin entregas, toda la muestra es racha.
    SELECT COALESCE(min(rn) FILTER (WHERE status = 'delivered'), 51) AS primera_ok
      FROM v_fin
  )
  SELECT count(*), count(DISTINCT f.recipient), min(f.sent_at),
         string_agg(f.request_id, ', ' ORDER BY f.sent_at DESC)
                   FILTER (WHERE f.rn <= 3)
    INTO v_racha, v_destinatarios, v_primer_fallo, v_req_ids
    FROM v_fin f, v_corte c
   WHERE f.rn < c.primera_ok;

  v_racha         := COALESCE(v_racha, 0);
  v_destinatarios := COALESCE(v_destinatarios, 0);

  SELECT max(sd.sent_at) INTO v_ultimo_fin
    FROM sms_deliveries sd
   WHERE sd.status IN ('delivered', 'un_delivered');

  -- Informativo, NO dispara por sí solo: durante la recuperación del 15-ago los acuses
  -- tardaron hasta 34 min de forma legítima (cola drenando), así que alertar por esto
  -- sería ruido. Va en el detalle porque distingue "rechaza rápido" de "retiene".
  SELECT count(*) INTO v_atascados
    FROM sms_deliveries sd
   WHERE sd.status = 'sent'
     AND sd.sent_at > v_now - interval '24 hours'
     AND sd.sent_at < v_now - interval '30 minutes';

  -- 'unknown' cuando no hay evidencia fresca: sin tráfico reciente no se puede afirmar
  -- ni que entrega ni que no. Nunca emite correo, así que un apagón durante el cual la
  -- gente deja de intentar NO se lee como recuperación.
  v_status := CASE
    WHEN v_ultimo_fin IS NULL
      OR v_ultimo_fin < v_now - interval '24 hours'          THEN 'unknown'
    WHEN v_racha >= v_k AND v_destinatarios >= v_min_dest    THEN 'down'
    ELSE 'ok' END;

  v_horas_txt := CASE
    WHEN v_primer_fallo IS NULL THEN '—'
    ELSE round(extract(epoch FROM (v_now - v_primer_fallo)) / 3600.0, 1)::text || ' h' END;

  v_detalle := v_racha::text || ' fallos seguidos · '
            || v_destinatarios::text || ' destinatarios'
            || CASE WHEN v_racha > 0 THEN ' · desde hace ' || v_horas_txt ELSE '' END
            || CASE WHEN v_atascados > 0
                    THEN ' · ' || v_atascados::text || ' sin acuse >30 min' ELSE '' END;

  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'sms_delivery_status';
  v_prev := COALESCE(v_prev, 'unknown');

  -- Persistir SIEMPRE el estado, aunque el email falle después.
  INSERT INTO platform_config (key, value) VALUES
    ('sms_delivery_status', to_jsonb(v_status)),
    ('sms_delivery_at',     to_jsonb(v_now::text)),
    ('sms_delivery_detail', to_jsonb(v_detalle))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- ── Alertar SOLO en transición; 'unknown' nunca notifica ───────────────────────
  IF (v_status = 'down' AND v_prev <> 'down')
     OR (v_status = 'ok' AND v_prev = 'down') THEN

    SELECT value #>> '{}' INTO v_to_raw
      FROM platform_config WHERE key = 'business_notification_email';

    IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
      v_service_key := get_service_role_key();
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key,
        'apikey', v_service_key);

      IF v_status = 'down' THEN
        v_subject := '[TriciGo] Los SMS salen pero NO llegan — la ruta a Cuba no entrega';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">SMS aceptados pero no entregados</h2>'
          || '<p>D7 está <b>aceptando</b> los mensajes (HTTP 200) pero el operador devuelve '
          || '<code>un_delivered</code>: <b>' || v_racha::text || ' seguidos</b> a <b>'
          || v_destinatarios::text || ' teléfonos distintos</b>. Mientras dure, quien intente '
          || 'entrar <b>no recibe su código</b>, aunque en los logs el envío se vea exitoso. '
          || 'Tampoco llegan el <b>SOS</b> ni el link de viaje a contactos de confianza.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Fallos consecutivos</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_racha::text || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Teléfonos afectados</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || v_destinatarios::text || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Primer fallo</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_primer_fallo::text, '—') || ' (' || v_horas_txt || ')</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><b>Qué hacer:</b> esto casi nunca se arregla del lado de TriciGo — el mensaje '
          || 'sale bien. Abrir ticket en <code>app.d7networks.com</code> pidiendo el motivo del '
          || '<code>un_delivered</code> en la ruta +53 y si el sender ID <code>TriciGo</code> '
          || 'sigue habilitado en ETECSA, citando estos request_id:</p>'
          || '<p style="font-family:monospace;font-size:12px;background:#f5f5f5;padding:8px;border-radius:4px">'
          || COALESCE(v_req_ids, '—') || '</p>'
          || '<p>Ojo: <b>cada intento se cobra igual</b> (~$0.07 a Cuba) aunque no se entregue.</p>'
          || '<p style="color:#777;font-size:12px">Watchdog de entrega de SMS (00566). Mide el acuse del '
          || 'operador, no el envío. Umbrales en platform_config.sms_delivery_fail_streak / '
          || 'sms_delivery_min_recipients. No responder.</p>'
          || '</body></html>';
      ELSE
        v_subject := '[TriciGo] Entrega de SMS recuperada';
        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#059669;border-bottom:2px solid #059669;padding-bottom:8px">Entrega de SMS recuperada</h2>'
          || '<p>El operador volvió a acusar entregas. Los códigos de verificación llegan otra vez.</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Último acuse</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ultimo_fin::text, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Fecha (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p style="color:#777;font-size:12px">Watchdog de entrega de SMS (00566). No responder.</p>'
          || '</body></html>';
      END IF;

      -- business_notification_email puede ser CSV; send-email toma un destinatario por llamada.
      FOR v_rcpt IN
        SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
        WHERE position('@' IN x) > 0
      LOOP
        PERFORM public.cron_http_post('sms-delivery-alert',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
          headers := v_headers,
          body    := jsonb_build_object(
                       'recipient_email', v_rcpt,
                       'subject', v_subject,
                       -- HTML crudo: send-email lo acepta por el legacy path de
                       -- resolveTemplate(). El guardrail solo rechaza slugs pelados.
                       'template', v_html,
                       'data', '{}'::jsonb));
        v_sent := v_sent + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status, 'prev', v_prev,
    'racha', v_racha, 'destinatarios', v_destinatarios,
    'primer_fallo', v_primer_fallo, 'sin_acuse_30min', v_atascados,
    'transitioned', (v_prev IS DISTINCT FROM v_status), 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_sms_delivery_rate failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_stuck_active_rides()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_enabled     text;
  v_win_s       integer;
  v_radius_m    integer;
  v_chat_s      integer;
  v_now         timestamptz := now();
  v_ride        RECORD;
  v_last_loc    geography;
  v_pt_count    integer;
  v_max_dist    numeric;
  v_span_s      numeric;
  v_blocked     boolean;
  v_chat        boolean;
  v_reason      text;
  v_customer    text;
  v_driver_name text;
  v_driver_tel  text;
  v_service_key text;
  v_headers     jsonb;
  v_to_raw      text;
  v_rcpt        text;
  v_subject     text;
  v_html        text;
  v_alerted     integer := 0;
  v_resolved    integer := 0;
  v_sent        integer := 0;
BEGIN
  -- Trampa jsonb (CLAUDE.md): #>> '{}' normaliza boolean true y string "true"
  -- a 'true', así el kill-switch funciona con ambas formas.
  SELECT value #>> '{}' INTO v_enabled FROM platform_config WHERE key = 'stuck_ride_watchdog_enabled';
  IF COALESCE(v_enabled, 'true') = 'false' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'disabled');
  END IF;

  v_win_s    := COALESCE(get_platform_config_numeric('stuck_ride_stationary_min_s', 300), 300)::int;
  v_radius_m := COALESCE(get_platform_config_numeric('stuck_ride_stationary_radius_m', 60), 60)::int;
  v_chat_s   := COALESCE(get_platform_config_numeric('stuck_ride_chat_window_s', 900), 900)::int;

  -- 1) Resolver en silencio las alertas cuyo viaje ya cerró.
  UPDATE stuck_ride_alerts sa SET resolved_at = v_now
  FROM rides rr
  WHERE rr.id = sa.ride_id
    AND sa.resolved_at IS NULL
    AND rr.status NOT IN ('in_progress', 'arrived_at_destination')
    -- 00555: 00542 alerta sobre arrived_at_pickup, un estado que este
    -- barrido no cubre; sin esto la alerta se retiraba sin avisar.
    AND NOT (sa.reason = 'dead_driver_app' AND rr.status = 'arrived_at_pickup');
  GET DIAGNOSTICS v_resolved = ROW_COUNT;

  -- 2) Barrer los viajes activos aún no alertados.
  FOR v_ride IN
    SELECT rr.id, rr.status, rr.pickup_address, rr.dropoff_address,
           rr.customer_id, rr.driver_id, rr.pickup_at, rr.accepted_at, rr.created_at
    FROM rides rr
    WHERE rr.status IN ('in_progress', 'arrived_at_destination')
      AND NOT EXISTS (SELECT 1 FROM stuck_ride_alerts sa WHERE sa.ride_id = rr.id)
  LOOP
    -- Señal directa: intentos de finalizar bloqueados por distancia (00537).
    SELECT EXISTS (
      SELECT 1 FROM validation_events ve
      WHERE ve.ride_id = v_ride.id
        AND ve.event_type = 'complete_blocked_distance'
        AND ve.created_at >= COALESCE(v_ride.accepted_at, v_ride.created_at)
    ) INTO v_blocked;

    v_reason := NULL;

    IF v_blocked THEN
      v_reason := 'complete_blocked';
      v_max_dist := NULL;
      v_span_s := NULL;
    ELSE
      -- Señal inferida: conductor quieto + chat reciente.
      SELECT le.location::geography INTO v_last_loc
      FROM ride_location_events le
      WHERE le.ride_id = v_ride.id
      ORDER BY le.recorded_at DESC, le.id DESC
      LIMIT 1;

      IF v_last_loc IS NOT NULL THEN
        SELECT count(*),
               max(ST_Distance(le.location::geography, v_last_loc)),
               extract(epoch FROM (max(le.recorded_at) - min(le.recorded_at)))
          INTO v_pt_count, v_max_dist, v_span_s
        FROM ride_location_events le
        WHERE le.ride_id = v_ride.id
          AND le.recorded_at >= v_now - make_interval(secs => v_win_s);

        IF v_pt_count >= 3
           AND v_span_s >= (v_win_s * 0.8)
           AND v_max_dist <= v_radius_m THEN
          SELECT EXISTS (
            SELECT 1 FROM ride_messages rm
            WHERE rm.ride_id = v_ride.id
              AND rm.created_at >= v_now - make_interval(secs => v_chat_s)
          ) INTO v_chat;
          IF v_chat THEN
            v_reason := 'stationary_chat';
          END IF;
        END IF;
      END IF;
    END IF;

    CONTINUE WHEN v_reason IS NULL;

    INSERT INTO stuck_ride_alerts (ride_id, reason, details)
    VALUES (
      v_ride.id,
      v_reason,
      jsonb_build_object(
        'status_at_detection', v_ride.status,
        'stationary_max_dist_m', v_max_dist,
        'stationary_span_s', v_span_s
      )
    )
    ON CONFLICT (ride_id) DO NOTHING;
    v_alerted := v_alerted + 1;

    -- 3) Email (best-effort; la alerta ya quedó persistida).
    BEGIN
      SELECT u.full_name INTO v_customer FROM users u WHERE u.id = v_ride.customer_id;
      SELECT u.full_name, u.phone INTO v_driver_name, v_driver_tel
      FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
      WHERE dp.id = v_ride.driver_id;

      SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'stuck_ride_alert_email';
      IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
        SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
      END IF;

      IF v_to_raw IS NOT NULL AND position('@' IN v_to_raw) > 0 THEN
        v_service_key := get_service_role_key();
        v_headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key,
          'apikey', v_service_key);

        v_subject := '[TriciGo] Viaje trabado #' || left(v_ride.id::text, 8)
          || CASE WHEN v_reason = 'complete_blocked'
               THEN ' — conductor bloqueado al finalizar'
               ELSE ' — detenido con chat activo' END;

        v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111">'
          || '<h2 style="color:#d97706;border-bottom:2px solid #d97706;padding-bottom:8px">Viaje posiblemente trabado</h2>'
          || '<p>'
          || CASE WHEN v_reason = 'complete_blocked'
               THEN 'La app del conductor registró <b>intentos de finalizar bloqueados por distancia al pin</b> (validation_events <code>complete_blocked_distance</code>). Puede ser un pin de destino mal geocodificado — mismo patrón del incidente b428022b.'
               ELSE 'El conductor lleva <b>&ge;' || (v_win_s / 60)::text || ' min detenido</b> con el viaje abierto y hay <b>chat reciente</b> entre las partes. Suele significar que están resolviendo a mano algo que la app no deja hacer.'
             END
          || '</p>'
          || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Viaje</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">#' || left(v_ride.id::text, 8) || ' (' || v_ride.status || ')</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Cliente</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_customer, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Conductor</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_driver_name, '—') || ' ' || COALESCE(v_driver_tel, '') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Origen</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ride.pickup_address, '—') || '</td></tr>'
          || '<tr><td style="padding:6px;border-bottom:1px solid #eee"><b>Destino</b></td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">' || COALESCE(v_ride.dropoff_address, '—') || '</td></tr>'
          || '<tr><td style="padding:6px"><b>Detectado (UTC)</b></td><td style="padding:6px;text-align:right">' || v_now::text || '</td></tr>'
          || '</table>'
          || '<p><a href="https://admin.tricigo.com/rides/' || v_ride.id::text || '" '
          || 'style="display:inline-block;background:#d97706;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Ver viaje en el admin</a></p>'
          || '<p style="color:#777;font-size:12px">Watchdog de viajes trabados (00538). Se alerta una sola vez por viaje. No responder.</p>'
          || '</body></html>';

        FOR v_rcpt IN
          SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
          WHERE position('@' IN x) > 0
        LOOP
          PERFORM public.cron_http_post('stuck-ride-alert', 
            url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
            headers := v_headers,
            body    := jsonb_build_object(
                         'recipient_email', v_rcpt,
                         'subject', v_subject,
                         -- HTML crudo: legacy path de resolveTemplate() (patrón 00503).
                         'template', v_html,
                         'data', '{}'::jsonb));
          v_sent := v_sent + 1;
        END LOOP;

        UPDATE stuck_ride_alerts SET emailed_at = v_now WHERE ride_id = v_ride.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'stuck-ride email failed for ride %: % %', v_ride.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'alerted', v_alerted, 'resolved', v_resolved, 'emails_sent', v_sent);

EXCEPTION WHEN OTHERS THEN
  -- Defensivo: el watchdog NUNCA debe tumbar el cron ni propagar un error.
  RAISE WARNING 'check_stuck_active_rides failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_audit_log()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  c_telemetry CONSTANT text[] :=
    ARRAY['last_heartbeat_at', 'current_location', 'current_heading', 'updated_at'];
  -- ::int obligatorio: get_platform_config_numeric devuelve NUMERIC y
  -- make_interval solo acepta INT en days (trampa documentada en 00527).
  v_keep_days     int := COALESCE(get_platform_config_numeric('audit_log_retention_days', 90), 90)::int;
  v_keep_tel_days int := COALESCE(get_platform_config_numeric('audit_log_telemetry_retention_days', 14), 14)::int;
  v_batch         int := COALESCE(get_platform_config_numeric('audit_log_prune_batch', 20000), 20000)::int;
  v_old int := 0;
  v_tel int := 0;
BEGIN
  DELETE FROM audit_log WHERE ctid IN (
    SELECT a.ctid FROM audit_log a
    WHERE a.created_at < now() - make_interval(days => v_keep_days)
    LIMIT v_batch);
  GET DIAGNOSTICS v_old = ROW_COUNT;

  DELETE FROM audit_log WHERE ctid IN (
    SELECT a.ctid FROM audit_log a
    WHERE a.table_name = 'driver_profiles'
      AND a.operation  = 'UPDATE'
      AND a.created_at < now() - make_interval(days => v_keep_tel_days)
      AND (a.old_values - c_telemetry) IS NOT DISTINCT FROM (a.new_values - c_telemetry)
    LIMIT v_batch);
  GET DIAGNOSTICS v_tel = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_retention', v_old,
    'deleted_telemetry', v_tel,
    'retention_days', v_keep_days,
    'telemetry_retention_days', v_keep_tel_days,
    'batch', v_batch,
    'remaining_rows', (SELECT count(*) FROM audit_log));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_audit_log failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_cron_job_run_details()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_keep  int := COALESCE(get_platform_config_numeric('cron_run_details_retention_days', 14), 14)::int;
  v_batch int := COALESCE(get_platform_config_numeric('cron_run_details_prune_batch', 50000), 50000)::int;
  v_n     int := 0;
BEGIN
  DELETE FROM cron.job_run_details WHERE ctid IN (
    SELECT d.ctid FROM cron.job_run_details d
    WHERE d.start_time < now() - make_interval(days => v_keep)
    LIMIT v_batch);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_n, 'retention_days', v_keep, 'batch', v_batch);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_cron_job_run_details failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prune_driver_heartbeat_log()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_keep int := COALESCE(get_platform_config_numeric('driver_heartbeat_retention_days', 30), 30)::int;
  v_n    int := 0;
BEGIN
  DELETE FROM driver_heartbeat_log WHERE beat_at < now() - make_interval(days => v_keep);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'deleted', v_n, 'retention_days', v_keep);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prune_driver_heartbeat_log failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.notify_dead_driver_alert()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_ids         uuid[];
  v_rows        text := '';
  v_html        text;
  v_subject     text;
  v_to_raw      text;
  v_rcpt        text;
  v_service_key text;
  v_headers     jsonb;
  v_sent        integer := 0;
  v_a           record;
BEGIN
  SELECT array_agg(sa.ride_id) INTO v_ids
  FROM stuck_ride_alerts sa
  WHERE sa.reason = 'dead_driver_app'
    AND sa.emailed_at IS NULL
    AND sa.resolved_at IS NULL;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'pending', 0, 'emails_sent', 0);
  END IF;

  SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'stuck_ride_alert_email';
  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    SELECT value #>> '{}' INTO v_to_raw FROM platform_config WHERE key = 'business_notification_email';
  END IF;

  IF v_to_raw IS NULL OR position('@' IN v_to_raw) = 0 THEN
    RAISE WARNING '[notify_dead_driver_alert] sin destinatario configurado; % alertas quedan pendientes',
      array_length(v_ids, 1);
    RETURN jsonb_build_object('ok', false, 'pending', array_length(v_ids, 1),
                              'emails_sent', 0, 'error', 'no_recipient');
  END IF;

  FOR v_a IN
    SELECT sa.ride_id, sa.details, sa.detected_at,
           rd.status AS ride_status, rd.pickup_address, rd.dropoff_address,
           cu.full_name AS customer_name,
           du.full_name AS driver_name, du.phone AS driver_phone
    FROM stuck_ride_alerts sa
    JOIN rides rd ON rd.id = sa.ride_id
    LEFT JOIN users cu ON cu.id = rd.customer_id
    LEFT JOIN driver_profiles dp ON dp.id = rd.driver_id
    LEFT JOIN users du ON du.id = dp.user_id
    WHERE sa.ride_id = ANY(v_ids)
    ORDER BY sa.detected_at
  LOOP
    v_rows := v_rows
      || '<tr><td style="padding:8px;border-bottom:1px solid #eee">'
      || '<a href="https://admin.tricigo.com/rides/' || v_a.ride_id::text || '">#'
      || left(v_a.ride_id::text, 8) || '</a><br>'
      || '<span style="color:#777;font-size:12px">' || COALESCE(v_a.ride_status::text, '—') || '</span></td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee">'
      || COALESCE(v_a.driver_name, '—') || ' ' || COALESCE(v_a.driver_phone, '')
      || '<br><span style="color:#777;font-size:12px">sin latido hace '
      || COALESCE(v_a.details ->> 'minutes_silent', '?') || ' min</span></td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee">'
      || COALESCE(v_a.customer_name, '—') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">'
      || COALESCE(v_a.pickup_address, '—') || ' → ' || COALESCE(v_a.dropoff_address, '—')
      || '</td></tr>';
  END LOOP;

  v_subject := '[TriciGo] Conductor sin conexión — ' || array_length(v_ids, 1)::text
    || CASE WHEN array_length(v_ids, 1) = 1 THEN ' viaje en curso' ELSE ' viajes en curso' END;

  v_html := '<!DOCTYPE html><html lang="es"><body style="font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#111">'
    || '<h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:8px">La app del conductor dejó de responder</h2>'
    || '<p>Estos viajes ya pasaron la recogida, así que <b>el pasajero puede ir a bordo y el viaje puede estar ocurriendo de verdad</b>. '
    || 'Por eso no se cancelan ni se reasignan solos: hace falta revisión humana. '
    || 'Los viajes anteriores a la recogida sí se liberaron automáticamente y ya se está buscando otro conductor.</p>'
    || '<table style="width:100%;border-collapse:collapse;margin:16px 0">'
    || '<tr style="text-align:left;background:#f5f5f5">'
    || '<th style="padding:8px">Viaje</th><th style="padding:8px">Conductor</th>'
    || '<th style="padding:8px">Pasajero</th><th style="padding:8px">Ruta</th></tr>'
    || v_rows
    || '</table>'
    || '<p style="color:#777;font-size:12px">Watchdog de conductores muertos (00542 + 00555). '
    || 'Se avisa una sola vez por viaje. No responder.</p>'
    || '</body></html>';

  v_service_key := get_service_role_key();
  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_service_key,
    'apikey', v_service_key);

  FOR v_rcpt IN
    SELECT btrim(x) FROM unnest(string_to_array(v_to_raw, ',')) AS t(x)
    WHERE position('@' IN x) > 0
  LOOP
    PERFORM public.cron_http_post('dead-driver-alert',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object(
                   'recipient_email', v_rcpt,
                   'subject', v_subject,
                   'template', v_html,
                   'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;

  UPDATE stuck_ride_alerts SET emailed_at = v_now WHERE ride_id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'pending', array_length(v_ids, 1), 'emails_sent', v_sent);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[notify_dead_driver_alert] failed: % %', SQLSTATE, SQLERRM;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.release_rides_from_dead_drivers()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_after_min   INT;
  v_enabled     TEXT;
  v_released    INT := 0;
  v_flagged     INT := 0;
  v_rider_ids   JSONB := '[]'::jsonb;
  v_service_key TEXT;
  r             RECORD;
BEGIN
  SELECT COALESCE((value #>> '{}'), 'true') INTO v_enabled
  FROM platform_config WHERE key = 'dead_driver_ride_release_enabled';
  IF v_enabled IN ('false', 'f') THEN
    RETURN jsonb_build_object('enabled', false, 'released', 0, 'flagged', 0);
  END IF;

  -- ::int es obligatorio: get_platform_config_numeric devuelve NUMERIC y
  -- make_interval(mins => ...) solo acepta INT (revienta en runtime, no al crear).
  v_after_min := GREATEST(1, get_platform_config_numeric('dead_driver_ride_release_after_minutes', 12))::int;

  -- A) PRE-RECOGIDA → devolver a búsqueda
  FOR r IN
    SELECT rd.id, rd.customer_id, rd.driver_id, rd.status
    FROM rides rd
    JOIN driver_profiles dp ON dp.id = rd.driver_id
    WHERE rd.status IN ('accepted', 'driver_en_route')
      AND dp.last_heartbeat_at IS NOT NULL
      AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  LOOP
    -- Sacar de línea al conductor muerto ANTES de liberar. Sin esto hay una carrera:
    -- find_best_drivers filtra por is_online pero el filtro de heartbeat está desactivado
    -- por defecto (dispatch_heartbeat_window_s = 0), así que un conductor muerto todavía
    -- marcado online podría recibir de vuelta el mismo viaje que le acabamos de quitar.
    UPDATE driver_profiles
    SET is_online = false, auto_offline_at = COALESCE(auto_offline_at, now())
    WHERE id = r.driver_id AND is_online = true;

    -- searching_seen_at = now() es CRÍTICO: cleanup_orphan_searching_rides (cron cada minuto)
    -- cancela los `searching` cuyo searching_seen_at supera searching_abandon_seconds. Sin
    -- refrescarlo, el viaje liberado se cancelaría al minuto siguiente. Con el refresco arranca
    -- una ventana limpia, y si nadie lo toma, ese mismo cron lo cierra de forma ordenada.
    -- last_dispatched_at = NULL deja que retry_dispatch_expired_rides lo re-despache ya.
    UPDATE rides
    SET status             = 'searching',
        driver_id          = NULL,
        accepted_at        = NULL,
        searching_seen_at  = now(),
        last_dispatched_at = NULL,
        updated_at         = now()
    WHERE id = r.id
      AND status = r.status;   -- guarda optimista: si el conductor revivió y avanzó, no lo pisamos

    IF FOUND THEN
      v_released := v_released + 1;
      v_rider_ids := v_rider_ids || to_jsonb(r.customer_id);

      UPDATE ride_offers
      SET status = 'expired'
      WHERE ride_id = r.id AND driver_profile_id = r.driver_id AND status = 'pending';
    END IF;
  END LOOP;

  -- B) POST-RECOGIDA → solo alertar, jamás tocar el viaje
  INSERT INTO stuck_ride_alerts (ride_id, reason, details)
  SELECT rd.id, 'dead_driver_app',
         jsonb_build_object(
           'ride_status', rd.status,
           'driver_id', rd.driver_id,
           'last_heartbeat_at', dp.last_heartbeat_at,
           'minutes_silent', ROUND(EXTRACT(EPOCH FROM (now() - dp.last_heartbeat_at)) / 60)
         )
  FROM rides rd
  JOIN driver_profiles dp ON dp.id = rd.driver_id
  WHERE rd.status IN ('arrived_at_pickup', 'in_progress', 'arrived_at_destination')
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at < now() - make_interval(mins => v_after_min)
  ON CONFLICT (ride_id) DO NOTHING;
  GET DIAGNOSTICS v_flagged = ROW_COUNT;

  -- 00555: avisar por correo. Hasta acá la fila se insertaba muda y 00538
  -- la auto-resolvía a los 5 min, así que nadie se enteraba nunca.
  PERFORM public.notify_dead_driver_alert();

  -- C) Avisar a los pasajeros liberados. Bloque propio: un fallo de push jamás debe
  -- deshacer la liberación.
  IF v_released > 0 THEN
    BEGIN
      v_service_key := get_service_role_key();
      IF v_service_key IS NOT NULL AND v_service_key <> '' THEN
        PERFORM public.cron_http_post('dead-driver-ride-released',
          url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-push',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_key,
            'apikey',        v_service_key
          ),
          body    := jsonb_build_object(
            'user_ids', v_rider_ids,
            'title',    'Buscando otro conductor',
            'body',     'Tu conductor perdió la conexión y no pudo continuar. Estamos buscándote otro ahora mismo.',
            'category', 'ride',
            'data',     jsonb_build_object('reason', 'dead_driver_ride_released')
          )
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[release_rides_from_dead_drivers] push failed: % %', SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('enabled', true, 'released', v_released, 'flagged', v_flagged);
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

-- LIVE ACLs: {postgres=X/postgres,service_role=X/postgres} on every one of them.
REVOKE ALL ON FUNCTION public.get_platform_config_numeric FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_config_numeric TO service_role;
REVOKE ALL ON FUNCTION public.cron_http_post FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_http_post TO service_role;
REVOKE ALL ON FUNCTION public._db_health_html FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._db_health_html TO service_role;
REVOKE ALL ON FUNCTION public.send_db_health_email FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_db_health_email TO service_role;
REVOKE ALL ON FUNCTION public.evaluate_database_health FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_database_health TO service_role;
REVOKE ALL ON FUNCTION public.sample_database_health FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sample_database_health TO service_role;
REVOKE ALL ON FUNCTION public.check_database_health FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_database_health TO service_role;
REVOKE ALL ON FUNCTION public.send_db_health_digest FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.send_db_health_digest TO service_role;
REVOKE ALL ON FUNCTION public.check_cron_http_failures FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_cron_http_failures TO service_role;
REVOKE ALL ON FUNCTION public.check_exchange_rate_freshness FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_exchange_rate_freshness TO service_role;
REVOKE ALL ON FUNCTION public.check_poi_sync_freshness FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_poi_sync_freshness TO service_role;
REVOKE ALL ON FUNCTION public.check_sms_delivery_health FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_sms_delivery_health TO service_role;
REVOKE ALL ON FUNCTION public.check_sms_delivery_rate FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_sms_delivery_rate TO service_role;
REVOKE ALL ON FUNCTION public.check_stuck_active_rides FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_stuck_active_rides TO service_role;
REVOKE ALL ON FUNCTION public.prune_audit_log FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_audit_log TO service_role;
REVOKE ALL ON FUNCTION public.prune_cron_job_run_details FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_cron_job_run_details TO service_role;
REVOKE ALL ON FUNCTION public.prune_driver_heartbeat_log FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_driver_heartbeat_log TO service_role;
REVOKE ALL ON FUNCTION public.notify_dead_driver_alert FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_dead_driver_alert TO service_role;
REVOKE ALL ON FUNCTION public.release_rides_from_dead_drivers FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_rides_from_dead_drivers TO service_role;
REVOKE ALL ON FUNCTION public.cron_sql_failures_now FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cron_sql_failures_now TO service_role;
REVOKE ALL ON FUNCTION public.get_service_role_key FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_service_role_key TO service_role;

RESET ROLE;

-- The cron jobs that call these functions, with prod's schedule and command, run by postgres.
INSERT INTO cron.job (schedule, command, username, jobname) VALUES
  ('40 * * * *', 'SELECT public.check_cron_http_failures();', 'postgres', 'check-cron-http-failures'),
  ('55 * * * *', 'SELECT public.check_database_health();', 'postgres', 'check-database-health'),
  ('20 * * * *', 'SELECT public.check_exchange_rate_freshness();', 'postgres', 'check-exchange-rate-freshness'),
  ('50 * * * *', 'SELECT public.check_poi_sync_freshness();', 'postgres', 'check-poi-sync-freshness'),
  ('*/15 * * * *', 'SELECT public.check_sms_delivery_health();', 'postgres', 'check-sms-delivery-health'),
  ('*/15 * * * *', 'SELECT public.check_sms_delivery_rate();', 'postgres', 'check-sms-delivery-rate'),
  ('*/5 * * * *', 'SELECT public.check_stuck_active_rides();', 'postgres', 'check-stuck-rides'),
  ('30 7 * * *', 'SELECT public.send_db_health_digest();', 'postgres', 'db-health-digest'),
  ('25 * * * *', 'SELECT public.prune_audit_log();', 'postgres', 'prune-audit-log'),
  ('35 * * * *', 'SELECT public.prune_cron_job_run_details();', 'postgres', 'prune-cron-run-details'),
  ('45 5 * * *', 'SELECT public.prune_driver_heartbeat_log();', 'postgres', 'prune-driver-heartbeat-log'),
  ('*/5 * * * *', 'SELECT public.release_rides_from_dead_drivers();', 'postgres', 'release-dead-driver-rides');

-- ═════════════════════════════════════════════════════════════════════════════
-- Seed (ages relative to now(); the suite runs within a minute of it)
-- ═════════════════════════════════════════════════════════════════════════════
SET ROLE postgres;

INSERT INTO public.users (id, full_name, phone) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'Ana Pasajera',   '+5355500001'),
  ('a0000000-0000-4000-8000-000000000002', 'Beto Pasajero',  '+5355500002'),
  ('a0000000-0000-4000-8000-0000000000d1', 'Carlos Conductor', '+5355500011'),
  ('a0000000-0000-4000-8000-0000000000d2', 'Dora Conductora',  '+5355500012');
-- Two drivers whose app went silent 30 minutes ago and who still show online.
INSERT INTO public.driver_profiles (id, user_id, is_online, last_heartbeat_at) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000d1', true, now() - interval '30 minutes'),
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-0000000000d2', true, now() - interval '30 minutes');
-- r1 before pickup (released by release_rides_from_dead_drivers), r2 on board (flagged only).
INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_address, dropoff_address, accepted_at, created_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'accepted', 'Calle 23 e/ L y M', 'Obispo e/ Habana y Aguiar', now() - interval '40 minutes', now() - interval '41 minutes'),
  ('e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002',
   'in_progress', 'Malecon y G', 'Paseo y 17', now() - interval '45 minutes', now() - interval '46 minutes');
INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'pending', now() + interval '1 minute');

-- 2 heartbeats past the 30-day retention, 1 inside it.
INSERT INTO public.driver_heartbeat_log (driver_profile_id, beat_at, is_online) VALUES
  ('d0000000-0000-4000-8000-000000000001', now() - interval '40 days', true),
  ('d0000000-0000-4000-8000-000000000001', now() - interval '35 days', true),
  ('d0000000-0000-4000-8000-000000000001', now() - interval '1 day', true);

-- 1 row past the 90-day retention, 1 telemetry-only row past the 14-day one, 1 recent row.
INSERT INTO public.audit_log (table_name, record_id, operation, old_values, new_values, created_at) VALUES
  ('rides', 'r-old', 'INSERT', NULL, '{"status": "searching"}', now() - interval '100 days'),
  ('driver_profiles', 'd1', 'UPDATE', '{"is_online": true, "last_heartbeat_at": "a"}', '{"is_online": true, "last_heartbeat_at": "b"}', now() - interval '20 days'),
  ('rides', 'r-new', 'UPDATE', '{"status": "searching"}', '{"status": "accepted"}', now() - interval '1 day');

INSERT INTO public.exchange_rates (source, usd_cup_rate, fetched_at, is_current)
VALUES ('eltoque_api', 400, now() - interval '1 hour', true);
INSERT INTO public.poi_sync_state (region, last_sequence, last_sync_at, last_sync_kind)
VALUES ('cuba', 1, now() - interval '2 hours', 'delta');
INSERT INTO public.cuba_pois (is_active) VALUES (true), (true), (true), (false);

RESET ROLE;

-- 2 runs past the 14-day retention of cron.job_run_details, 1 recent.
INSERT INTO cron.job_run_details (jobid, database, username, command, status, return_message, start_time, end_time)
SELECT j.jobid, j.database, j.username, j.command, 'succeeded', '1 row', now() - a.ago, now() - a.ago + interval '40 milliseconds'
FROM cron.job j
CROSS JOIN (VALUES (interval '20 days'), (interval '15 days'), (interval '1 hour')) AS a(ago)
WHERE j.jobname = 'prune-audit-log';

-- ═════════════════════════════════════════════════════════════════════════════
-- Test helpers (not production shapes)
-- ═════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA t;

-- Runs a job the way pg_cron does: its command in a transaction of its own (here a
-- subtransaction), then one cron.job_run_details row. pg_cron stores the command
-- tag for a success and the server's error text, starting with 'ERROR:', for a
-- failure (00597); that prefix is all check_cron_sql_failures reads.
CREATE FUNCTION t.run_job(p_jobname text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_job    cron.job%ROWTYPE;
  v_start  timestamptz := clock_timestamp();
  v_status text;
  v_msg    text;
BEGIN
  SELECT * INTO v_job FROM cron.job WHERE jobname = p_jobname;
  IF NOT FOUND THEN
    RETURN 'no such job';
  END IF;
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

-- Whether a function returning jsonb returned (and its "ok") or raised.
CREATE FUNCTION t.outcome(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN 'returned ok=' || COALESCE(v ->> 'ok', 'null');
EXCEPTION WHEN OTHERS THEN
  RETURN 'raised: ' || SQLERRM;
END $$;

-- Requests a function queued through cron_http_post, per label.
CREATE FUNCTION t.queued(p_jobname text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.cron_http_calls WHERE jobname = p_jobname
$$;
