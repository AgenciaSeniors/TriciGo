#!/usr/bin/env bash
# Rehearsal runner for migration 00640 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00640/run.sh none
#       -> scaffold + tests on the live prod bodies (RED: an error inside the
#          watchdogs, the prune jobs and the dead-driver e-mail leaves the cron
#          run "succeeded", so check_cron_sql_failures never reports it)
#   supabase/tests/00640/run.sh supabase/migrations/00640_cron_errors_reach_watchdog.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the
#          migration's own guards and self-checks (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00640/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr640
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
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

FNS="'check_cron_http_failures','check_database_health','check_exchange_rate_freshness','check_poi_sync_freshness',
     'check_sms_delivery_health','check_sms_delivery_rate','check_stuck_active_rides','notify_dead_driver_alert',
     'prune_audit_log','prune_cron_job_run_details','prune_driver_heartbeat_log','release_rides_from_dead_drivers',
     'sample_database_health','send_db_health_digest'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"
# The 14 live bodies minus the handler (or, for release_rides_from_dead_drivers, minus the e-mail call).
NEW="check_cron_http_failures:3bcacc073b307c74b8ef7e137865de32,check_database_health:9b430de3b750510e0079ea5b122f110f,check_exchange_rate_freshness:658b8be4592ab74821ee0df845579437,check_poi_sync_freshness:c9434e9e1c75a6504f84de2074369a88,check_sms_delivery_health:bf6f70fa0eccf6204f901585a6231ff3,check_sms_delivery_rate:b4a1e7798ef2ad6b78c2722591b2137a,check_stuck_active_rides:8478bba2e479523f4d52855adf7454ca,notify_dead_driver_alert:aa6a768cbd67d7b2cd7bfa4e135875f3,prune_audit_log:31047360d4acebcd77df5ac5f8466829,prune_cron_job_run_details:d36caf9ff0b05e0dda2dc39bd7d49740,prune_driver_heartbeat_log:3d773de2f38ded589e5789be92577d5b,release_rides_from_dead_drivers:c99dd7b82a9cddaa2bf21a48d9bff7f7,sample_database_health:a783d40d937aa44aba84f1ba31e819fe,send_db_health_digest:56da1c243a370de9cdfd077870069ada"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the 20 live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname <> 'get_service_role_key'" \
  "_db_health_html:9488dabfba2c0bfa77317711a8db778b/3634,check_cron_http_failures:6b98f714dda196b1cbec8bb8ca5877b5/6576,check_database_health:5977319218fc36d3c304a010afd714aa/1879,check_exchange_rate_freshness:4516f6eaf875c82c19f55f59139f297a/7094,check_poi_sync_freshness:5eadc628202089e46b81c1c27335adec/6501,check_sms_delivery_health:4772591574069fa40d0207370ca5db4f/7562,check_sms_delivery_rate:f522e403e3c9c1f8a139b5958390538a/9723,check_stuck_active_rides:863c3bf93fa8f655c53bf01ef507a180/9344,cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab/626,cron_sql_failures_now:0557d22d014590c631e8d300d2651100/2078,evaluate_database_health:08c3bedbfe9695d9591735538c945e7e/4390,get_platform_config_numeric:13d2587037eca74854cf2394ba42a90c/479,notify_dead_driver_alert:53f5bdf95aa8c09ee6e856c9ca5fcf90/5128,prune_audit_log:b0dc29f0fe42cb2945a325189d378e47/1644,prune_cron_job_run_details:0f071ed728ee6d023d42c7233f9add3b/731,prune_driver_heartbeat_log:8265af3f0aad993b95b1a0d342087438/514,release_rides_from_dead_drivers:0e18ee0004fdc8f6735fc93d17520eab/4899,sample_database_health:ff5051ef8e16b0c5cda03e65208dec72/2444,send_db_health_digest:1aea42c6793f6b671595bffaf0270fa1/1016,send_db_health_email:4b9ed06fabc6d67a8f4666945fafd0a9/1468"
val "S1 like prod, postgres owns them all and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace" "postgres|false"

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== what the bodies are =="
val "B1 the 14 bodies are exactly the live ones minus the handler (release: minus the e-mail call)" "$BODIES" "$NEW"
val "B2 'EXCEPTION WHEN' left: only the per-ride e-mail (check_stuck_active_rides) and the rider push (release)" \
  "SELECT string_agg(proname || '=' || (SELECT count(*) FROM regexp_matches(prosrc, 'exception\s+when', 'gi')), ',' ORDER BY proname)
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)" \
  "check_cron_http_failures=0,check_database_health=0,check_exchange_rate_freshness=0,check_poi_sync_freshness=0,check_sms_delivery_health=0,check_sms_delivery_rate=0,check_stuck_active_rides=1,notify_dead_driver_alert=0,prune_audit_log=0,prune_cron_job_run_details=0,prune_driver_heartbeat_log=0,release_rides_from_dead_drivers=1,sample_database_health=0,send_db_health_digest=0"
