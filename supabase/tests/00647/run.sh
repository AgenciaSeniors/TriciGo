#!/usr/bin/env bash
# Rehearsal runner for migration 00647 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00647/run.sh none
#       -> scaffold + tests on the live prod bodies (RED: the four watchdog e-mail
#          paths send through a raw net.http_post, so a rejected alert leaves no row
#          in cron_http_calls and check_cron_http_failures never sees it)
#   supabase/tests/00647/run.sh supabase/migrations/00647_watchdog_alerts_through_cron_http_post.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the
#          migration's own guards and self-checks (GREEN)
# The scaffold is supabase/tests/00640/scaffold.sql plus migration 00640, which is
# what prod runs since 2026-10-08: S0 checks the four bodies against the md5 read
# from prod (prosrc and pg_get_functiondef). The migration is applied as postgres,
# the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00647/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
SCAFFOLD="$DIR/../00640/scaffold.sql"
M640="$DIR/../../migrations/00640_cron_errors_reach_watchdog.sql"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr647
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
# fresh DBNAME -> a new database with the scaffold, migration 00640 (prod's state) and the test helpers
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$SCAFFOLD" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M640" >/dev/null 2>&1 || return 1
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

FOUR="'check_cron_http_failures','check_exchange_rate_freshness','check_poi_sync_freshness','send_db_health_email'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ($FOUR)"
# The four live bodies with 'PERFORM net.http_post(' -> "PERFORM public.cron_http_post('<label>',"
# (computed apart, in Python, from the bodies read from prod).
NEW="check_cron_http_failures:2afcc2be8700867913f7a6c00c73bc22,check_exchange_rate_freshness:fb984eeaf3c688c11d35b6e31b831914,check_poi_sync_freshness:fdd8db5c1cd35cb8f91dd65b2447cd67,send_db_health_email:1358c35561353f2bb514e3da6614e363"
OTHERS="SELECT md5(string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname)) || '/' || count(*) FROM pg_proc
        WHERE pronamespace IN ('public'::regnamespace, 'cron'::regnamespace, 'net'::regnamespace) AND proname NOT IN ($FOUR)"
META="SELECT string_agg(proname || ':' || pg_get_userbyid(proowner) || ':' || prosecdef || ':' || COALESCE(proconfig::text, '-')
        || ':' || COALESCE(proacl::text, '-'), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ($FOUR)"
JOBS="SELECT count(*) || ',' || md5(string_agg(jobname || '|' || schedule || '|' || command || '|' || username, E'\n' ORDER BY jobname)) FROM cron.job"
RCPT="ops@example.test,dev@example.test"
SEND_EMAIL="/functions/v1/send-email"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
# S0 is a precondition (it passes before and after): the scaffold is what prod runs.
val "S0 the four bodies and cron_http_post are prod's (md5/length of prosrc, md5 of pg_get_functiondef)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc) || ':' || md5(pg_get_functiondef(oid)), ',' ORDER BY proname)
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FOUR, 'cron_http_post')" \
  "check_cron_http_failures:3bcacc073b307c74b8ef7e137865de32/6414:b1660e24ad798c167a4a023da4c9bd1a,check_exchange_rate_freshness:658b8be4592ab74821ee0df845579437/6927:150ee6f9f45c06f9dfe47cbea311eef7,check_poi_sync_freshness:c9434e9e1c75a6504f84de2074369a88/6339:22ad677d573f0988badcdb923f2744ff,cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab/626:6db1e8de055f53d93199080dad052b62,send_db_health_email:4b9ed06fabc6d67a8f4666945fafd0a9/1468:56a0ede75e9549f042e76a9b0b4b2ac6"
