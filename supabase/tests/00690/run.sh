#!/usr/bin/env bash
# Rehearsal runner for migration 00690 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00690/run.sh none
#       -> scaffold + tests on the live prod bodies (RED: the sampler counts background processes
#          and the pg_cron burst against max_connections, and one reading e-mails the team)
#   supabase/tests/00690/run.sh supabase/migrations/00690_db_health_count_real_connections.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the migration's own
#          guards and checks (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# The C tests open real sessions (application_name pg_cron and zz-api) and wait until the pg_cron
# ones are 61 s old, so the suite takes a bit over a minute.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest,
# port 5433). The cluster needs max_connections = 60 and superuser_reserved_connections = 3, as prod
# (the slots a client gets: 57).
# Other clusters: PGBIN=<dir with psql, no spaces> PGPORT=<port> PYTHON=<python> supabase/tests/00690/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr690
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# txn SQL -> SQL inside a transaction that is always rolled back; besides the rows, only errors are printed
txn(){ printf "BEGIN; SET LOCAL client_min_messages = error; %s ROLLBACK;" "$1"; }
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# expect_err NAME DBNAME FILE PATTERN -> applying FILE must fail with an ERROR matching PATTERN
expect_err(){ local r; r=$(apply_err "$2" "$3"); if echo "$r" | grep -q -- "$4"; then ok "$1"; else ko "$1" "expected an error like [$4], got [$r]"; fi; }

FNS="'_db_health_counts_connection','sample_database_health','check_database_health'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"
NEW="_db_health_counts_connection:7f3aab85a0984e7c3a674629ca5e23e2,check_database_health:03278947b5eb362d80eb99a118bbbce8,sample_database_health:79de4691d0fe0571b53d992a76ef785a"

# Forces the status of the sample check_database_health is about to take (only the connections rule
# is in play: the cache rule is off, and the size thresholds are far above the test database).
RAW_OK="UPDATE public.platform_config SET value = '1000' WHERE key IN ('db_conn_warn_pct', 'db_conn_crit_pct');
        UPDATE public.platform_config SET value = '0' WHERE key = 'db_cache_hit_warn_pct';"
RAW_WARN="UPDATE public.platform_config SET value = '0' WHERE key = 'db_conn_warn_pct';
          UPDATE public.platform_config SET value = '1000' WHERE key = 'db_conn_crit_pct';
          UPDATE public.platform_config SET value = '0' WHERE key = 'db_cache_hit_warn_pct';"
RAW_CRIT="UPDATE public.platform_config SET value = '0' WHERE key IN ('db_conn_warn_pct', 'db_conn_crit_pct');
          UPDATE public.platform_config SET value = '0' WHERE key = 'db_cache_hit_warn_pct';"
told(){ echo "UPDATE public.platform_config SET value = to_jsonb('$1'::text) WHERE key = 'db_health_status';"; }
# prev STATUS -> the sample of the previous hour, evaluated to STATUS (SQL NULL: a sample from before 00690)
prev(){ echo "INSERT INTO public.db_health_samples (sampled_at, db_size_bytes, conn_used, conn_max, status)
              VALUES (date_trunc('hour', now()) - interval '1 hour', pg_database_size(current_database()), 1, 57, $1);"; }
# One run: the e-mails it sent, then (its own statement, so it sees the run's write) the status the team was told.
RUN="SELECT public.check_database_health() ->> 'emails_sent';
     SELECT value #>> '{}' FROM public.platform_config WHERE key = 'db_health_status';"
SUBJ="SELECT COALESCE(string_agg(DISTINCT body ->> 'subject', '|'), '-') FROM net.zz_requests;"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the 8 live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname <> 'get_service_role_key'" \
  "_db_health_html:9488dabfba2c0bfa77317711a8db778b/3634,check_database_health:9b430de3b750510e0079ea5b122f110f/1720,cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab/626,evaluate_database_health:08c3bedbfe9695d9591735538c945e7e/4390,get_platform_config_numeric:13d2587037eca74854cf2394ba42a90c/479,sample_database_health:a783d40d937aa44aba84f1ba31e819fe/2284,send_db_health_digest:56da1c243a370de9cdfd077870069ada/857,send_db_health_email:1358c35561353f2bb514e3da6614e363/1494"
val "S1 like prod: postgres owns them all, is not a superuser and reads all stats; 60 connections, 3 reserved" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
          || '|' || pg_has_role('postgres', 'pg_read_all_stats', 'USAGE') || '|' || current_setting('max_connections')
          || '|' || current_setting('superuser_reserved_connections') || '|' || current_setting('reserved_connections')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace" "postgres|false|true|60|3|0"

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== what the bodies are =="
val "B1 the three bodies are 00690's" "$BODIES" "$NEW"
val "B2 evaluate_database_health, the e-mail, the HTML and the digest are untouched" \
  "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('evaluate_database_health','send_db_health_email','_db_health_html','send_db_health_digest')" \
  "_db_health_html:9488dabfba2c0bfa77317711a8db778b,evaluate_database_health:08c3bedbfe9695d9591735538c945e7e,send_db_health_digest:56da1c243a370de9cdfd077870069ada,send_db_health_email:1358c35561353f2bb514e3da6614e363"
val "B3 db_health_samples.status, checked to ok/warn/critical" \
  "SELECT data_type || '|' || (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'db_health_samples_status_chk')
   FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'db_health_samples' AND column_name = 'status'" \
  "text|CHECK ((status = ANY (ARRAY['ok'::text, 'warn'::text, 'critical'::text])))"
val "B4 no client role can execute the three; service_role can; no EXCEPTION handler (00640)" \
  "SELECT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) || ',' || bool_or(has_function_privilege('authenticated', oid, 'EXECUTE'))
          || ',' || bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) || ',' || bool_or(prosrc ~* 'exception\s+when')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)" "false,false,true,false"