val "B3 only its own job calls notify_dead_driver_alert, one minute after the release job" \
  "SELECT COALESCE((SELECT string_agg(proname, ',') FROM pg_proc WHERE pronamespace = 'public'::regnamespace
            AND proname <> 'notify_dead_driver_alert' AND prosrc ~ 'notify_dead_driver_alert\s*\('), '-') || '|' ||
          COALESCE((SELECT string_agg(jobname || ' ' || schedule || ' ' || command || ' ' || username, ',') FROM cron.job
            WHERE command ~ 'notify_dead_driver_alert'), '-')" \
  "-|notify-dead-driver-alert 1-59/5 * * * * SELECT public.notify_dead_driver_alert(); postgres"
val "B4 the other 12 jobs are untouched (schedule and command, md5 of the list)" \
  "SELECT count(*) || ',' || md5(string_agg(jobname || '|' || schedule || '|' || command, E'\n' ORDER BY jobname)) FROM cron.job
   WHERE jobname <> 'notify-dead-driver-alert'" "12,91d36295292392fccbb23b0f0999755e"
val "B5 anon and authenticated cannot execute any of the 14; service_role can" \
  "SELECT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) || ',' || bool_or(has_function_privilege('authenticated', oid, 'EXECUTE'))
          || ',' || bool_and(has_function_privilege('service_role', oid, 'EXECUTE'))
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)" "false,false,true"

echo "== normal runs still work =="
val "H1 the 12 prod jobs run and succeed, and none is reported" \
  "$(txn "SELECT t.run_job(j) FROM unnest(ARRAY['check-cron-http-failures','check-database-health','check-exchange-rate-freshness',
            'check-poi-sync-freshness','check-sms-delivery-health','check-sms-delivery-rate','check-stuck-rides','db-health-digest',
            'prune-audit-log','prune-cron-run-details','prune-driver-heartbeat-log','release-dead-driver-rides']) AS j;
          SELECT t.flagged() = '';")" \
  "$(printf 'succeeded: 1 row;%.0s' {1..12})t"
val "H2 the prune jobs delete what is past their retention (heartbeats 2, audit 1 + 1 telemetry, cron runs 2)" \
  "$(txn "SELECT (public.prune_driver_heartbeat_log() ->> 'deleted');
          SELECT a ->> 'deleted_retention' || ',' || (a ->> 'deleted_telemetry') FROM (SELECT public.prune_audit_log() AS a) x;
          SELECT (public.prune_cron_job_run_details() ->> 'deleted');")" "2;1,1;2"
val "H3 each watchdog reports its state (fx, poi, sms, sms delivery, cron http, db, digest, stuck)" \
  "$(txn "SELECT public.check_exchange_rate_freshness() ->> 'status'; SELECT public.check_poi_sync_freshness() ->> 'status';
          SELECT public.check_sms_delivery_health() ->> 'status'; SELECT public.check_sms_delivery_rate() ->> 'status';
          SELECT public.check_cron_http_failures() ->> 'status'; SELECT public.check_database_health() ->> 'status';
          SELECT public.send_db_health_digest() ->> 'ok'; SELECT public.check_stuck_active_rides() ->> 'ok';")" \
  "ok;ok;unknown;unknown;ok;ok;true;true"
val "H4 release_rides_from_dead_drivers releases the pre-pickup ride, flags the on-board one, pushes the rider" \
  "$(txn "SELECT public.release_rides_from_dead_drivers()::text;
          SELECT status || ',' || COALESCE(driver_id::text, 'null') FROM public.rides WHERE id = 'e0000000-0000-4000-8000-000000000001';
          SELECT is_online FROM public.driver_profiles WHERE id = 'd0000000-0000-4000-8000-000000000001';
          SELECT status FROM public.ride_offers; SELECT reason FROM public.stuck_ride_alerts;
          SELECT t.queued('dead-driver-ride-released');")" \
  '{"enabled": true, "flagged": 1, "released": 1};searching,null;f;expired;dead_driver_app;1'
# RED: the release run itself e-mails (2,true right after it) and there is no notify job.
val "H5 the dead-driver e-mail goes out from its own job, not from the release run" \
  "$(txn "SELECT t.run_job('release-dead-driver-rides');
          SELECT t.queued('dead-driver-alert') || ',' || (emailed_at IS NOT NULL) FROM public.stuck_ride_alerts;
          SELECT t.run_job('notify-dead-driver-alert');
          SELECT t.queued('dead-driver-alert') || ',' || (emailed_at IS NOT NULL) FROM public.stuck_ride_alerts;")" \
  "succeeded: 1 row;0,false;succeeded: 1 row;2,true"

