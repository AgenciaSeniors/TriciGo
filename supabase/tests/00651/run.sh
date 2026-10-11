#!/usr/bin/env bash
# Rehearsal runner for migration 00651 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00651/run.sh none
#       -> scaffold + tests on the live prod body (RED: notify_ops_workflow_failure
#          sends through a raw net.http_post, so a rejected alert leaves no row in
#          cron_http_calls and check_cron_http_failures never sees it)
#   supabase/tests/00651/run.sh supabase/migrations/00651_ops_workflow_alert_through_cron_http_post.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the
#          migration's own guards and self-checks (GREEN)
# The scaffold is supabase/tests/00640/scaffold.sql + migrations 00640 and 00647 +
# supabase/tests/00651/scaffold.sql (notify_ops_workflow_failure), which is what prod
# runs since 2026-10-08: S0 checks the bodies against the md5 read from prod. The
# migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00651/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
SCAFFOLD="$DIR/../00640/scaffold.sql"
M640="$DIR/../../migrations/00640_cron_errors_reach_watchdog.sql"
M647="$DIR/../../migrations/00647_watchdog_alerts_through_cron_http_post.sql"
ADDON="$DIR/scaffold.sql"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr651
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q SQL -> the printed rows joined with ';' (psql on Windows ends its lines with \r\n: the \r is dropped)
q(){ $P -c "$1" 2>&1 | tr -d '\r' | paste -sd';' -; }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(q "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# txn SQL -> SQL inside a transaction that is always rolled back; besides the rows, only errors are printed
txn(){ printf "BEGIN; SET LOCAL client_min_messages = error; %s ROLLBACK;" "$1"; }
# fresh DBNAME -> a new database with prod's state (scaffold, 00640, 00647, the addon) and the test helpers
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$SCAFFOLD" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M640" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M647" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$ADDON" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL'
-- Requests queued through cron_http_post with a label: count|timeout|url path|recipients (in queue order).
CREATE FUNCTION t.calls(p_label text) RETURNS text LANGUAGE sql AS $$
  SELECT count(*) || '|' || COALESCE(string_agg(DISTINCT q.timeout_milliseconds::text, ' '), '-')
         || '|' || COALESCE(string_agg(DISTINCT replace(q.url, 'https://lqaufszburqvlslpcuac.supabase.co', ''), ' '), '-')
         || '|' || COALESCE(string_agg(convert_from(q.body, 'UTF8')::jsonb ->> 'recipient_email', ',' ORDER BY q.id), '-')
  FROM public.cron_http_calls c JOIN net.http_request_queue q ON q.id = c.request_id
  WHERE c.jobname = p_label
$$;
-- Requests that went out without a cron_http_calls row: invisible to check_cron_http_failures.
CREATE FUNCTION t.untracked() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM net.http_request_queue q
  WHERE NOT EXISTS (SELECT 1 FROM public.cron_http_calls c WHERE c.request_id = q.id)
$$;
-- send-email answers every queued request with p_status, and the calls age 5 minutes
-- (check_cron_http_failures skips the last 2 minutes, while pg_net may still be waiting).
CREATE FUNCTION t.answer_all(p_status int) RETURNS bigint LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO net._http_response (id, status_code, content)
    SELECT q.id, p_status,
           CASE WHEN p_status >= 300 THEN '{"success":false,"error":"send_failed"}' ELSE '{"success":true}' END
    FROM net.http_request_queue q
    WHERE NOT EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = q.id)
    RETURNING 1),
  aged AS (UPDATE public.cron_http_calls SET called_at = called_at - interval '5 minutes' RETURNING 1)
  SELECT (SELECT count(*) FROM ins) + 0 * (SELECT count(*) FROM aged)
$$;
SQL
}
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

FN="public.notify_ops_workflow_failure(text,text,text)"
BODY="SELECT md5(prosrc) FROM pg_proc WHERE oid = '$FN'::regprocedure"
# The live body with 'PERFORM net.http_post(' -> "PERFORM public.cron_http_post('ops-workflow-alert',"
# (computed apart, in Python, from the body read from prod).
NEW="e0951f901595cd556c019a65fd316a57"
OTHERS="SELECT md5(string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname)) || '/' || count(*) FROM pg_proc
        WHERE pronamespace IN ('public'::regnamespace, 'cron'::regnamespace, 'net'::regnamespace) AND proname <> 'notify_ops_workflow_failure'"
META="SELECT pg_get_userbyid(proowner) || ':' || prosecdef || ':' || COALESCE(proconfig::text, '-') || ':' || COALESCE(proacl::text, '-')
        || ':' || pg_get_function_arguments(oid) || ':' || pg_get_function_result(oid) FROM pg_proc WHERE oid = '$FN'::regprocedure"
