#!/usr/bin/env bash
# Rehearsal runner for migration 00630 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00630/run.sh none
#       -> scaffold + seed + tests (RED: any signed-in user, driver or admin calls
#          dispatch_ride and forces a dispatch round on someone else's searching ride)
#   supabase/tests/00630/run.sh supabase/migrations/00630_dispatch_ride_no_client_execute.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00630/run.sh ...
set -u
# Git Bash: with MSYS_NO_PATHCONV=1 (handy for adb), /c/... paths reach psql.exe unconverted.
unset MSYS_NO_PATHCONV
# Server messages in English, so the error patterns match on any cluster (the suite runs as a superuser).
export PGOPTIONS='-c lc_messages=C'
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
# The SQL files are UTF-8 (two live bodies carry non-ASCII characters). psql on Windows
# otherwise reads them in the console code page when its output is redirected.
export PGCLIENTENCODING=UTF8
DB=pr630
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# run DBNAME SQL -> psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql
# ends its lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines are dropped.
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED -> the output of SQL, rows joined with ';', must equal EXPECTED
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# has NAME SQL PATTERN -> the output of SQL must contain PATTERN (grep -E)
has(){ local r; r=$(run $DB "$2"); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $r"; fi; }

ROSA=a0000000-0000-4000-8000-000000000001    # customer; RIDE_A is hers
MALLO=a0000000-0000-4000-8000-000000000002   # any other signed-in customer
ADA=a0000000-0000-4000-8000-000000000003     # admin
U_D1=b0000000-0000-4000-8000-0000000000d1    # the user behind driver D1
U_D3=b0000000-0000-4000-8000-0000000000d3    # the user behind driver D3 (offline in the seed)
D1=d0000000-0000-4000-8000-000000000001
D3=d0000000-0000-4000-8000-000000000003
RIDE_A=f0000000-0000-4000-8000-00000000000a  # searching, round 1; D1 and D2 offers expired 5 min ago
RIDE_N=f0000000-0000-4000-8000-0000000000b1  # created by K1
RIDE_C=f0000000-0000-4000-8000-0000000000c1  # cargo ride created by K2
RIDE_F=f0000000-0000-4000-8000-0000000000f1  # in_progress ride that D1 finishes in K4
RIDE_S=f0000000-0000-4000-8000-0000000000e1  # ride scheduled 5 minutes ahead, K6

DENIED="42501: permission denied for function dispatch_ride"
# state RIDE -> dispatch_round|live offers|pushes queued for that ride
state(){ printf "SELECT r.dispatch_round || '|' ||
  (SELECT count(*) FROM public.ride_offers o WHERE o.ride_id = r.id AND o.status = 'pending' AND o.expires_at > now()) || '|' ||
  (SELECT count(*) FROM net.http_request_queue q WHERE q.body->'data'->>'ride_id' = r.id::text)
  FROM public.rides r WHERE r.id = '%s';" "$1"; }
# as UID ROLE -> the role and JWT subject PostgREST would set for that caller, until RESET ROLE
as(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s;" "$1" "$2"; }
# who may execute each dispatch_ride overload: anon/authenticated/service_role, true or false each
PRIVS="SELECT string_agg(p.oid::regprocedure::text || ':' ||
         has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('service_role', p.oid, 'EXECUTE')::text || ' ' || p.proacl::text, ',')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'dispatch_ride'"
# fresh DBNAME [seed] -> a new database with the scaffold, and the seed when asked
fresh(){ "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-}" = seed ]; then "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || return 1; fi; }
# apply DBNAME FILE [-1] -> applies FILE as the owner (in one transaction with -1); prints everything psql said
# and, last, 'applied' or 'failed'
apply(){ local out rc; out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose ${3:-} -c "$AS_OWNER" -f "$2" 2>&1); rc=$?
         echo "$out" | tr -d '\r'; [ $rc -eq 0 ] && echo applied || echo failed; }
# apply_err DBNAME FILE -> applies FILE in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local r; r=$(apply "$1" "$2" -1); if [ "$(echo "$r" | tail -1)" = applied ]; then echo applied; else echo "$r" | grep -m1 ERROR; fi; }
# body DBNAME FILE -> dispatch_ride's prosrc, as stored, into FILE
body(){ "$BIN/psql" $CONN -d "$1" -qAt -c "SELECT prosrc FROM pg_proc WHERE oid = 'public.dispatch_ride(uuid,integer)'::regprocedure" | tr -d '\r' > "$2"; }
# shape: owner|owner is superuser|SECURITY DEFINER|proconfig|md5/length of the body
SHAPE="SELECT pg_get_userbyid(p.proowner) || '|' || r.rolsuper || '|' || p.prosecdef || '|' || array_to_string(p.proconfig, ',') || '|' ||
         md5(p.prosrc) || '/' || length(p.prosrc)
       FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = 'public.dispatch_ride(uuid,integer)'::regprocedure"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== reset database =="
fresh $DB seed || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE proname IN ('uid', 'current_user_role', 'is_admin', 'get_platform_config_numeric', 'dispatch_ride',
                     'on_ride_insert_dispatch', 'tg_dispatch_on_delivery_details', 'dispatch_searching_rides_near_driver',
                     'dispatch_searching_rides_for_driver', 'tg_redispatch_searching_on_ride_freed',
                     'retry_dispatch_expired_rides', 'activate_scheduled_rides', 'notify_driver_new_offer')" \
  "activate_scheduled_rides:4ccac5902f86f94f4b4b4d3d2a7743e1/731,current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,dispatch_ride:a16ae76866950dedd21d33595f345d63/5537,dispatch_searching_rides_for_driver:5bb66ef3d51603259b1e39b8f830c806/615,dispatch_searching_rides_near_driver:2b34bc2c1c0b82917ca81dbadaf679eb/181,get_platform_config_numeric:13d2587037eca74854cf2394ba42a90c/479,is_admin:22cb75e91980d512498034cd33e1eda2/285,notify_driver_new_offer:6226f91fe0acacd99b298718a3c35937/2181,on_ride_insert_dispatch:93a4c0c44b85f4ed41ff6ba9785e9fd4/403,retry_dispatch_expired_rides:44da5d968977eadfcec31e0f7dbd959e/1029,tg_dispatch_on_delivery_details:88a12f75dfa77176dfdadb48376819a3/591,tg_redispatch_searching_on_ride_freed:97283c1dd46d529810292e0c9ed9de8e/129,uid:cdef18c69c4f4cbbced2eaf81e628b49/176"
val "S0b and their SECURITY DEFINER flag, owner and SET clause are prod's" \
  "SELECT string_agg(proname || ':' || prosecdef || ':' || pg_get_userbyid(proowner) || ':' || coalesce(array_to_string(proconfig, ';'), '-'), ','
          ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('current_user_role', 'is_admin', 'get_platform_config_numeric',
     'dispatch_ride', 'on_ride_insert_dispatch', 'tg_dispatch_on_delivery_details', 'dispatch_searching_rides_near_driver',
     'dispatch_searching_rides_for_driver', 'tg_redispatch_searching_on_ride_freed', 'retry_dispatch_expired_rides',
     'activate_scheduled_rides', 'notify_driver_new_offer')" \
  "activate_scheduled_rides:true:postgres:search_path=public, pg_catalog,current_user_role:true:postgres:search_path=public, pg_catalog,dispatch_ride:true:postgres:search_path=public, pg_catalog,dispatch_searching_rides_for_driver:true:postgres:search_path=public, pg_catalog,dispatch_searching_rides_near_driver:true:postgres:search_path=public, pg_catalog,get_platform_config_numeric:true:postgres:search_path=public, pg_catalog,is_admin:false:postgres:search_path=public, extensions, pg_catalog,notify_driver_new_offer:true:postgres:search_path=public, pg_catalog,on_ride_insert_dispatch:true:postgres:search_path=public, pg_catalog,retry_dispatch_expired_rides:true:postgres:search_path=public, pg_catalog,tg_dispatch_on_delivery_details:true:postgres:search_path=public, pg_catalog,tg_redispatch_searching_on_ride_freed:true:postgres:search_path=public, pg_catalog"
val "S0c the six triggers that reach dispatch_ride or its pushes are prod's (md5 of pg_get_triggerdef)" \
  "SELECT md5(string_agg(pg_get_triggerdef(t.oid), E'\n' ORDER BY t.tgname)) || '/' || count(*) FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgname IN ('trg_on_ride_insert_dispatch', 'trg_redispatch_searching_on_ride_freed',
     'trg_dispatch_on_delivery_details', 'trg_dispatch_on_driver_online', 'trg_notify_driver_new_offer', 'trg_notify_driver_reoffer')" \
  "31a88d11e36858e580e6de33f225bd19/6"