OTHERS0=$(q "$OTHERS"); META0=$(q "$META"); JOBS0=$(q "$JOBS")

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== what the bodies are =="
val "B1 the four bodies are the live ones with the e-mail call going through cron_http_post" "$BODIES" "$NEW"
val "B2 no raw net.http_post is left in them; each calls cron_http_post once, with its own label" \
  "SELECT string_agg(proname || '=' || (SELECT count(*) FROM regexp_matches(prosrc, 'net\.http_post\s*\(', 'g')) || '/'
          || COALESCE((SELECT string_agg(m[1], '+') FROM regexp_matches(prosrc, 'public\.cron_http_post\(''([a-z-]+)'',', 'g') AS m), '-'),
          ',' ORDER BY proname)
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FOUR)" \
  "check_cron_http_failures=0/cron-http-failure-alert,check_exchange_rate_freshness=0/fx-stale-alert,check_poi_sync_freshness=0/poi-sync-stale-alert,send_db_health_email=0/db-health-email"
# B3-B6 are controls (they pass before and after): the migration changes nothing else.
val "B3 every other function (public, cron, net) is untouched" "$OTHERS" "$OTHERS0"
val "B4 owner, SECURITY DEFINER, search_path and grants of the four are unchanged" "$META" "$META0"
val "B5 the cron jobs are untouched" "$JOBS" "$JOBS0"
val "B6 anon and authenticated cannot execute any of the four; service_role can" \
  "SELECT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) || ',' || bool_or(has_function_privilege('authenticated', oid, 'EXECUTE'))
          || ',' || bool_and(has_function_privilege('service_role', oid, 'EXECUTE'))
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FOUR)" "false,false,true"

echo "== each alert goes out through cron_http_post, labeled, with a 30 s timeout =="
# RED: the alert is sent ("2"), but no request is labeled and both go out untracked ("0|-|-|-;2").
val "H1 check_cron_http_failures (recovery: the stored signature differs)" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('cron_http_health_signature', to_jsonb('zz_old'::text));
          SELECT public.check_cron_http_failures() ->> 'emails_sent'; SELECT t.calls('cron-http-failure-alert'); SELECT t.untracked();")" \
  "2;2|30000|$SEND_EMAIL|$RCPT;0"
val "H2 check_exchange_rate_freshness (stale -> ok)" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('fx_health_status', to_jsonb('stale'::text));
          SELECT public.check_exchange_rate_freshness() ->> 'emails_sent'; SELECT t.calls('fx-stale-alert'); SELECT t.untracked();")" \
  "2;2|30000|$SEND_EMAIL|$RCPT;0"
val "H3 check_exchange_rate_freshness (ok -> stale: the rate is 1 h old, the threshold 0.5 h)" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('fx_health_status', to_jsonb('ok'::text)), ('fx_stale_alert_hours', to_jsonb(0.5));
          SELECT public.check_exchange_rate_freshness() ->> 'status'; SELECT t.calls('fx-stale-alert'); SELECT t.untracked();")" \
  "stale;2|30000|$SEND_EMAIL|$RCPT;0"
val "H4 check_poi_sync_freshness (stale -> ok)" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('poi_sync_health_status', to_jsonb('stale'::text));
          SELECT public.check_poi_sync_freshness() ->> 'emails_sent'; SELECT t.calls('poi-sync-stale-alert'); SELECT t.untracked();")" \
  "2;2|30000|$SEND_EMAIL|$RCPT;0"
val "H5 check_database_health (critical -> ok) and send_db_health_digest, both through send_db_health_email" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('db_health_status', to_jsonb('critical'::text));
          SELECT public.check_database_health() ->> 'emails_sent'; SELECT public.send_db_health_digest() ->> 'emails_sent';
          SELECT t.calls('db-health-email'); SELECT t.untracked();")" \
  "2;2;4|30000|$SEND_EMAIL|$RCPT,$RCPT;0"