echo "== what counts as a connection =="
val "C1 a client backend counts; a pg_cron job younger than 60 s and background processes do not; unknown ones count" \
  "SELECT string_agg(r::text, ',' ORDER BY i) FROM (VALUES
     (1, public._db_health_counts_connection('client backend', 'zz-api', now() - interval '1 hour', now())),
     (2, public._db_health_counts_connection('client backend', 'pg_cron', now() - interval '1 second', now())),
     (3, public._db_health_counts_connection('client backend', 'pg_cron', now() - interval '61 seconds', now())),
     (4, public._db_health_counts_connection('client backend', NULL, now(), now())),
     (5, public._db_health_counts_connection('client backend', 'pg_cron', NULL, now())),
     (6, public._db_health_counts_connection('checkpointer', NULL, now() - interval '1 day', now())),
     (7, public._db_health_counts_connection('walsender', 'pg_cron', now(), now())),
     (8, public._db_health_counts_connection('pg_cron launcher', NULL, now() - interval '1 day', now())),
     (9, public._db_health_counts_connection(NULL, 'zz-hidden', NULL, now()))) t(i, r)" \
  "true,false,true,true,true,false,false,false,true"

# Real sessions: 3 that look like pg_cron jobs and 2 like an API pool.
for a in pg_cron pg_cron pg_cron zz-api zz-api; do
  PGAPPNAME=$a $BIN/psql $CONN -d $DB -qAt -c "SELECT pg_sleep(180)" >/dev/null 2>&1 &
done
for i in $(seq 1 40); do
  n=$($P -c "SELECT count(*) FROM pg_stat_activity WHERE application_name IN ('pg_cron', 'zz-api') AND state = 'active'" 2>/dev/null | tr -d '\r')
  [ "$n" = "5" ] && break; $P -c "SELECT pg_sleep(0.25)" >/dev/null
done
SAMPLE="SELECT public.sample_database_health() IS NOT NULL;
        SELECT (s.conn_used - c.n) || '/' || s.conn_max FROM public.db_health_samples s,
               (SELECT count(*) AS n FROM pg_stat_activity WHERE backend_type = 'client backend') c
         WHERE s.sampled_at = date_trunc('hour', now());"
val "C2 a sample leaves out the 3 fresh pg_cron sessions and counts the rest out of 57 slots" "$(txn "$SAMPLE")" "t;-3/57"

echo "== when the team is told =="
val "D1 one reading over the threshold, with no previous sample: nothing sent, the team still told ok" \
  "$(txn "$RAW_WARN $RUN $SUBJ")" "0;ok;-"
val "D2 two readings in a row over the threshold: 'atención' to the 2 recipients" \
  "$(txn "$RAW_WARN $(prev "'warn'") $RUN $SUBJ")" "2;warn;[TriciGo] Base de datos: atención"
val "D3 told warn, one reading back under it: nothing sent, still warn" \
  "$(txn "$RAW_OK $(told warn) $(prev "'warn'") $RUN $SUBJ")" "0;warn;-"
val "D4 told warn, two readings in a row back under it: 'normalizada'" \
  "$(txn "$RAW_OK $(told warn) $(prev "'ok'") $RUN $SUBJ")" "2;ok;[TriciGo] Base de datos: normalizada"
val "D5 one reading into critical, from ok: e-mailed at once" \
  "$(txn "$RAW_CRIT $RUN $SUBJ")" "2;critical;[TriciGo] BASE DE DATOS EN RIESGO"
val "D6 told critical, one reading back to warn: nothing sent, still critical" \
  "$(txn "$RAW_WARN $(told critical) $(prev "'critical'") $RUN $SUBJ")" "0;critical;-"
val "D7 told critical, two readings in a row at warn: 'atención'" \
  "$(txn "$RAW_WARN $(told critical) $(prev "'warn'") $RUN $SUBJ")" "2;warn;[TriciGo] Base de datos: atención"
