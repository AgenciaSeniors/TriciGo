#!/usr/bin/env bash
# Rehearsal runner for migration 00679 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00679/run.sh none
#       -> base (the 00650 scaffold, migration 00650, scaffold-extra.sql) + tests.sql
#          (RED: 00679 is missing)
#   supabase/tests/00679/run.sh supabase/migrations/00679_moto_deportiva.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00679/run.sh ...
# Another database name (two runs at once): PGDB=<name> ...  (the CRLF and negative runs use <name>w and <name>n)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr679}"
CRL="${DB}w"
NEG="${DB}n"
M650="$REPO/supabase/migrations/00650_driver_vehicle_review.sql"
FRESHLOG="$(mktemp)"; TESTLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG" "$TESTLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

FBD="public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)"
# The bodies 00679 patches, as prod had them on 2026-11-08, and the helpers they call.
LIVE="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('find_best_drivers',
        'notify_offline_drivers_for_searching_rides', '_driver_can_serve_ride', '_vehicle_types_for_service',
        'admin_ride_assist_candidates', '_ride_service_change_error')"
LIVE_MD5="_driver_can_serve_ride=733f31677b6c4c146efa6434976180a8,_ride_service_change_error=a0796f7df0430c7bafa9d4621b82eae8,_vehicle_types_for_service=5299ab645064c495257109e7e53c6e4e,admin_ride_assist_candidates=c97a27059673affa5f75bc024e09f6bb,find_best_drivers=ec914394abd6f03eeedffc1ae51e8db0,notify_offline_drivers_for_searching_rides=2a317ff22745d2bbf80c86b20b426a17"
# Every function the migration creates or patches.
BODIES="SELECT string_agg(proname || '=' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('find_best_drivers',
          'notify_offline_drivers_for_searching_rides', '_driver_can_serve_ride', 'admin_ride_assist_candidates',
          '_ride_service_change_error', '_moto_deportiva_raw_status', '_moto_deportiva_is_on',
          '_md_driver_allowed', 'get_moto_deportiva_status', 'tg_rides_moto_deportiva_guard',
          '_moto_deportiva_send_notice', 'tg_moto_deportiva_pilot_online', 'set_moto_deportiva_waitlist',
          'admin_moto_deportiva_overview', 'admin_moto_deportiva_subscribers', 'admin_remove_moto_deportiva_subscriber',
          'admin_set_moto_deportiva', 'admin_add_moto_deportiva_pilot', 'admin_remove_moto_deportiva_pilot',
          'admin_moto_deportiva_metrics')"
# The five patched bodies must be the ones the migration accepts on a re-run.
PATCHED="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace AND proname IN ('find_best_drivers',
           'notify_offline_drivers_for_searching_rides', '_driver_can_serve_ride', 'admin_ride_assist_candidates',
           '_ride_service_change_error')"
PATCHED_MD5="_driver_can_serve_ride=770b020e687a712eb87d29237bcf0b4f,_ride_service_change_error=f782b9188ac8807f9592be7e5508e09e,admin_ride_assist_candidates=a858e14c0195e64bceb8c77417c4e472,find_best_drivers=401af5186bc34c13559d75a0f7e19cfe,notify_offline_drivers_for_searching_rides=38ca2bf6cdb427882fcfabe1b00a8b9d"

# fresh DB: the base. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/00650/scaffold.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- the 00650 scaffold failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M650" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- migration 00650 failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold-extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- scaffold-extra.sql failed:"; cat "$FRESHLOG"; return 1; }; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# mutate DB SQL: rewrite a live function as its owner (a body the migration does not know)
mutate(){ run "$1" "SET ROLE tricigo_owner; DO \$m\$ BEGIN EXECUTE $2; END \$m\$;" >/dev/null; }

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M0 the migration applies" || { ko "M0 the migration applies" "$r"; exit 1; }
  B1="$(run $DB "$BODIES")"
  echo "== apply migration (2nd, idempotency) =="
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M1 the migration re-applies (idempotent)" || ko "M1 the migration re-applies" "$r"
  val "M2 ...leaving every body as the first run did" "$BODIES" "$B1"
  val "M3 the patched bodies are the ones the migration accepts on a re-run" "$PATCHED" "$PATCHED_MD5"
  val "M4 two runs: one service row, 4 bands, 3 settings, the 2 triggers once" \
    "SELECT count(*) FROM public.service_type_configs WHERE slug = 'moto_deportiva';
     SELECT count(*) FROM public.pricing_rules WHERE service_type = 'moto_deportiva';
     SELECT count(*) FROM public.platform_config WHERE key LIKE 'moto_deportiva%';
     SELECT count(*) FROM pg_trigger WHERE tgname IN ('rides_moto_deportiva_guard', 'driver_profiles_moto_deportiva_online');" \
    "1;4;3;2"