echo "== an error inside a job fails the run and check_cron_sql_failures reports it (3 failed runs) =="
# fault NAME JOB SETUP ERROR -> SETUP breaks the job, the job runs 3 times; prints the runs and what the watchdog
# would report. RED: every run "succeeded: 1 row" and nothing is reported.
fault(){ local job="$2"
  val "$1" "$(txn "$3 SELECT t.run_job('$job'); SELECT t.run_job('$job'); SELECT split_part(t.run_job('$job'), ':', 1); SELECT '[' || t.flagged() || ']';")" \
    "failed: $4;failed: $4;failed;[$job]"; }
fault "F1 check-cron-http-failures"      check-cron-http-failures      "ALTER TABLE public.cron_http_calls RENAME TO gone;"   'ERROR:  relation "public.cron_http_calls" does not exist'
fault "F2 check-database-health"         check-database-health         "ALTER TABLE public.db_health_samples RENAME TO gone;" 'ERROR:  relation "db_health_samples" does not exist'
fault "F3 db-health-digest"              db-health-digest              "ALTER TABLE public.db_health_samples RENAME TO gone;" 'ERROR:  relation "db_health_samples" does not exist'
fault "F4 check-exchange-rate-freshness" check-exchange-rate-freshness "ALTER TABLE public.exchange_rates RENAME TO gone;"    'ERROR:  relation "exchange_rates" does not exist'
fault "F5 check-poi-sync-freshness"      check-poi-sync-freshness      "ALTER TABLE public.poi_sync_state RENAME TO gone;"    'ERROR:  relation "poi_sync_state" does not exist'
fault "F6 check-sms-delivery-health"     check-sms-delivery-health     "ALTER TABLE public.rate_limits RENAME TO gone;"       'ERROR:  relation "rate_limits" does not exist'
fault "F7 check-sms-delivery-rate"       check-sms-delivery-rate       "ALTER TABLE public.sms_deliveries RENAME TO gone;"    'ERROR:  relation "sms_deliveries" does not exist'
fault "F8 check-stuck-rides"             check-stuck-rides             "ALTER TABLE public.stuck_ride_alerts RENAME TO gone;" 'ERROR:  relation "stuck_ride_alerts" does not exist'
fault "F9 prune-audit-log"               prune-audit-log               "ALTER TABLE public.audit_log RENAME TO gone;"         'ERROR:  relation "audit_log" does not exist'
fault "F10 prune-cron-run-details (a retention that overflows)" prune-cron-run-details \
  "INSERT INTO public.platform_config (key, value) VALUES ('cron_run_details_retention_days', to_jsonb(2000000000));" 'ERROR:  timestamp out of range'
fault "F11 prune-driver-heartbeat-log"   prune-driver-heartbeat-log    "ALTER TABLE public.driver_heartbeat_log RENAME TO gone;" 'ERROR:  relation "driver_heartbeat_log" does not exist'
# RED: notify-dead-driver-alert does not exist yet, and the function itself returns {"ok": false}.
fault "F12 notify-dead-driver-alert"     notify-dead-driver-alert      "ALTER TABLE public.stuck_ride_alerts RENAME TO gone;" 'ERROR:  relation "stuck_ride_alerts" does not exist'

echo "== the two nested helpers =="
# RED: both return {"ok": false} and their caller throws the result away.
val "N0 sample_database_health and notify_dead_driver_alert raise instead of returning ok=false" \
  "$(txn "ALTER TABLE public.db_health_samples RENAME TO gone_s; ALTER TABLE public.stuck_ride_alerts RENAME TO gone_a;
          SELECT t.outcome('SELECT public.sample_database_health()'); SELECT t.outcome('SELECT public.notify_dead_driver_alert()');")" \
  'raised: relation "db_health_samples" does not exist;raised: relation "stuck_ride_alerts" does not exist'
