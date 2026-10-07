#!/usr/bin/env bash
# Rehearsal runner for migration 00634 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00634/run.sh none
#       -> scaffold (prod's update_ride_status_v2, the two ride guards, the FSM and r_update) + tests (RED)
#   supabase/tests/00634/run.sh supabase/migrations/00634_ride_writes_through_rpcs.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Needs PostGIS for Postgres 16 (Ubuntu: apt-get install postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00634/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr634
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001     # customer of every ride
RIDER2=a0000000-0000-4000-8000-000000000002    # another customer
DIEGO=d0000000-0000-4000-8000-000000000004     # driver assigned to the rides (DP_DIEGO)
OTTO=d0000000-0000-4000-8000-000000000005      # another approved driver (DP_OTTO)
EVA=e0000000-0000-4000-8000-000000000005       # platform admin
DP_DIEGO=dd000000-0000-4000-8000-000000000004
DP_OTTO=dd000000-0000-4000-8000-000000000005
RIDE=11111111-0000-4000-8000-000000000001
PICK="ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography"
DROP="ST_SetSRID(ST_MakePoint(-82.3800, 23.1400), 4326)::geography"

# ride STATUS [DRIVER_PROFILE|NULL] -> the ride $RIDE of $RIDER in that status, set up as the service
ride(){ local d="NULL"; [ "${2:-$DP_DIEGO}" != NULL ] && d="'${2:-$DP_DIEGO}'"
  echo "INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_location, dropoff_location,
          estimated_fare_cup, estimated_fare_trc, accepted_at, driver_arrived_at, pickup_at)
        VALUES ('$RIDE', '$RIDER', $d, '$1', $PICK, $DROP, 2000, 2000, now() - interval '20 minutes',
                CASE WHEN '$1' IN ('in_progress', 'arrived_at_destination', 'completed') THEN now() - interval '12 minutes' END,
                CASE WHEN '$1' IN ('in_progress', 'arrived_at_destination', 'completed') THEN now() - interval '10 minutes' END);"; }