fi

echo "== tests.sql =="
# Without ON_ERROR_STOP: a case whose setup fails prints nothing and is reported as not reached.
"$BIN/psql" $CONN -d "$DB" -qAt -f "$DIR/tests.sql" 2>"$TESTLOG" | tr -d '\r' > "$TESTLOG.out"
while IFS= read -r line; do
  case "$line" in
    "PASS  "*) echo "$line"; PASS=$((PASS+1)) ;;
    "FAIL  "*) echo "$line"; FAIL=$((FAIL+1)) ;;
  esac
done < "$TESTLOG.out"
while IFS= read -r name; do
  grep -qF "  $name" "$TESTLOG.out" || ko "$name" "not reached: $(tr -d '\r' < "$TESTLOG" | grep -m1 'ERROR' || echo 'no error')"
done < <(grep -oE "tst\.t\('[^']+'" "$DIR/tests.sql" | sed -E "s/^tst\.t\('//; s/'$//")
rm -f "$TESTLOG.out"

if [ "$MIG" != "none" ]; then
  echo "== CRLF copy (pasted from Windows into the SQL Editor) =="
  fresh $CRL || { echo "base failed"; exit 1; }
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $CRL "$CRLF"); rm -f "$CRLF"
  [ "$r" = applied ] && ok "C1 a CRLF copy applies" || ko "C1 a CRLF copy applies" "$r"
  val "C2 ...leaving the same bodies as the LF one, with no carriage return" \
    "$BODIES; SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(chr(13) IN prosrc) > 0" "$B1;0" $CRL
  r=$(apply_err $CRL "$MIG")
  [ "$r" = applied ] && ok "C3 ...and the LF file re-applies on top" || ko "C3 the LF file re-applies on top of a CRLF apply" "$r"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $CRL" >/dev/null 2>&1

  echo "== negative proofs =="
  fresh $NEG || { echo "base failed"; exit 1; }
  mutate $NEG "replace(pg_get_functiondef('$FBD'::regprocedure), 'v_is_long_trip := ', 'v_is_long_trip :=  ')"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "find_best_drivers has an unknown body" \
    && ok "N1 an unknown body of find_best_drivers stops the migration" || ko "N1 unknown find_best_drivers" "got [$r]"
  val "N2 ...and nothing was half-applied" \
    "SELECT count(*) FROM public.service_type_configs WHERE slug = 'moto_deportiva'; SELECT to_regclass('public.moto_deportiva_pilots') IS NULL;" \
    "0;t" $NEG
  fresh $NEG || { echo "base failed"; exit 1; }
  mutate $NEG "replace(pg_get_functiondef('public.notify_offline_drivers_for_searching_rides()'::regprocedure), 'v_total := v_total', 'v_total :=  v_total')"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "notify_offline_drivers_for_searching_rides has an unknown body" \
    && ok "N3 an unknown body of notify_offline_drivers_for_searching_rides stops it" || ko "N3 unknown notify_offline" "got [$r]"
  fresh $NEG || { echo "base failed"; exit 1; }
  mutate $NEG "replace(pg_get_functiondef('public._driver_can_serve_ride(uuid,text,boolean)'::regprocedure), 'AND v.is_active', 'AND  v.is_active')"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "_driver_can_serve_ride has an unknown body" \
    && ok "N4 an unknown body of _driver_can_serve_ride stops it" || ko "N4 unknown _driver_can_serve_ride" "got [$r]"
  fresh $NEG || { echo "base failed"; exit 1; }
  mutate $NEG "replace(pg_get_functiondef('public.admin_ride_assist_candidates(uuid,text)'::regprocedure), 'LIMIT 60;', 'LIMIT  60;')"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_ride_assist_candidates has an unknown body" \
    && ok "N4b an unknown body of admin_ride_assist_candidates stops it" || ko "N4b unknown admin_ride_assist_candidates" "got [$r]"
  fresh $NEG || { echo "base failed"; exit 1; }
  mutate $NEG "replace(pg_get_functiondef('public._ride_service_change_error(public.rides,text,integer)'::regprocedure), 'RETURN NULL;', 'RETURN  NULL;')"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "_ride_service_change_error has an unknown body" \
    && ok "N4c an unknown body of _ride_service_change_error stops it" || ko "N4c unknown _ride_service_change_error" "got [$r]"

  # The final check, run alone on a migrated database: passes, then stops on each broken invariant.
  # (Re-running the whole migration would not prove it: its REVOKEs run before the check.)
  fresh $NEG || { echo "base failed"; exit 1; }
  r=$(apply_err $NEG "$MIG"); [ "$r" = applied ] || ko "N5 setup" "$r"
  CHECK="$(mktemp)"; awk '/^DO \$check\$/,/^\$check\$;/' "$MIG" > "$CHECK"
  r=$(apply_err $NEG "$CHECK"); [ "$r" = applied ] && ok "N5 the final check passes on the migrated database" || ko "N5 final check" "$r"
  run $NEG "GRANT SELECT ON public.moto_deportiva_waitlist TO anon" >/dev/null
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "lock tables are readable by clients" \
    && ok "N6 ...stops on the waitlist readable by anon" || ko "N6 waitlist grant" "got [$r]"
  run $NEG "REVOKE SELECT ON public.moto_deportiva_waitlist FROM anon; GRANT SELECT ON public.moto_deportiva_notices TO authenticated" >/dev/null
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "moto_deportiva_notices is readable by clients" \
    && ok "N7 ...stops on the notices readable by authenticated" || ko "N7 notices grant" "got [$r]"
  run $NEG "REVOKE SELECT ON public.moto_deportiva_notices FROM authenticated; GRANT EXECUTE ON FUNCTION public._md_driver_allowed(uuid, text) TO authenticated" >/dev/null
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "_md_driver_allowed is executable by clients" \
    && ok "N8 ...stops on _md_driver_allowed executable by clients" || ko "N8 helper grant" "got [$r]"
  run $NEG "REVOKE EXECUTE ON FUNCTION public._md_driver_allowed(uuid, text) FROM authenticated" >/dev/null
  mutate $NEG "replace(pg_get_functiondef('$FBD'::regprocedure), 'AND public._md_driver_allowed(dp.id, p_service_type)  -- 00679', '')"
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "dispatch not patched" \
    && ok "N9 ...stops on a find_best_drivers without the pilot filter" || ko "N9 unpatched dispatch" "got [$r]"
  fresh $NEG || { echo "base failed"; exit 1; }
  r=$(apply_err $NEG "$MIG"); [ "$r" = applied ] || ko "N10 setup" "$r"
  mutate $NEG "replace(pg_get_functiondef('public.admin_ride_assist_candidates(uuid,text)'::regprocedure), 'AND public._md_driver_allowed(dp.id, v_type)  -- 00679', '')"
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "support functions not patched" \
    && ok "N10 ...stops on an assist list without the pilot filter" || ko "N10 unpatched assist list" "got [$r]"
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_ride_assist_candidates has an unknown body" \
    && ok "N11 ...and the migration does not re-patch a body it does not know" || ko "N11 re-run on an unpatched assist list" "got [$r]"
  rm -f "$CHECK"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1

  echo "== bodies after 00679 (md5/length of prosrc) =="
  run $DB "$BODIES" | tr ',' '\n'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
