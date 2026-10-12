#!/usr/bin/env bash
# Rehearsal runner for migration 00659 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00659/run.sh none
#       -> scaffold (prod's tables, policies, grants and live function bodies) + tests (RED)
#   supabase/tests/00659/run.sh supabase/migrations/00659_ride_trail_guards.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00659/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr659
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001
DIEGO=d0000000-0000-4000-8000-000000000001     # driver of OWN and OWN_IP
ANA=d0000000-0000-4000-8000-000000000002       # driver of FOREIGN
DP_DIEGO=dd000000-0000-4000-8000-000000000001
DP_ANA=dd000000-0000-4000-8000-000000000002
OWN=11111111-0000-4000-8000-000000000001       # Diego's, driver_en_route, accepted 25 min ago
OWN_IP=11111111-0000-4000-8000-000000000002    # Diego's, in_progress, picked up 10 min ago
FOREIGN=11111111-0000-4000-8000-000000000003   # Ana's, driver_en_route
SEARCH=11111111-0000-4000-8000-000000000004    # nobody's, searching
PT_A="ST_SetSRID(ST_MakePoint(-82.3666,23.1357),4326)::geography"   # pickup (Capitolio)
PT_B="ST_SetSRID(ST_MakePoint(-82.3816,23.1418),4326)::geography"   # dropoff (Hotel Nacional)

# as UID SQL -> SQL as authenticated with JWT subject UID; rolled back. "RESET ROLE;"
# inside SQL switches back to the superuser to look at rows RLS would hide.
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
asanon(){ printf "BEGIN; SET LOCAL ROLE anon; %s ROLLBACK;" "$1"; }
asowner(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
PT(){ echo "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$1', '$2', $3, $4);"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER', 'customer', 'Rider'), ('$DIEGO', 'driver', 'Diego'), ('$ANA', 'driver', 'Ana');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO'), ('$DP_ANA', '$ANA');
  INSERT INTO public.rides (id, customer_id, driver_id, status, pickup_location, dropoff_location, accepted_at, pickup_at) VALUES
    ('$OWN', '$RIDER', '$DP_DIEGO', 'driver_en_route', $PT_A, $PT_B, now() - interval '25 minutes', NULL),
    ('$OWN_IP', '$RIDER', '$DP_DIEGO', 'in_progress', $PT_A, $PT_B, now() - interval '30 minutes', now() - interval '10 minutes'),
    ('$FOREIGN', '$RIDER', '$DP_ANA', 'driver_en_route', $PT_A, $PT_B, now() - interval '25 minutes', NULL),
    ('$SEARCH', '$RIDER', NULL, 'searching', $PT_A, $PT_B, NULL, NULL);" >/dev/null 2>&1 || return 1; }

fresh $DB || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

COUNT(){ echo "RESET ROLE; SELECT count(*) FROM public.ride_location_events WHERE ride_id = '$1';"; }
PUSHES="RESET ROLE; SELECT count(*) FROM net.calls;"
ARRIVED_MIN="RESET ROLE; SELECT round(extract(epoch FROM now() - driver_arrived_at) / 60) FROM public.rides WHERE id = '$OWN';"

echo "== a driver writes only to the rides they drive =="
val "F1 a point on another driver's ride is dropped" \
  "$(as $DIEGO "$(PT $FOREIGN $DP_DIEGO "$PT_A" "now()") $(COUNT $FOREIGN)")" "0"
val "F2 ...and sends no 'Conductor cerca' push to that ride's rider" \
  "$(as $DIEGO "$(PT $FOREIGN $DP_DIEGO "$PT_A" "now()") $PUSHES")" "0"
val "F3 the same through update_driver_position" \
  "$(as $DIEGO "SELECT public.update_driver_position('$DP_DIEGO', 23.1357, -82.3666, NULL, NULL, '$FOREIGN'); $(COUNT $FOREIGN)")" "0"
val "F4 a point on a ride with no driver is dropped" \
  "$(as $DIEGO "$(PT $SEARCH $DP_DIEGO "$PT_A" "now()") $(COUNT $SEARCH)")" "0"
val "F5 a batch keeps the driver's own points and drops the foreign one, without an error" \
  "$(as $DIEGO "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES
      ('$OWN', '$DP_DIEGO', $PT_B, now() - interval '3 minutes'), ('$FOREIGN', '$DP_DIEGO', $PT_A, now() - interval '3 minutes');
     RESET ROLE; SELECT (SELECT count(*) FROM public.ride_location_events WHERE ride_id = '$OWN') || '|' ||
                        (SELECT count(*) FROM public.ride_location_events WHERE ride_id = '$FOREIGN');")" "1|0"
err "F6 another driver's points do not open the arrival gate (no trail -> gps_required)" \
  "BEGIN; SET LOCAL request.jwt.claim.sub = '$ANA'; SET LOCAL ROLE authenticated; $(PT $OWN $DP_ANA "$PT_A" "now() - interval '24 minutes'")
   RESET ROLE; SET LOCAL request.jwt.claim.sub = '$DIEGO'; SET LOCAL ROLE authenticated;
   SELECT public.update_ride_status_v2('$OWN', 'arrived_at_pickup', NULL, NULL); ROLLBACK;" \
  "gps_required"

echo "== the driver's own points keep working =="
val "O1 own point stored, phone time kept, server time recorded" \
  "$(as $DIEGO "$(PT $OWN $DP_DIEGO "$PT_A" "now() - interval '24 minutes'") RESET ROLE;
     SELECT round(extract(epoch FROM now() - recorded_at) / 60) || '|' || (received_at = now()) FROM public.ride_location_events WHERE ride_id = '$OWN';")" "24|true"
val "O2 a forged received_at is replaced by the server's time" \
  "$(as $DIEGO "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at, received_at)
     VALUES ('$OWN', '$DP_DIEGO', $PT_A, now(), now() - interval '1 day'); RESET ROLE;
     SELECT received_at = now() FROM public.ride_location_events WHERE ride_id = '$OWN';")" "t"
