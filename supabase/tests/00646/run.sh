#!/usr/bin/env bash
# Rehearsal runner for migration 00646 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00646/run.sh none
#       -> scaffold + tests on the live prod body of retry_dispatch_expired_rides (RED:
#          one ride that makes dispatch_ride fail rolls back the whole run, so no
#          ride is re-dispatched)
#   supabase/tests/00646/run.sh supabase/migrations/00646_retry_dispatch_per_ride.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the
#          migration's own guards (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00646/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr646
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

BODY="SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.retry_dispatch_expired_rides()'::regprocedure"
NEW=12ae559c73b0f583f2fb64a5d971b98e
R1=00000000-0000-4000-8000-000000000001
R2=00000000-0000-4000-8000-000000000002
R3=00000000-0000-4000-8000-000000000003
NONE_PREFIX='ERROR:  retry_dispatch_expired_rides: none of the'

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('retry_dispatch_expired_rides', 'log_rpc_attempt', 'cron_sql_failures_now')" \
  "cron_sql_failures_now:0557d22d014590c631e8d300d2651100/2078,log_rpc_attempt:0a902c34a1148dac5686403a7c941bc0/203,retry_dispatch_expired_rides:44da5d968977eadfcec31e0f7dbd959e/1029"
val "S1 like prod, postgres owns them and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace" "postgres|false"

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== the body =="
val "B1 the body is the live one with the three patches, and has two handlers (per ride, reactivation push)" \
  "$BODY; SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE oid = 'public.retry_dispatch_expired_rides()'::regprocedure), 'exception\s+when', 'gi');" \
  "$NEW;2"
val "B2 anon and authenticated cannot execute it; service_role can; the job is unchanged" \
  "SELECT has_function_privilege('anon', 'public.retry_dispatch_expired_rides()'::regprocedure, 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.retry_dispatch_expired_rides()'::regprocedure, 'EXECUTE') || ',' ||
          has_function_privilege('service_role', 'public.retry_dispatch_expired_rides()'::regprocedure, 'EXECUTE');
   SELECT schedule || '|' || command || '|' || active FROM cron.job WHERE jobname = 'retry-dispatch-expired-rides';" \
  "false,false,true;*/1 * * * *|SELECT retry_dispatch_expired_rides();|true"

echo "== normal runs still work =="
val "H1 the eligible rides are re-dispatched; a ride with a pending offer and a round-0 ride are skipped" \
  "$(txn "CALL t.seed(3); SELECT public.retry_dispatch_expired_rides(); SELECT t.state();")" \
  "3;01:2:1,02:2:1,03:2:1,aa:1:1,bb:0:0"
val "H2 with no eligible ride the run succeeds and returns 0" \
  "$(txn "CALL t.seed(0); SELECT public.retry_dispatch_expired_rides(); SELECT t.run_job('retry-dispatch-expired-rides');")" \
  "0;succeeded: 1 row"
val "H3 a failed reactivation push still does not stop the re-dispatch (unchanged behaviour)" \
  "$(txn "SET LOCAL test.push_fails = '1'; CALL t.seed(3);
          SELECT t.outcome('SELECT to_jsonb(public.notify_offline_drivers_for_searching_rides())');
          SELECT public.retry_dispatch_expired_rides(); SELECT t.state();")" \
  "raised: stub: reactivation push failed;3;01:2:1,02:2:1,03:2:1,aa:1:1,bb:0:0"

echo "== one bad ride =="
# RED: the error escapes, the whole statement rolls back and no ride is re-dispatched.
val "F1 a ride that makes dispatch_ride fail is skipped; the others are re-dispatched; its partial offer rolls back" \
  "$(txn "SET LOCAL test.poison = '$R2'; CALL t.seed(3); SELECT public.retry_dispatch_expired_rides(); SELECT t.state();")" \
  "2;01:2:1,02:1:0,03:2:1,aa:1:1,bb:0:0"