val "S1 like prod, a NON-superuser role named postgres owns dispatch_ride, SECURITY DEFINER, search_path public, pg_catalog" \
  "$SHAPE" "postgres|false|true|search_path=public, pg_catalog|a16ae76866950dedd21d33595f345d63/5537"
val "S2 the seed: RIDE_A is searching, round 1, no live offer, no push; D1 and D2 hold expired offers" \
  "$(state $RIDE_A) SELECT count(*) FROM public.ride_offers WHERE ride_id = '$RIDE_A' AND status = 'expired';" "1|0|0;2"
val "S3 like prod, postgres is a member of anon, authenticated and service_role and inherits their privileges" \
  "SELECT pg_has_role('postgres', 'anon', 'USAGE') || '|' || pg_has_role('postgres', 'authenticated', 'USAGE') || '|' ||
          pg_has_role('postgres', 'service_role', 'USAGE');" "true|true|true"

if [ "$MIG" = "none" ]; then
  val "S4 who may execute dispatch_ride is what prod shows on 2026-10-07" "$PRIVS" \
    "dispatch_ride(uuid,integer):false/true/true {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}"
  echo "== the hole, as it is in prod =="
  val "E1 a signed-in customer forces a new round on Rosa's ride: D1 and D2 re-armed, D4 offered, a push each, round 1 -> 2" \
    "BEGIN; $(state $RIDE_A) $(as $MALLO authenticated) SELECT public.dispatch_ride('$RIDE_A')->>'offers_created'; RESET ROLE;
     $(state $RIDE_A) SELECT string_agg(right(q.body->>'user_id', 2), ',' ORDER BY q.body->>'user_id') FROM net.http_request_queue q; ROLLBACK;" \
    "1|0|0;3;2|3|3;d1,d2,d4"