# N1: sampling breaks (its DELETE overflows) while a 3-hour-old sample exists. RED: check_database_health
# evaluates the old sample, says "ok" and refreshes db_health_at, so it looks healthy ("succeeded: 1 row;t;t").
val "N1 broken sampling fails the run instead of reporting ok on a stale sample" \
  "$(txn "INSERT INTO public.db_health_samples (sampled_at, db_size_bytes, conn_used, conn_max)
            VALUES (date_trunc('hour', now()) - interval '3 hours', 9000000, 5, 60);
          INSERT INTO public.platform_config (key, value) VALUES
            ('db_health_status', to_jsonb('ok'::text)), ('db_health_at', to_jsonb('2026-01-01 00:00:00+00'::text)),
            ('db_health_sample_retention_days', to_jsonb(2000000000));
          SELECT t.run_job('check-database-health');
          SELECT (value #>> '{}') <> '2026-01-01 00:00:00+00' FROM public.platform_config WHERE key = 'db_health_at';
          SELECT max(sampled_at) < now() - interval '2 hours' FROM public.db_health_samples;")" \
  "failed: ERROR:  timestamp out of range;f;t"
# N2: the dead-driver e-mail cannot be sent (vault unreadable). The releases happen either way. RED: the
# release runs "succeed", the alert is never e-mailed, and nothing is reported.
val "N2 an e-mail failure does not undo the releases, and its own job reports it" \
  "$(txn "CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE plpgsql STABLE
            AS \$f\$ BEGIN RAISE EXCEPTION 'vault unavailable'; END \$f\$;
          SELECT t.run_job('release-dead-driver-rides'); SELECT t.run_job('release-dead-driver-rides'); SELECT t.run_job('release-dead-driver-rides');
          SELECT status FROM public.rides WHERE id = 'e0000000-0000-4000-8000-000000000001';
          SELECT t.run_job('notify-dead-driver-alert'); SELECT t.run_job('notify-dead-driver-alert'); SELECT t.run_job('notify-dead-driver-alert');
          SELECT '[' || t.flagged() || ']'; SELECT emailed_at IS NOT NULL FROM public.stuck_ride_alerts;")" \
  "succeeded: 1 row;succeeded: 1 row;succeeded: 1 row;searching;failed: ERROR:  vault unavailable;failed: ERROR:  vault unavailable;failed: ERROR:  vault unavailable;[notify-dead-driver-alert];f"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own guards and checks catch a broken result =="
  T=$(mktemp -d)
  # sabotage NAME OLD NEW -> a copy of the migration with OLD replaced by NEW (OLD must appear exactly once)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # G0: the same file with CRLF line endings (pasted from Windows) patches the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql")
  b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$NEW" ] && ok "G0 with CRLF line endings the migration patches the same 14 bodies" || ko "G0 with CRLF line endings the migration patches the same 14 bodies" "$r / $b"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.prune_audit_log()'::regprocedure),
      'GET DIAGNOSTICS v_old = ROW_COUNT;', 'GET DIAGNOSTICS v_old = ROW_COUNT; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "prune_audit_log() has a body this migration does not know" && ok "G1 a body that drifted from prod aborts the migration" || ko "G1 a body that drifted from prod aborts the migration" "$r"

  sabotage g2 "CONTINUE WHEN v_md5 = r.md5_new;" "CONTINUE WHEN v_md5 = r.md5_new OR r.fn = 'public.release_rides_from_dead_drivers()';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "notify_dead_driver_alert is still called from release_rides_from_dead_drivers" && ok "G2 a release that still calls the e-mail aborts the migration" || ko "G2 a release that still calls the e-mail aborts the migration" "$r"

  sabotage g3 "CONTINUE WHEN v_md5 = r.md5_new;" "CONTINUE WHEN v_md5 = r.md5_new OR r.fn = 'public.prune_audit_log()';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "still an EXCEPTION handler in prune_audit_log" && ok "G3 a function left with its handler aborts the migration" || ko "G3 a function left with its handler aborts the migration" "$r"

  sabotage g4 "SELECT cron.schedule('notify-dead-driver-alert', '1-59/5 * * * *', 'SELECT public.notify_dead_driver_alert();');" "-- schedule left out"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g4.sql")
  echo "$r" | grep -q "cron job notify-dead-driver-alert is missing" && ok "G4 a missing cron job aborts the migration" || ko "G4 a missing cron job aborts the migration" "$r"

  sabotage g5 "('driver_heartbeat_retention_days', to_jsonb(2000000000))" "('driver_heartbeat_retention_days', to_jsonb(30))"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g5.sql")
  echo "$r" | grep -q "probe failed (prune_driver_heartbeat_log returned" && ok "G5 a probe that does not make the function fail aborts the migration" || ko "G5 a probe that does not make the function fail aborts the migration" "$r"

  sabotage g6 "'8265af3f0aad993b95b1a0d342087438', '3d773de2f38ded589e5789be92577d5b'" "'8265af3f0aad993b95b1a0d342087438', '00000000000000000000000000000000'"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g6.sql")
  echo "$r" | grep -q "prune_driver_heartbeat_log() was patched to md5 3d773de2f38ded589e5789be92577d5b, expected 00000000000000000000000000000000" && ok "G6 a patch that does not produce the expected body aborts the migration" || ko "G6 a patch that does not produce the expected body aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
