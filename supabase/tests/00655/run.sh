#!/usr/bin/env bash
# Rehearsal runner for migration 00655 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00655/run.sh none
#       -> scaffold (prod's tables, policies, grants and live function bodies) + tests (RED)
#   supabase/tests/00655/run.sh supabase/migrations/00655_ride_side_writes_guards.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00655/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr655
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001     # customer of ACTIVE, PRE, DONE, CARGO, CARGO_LIVE
EMP=a0000000-0000-4000-8000-000000000002       # employee (and creator) of CORP
STRANGER=a0000000-0000-4000-8000-000000000003  # party of no ride
DIEGO=d0000000-0000-4000-8000-000000000004     # driver of ACTIVE, PRE, DONE, CARGO_LIVE
EVA=e0000000-0000-4000-8000-000000000005       # platform admin
DP_DIEGO=dd000000-0000-4000-8000-000000000004
CORP=cc000000-0000-4000-8000-000000000001
ACTIVE=11111111-0000-4000-8000-000000000001    # in_progress, 2 stops: one visited, one not
PRE=11111111-0000-4000-8000-000000000002       # accepted, 1 stop
DONE=11111111-0000-4000-8000-000000000003      # completed
CARGO=11111111-0000-4000-8000-000000000004     # cargo, searching, no details yet
CARGO_LIVE=11111111-0000-4000-8000-000000000005  # cargo, in_progress, details DD
WP_VISITED=22222222-0000-4000-8000-000000000001
WP_NEXT=22222222-0000-4000-8000-000000000002
WP_PRE=22222222-0000-4000-8000-000000000003
PT_A="ST_SetSRID(ST_MakePoint(-82.3666,23.1357),4326)::geography"   # Capitolio
PT_B="ST_SetSRID(ST_MakePoint(-82.3816,23.1418),4326)::geography"   # Hotel Nacional
PT_S="ST_SetSRID(ST_MakePoint(-82.3740,23.1250),4326)::geography"   # a stop 1.5 km off the route
PHOTO="https://lqaufszburqvlslpcuac.supabase.co/storage/v1/object/public/delivery-photos/$CARGO_LIVE/proof.jpg"