else
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  body $DB "$T/before.txt"
  r=$(apply $DB "$MIG" -1); [ "$(echo "$r" | tail -1)" = applied ] || { echo "$r"; echo "migration failed"; exit 1; }
  body $DB "$T/after1.txt"
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  r2=$(apply $DB "$MIG"); [ "$(echo "$r2" | tail -1)" = applied ] || { echo "$r2"; echo "migration NOT idempotent"; exit 1; }
  body $DB "$T/after2.txt"
  val "M1 after the migration only the owner and service_role may execute it" "$PRIVS" \
    "dispatch_ride(uuid,integer):false/false/true {postgres=X/postgres,service_role=X/postgres}"
  d=$("$PY" - "$T/before.txt" "$T/after1.txt" <<'PYEOF'
import difflib, sys
a = open(sys.argv[1], encoding='utf-8').read().split('\n')
b = open(sys.argv[2], encoding='utf-8').read().split('\n')
removed = [l[2:].strip() for l in difflib.ndiff(a, b) if l.startswith('- ')]
added = [l[2:] for l in difflib.ndiff(a, b) if l.startswith('+ ')]
code = [l for l in added if l.strip() and not l.strip().startswith('--')]
print('removed: ' + ' | '.join(removed) + ' / added: %d comment lines, %d code lines' % (len(added) - len(code), len(code)))
PYEOF
)
  exp="removed: IF pg_trigger_depth() = 0 AND current_user <> 'postgres' AND NOT is_admin() THEN | RAISE EXCEPTION 'Forbidden: dispatch_ride is internal-only'; | END IF; / added: 4 comment lines, 0 code lines"
  [ "$d" = "$exp" ] && ok "M2 the body lost exactly the three lines of the old check and gained only comments" || ko "M2 the body lost exactly the three lines of the old check and gained only comments" "got [$d]"
  # The md5 is the patched body this migration leaves in prod, computed outside the migration
  # (the live body with the three lines swapped for the comment, in Python); M2 proves its content.
  val "M3 owner, SECURITY DEFINER and search_path unchanged; the new body is the expected one" \
    "$SHAPE" "postgres|false|true|search_path=public, pg_catalog|adec90cbff82dd8ffb77c07bfefa3086/5673"
  echo "$r2" | grep -q "00630: dispatch_ride carries no current_user check; body unchanged" && cmp -s "$T/after1.txt" "$T/after2.txt" \
    && ok "M4 the 2nd run finds no check left, says so and leaves the body alone" \
    || ko "M4 the 2nd run finds no check left, says so and leaves the body alone" "$(echo "$r2" | grep -m1 -E 'NOTICE|ERROR') / cmp $(cmp "$T/after1.txt" "$T/after2.txt" 2>&1)"
  # A database rebuilt from the migration history: PUBLIC (so anon) and authenticated hold EXECUTE.
  fresh ${DB}m || { echo "scaffold failed"; exit 1; }
  run ${DB}m "GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) TO PUBLIC, anon, authenticated, service_role;" >/dev/null
  r=$(apply_err ${DB}m "$MIG"); p=$(run ${DB}m "$PRIVS")
  [ "$r" = applied ] && [ "$p" = "dispatch_ride(uuid,integer):false/false/true {postgres=X/postgres,service_role=X/postgres}" ] \
    && ok "M5 where PUBLIC, anon and authenticated all hold EXECUTE (a rebuild from history), it closes all three" \
    || ko "M5 where PUBLIC, anon and authenticated all hold EXECUTE (a rebuild from history), it closes all three" "$r / $p"
  # A body that drifted (the old check reformatted): the patch must not block the revoke.
  fresh ${DB}m || { echo "scaffold failed"; exit 1; }
  run ${DB}m "SET ROLE postgres; DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.dispatch_ride(uuid,integer)'::regprocedure),
    'AND current_user <> ''postgres'' AND', 'AND current_user  <>  ''postgres'' AND'); END \$d\$;" >/dev/null
  b1=$(run ${DB}m "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.dispatch_ride(uuid,integer)'::regprocedure")
  r=$(apply ${DB}m "$MIG" -1)
  b2=$(run ${DB}m "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.dispatch_ride(uuid,integer)'::regprocedure"); p=$(run ${DB}m "$PRIVS")
  [ "$(echo "$r" | tail -1)" = applied ] && echo "$r" | grep -q "00630: dispatch_ride still has a current_user check, not in the expected form; body unchanged" \
    && [ "$b1" = "$b2" ] && [ "$p" = "dispatch_ride(uuid,integer):false/false/true {postgres=X/postgres,service_role=X/postgres}" ] \
    && ok "M6 a body whose old check drifted is left alone (NOTICE), and EXECUTE is closed all the same" \
    || ko "M6 a body whose old check drifted is left alone (NOTICE), and EXECUTE is closed all the same" "$(echo "$r" | grep -m1 -E 'NOTICE|ERROR') / $b1 -> $b2 / $p"
