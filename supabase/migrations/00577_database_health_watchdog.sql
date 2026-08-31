-- 00577 — Salud de la base: muestreo, correo diario y alerta temprana
--
-- Pedido del dueño tras tener que reiniciar la base porque colapsó: "algo que
-- me avise cuando esté a punto de colapsar, y un correo a diario para ir
-- viendo su estado".
--
-- 00576 corta la causa que se encontró (audit_log + cron.job_run_details
-- crecían 15,7 MB/día sin techo). Esto es la otra mitad: VER venir el próximo
-- problema, que puede no ser el mismo. Al momento de escribir esto la otra
-- señal apretada es CONEXIONES — max_connections=60 y 36 ya ocupadas en
-- reposo por los pools internos de Supabase (postgrest 8, storage 10,
-- realtime 6...): quedan ~24 de margen real.
--
-- POR QUÉ ES SQL PURO Y NO UNA EDGE FUNCTION: misma razón que
-- check_exchange_rate_freshness (00503). Una EF invocada por net.http_post
-- hereda la ceguera de pg_cron ante los fallos HTTP, y peor: si la base está
-- por colapsar, la EF puede no conseguir conexión justo cuando hay que avisar.
-- La detección corre DENTRO de la base; el único HTTP es el envío del correo,
-- que es la acción, no la detección.
--
-- DOS CANALES, a propósito:
--   digest diario  -> siempre sale, aunque esté todo bien. Es el "ir viendo
--                     su estado" que se pidió: tendencia y proyección.
--   alerta         -> solo en TRANSICIÓN de severidad (patrón 00503/00574),
--                     para que un problema que dura una semana no mande 168
--                     correos. Llega apenas cruza el umbral, sin esperar al
--                     digest del día siguiente.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Umbrales (editables desde el panel admin, sin deploy)
-- ════════════════════════════════════════════════════════════════════════
--
-- db_size_*_mb son un TECHO ASUMIDO, no medido: Postgres no conoce el tamaño
-- del disco que le dio Supabase. 6000/7500 MB asumen el disco de 8 GB que
-- Supabase provisiona por defecto en las instancias chicas. Si el disco real
-- es otro, ajustar estas dos keys — es el único número de esta migración que
-- no salió de una medición.
INSERT INTO platform_config (key, value) VALUES
  ('db_size_warn_mb',                 to_jsonb(6000)),
  ('db_size_crit_mb',                 to_jsonb(7500)),
  ('db_conn_warn_pct',                to_jsonb(75)),
  ('db_conn_crit_pct',                to_jsonb(90)),
  ('db_long_tx_warn_seconds',         to_jsonb(300)),
  ('db_cache_hit_warn_pct',           to_jsonb(95)),
  ('db_health_digest_enabled',        to_jsonb(true)),
  ('db_health_sample_retention_days', to_jsonb(90))
ON CONFLICT (key) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Muestras
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.db_health_samples (
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

COMMENT ON TABLE public.db_health_samples IS
  '00577: una fila por hora con el estado de la base. Sin historial no hay ni '
  'tendencia ni proyección de "cuántos días quedan", que es justamente lo que '
  'convierte un número suelto en un aviso temprano.';

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
$function$;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Evaluación: severidad + proyección
-- ════════════════════════════════════════════════════════════════════════
-- Función de LECTURA pura: no manda correos ni escribe estado. La usan el
-- watchdog y el digest, así que los dos ven exactamente el mismo diagnóstico
-- (si divergieran, un correo diario podría decir "todo bien" mientras la
-- alerta grita, que es el modo de falla que se vio con fx_health vs
-- cron_http_health).

CREATE OR REPLACE FUNCTION public.evaluate_database_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

-- ════════════════════════════════════════════════════════════════════════
-- 4. Envío de correo (compartido por el digest y la alerta)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.send_db_health_email(p_subject text, p_html text)
RETURNS int
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
$function$;

-- Cuerpo HTML compartido: una sola definición para que el digest y la alerta
-- no puedan contar historias distintas.
CREATE OR REPLACE FUNCTION public._db_health_html(p_h jsonb, p_titulo text, p_color text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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

-- ════════════════════════════════════════════════════════════════════════
-- 5. Alerta por transición (horaria) y digest (diario)
-- ════════════════════════════════════════════════════════════════════════

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
$function$;

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
$function$;

REVOKE ALL ON FUNCTION public.sample_database_health()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.evaluate_database_health() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_database_health()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_db_health_digest()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_db_health_email(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._db_health_html(jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sample_database_health()   TO service_role;
GRANT EXECUTE ON FUNCTION public.evaluate_database_health() TO service_role;
GRANT EXECUTE ON FUNCTION public.check_database_health()    TO service_role;
GRANT EXECUTE ON FUNCTION public.send_db_health_digest()    TO service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 6. Crons
-- ════════════════════════════════════════════════════════════════════════
-- :55 horario (muestreo + alerta) — libre entre los watchdogs de :20/:40/:50.
-- El digest sale 07:30 UTC = 02:30 en La Habana, para que esté en la bandeja
-- al despertar. Va DESPUÉS del bloque de prunes de 03:00-05:45 UTC, así el
-- número que informa ya refleja la limpieza de la madrugada.
SELECT cron.unschedule('check-database-health') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='check-database-health');
SELECT cron.unschedule('db-health-digest')      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='db-health-digest');

SELECT cron.schedule('check-database-health', '55 * * * *', 'SELECT public.check_database_health();');
SELECT cron.schedule('db-health-digest',      '30 7 * * *', 'SELECT public.send_db_health_digest();');

-- Semilla del estado con la severidad REAL de este momento, para que aplicar
-- la migración no dispare un correo de "transición" que no corresponde
-- (mismo cuidado que 00574 con poi_sync_health_status).
SELECT sample_database_health();
INSERT INTO platform_config (key, value)
VALUES ('db_health_status', to_jsonb(COALESCE(evaluate_database_health() ->> 'status', 'ok')))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
