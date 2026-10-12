#!/usr/bin/env bash
# Rehearsal runner for migration 00660 (local Postgres 16 + PostGIS).
#   supabase/tests/00660/run.sh none                                         -> RED
#   supabase/tests/00660/run.sh supabase/migrations/00660_stuck_ride_support.sql -> GREEN (+ x2, CRLF, negatives)
# Base: the 00659 scaffold + the 00659 migration (prod today), then scaffold-extra.sql.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr660
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001
DIEGO=d0000000-0000-4000-8000-000000000001
ANA=d0000000-0000-4000-8000-000000000002
ADMIN=e0000000-0000-4000-8000-000000000001
BETO=d0000000-0000-4000-8000-000000000003
MKT=e0000000-0000-4000-8000-000000000002
SUPER=e0000000-0000-4000-8000-000000000003
DP_DIEGO=dd000000-0000-4000-8000-000000000001
DP_ANA=dd000000-0000-4000-8000-000000000002
DP_BETO=dd000000-0000-4000-8000-000000000003
DP_SOFI=dd000000-0000-4000-8000-000000000009     # created by the self-ride tests only
R_ACC=22222222-0000-4000-8000-000000000001     # accepted
R_ENR=22222222-0000-4000-8000-000000000002     # driver_en_route
R_PICK=22222222-0000-4000-8000-000000000003    # arrived_at_pickup, arrived 15 min ago (06:xx Havana is not assumed)
R_IP=22222222-0000-4000-8000-000000000004      # in_progress, waited 10 min, discount 500
R_DEST=22222222-0000-4000-8000-000000000005    # arrived_at_destination
R_NOSNAP=22222222-0000-4000-8000-000000000006  # in_progress without an estimate snapshot
R_SCHED=22222222-0000-4000-8000-000000000007   # accepted, scheduled 2 h ahead
R_GRID=22222222-0000-4000-8000-000000000008    # completed; used for the wait-charge grid
PT_A="ST_SetSRID(ST_MakePoint(-82.3666,23.1357),4326)::geography"   # pickup (Capitolio)
PT_B="ST_SetSRID(ST_MakePoint(-82.3816,23.1418),4326)::geography"   # dropoff (Hotel Nacional)
PT_NEAR="ST_SetSRID(ST_MakePoint(-82.3670,23.1358),4326)::geography" # ~40 m from pickup
PT_FAR="ST_SetSRID(ST_MakePoint(-82.3690,23.1360),4326)::geography"  # ~250 m from pickup

as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
PT(){ echo "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$1', '$2', $3, $4);"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/00659/scaffold.sql" >/dev/null 2>&1 || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$ROOT/supabase/migrations/00659_ride_trail_guards.sql" >/dev/null 2>&1 || return 1
  (cd "$DIR" && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold-extra.sql >/dev/null 2>&1) || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, phone) VALUES
    ('$RIDER','customer','Rider','+5355550001'), ('$DIEGO','driver','Diego','+5355550002'),
    ('$ANA','driver','Ana','+5355550003'), ('$ADMIN','admin','Sofi','+5355550004'), ('$MKT','marketing','Mara',NULL),
    ('$BETO','driver','Beto','+5355550005'), ('$SUPER','super_admin','Rosa','+5355550006');
  INSERT INTO public.driver_profiles (id, user_id, is_online, last_heartbeat_at) VALUES
    ('$DP_DIEGO','$DIEGO', true, now() - interval '20 minutes'), ('$DP_ANA','$ANA', true, now()), ('$DP_BETO','$BETO', true, now());
  INSERT INTO public.vehicles (driver_id, make, model, color, plate_number) VALUES ('$DP_DIEGO','Triciclo','',NULL,'T123');
  INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_location, dropoff_location,
                            accepted_at, driver_arrived_at, pickup_at, discount_amount_cup, scheduled_at) VALUES
    ('$R_ACC','$RIDER','$DP_DIEGO','accepted',$PT_A,$PT_B, now()-interval '10 minutes', NULL, NULL, 0, NULL),
    ('$R_ENR','$RIDER','$DP_DIEGO','driver_en_route',$PT_A,$PT_B, now()-interval '10 minutes', NULL, NULL, 0, NULL),
    ('$R_PICK','$RIDER','$DP_DIEGO','arrived_at_pickup',$PT_A,$PT_B, now()-interval '30 minutes', now()-interval '15 minutes', NULL, 0, NULL),
    ('$R_IP','$RIDER','$DP_DIEGO','in_progress',$PT_A,$PT_B, now()-interval '40 minutes', now()-interval '30 minutes', now()-interval '20 minutes', 500, NULL),
    ('$R_DEST','$RIDER','$DP_DIEGO','arrived_at_destination',$PT_A,$PT_B, now()-interval '40 minutes', now()-interval '30 minutes', now()-interval '29 minutes', 0, NULL),
    ('$R_NOSNAP','$RIDER','$DP_ANA','in_progress',$PT_A,$PT_B, now()-interval '40 minutes', NULL, now()-interval '20 minutes', 0, NULL),
    ('$R_SCHED','$RIDER','$DP_ANA','accepted',$PT_A,$PT_B, now(), NULL, NULL, 0, now()+interval '2 hours'),
    ('$R_GRID','$RIDER','$DP_ANA','completed',$PT_A,$PT_B, NULL, NULL, NULL, 0, NULL);
  INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, total)
    SELECT id, 'estimate', 3000 FROM public.rides WHERE id <> '$R_NOSNAP';
  INSERT INTO public.ride_offers (ride_id, driver_profile_id, status) VALUES
    ('$R_ACC','$DP_DIEGO','accepted'), ('$R_ENR','$DP_DIEGO','accepted');
  INSERT INTO public.stuck_ride_alerts (ride_id, reason) VALUES ('$R_IP','dead_driver_app');" >/dev/null 2>&1 || return 1; }