fi

echo "== the hole: no signed-in user may call it =="
has "L1 a signed-in customer cannot dispatch someone else's ride" \
  "BEGIN; $(as $MALLO authenticated) SELECT public.dispatch_ride('$RIDE_A'); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "$DENIED"
has "L2 nor can the ride's own customer" \
  "BEGIN; $(as $ROSA authenticated) SELECT public.dispatch_ride('$RIDE_A'); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "$DENIED"
has "L3 nor a signed-in driver (ride ids reach drivers in every offer push)" \
  "BEGIN; $(as $U_D1 authenticated) SELECT public.dispatch_ride('$RIDE_A'); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "$DENIED"
has "L4 nor an admin: the panel never calls it" \
  "BEGIN; $(as $ADA authenticated) SELECT public.dispatch_ride('$RIDE_A'); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "$DENIED"
has "L5 anon is refused, as before" \
  "BEGIN; $(as '' anon) SELECT public.dispatch_ride('$RIDE_A'); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "$DENIED"

echo "== every internal caller still dispatches =="
K1_SQL="BEGIN; $(as $MALLO authenticated)
   INSERT INTO public.rides (id, customer_id, service_type, pickup_location, pickup_address, estimated_fare_cup, estimated_distance_m)
   VALUES ('$RIDE_N', '$MALLO', 'triciclo_basico', 'POINT(-82.3830 23.1330)', 'Vedado', 1500, 3000);
   RESET ROLE; $(state $RIDE_N) ROLLBACK;"