val "O3 update_driver_position on the own ride writes the point and fires the push (rider + driver)" \
  "$(as $DIEGO "SELECT public.update_driver_position('$DP_DIEGO', 23.1357, -82.3666, NULL, NULL, '$OWN'); RESET ROLE;
     SELECT (SELECT count(*) FROM public.ride_location_events WHERE ride_id = '$OWN') || '|' || (SELECT count(*) FROM net.calls);")" "1|2"
val "O4 the app's upsert (ON CONFLICT DO NOTHING) still works and dedupes" \
  "$(as $DIEGO "INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$OWN', '$DP_DIEGO', $PT_B, '2026-10-12 10:00:00+00')
       ON CONFLICT (ride_id, recorded_at) DO NOTHING;
     INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at) VALUES ('$OWN', '$DP_DIEGO', $PT_B, '2026-10-12 10:00:00+00')
       ON CONFLICT (ride_id, recorded_at) DO NOTHING; $(COUNT $OWN)")" "1"

echo "== the wait clock =="
val "A1 a backdated point at the pickup no longer backdates the arrival" \
  "$(as $DIEGO "$(PT $OWN $DP_DIEGO "$PT_A" "now() - interval '24 minutes'") SELECT public.update_ride_status_v2('$OWN', 'arrived_at_pickup', NULL, NULL) ->> 'offline_trail_used'; $ARRIVED_MIN")" "true;0"
val "A2 a point written before 00659 (no received_at) still counts from its own time" \
  "$(asowner "SET session_replication_role = replica;
     INSERT INTO public.ride_location_events (ride_id, driver_id, location, recorded_at, received_at)
       VALUES ('$OWN', '$DP_DIEGO', $PT_A, now() - interval '10 minutes', NULL);
     SET session_replication_role = origin;
     SET LOCAL request.jwt.claim.sub = '$DIEGO'; SET LOCAL ROLE authenticated;
     SELECT public.update_ride_status_v2('$OWN', 'arrived_at_pickup', NULL, NULL) ->> 'offline_trail_used'; $ARRIVED_MIN")" "true;10"
val "A3 live coordinates at the pickup arrive now, as before" \
  "$(as $DIEGO "SELECT public.update_ride_status_v2('$OWN', 'arrived_at_pickup', 23.1357, -82.3666) ->> 'gated'; $ARRIVED_MIN")" "false;0"
val "A4 the destination gate still accepts the driver's own trail" \
  "$(as $DIEGO "$(PT $OWN_IP $DP_DIEGO "$PT_B" "now() - interval '1 minute'") SELECT public.update_ride_status_v2('$OWN_IP', 'arrived_at_destination', NULL, NULL) ->> 'new_status';")" "arrived_at_destination"