# The old calculate_wait_charge's answers on a grid, kept to compare the new code against.
# waited is in seconds: 0, 4, 5, 5:59 (no billable minute), 6, 12, 25 and 40 minutes.
grid(){ run "$1" "
  CREATE TABLE public.wait_grid (arrived timestamptz, waited integer, wait_minutes integer, billable integer, charge integer);
  DO \$g\$ DECLARE h integer; w integer; r record; BEGIN
    FOR h IN 0..23 LOOP FOREACH w IN ARRAY ARRAY[0,240,300,359,360,720,1500,2400] LOOP
      UPDATE public.rides SET driver_arrived_at = (date '2026-10-12' + make_interval(hours => h)) AT TIME ZONE 'America/Havana',
                              pickup_at = (date '2026-10-12' + make_interval(hours => h, secs => w)) AT TIME ZONE 'America/Havana'
       WHERE id = '$R_GRID';
      SELECT * INTO r FROM public.calculate_wait_charge('$R_GRID') AS (wait_minutes integer, billable_minutes integer, charge integer);
      INSERT INTO public.wait_grid SELECT driver_arrived_at, w, r.wait_minutes, r.billable_minutes, r.charge FROM public.rides WHERE id = '$R_GRID';
    END LOOP; END LOOP;
    UPDATE public.rides SET driver_arrived_at = NULL, pickup_at = NULL WHERE id = '$R_GRID';
  END \$g\$; SELECT count(*) FROM public.wait_grid;"; }

fresh $DB || { echo "scaffold failed"; exit 1; }
[ "$(grid $DB)" = "192" ] || { echo "grid failed"; exit 1; }

# The live bodies the scaffold loaded are the ones read from prod (before the migration touches any).
LIVE_MD5=$(sed -n "s/^-- live \([a-z_]*\): md5 \([0-9a-f]*\)$/('\1','\2')/p" "$DIR/live-bodies.sql" | paste -sd, -)
val "S1 the live bodies load with the md5 noted in live-bodies.sql" \
  "SELECT count(*) FILTER (WHERE md5(p.prosrc) = v.m) || '/' || count(*) FROM (VALUES $LIVE_MD5) v(n, m)
   LEFT JOIN pg_proc p ON p.proname = v.n AND p.pronamespace = 'public'::regnamespace;" "9/9"

apply(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1 | tr -d '\r' | grep -v '^$'; return ${PIPESTATUS[0]}; }
if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner) =="
  apply $DB "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  apply $DB "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

RPC(){ echo "SELECT public.$1;"; }
PUSHES="RESET ROLE; SELECT count(*) FROM net.calls WHERE url LIKE 'support-ride-resolved%';"
STATUS_PUSHES="RESET ROLE; SELECT count(*) FROM net.calls WHERE url NOT LIKE 'support-ride-resolved%';"

echo "== the wait charge keeps its rules =="
val "W1 _wait_charge_for equals the old calculate_wait_charge on 192 waits (24 hours x 8 lengths)" \
  "SELECT count(*) FROM public.wait_grid g, public._wait_charge_for('triciclo_basico', g.arrived, g.arrived + make_interval(secs => g.waited)) n
   WHERE (n.wait_minutes, n.billable_minutes, n.charge) IS DISTINCT FROM (g.wait_minutes, g.billable, g.charge);" "0"
val "W2 the new calculate_wait_charge gives the same 192 answers and writes the same columns" \
  "BEGIN; DO \$g\$ DECLARE g record; r record; BEGIN
     FOR g IN SELECT * FROM public.wait_grid LOOP
       UPDATE public.rides SET driver_arrived_at = g.arrived, pickup_at = g.arrived + make_interval(secs => g.waited) WHERE id = '$R_GRID';
       SELECT * INTO r FROM public.calculate_wait_charge('$R_GRID') AS (wait_minutes integer, billable_minutes integer, charge integer);
       IF (r.wait_minutes, r.billable_minutes, r.charge) IS DISTINCT FROM (g.wait_minutes, g.billable, g.charge)
          OR (SELECT (wait_time_minutes, wait_time_charge_cup) FROM public.rides WHERE id = '$R_GRID') IS DISTINCT FROM (g.wait_minutes, g.charge) THEN
         RAISE EXCEPTION 'differs at % +%', g.arrived, g.waited; END IF;
     END LOOP; END \$g\$; SELECT 'same'; ROLLBACK;" "same"
val "W3 no times, no charge" "SELECT (n).* FROM (SELECT public._wait_charge_for('triciclo_basico', NULL, now()) n) s;" "0|0|0"
val "W4 the grid has the 5:59 wait: 5 minutes, none billable" \
  "SELECT string_agg(DISTINCT wait_minutes || '|' || billable || '|' || charge, ' ') FROM public.wait_grid WHERE waited = 359;" "5|0|0"

