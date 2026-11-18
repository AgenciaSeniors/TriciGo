-- 00690: the database health watchdog (00577) counts the connections that take a slot, and tells
-- the team about a change only when two samples in a row agree.
--
-- Why. check_database_health runs at :55 and e-mails the five addresses in
-- business_notification_email on every status change. Only its connections rule ever fired
-- (2026-10-18 .. 2026-11-17: 24 "atención" and 24 "normalizada" e-mails, each pair an hour
-- apart), and it measured the wrong thing:
--   * sample_database_health counted count(*) of pg_stat_activity: every process, including the
--     ~9 background ones (checkpointer, walwriter, archiver, the pg_cron launcher, the pg_net
--     worker, the walsender...) that take no max_connections slot;
--   * it runs at :55, a */5 minute, when 14-17 pg_cron jobs start at once. pg_cron runs in libpq
--     mode (cron.use_background_workers = off), so each job is a client connection for under a
--     second. Measured at the sample instant, 2026-11-18 04:55:00.332: 22 -> 34 rows, the 12 extra
--     all `client backend | postgres | pg_cron`; real client sessions: 13;
--   * the denominator was max_connections (60), but 3 slots are kept for superusers: a client
--     gets 57.
-- The 20:55 reading of 2026-11-17, 49/60 (81.7%) "sobre el aviso de 75%", was about 28 real
-- connections, 49% of 57. Postgres logged no "too many clients" and no "remaining connection slots"
-- in the same days. One reading per hour with no confirmation turned each burst into two e-mails.
--
-- What changes.
--   A. db_health_samples.status: each sample keeps the status it was evaluated to.
--   B. _db_health_counts_connection: what counts as a connection. A client backend counts, unless
--      it is a pg_cron job started in the last 60 s (a job alive longer is stuck and holds its
--      slot, so it counts). A session whose backend_type the owner cannot see counts too: without
--      pg_read_all_stats the watchdog overcounts, as before, instead of going blind.
--   C. sample_database_health: conn_used with that rule, conn_max = the slots a client can take
--      (max_connections - superuser_reserved_connections - reserved_connections).
--   D. check_database_health: db_health_status is what the team was last told. A change is
--      e-mailed when this sample and the previous one agree on it; a turn for the worse into
--      critical is e-mailed at once. With no db_health_status yet, the database starts as normal
--      (the old body e-mailed "normalizada" on its very first run).
-- The thresholds (db_conn_warn_pct 75, db_conn_crit_pct 90) do not change: 75% of 57 is 43 real
-- connections. evaluate_database_health, the e-mail and the daily digest do not change either.
--
-- Rehearsal: supabase/tests/00690/run.sh (the scaffold carries prod's bodies of 2026-11-18).

SET lock_timeout = '5s';

-- ── A. The status of each sample ────────────────────────────
ALTER TABLE public.db_health_samples
  ADD COLUMN IF NOT EXISTS status text
  CONSTRAINT db_health_samples_status_chk CHECK (status IN ('ok', 'warn', 'critical'));

COMMENT ON COLUMN public.db_health_samples.status IS
  '00690: the status check_database_health evaluated this sample to. NULL before 00690, or for a sample taken by the daily digest and not yet checked.';

-- ── B. What counts as a connection ──────────────────────────
CREATE OR REPLACE FUNCTION public._db_health_counts_connection(p_backend_type text, p_application_name text,
                                                               p_backend_start timestamptz, p_now timestamptz)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    -- Not visible to the caller (no pg_read_all_stats): count it rather than miss it.
    WHEN p_backend_type IS NULL THEN true
    -- Background processes and workers take no max_connections slot.
    WHEN p_backend_type <> 'client backend' THEN false
    -- A pg_cron job started in the last minute: the burst this very check is part of.
    WHEN p_application_name = 'pg_cron' AND p_backend_start > p_now - interval '60 seconds' THEN false
    ELSE true
  END;
$function$;

REVOKE ALL ON FUNCTION public._db_health_counts_connection(text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._db_health_counts_connection(text, text, timestamptz, timestamptz)
  TO service_role;

-- ── Replacing live bodies ───────────────────────────────────
-- A body is replaced only from its md5 in prod on 2026-11-18 (00640's version), and re-applying
-- changes nothing. The new texts are stripped of chr(13), so a copy pasted from Windows replaces
-- the same.
CREATE OR REPLACE FUNCTION pg_temp.m00690_replace(p_fn regprocedure, p_old_md5 text, p_new_md5 text, p_body text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_md5 text;
  v_src text;
  v_def text;
BEGIN
  SELECT md5(prosrc), prosrc INTO v_md5, v_src FROM pg_proc WHERE oid = p_fn;
  IF v_md5 = p_new_md5 THEN
    RETURN;
  END IF;
  IF v_md5 IS DISTINCT FROM p_old_md5 THEN
    RAISE EXCEPTION '00690: % has an unknown body (md5 %)', p_fn, v_md5;
  END IF;
  SELECT pg_get_functiondef(p_fn) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_src, ''))) / length(v_src) <> 1 THEN
    RAISE EXCEPTION '00690: the body of % is not in its definition exactly once', p_fn;
  END IF;
  EXECUTE replace(v_def, v_src, replace(p_body, chr(13), ''));
END
$function$;

-- ── C. sample_database_health ───────────────────────────────
SELECT pg_temp.m00690_replace('public.sample_database_health()', 'a783d40d937aa44aba84f1ba31e819fe',
  '79de4691d0fe0571b53d992a76ef785a', $new$
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

  -- 00690: the slots a client can take. superuser_reserved_connections and reserved_connections
  -- are kept for superusers and for pg_use_reserved_connections.
  v_max := GREATEST(current_setting('max_connections')::int
                    - current_setting('superuser_reserved_connections')::int
                    - COALESCE(NULLIF(current_setting('reserved_connections', true), ''), '0')::int, 1);

  -- 00690: only client connections take a slot (public._db_health_counts_connection). The
  -- background processes do not, and neither do the pg_cron jobs started in the last minute: this
  -- job runs at :55 inside a */5 burst of jobs, each a connection for under a second.
  SELECT count(*) FILTER (WHERE public._db_health_counts_connection(backend_type, application_name,
                                                                    backend_start, clock_timestamp())),
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

  -- 00690: a sample taken again in the same hour has not been evaluated yet (status NULL).
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
    top_tables = EXCLUDED.top_tables, status = NULL;

  DELETE FROM db_health_samples WHERE sampled_at < now() - make_interval(days => v_keep);

  RETURN jsonb_build_object('ok', true, 'db_size_mb', round(v_size / 1048576.0, 1),
                            'conn', v_used || '/' || v_max, 'cache_hit_pct', v_cache);
END;
$new$);

-- ── D. check_database_health ────────────────────────────────
SELECT pg_temp.m00690_replace('public.check_database_health()', '9b430de3b750510e0079ea5b122f110f',
  '03278947b5eb362d80eb99a118bbbce8', $new$
DECLARE
  v_h        jsonb;
  v_status   text;
  v_at       timestamptz;
  v_prev     text;
  v_prev_raw text;
  v_new      text;
  v_announce boolean;
  v_sent     int := 0;
  v_color    text;
BEGIN
  PERFORM sample_database_health();
  v_h := evaluate_database_health();

  IF (v_h ->> 'ok')::boolean IS NOT TRUE THEN
    RETURN v_h;
  END IF;
  v_status := v_h ->> 'status';
  v_at     := (v_h ->> 'sampled_at')::timestamptz;

  -- 00690: each sample keeps its status, so the next run can tell whether two in a row agree.
  UPDATE db_health_samples SET status = v_status WHERE sampled_at = v_at;
  SELECT status INTO v_prev_raw
    FROM db_health_samples WHERE sampled_at < v_at ORDER BY sampled_at DESC LIMIT 1;

  -- db_health_status is what the team was last told. With no row yet, the database starts as normal.
  SELECT value #>> '{}' INTO v_prev FROM platform_config WHERE key = 'db_health_status';
  v_prev := COALESCE(v_prev, 'ok');

  -- 00690: a change is e-mailed only when this sample and the previous one agree on it. One reading
  -- over a threshold, or one back under it, sends nothing. A turn for the worse into critical is
  -- e-mailed at once.
  v_announce := v_status IS DISTINCT FROM v_prev
                AND (v_status = 'critical' OR v_prev_raw IS NOT DISTINCT FROM v_status);
  v_new := CASE WHEN v_announce THEN v_status ELSE v_prev END;

  INSERT INTO platform_config (key, value) VALUES
    ('db_health_status', to_jsonb(v_new)),
    ('db_health_at',     to_jsonb(now()::text)),
    ('db_health_detail', to_jsonb(
        (v_h ->> 'db_size_mb') || ' MB · conn ' || (v_h ->> 'conn_used') || '/' || (v_h ->> 'conn_max')
        || COALESCE(' · ' || (v_h ->> 'growth_mb_per_day') || ' MB/día', '')
        || COALESCE(' · ' || (v_h ->> 'days_to_warn') || ' días al umbral', '')
        || CASE WHEN v_status IS DISTINCT FROM v_new
                THEN ' · sin confirmar: ' || CASE v_status WHEN 'critical' THEN 'en riesgo'
                                                           WHEN 'warn'     THEN 'atención'
                                                           ELSE                 'normal' END
                ELSE '' END))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- Solo en TRANSICIÓN: un problema que dura una semana manda 1 correo, no 168.
  IF v_announce THEN
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

  RETURN v_h || jsonb_build_object('previous_status', v_prev, 'previous_sample_status', v_prev_raw,
                                   'announced_status', v_new, 'emails_sent', v_sent);
END;
$new$);

-- Pasted from Windows, the SQL Editor puts carriage returns (chr(13)) inside the function bodies:
-- recreate them without those.
DO $crlf$
DECLARE
  v_fn regprocedure;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public._db_health_counts_connection(text,text,timestamptz,timestamptz)',
    'public.sample_database_health()', 'public.check_database_health()'
  ]::regprocedure[] LOOP
    SELECT pg_get_functiondef(v_fn) INTO v_def;
    IF position(chr(13) IN v_def) > 0 THEN
      EXECUTE replace(v_def, chr(13), '');
    END IF;
  END LOOP;
