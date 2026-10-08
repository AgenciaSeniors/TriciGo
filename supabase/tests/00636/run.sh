#!/usr/bin/env bash
# Rehearsal runner for migration 00636 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00636/run.sh none
#       -> scaffold + seed + tests (RED: no cron job calls cleanup_rate_limits, and the
#          live body deletes everything older than 2 h, open 24 h windows included)
#   supabase/tests/00636/run.sh supabase/migrations/00636_rate_limits_retention.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00636/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr636
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# has NAME SQL PATTERN -> the output of SQL (errors included) must contain PATTERN (grep -E)
has(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r'); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $(echo "$r" | paste -sd' ' -)"; fi; }
# txn SQL -> SQL inside a transaction that is always rolled back
txn(){ printf "BEGIN; %s ROLLBACK;" "$1"; }

EXPIRED="(SELECT count(*) FROM public.rate_limits WHERE window_start < now() - interval '30 days')"
KEPT="(SELECT count(*) FROM public.rate_limits WHERE window_start >= now() - interval '30 days')"
COUNTS="SELECT $EXPIRED || ',' || $KEPT;"
# CLEAN -> one cleanup with the default batch, its result discarded (the live body returns void)
CLEAN='DO $c$ BEGIN PERFORM public.cleanup_rate_limits(); END $c$;'
OPEN_DAY="SELECT string_agg(key || '=' || count, ',' ORDER BY key) FROM public.rate_limits
          WHERE key IN ('send-sms-otp:foreign:daily', 'broadcast-emergency:day:a0000000-0000-4000-8000-000000000001');"
# fresh DBNAME [seed] -> a new database with the scaffold, and the seed when asked
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-}" = seed ]; then $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || return 1; fi; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB seed || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE proname IN ('check_rate_limit', 'cleanup_rate_limits')" \
  "check_rate_limit:5a2e61635bf60849be2e5ca41cbd9889/527,cleanup_rate_limits:100a31cff87d39e6c4e254db6155a7a8/76"
val "S1 like prod, a non-superuser owns rate_limits; RLS on, not forced, no policy" \
  "SELECT pg_get_userbyid(c.relowner) || '|' || r.rolsuper || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' ||
          (SELECT count(*) FROM pg_policies WHERE tablename = 'rate_limits')
   FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'public.rate_limits'::regclass" \
  "tricigo_owner|false|true|false|0"
val "S2 seeded: 49 expired rows, 8 that must survive" "$COUNTS" "49,8"

if [ "$MIG" != "none" ]; then
  # A database built from the history has an empty rate_limits: the migration must apply there too, probe included.
  fresh ${DB}e || { echo "scaffold failed"; exit 1; }
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 on an empty table the migration applies, probe included" || ko "M0 on an empty table the migration applies, probe included" "$r"
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration deletes nothing itself (the job drains the backlog) and its probe leaves no rows behind" \
    "SELECT $EXPIRED || ',' || $KEPT || ',' || (SELECT count(*) FROM public.rate_limits WHERE key LIKE 'zz_00636%')" "49,8,0"
fi

echo "== the job =="
val "C1 one pg_cron job calls the cleanup, hourly at minute 13" \
  "SELECT string_agg(jobname || '|' || schedule || '|' || command, ',') FROM cron.job WHERE command ILIKE '%cleanup_rate_limits%'" \
  "cleanup-rate-limits|13 * * * *|SELECT public.cleanup_rate_limits();"
val "C2 the other jobs are untouched" \
  "SELECT string_agg(jobname, ',' ORDER BY jobname) FROM cron.job WHERE jobname <> 'cleanup-rate-limits'" \
  "check-cron-sql-failures,prune-audit-log"

echo "== what the cleanup deletes =="
val "W1 open 24 h windows (20 h and 23 h old, at their caps) survive a cleanup" \
  "$(txn "$CLEAN $OPEN_DAY")" \
  "broadcast-emergency:day:a0000000-0000-4000-8000-000000000001=10,send-sms-otp:foreign:daily=20"
# In RED this one fails whenever the current UTC day started more than 2 h ago (the live body deletes the window).
val "W2 a 24 h cap reached today still blocks after a cleanup" \
  "$(txn "INSERT INTO public.rate_limits (key, window_start, count)
            VALUES ('w2:foreign', to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 20);
          $CLEAN
          SELECT allowed || ',' || current_count FROM public.check_rate_limit('w2:foreign', 20, 86400);")" \
  "false,21"
val "K1 every row younger than 30 days survives (29 d, 3 d, 10 min window, last hour, boundary 30 d - 10 min)" \
  "$(txn "$CLEAN $COUNTS")" "0,8"
val "K2 the 30-day boundary: 30 d + 10 min goes, 30 d - 10 min stays" \
  "$(txn "$CLEAN SELECT string_agg(key, ',') FROM public.rate_limits WHERE key LIKE 'link-phone:%';")" \
  "link-phone:189.126.33.215"