echo "== GPS departure =="
val "D1 the first point beyond 100 m after arrival (exactly the 6-minute limit still counts as continuous)" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '14 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '8 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '7 minutes'")
   SELECT round(extract(epoch FROM now() - public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes')) / 60); ROLLBACK;" "8"
val "D2 a far point from before the arrival is ignored" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '20 minutes'")
   SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') IS NULL; ROLLBACK;" "t"
val "D3 never later than the server received it (a phone time in the future is capped)" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '2 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() + interval '30 minutes'")
   SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') = now(); ROLLBACK;" "t"
val "D4 no point: NULL" "SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') IS NULL;" "t"
val "D5 no arrival time: NULL" "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SELECT public._ride_gps_departure_at('$R_PICK', NULL) IS NULL; ROLLBACK;" "t"
DEP="SELECT round(extract(epoch FROM now() - public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes')) / 60);"
val "D6 a 14-minute silence before the first far point: departure = the last near point" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '14 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now()") $DEP ROLLBACK;" "14"
val "D6 ...and the arrival when no point came before" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '1 minute'") $DEP ROLLBACK;" "15"
val "D7 another driver's points on the ride are ignored (far or near)" \
  "BEGIN; UPDATE public.rides SET driver_id = '$DP_ANA' WHERE id = '$R_PICK';
     $(PT $R_PICK $DP_ANA "$PT_FAR" "now() - interval '12 minutes'") $(PT $R_PICK $DP_ANA "$PT_NEAR" "now() - interval '10 minutes'")
     UPDATE public.rides SET driver_id = '$DP_DIEGO' WHERE id = '$R_PICK';
     $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '8 minutes 30 seconds'") $DEP ROLLBACK;" "15"
val "D8 the silence limit is 6 minutes: 6 min 1 s already counts as silence (D1 is exactly 6)" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '14 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '7 minutes 59 seconds'") $DEP ROLLBACK;" "14"
val "D9 a 5 min 30 s gap before the first far point is not silence: departure = the far point" \
  "BEGIN; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '14 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '8 minutes 30 seconds'")
   SELECT public._ride_gps_departure_at('$R_PICK', now() - interval '15 minutes') = now() - interval '8 minutes 30 seconds'; ROLLBACK;" "t"

echo "== who may act =="
for fn in "admin_active_ride_context('$R_IP')" "admin_release_active_ride('$R_ACC','accepted','$DP_DIEGO','no responde')" \
          "admin_advance_active_ride('$R_PICK','arrived_at_pickup','$DP_DIEGO','sin gps')" "admin_complete_active_ride('$R_IP','in_progress','$DP_DIEGO',3065,'app caida')"; do
  val "G1 marketing is refused: ${fn%%(*}" "$(as $MKT "SELECT (public.$fn)->>'error';")" "forbidden"
  val "G2 a rider is refused: ${fn%%(*}" "$(as $RIDER "SELECT (public.$fn)->>'error';")" "forbidden"
done
err "G3 anon cannot call them" "BEGIN; SET LOCAL ROLE anon; SELECT public.admin_active_ride_context('$R_IP'); ROLLBACK;" "permission denied"
val "G4 the five helpers exist and are not executable by clients" \
  "SELECT count(*) || '|' || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE')
                                          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('_wait_charge_for','_ride_gps_departure_at','_active_ride_charge_preview','_support_ride_push','_reopen_ride_offers');" "5|0"
val "G8 the read-only helpers are STABLE" \
  "SELECT string_agg(proname || ':' || provolatile::text, ' ' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('_wait_charge_for','_ride_gps_departure_at','_active_ride_charge_preview');" \
  "_active_ride_charge_preview:s _ride_gps_departure_at:s _wait_charge_for:s"
val "G5 a super_admin may act (context and release)" \
  "$(as $SUPER "SELECT COALESCE(public.admin_active_ride_context('$R_IP')->>'error', 'ok');
     SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';")" "ok;true"
SELF_DRIVES="RESET ROLE; INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_SOFI', '$ADMIN');
  UPDATE public.rides SET driver_id = '$DP_SOFI' WHERE id IN ('$R_ACC', '$R_PICK', '$R_IP'); SET LOCAL ROLE authenticated;"
for fn in "admin_active_ride_context('$R_IP')" "admin_release_active_ride('$R_ACC','accepted','$DP_SOFI','no responde')" \
          "admin_advance_active_ride('$R_PICK','arrived_at_pickup','$DP_SOFI','sin gps')" "admin_complete_active_ride('$R_IP','in_progress','$DP_SOFI',3065,'app caida')"; do
  val "G6 an admin who drives the ride is refused: ${fn%%(*}" "$(as $ADMIN "$SELF_DRIVES SELECT (public.$fn)->>'error';")" "self_ride"
done
val "G7 an admin who is the rider is refused (context and complete)" \
  "$(as $ADMIN "RESET ROLE; UPDATE public.rides SET customer_id = '$ADMIN' WHERE id = '$R_IP'; SET LOCAL ROLE authenticated;
     SELECT public.admin_active_ride_context('$R_IP')->>'error';
     SELECT public.admin_complete_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 3065, 'app caida')->>'error';")" "self_ride;self_ride"

echo "== context =="
val "C1 allowed actions per status" \
  "$(as $ADMIN "SELECT string_agg(s || ':' || (public.admin_active_ride_context(id)->'allowed_actions')::text, ' ' ORDER BY s)
     FROM (VALUES ('$R_ACC'::uuid,'a'),('$R_ENR','b'),('$R_PICK','c'),('$R_IP','d'),('$R_DEST','e')) v(id, s);")" \
  'a:["release", "advance"] b:["release", "advance"] c:["advance"] d:["advance", "complete"] e:["complete"]'