END
$crlf$;

-- ── Checks ──────────────────────────────────────────────────
DO $check$
DECLARE
  v_row     record;
  v_usable  int := current_setting('max_connections')::int
                   - current_setting('superuser_reserved_connections')::int
                   - COALESCE(NULLIF(current_setting('reserved_connections', true), ''), '0')::int;
  v_hidden  int;
  v_clients int;
  v_used    int;
  v_max     int;
  v_status  text;
BEGIN
  -- The three bodies: this file's (md5 of prosrc, no carriage return), still SECURITY DEFINER where
  -- they were, with prod's grants.
  FOR v_row IN
    SELECT f.fn, f.want, f.secdef, md5(p.prosrc) AS got, position(chr(13) IN p.prosrc) > 0 AS has_cr,
           p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
      FROM (VALUES
        ('public._db_health_counts_connection(text,text,timestamptz,timestamptz)', '7f3aab85a0984e7c3a674629ca5e23e2', false),
        ('public.sample_database_health()', '79de4691d0fe0571b53d992a76ef785a', true),
        ('public.check_database_health()', '03278947b5eb362d80eb99a118bbbce8', true)
      ) AS f(fn, want, secdef)
      JOIN pg_proc p ON p.oid = f.fn::regprocedure
  LOOP
    IF v_row.got IS DISTINCT FROM v_row.want OR v_row.has_cr THEN
      RAISE EXCEPTION '00690 check: % has md5 %, expected %', v_row.fn, v_row.got, v_row.want;
    END IF;
    IF v_row.prosecdef IS DISTINCT FROM v_row.secdef THEN
      RAISE EXCEPTION '00690 check: % has the wrong SECURITY DEFINER', v_row.fn;
    END IF;
    IF v_row.anon_x OR v_row.auth_x OR NOT v_row.svc_x THEN
      RAISE EXCEPTION '00690 check: % has the wrong grants', v_row.fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.db_health_samples'::regclass AND conname = 'db_health_samples_status_chk') THEN
    RAISE EXCEPTION '00690 check: db_health_samples.status is missing its check';
  END IF;

  -- The rule needs the owner to see every session's backend_type (pg_read_all_stats, as in prod).
  SELECT count(*) FILTER (WHERE backend_type IS NULL),
         count(*) FILTER (WHERE backend_type = 'client backend')
    INTO v_hidden, v_clients
    FROM pg_stat_activity;
  IF v_hidden > 0 THEN
    RAISE EXCEPTION '00690 check: % sessions hide their backend_type from %', v_hidden, current_user;
  END IF;

  -- A sample, undone: it counts at most the client backends, out of the slots a client gets.
  BEGIN
    PERFORM public.sample_database_health();
    SELECT conn_used, conn_max, status INTO v_used, v_max, v_status
      FROM public.db_health_samples WHERE sampled_at = date_trunc('hour', now());
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN
    NULL;
  END;
  IF v_max IS DISTINCT FROM v_usable OR v_used IS NULL OR v_used < 1 OR v_used > v_clients
     OR v_status IS NOT NULL THEN
    RAISE EXCEPTION '00690 check: a sample counted %/% (client backends %, slots %, status %)',
      v_used, v_max, v_clients, v_usable, v_status;
  END IF;
END
$check$;

RESET lock_timeout;
