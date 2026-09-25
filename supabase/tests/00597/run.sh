#!/usr/bin/env bash
# Rehearsal runner for migration 00597 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00597/run.sh none
#       -> scaffold (the live 00596 watchdog) + tests. RED: its alerts are not tracked by
#          cron_http_post, and a pg_cron failure other than its two skipped messages counts
#          as the job's. The tests about what 00597 keeps (the rule, the emails) pass.
#   supabase/tests/00597/run.sh supabase/migrations/00597_cron_sql_watchdog_tracked_send_and_job_errors.sql
#       -> scaffold + migration x2 (idempotency) + tests + mutants that the tests must catch (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# PG_BIN, PG_PORT and PYTHON override the binaries directory, the port and the python, e.g. on Windows:
#   PG_BIN=/c/.../pgsql/bin PG_PORT=5435 PYTHON=python supabase/tests/00597/run.sh <migration>
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PG_PORT:-5433} -U pgtest"
DB=pr597
PY="${PYTHON:-$(command -v python3 || command -v python)}"   # Windows has no python3
# UTC like prod; notices off so a DO block's chatter never lands in a compared value. UTF-8 and
# untranslated messages so that psql on Windows prints the same bytes as on Linux.
export PGOPTIONS="-c client_min_messages=warning -c TimeZone=UTC" PGCLIENTENCODING=UTF8 LC_MESSAGES=C
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q SQL [PSQL] -> the rows the statements print, one per line. Blank lines are dropped (a void
# helper prints one) and so are CRs (psql on Windows ends lines with CRLF).
q(){ ${2:-$P} -c "$1" 2>&1 | tr -d '\r' | grep -v '^$'; }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(q "$2" | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# SQL files reach psql with their CRs stripped: a Windows checkout with core.autocrlf=true has
# them in CRLF, and every CR would end up inside the function bodies, breaking the md5 checks and
# the text the migration's patches look for.
# fresh NAME -> an empty database NAME with the scaffold loaded (prints the first errors if not)
fresh(){ local out
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || return 1
  out=$(tr -d '\r' < "$DIR/scaffold.sql" | $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1) \
    || { printf '%s\n' "$out" | tr -d '\r' | grep -m3 -E 'ERROR|FATAL'; return 1; }; }
# apply FILE [DB] -> run a migration file in one transaction as role postgres (prod's owner:
# no superuser, BYPASSRLS) with an empty search_path; prints psql's output, notices included
apply(){ tr -d '\r' < "$1" | PGOPTIONS="-c client_min_messages=notice -c TimeZone=UTC" \
  $BIN/psql $CONN -d "${2:-$DB}" -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE postgres" -c "SET search_path = ''" -f - 2>&1 | tr -d '\r'
  return "${PIPESTATUS[1]}"; }
# raw_apply FILE DB -> the same, but psql reads the file exactly as it is on disk (CRs included)
raw_apply(){ PGOPTIONS="-c client_min_messages=notice -c TimeZone=UTC" \
  $BIN/psql $CONN -d "$2" -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE postgres" -c "SET search_path = ''" -f "$1" 2>&1 | tr -d '\r'
  return "${PIPESTATUS[0]}"; }

RESET="SELECT FROM t.reset();"
RUN="SELECT FROM public.check_cron_sql_failures();"      # one watchdog run, output discarded
# 00596 confirms a job at the second check that sees it failing: RUN, then ST.
ST="SELECT x.c->>'status' || '|' || (x.c->'failing')::text || '|' || (x.c->>'emails_sent') FROM (SELECT public.check_cron_sql_failures() AS c) x;"
SENT="SELECT count(*) || '|' || count(*) FILTER (WHERE tracked_as = 'cron-sql-failure-alert') FROM t.sent;"
LIVE_MD5="check_cron_http_failures:6b98f714dda196b1cbec8bb8ca5877b5 check_cron_sql_failures:fcfb06087336eaacbcc1d3acd53cefcf cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab cron_sql_failures_now:f5d29cd85b5f8bb54e683fc18a98fc32 send_db_health_email:4b9ed06fabc6d67a8f4666945fafd0a9"
MD5S="SELECT string_agg(p.proname || ':' || md5(p.prosrc), ' ' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('cron_http_post', 'check_cron_http_failures', 'send_db_health_email', 'cron_sql_failures_now', 'check_cron_sql_failures')"
SNAP="SELECT (SELECT md5(string_agg(runid || status || COALESCE(return_message, '') || start_time, ',' ORDER BY runid)) FROM cron.job_run_details)
  || '|' || (SELECT string_agg(key || '=' || value::text, ',' ORDER BY key) FROM public.platform_config WHERE key LIKE 'cron\_sql\_health\_%')
  || '|' || (SELECT count(*) FROM net.http_request_queue) || '|' || (SELECT count(*) FROM public.cron_http_calls);"
# replay TAG [MESSAGE] -> a real outage window checked hour by hour at :45 (t.replay_checks);
# prints emails sent|checks that saw the job as a candidate|checks
replay(){ printf "%s SELECT sum(r_emails) || '|' || count(*) FILTER (WHERE jsonb_array_length(r_candidates) > 0) || '|' || count(*) FROM t.replay_checks('%s'%s);" \
  "$RESET" "$1" "${2:+, '$2'}"; }

echo "== reset database =="
fresh "$DB" || { echo "scaffold failed (is the cluster up on port ${PG_PORT:-5433}?)"; exit 1; }
val "S0 the scaffold carries the live prod bodies (md5 of prosrc) of the five functions involved" "$MD5S" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  BEFORE=$(q "$SNAP")
  TMPD="$(mktemp -d)"
  # the live 00596 bodies, to check below that the patches are the only change
  for f in cron_sql_failures_now check_cron_sql_failures; do
    $P -c "SELECT prosrc FROM pg_proc WHERE oid = 'public.$f()'::regprocedure" | tr -d '\r' > "$TMPD/$f.before"
  done
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="
  OUT1=$(apply "$MIG") || { echo "migration failed:"; echo "$OUT1" | grep -m3 -E 'ERROR|FATAL'; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  OUT2=$(apply "$MIG") || { echo "migration NOT idempotent:"; echo "$OUT2" | grep -m3 -E 'ERROR|FATAL'; exit 1; }
  val "M1 applying it twice leaves the state, the run history and the queue as they were (its self-test rolls back)" "$SNAP" "$BEFORE"
  if echo "$OUT1" | grep -q '00597: verified, a change emails all 3 recipients through cron_http_post'; then
    ok "M2 at apply time the self-test forced an alert and saw all 3 emails go through cron_http_post"
  else ko "M2 at apply time the self-test forced an alert and saw all 3 emails go through cron_http_post" "notice was [$(echo "$OUT1" | grep '00597:')]"; fi
  if [ "$(echo "$OUT2" | grep -c 'already patched')" = 2 ] && echo "$OUT2" | grep -q '00597: verified'; then
    ok "M3 a second apply finds both patches in place and runs the self-test again"
  else ko "M3 a second apply finds both patches in place and runs the self-test again" "$(echo "$OUT2" | grep '00597:' | head -3 | paste -sd' ' -)"; fi
  for f in cron_sql_failures_now check_cron_sql_failures; do
    $P -c "SELECT prosrc FROM pg_proc WHERE oid = 'public.$f()'::regprocedure" | tr -d '\r' > "$TMPD/$f.after"
  done
  # M4: rebuild the patched bodies from the live ones with the migration's own targets and
  # replacements (read from the file), and require the result to be exactly what the database has
  if r=$("$PY" - "$MIG" "$TMPD" <<'PYEOF'
import re, sys
mig = open(sys.argv[1], encoding="utf-8").read().replace("\r", "")
lit = lambda tag: re.search(r"\$%s\$(.*?)\$%s\$" % (tag, tag), mig, re.S).group(1)
d = sys.argv[2]
names = ("cron_sql_failures_now", "check_cron_sql_failures")
before = {f: open(f"{d}/{f}.before", encoding="utf-8").read() for f in names}
after  = {f: open(f"{d}/{f}.after",  encoding="utf-8").read() for f in names}
bad = [f"{t} x{before[n].count(lit(t))}" for n, t in (("cron_sql_failures_now", "a_decl_old"), ("cron_sql_failures_now", "a_cond_old"),
                                                        ("check_cron_sql_failures", "b_old")) if before[n].count(lit(t)) != 1]
exp = {"cron_sql_failures_now": before["cron_sql_failures_now"].replace(lit("a_decl_old"), "").replace(lit("a_cond_old"), lit("a_cond_new")),
       "check_cron_sql_failures": before["check_cron_sql_failures"].replace(lit("b_old"), lit("b_new"))}
bad += [n for n in names if after[n] != exp[n]]
print("ok" if not bad else "differs: " + ", ".join(bad))
PYEOF
  ) && [ "$r" = "ok" ]; then ok "M4 the two patches are the only change to the 00596 bodies (rebuilt byte for byte)"
  else ko "M4 the two patches are the only change to the 00596 bodies (rebuilt byte for byte)" "$r"; fi
  rm -rf "$TMPD"
fi

echo "== tests =="
val "S1 the functions 00597 does not patch keep their live bodies" \
  "$MD5S AND p.proname NOT IN ('cron_sql_failures_now', 'check_cron_sql_failures')" \
  "check_cron_http_failures:6b98f714dda196b1cbec8bb8ca5877b5 cron_http_post:15d9ded451c60f92a0fd0a3c4e1ee0ab send_db_health_email:4b9ed06fabc6d67a8f4666945fafd0a9"
val "S2 role postgres is no superuser but bypasses RLS, as in prod" \
  "SELECT rolsuper || '|' || rolbypassrls FROM pg_roles WHERE rolname = 'postgres'" "false|true"
val "S3 00596's job and prod's seeded state are in place" \
  "SELECT (SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'check-cron-sql-failures') || '|' || (SELECT value::text FROM public.platform_config WHERE key = 'cron_sql_health_signature')" \
  '45 * * * *|SELECT public.check_cron_sql_failures();|["cleanup_auth_revocations"]'

# C. which failed runs are the job's
val "C1 'connection failed' on every run is pg_cron not running the job: not reported" \
  "$RESET SELECT FROM t.seed('conn_failed', '0 * * * *', 'OCCCC', '1 hour', '10 minutes'); $RUN $ST" 'ok|[]|0'
val "C2 'connection lost' and 'job canceled': not reported" \
  "$RESET SELECT FROM t.seed('pg_cron_failures', '0 * * * *', 'OLLKK', '1 hour', '10 minutes'); $RUN $ST" 'ok|[]|0'
val "C3 'job startup timeout', 'server restarted' and a failure with no message are still skipped (00596)" \
  "$RESET SELECT FROM t.seed('outage_only', '0 * * * *', 'OSSRRNN', '1 hour', '10 minutes'); $RUN $ST" 'ok|[]|0'
val "C4 prod's case still alerts: 14 nightly 'query returned more than one row', confirmed at the 2nd check" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $RUN $ST" \
  'failing|["cleanup_auth_revocations"]|3'
val "C5 ... and the 1st check alone does not (00596's confirmation is kept)" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $ST" 'ok|[]|0'
val "C6 'COPY not supported' is the job's fault: reported" \
  "$RESET SELECT FROM t.seed('copy_job', '0 * * * *', 'OPPP', '1 hour', '10 minutes'); $RUN $ST" 'failing|["copy_job"]|3'
val "C7 a statement timeout on every run still counts" \
  "$RESET SELECT FROM t.seed('slow_job', '0 * * * *', 'OTTT', '1 hour', '10 minutes'); $RUN $ST" 'failing|["slow_job"]|3'
val "C8 platform failures between SQL errors are still skipped, not breaking the streak (00596)" \
  "$RESET SELECT FROM t.seed('mixed', '0 * * * *', 'OESESE', '1 hour', '10 minutes'); $RUN $ST" 'failing|["mixed"]|3'
val "C9 ... and so are the other pg_cron failures (E C E L E -> 3 in a row)" \
  "$RESET SELECT FROM t.seed('mixed', '0 * * * *', 'OECELE', '1 hour', '10 minutes'); $RUN $ST" 'failing|["mixed"]|3'
val "C10 two SQL errors with connection failures around them are not 3 in a row" \
  "$RESET SELECT FROM t.seed('mixed', '0 * * * *', 'OECEC', '1 hour', '10 minutes'); $RUN $ST" 'ok|[]|0'

# T. how the alert travels
val "T1 the alert goes through cron_http_post: one tracked call per valid recipient" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $RUN $RUN $SENT
   SELECT string_agg(DISTINCT url, ',') || '|' || string_agg(recipient, ',' ORDER BY id) FROM t.sent" \
  '3|3;https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email|ops@example.test,dev@example.test,owner@example.test'
val "T2 so a rejected send is visible: check_cron_http_failures reports the label" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $RUN $RUN
   UPDATE public.cron_http_calls SET called_at = now() - interval '5 minutes';
   INSERT INTO net._http_response (id, status_code, content) SELECT id, 401, '{\"code\":401,\"message\":\"Invalid JWT\"}' FROM net.http_request_queue;
   SELECT x.c->>'status' || '|' || (x.c->>'failing') FROM (SELECT public.check_cron_http_failures() AS c) x" \
  'failing|cron-sql-failure-alert'
val "T3 the recovery email goes through cron_http_post too" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '1 day 15 hours'); $RUN $RUN
   DELETE FROM net.http_request_queue; DELETE FROM public.cron_http_calls;
   SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', 'O', '1 day', '15 hours'); $ST $SENT
   SELECT DISTINCT subject FROM t.sent" \
  'ok|[]|3;3|3;[TriciGo] Tareas programadas de la base recuperadas'
# one scenario, first through a copy of the 00596 check, then through public.check_cron_sql_failures(),
# in the same transaction (same now(), so the times inside the body match)
T4_SCENARIO="SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '1 day 15 hours');"
T4_RECOVER="SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', 'O', '1 day', '15 hours');"
T4_CLEAN="DELETE FROM net.http_request_queue; DELETE FROM public.cron_http_calls; DELETE FROM cron.job_run_details;
   DELETE FROM public.platform_config WHERE key LIKE 'cron\_sql\_health\_%';"
T4_SIG="md5(string_agg(concat_ws('|', url, auth_header, apikey, recipient, subject, template), E'\n' ORDER BY id))"
val "T4 same emails as 00596 sent (recipients, subject, body, auth headers), for the alert and the recovery" \
  "$RESET $T4_SCENARIO
   SELECT FROM t.check_cron_sql_failures_00596(); SELECT FROM t.check_cron_sql_failures_00596(); $T4_RECOVER SELECT FROM t.check_cron_sql_failures_00596();
   CREATE TEMP TABLE sent_00596 AS SELECT * FROM t.sent;
   $T4_CLEAN $T4_SCENARIO $RUN $RUN $T4_RECOVER $RUN
   SELECT ((SELECT $T4_SIG FROM sent_00596) = (SELECT $T4_SIG FROM t.sent)) || '|' || (SELECT count(*) FROM sent_00596) || '|' || (SELECT count(DISTINCT subject) FROM sent_00596)" \
  'true|6|2'
val "T6 the alert waits 30 s for send-email (cron_http_post's timeout); 00596's waited pg_net's default 5 s" \
  "$RESET SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours');
   SELECT FROM t.check_cron_sql_failures_00596(); SELECT FROM t.check_cron_sql_failures_00596();
   SELECT string_agg(DISTINCT timeout_milliseconds::text, ',') FROM net.http_request_queue;
   $T4_CLEAN SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $RUN $RUN
   SELECT string_agg(DISTINCT timeout_milliseconds::text, ',') FROM net.http_request_queue" \
  '5000;30000'
val "T5 no business_notification_email: nothing is sent" \
  "$RESET DELETE FROM public.platform_config WHERE key = 'business_notification_email';
   SELECT FROM t.seed('cleanup_auth_revocations', '0 3 * * *', repeat('E', 14), '1 day', '15 hours'); $RUN $ST $SENT" \
  'failing|["cleanup_auth_revocations"]|0;0|0'

# R. the real September outages, checked hour by hour at :45 as in prod
val "R1 2026-09-21, retry-dispatch-expired-rides: a candidate at one check, never confirmed, no email" "$(replay 2026-09-21)" "0|1|4"
val "R2 2026-09-20, retry-dispatch-expired-rides: a candidate at one check, no email" "$(replay 2026-09-20)" "0|1|3"
val "R3 2026-09-20, keepwarm-netopia-mint: no email" "$(replay 2026-09-20-keepwarm)" "0|0|2"
val "R4 2026-09-18, cleanup_orphan_searching_rides: no email" "$(replay 2026-09-18)" "0|0|7"
val "R5 the 2026-09-21 outage, had pg_cron logged 'connection failed' instead of 'job startup timeout': still no email" \
  "$(replay 2026-09-21 'connection failed')" "0|1|4"

# E. contract
val "E1 anon and authenticated cannot execute either function; service_role can" \
  "SELECT string_agg(r || ':' || has_function_privilege(r, f, 'EXECUTE'), ' ' ORDER BY f, r) FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r, unnest(ARRAY['public.check_cron_sql_failures()', 'public.cron_sql_failures_now()']) AS f" \
  'anon:false authenticated:false service_role:true anon:false authenticated:false service_role:true'
val "E2 both keep SECURITY DEFINER, their volatility, owner postgres and the pinned search_path" \
  "SELECT string_agg(proname || ':' || prosecdef || ':' || provolatile::text || ':' || pg_get_userbyid(proowner) || ':' || array_to_string(proconfig, ','), ' ' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('check_cron_sql_failures', 'cron_sql_failures_now')" \
  'check_cron_sql_failures:true:v:postgres:search_path=public, pg_catalog cron_sql_failures_now:true:s:postgres:search_path=public, pg_catalog'
val "E3 the watchdog's cron job is untouched" \
  "SELECT count(*) || '|' || string_agg(schedule || '|' || command || '|' || username || '|' || active, ',') FROM cron.job WHERE jobname = 'check-cron-sql-failures'" \
  "1|45 * * * *|SELECT public.check_cron_sql_failures();|postgres|true"

# N. mutants: each undoes one decision in a copy of the migration, on its own database; a test must catch it
if [ "$MIG" != "none" ]; then
  TMPD="$(mktemp -d)"; MUT=""; out=""
  # mutate N OLD NEW -> writes the mutated copy to $MUT (OLD must occur exactly once)
  mutate(){ MUT="$TMPD/mutant-$1.sql"; "$PY" - "$MIG" "$MUT" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = open(sys.argv[1], encoding="utf-8").read().replace("\r", ""), sys.argv[2], sys.argv[3], sys.argv[4]
assert src.count(old) == 1, f"expected the target once, found {src.count(old)}: {old!r}"
out = src.replace(old, new)
assert out != src
open(dst, "w", encoding="utf-8", newline="\n").write(out)
PYEOF
  }
  mdb(){ echo "$BIN/psql $CONN -d ${DB}n$1 -qAt -v ON_ERROR_STOP=1"; }
  # N1: prod's body drifted from 00596's: the patch must refuse to touch it
  if fresh "${DB}n1" \
     && $(mdb 1) -c "DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.cron_sql_failures_now()'::regprocedure), '''server restarted''];', '''server restarted'', ''connection failed''];'); END \$\$;" >/dev/null 2>&1 \
     && [ "$(q "SELECT position('connection failed' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.cron_sql_failures_now()'::regprocedure" "$(mdb 1)")" = "t" ] \
     && out=$(apply "$MIG" "${DB}n1"); then
    ko "N1 a body that drifted from 00596's aborts the migration instead of being patched" "applied cleanly"
  elif echo "$out" | grep -q "is not the 00596 body this patches"; then ok "N1 a body that drifted from 00596's aborts the migration instead of being patched"
  else ko "N1 a body that drifted from 00596's aborts the migration instead of being patched" "$(echo "$out" | grep -m1 ERROR)"; fi
  # N2: a patch whose emails stop reaching send-email must be caught by the self-test at apply time
  if mutate 2 "url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email'," \
                "url     := 'https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-mail'," \
     && fresh "${DB}n2" && out=$(apply "$MUT" "${DB}n2"); then
    ko "N2 the self-test aborts a migration whose alert does not reach send-email" "the mutant applied cleanly"
  elif echo "$out" | grep -q "00597: the check queued 0 emails"; then ok "N2 the self-test aborts a migration whose alert does not reach send-email"
  else ko "N2 the self-test aborts a migration whose alert does not reach send-email" "$(echo "$out" | grep -m1 ERROR)"; fi
  # catch NAME N OLD NEW SQL CORRECT -> on the mutant, SQL must NOT print CORRECT
  catch(){ if mutate "$2" "$3" "$4" && fresh "${DB}n$2" && apply "$MUT" "${DB}n$2" >/dev/null; then
      local r; r=$(q "$5" "$(mdb "$2")" | paste -sd';' -)
      if [ "$r" != "$6" ]; then ok "$1 (mutant printed [$r])"; else ko "$1" "the mutant still printed [$r]"; fi
    else ko "$1" "could not build or apply the mutant"; fi; }
  catch "N3 C1 catches a watchdog that still counts every pg_cron failure" 3 \
    "OR COALESCE(d.return_message, '') LIKE 'ERROR:%'" "OR true" \
    "$RESET SELECT FROM t.seed('conn_failed', '0 * * * *', 'OCCCC', '1 hour', '10 minutes'); $RUN $ST" 'ok|[]|0'
  catch "N4 C6 catches a watchdog that forgets 'COPY not supported'" 4 \
    " = 'COPY not supported')" " = 'COPY not supported' AND false)" \
    "$RESET SELECT FROM t.seed('copy_job', '0 * * * *', 'OPPP', '1 hour', '10 minutes'); $RUN $ST" 'failing|["copy_job"]|3'
  # N5: check_cron_sql_failures() drifted: the migration aborts, and cron_sql_failures_now() is not
  # patched either (both patches are in one DO block: all or nothing)
  if fresh "${DB}n5" \
     && $(mdb 5) -c "DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.check_cron_sql_failures()'::regprocedure), 'Shared ops mailer from 00577', 'Shared ops mailer (00577)'); END \$\$;" >/dev/null 2>&1 \
     && [ "$(q "SELECT position('Shared ops mailer (00577)' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.check_cron_sql_failures()'::regprocedure" "$(mdb 5)")" = "t" ] \
     && out=$(apply "$MIG" "${DB}n5"); then
    ko "N5 a drifted check_cron_sql_failures() aborts the migration, and neither function is patched" "applied cleanly"
  elif echo "$out" | grep -q "check_cron_sql_failures() is not the 00596 body this patches" \
       && [ "$(q "SELECT position('00597:' IN prosrc) FROM pg_proc WHERE oid = 'public.cron_sql_failures_now()'::regprocedure" "$(mdb 5)")" = "0" ]; then
    ok "N5 a drifted check_cron_sql_failures() aborts the migration, and neither function is patched"
  else ko "N5 a drifted check_cron_sql_failures() aborts the migration, and neither function is patched" "$(echo "$out" | grep -m1 ERROR)"; fi
  # N6: the file read with CRLF against LF bodies (prod's): the abort says so instead of claiming a drift
  "$PY" -c "import sys; s = open(sys.argv[1], encoding='utf-8').read().replace('\r', ''); open(sys.argv[2], 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n'))" "$MIG" "$TMPD/crlf.sql"
  if fresh "${DB}n6" && out=$(raw_apply "$TMPD/crlf.sql" "${DB}n6"); then
    ko "N6 applying the file with CRLF line endings aborts with a message that says so" "applied cleanly"
  elif echo "$out" | grep -q "read with CRLF line endings"; then ok "N6 applying the file with CRLF line endings aborts with a message that says so"
  else ko "N6 applying the file with CRLF line endings aborts with a message that says so" "$(echo "$out" | grep -m1 ERROR)"; fi
  rm -rf "$TMPD"
  for n in 1 2 3 4 5 6; do $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n$n" >/dev/null 2>&1; done
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
