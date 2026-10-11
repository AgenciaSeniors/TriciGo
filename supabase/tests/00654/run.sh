#!/usr/bin/env bash
# Rehearsal runner for migration 00654 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00654/run.sh none
#       -> scaffold + tests on the live prod bodies (RED: a rider, a driver and marketing can run
#          the collusion detector and read the /validation numbers, including each driver's
#          rejected offers; riders and drivers read peak hours and driver utilization)
#   supabase/tests/00654/run.sh supabase/migrations/00654_gate_panel_analytics_rpcs.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the migration's own
#          guards (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00654/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr654
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
# as UUID -> the rest of the transaction runs as that signed-in user (role authenticated + JWT subject)
as(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
# all3 -> the outcome of detector, peak hours and utilization; val3 -> the three /validation functions
ALL3="SELECT t.outcome('SELECT t.detect()'); SELECT t.outcome('SELECT t.peak()'); SELECT t.outcome('SELECT t.util()');"
VAL3="SELECT t.outcome('SELECT t.accept()'); SELECT t.outcome('SELECT t.nav()'); SELECT t.outcome('SELECT t.overrides()');"
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('detect_collusion_reviews', 'get_peak_hours', 'get_driver_utilization', 'get_auto_accept_rate', 'get_auto_nav_rate', 'get_override_frequency')"
NEW="detect_collusion_reviews:94558654ff2fdd4a0482099f2649b690,get_auto_accept_rate:d287cc0735f48cb5d621d71b82bd0456,get_auto_nav_rate:ea732c6b23a1f3654f44d52077e3bd70,get_driver_utilization:deb8280b477f4dc4ccf64acfcdd0cafa,get_override_frequency:32d90734b10ec562591c9362b61f11a7,get_peak_hours:29e882b3dfbf6c3f2d5ad5946d04e3d8"
ADMIN=00000000-0000-4000-8000-0000000000a1
MKT=00000000-0000-4000-8000-0000000000a2
RIDER=00000000-0000-4000-8000-0000000000c1
DRIVER=00000000-0000-4000-8000-0000000000d1
DENIED="raised 42501: forbidden: admin only"
PEAK="ok: 8|1.5,14|1.0"
UTIL="ok: 2|1|1|1"
VALIDATION="ok: high|3|2|1|66.7,low|1|0|1|0.0;ok: 4|3|1|75.0;ok: e1|2|2|0,e2|1|0|1"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND proname NOT LIKE 'pg\_%'" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,detect_collusion_reviews:47ea9b9b71a38098dd07b398bdeee87d/2981,get_auto_accept_rate:0a68bb7e05d942faaf870d066783115f/626,get_auto_nav_rate:b7ee2686794168da2e8a74a5b3d0f0d0/644,get_driver_utilization:47b8b33fb8a8583b558409faeb7034b0/653,get_override_frequency:cbf1219470c8402ec9c94cb956c9e682/494,get_peak_hours:f05bd1924513646349e38cacd817a0e4/476,get_platform_config_numeric:13d2587037eca74854cf2394ba42a90c/479,is_admin:22cb75e91980d512498034cd33e1eda2/285,is_marketing:1903156b6a1218a543888ae2ebfb3656/291,uid:cdef18c69c4f4cbbced2eaf81e628b49/176"
val "S1 like prod, postgres owns the public functions and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres')
   FROM pg_proc WHERE pronamespace = 'public'::regnamespace" "postgres|false"

if [ "$MIG" != "none" ]; then
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== the bodies =="
val "B1 the six functions have the gated bodies" "$BODIES" "$NEW"
val "B2 grants unchanged: not anon; authenticated and service_role can execute them" \
  "SELECT string_agg(proname || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ',' || has_function_privilege('authenticated', oid, 'EXECUTE')
          || ',' || has_function_privilege('service_role', oid, 'EXECUTE'), ' ' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('detect_collusion_reviews', 'get_peak_hours', 'get_driver_utilization', 'get_auto_accept_rate', 'get_auto_nav_rate', 'get_override_frequency')" \
  "detect_collusion_reviews:false,true,true get_auto_accept_rate:false,true,true get_auto_nav_rate:false,true,true get_driver_utilization:false,true,true get_override_frequency:false,true,true get_peak_hours:false,true,true"
val "B3 all six are plpgsql and still SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || l.lanname || ':' || p.prosecdef, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('detect_collusion_reviews', 'get_peak_hours', 'get_driver_utilization', 'get_auto_accept_rate', 'get_auto_nav_rate', 'get_override_frequency')" \
  "detect_collusion_reviews:plpgsql:true,get_auto_accept_rate:plpgsql:true,get_auto_nav_rate:plpgsql:true,get_driver_utilization:plpgsql:true,get_override_frequency:plpgsql:true,get_peak_hours:plpgsql:true"

echo "== who may call them =="
# RED: the rider runs the detector (one case written) and reads both reports.
val "C1 a rider gets 42501 from all three, and no case is written" \
  "$(txn "$(as $RIDER) $ALL3 RESET ROLE; SELECT t.cases();")" "$DENIED;$DENIED;$DENIED;<none>"
val "C2 a driver gets 42501 from all three, and no case is written" \
  "$(txn "$(as $DRIVER) $ALL3 RESET ROLE; SELECT t.cases();")" "$DENIED;$DENIED;$DENIED;<none>"
val "M1 marketing reads peak hours and driver utilization, but cannot run the detector" \
  "$(txn "$(as $MKT) $ALL3 RESET ROLE; SELECT t.cases();")" "$DENIED;$PEAK;$UTIL;<none>"
val "A1 an admin gets the same answers as before: one collusion case, the peak hours and the utilization" \
  "$(txn "$(as $ADMIN) $ALL3 RESET ROLE; SELECT t.cases();")" "ok: 1;$PEAK;$UTIL;e2/c1/60/pending/2"
val "A2 running the detector twice still keeps one pending case per pair" \
  "$(txn "$(as $ADMIN) SELECT t.outcome('SELECT t.detect()'); SELECT t.outcome('SELECT t.detect()'); RESET ROLE; SELECT t.cases();")" \
  "ok: 1;ok: 1;e2/c1/60/pending/2"
val "N1 without a JWT (service role, cron, SQL editor) all three refuse" \
  "$(txn "SET LOCAL ROLE service_role; $ALL3 RESET ROLE; SELECT t.cases();")" "$DENIED;$DENIED;$DENIED;<none>"
val "N2 anon cannot execute them at all (unchanged)" \
  "$(txn "SET LOCAL ROLE anon; $ALL3 $VAL3")" \
  "raised 42501: permission denied for function detect_collusion_reviews;raised 42501: permission denied for function get_peak_hours;raised 42501: permission denied for function get_driver_utilization;raised 42501: permission denied for function get_auto_accept_rate;raised 42501: permission denied for function get_auto_nav_rate;raised 42501: permission denied for function get_override_frequency"

echo "== the /validation numbers are admin-only =="
# RED: anyone signed in reads them, including how many offers each driver rejected.
val "V1 a rider and a driver get 42501 from the three /validation functions" \
  "$(txn "$(as $RIDER) $VAL3 RESET ROLE; $(as $DRIVER) $VAL3")" "$DENIED;$DENIED;$DENIED;$DENIED;$DENIED;$DENIED"
val "V2 marketing gets 42501 too (/validation is not a marketing page)" \
  "$(txn "$(as $MKT) $VAL3")" "$DENIED;$DENIED;$DENIED"
val "V3 an admin gets the same numbers as before" \
  "$(txn "$(as $ADMIN) $VAL3")" "$VALIDATION"
val "V4 without a JWT (service role, cron, SQL editor) they refuse" \
  "$(txn "SET LOCAL ROLE service_role; $VAL3")" "$DENIED;$DENIED;$DENIED"

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
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$NEW" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.detect_collusion_reviews()'::regprocedure),
      'RETURN v_count;', 'RETURN v_count; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "detect_collusion_reviews() has a body this migration does not know" && ok "G1 a detector body that drifted from prod aborts the migration" || ko "G1 a detector body that drifted from prod aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_peak_hours(integer)'::regprocedure),
      'ORDER BY h.hour;', 'ORDER BY h.hour; -- drift'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "get_peak_hours(integer) has a body this migration does not know" && ok "G2 a peak-hours body that drifted from prod aborts the migration" || ko "G2 a peak-hours body that drifted from prod aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_override_frequency(integer,integer)'::regprocedure),
      'LIMIT p_limit', 'LIMIT p_limit + 1'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "get_override_frequency(integer,integer) has a body this migration does not know" && ok "G2b an override-frequency body that drifted from prod aborts the migration" || ko "G2b an override-frequency body that drifted from prod aborts the migration" "$r"

  sabotage g3 "c_md5_new CONSTANT text := '94558654ff2fdd4a0482099f2649b690';" "c_md5_new CONSTANT text := '00000000000000000000000000000000';"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "was patched to md5 94558654ff2fdd4a0482099f2649b690, expected 00000000000000000000000000000000" && ok "G3 a patch that does not produce the expected body aborts the migration" || ko "G3 a patch that does not produce the expected body aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "GRANT EXECUTE ON FUNCTION public.get_driver_utilization() TO anon" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "get_driver_utilization() is executable by anon" && ok "G4 a function anon can execute aborts the migration" || ko "G4 a function anon can execute aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "REVOKE EXECUTE ON FUNCTION public.get_peak_hours(integer) FROM authenticated" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "get_peak_hours(integer) is no longer executable by authenticated" && ok "G5 a function admins could no longer call aborts the migration" || ko "G5 a function admins could no longer call aborts the migration" "$r"

  # G6: a gate that lets everyone through (here, an is_admin() that always says yes) is caught
  # by the behavioural check, not only by the md5s.
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET SESSION AUTHORIZATION postgres;
    CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true';" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "detect_collusion_reviews() answered without an admin or marketing user" && ok "G6 a gate that does not refuse aborts the migration" || ko "G6 a gate that does not refuse aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