# as UID SQL -> SQL as authenticated with JWT subject UID; rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
asowner(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# RIDE customer fare trc [extra columns] [extra values]
RIDE(){ echo "INSERT INTO public.rides (customer_id, service_type, pickup_location, pickup_address, dropoff_location, dropoff_address, estimated_fare_cup, estimated_fare_trc${4:+, $4})
              VALUES ('$1', 'triciclo_basico', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', $2, $3${5:+, $5})"; }
SCHED(){ echo "INSERT INTO public.rides (customer_id, service_type, pickup_location, pickup_address, dropoff_location, dropoff_address, estimated_fare_cup, scheduled_at)
              SELECT '$1', 'triciclo_basico', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 1500, now() + (g || ' hours')::interval FROM generate_series(1, $2) g;"; }
RECUR(){ echo "INSERT INTO public.recurring_rides (customer_id, pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude, days_of_week, time_of_day, next_occurrence_at, last_triggered_at)
              SELECT '$1', 'A', 23.1357, -82.3666, 'B', 23.1418, -82.3816, ${3:-ARRAY[1,2,3,4,5,6,7]}, '08:00', now() + interval '1 minute', now() FROM generate_series(1, $2);"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         # Seeds skip the triggers: the rider holds several rides in flight on purpose.
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  SET session_replication_role = replica;
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER', 'customer', 'Rider'), ('$EMP', 'customer', 'Employee'), ('$STRANGER', 'customer', 'Stranger'),
    ('$DIEGO', 'driver', 'Diego'), ('$EVA', 'admin', 'Eva');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO');
  INSERT INTO public.service_type_configs (slug, base_fare_cup, per_km_rate_cup, per_minute_rate_cup, min_fare_cup)
    VALUES ('triciclo_basico', 500, 300, 20, 1000);
  INSERT INTO public.corporate_accounts (id, status, created_by, per_ride_cap_trc, monthly_budget_trc)
    VALUES ('$CORP', 'approved', '$EMP', 2000, 5000);
  INSERT INTO public.corporate_employees (corporate_account_id, user_id) VALUES ('$CORP', '$EMP');
  INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES ('$EMP', 'corporate_cash', 5000);
  INSERT INTO public.rides (id, customer_id, driver_id, status, service_type, ride_mode, pickup_location, pickup_address, dropoff_location, dropoff_address, estimated_fare_cup) VALUES
    ('$ACTIVE', '$RIDER', '$DP_DIEGO', 'in_progress', 'triciclo_basico', 'passenger', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 3914),
    ('$PRE', '$RIDER', '$DP_DIEGO', 'accepted', 'triciclo_basico', 'passenger', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 3000),
    ('$DONE', '$RIDER', '$DP_DIEGO', 'completed', 'triciclo_basico', 'passenger', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 3000),
    ('$CARGO', '$RIDER', NULL, 'searching', 'triciclo_basico', 'cargo', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 3000),
    ('$CARGO_LIVE', '$RIDER', '$DP_DIEGO', 'in_progress', 'triciclo_basico', 'cargo', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional', 3000);
  INSERT INTO public.ride_waypoints (id, ride_id, sort_order, location, address, arrived_at) VALUES
    ('$WP_VISITED', '$ACTIVE', 1, $PT_S, 'Parada visitada', now() - interval '5 minutes'),
    ('$WP_NEXT', '$ACTIVE', 2, $PT_S, 'Parada siguiente', NULL),
    ('$WP_PRE', '$PRE', 1, $PT_S, 'Parada', NULL);
  INSERT INTO public.delivery_details (ride_id, recipient_phone, recipient_name) VALUES ('$CARGO_LIVE', '+5355551234', 'Ana');" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== the fare a client declares =="
err "F1 an employee cannot pass a 3000 CUP company ride off as 1 TRC" \
  "$(as $EMP "$(RIDE $EMP 3000 1 'payment_method, corporate_account_id' "'corporate', '$CORP'");")" "corporate_over_ride_cap"
val "F2 the TRC estimate is the CUP estimate" \
  "$(as $STRANGER "$(RIDE $STRANGER 1500 7) RETURNING estimated_fare_trc;")" "1500"
err "F3 a client's ride without a price is refused" \
  "$(as $STRANGER "INSERT INTO public.rides (customer_id, service_type, pickup_location, pickup_address, dropoff_location, dropoff_address)
                   VALUES ('$STRANGER', 'triciclo_basico', $PT_A, 'Capitolio', $PT_B, 'Hotel Nacional');")" "fare_required"
val "F4 a server insert without a price still goes through" \
  "$(asowner "$(RIDE $STRANGER 0 0) RETURNING estimated_fare_cup;")" "0"
val "F5 a company ride within its limits goes through" \
  "$(as $EMP "$(RIDE $EMP 1500 1500 'payment_method, corporate_account_id' "'corporate', '$CORP'") RETURNING estimated_fare_trc;")" "1500"

echo "== pending scheduled rides =="
val "S1 five pending scheduled rides go through" "$(as $STRANGER "$(SCHED $STRANGER 5) SELECT count(*) FROM public.rides WHERE customer_id = '$STRANGER';")" "5"
err "S2 the sixth is refused" "$(as $STRANGER "$(SCHED $STRANGER 6)")" "scheduled_limit"

echo "== stops =="
err "W1 the rider cannot move a stop already visited" \
  "$(as $RIDER "UPDATE public.ride_waypoints SET location = ST_SetSRID(ST_MakePoint(-82.3741,23.13875),4326)::geography WHERE id = '$WP_VISITED';")" "waypoint_column"
err "W2 the rider cannot remove a stop already visited" \
  "$(as $RIDER "DELETE FROM public.ride_waypoints WHERE id = '$WP_VISITED';")" "waypoint_locked"
err "W3 the rider cannot remove a stop once the trip started" \
  "$(as $RIDER "DELETE FROM public.ride_waypoints WHERE id = '$WP_NEXT';")" "waypoint_locked"
val "W4 the rider removes a stop before pickup" \
  "$(as $RIDER "DELETE FROM public.ride_waypoints WHERE id = '$WP_PRE'; SELECT count(*) FROM public.ride_waypoints WHERE ride_id = '$PRE';")" "0"
val "W5 the rider adds a third stop mid-trip; arrival starts empty" \
  "$(as $RIDER "INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address, arrived_at) VALUES ('$ACTIVE', 3, $PT_S, 'Otra', now() - interval '1 hour');
     SELECT count(*) FILTER (WHERE address = 'Otra' AND arrived_at IS NULL) FROM public.ride_waypoints WHERE ride_id = '$ACTIVE';")" "1"
err "W6 a fourth stop is refused" \
  "$(as $RIDER "INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address) VALUES ('$ACTIVE', 3, $PT_S, 'Tres'), ('$ACTIVE', 4, $PT_S, 'Cuatro');")" "waypoint_limit"
err "W7 no stops on a completed ride" \
  "$(as $RIDER "INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address) VALUES ('$DONE', 1, $PT_S, 'Tarde');")" "waypoint_locked"
val "W8 the driver stamps arrival with the server's time" \
  "$(as $DIEGO "UPDATE public.ride_waypoints SET arrived_at = '2000-01-01' WHERE id = '$WP_NEXT';
     SELECT arrived_at > now() - interval '1 minute' FROM public.ride_waypoints WHERE id = '$WP_NEXT';")" "t"
err "W9 the driver cannot rewrite a stop's address" \
  "$(as $DIEGO "UPDATE public.ride_waypoints SET address = 'Otra cosa' WHERE id = '$WP_NEXT';")" "waypoint_column"
err "W10 the driver cannot re-stamp an arrival" \
  "$(as $DIEGO "UPDATE public.ride_waypoints SET arrived_at = now() WHERE id = '$WP_VISITED';")" "waypoint_column"
val "W11 the driver stamps departure after arrival" \
  "$(as $DIEGO "UPDATE public.ride_waypoints SET departed_at = now() WHERE id = '$WP_VISITED';
     SELECT departed_at IS NOT NULL FROM public.ride_waypoints WHERE id = '$WP_VISITED';")" "t"
err "W12 a stranger cannot add a stop to someone's ride" \
  "$(as $STRANGER "INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address) VALUES ('$ACTIVE', 3, $PT_S, 'X');")" "waypoint_not_your_ride\|row-level security"
val "W13 an admin may still fix a stop" \
  "$(as $EVA "UPDATE public.ride_waypoints SET address = 'Corregida' WHERE id = '$WP_VISITED'; SELECT address FROM public.ride_waypoints WHERE id = '$WP_VISITED';")" "Corregida"

echo "== reviews =="
val "R1 a review starts not featured, visible and dated now" \
  "$(as $RIDER "INSERT INTO public.reviews (ride_id, reviewer_id, reviewee_id, rating, comment, is_featured, is_visible, created_at)
                VALUES ('$DONE', '$RIDER', '$DIEGO', 5, '  Muy bien  ', true, false, '2000-01-01');
     SELECT is_featured || '|' || is_visible || '|' || (created_at > now() - interval '1 minute') || '|' || comment FROM public.reviews;")" "false|true|true|Muy bien"
err "R2 a comment over 1000 characters is refused" \
  "$(as $RIDER "INSERT INTO public.reviews (ride_id, reviewer_id, reviewee_id, rating, comment) VALUES ('$DONE', '$RIDER', '$DIEGO', 4, repeat('a', 1001));")" "review_comment_length"
val "R3 a blank comment is stored empty" \
  "$(as $DIEGO "INSERT INTO public.reviews (ride_id, reviewer_id, reviewee_id, rating, comment) VALUES ('$DONE', '$DIEGO', '$RIDER', 4, '   ');
     SELECT coalesce(comment, '-') FROM public.reviews WHERE reviewer_id = '$DIEGO';")" "-"

echo "== delivery details =="
val "D1 the OTP is the server's and the proof starts empty" \
  "$(as $RIDER "INSERT INTO public.delivery_details (ride_id, recipient_name, delivery_otp, delivery_otp_validated_at, delivery_photo_url, pickup_photo_url)
                VALUES ('$CARGO', 'Ana', 'zz', now(), 'x', 'y');
     SELECT (delivery_otp ~ '^[0-9]{4}\$') || '|' || coalesce(delivery_otp_validated_at::text, '-') || '|' || coalesce(delivery_photo_url, '-') || '|' || coalesce(pickup_photo_url, '-')
       FROM public.delivery_details WHERE ride_id = '$CARGO';")" "true|-|-|-"
err "D2 no delivery details on a passenger ride" \
  "$(as $RIDER "INSERT INTO public.delivery_details (ride_id, recipient_name) VALUES ('$PRE', 'Ana');")" "delivery_not_your_ride"
# Through the API the driver updates nothing today: they have no SELECT policy on
# delivery_details, so a filtered UPDATE matches no row, and PostgREST's
# safeupdate refuses an UPDATE without WHERE. D3-D5 run without WHERE (psql has
# no safeupdate) to exercise the guard for the day drivers get to read the row.
val "D3a a filtered update by the driver touches no row (prod today)" \
  "$(as $DIEGO "WITH u AS (UPDATE public.delivery_details SET recipient_phone = '+5355550000' WHERE ride_id = '$CARGO_LIVE' RETURNING 1) SELECT count(*) FROM u;")" "0"
err "D3 the driver cannot rewrite the recipient" \
  "$(as $DIEGO "UPDATE public.delivery_details SET recipient_phone = '+5355550000';")" "delivery_column"
val "D4 the driver sets a proof photo of the ride's folder" \
  "$(as $DIEGO "UPDATE public.delivery_details SET delivery_photo_url = '$PHOTO'; SELECT 'updated';")" "updated"
err "D5 a proof photo from elsewhere is refused" \
  "$(as $DIEGO "UPDATE public.delivery_details SET delivery_photo_url = 'https://evil.example/x.jpg';")" "delivery_column"

echo "== recurring rides =="
val "RR1 the server computes when the next ride is due and keeps the trigger time" \
  "$(as $RIDER "$(RECUR $RIDER 1) SELECT (next_occurrence_at = public.compute_next_occurrence(ARRAY[1,2,3,4,5,6,7]::smallint[], '08:00', 'America/Havana')) || '|' || coalesce(last_triggered_at::text, '-') FROM public.recurring_rides;")" "true|-"
err "RR2 the eleventh is refused" "$(as $RIDER "$(RECUR $RIDER 11)")" "recurring_limit"
err "RR3 days are ISO 1..7" "$(as $RIDER "$(RECUR $RIDER 1 'ARRAY[0]')")" "recurring_days"
val "RR4 the cron creates nothing while the feature flag is off" \
  "$(asowner "INSERT INTO public.recurring_rides (customer_id, pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude, days_of_week, time_of_day, next_occurrence_at)
       VALUES ('$STRANGER', 'A', 23.1357, -82.3666, 'B', 23.1418, -82.3816, ARRAY[1,2,3,4,5,6,7], '08:00', now() + interval '2 hours');
     SELECT public.create_rides_for_recurring();")" "0"
val "RR5 and creates the ride once the flag is on" \
  "$(asowner "INSERT INTO public.feature_flags (key, value) VALUES ('recurring_rides_enabled', true);
     INSERT INTO public.recurring_rides (customer_id, pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude, days_of_week, time_of_day, next_occurrence_at)
       VALUES ('$STRANGER', 'A', 23.1357, -82.3666, 'B', 23.1418, -82.3816, ARRAY[1,2,3,4,5,6,7], '08:00', now() + interval '2 hours');
     SELECT public.create_rides_for_recurring();")" "1"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  TMP=$(mktemp -d)
  # N1: without forcing the TRC estimate, F1 passes again.
  python3 - "$MIG" "$TMP/n1.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
line = "  NEW.estimated_fare_trc := NEW.estimated_fare_cup;\n"
assert s.count(line) == 1
s = s.replace(line, "")
# its body no longer matches the rehearsed md5: drop that check for this proof
a = s.index("  -- The three patched bodies"); b = s.index("END\n$verify$;")
open(sys.argv[2], 'w').write(s[:a] + s[b:])
PY
  fresh pr655n >/dev/null && $BIN/psql $CONN -d pr655n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n1.sql" >/dev/null 2>&1
  val "N1 F1 catches a TRC estimate left to the client" \
    "$(as $EMP "$(RIDE $EMP 3000 1 'payment_method, corporate_account_id' "'corporate', '$CORP'") RETURNING estimated_fare_trc;")" "1" pr655n
  # N2: the patch refuses a live body it does not know.
  fresh pr655n >/dev/null
  $BIN/psql $CONN -d pr655n -qAt -c "SET ROLE tricigo_owner; CREATE OR REPLACE FUNCTION public.create_rides_for_recurring() RETURNS integer LANGUAGE plpgsql AS \$\$ BEGIN RETURN 0; END \$\$;" >/dev/null 2>&1
  r=$($BIN/psql $CONN -d pr655n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "create_rides_for_recurring is not the body read from prod"; then ok "N2 the patch refuses an unknown live body"; else ko "N2" "got [$r]"; fi
  # N3: the verification block refuses a missing trigger.
  python3 - "$MIG" "$TMP/n3.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
block = "CREATE OR REPLACE TRIGGER trg_reviews_client_guard\n  BEFORE INSERT ON public.reviews\n  FOR EACH ROW EXECUTE FUNCTION public.tg_reviews_client_guard();\n"
assert s.count(block) == 1
open(sys.argv[2], 'w').write(s.replace(block, ''))
PY
  fresh pr655n >/dev/null
  r=$($BIN/psql $CONN -d pr655n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n3.sql" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "triggers missing or disabled: trg_reviews_client_guard"; then ok "N3 the verification block refuses a missing trigger"; else ko "N3" "got [$r]"; fi
  # N4: the verification block refuses a patched body that is not the rehearsed one.
  sed 's/the apps hide recurring rides unless this flag is on/the apps hide recurring rides unless that flag is on/' "$MIG" > "$TMP/n4.sql"
  if cmp -s "$MIG" "$TMP/n4.sql"; then ko "N4 mutation" "sed changed nothing"; else
    fresh pr655n >/dev/null
    r=$($BIN/psql $CONN -d pr655n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n4.sql" 2>&1 | tr -d '\r')
    if echo "$r" | grep -q "patched bodies differ from the rehearsal: create_rides_for_recurring"; then ok "N4 the verification block refuses an unrehearsed body"; else ko "N4" "got [$r]"; fi; fi
  # N5: a CRLF copy (SQL Editor pasted from Windows) applies, passes its own checks and behaves.
  sed 's/$/\r/' "$MIG" > "$TMP/n5.sql"
  fresh pr655n >/dev/null
  if $BIN/psql $CONN -d pr655n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n5.sql" >/dev/null 2>&1; then
    err "N5 a CRLF copy applies and still refuses the 1-TRC company ride" \
      "$(as $EMP "$(RIDE $EMP 3000 1 'payment_method, corporate_account_id' "'corporate', '$CORP'");")" "corporate_over_ride_cap" pr655n
  else ko "N5" "CRLF copy did not apply"; fi
  rm -rf "$TMP"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr655n" >/dev/null 2>&1
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