K3_SQL="BEGIN; $(as $U_D3 authenticated) UPDATE public.driver_profiles SET is_online = true WHERE id = '$D3'; RESET ROLE;
   $(state $RIDE_A) SELECT count(*) FROM public.ride_offers WHERE ride_id = '$RIDE_A' AND driver_profile_id = '$D3' AND status = 'pending';
   ROLLBACK;"
val "K1 a rider's INSERT (as authenticated, like the app) dispatches through on_ride_insert_dispatch" "$K1_SQL" "1|3|3"
val "K2 a cargo ride waits for its package, then the rider's delivery_details INSERT dispatches it" \
  "BEGIN; $(as $MALLO authenticated)
   INSERT INTO public.rides (id, customer_id, service_type, ride_mode, pickup_location, pickup_address, estimated_fare_cup, estimated_distance_m)
   VALUES ('$RIDE_C', '$MALLO', 'moto_standard', 'cargo', 'POINT(-82.3830 23.1330)', 'Vedado', 900, 3000);
   RESET ROLE; $(state $RIDE_C) SET LOCAL ROLE authenticated;
   INSERT INTO public.delivery_details (ride_id, package_category, estimated_weight_kg) VALUES ('$RIDE_C', 'documents', 0.5);
   RESET ROLE; $(state $RIDE_C) ROLLBACK;" "0|0|0;1|3|3"
val "K3 a driver connecting (his own UPDATE of is_online) re-dispatches the searching rides: D3 gets one" "$K3_SQL" "2|4|4;1"
val "K4 a driver freed by a finished ride re-dispatches them (trg_redispatch_searching_on_ride_freed, inside an RPC)" \
  "BEGIN; INSERT INTO public.rides (id, customer_id, driver_id, service_type, status, pickup_location, pickup_address)
   VALUES ('$RIDE_F', '$MALLO', '$D1', 'triciclo_basico', 'in_progress', 'POINT(-82.3830 23.1330)', 'Vedado');
   SET LOCAL ROLE postgres; UPDATE public.rides SET status = 'completed' WHERE id = '$RIDE_F'; RESET ROLE;
   $(state $RIDE_A) ROLLBACK;" "2|3|3"
val "K5 cron retry-dispatch-expired-rides (runs as postgres) re-dispatches Rosa's ride" \
  "BEGIN; SET LOCAL ROLE postgres; SELECT public.retry_dispatch_expired_rides(); RESET ROLE; $(state $RIDE_A) ROLLBACK;" "1;2|3|3"
val "K6 cron activate-scheduled-rides (runs as postgres) dispatches a ride scheduled 5 minutes ahead" \
  "BEGIN; INSERT INTO public.rides (id, customer_id, service_type, pickup_location, pickup_address, estimated_fare_cup,
     estimated_distance_m, is_scheduled, scheduled_at, scheduled_notified)
   VALUES ('$RIDE_S', '$MALLO', 'triciclo_basico', 'POINT(-82.3830 23.1330)', 'Vedado', 1500, 3000, true, now() + interval '5 minutes', false);
   $(state $RIDE_S) SET LOCAL ROLE postgres; SELECT public.activate_scheduled_rides(); RESET ROLE; $(state $RIDE_S) ROLLBACK;" "0|0|0;1;1|3|3"