val "C2 in_progress preview: agreed 3000, discount 500, waited 10 -> 5 billable" \
  "$(as $ADMIN "SELECT (p->>'agreed_cup') || '|' || (p->>'discount_cup') || '|' || (p->>'billable_minutes') || '|' ||
     ((p->>'total_cup')::int = 2500 + (p->>'wait_cup')::int)::text
     FROM (SELECT public.admin_active_ride_context('$R_IP')->'preview' p) s;")" "3000|500|5|true"
val "C3 arrived_at_pickup: start time from the GPS departure" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '12 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SET LOCAL ROLE authenticated;
     SELECT (c->>'start_pickup_source') || '|' || round(extract(epoch FROM now() - (c->>'start_pickup_at')::timestamptz) / 60)
     FROM (SELECT public.admin_active_ride_context('$R_PICK') c) s;")" "gps|9"
val "C4 driver, vehicle label without blank fields, alert" \
  "$(as $ADMIN "SELECT (c->'driver'->>'full_name') || '|' || (c->'driver'->>'vehicle_label') || '|' || (c->'alert'->>'reason')
     FROM (SELECT public.admin_active_ride_context('$R_IP') c) s;")" "Diego|Triciclo · T123|dead_driver_app"
val "C5 no snapshot, no preview" "$(as $ADMIN "SELECT public.admin_active_ride_context('$R_NOSNAP')->'preview' = 'null'::jsonb;")" "t"
val "C13 the ride's driver at the top level, for the panel to send back" \
  "$(as $ADMIN "SELECT public.admin_active_ride_context('$R_IP')->>'driver_profile_id';")" "$DP_DIEGO"
val "C17 the last point is the ride's driver's: a newer point of another driver is not shown" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_IP $DP_DIEGO "$PT_FAR" "now() - interval '5 minutes'") UPDATE public.rides SET driver_id = '$DP_ANA' WHERE id = '$R_IP';
     $(PT $R_IP $DP_ANA "$PT_NEAR" "now() - interval '1 minute'") UPDATE public.rides SET driver_id = '$DP_DIEGO' WHERE id = '$R_IP'; SET LOCAL ROLE authenticated;
     SELECT (public.admin_active_ride_context('$R_IP')->'last_point'->>'recorded_at')::timestamptz = now() - interval '5 minutes';")" "t"
val "C14 a ride scheduled later offers neither release nor advance" \
  "$(as $ADMIN "SELECT public.admin_active_ride_context('$R_SCHED')->'allowed_actions';")" "[]"

echo "== release =="
val "R1 releases an accepted ride like the automatic release, plus the GPS and proximity reset" \
  "$(as $ADMIN "RESET ROLE; UPDATE public.rides SET gps_override_confirmed_at = now(), driver_gps_status = 'rider_consented',
       proximity_pickup_notified_at = now() WHERE id = '$R_ACC';
     SET LOCAL ROLE authenticated; SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT status || '|' || (driver_id IS NULL) || '|' || (accepted_at IS NULL) || '|' || (searching_seen_at = now()) || '|' ||
       driver_gps_status || '|' || (gps_override_confirmed_at IS NULL) || '|' ||
       (SELECT count(*) FROM public.dispatch_calls WHERE ride_id = '$R_ACC') || '|' || (last_dispatched_at = now()) || '|' ||
       (SELECT is_online FROM public.driver_profiles WHERE id = '$DP_DIEGO') || '|' || (proximity_pickup_notified_at IS NULL)
     FROM public.rides WHERE id = '$R_ACC';")" \
  "true;searching|true|true|true|healthy|true|1|true|false|true"
val "R2 the driver goes offline, the accepted offer stays accepted, dispatch is called" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ENR', 'driver_en_route', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT (SELECT is_online FROM public.driver_profiles WHERE id = '$DP_DIEGO') || '|' ||
       (SELECT status FROM public.ride_offers WHERE ride_id = '$R_ENR') || '|' || (SELECT count(*) FROM public.dispatch_calls WHERE ride_id = '$R_ENR');")" \
  "true;false|accepted|1"
val "R3 two pushes (rider + driver), an audit row with the reason, the wait alert stamped" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success'; $PUSHES
     SELECT (SELECT reason FROM public.admin_actions WHERE action = 'support_release_ride') || '|' ||
       (SELECT wait_alert_sent_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R_ACC');")" \
  "true;2;no responde|true"
val "R4 refused when the status changed" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'driver_en_route', '$DP_DIEGO', 'x y z')->>'error';")" "ride_changed"
val "R5 refused after pickup" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 'x y z')->>'error';")" "ride_not_releasable"
val "R6 refused for a ride scheduled later" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_SCHED', 'accepted', '$DP_ANA', 'x y z')->>'error';")" "scheduled_not_due"
val "R7 refused without a reason" "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', '  ')->>'error';")" "reason_required"
val "R8 a failing dispatch keeps the release and logs dispatch_failed" \
  "$(as $ADMIN "SET LOCAL client_min_messages TO error; RESET ROLE; CREATE OR REPLACE FUNCTION public.dispatch_ride(p_ride_id uuid, p_radius_m integer DEFAULT 5000) RETURNS jsonb
       LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'boom'; END \$f\$; SET LOCAL ROLE authenticated;
     SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_ACC') || '|' || (SELECT outcome FROM public.rpc_attempt_log WHERE rpc_name = 'admin_release_active_ride');")" \
  "true;searching|dispatch_failed"