val "F2 the skipped ride is logged in rpc_attempt_log with its error" \
  "$(txn "SET LOCAL test.poison = '$R2'; CALL t.seed(3); SELECT public.retry_dispatch_expired_rides();
          SELECT rpc_name || '|' || (caller_uid IS NULL) || '|' || target_id || '|' || outcome || '|' || (metadata ->> 'sqlstate') || '|' || (metadata ->> 'error')
          FROM public.rpc_attempt_log;")" \
  "2;retry_dispatch_expired_rides|true|$R2|dispatch_failed|23514|stub: dispatch_ride failed for ride $R2"
# Through the job: the first run serves the healthy rides; once only the bad ride is eligible, every run
# fails, and after 3 failed runs check_cron_sql_failures reports the job.
# RED: every run fails on the bad ride and the healthy rides are never re-dispatched (01:1:0, 03:1:0).
val "F3 once only the bad ride is left, each run fails and check_cron_sql_failures reports the job" \
  "$(txn "SET LOCAL test.poison = '$R2'; CALL t.seed(3);
          SELECT t.run_job('retry-dispatch-expired-rides'); SELECT t.run_job('retry-dispatch-expired-rides');
          SELECT t.run_job('retry-dispatch-expired-rides'); SELECT t.run_job('retry-dispatch-expired-rides');
          SELECT '[' || t.flagged() || ']'; SELECT t.state();")" \
  "succeeded: 1 row;failed: $NONE_PREFIX 1 rides could be re-dispatched, last error: ride $R2: 23514 stub: dispatch_ride failed for ride $R2;failed: $NONE_PREFIX 1 rides could be re-dispatched, last error: ride $R2: 23514 stub: dispatch_ride failed for ride $R2;failed: $NONE_PREFIX 1 rides could be re-dispatched, last error: ride $R2: 23514 stub: dispatch_ride failed for ride $R2;[retry-dispatch-expired-rides];01:2:1,02:1:0,03:2:1,aa:1:1,bb:0:0"
# A failed run rolls back its rpc_attempt_log rows: the run's error text is the record.
val "F4 if every eligible ride fails (a broken dispatch_ride), the run fails with the count and keeps no log row" \
  "$(txn "SET LOCAL test.poison = '$R1,$R2,$R3'; CALL t.seed(3);
          SELECT split_part(t.run_job('retry-dispatch-expired-rides'), ', last error', 1); SELECT t.state();
          SELECT count(*) FROM public.rpc_attempt_log;")" \
  "failed: $NONE_PREFIX 3 rides could be re-dispatched;01:1:0,02:1:0,03:1:0,aa:1:1,bb:0:0;0"

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
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same body.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODY" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$NEW" ] && ok "G0 with CRLF line endings the migration produces the same body" || ko "G0 with CRLF line endings the migration produces the same body" "$r / $b"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.retry_dispatch_expired_rides()'::regprocedure),
      'RETURN v_processed;', 'RETURN v_processed; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "has a body this migration does not know" && ok "G1 a body that drifted from prod aborts the migration" || ko "G1 a body that drifted from prod aborts the migration" "$r"

  sabotage g2 "c_md5_new  CONSTANT text := '12ae559c73b0f583f2fb64a5d971b98e';" "c_md5_new  CONSTANT text := '00000000000000000000000000000000';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "was patched to md5 12ae559c73b0f583f2fb64a5d971b98e, expected 00000000000000000000000000000000" && ok "G2 a patch that does not produce the expected body aborts the migration" || ko "G2 a patch that does not produce the expected body aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "UPDATE cron.job SET active = false WHERE jobname = 'retry-dispatch-expired-rides'" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "cron job retry-dispatch-expired-rides is missing or inactive" && ok "G3 an inactive job aborts the migration" || ko "G3 an inactive job aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "GRANT EXECUTE ON FUNCTION public.retry_dispatch_expired_rides() TO authenticated" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "retry_dispatch_expired_rides is executable by a client role" && ok "G4 a function a client can execute aborts the migration" || ko "G4 a function a client can execute aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
