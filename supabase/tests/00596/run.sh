#!/usr/bin/env bash
# Rehearsal runner for migration 00596 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00596/run.sh none
#       -> scaffold + tests (RED: there is no watchdog for SQL cron jobs)
#   supabase/tests/00596/run.sh supabase/migrations/00596_cron_sql_failure_watchdog.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
DB=pr596
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" 2>&1 | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# expect_err NAME SQL PATTERN -> the statement must fail with an error matching PATTERN
expect_err(){ local r; if r=$($P -c "$2" 2>&1); then ko "$1" "expected an error, got [$r]"; elif echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "wrong error: $(echo "$r" | head -1)"; fi; }

# run JOB STATUS MESSAGE AGO -> one run of JOB that started AGO ago (MESSAGE is an SQL literal or NULL)
run(){ printf "INSERT INTO cron.job_run_details (jobid, status, return_message, start_time, end_time)
  SELECT jobid, '%s', %s, now() - interval '%s', now() - interval '%s' + interval '1 second' FROM cron.job WHERE jobname = '%s';" "$2" "$3" "$4" "$4" "$1"; }
OKM="'1 row'"                                                        # pg_cron's message for a run that worked
F="'ERROR:  query returned more than one row'"                       # a real SQL error
T="'ERROR:  canceling statement due to statement timeout'"           # a real error that outages also cause
O1="'job startup timeout'"; O2="'server restarted'"                  # the platform failed, not the job
C=cleanup_auth_revocations; R=retry-dispatch-expired-rides; W=anonymize-old-rides-yearly
RECIPIENTS="to_jsonb('ops1@example.com, ops2@example.com,ops3@example.com, ops4@example.com, ops5@example.com'::text)"
RESET="DELETE FROM cron.job WHERE jobname LIKE 'test-%'; UPDATE cron.job SET active = true;
TRUNCATE cron.job_run_details, net.http_request_queue;
DELETE FROM public.platform_config WHERE key LIKE 'cron_sql_health_%';
INSERT INTO public.platform_config (key, value) VALUES ('business_notification_email', $RECIPIENTS)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;"
CHECK="SELECT public.check_cron_sql_failures() ->> 'emails_sent';"
STATE="SELECT (SELECT value #>> '{}' FROM public.platform_config WHERE key = 'cron_sql_health_status') || '|' ||
              (SELECT value::text FROM public.platform_config WHERE key = 'cron_sql_health_signature') || '|' ||
              (SELECT value::text FROM public.platform_config WHERE key = 'cron_sql_health_candidates');"
DETAIL="SELECT value #>> '{}' FROM public.platform_config WHERE key = 'cron_sql_health_detail';"
LAST="(SELECT convert_from(body, 'UTF8')::jsonb FROM net.http_request_queue ORDER BY id DESC LIMIT 1)"
# broken3 JOB -> JOB worked 4 days ago and failed the last three times with a real error
broken3(){ echo "$(run $1 succeeded "$OKM" '4 days') $(run $1 failed "$F" '3 days') $(run $1 failed "$F" '2 days') $(run $1 failed "$F" '1 day')"; }

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live mailer from 00577 (md5 of prosrc)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.send_db_health_email(text,text)'::regprocedure" \
  "4b9ed06fabc6d67a8f4666945fafd0a9/1468"

if [ "$MIG" != "none" ]; then
  # The shape prod had on 2026-09-25: the nightly cleanup failing 14 nights in a row, never a success.
  SEED="$RESET"; for d in 1 2 3 4 5 6 7 8 9 10 11 12 13 14; do SEED="$SEED $(run $C failed "$F" "$d days")"; done
  $P -c "$SEED" >/dev/null || exit 1
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  val "M1 applying it with a job already failing sends nothing and seeds that job as known" \
    "SELECT count(*) FROM net.http_request_queue; $STATE $DETAIL" \
    '0;failing|["cleanup_auth_revocations"]|["cleanup_auth_revocations"];seeded by migration 00596'
  $P -c "UPDATE public.platform_config SET value = to_jsonb('kept'::text) WHERE key = 'cron_sql_health_detail'" >/dev/null
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M2 a second apply keeps the watchdog's state and its single cron job" \
    "$DETAIL SELECT count(*) FROM cron.job WHERE jobname = 'check-cron-sql-failures'; SELECT count(*) FROM net.http_request_queue;" "kept;1;0"
fi

echo "== tests =="
# A. what counts as failing, and when it emails
val "A1 three real failures in a row: the 1st check only notes it, the 2nd emails all 5 recipients" \
  "$RESET $(broken3 $C) $CHECK $CHECK $STATE" \
  '0;5;failing|["cleanup_auth_revocations"]|["cleanup_auth_revocations"]'
val "A2 two real failures in a row are not enough for a job with more runs" \
  "$RESET $(run $C succeeded "$OKM" '4 days') $(run $C failed "$F" '2 days') $(run $C failed "$F" '1 day') $CHECK $CHECK $STATE" \
  '0;0;ok|[]|[]'
val "A3 outage messages do not count as failures (2 real + 1 outage is still 2)" \
  "$RESET $(run $C succeeded "$OKM" '4 days') $(run $C failed "$F" '3 days') $(run $C failed "$O1" '2 days') $(run $C failed "$F" '1 day')
          $CHECK $CHECK $STATE" \
  '0;0;ok|[]|[]'
val "A3 outage messages do not break a streak either (real, outage, real, real is 3)" \
  "$RESET $(run $C succeeded "$OKM" '5 days') $(run $C failed "$F" '4 days') $(run $C failed "$O2" '3 days') $(run $C failed "$F" '2 days')
          $(run $C failed "$F" '1 day') $CHECK $CHECK $STATE" \
  '0;5;failing|["cleanup_auth_revocations"]|["cleanup_auth_revocations"]'
OUT10="$(run $R succeeded "$OKM" '11 minutes')"; for m in 10 9 8 7 6 5 4 3 2 1; do OUT10="$OUT10 $(run $R failed "$O1" "$m minutes")"; done
val "A4 a job whose only failures are outages is not failing" "$RESET $OUT10 $CHECK $CHECK $STATE" '0;0;ok|[]|[]'
val "A5 a success in between resets the streak" \
  "$RESET $(run $C failed "$F" '5 days') $(run $C failed "$F" '4 days') $(run $C succeeded "$OKM" '3 days')
          $(run $C failed "$F" '2 days') $(run $C failed "$F" '1 day') $CHECK $CHECK $STATE" \
  '0;0;ok|[]|[]'
val "A6 a weekly job whose two runs in the window both failed counts" \
  "$RESET $(run $W failed "$F" '8 days') $(run $W failed "$F" '1 day') $CHECK $CHECK $STATE" \
  '0;5;failing|["anonymize-old-rides-yearly"]|["anonymize-old-rides-yearly"]'
val "A7 a new job whose only run failed counts (and reads \"1 falla\")" \
  "$RESET INSERT INTO cron.job (jobname, schedule, command) VALUES ('test-new-job', '0 5 * * *', 'SELECT 1');
          $(run test-new-job failed "$F" '30 minutes') $CHECK $CHECK $STATE $DETAIL
   SELECT ($LAST ->> 'template') LIKE '%>1 falla<br>%';" \
  '0;5;failing|["test-new-job"]|["test-new-job"];test-new-job: 1 falla;t'
val "A8 inactive jobs are ignored" \
  "$RESET $(broken3 $C) UPDATE cron.job SET active = false WHERE jobname = '$C'; $CHECK $CHECK $STATE" '0;0;ok|[]|[]'
val "A9 runs still in progress are ignored and do not count as a success" \
  "$RESET $(broken3 $C) $(run $C running NULL '1 minute') $(run $C starting NULL '30 seconds') $CHECK $CHECK $STATE" \
  '0;5;failing|["cleanup_auth_revocations"]|["cleanup_auth_revocations"]'
val "A9 a run still in progress does not count toward a new job's run total" \
  "$RESET INSERT INTO cron.job (jobname, schedule, command) VALUES ('test-new-job', '0 5 * * *', 'SELECT 1');
          $(run test-new-job failed "$F" '1 day') $(run test-new-job running NULL '1 minute') $CHECK $CHECK $STATE" \
  '0;5;failing|["test-new-job"]|["test-new-job"]'
val "A10 runs older than 14 days are ignored" \
  "$RESET $(run $R failed "$F" '17 days') $(run $R failed "$F" '16 days') $(run $R failed "$F" '15 days') $CHECK $CHECK $STATE" \
  '0;0;ok|[]|[]'
val "A11 a job that stays broken emails once, not at every check" \
  "$RESET $(broken3 $C) $CHECK $CHECK $CHECK $CHECK $CHECK" '0;5;0;0;0'
val "A12 a second job joining emails again, listing both" \
  "$RESET $(broken3 $C) $CHECK $CHECK
          $(run $R succeeded "$OKM" '10 minutes') $(run $R failed "$F" '3 minutes') $(run $R failed "$F" '2 minutes') $(run $R failed "$F" '1 minute')
          $CHECK $CHECK SELECT $LAST ->> 'subject';" \
  '0;5;0;5;[TriciGo] 2 tareas programadas fallando'
val "A13 once it works again, the next check emails that it recovered" \
  "$RESET $(broken3 $C) $CHECK $CHECK $(run $C succeeded "$OKM" '1 minute') $CHECK $STATE SELECT $LAST ->> 'subject';" \
  '0;5;5;ok|[]|[];[TriciGo] Tareas programadas de la base recuperadas'
val "A14 seen failing once, fine by the next check: never emails (the outage pattern)" \
  "$RESET $(run $R succeeded "$OKM" '10 minutes') $(run $R failed "$T" '3 minutes') $(run $R failed "$T" '2 minutes') $(run $R failed "$T" '1 minute')
          $CHECK $(run $R succeeded "$OKM" '1 second') $CHECK $CHECK $STATE SELECT count(*) FROM net.http_request_queue;" \
  '0;0;0;ok|[]|[];0'
val "A15 when one of two failing jobs recovers, the email keeps the other and names the recovered one" \
  "$RESET $(broken3 $C) $(run $R succeeded "$OKM" '10 minutes') $(run $R failed "$F" '3 minutes') $(run $R failed "$F" '2 minutes') $(run $R failed "$F" '1 minute')
          $CHECK $CHECK $(run $R succeeded "$OKM" '1 second') $CHECK
          SELECT ($LAST ->> 'subject') || '|' || (($LAST ->> 'template') LIKE '%Ya se recuperaron: retry-dispatch-expired-rides.%');" \
  '0;5;5;[TriciGo] Tarea programada fallando: cleanup_auth_revocations|true'
val "A16 without recipients the state still moves and nothing is sent" \
  "$RESET UPDATE public.platform_config SET value = to_jsonb(''::text) WHERE key = 'business_notification_email';
          $(broken3 $C) $CHECK $CHECK $STATE SELECT count(*) FROM net.http_request_queue;" \
  '0;0;failing|["cleanup_auth_revocations"]|["cleanup_auth_revocations"];0'
EB="E'ERROR:  <b>boom</b> & more\nHINT:  try again\n'"
val "A17 the email escapes the error, keeps its lines, says the job never worked, and names it in the subject" \
  "$RESET $(run $C failed "$EB" '3 days') $(run $C failed "$EB" '2 days') $(run $C failed "$EB" '1 day') $CHECK $CHECK
   SELECT (($LAST ->> 'template') LIKE '%ERROR:  &lt;b&gt;boom&lt;/b&gt; &amp; more<br>HINT:  try again</td>%') || '|' ||
          (($LAST ->> 'template') NOT LIKE '%<b>boom%') || '|' ||
          (($LAST ->> 'template') LIKE '%No anduvo ni una vez en los últimos 14 días%') || '|' || ($LAST ->> 'subject');" \
  '0;5;true|true|true|[TriciGo] Tarea programada fallando: cleanup_auth_revocations'
val "A18 a job that worked before shows when, in Cuba time" \
  "$RESET $(broken3 $C) $CHECK $CHECK
   SELECT ($LAST ->> 'template') LIKE '%Última vez que anduvo: ' || to_char((now() - interval '4 days') AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI') || '%';" \
  '0;5;t'
val "A19 the stored detail says what fails and what is only being watched" \
  "$RESET $(broken3 $C) $CHECK $DETAIL $CHECK $DETAIL" \
  '0;todas las tareas programadas andan · en observación: cleanup_auth_revocations;5;cleanup_auth_revocations: 3 fallas seguidas'
val "A20 every queued email goes to send-email with the service key, one per recipient" \
  "$RESET $(broken3 $C) $CHECK $CHECK
   SELECT count(DISTINCT convert_from(body, 'UTF8')::jsonb ->> 'recipient_email') || '|' ||
          bool_and(url = 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email') || '|' ||
          bool_and(headers ->> 'Authorization' = 'Bearer test-service-role-key') FROM net.http_request_queue;" \
  '0;5;5|true|true'

# B. contract
for fn in 'cron_sql_failures_now()' 'check_cron_sql_failures()'; do
  val "B1 $fn is SECURITY DEFINER with a pinned search_path" \
    "SELECT prosecdef || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.$fn'::regprocedure" "true|search_path=public, pg_catalog"
  val "B2 $fn: anon no, authenticated no, service_role yes" \
    "SELECT has_function_privilege('anon', 'public.$fn', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.$fn', 'EXECUTE')
            || '|' || has_function_privilege('service_role', 'public.$fn', 'EXECUTE')" "false|false|true"
done
val "B3 cron_sql_failures_now() only reads" \
  "$RESET $(broken3 $C) SELECT jsonb_array_length(public.cron_sql_failures_now());
   SELECT (SELECT count(*) FROM public.platform_config WHERE key LIKE 'cron_sql_health_%') || '|' || (SELECT count(*) FROM net.http_request_queue);" \
  '1;0|0'
val "B4 before a failed check: one job noted" "$RESET $(broken3 $C) $CHECK" '0'
expect_err "B4 a failure inside the check is not swallowed: the cron run fails" \
  "CREATE OR REPLACE FUNCTION public.send_db_health_email(p_subject text, p_html text) RETURNS integer
     LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'boom'; END \$f\$; $CHECK" "ERROR:  boom"
val "B4 ...and the change is still pending, so the next hour sends it" \
  "$STATE $CHECK" 'ok|[]|["cleanup_auth_revocations"];5'
val "B5 the watchdog runs at :45 and only calls the check" \
  "SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'check-cron-sql-failures'" \
  "45 * * * *|SELECT public.check_cron_sql_failures();"

# N. negative proof: plant the NULL-concatenation trap in a copy; its self-test must abort it
if [ "$MIG" != "none" ]; then
  BUGGY="$(mktemp --suffix=.sql)"
  if python3 - "$MIG" "$BUGGY" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
old = """          || COALESCE('Última vez que anduvo: '
                      || to_char((v_item ->> 'last_ok')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI'),
                      'No anduvo ni una vez en los últimos 14 días')
"""
new = """          || 'Última vez que anduvo: '
          || to_char((v_item ->> 'last_ok')::timestamptz AT TIME ZONE 'America/Havana', 'DD/MM HH24:MI')
"""
assert src.count(old) == 1, f"expected the last_ok line once, found {src.count(old)}"
out = src.replace(old, new)
assert out != src and "No anduvo ni una vez" not in out
open(sys.argv[2], "w").write(out)
PYEOF
  then
    ok "N0 built a copy of the migration whose email is blank when a job never worked"
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n1" -c "CREATE DATABASE ${DB}n1" >/dev/null 2>&1
    N1="$BIN/psql $CONN -d ${DB}n1 -qAt -v ON_ERROR_STOP=1"
    $N1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
    # The prod shape: the job never worked in the window, so last_ok is NULL.
    $N1 -c "$(run $C failed "$F" '3 days') $(run $C failed "$F" '2 days') $(run $C failed "$F" '1 day')" >/dev/null
    if out=$($N1 -1 -c "SET search_path = ''" -f "$BUGGY" 2>&1); then
      ko "N1 the self-test aborts a migration whose alert email would go out blank" "migration succeeded with the bug in place"
    elif echo "$out" | grep -q "00596: the check queued 0 emails"; then
      ok "N1 the self-test aborts a migration whose alert email would go out blank"
    else
      ko "N1 the self-test aborts a migration whose alert email would go out blank" "wrong error: $(echo "$out" | grep -m1 ERROR)"
    fi
  else
    ko "N0 built a copy of the migration whose email is blank when a job never worked" "the replacement did not apply; N1 skipped"
  fi
  rm -f "$BUGGY"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