val "D8 told warn, still warn: nothing sent" \
  "$(txn "$RAW_WARN $(told warn) $(prev "'warn'") $RUN $SUBJ")" "0;warn;-"
val "D9 the sample keeps its status, the previous one is left alone" \
  "$(txn "$RAW_WARN $(prev "'ok'") $RUN SELECT string_agg(COALESCE(status, 'NULL'), ',' ORDER BY sampled_at) FROM public.db_health_samples;")" \
  "0;ok;ok,warn"
val "D10 running it twice in the same hour is one sample: nothing sent" \
  "$(txn "$RAW_WARN $RUN $RUN $SUBJ")" "0;ok;0;ok;-"
val "D11 no db_health_status yet and the database is fine: nothing sent (the old body sent 'normalizada')" \
  "$(txn "$RAW_OK DELETE FROM public.platform_config WHERE key = 'db_health_status'; $RUN $SUBJ")" "0;ok;-"
val "D12 the previous sample is from before 00690 (status NULL): nothing sent" \
  "$(txn "$RAW_WARN $(prev NULL) $RUN $SUBJ")" "0;ok;-"
val "D13 the daily digest still goes out, and does not change what the team was told" \
  "$(txn "$RAW_WARN SELECT (public.send_db_health_digest() ->> 'emails_sent') || ',' || (SELECT value #>> '{}' FROM public.platform_config WHERE key = 'db_health_status');
          SELECT bool_and(body ->> 'subject' LIKE U&'[TriciGo] Estado diario de la base \2014 % MB') FROM net.zz_requests;")" \
  "2,ok;t"
val "D14 the pending change shows in db_health_detail" \
  "$(txn "$RAW_WARN $RUN SELECT value #>> '{}' LIKE U&'% \00B7 sin confirmar: atenci\00F3n' FROM public.platform_config WHERE key = 'db_health_detail';")" \
  "0;ok;t"

echo "== a pg_cron session alive over a minute is stuck, and holds its slot =="
for i in $(seq 1 300); do
  n=$($P -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_cron' AND backend_start < clock_timestamp() - interval '61 seconds'" 2>/dev/null | tr -d '\r')
  [ "$n" = "3" ] && break; $P -c "SELECT pg_sleep(0.5)" >/dev/null
done
val "C3 61 s later the same 3 pg_cron sessions count" "$(txn "$SAMPLE")" "t;0/57"
$P -c "SELECT count(pg_terminate_backend(pid)) >= 0 FROM pg_stat_activity WHERE application_name IN ('pg_cron', 'zz-api')" >/dev/null 2>&1

if [ "$MIG" != "none" ]; then
  echo "== negative proofs of the migration's guards and checks =="
  T=pr690n
  fresh $T
  $BIN/psql $CONN -d $T -qAt -c "$AS_OWNER" -c "CREATE OR REPLACE FUNCTION public.sample_database_health() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN '{}'::jsonb; END; \$f\$" >/dev/null
  expect_err "N1 an unknown sample_database_health body stops it" $T "$MIG" "00690: public.sample_database_health() has an unknown body"
  fresh $T
  $BIN/psql $CONN -d $T -qAt -c "$AS_OWNER" -c "CREATE OR REPLACE FUNCTION public.check_database_health() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN '{}'::jsonb; END; \$f\$" >/dev/null
  expect_err "N2 an unknown check_database_health body stops it" $T "$MIG" "00690: public.check_database_health() has an unknown body"
  fresh $T
  $BIN/psql $CONN -d $T -qAt -c "GRANT EXECUTE ON FUNCTION public.sample_database_health() TO anon" >/dev/null
  expect_err "N3 a sampler a client can run stops it" $T "$MIG" "00690 check: public.sample_database_health() has the wrong grants"
  fresh $T
  $BIN/psql $CONN -d postgres -qAt -c "REVOKE pg_read_all_stats FROM postgres" >/dev/null
  expect_err "N4 an owner that cannot see every session's backend_type stops it" $T "$MIG" "sessions hide their backend_type from postgres"
  $BIN/psql $CONN -d postgres -qAt -c "GRANT pg_read_all_stats TO postgres" >/dev/null
  fresh $T
  CR="$(dirname "$MIG")/../../.00690-crlf.sql"
  "$PY" -c "import sys; d=open(sys.argv[1],'rb').read().replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'); open(sys.argv[2],'wb').write(d)" "$MIG" "$CR"
  r=$(apply_err $T "$CR"); rm -f "$CR"
  if [ "$r" = "applied" ]; then
    r=$($BIN/psql $CONN -d $T -qAt -c "$BODIES" | tr -d '\r')
    [ "$r" = "$NEW" ] && ok "N5 a copy with CRLF line ends gives the same bodies" || ko "N5" "bodies [$r]"
  else ko "N5 a copy with CRLF line ends gives the same bodies" "$r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $T WITH (FORCE)" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
