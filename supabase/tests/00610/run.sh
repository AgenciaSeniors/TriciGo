#!/usr/bin/env bash
# Rehearsal runner for migration 00610 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00610/run.sh none
#       -> scaffold + tests (RED: any signed-in user, and anon for _waypoint_pricing,
#          can call the seven internal helpers)
#   supabase/tests/00610/run.sh supabase/migrations/00610_lock_internal_dispatch_and_wallet_helpers.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00610/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr610
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# has NAME SQL PATTERN -> the output of SQL must contain PATTERN (grep -E)
has(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r'); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $(echo "$r" | paste -sd' ' -)"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001     # any signed-in user
DRIVER=d0000000-0000-4000-8000-000000000001    # someone else's driver profile
# as UID ROLE SQL -> SQL as that role with JWT subject UID (as PostgREST would), rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s; %s ROLLBACK;" "$1" "$2" "$3"; }
DENIED="permission denied for function"
SEVEN="'check_driver_eligibility','driver_can_afford_commission','find_best_drivers','_waypoint_pricing','get_driver_user_id','can_send_sms','driver_no_gps_rides_this_week'"
# who may execute a set of functions: anon/authenticated/service_role, t or f each
privs(){ echo "SELECT string_agg(p.proname || ':' ||
         has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('service_role', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($1)"; }
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 get_driver_user_id carries the live prod body (md5/length of prosrc)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE proname = 'get_driver_user_id'" \
  "a11e7a77d9dcdea08e08d0c8346d9dbc/71"
val "S1 like prod, a non-superuser owns the functions" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(p.proowner) || '|' || r.rolsuper, ',') FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($SEVEN)" "tricigo_owner|false"

if [ "$MIG" = "none" ]; then
  val "S2 who may execute the seven is what prod shows on 2026-10-06" "$(privs "$SEVEN")" \
    "_waypoint_pricing:true/true/true,can_send_sms:false/true/true,check_driver_eligibility:false/true/true,driver_can_afford_commission:false/true/true,driver_no_gps_rides_this_week:false/true/true,find_best_drivers:false/true/true,get_driver_user_id:false/true/true"
else
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 after the migration only service_role runs the seven" "$(privs "$SEVEN")" \
    "_waypoint_pricing:false/false/true,can_send_sms:false/false/true,check_driver_eligibility:false/false/true,driver_can_afford_commission:false/false/true,driver_no_gps_rides_this_week:false/false/true,find_best_drivers:false/false/true,get_driver_user_id:false/false/true"
  val "M2 the probe left nothing behind" \
    "SELECT count(*) FROM pg_proc WHERE proname = 'zz_00610_probe'" "0"
fi

echo "== a signed-in user acting on someone else =="
has "L1 cannot flag another driver's financial eligibility" \
  "$(as $RIDER authenticated "SELECT public.check_driver_eligibility('$DRIVER');")" "$DENIED check_driver_eligibility"
has "L2 cannot read another driver's wallet balance" \
  "$(as $RIDER authenticated "SELECT public.driver_can_afford_commission('$DRIVER', 2000);")" "$DENIED driver_can_afford_commission"
has "L3 cannot list drivers with their distance to a point of their choice" \
  "$(as $RIDER authenticated "SELECT * FROM public.find_best_drivers(23.13, -82.36, 'triciclo_basico');")" "$DENIED find_best_drivers"
has "L4 cannot price another rider's route" \
  "$(as $RIDER authenticated "SELECT * FROM public._waypoint_pricing(gen_random_uuid());")" "$DENIED _waypoint_pricing"
has "L5 neither can anon (it had EXECUTE through PUBLIC)" \
  "$(as '' anon "SELECT * FROM public._waypoint_pricing(gen_random_uuid());")" "$DENIED _waypoint_pricing"
has "L6 cannot map a driver profile to its user" \
  "$(as $RIDER authenticated "SELECT public.get_driver_user_id('$DRIVER');")" "$DENIED get_driver_user_id"
has "L7 cannot probe someone's SMS count" \
  "$(as $RIDER authenticated "SELECT public.can_send_sms('$RIDER', 5);")" "$DENIED can_send_sms"
has "L8 cannot read a driver's no-GPS ride count" \
  "$(as $RIDER authenticated "SELECT public.driver_no_gps_rides_this_week('$DRIVER');")" "$DENIED driver_no_gps_rides_this_week"

echo "== what must keep working =="
val "K1 dispatch: a SECURITY DEFINER caller run by a signed-in user still gets drivers" \
  "$(as $RIDER authenticated "SELECT public.zz_dispatch_like();")" "1"
val "K2 accept: a SECURITY DEFINER caller still checks the driver's balance" \
  "$(as $RIDER authenticated "SELECT public.zz_accept_like();")" "t"
val "K3 notify triggers and the waypoint preview still reach their helpers" \
  "$(as $RIDER authenticated "SELECT public.zz_trigger_like();")" "a0000000-0000-4000-8000-000000000002|true|90"
val "K4 service_role still calls them directly (Edge Functions, scripts)" \
  "$(printf "BEGIN; SET LOCAL ROLE service_role; SELECT public.get_driver_user_id('$DRIVER')::text || '|' || (SELECT count(*) FROM public.find_best_drivers(23.13, -82.36, 'triciclo_basico')); ROLLBACK;")" \
  "a0000000-0000-4000-8000-000000000002|1"
val "K5 the functions the apps call are untouched" \
  "$(privs "'calculate_cancellation_fee','check_accept_ride_eligibility'")" \
  "calculate_cancellation_fee:false/true/true,check_accept_ride_eligibility:false/true/true"

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
open(dst, 'w', encoding='utf-8').write(s2)
PYEOF
  }
  sabotage g1 "'check_driver_eligibility', 'driver_can_afford_commission', 'find_best_drivers',
    '_waypoint_pricing'," "'check_driver_eligibility', 'driver_can_afford_commission',
    '_waypoint_pricing',"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "authenticated can still execute public.find_best_drivers" && ok "G1 a function left off the revoke list aborts the migration" || ko "G1 a function left off the revoke list aborts the migration" "$r"
  sabotage g2 "FROM PUBLIC, anon, authenticated', r.sig);" "FROM anon, authenticated', r.sig);"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "anon can still execute public._waypoint_pricing" && ok "G2 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" || ko "G2 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" "$r"
  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "SET ROLE tricigo_owner; ALTER FUNCTION public.can_send_sms(uuid, integer) RENAME TO can_send_sms_old;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "functions not found: {can_send_sms}" && ok "G3 a function that no longer exists aborts the migration" || ko "G3 a function that no longer exists aborts the migration" "$r"
  sabotage g4 "LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_catalog'
      AS \$p\$" "LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public', 'pg_catalog'
      AS \$p\$"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g4.sql")
  echo "$r" | grep -q "$DENIED get_driver_user_id" && ok "G4 the probe really runs as a signed-in user (an INVOKER wrapper aborts the migration)" || ko "G4 the probe really runs as a signed-in user (an INVOKER wrapper aborts the migration)" "$r"
  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