JOBS="SELECT count(*) || ',' || md5(string_agg(jobname || '|' || schedule || '|' || command || '|' || username, E'\n' ORDER BY jobname)) FROM cron.job"
RCPT="ops@example.test,dev@example.test"
SEND_EMAIL="/functions/v1/send-email"
# The call the GitHub workflows make (sync-pois.yml, sync-osm-delta.yml), through PostgREST with the service key.
CALL="public.notify_ops_workflow_failure('sync-pois.yml (POI sync semanal)', 'https://github.com/AgenciaSeniors/TriciGo/actions/runs/1', 'step 3 <failed>')"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
# S0 is a precondition (it passes before and after): the scaffold is what prod runs.
val "S0 notify_ops_workflow_failure, check_cron_http_failures and cron_http_post are prod's (md5/length of prosrc, md5 of pg_get_functiondef)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc) || ':' || md5(pg_get_functiondef(oid)), ',' ORDER BY proname)
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('notify_ops_workflow_failure', 'check_cron_http_failures', 'cron_http_post')" \
  "check_cron_http_failures:2afcc2be8700867913f7a6c00c73bc22/6448:8faa2148990818bee8958837796342fe,cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab/626:6db1e8de055f53d93199080dad052b62,notify_ops_workflow_failure:c8b27cf11345251e309c561b77516506/4719:179ef68dbd340744cf744d3a122047e8"
OTHERS0=$(q "$OTHERS"); META0=$(q "$META"); JOBS0=$(q "$JOBS")

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== what the body is =="
val "B1 the body is the live one with the e-mail call going through cron_http_post" "$BODY" "$NEW"
val "B2 no raw net.http_post is left; it calls cron_http_post once, with its label" \
  "SELECT (SELECT count(*) FROM regexp_matches(prosrc, 'net\.http_post\s*\(', 'g')) || '/'
          || COALESCE((SELECT string_agg(m[1], '+') FROM regexp_matches(prosrc, 'public\.cron_http_post\(''([a-z-]+)'',', 'g') AS m), '-')
   FROM pg_proc WHERE oid = '$FN'::regprocedure" "0/ops-workflow-alert"
# B3-B6 are controls (they pass before and after): the migration changes nothing else.
val "B3 every other function (public, cron, net) is untouched" "$OTHERS" "$OTHERS0"
val "B4 owner, SECURITY DEFINER, search_path, grants, arguments and result are unchanged" "$META" "$META0"
val "B5 the cron jobs are untouched" "$JOBS" "$JOBS0"
val "B6 anon and authenticated cannot execute it; service_role can" \
  "SELECT has_function_privilege('anon', '$FN', 'EXECUTE') || ',' || has_function_privilege('authenticated', '$FN', 'EXECUTE')
          || ',' || has_function_privilege('service_role', '$FN', 'EXECUTE')" "false,false,true"

echo "== the alert goes out through cron_http_post, labeled, with a 30 s timeout =="
# RED: the alert is sent ("true|2"), but no request is labeled and both go out untracked ("0|-|-|-;2").
val "H1 a failed workflow: one labeled request per address, none untracked" \
  "$(txn "SELECT r ->> 'ok' || '|' || (r ->> 'emails_sent') FROM (SELECT $CALL AS r) x;
          SELECT t.calls('ops-workflow-alert'); SELECT t.untracked();")" \
  "true|2;2|30000|$SEND_EMAIL|$RCPT;0"
# Controls (the same before and after): the cooldown and what goes to send-email do not change.
val "H2 a second failure inside the 6 h cooldown sends nothing" \
  "$(txn "SELECT count(*) FROM (SELECT $CALL) x;
          SELECT r ->> 'skipped' || '|' || (r ->> 'emails_sent') FROM (SELECT $CALL AS r) x;
          SELECT count(*) FROM net.http_request_queue;")" \
  "1;cooldown|0;2"
val "H3 the request body and headers keep their keys, subject and escaping" \
  "$(txn "SELECT count(*) FROM (SELECT $CALL) x;
          SELECT count(*) || ':' || string_agg(DISTINCT
                   (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(convert_from(body, 'UTF8')::jsonb) AS k) || '|' ||
                   (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(headers) AS k), ';')
          FROM net.http_request_queue;
          SELECT DISTINCT (convert_from(body, 'UTF8')::jsonb ->> 'subject') || '|'
                 || (position('step 3 &lt;failed&gt;' IN convert_from(body, 'UTF8')::jsonb ->> 'template') > 0)
          FROM net.http_request_queue;")" \
  "1;2:data,recipient_email,subject,template|Authorization,Content-Type,apikey;[TriciGo] Workflow en rojo: sync-pois.yml (POI sync semanal)|true"