val "K7 service_role keeps EXECUTE" \
  "BEGIN; SET LOCAL ROLE service_role; SELECT public.dispatch_ride('$RIDE_A')->>'offers_created'; RESET ROLE; $(state $RIDE_A) ROLLBACK;" "3;2|3|3"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
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
  sabotage g1 "integer) FROM PUBLIC, anon, authenticated;" "integer) FROM PUBLIC, anon;"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "00630: authenticated can still execute public.dispatch_ride(uuid,integer)" \
    && ok "G1 EXECUTE left to authenticated aborts the migration" || ko "G1 EXECUTE left to authenticated aborts the migration" "$r"
  sabotage g2 "integer) FROM PUBLIC, anon, authenticated;" "integer) FROM anon, authenticated;"
  fresh ${DB}g; run ${DB}g "GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) TO PUBLIC;" >/dev/null
  r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "00630: anon can still execute public.dispatch_ride(uuid,integer)" \
    && ok "G2 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" || ko "G2 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" "$r"
  fresh ${DB}g
  run ${DB}g "SET ROLE postgres; CREATE FUNCTION public.dispatch_ride(p_ride_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
    AS \$f\$ SELECT public.dispatch_ride(p_ride_id, 5000) \$f\$;
    REVOKE ALL ON FUNCTION public.dispatch_ride(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid) TO authenticated;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00630: authenticated can still execute public.dispatch_ride(uuid)" \
    && ok "G3 another overload left open aborts the migration" || ko "G3 another overload left open aborts the migration" "$r"
  sabotage g4 "GRANT EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) TO service_role;" ""
  fresh ${DB}g; run ${DB}g "REVOKE EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) FROM service_role;" >/dev/null
  r=$(apply_err ${DB}g "$T/g4.sql")
  echo "$r" | grep -q "00630: service_role lost EXECUTE on public.dispatch_ride(uuid,integer)" \
    && ok "G4 service_role left without EXECUTE aborts the migration" || ko "G4 service_role left without EXECUTE aborts the migration" "$r"
  # Every internal caller runs dispatch_ride as its owner: an owner without EXECUTE stops all
  # dispatch. postgres inherits service_role's EXECUTE (S3), so it takes revoking both. The
  # revoke goes after the patch: plpgsql's validator wants EXECUTE too, so a CREATE OR REPLACE
  # by an owner without it fails on its own (42501), before the checks run.
  sabotage g5 "-- Assert the end state" \
    "REVOKE EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) FROM postgres, service_role; -- Assert the end state"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g5.sql")
  echo "$r" | grep -q "00630: the owner cannot execute public.dispatch_ride(uuid,integer)" \
    && ok "G5 an owner left without EXECUTE aborts the migration" || ko "G5 an owner left without EXECUTE aborts the migration" "$r"
  # The K checks are not vacuous: break the internal path by hand and watch them fail. The
  # driver-online trigger swallows errors, so there the only symptom is a ride nobody is offered.
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$MIG")
  run ${DB}g "REVOKE EXECUTE ON FUNCTION public.dispatch_ride(uuid, integer) FROM postgres, service_role;" >/dev/null
  k1=$(run ${DB}g "$K1_SQL"); k3=$(run ${DB}g "$K3_SQL")
  [ "$r" = applied ] && echo "$k1" | grep -q "$DENIED" && [ "$k3" = "1|0|0;0" ] \
    && ok "G6 with the owner's EXECUTE gone, K1 fails loudly and K3 silently offers nothing" \
    || ko "G6 with the owner's EXECUTE gone, K1 fails loudly and K3 silently offers nothing" "$r / K1 [$k1] / K3 [$k3]"
  # A caller that would lose the call once clients lose EXECUTE: one that runs as its caller...
  fresh ${DB}g
  run ${DB}g "SET ROLE postgres; CREATE FUNCTION public.redispatch_now(p uuid) RETURNS jsonb LANGUAGE plpgsql
    AS \$f\$ BEGIN RETURN public.dispatch_ride(p); END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00630: public.redispatch_now(uuid) is SECURITY INVOKER and calls dispatch_ride" \
    && ok "G7 a SECURITY INVOKER caller of dispatch_ride aborts the migration" || ko "G7 a SECURITY INVOKER caller of dispatch_ride aborts the migration" "$r"
  # ...or one whose owner cannot execute it.
  fresh ${DB}g
  run ${DB}g "DO \$r\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'g8_owner') THEN CREATE ROLE g8_owner NOLOGIN; END IF; END \$r\$;
    CREATE FUNCTION public.redispatch_as_other(p uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    AS \$f\$ BEGIN RETURN public.dispatch_ride(p); END \$f\$;
    ALTER FUNCTION public.redispatch_as_other(uuid) OWNER TO g8_owner;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00630: public.redispatch_as_other(uuid) calls dispatch_ride as g8_owner, which cannot execute it" \
    && ok "G8 a SECURITY DEFINER caller whose owner cannot execute dispatch_ride aborts the migration" \
    || ko "G8 a SECURITY DEFINER caller whose owner cannot execute dispatch_ride aborts the migration" "$r"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" -c "DROP DATABASE IF EXISTS ${DB}m" -c "DROP ROLE IF EXISTS g8_owner" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