# as UID SETUP SQL -> SETUP as the service, then SQL as authenticated with JWT subject UID; rolled back
as(){ printf "BEGIN; %s SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$2" "$1" "$3"; }
# anon SETUP SQL
asanon(){ printf "BEGIN; %s SET LOCAL request.jwt.claims = '{\"role\":\"anon\"}'; SET LOCAL ROLE anon; %s ROLLBACK;" "$1" "$2"; }
# service SETUP SQL -> as the service role (no subject), as an Edge Function would
asservice(){ printf "BEGIN; %s SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}'; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1" "$2"; }
tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
STATE="SELECT status || '|' || coalesce(final_fare_cup::text, '-') FROM public.rides WHERE id = '$RIDE';"
UPD(){ echo "UPDATE public.rides SET $1 WHERE id = '$RIDE' RETURNING status;"; }
V2(){ echo "SELECT public.update_ride_status_v2('$RIDE', '$1', ${2:-NULL}, ${3:-NULL}, false, false)->>'success';"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER', 'customer', 'Rider'), ('$RIDER2', 'customer', 'Rider Two'),
    ('$DIEGO', 'driver', 'Diego'), ('$OTTO', 'driver', 'Otto'), ('$EVA', 'admin', 'Eva');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO'), ('$DP_OTTO', '$OTTO');" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
bodies(){ echo "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
                WHERE proname IN ('update_ride_status_v2', 'tg_rides_client_write_guard')"; }
OLD_MD5="update_ride_status_v2=0127dfedde6c8f7bbb8185a6086a6ae5"
NEW_MD5="tg_rides_client_write_guard=dadf42ea83ba7ee425208128543162b0,update_ride_status_v2=182eeb5721e458b9976c12d7318f09ac"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" = "none" ]; then
  val "S0 the scaffold carries prod's update_ride_status_v2" "$(bodies)" "$OLD_MD5"
fi

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "S1 the two bodies are the 00634 ones" "$(bodies)" "$NEW_MD5"
fi

echo "== 1. the driver cannot rewrite the ride by hand =="
err "D1 cannot complete it with a fare of their own" \
  "$(as $DIEGO "$(ride in_progress)" "$(UPD "status = 'completed', final_fare_cup = 1, final_fare_trc = 1, completed_at = now()")")" "ride_status_via_rpc"
err "D2 ... nor from arrived_at_destination" \
  "$(as $DIEGO "$(ride arrived_at_destination)" "$(UPD "status = 'completed', final_fare_cup = 1, final_fare_trc = 1")")" "ride_status_via_rpc"
err "D3 cannot cancel it without cancel_ride" \
  "$(as $DIEGO "$(ride accepted)" "$(UPD "status = 'canceled', canceled_at = now()")")" "ride_status_via_rpc"
err "D4 cannot move it to arrived_at_pickup without the GPS check" \
  "$(as $DIEGO "$(ride driver_en_route)" "$(UPD "status = 'arrived_at_pickup', driver_arrived_at = now()")")" "ride_status_via_rpc"
err "D5 cannot backdate the arrival to bill waiting time" \
  "$(as $DIEGO "$(ride in_progress)" "$(UPD "driver_arrived_at = now() - interval '60 minutes'")")" "ride_column_via_rpc"
err "D6 cannot move the pickup time either" \
  "$(as $DIEGO "$(ride in_progress)" "$(UPD "pickup_at = now()")")" "ride_column_via_rpc"
err "D7 cannot set the surge or a custom rate" \
  "$(as $DIEGO "$(ride in_progress)" "$(UPD "surge_multiplier = 3, driver_custom_rate_cup = 5000")")" "ride_column_via_rpc"
err "D8 the error speaks Spanish" \
  "$(as $DIEGO "$(ride in_progress)" "$(UPD "status = 'completed', final_fare_cup = 1")")" "solo cambia desde la app"

echo "== 2. the rider writes only what the apps write =="
DISPUTE(){ echo "INSERT INTO public.ride_disputes (ride_id, opened_by, status) VALUES ('$RIDE', '$RIDER', '${1:-open}');"; }
err "C1 cannot freeze a ride in progress as disputed, even with a dispute" \
  "$(as $RIDER "$(ride in_progress)" "$(DISPUTE) $(UPD "status = 'disputed'")")" "ride_status_via_rpc"
err "C2 cannot dispute a completed ride without opening a dispute" \
  "$(as $RIDER "$(ride completed)" "$(UPD "status = 'disputed'")")" "ride_status_via_rpc"
val "C3 disputes a completed ride after opening a dispute (createDispute)" \
  "$(as $RIDER "$(ride completed)" "$(DISPUTE) $(UPD "status = 'disputed'")")" "disputed"
err "C4 ... but not with a dispute already resolved" \
  "$(as $RIDER "$(ride completed) $(DISPUTE resolved_driver)" "$(UPD "status = 'disputed'")")" "ride_status_via_rpc"
err "C5 ... nor with somebody else's dispute" \
  "$(as $RIDER "$(ride completed) INSERT INTO public.ride_disputes (ride_id, opened_by) VALUES ('$RIDE', '$DIEGO');" "$(UPD "status = 'disputed'")")" \
  "ride_status_via_rpc"
err "C6 cannot cancel by hand" \
  "$(as $RIDER "$(ride accepted)" "$(UPD "status = 'canceled'")")" "ride_status_via_rpc"
val "C7 sets and clears the share link" \
  "$(as $RIDER "$(ride in_progress)" "$(UPD "share_token = 'abc', share_token_expires_at = now() + interval '1 day'") $(UPD "share_token = NULL, share_token_expires_at = NULL")")" \
  "in_progress;in_progress"
val "C8 marks the ride split and chains the next one" \
  "$(as $RIDER "$(ride accepted)" "$(UPD "is_split = true") $(UPD "next_ride_id = gen_random_uuid(), is_chained = true")")" "accepted;accepted"
err "C9 cannot lower the fare it agreed" \
  "$(as $RIDER "$(ride accepted)" "$(UPD "estimated_fare_cup = 1, estimated_fare_trc = 1")")" "ride_column_via_rpc"
err "C10 cannot change the destination by hand" \
  "$(as $RIDER "$(ride accepted)" "$(UPD "dropoff_address = 'otro lado'")")" "ride_column_via_rpc"

echo "== 3. the RPCs, admins and the service still write =="
val "R1 the driver goes en route through update_ride_status_v2" \
  "$(as $DIEGO "$(ride accepted)" "$(V2 driver_en_route) $STATE")" "true;driver_en_route|-"
val "R2 ... arrives with GPS at the pickup (arrival time set)" \
  "$(as $DIEGO "$(ride driver_en_route)" "$(V2 arrived_at_pickup 23.1357 -82.3666)
     SELECT status || '|' || (driver_arrived_at IS NOT NULL) FROM public.rides WHERE id = '$RIDE';")" "true;arrived_at_pickup|true"
val "R3 ... and starts the trip (pickup time set)" \
  "$(as $DIEGO "$(ride arrived_at_pickup)" "$(V2 in_progress)
     SELECT status || '|' || (pickup_at IS NOT NULL) FROM public.rides WHERE id = '$RIDE';")" "true;in_progress|true"
val "R4 completing through the payment RPC still works" \
  "$(as $DIEGO "$(ride in_progress)" "SELECT public.scaffold_complete('$RIDE');")" "completed|2000"
val "R5 cancelling through cancel_ride still works" \
  "$(as $RIDER "$(ride accepted)" "SELECT public.scaffold_cancel('$RIDE');")" "canceled"
val "R6 an admin still writes a ride by hand (dispute resolved with no action)" \
  "$(as $EVA "$(ride disputed)" "$(UPD "status = 'completed'")")" "completed"
val "R7 the service role still writes a ride by hand" \
  "$(asservice "$(ride completed)" "$(UPD "payment_status = 'failed'") $(UPD "status = 'disputed'")")" "completed;disputed"
val "R8 SQL sessions (cron, migrations) still write a ride" \
  "$(tx "$(ride in_progress) $(UPD "status = 'completed', final_fare_cup = 2000, driver_arrived_at = now()")")" "completed"

echo "== 4. update_ride_status_v2 answers only the driver of the ride =="
err "V1 anon cannot call it" "$(asanon "$(ride accepted)" "$(V2 driver_en_route)")" "permission denied for function update_ride_status_v2"
err "V2 a stranger cannot move a ride with a driver" "$(as $RIDER2 "$(ride accepted)" "$(V2 driver_en_route)")" "Forbidden"
err "V3 another driver cannot take a ride with no driver yet" "$(as $OTTO "$(ride searching NULL)" "$(V2 accepted)")" "Forbidden"
err "V4 the rider cannot move their own ride" "$(as $RIDER "$(ride accepted)" "$(V2 driver_en_route)")" "Forbidden"
val "V5 an admin still can" "$(as $EVA "$(ride accepted)" "$(V2 driver_en_route)")" "true"
val "V6 authenticated keeps EXECUTE, anon and PUBLIC do not" \
  "SELECT has_function_privilege('authenticated', 'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)', 'EXECUTE')
       || '|' || has_function_privilege('anon', 'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)', 'EXECUTE')
       || '|' || has_function_privilege('service_role', 'public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)', 'EXECUTE')" \
  "true|false|true"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  NEG=pr634n
  fresh $NEG
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure),
            E'END;\n', E'END; -- local edit\n'); END \$x\$;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "unexpected body of update_ride_status_v2" \
    && ok "N1 a body it does not know is not replaced" || ko "N1" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; CREATE TRIGGER rides_a_first BEFORE UPDATE ON public.rides
            FOR EACH ROW EXECUTE FUNCTION public.scaffold_touch_coords();" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "must fire first" \
    && ok "N2 a BEFORE UPDATE trigger that fires before the guard aborts it" || ko "N2" "got [$r]"
  fresh $NEG
  run $NEG "CREATE ROLE pr634_exec NOLOGIN; GRANT pr634_exec TO anon; SET ROLE tricigo_owner;
            GRANT EXECUTE ON FUNCTION public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean) TO pr634_exec;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "anon can still execute" \
    && ok "N3 anon reaching it through another role aborts it" || ko "N3" "got [$r]"
  run postgres "DROP DATABASE IF EXISTS $NEG" >/dev/null; run postgres "DROP ROLE IF EXISTS pr634_exec" >/dev/null
  fresh $NEG
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$(bodies)")" = "$NEW_MD5" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N4 pasted with CRLF line ends, the bodies still match git"
  else ko "N4" "apply [$r], bodies [$(run $NEG "$(bodies)")]"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
fi

$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