# A control (the same before and after): what goes to send-email does not change.
val "H6 the request body and headers keep their keys" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('cron_http_health_signature', to_jsonb('zz_old'::text)),
            ('fx_health_status', to_jsonb('stale'::text)), ('poi_sync_health_status', to_jsonb('stale'::text)),
            ('db_health_status', to_jsonb('critical'::text));
          SELECT count(*) FROM (SELECT public.check_cron_http_failures(), public.check_exchange_rate_freshness(),
                                       public.check_poi_sync_freshness(), public.check_database_health()) x;
          SELECT count(*) || ':' || string_agg(DISTINCT
                   (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(convert_from(body, 'UTF8')::jsonb) AS k) || '|' ||
                   (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(headers) AS k), ';')
          FROM net.http_request_queue;")" \
  "1;8:data,recipient_email,subject,template|Authorization,Content-Type,apikey"

echo "== a rejected alert now reaches check_cron_http_failures =="
# E1: all four alerts go out, send-email answers 500 to every one, and the next review runs.
# RED: none of them is in cron_http_calls, so the review says "ok" and the alert path stays silent.
val "E1 send-email rejecting the alerts: the next review reports all four labels" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('cron_http_health_signature', to_jsonb('zz_old'::text)),
            ('fx_health_status', to_jsonb('stale'::text)), ('poi_sync_health_status', to_jsonb('stale'::text)),
            ('db_health_status', to_jsonb('critical'::text));
          SELECT count(*) FROM (SELECT public.check_cron_http_failures(), public.check_exchange_rate_freshness(),
                                       public.check_poi_sync_freshness(), public.check_database_health()) x;
          SELECT t.answer_all(500);
          SELECT r ->> 'status' || '|' || (r ->> 'failing') || '|' || (r ->> 'detail') FROM (SELECT public.check_cron_http_failures() AS r) x;
          SELECT value #>> '{}' FROM public.platform_config WHERE key = 'cron_http_health_status';")" \
  "1;8;failing|cron-http-failure-alert,db-health-email,fx-stale-alert,poi-sync-stale-alert|cron-http-failure-alert (2x 500) - db-health-email (2x 500) - fx-stale-alert (2x 500) - poi-sync-stale-alert (2x 500);failing"
# E2: a single rejected alert also shows (the FX watchdog alone, send-email down).
val "E2 send-email down while the FX rate freezes: the review reports fx-stale-alert" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('fx_health_status', to_jsonb('ok'::text)), ('fx_stale_alert_hours', to_jsonb(0.5));
          SELECT public.check_exchange_rate_freshness() ->> 'status'; SELECT t.answer_all(503);
          SELECT public.check_cron_http_failures() ->> 'failing';")" \
  "stale;2;fx-stale-alert"
