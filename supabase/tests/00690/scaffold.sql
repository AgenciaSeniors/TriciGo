-- Scaffold for the 00690 rehearsal: the database health watchdog (00577) as it runs in prod on
-- 2026-11-18. The function bodies are prod's, copied byte for byte with pg_get_functiondef; the
-- tables carry prod's columns. Like prod, postgres owns everything, is not a superuser and is a
-- member of pg_read_all_stats (so a SECURITY DEFINER function sees every session's backend_type).
-- net.http_post only records the request: no e-mail leaves the rehearsal.
SET client_min_messages = warning;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
GRANT pg_read_all_stats TO postgres;
GRANT CREATE ON SCHEMA public TO postgres;
CREATE SCHEMA net AUTHORIZATION postgres;

SET SESSION AUTHORIZATION postgres;

CREATE TABLE net.zz_requests (
  id      bigserial PRIMARY KEY,
  url     text,
  headers jsonb,
  body    jsonb
);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
 RETURNS bigint LANGUAGE sql
AS $f$ INSERT INTO net.zz_requests (url, headers, body) VALUES (url, headers, body) RETURNING id $f$;

CREATE TABLE public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname    text NOT NULL,
  url        text,
  called_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.platform_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.db_health_samples (
  sampled_at    timestamptz PRIMARY KEY DEFAULT now(),
  db_size_bytes bigint  NOT NULL,
  conn_used     int     NOT NULL,
  conn_max      int     NOT NULL,
  cache_hit_pct numeric(5,2),
  dead_tuples   bigint,
  longest_tx_s  int,
  idle_in_tx    int,
  deadlocks     bigint,
  top_tables    jsonb
);
ALTER TABLE public.db_health_samples ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS $f$ SELECT 'zz-service-key'::text $f$;

-- ── Live bodies (prod, 2026-11-18) ──
-- get_platform_config_numeric: md5 13d2587037eca74854cf2394ba42a90c, 479 characters
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

-- cron_http_post: md5 15d9ded451c60f92a0fd0a3c4e1ee0ab, 626 characters
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
$function$;

-- send_db_health_email: md5 1358c35561353f2bb514e3da6614e363, 1494 characters
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
    PERFORM public.cron_http_post('db-health-email',
      url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email',
      headers := v_headers,
      body    := jsonb_build_object('recipient_email', v_rcpt, 'subject', p_subject,
                                    -- HTML crudo por el legacy path de resolveTemplate().
                                    'template', p_html, 'data', '{}'::jsonb));
    v_sent := v_sent + 1;
  END LOOP;
  RETURN v_sent;
END;
$function$;

-- _db_health_html: md5 9488dabfba2c0bfa77317711a8db778b, 3634 characters
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
$function$;

-- evaluate_database_health: md5 08c3bedbfe9695d9591735538c945e7e, 4390 characters
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
$function$;

-- sample_database_health: md5 a783d40d937aa44aba84f1ba31e819fe, 2284 characters
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
END;
$function$;

-- check_database_health: md5 9b430de3b750510e0079ea5b122f110f, 1720 characters
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
END;
$function$;

-- send_db_health_digest: md5 56da1c243a370de9cdfd077870069ada, 857 characters
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
END;
$function$;

-- Prod's grants: postgres and service_role.
DO $grants$
DECLARE
  v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
  END LOOP;
END
$grants$;

-- Prod's settings for the watchdog (2026-11-18), plus two test recipients.
INSERT INTO public.platform_config (key, value) VALUES
  ('db_cache_hit_warn_pct', '95'), ('db_conn_crit_pct', '90'), ('db_conn_warn_pct', '75'),
  ('db_health_digest_enabled', 'true'), ('db_health_sample_retention_days', '90'),
  ('db_health_status', '"ok"'), ('db_long_tx_warn_seconds', '300'),
  ('db_size_crit_mb', '7500'), ('db_size_warn_mb', '6000'),
  ('business_notification_email', '"a@zz.test, b@zz.test"');

RESET SESSION AUTHORIZATION;