val "D1 one call with the default batch deletes the 49 expired rows" \
  "$(txn "$CLEAN $COUNTS")" "0,8"
val "D2 the return value is the number of rows deleted" \
  "$(txn "SELECT public.cleanup_rate_limits(); SELECT public.cleanup_rate_limits();")" "49;0"
val "L1 the limiter keeps counting in the current window across a cleanup" \
  "$(txn "SELECT current_count FROM public.check_rate_limit('l1:ip', 5, 60);
          SELECT current_count FROM public.check_rate_limit('l1:ip', 5, 60);
          $CLEAN
          SELECT current_count FROM public.check_rate_limit('l1:ip', 5, 60);")" "1;2;3"

echo "== batches =="
val "B1 batches of 20 drain the backlog over several calls: 20, 20, 9, 0" \
  "$(txn "SELECT public.cleanup_rate_limits(20); SELECT public.cleanup_rate_limits(20);
          SELECT public.cleanup_rate_limits(20); SELECT public.cleanup_rate_limits(20); $COUNTS")" "20;20;9;0;0,8"
val "B2 the oldest go first: a batch of 3 takes the three June rows" \
  "$(txn "SELECT public.cleanup_rate_limits(3);
          SELECT count(*) FILTER (WHERE window_start < now() - interval '100 days') || ',' || $EXPIRED FROM public.rate_limits;")" \
  "3;0,46"
val "B3 the default batch is 20000 (20049 expired rows: 20000, then 49, then 0)" \
  "$(txn "INSERT INTO public.rate_limits (key, window_start, count)
            SELECT 'b3:' || g, now() - interval '60 days' - g * interval '1 second', 1 FROM generate_series(1, 20000) g;
          SELECT public.cleanup_rate_limits(); SELECT public.cleanup_rate_limits(); SELECT public.cleanup_rate_limits(); $COUNTS")" \
  "20000;49;0;0,8"
has "B4 a batch below 1 is rejected" "$(txn "SELECT public.cleanup_rate_limits(0);")" "ERROR: .*batch"
val "B5 a NULL batch falls back to the default" "$(txn "SELECT public.cleanup_rate_limits(NULL);")" "49"

echo "== failures reach the cron watchdog =="
has "E1 an error inside the cleanup is raised, not swallowed (check_cron_sql_failures reads ERROR: from the run)" \
  "$(txn "ALTER TABLE public.rate_limits RENAME TO rate_limits_gone; $CLEAN")" \
  "ERROR: +relation \"rate_limits\" does not exist"

echo "== who can run it =="
val "P1 one cleanup_rate_limits, (p_batch integer DEFAULT 20000) returns integer, SECURITY DEFINER, search_path pinned" \
  "SELECT string_agg(pg_get_function_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || array_to_string(proconfig, ';'), ',')
   FROM pg_proc WHERE proname = 'cleanup_rate_limits'" \
  "p_batch integer DEFAULT 20000|integer|true|search_path=public, pg_catalog"
val "P2 anon and authenticated cannot execute it; service_role can" \
  "SELECT has_function_privilege('anon', p.oid, 'EXECUTE') || ',' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || ',' ||
          has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname = 'cleanup_rate_limits'" \
  "false,false,true"
val "P3 run as service_role it deletes (SECURITY DEFINER, the table has no policy)" \
  "$(txn "SET LOCAL ROLE service_role; SELECT public.cleanup_rate_limits(5);")" "5"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
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
  sabotage g1 "ORDER BY r.window_start" "ORDER BY r.window_start DESC"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "cleanup probe failed" && ok "G1 a cleanup that deletes the newest expired rows first aborts the migration" || ko "G1 a cleanup that deletes the newest expired rows first aborts the migration" "$r"
  sabotage g2 "REVOKE ALL ON FUNCTION public.cleanup_rate_limits(integer) FROM PUBLIC, anon, authenticated;" "-- revoke left out"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "executable by a client role" && ok "G2 a cleanup a client can execute aborts the migration" || ko "G2 a cleanup a client can execute aborts the migration" "$r"
  sabotage g3 "SELECT cron.schedule('cleanup-rate-limits', '13 * * * *', 'SELECT public.cleanup_rate_limits();');" "-- schedule left out"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "cron job cleanup-rate-limits" && ok "G3 a missing cron job aborts the migration" || ko "G3 a missing cron job aborts the migration" "$r"
  sabotage g4 "  RETURN v_deleted;" "  RETURN 0;"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g4.sql")
  echo "$r" | grep -q "cleanup probe failed" && ok "G4 a cleanup that misreports what it deleted aborts the migration (empty table)" || ko "G4 a cleanup that misreports what it deleted aborts the migration (empty table)" "$r"
  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