# E3 (control): send-email accepting the alerts is not a failure.
val "E3 send-email accepting every alert: the review stays ok" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('cron_http_health_signature', to_jsonb('zz_old'::text)),
            ('fx_health_status', to_jsonb('stale'::text)), ('poi_sync_health_status', to_jsonb('stale'::text)),
            ('db_health_status', to_jsonb('critical'::text));
          SELECT count(*) FROM (SELECT public.check_cron_http_failures(), public.check_exchange_rate_freshness(),
                                       public.check_poi_sync_freshness(), public.check_database_health()) x;
          SELECT t.answer_all(200);
          SELECT r ->> 'status' || '|' || (r ->> 'failing') FROM (SELECT public.check_cron_http_failures() AS r) x;")" \
  "1;8;ok|"

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
  [ "$r" = applied ] && [ "$b" = "$NEW" ] && ok "G0 with CRLF line endings the migration patches the same four bodies" || ko "G0 with CRLF line endings the migration patches the same four bodies" "$r / $b"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.check_poi_sync_freshness()'::regprocedure),
      'v_sent := v_sent + 1;', 'v_sent := v_sent + 1; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "check_poi_sync_freshness() has a body this migration does not know" && ok "G1 a body that drifted from prod aborts the migration" || ko "G1 a body that drifted from prod aborts the migration" "$r"

  sabotage g2 "CONTINUE WHEN v_md5 = r.md5_new;" "CONTINUE WHEN v_md5 = r.md5_new OR r.fn = 'public.check_exchange_rate_freshness()';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "check_exchange_rate_freshness still sends through a raw net.http_post" && ok "G2 a function left unpatched aborts the migration" || ko "G2 a function left unpatched aborts the migration" "$r"

  sabotage g3 "'c9434e9e1c75a6504f84de2074369a88', 'fdd8db5c1cd35cb8f91dd65b2447cd67'" "'c9434e9e1c75a6504f84de2074369a88', '00000000000000000000000000000000'"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "check_poi_sync_freshness() was patched to md5 fdd8db5c1cd35cb8f91dd65b2447cd67, expected 00000000000000000000000000000000" && ok "G3 a patch that does not produce the expected body aborts the migration" || ko "G3 a patch that does not produce the expected body aborts the migration" "$r"

  # G4: cron_http_post sends but its bookkeeping row disappears: the probe sees no labeled call.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.cron_http_post(text,text,jsonb,jsonb,integer)'::regprocedure),
      'ON CONFLICT (request_id) DO NOTHING;', 'ON CONFLICT (request_id) DO NOTHING; DELETE FROM public.cron_http_calls WHERE request_id = v_id;'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00647: probe failed" && ok "G4 alerts that do not land in cron_http_calls abort the migration" || ko "G4 alerts that do not land in cron_http_calls abort the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "DROP FUNCTION public.cron_http_post(text,text,jsonb,jsonb,integer)" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00647: public.cron_http_post(text,text,jsonb,jsonb,integer) is missing" && ok "G5 a missing cron_http_post aborts the migration" || ko "G5 a missing cron_http_post aborts the migration" "$r"

  # G6: another cron job that reaches net.http_post raw: the catalog sweep names it.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    CREATE FUNCTION public.zz_rogue_alert() RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM net.http_post(url := 'https://x.test/functions/v1/send-email'); END \$f\$;
    CREATE FUNCTION public.zz_rogue_check() RETURNS void LANGUAGE plpgsql AS \$f\$ BEGIN PERFORM public.zz_rogue_alert(); END \$f\$;
    SELECT cron.schedule('zz-rogue', '0 * * * *', 'SELECT public.zz_rogue_check();');" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00647: cron jobs still reach a raw net.http_post: zz-rogue via zz_rogue_alert" && ok "G6 another cron path with a raw net.http_post aborts the migration" || ko "G6 another cron path with a raw net.http_post aborts the migration" "$r"

  # G7: a cron job whose command itself calls net.http_post: the sweep's other branch.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    SELECT cron.schedule('zz-raw-command', '0 * * * *', \$c\$SELECT net.http_post(url := 'https://x.test/functions/v1/send-email');\$c\$);" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00647: cron jobs still reach a raw net.http_post: zz-raw-command via (its command)" && ok "G7 a cron command with a raw net.http_post aborts the migration" || ko "G7 a cron command with a raw net.http_post aborts the migration" "$r"

  # G8: the alerts are labeled but go out with net.http_post's 5 s timeout: the probe catches it.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.cron_http_post(text,text,jsonb,jsonb,integer)'::regprocedure),
      'timeout_milliseconds := v_timeout', 'timeout_milliseconds := 5000'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00647: probe failed, the labeled calls were \[cron-http-failure-alert:5000:" && ok "G8 alerts with a 5 s timeout abort the migration" || ko "G8 alerts with a 5 s timeout abort the migration" "$r"

  # G9: the self-check's label assertion can fail (here it expects a label the patch does not write).
  sabotage g9 "('public.check_exchange_rate_freshness()', 'check_exchange_rate_freshness', 'fx-stale-alert')," \
                "('public.check_exchange_rate_freshness()', 'check_exchange_rate_freshness', 'fx-alert'),"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g9.sql")
  echo "$r" | grep -q "00647: check_exchange_rate_freshness must call public.cron_http_post once, with label fx-alert" && ok "G9 a function without its label aborts the migration" || ko "G9 a function without its label aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