RETAKEN="RESET ROLE; UPDATE public.rides SET status = 'accepted', driver_id = '$DP_ANA', accepted_at = now() WHERE id = '$R_ACC'; SET LOCAL ROLE authenticated;"
val "R9 bound to the driver support saw: retaken by Ana -> ride_changed, Ana untouched" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success'; $RETAKEN
     SELECT (r->>'error') || '|' || (r->>'status') FROM (SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde') r) s;
     RESET ROLE; SELECT (SELECT driver_id FROM public.rides WHERE id = '$R_ACC') || '|' || (SELECT is_online FROM public.driver_profiles WHERE id = '$DP_ANA');")" \
  "true;ride_changed|accepted;$DP_ANA|true"
val "R10 the driver goes offline by hand: no auto_offline_at (he reconnects himself)" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT is_online || '|' || (auto_offline_at IS NULL) FROM public.driver_profiles WHERE id = '$DP_DIEGO';")" "true;false|true"
# Ana had been offered the ride (superseded when Diego took it), Beto had said no.
OTHER_OFFERS="RESET ROLE; INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at) VALUES
  ('$R_ACC', '$DP_ANA', 'superseded', now() - interval '9 minutes'), ('$R_ACC', '$DP_BETO', 'rejected', now() - interval '9 minutes');"
OFFERS_AFTER="SELECT string_agg(o.status || ':' || CASE WHEN o.status <> 'expired' THEN '-'
     WHEN o.expires_at < now() - make_interval(secs => public.get_platform_config_numeric('reoffer_cooldown_s', 120)::int) THEN 'rearmable' ELSE 'cooling' END,
     ' ' ORDER BY u.full_name) FROM public.ride_offers o JOIN public.driver_profiles dp ON dp.id = o.driver_profile_id JOIN public.users u ON u.id = dp.user_id
   WHERE o.ride_id = '$R_ACC';"
val "R11 the release reopens the other drivers' offers to dispatch; a rejection and the released driver's row stay" \
  "$(as $ADMIN "$OTHER_OFFERS SET LOCAL ROLE authenticated; SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; $OFFERS_AFTER")" "true;expired:rearmable rejected:- accepted:-"
val "R12 ...past the configured re-offer cooldown" \
  "$(as $ADMIN "$OTHER_OFFERS UPDATE public.platform_config SET value = '600' WHERE key = 'reoffer_cooldown_s'; SET LOCAL ROLE authenticated;
     SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT expires_at < now() - interval '600 seconds' FROM public.ride_offers WHERE ride_id = '$R_ACC' AND driver_profile_id = '$DP_ANA';")" "true;t"
val "R13 the automatic release (block A) also reopens the offers and resets GPS and proximity" \
  "BEGIN; $OTHER_OFFERS UPDATE public.rides SET proximity_pickup_notified_at = now(), driver_gps_status = 'rider_consented',
       gps_override_requested_at = now(), gps_override_confirmed_at = now(), gps_check_distance_m = 50, driver_custom_rate_cup = 100,
       driver_gps_unavailable_at = now() WHERE id = '$R_ACC';
     SELECT public.release_rides_from_dead_drivers()->>'released';
     SELECT status || '|' || (proximity_pickup_notified_at IS NULL) || '|' || driver_gps_status || '|' ||
       (num_nulls(gps_override_requested_at, gps_override_confirmed_at, gps_check_distance_m, driver_custom_rate_cup, driver_gps_unavailable_at) = 5)
       FROM public.rides WHERE id = '$R_ACC';
     $OFFERS_AFTER ROLLBACK;" "2;searching|true|healthy|true;expired:rearmable rejected:- accepted:-"

# L1: a session holding the driver's row (as block A and update_driver_position do,
# driver first) must not find the release already holding the ride.
lock_order(){ local a b w=0 c i out; out=$(mktemp)
  PGAPPNAME=l1a $BIN/psql $CONN -d $DB -qAt -c "BEGIN; SELECT 1 FROM public.driver_profiles WHERE id = '$DP_DIEGO' FOR UPDATE; SELECT pg_sleep(3); ROLLBACK;" >/dev/null 2>&1 & a=$!
  sleep 0.5
  PGAPPNAME=l1b $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 \
    -c "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ENR', 'driver_en_route', '$DP_DIEGO', 'no responde')->>'success';")" >"$out" 2>&1 & b=$!
  for i in $(seq 1 40); do
    [ "$(run $DB "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'l1b' AND wait_event_type = 'Lock';")" = "1" ] && { w=1; break; }
    sleep 0.1; done
  c=$(run $DB "BEGIN; SELECT 'free' FROM public.rides WHERE id = '$R_ENR' FOR UPDATE NOWAIT; ROLLBACK;")
  wait $a $b; echo "$w|$c|$(tr -d '\r' < "$out" | sed '/^$/d' | paste -sd';' -)"; rm -f "$out"; }
L1=$(lock_order); [ "$L1" = "1|free|true" ] && ok "L1 the release locks the driver before the ride" || ko "L1 the release locks the driver before the ride" "expected [1|free|true], got [$L1]"

echo "== advance =="
val "A1 accepted -> arrived_at_pickup in exactly one transition and one status push for the ride, arrival = now" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'sin gps')->>'status';
     RESET ROLE; SELECT (SELECT string_agg(from_status || '>' || to_status, ',') FROM public.ride_transitions WHERE ride_id = '$R_ACC') || '|' ||
       (SELECT string_agg(body->>'title', ',') FROM net.calls WHERE url NOT LIKE 'support-ride-resolved%' AND body->'data'->>'ride_id' = '$R_ACC') || '|' ||
       (SELECT driver_arrived_at = now() FROM public.rides WHERE id = '$R_ACC');")" "arrived_at_pickup;accepted>arrived_at_pickup|Conductor llegó|true"
