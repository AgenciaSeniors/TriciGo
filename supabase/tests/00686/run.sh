#!/usr/bin/env bash
# Rehearsal for migration 00686 (local Postgres 16; PostGIS not needed).
#   supabase/tests/00686/run.sh none                                              -> RED
#   supabase/tests/00686/run.sh supabase/migrations/00686_reclaim_released_ride.sql -> GREEN
#     (+ applied twice, a CRLF copy, and negative tests of its own guards)
# Env: PGBIN (default /usr/lib/postgresql/16/bin), PGPORT (default 5433), user pgtest.
#      PSQL: another client to run instead of $PGBIN/psql, with psql's flags
#      (e.g. "python -I pgq.py" when only a server binary is at hand).
# Base: scaffold.sql + live-bodies.sql (the prod bodies of 2026-11-18).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
case "$MIG" in none|/*) ;; *) MIG="$ROOT/$MIG" ;; esac
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
if [ -n "${PSQL:-}" ]; then read -ra PSQL_CMD <<< "$PSQL"; else PSQL_CMD=("$BIN/psql"); fi
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "${PSQL_CMD[@]}" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "$2" "$3"); if [ "$r" = "$4" ]; then ok "$1"; else ko "$1" "expected [$4], got [$r]"; fi; }
# The statement ran without an ERROR (a WARNING from an isolated block is fine).
noerr(){ local r; r=$(run "$2" "$3"); if echo "$r" | grep -q "ERROR"; then ko "$1" "$r"; else ok "$1"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001
RIDER2=a0000000-0000-4000-8000-000000000002
DIEGO=d0000000-0000-4000-8000-000000000001
ANA=d0000000-0000-4000-8000-000000000002
ADMIN=e0000000-0000-4000-8000-000000000001
DP_D=dd000000-0000-4000-8000-000000000001
DP_A=dd000000-0000-4000-8000-000000000002
R1=11111111-0000-4000-8000-000000000001   # the ride Diego was doing when his phone went silent
R2=11111111-0000-4000-8000-000000000002   # another ride, for "he took another one since"
ACCEPTED_AT="2026-11-17 20:28:20+00"
NOTIFIED_AT="2026-11-17 20:29:00+00"
POS_SIG="uuid, double precision, double precision, double precision, double precision, uuid"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('release_rides_from_dead_drivers',
  '_reclaim_released_ride', 'update_driver_position', 'driver_heartbeat', 'tg_ride_location_events_guard')"

# A statement run as a signed-in user: auth.uid() = $1, role authenticated.
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s COMMIT;" "$1" "$2"; }
pos(){ echo "SELECT public.update_driver_position('$1', 23.0818, -82.4419, 90, 5, $2);"; }

apply_mig(){ "${PSQL_CMD[@]}" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f "$2" 2>&1 | tr -d '\r'; }

# A database with the prod bodies, Diego's ride released by the dead-driver job
# and a new offer to Ana, as in the incident. $2 = migration file or none.
fresh(){
  "${PSQL_CMD[@]}" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
  (cd "$DIR" && "${PSQL_CMD[@]}" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql -f live-bodies.sql >/dev/null 2>&1) \
    || { echo "scaffold failed for $1"; return 1; }
  if [ "$2" != none ]; then
    local out; out=$(apply_mig "$1" "$2"); [ -z "$(echo "$out" | grep -i error)" ] || { echo "migration failed: $out"; return 1; }
  fi
  "${PSQL_CMD[@]}" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER','customer','Luis'), ('$RIDER2','customer','Otro'), ('$DIEGO','driver','Diego'),
    ('$ANA','driver','Ana'), ('$ADMIN','admin','Sofi');
  INSERT INTO public.driver_profiles (id, user_id, status, is_online, last_heartbeat_at, custom_per_km_rate_cup) VALUES
    ('$DP_D','$DIEGO','approved', true, now() - interval '13 minutes', 50),
    ('$DP_A','$ANA','approved', true, now(), NULL);
  INSERT INTO public.vehicles (driver_id) VALUES ('$DP_D'), ('$DP_A');
  INSERT INTO public.rides (id, customer_id, driver_id, status, estimated_fare_cup, accepted_at,
                            driver_custom_rate_cup, proximity_pickup_notified_at) VALUES
    ('$R1','$RIDER','$DP_D','accepted', 1452, '$ACCEPTED_AT', 50, '$NOTIFIED_AT');
  INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, responded_at) VALUES
    ('$R1','$DP_D','accepted','$ACCEPTED_AT');
  SELECT public.release_rides_from_dead_drivers();
  INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at) VALUES
    ('$R1','$DP_A','pending', now() + interval '1 minute');" >/dev/null 2>&1 || { echo "seed failed for $1"; return 1; }
}

RIDE_STATE="SELECT status || '|' || coalesce(driver_id::text, '-') FROM public.rides WHERE id = '$R1'"
PTS(){ echo "SELECT count(*) FROM public.ride_location_events WHERE ride_id = '$R1' AND driver_id = '$1'"; }

echo "== migration: $MIG"

# --- A/B: the incident. Diego comes back and calls update_driver_position with the ride.
fresh r686a "$MIG" || exit 1
val "A1 the dead-driver job still releases the ride" r686a "$RIDE_STATE" "searching|-"
val "A2 the release records who lost it and what he had" r686a "SELECT driver_profile_id || '|' || (accepted_at = '$ACCEPTED_AT') || '|' || driver_custom_rate_cup || '|' || (proximity_pickup_notified_at = '$NOTIFIED_AT') || '|' || (reclaimed_at IS NULL) FROM public.dead_driver_releases WHERE ride_id = '$R1'" "$DP_D|true|50|true|true"
run r686a "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "B1 his position call gives him the ride back" r686a "$RIDE_STATE" "accepted|$DP_D"
val "B2 with the accepted_at, rate and proximity mark he had" r686a "SELECT (accepted_at = '$ACCEPTED_AT') || '|' || driver_custom_rate_cup || '|' || (proximity_pickup_notified_at = '$NOTIFIED_AT') FROM public.rides WHERE id = '$R1'" "true|50|true"
val "B3 the offer sent to Ana while it searched loses" r686a "SELECT status FROM public.ride_offers WHERE ride_id = '$R1' AND driver_profile_id = '$DP_A'" "superseded"
val "B4 the transition is his, as a driver" r686a "SELECT from_status || '|' || to_status || '|' || actor_id || '|' || actor_role FROM public.ride_transitions WHERE ride_id = '$R1' ORDER BY created_at DESC LIMIT 1" "searching|accepted|$DIEGO|driver"
val "B5 his heartbeat is fresh again" r686a "SELECT last_heartbeat_at > now() - interval '1 minute' FROM public.driver_profiles WHERE id = '$DP_D'" "t"
val "B6 the point he sent with it is kept" r686a "$(PTS "$DP_D")" "1"
val "B7 the release is marked reclaimed and logged" r686a "SELECT (SELECT reclaimed_at IS NOT NULL FROM public.dead_driver_releases WHERE ride_id = '$R1') || '|' || (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'reclaim_released_ride' AND outcome = 'success' AND target_id = '$R1')" "true|1"
run r686a "SELECT public.release_rides_from_dead_drivers();" >/dev/null
val "B8 the next pass of the release job leaves it with him" r686a "$RIDE_STATE" "accepted|$DP_D"
run r686a "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "B9 later position calls change nothing" r686a "SELECT (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'reclaim_released_ride') || '|' || ($(PTS "$DP_D"))" "1|2"

# --- C: the heartbeat path (the background task).
fresh r686c "$MIG" || exit 1
run r686c "$(as "$DIEGO" "SELECT public.driver_heartbeat('$DP_D');")" >/dev/null
val "C1 his heartbeat gives him the ride back, and the auto-restore puts him online" r686c "SELECT r.status || '|' || r.driver_id || '|' || dp.is_online FROM public.rides r JOIN public.driver_profiles dp ON dp.id = '$DP_D' WHERE r.id = '$R1'" "accepted|$DP_D|true"

# --- D: his GPS backlog arrives before any reclaim call (the background task inserts directly).
fresh r686d "$MIG" || exit 1
run r686d "$(as "$DIEGO" "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$R1', '$DP_D', 'POINT(-82.44 23.08)', now() - interval '10 minutes');")" >/dev/null
val "D1 his points on the released ride are kept, and do not move the ride" r686d "SELECT ($(PTS "$DP_D")) || '|' || ($RIDE_STATE)" "1|searching|-"
run r686d "$(as "$ANA" "INSERT INTO public.ride_location_events (ride_id, driver_id, location) VALUES ('$R1', '$DP_A', 'POINT(-82.44 23.08)');")" >/dev/null
val "D2 another driver's points on it are still dropped" r686d "$(PTS "$DP_A")" "0"

# --- E: another driver took it first.
fresh r686e "$MIG" || exit 1
run r686e "UPDATE public.rides SET status = 'accepted', driver_id = '$DP_A', accepted_at = now() WHERE id = '$R1';" >/dev/null
run r686e "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "E1 a ride another driver accepted stays his" r686e "$RIDE_STATE" "accepted|$DP_A"
val "E2 Diego's point on it is dropped, his position still saved" r686e "SELECT ($(PTS "$DP_D")) || '|' || (SELECT current_location IS NOT NULL FROM public.driver_profiles WHERE id = '$DP_D')" "0|true"

# --- F: the passenger cancelled it first.
fresh r686f "$MIG" || exit 1
run r686f "UPDATE public.rides SET status = 'canceled', canceled_at = now() WHERE id = '$R1';" >/dev/null
run r686f "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "F1 a cancelled ride stays cancelled; his point is kept as the record" r686f "SELECT ($RIDE_STATE) || '|' || ($(PTS "$DP_D"))" "canceled|-|1"

# --- G: he comes back after the window.
fresh r686g "$MIG" || exit 1
run r686g "UPDATE public.dead_driver_releases SET released_at = now() - interval '20 minutes';" >/dev/null
run r686g "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "G1 after the window: no reclaim, the point is dropped" r686g "SELECT ($RIDE_STATE) || '|' || ($(PTS "$DP_D"))" "searching|-|0"

# --- H: he took another ride since.
fresh r686h "$MIG" || exit 1
run r686h "INSERT INTO public.rides (id, customer_id, driver_id, status, accepted_at) VALUES ('$R2', '$RIDER2', '$DP_D', 'accepted', now());" >/dev/null
noerr "H1 the position call still works" r686h "$(as "$DIEGO" "$(pos "$DP_D" "NULL")")"
val "H2 the first ride is not taken back" r686h "SELECT ($RIDE_STATE) || '|' || (SELECT status FROM public.rides WHERE id = '$R2')" "searching|-|accepted"

# --- I: an admin's heartbeat for him is no sign of life.
fresh r686i "$MIG" || exit 1
run r686i "$(as "$ADMIN" "SELECT public.driver_heartbeat('$DP_D');")" >/dev/null
val "I1 an admin heartbeat does not reclaim" r686i "$RIDE_STATE" "searching|-"

# --- J: he was suspended meanwhile.
fresh r686j "$MIG" || exit 1
run r686j "UPDATE public.driver_profiles SET status = 'suspended' WHERE id = '$DP_D';" >/dev/null
noerr "J1 the heartbeat still works" r686j "$(as "$DIEGO" "SELECT public.driver_heartbeat('$DP_D');")"
val "J2 a suspended driver does not get it back" r686j "$RIDE_STATE" "searching|-"

# --- K: window 0 turns it off.
fresh r686k "$MIG" || exit 1
run r686k "UPDATE public.platform_config SET value = to_jsonb(0) WHERE key = 'dead_driver_reclaim_window_min';" >/dev/null
run r686k "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")" >/dev/null
val "K1 window 0: no reclaim and the point is dropped" r686k "SELECT ($RIDE_STATE) || '|' || ($(PTS "$DP_D"))" "searching|-|0"

# --- L: a failing reclaim never costs the position update.
fresh r686l "$MIG" || exit 1
run r686l "DELETE FROM public.valid_transitions WHERE from_status = 'searching' AND to_status = 'accepted';" >/dev/null
noerr "L1 the position call does not fail" r686l "$(as "$DIEGO" "$(pos "$DP_D" "'$R1'")")"
val "L2 the position is saved, the ride left as it was, the failure logged" r686l "SELECT (SELECT current_location IS NOT NULL FROM public.driver_profiles WHERE id = '$DP_D') || '|' || ($RIDE_STATE) || '|' || (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'reclaim_released_ride' AND outcome = 'reclaim_failed')" "true|searching|-|1"

# --- M: permissions.
val "M1 clients cannot call _reclaim_released_ride" r686a "SELECT has_function_privilege('anon', 'public._reclaim_released_ride(uuid)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public._reclaim_released_ride(uuid)', 'EXECUTE')" "false|false"
val "M2 clients cannot read dead_driver_releases; the service role can" r686a "SELECT has_table_privilege('authenticated', 'public.dead_driver_releases', 'SELECT') || '|' || has_table_privilege('anon', 'public.dead_driver_releases', 'SELECT') || '|' || has_table_privilege('service_role', 'public.dead_driver_releases', 'SELECT')" "false|false|true"
val "M3 the position and heartbeat calls keep their grants" r686a "SELECT has_function_privilege('authenticated', 'public.update_driver_position($POS_SIG)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.driver_heartbeat(uuid)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.release_rides_from_dead_drivers()', 'EXECUTE')" "true|true|false"

# --- N: the migration itself.
if [ "$MIG" != none ]; then
  B1=$(run r686a "$BODIES")
  out=$(apply_mig r686a "$MIG")
  if echo "$out" | grep -qi error; then ko "N1 applies twice" "$out"; else ok "N1 applies twice"; fi
  val "N2 the second run leaves the same bodies" r686a "$BODIES" "$B1"

  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh r686n "$CRLF" || ko "N3 a CRLF copy applies" "fresh failed"
  val "N3 a CRLF copy leaves the same bodies" r686n "$BODIES" "$B1"
  rm -f "$CRLF"

  "${PSQL_CMD[@]}" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS r686x" -c "CREATE DATABASE r686x" >/dev/null 2>&1
  (cd "$DIR" && "${PSQL_CMD[@]}" $CONN -d r686x -qAt -v ON_ERROR_STOP=1 -f scaffold.sql -f live-bodies.sql >/dev/null 2>&1)
  run r686x "CREATE OR REPLACE FUNCTION public.release_rides_from_dead_drivers() RETURNS jsonb LANGUAGE plpgsql AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$;" >/dev/null
  out=$(apply_mig r686x "$MIG")
  if echo "$out" | grep -q "release_rides_from_dead_drivers is not the body"; then ok "N4 refuses a release body it does not know"; else ko "N4 refuses a release body it does not know" "$out"; fi
  val "N5 and leaves nothing behind" r686x "SELECT to_regclass('public.dead_driver_releases') IS NULL" "t"

  "${PSQL_CMD[@]}" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS r686y" -c "CREATE DATABASE r686y" >/dev/null 2>&1
  (cd "$DIR" && "${PSQL_CMD[@]}" $CONN -d r686y -qAt -v ON_ERROR_STOP=1 -f scaffold.sql -f live-bodies.sql >/dev/null 2>&1)
  run r686y "CREATE OR REPLACE FUNCTION public.tg_ride_location_events_guard() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;" >/dev/null
  out=$(apply_mig r686y "$MIG")
  if echo "$out" | grep -q "tg_ride_location_events_guard is not the body"; then ok "N6 refuses a guard body it does not know"; else ko "N6 refuses a guard body it does not know" "$out"; fi

  # The migration revokes before it checks, so a grant added by hand is gone by
  # then. What the check guards against is a copy that loses its REVOKE.
  NOREV="$(mktemp)"; grep -v "^REVOKE ALL ON FUNCTION public._reclaim_released_ride" "$MIG" > "$NOREV"
  "${PSQL_CMD[@]}" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS r686z" -c "CREATE DATABASE r686z" >/dev/null 2>&1
  (cd "$DIR" && "${PSQL_CMD[@]}" $CONN -d r686z -qAt -v ON_ERROR_STOP=1 -f scaffold.sql -f live-bodies.sql >/dev/null 2>&1)
  out=$(apply_mig r686z "$NOREV"); rm -f "$NOREV"
  if echo "$out" | grep -q "clients can call _reclaim_released_ride"; then ok "N7 its checks catch a copy without the REVOKE"; else ko "N7 its checks catch a copy without the REVOKE" "$out"; fi
  val "N8 and that copy leaves nothing behind" r686z "SELECT to_regclass('public.dead_driver_releases') IS NULL" "t"
fi

echo "== $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