echo "== a rejected alert now reaches check_cron_http_failures =="
# RED: the alert is not in cron_http_calls, so the review says "ok" and the alert path stays silent.
val "E1 send-email rejecting the alert: the next review reports ops-workflow-alert" \
  "$(txn "SELECT count(*) FROM (SELECT $CALL) x; SELECT t.answer_all(500);
          SELECT r ->> 'status' || '|' || (r ->> 'failing') || '|' || (r ->> 'detail') FROM (SELECT public.check_cron_http_failures() AS r) x;
          SELECT value #>> '{}' FROM public.platform_config WHERE key = 'cron_http_health_status';")" \
  "1;2;failing|ops-workflow-alert|ops-workflow-alert (2x 500);failing"
# E2 (control): send-email accepting the alert is not a failure.
val "E2 send-email accepting the alert: the review stays ok" \
  "$(txn "SELECT count(*) FROM (SELECT $CALL) x; SELECT t.answer_all(200);
          SELECT r ->> 'status' || '|' || (r ->> 'failing') FROM (SELECT public.check_cron_http_failures() AS r) x;")" \
  "1;2;ok|"

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
  # G0: the same file with CRLF line endings (pasted from Windows) patches the same body.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql")
  b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODY" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$NEW" ] && ok "G0 with CRLF line endings the migration patches the same body" || ko "G0 with CRLF line endings the migration patches the same body" "$r / $b"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('$FN'::regprocedure),
      'v_sent := v_sent + 1;', 'v_sent := v_sent + 1; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: notify_ops_workflow_failure has a body this migration does not know" && ok "G1 a body that drifted from prod aborts the migration" || ko "G1 a body that drifted from prod aborts the migration" "$r"

  sabotage g2 "IF v_md5 = c_md5_new THEN" "IF v_md5 = c_md5_live THEN"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "00651: notify_ops_workflow_failure still sends through a raw net.http_post" && ok "G2 a function left unpatched aborts the migration" || ko "G2 a function left unpatched aborts the migration" "$r"

  sabotage g3 "c_md5_new  constant text := 'e0951f901595cd556c019a65fd316a57';" "c_md5_new  constant text := '00000000000000000000000000000000';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "00651: notify_ops_workflow_failure was patched to md5 e0951f901595cd556c019a65fd316a57, expected 00000000000000000000000000000000" && ok "G3 a patch that does not produce the expected body aborts the migration" || ko "G3 a patch that does not produce the expected body aborts the migration" "$r"

  # G4: cron_http_post sends but its bookkeeping row disappears: the probe sees no labeled call.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.cron_http_post(text,text,jsonb,jsonb,integer)'::regprocedure),
      'ON CONFLICT (request_id) DO NOTHING;', 'ON CONFLICT (request_id) DO NOTHING; DELETE FROM public.cron_http_calls WHERE request_id = v_id;'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: probe failed" && ok "G4 an alert that does not land in cron_http_calls aborts the migration" || ko "G4 an alert that does not land in cron_http_calls aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "DROP FUNCTION public.cron_http_post(text,text,jsonb,jsonb,integer)" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: public.cron_http_post(text,text,jsonb,jsonb,integer) is missing" && ok "G5 a missing cron_http_post aborts the migration" || ko "G5 a missing cron_http_post aborts the migration" "$r"

  # G6: the label assertion can fail (here it expects a label the patch does not write).
  sabotage g6 "c_expected constant text := 'ops-workflow-alert';" "c_expected constant text := 'ops-alert';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g6.sql")
  echo "$r" | grep -q "00651: notify_ops_workflow_failure must call public.cron_http_post once, with label ops-alert" && ok "G6 a function without its label aborts the migration" || ko "G6 a function without its label aborts the migration" "$r"

  # G7: the alert is labeled but goes out with net.http_post's 5 s timeout: the probe catches it.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.cron_http_post(text,text,jsonb,jsonb,integer)'::regprocedure),
      'timeout_milliseconds := v_timeout', 'timeout_milliseconds := 5000'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: probe failed, .*ops-workflow-alert:5000:" && ok "G7 an alert with a 5 s timeout aborts the migration" || ko "G7 an alert with a 5 s timeout aborts the migration" "$r"

  # G8: the function swallows its own errors (outer EXCEPTION handler): a failure inside it
  # must still abort the migration, through the probe's check of its result.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE plpgsql STABLE
    AS \$f\$ BEGIN RAISE EXCEPTION 'vault unavailable'; END \$f\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: probe failed, the function returned .*vault unavailable" && ok "G8 an error the function swallows still aborts the migration" || ko "G8 an error the function swallows still aborts the migration" "$r"

  # G9: a client role that can execute the function aborts the migration.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "GRANT EXECUTE ON FUNCTION $FN TO anon" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00651: notify_ops_workflow_failure grants changed" && ok "G9 a function a client role can execute aborts the migration" || ko "G9 a function a client role can execute aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