val "A2 arrived_at_pickup -> in_progress with pickup at the GPS departure" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '12 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SET LOCAL ROLE authenticated;
     SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 'sin gps')->>'status';
     RESET ROLE; SELECT round(extract(epoch FROM now() - pickup_at) / 60) FROM public.rides WHERE id = '$R_PICK';")" "in_progress;9"
val "A3 no departure point: pickup = arrival, so no wait" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 'sin gps')->>'success';
     RESET ROLE; SELECT pickup_at = driver_arrived_at FROM public.rides WHERE id = '$R_PICK';")" \
  "true;t"
val "A4 in_progress -> arrived_at_destination, the driver gets the support push" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 'sin gps')->>'status'; $PUSHES")" "arrived_at_destination;1"
val "A5 refused at the destination" "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_DEST', 'arrived_at_destination', '$DP_DIEGO', 'x y z')->>'error';")" "ride_not_advanceable"
val "A6 refused when the status changed" "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_PICK', 'accepted', '$DP_DIEGO', 'x y z')->>'error';")" "ride_changed"
val "A8 bound to the driver support saw: retaken by Ana -> ride_changed" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success'; $RETAKEN
     SELECT public.admin_advance_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'sin gps')->>'error';
     RESET ROLE; SELECT status || '|' || driver_id || '|' || (driver_arrived_at IS NULL) FROM public.rides WHERE id = '$R_ACC';")" \
  "true;ride_changed;accepted|$DP_ANA|true"
val "A9 refused for a ride scheduled later" "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_SCHED', 'accepted', '$DP_ANA', 'x y z')->>'error';")" "scheduled_not_due"
val "A10 'viaje iniciado' returns the times it wrote and the wait, the one the context previewed" \
  "$(as $ADMIN "RESET ROLE; $(PT $R_PICK $DP_DIEGO "$PT_NEAR" "now() - interval '12 minutes'") $(PT $R_PICK $DP_DIEGO "$PT_FAR" "now() - interval '9 minutes'") SET LOCAL ROLE authenticated;
     SELECT set_config('t.wait', public.admin_active_ride_context('$R_PICK')->'preview'->>'wait_cup', true) IS NOT NULL;
     SELECT (r->>'status') || '|' || round(extract(epoch FROM now() - (r->>'driver_arrived_at')::timestamptz) / 60) || '|' ||
       ((r->>'pickup_at')::timestamptz = now() - interval '9 minutes') || '|' || (r->>'wait_minutes') || '|' || (r->>'billable_minutes') || '|' ||
       ((r->>'wait_cup')::int = current_setting('t.wait')::int AND (r->>'wait_cup')::int > 0)
     FROM (SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 'sin gps') r) s;")" "t;in_progress|15|true|6|1|true"
val "A11 'llegada' returns the arrival, no pickup and no wait yet" \
  "$(as $ADMIN "SELECT (r->>'status') || '|' || ((r->>'driver_arrived_at')::timestamptz = now()) || '|' || (r->'pickup_at')::text || '|' ||
       (r->>'wait_minutes') || (r->>'billable_minutes') || (r->>'wait_cup')
     FROM (SELECT public.admin_advance_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'sin gps') r) s;")" "arrived_at_pickup|true|null|000"
val "A7 the new transition is admin-only" \
  "SELECT allowed_roles::text FROM public.valid_transitions WHERE from_status = 'accepted' AND to_status = 'arrived_at_pickup';" "{admin,super_admin}"

echo "== complete =="
val "C6 charges agreed - discount + recorded wait, through complete_ride_and_pay" \
  "$(as $ADMIN "SELECT set_config('t.total', public.admin_active_ride_context('$R_IP')->'preview'->>'total_cup', true) IS NOT NULL;
     SELECT (public.admin_complete_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', current_setting('t.total')::int, 'app caida'))->>'success';
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_IP') || '|' ||
       (SELECT final_fare_cup = current_setting('t.total')::int FROM public.rides WHERE id = '$R_IP') || '|' || (SELECT distance_m FROM public.complete_calls) || '|' ||
       (SELECT resolved_at IS NOT NULL FROM public.stuck_ride_alerts WHERE ride_id = '$R_IP') || '|' ||
       (SELECT count(*) FROM public.admin_actions WHERE action = 'support_complete_ride');")" \
  "t;true;completed|true|4000|true|1"
val "C7 refused when the amount changed" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 1, 'app caida')->>'error';")" "amount_changed"
val "C8 refused without an agreed price" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_NOSNAP', 'in_progress', '$DP_ANA', 3000, 'app caida')->>'error';")" "no_agreed_price"
val "C9 refused before pickup" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 3000, 'x y z')->>'error';")" "ride_not_completable"
val "C10 refused when the status changed" "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_DEST', 'in_progress', '$DP_DIEGO', 3000, 'x y z')->>'error';")" "ride_changed"
val "C11 completion sends no support push (the status trigger already pushes both)" \
  "$(as $ADMIN "SELECT public.admin_complete_active_ride('$R_DEST', 'arrived_at_destination', '$DP_DIEGO',
       (public.admin_active_ride_context('$R_DEST')->'preview'->>'total_cup')::int, 'app caida')->>'success'; $PUSHES $STATUS_PUSHES")" "true;0;2"