err "A5 with no trail and no coordinates the arrival is still refused" \
  "$(as $DIEGO "SELECT public.update_ride_status_v2('$OWN', 'arrived_at_pickup', NULL, NULL);")" "gps_required"

echo "== privileges =="
val "P1 anon: no INSERT/UPDATE/DELETE/TRUNCATE; authenticated: no UPDATE/DELETE/TRUNCATE, keeps INSERT/SELECT" \
  "SELECT has_table_privilege('anon', 'public.ride_location_events', 'INSERT') || '|' ||
          has_table_privilege('anon', 'public.ride_location_events', 'UPDATE') || '|' ||
          has_table_privilege('anon', 'public.ride_location_events', 'TRUNCATE') || '|' ||
          has_table_privilege('authenticated', 'public.ride_location_events', 'UPDATE') || '|' ||
          has_table_privilege('authenticated', 'public.ride_location_events', 'DELETE') || '|' ||
          has_table_privilege('authenticated', 'public.ride_location_events', 'TRUNCATE') || '|' ||
          has_table_privilege('authenticated', 'public.ride_location_events', 'INSERT') || '|' ||
          has_table_privilege('authenticated', 'public.ride_location_events', 'SELECT');" \
  "false|false|false|false|false|false|true|true"
err "P2 anon cannot insert at all" \
  "$(asanon "$(PT $OWN $DP_DIEGO "$PT_A" "now()")")" "permission denied for table ride_location_events"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  TMP=$(mktemp -d)
  # The verify block alone, to run against a database broken after the migration.
  python3 -I - "$MIG" "$TMP/verify.sql" <<'PY'
import sys, re
s = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'DO \$verify\$.*?\$verify\$;', s, re.S)
open(sys.argv[2], 'w', encoding='utf-8').write(m.group(0) + '\n')
PY

  # N1: a body other than the one 00659 patches is refused, and nothing is applied.
  fresh pr659n >/dev/null
  run pr659n "$(printf "SET ROLE tricigo_owner; DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.update_ride_status_v2(uuid,text,double precision,double precision,boolean,boolean)'::regprocedure), 'Path D:', 'Path D (changed):'); END \$x\$;")" >/dev/null
  r=$($BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "is not the body this migration patches"; then ok "N1 an unknown update_ride_status_v2 body stops the migration"; else ko "N1" "got [$r]"; fi
  val "N1b ...and the transaction left no received_at column" \
    "SELECT count(*) FROM information_schema.columns WHERE table_name = 'ride_location_events' AND column_name = 'received_at';" "0" pr659n

  # N2: the checks catch a write privilege granted back.
  fresh pr659n >/dev/null
  $BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
  run pr659n "GRANT UPDATE ON public.ride_location_events TO authenticated;" >/dev/null
  r=$($BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$TMP/verify.sql" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "still holds a write privilege"; then ok "N2 the checks catch UPDATE granted back to authenticated"; else ko "N2" "got [$r]"; fi

  # N3: the checks catch a changed guard body.
  fresh pr659n >/dev/null
  $BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
  run pr659n "SET ROLE tricigo_owner; DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_ride_location_events_guard()'::regprocedure), 'RETURN NULL;', 'RETURN NEW;'); END \$x\$;" >/dev/null
  r=$($BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$TMP/verify.sql" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "tg_ride_location_events_guard has an unexpected body"; then ok "N3 the checks catch a guard that no longer drops foreign points"; else ko "N3" "got [$r]"; fi

  # N4: the checks catch a disabled guard.
  fresh pr659n >/dev/null
  $BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
  run pr659n "ALTER TABLE public.ride_location_events DISABLE TRIGGER trg_ride_location_events_guard;" >/dev/null
  r=$($BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$TMP/verify.sql" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "missing or disabled"; then ok "N4 the checks catch a disabled guard trigger"; else ko "N4" "got [$r]"; fi

  # N5: a CRLF copy (SQL Editor pasted from Windows) applies, passes its own checks and behaves.
  sed 's/$/\r/' "$MIG" > "$TMP/n5.sql"
  fresh pr659n >/dev/null
  if $BIN/psql $CONN -d pr659n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n5.sql" >/dev/null 2>&1; then
    val "N5 a CRLF copy applies and still drops a point on another driver's ride" \
      "$(as $DIEGO "$(PT $FOREIGN $DP_DIEGO "$PT_A" "now()") $(COUNT $FOREIGN)")" "0" pr659n
  else ko "N5" "CRLF copy did not apply"; fi

  rm -rf "$TMP"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr659n" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