val "C12 bound to the driver support saw: reassigned to Ana -> ride_changed, nothing charged" \
  "$(as $ADMIN "RESET ROLE; UPDATE public.rides SET driver_id = '$DP_ANA' WHERE id = '$R_IP'; SET LOCAL ROLE authenticated;
     SELECT (r->>'error') || '|' || (r->>'status') FROM (SELECT public.admin_complete_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 3065, 'app caida') r) s;
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_IP') || '|' || (SELECT count(*) FROM public.complete_calls);")" \
  "ride_changed|in_progress;in_progress|0"
CARGO="RESET ROLE; UPDATE public.rides SET ride_mode = 'cargo' WHERE id = '$R_IP';"
COMPLETE_IP="SELECT public.admin_complete_active_ride('$R_IP', 'in_progress', '$DP_DIEGO',
     (public.admin_active_ride_context('$R_IP')->'preview'->>'total_cup')::int, 'app caida')"
val "C15 a cargo ride without the delivery proof (code and photo) is not completed, nor offered" \
  "$(as $ADMIN "$CARGO INSERT INTO public.delivery_details (ride_id, delivery_otp_validated_at) VALUES ('$R_IP', now()); SET LOCAL ROLE authenticated;
     SELECT (c->'allowed_actions')::text || '|' || (c->>'delivery_proof_missing') FROM (SELECT public.admin_active_ride_context('$R_IP') c) s;
     SELECT (r->>'error') || '|' || (r->>'status') FROM ($COMPLETE_IP r) s;
     RESET ROLE; SELECT status || '|' || (SELECT count(*) FROM public.complete_calls) FROM public.rides WHERE id = '$R_IP';")" \
  '["advance"]|true;delivery_proof_missing|in_progress;in_progress|0'
val "C16 with the proof it is offered and completes; a passenger ride never misses a proof" \
  "$(as $ADMIN "$CARGO INSERT INTO public.delivery_details VALUES ('$R_IP', now(), 'delivery-photos/x.jpg'); SET LOCAL ROLE authenticated;
     SELECT (c->'allowed_actions')::text || '|' || (c->>'delivery_proof_missing') FROM (SELECT public.admin_active_ride_context('$R_IP') c) s;
     SELECT ($COMPLETE_IP)->>'success';
     SELECT public.admin_active_ride_context('$R_DEST')->>'delivery_proof_missing';")" \
  '["advance", "complete"]|false;true;false'
# complete_ride_and_pay's own cash_amount_cup / wallet_amount_cup are 0 on a cash ride (prod fills
# them only for a mixed ride, a split and the wallet shortfall), so the migration derives them
# from the ride row: cash = the whole fare on a cash ride, the shortfall on a mixed one.
val "C18 a cash ride: the whole fare is cash to collect, nothing from a wallet" \
  "$(as $ADMIN "SELECT set_config('t.total', public.admin_active_ride_context('$R_DEST')->'preview'->>'total_cup', true) IS NOT NULL;
     SELECT ((r->>'final_fare_cup')::int = current_setting('t.total')::int) || '|' || (r->>'payment_method') || '|' ||
       ((r->>'cash_amount_cup')::int = current_setting('t.total')::int) || '|' || (r->>'wallet_amount_cup') || '|' || (r->>'status')
     FROM (SELECT public.admin_complete_active_ride('$R_DEST', 'arrived_at_destination', '$DP_DIEGO', current_setting('t.total')::int, 'app caida') r) s;")" \
  "t;true|cash|true|0|completed"
WALLET_RIDE="RESET ROLE; UPDATE public.rides SET payment_method = 'tricicoin' WHERE id = '$R_DEST';"
COMPLETE_DEST="SELECT (r->>'final_fare_cup') || '|' || (r->>'payment_method') || '|' || (r->>'cash_amount_cup') || '|' || (r->>'wallet_amount_cup')
     FROM (SELECT public.admin_complete_active_ride('$R_DEST', 'arrived_at_destination', '$DP_DIEGO', 3000, 'app caida') r) s;"
val "C19 a wallet ride the wallet does not cover (balance 2000 of 3000): mixed, the shortfall is the cash to collect" \
  "$(as $ADMIN "$WALLET_RIDE INSERT INTO public.stub_wallet VALUES ('$RIDER', 2000); SET LOCAL ROLE authenticated;
     $COMPLETE_DEST RESET ROLE; SELECT payment_method || '|' || cash_amount_cup FROM public.rides WHERE id = '$R_DEST';")" \
  "3000|mixed|1000|2000;mixed|1000"
val "C20 a wallet ride the wallet covers: nothing to collect, the whole fare from the wallet" \
  "$(as $ADMIN "$WALLET_RIDE INSERT INTO public.stub_wallet VALUES ('$RIDER', 5000); SET LOCAL ROLE authenticated;
     $COMPLETE_DEST RESET ROLE; SELECT payment_method || '|' || COALESCE(cash_amount_cup, 0) FROM public.rides WHERE id = '$R_DEST';")" \
  "3000|tricicoin|0|3000;tricicoin|0"

echo "== pushes =="
val "P1 a push without a service key keeps the action and logs push_failed" \
  "$(as $ADMIN "SET LOCAL client_min_messages TO error; RESET ROLE; CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS \$f\$ SELECT NULL::text \$f\$; SET LOCAL ROLE authenticated;
     SELECT public.admin_advance_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 'sin gps')->>'status';
     RESET ROLE; SELECT outcome FROM public.rpc_attempt_log WHERE rpc_name = 'admin_advance_active_ride';")" "arrived_at_destination;push_failed"
val "P1b a push whose cron_http_post raises keeps the release and logs push_failed for each" \
  "$(as $ADMIN "SET LOCAL client_min_messages TO error; RESET ROLE; CREATE OR REPLACE FUNCTION public.cron_http_post(p_jobname text, url text,
       headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 30000)
       RETURNS bigint LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'pg_net is down'; END \$f\$; SET LOCAL ROLE authenticated;
     SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success';
     RESET ROLE; SELECT (SELECT status FROM public.rides WHERE id = '$R_ACC') || '|' ||
       (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'admin_release_active_ride' AND outcome = 'push_failed');")" "true;searching|2"
SUPPORT_PUSHES="RESET ROLE; SELECT string_agg((body->>'title') || ' / ' || (body->>'body'), ' # ' ORDER BY id) FROM net.calls WHERE url LIKE 'support-ride-resolved%';"
val "P2 release: the rider is told we look for another driver, the driver what support did" \
  "$(as $ADMIN "SELECT public.admin_release_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'no responde')->>'success'; $SUPPORT_PUSHES")" \
  "true;Buscando otro conductor / Tu conductor no pudo continuar. Estamos buscándote otro ahora mismo. # Soporte te quitó el viaje / Estamos buscando otro conductor para este viaje. Te pusimos fuera de línea: conéctate cuando puedas tomar viajes."
val "P3 advance: one sentence per step for the driver" \
  "$(as $ADMIN "SELECT public.admin_advance_active_ride('$R_ACC', 'accepted', '$DP_DIEGO', 'sin gps')->>'success';
     SELECT public.admin_advance_active_ride('$R_PICK', 'arrived_at_pickup', '$DP_DIEGO', 'sin gps')->>'success';
     SELECT public.admin_advance_active_ride('$R_IP', 'in_progress', '$DP_DIEGO', 'sin gps')->>'success'; $SUPPORT_PUSHES")" \
  "true;true;true;Soporte actualizó tu viaje / Marcamos que llegaste al punto de recogida. # Soporte actualizó tu viaje / Marcamos el viaje como iniciado. # Soporte actualizó tu viaje / Marcamos que llegaste al destino."

if [ "$MIG" != "none" ]; then
  echo "== CRLF copy applies and leaves no carriage return =="
  fresh pr660crlf >/dev/null && grid pr660crlf >/dev/null
  CRLF_COPY=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF_COPY"
  apply pr660crlf "$CRLF_COPY" >/dev/null && ok "X1 a CRLF copy applies" || ko "X1 a CRLF copy applies" "migration failed"
  val "X2 ...and no body keeps a carriage return" \
    "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(chr(13) IN prosrc) > 0;" "0" pr660crlf
  rm -f "$CRLF_COPY"

  echo "== the checks fail when their promise is broken =="
  neg(){ fresh pr660neg >/dev/null && grid pr660neg >/dev/null
         run pr660neg "$1" >/dev/null
         local r; r=$(apply pr660neg "$MIG")
         if echo "$r" | grep -q "$2"; then ok "$3"; else ko "$3" "expected [$2], got [$r]"; fi; }
  neg "CREATE OR REPLACE FUNCTION public.calculate_wait_charge(p_ride_id uuid) RETURNS record LANGUAGE plpgsql AS \$f\$ DECLARE r record; BEGIN SELECT 0 AS a INTO r; RETURN r; END \$f\$;" \
      "is not the body this migration replaces" "N1 refuses an unknown calculate_wait_charge"
  neg "INSERT INTO public.valid_transitions VALUES ('accepted','arrived_at_pickup','{driver,admin,super_admin}');" \
      "must be for admin and super_admin only" "N2 refuses a driver-open accepted -> arrived_at_pickup"
  neg "CREATE OR REPLACE FUNCTION public.release_rides_from_dead_drivers() RETURNS jsonb LANGUAGE plpgsql AS \$f\$ BEGIN RETURN '{}'; END \$f\$;" \
      "is not the body this migration patches" "N4 refuses an unknown release_rides_from_dead_drivers"
  neg "CREATE OR REPLACE FUNCTION public._wait_charge_for(p text) RETURNS int LANGUAGE sql AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public._wait_charge_for(text) TO authenticated;" \
      "executable by a client role" "N3 refuses a client-executable helper overload"
  neg "CREATE FUNCTION public.admin_release_active_ride(p uuid) RETURNS jsonb LANGUAGE sql SET search_path = public, pg_catalog AS 'SELECT NULL::jsonb';" \
      "is not SECURITY DEFINER with a fixed search_path" "N5 refuses an RPC that is not SECURITY DEFINER"
  neg "CREATE FUNCTION public.admin_advance_active_ride(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS 'SELECT NULL::jsonb';" \
      "is not SECURITY DEFINER with a fixed search_path" "N6 refuses an RPC without a fixed search_path"
  neg "CREATE FUNCTION public.admin_complete_active_ride(p uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS 'SELECT NULL::jsonb'; GRANT EXECUTE ON FUNCTION public.admin_complete_active_ride(uuid) TO anon;" \
      "is executable by anon" "N7 refuses an RPC that anon may run"
  neg "CREATE FUNCTION public._reopen_ride_offers(p uuid) RETURNS integer LANGUAGE sql SET search_path = public, pg_catalog AS 'SELECT 0'; REVOKE ALL ON FUNCTION public._reopen_ride_offers(uuid) FROM PUBLIC;" \
      "is not SECURITY DEFINER with a fixed search_path" "N8 refuses a writing helper that is not SECURITY DEFINER"
fi

echo
echo "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ]
