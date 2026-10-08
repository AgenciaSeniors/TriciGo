#!/usr/bin/env bash
# Rehearsal runner for migration 00645 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00645/run.sh none
#       -> scaffold (the LIVE bodies of find_nearby_vehicles, get_demand_hotspots,
#          get_destination_suggestions; prod's reviews policies and view grants) + tests
#          (RED: anon gets exact driver positions from anywhere, one rider's home becomes a
#          popular suggestion, hotspots sit on exact pickups, anyone reads passenger reviews)
#   supabase/tests/00645/run.sh supabase/migrations/00645_read_privacy_positions_hotspots_reviews.sql
#       -> the same + migration on an empty DB, x2 (idempotency), a CRLF copy, tests and
#          negative proofs of its guards (GREEN)
# Client tests run as PostgREST would (role authenticated or anon, JWT subject set),
# each rolled back. Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad
# sin tocar prod" (user pgtest, port 5433; PostGIS: postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00645/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr645
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# denied NAME SQL -> the read is refused with a privilege error
denied(){ local r; r=$(run "${3:-$DB}" "$2")
  if echo "$r" | grep -Eq "permission denied|42501"; then ok "$1"; else ko "$1" "not refused: [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-0000000000aa
R1=a0000000-0000-4000-8000-000000000001   # the passenger reviewed by a driver
R2=a0000000-0000-4000-8000-000000000002   # goes home three times; left a hidden review
R3=a0000000-0000-4000-8000-000000000003
R4=a0000000-0000-4000-8000-000000000004   # a stranger to every ride below
R5=a0000000-0000-4000-8000-000000000005
D1U=a0000000-0000-4000-8000-0000000000d1; DP1=b0000000-0000-4000-8000-000000000001   # Capitolio, triciclo
D2U=a0000000-0000-4000-8000-0000000000d2; DP2=b0000000-0000-4000-8000-000000000002   # ~1.9 km away, moto
D3U=a0000000-0000-4000-8000-0000000000d3; DP3=b0000000-0000-4000-8000-000000000003   # offline, next door
D4U=a0000000-0000-4000-8000-0000000000d4; DP4=b0000000-0000-4000-8000-000000000004   # Santiago de Cuba
D5U=a0000000-0000-4000-8000-0000000000d5; DP5=b0000000-0000-4000-8000-000000000005   # busy with a ride
RDONE=c0000000-0000-4000-8000-000000000001    # R1 with DP1, completed
RDONE2=c0000000-0000-4000-8000-000000000002   # R2 with DP1, completed
RDONE3=c0000000-0000-4000-8000-000000000003   # R4 with DP2, completed, not reviewed yet
REV_D=e0000000-0000-4000-8000-000000000001    # R1 about driver D1U, visible
REV_P=e0000000-0000-4000-8000-000000000002    # D1U about passenger R1, visible
REV_H=e0000000-0000-4000-8000-000000000003    # R2 about driver D1U, hidden by an admin
TAG=f0000000-0000-4000-8000-000000000001
CAP="23.1357, -82.3666"                       # p_lat, p_lng at the Capitolio
pt(){ printf "ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography" "$2" "$1"; }   # pt LAT LNG
SEED="
INSERT INTO public.users (id, role) VALUES ('$ADMIN','admin'), ('$R1','customer'), ('$R2','customer'),
  ('$R3','customer'), ('$R4','customer'), ('$R5','customer'), ('$D1U','driver'), ('$D2U','driver'),
  ('$D3U','driver'), ('$D4U','driver'), ('$D5U','driver');
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, current_heading) VALUES
  ('$DP1','$D1U','approved',true,  $(pt 23.1357123 -82.3666456), 90),
  ('$DP2','$D2U','approved',true,  $(pt 23.1250789 -82.3800321), 180),
  ('$DP3','$D3U','approved',false, $(pt 23.1360 -82.3670), 0),
  ('$DP4','$D4U','approved',true,  $(pt 20.0247 -75.8219), 0),
  ('$DP5','$D5U','approved',true,  $(pt 23.1365 -82.3675), 0);
INSERT INTO public.vehicles (driver_id, type) VALUES ('$DP1','triciclo'), ('$DP2','moto'), ('$DP3','auto'),
  ('$DP4','auto'), ('$DP5','auto');
-- 55 drivers within a kilometre of Cienfuegos' Parque Martí.
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location)
  SELECT gen_random_uuid(), gen_random_uuid(), 'approved', true,
         $(pt '22.1456 + (g % 8) * 0.0010' '-80.4364 + (g / 8) * 0.0010')
  FROM generate_series(0, 54) g;
INSERT INTO public.vehicles (driver_id, type)
  SELECT id, 'moto' FROM public.driver_profiles WHERE ST_Y(current_location::geometry) < 22.2;
INSERT INTO public.rides (id, customer_id, driver_id, status, created_at) VALUES
  ('$RDONE','$R1','$DP1','completed', now() - interval '30 days'), ('$RDONE2','$R2','$DP1','completed', now() - interval '30 days'),
  ('$RDONE3','$R4','$DP2','completed', now() - interval '30 days');
INSERT INTO public.rides (customer_id, driver_id, status) VALUES ('$R3','$DP5','in_progress');
-- R2's home: three completed rides of ONE rider, 40 days ago (outside the 28-day demand view).
INSERT INTO public.rides (customer_id, status, created_at, dropoff_location, dropoff_lat, dropoff_lng, dropoff_address)
  SELECT '$R2', 'completed', now() - interval '40 days' - g * interval '1 hour',
         $(pt 23.1400 -82.4000), 23.1400, -82.4000, 'Calle 10 #123 e/ 5ta y 7ma, Vedado'
  FROM generate_series(1, 3) g;
-- A popular place: three completed rides of three different riders.
INSERT INTO public.rides (customer_id, status, created_at, dropoff_location, dropoff_lat, dropoff_lng, dropoff_address)
  SELECT c, 'completed', now() - interval '40 days', $(pt 23.1300 -82.3900), 23.1300, -82.3900,
         'Calle 23 #456 e/ L y M, Vedado'
  FROM unnest(ARRAY['$R3','$R4','$R5']::uuid[]) c;
-- R4 is picked up three times at the same doorway, same weekday and hour (demand history).
INSERT INTO public.rides (customer_id, status, created_at, pickup_location)
  SELECT '$R4', 'completed', now() - g * interval '7 days', $(pt 23.13571 -82.36666)
  FROM generate_series(1, 3) g;
REFRESH MATERIALIZED VIEW public.hourly_demand_cells;
-- Two riders searching right now, 80 m apart (a live hotspot).
INSERT INTO public.rides (customer_id, status, pickup_location) VALUES
  ('$R1','searching', $(pt 23.1412 -82.3587)), ('$R5','searching', $(pt 23.1418 -82.3581));
INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating, comment, is_visible) VALUES
  ('$REV_D','$RDONE','$R1','$D1U',5,'Excelente',true),
  ('$REV_P','$RDONE','$D1U','$R1',2,'Llegó tarde y molesto',true),
  ('$REV_H','$RDONE2','$R2','$D1U',1,'Oculta por un admin',false);
INSERT INTO public.review_tags (review_id, tag_id) VALUES ('$REV_D','$TAG'), ('$REV_P','$TAG');"

# as SUB|anon SQL -> SQL as that signed-in account (or anon), rolled back
as(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; %s %s ROLLBACK;" "$who" "$2"; }
fnv(){ printf "public.find_nearby_vehicles(%s)" "$1"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "SET ROLE tricigo_owner; $SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('find_nearby_vehicles', 'get_demand_hotspots', 'get_destination_suggestions', 'review_is_public')"

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('can_review_ride', 'find_nearby_vehicles',
   'get_demand_hotspots', 'get_destination_suggestions', 'get_review_summary')" \
  "can_review_ride:78ca07dd4fb53061504975cb14d8a793/370,find_nearby_vehicles:d8f7ccb01d9dd78a6022c905563c3092/975,get_demand_hotspots:a287c466520a5a9de1f2d94a1e2470fd/2252,get_destination_suggestions:f30abb2bacd8ed35865e9e2435bbbea2/4520,get_review_summary:5b84fcf048fe00a523af462d8fff2f19/521"
val "S1 seed: 59 online drivers, 1 cell in the demand view" \
  "SELECT (SELECT count(*) FROM public.driver_profiles WHERE is_online) || '/' || (SELECT count(*) FROM public.hourly_demand_cells)" \
  "59/1"

if [ "$MIG" != none ]; then
  # A fresh environment (local stack, branch) has no rows: the migration must apply there too.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
  $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 applies on an empty database" || ko "M0 applies on an empty database" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  ok "M1 migration applies twice (idempotent)"
  # Pasted from Windows into the SQL Editor: the same text with CRLF line endings.
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh ${DB}w || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}w "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ]; then
    val "M2 a CRLF copy applies and leaves the bodies of git" "$BODIES" "$(run $DB "$BODIES")" ${DB}w
  else ko "M2 a CRLF copy applies" "$r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}w" >/dev/null 2>&1
fi

# --- Driver positions (find_nearby_vehicles) ------------------------------------------
denied "N1 anon cannot call find_nearby_vehicles" \
  "$(as anon "SELECT count(*) FROM $(fnv "0, 0, NULL, 20000000, 10000");")"
val "N2 a rider sees the two available drivers within 5 km (not offline, busy or far ones)" \
  "$(as $R1 "SELECT count(*) FROM $(fnv "$CAP, NULL, 5000, 30");")" "2"
# shown SQL -> call find_nearby_vehicles as R1 into a temp table, then judge it as the
# owner (a rider cannot read other drivers' rows, so the comparison must not go through RLS)
shown(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;
  CREATE TEMP TABLE n ON COMMIT DROP AS SELECT * FROM %s; RESET ROLE; %s ROLLBACK;" "$R1" "$(fnv "$CAP, NULL, 5000, 30")" "$1"; }
val "N3 no shown position is a driver's real position" \
  "$(shown "SELECT count(*) FROM n WHERE EXISTS (SELECT 1 FROM public.driver_profiles d
     WHERE abs(ST_Y(d.current_location::geometry) - n.latitude) < 1e-6 AND abs(ST_X(d.current_location::geometry) - n.longitude) < 1e-6);")" "0"
val "N4 each shown position lies in its driver's real 0.002-degree cell" \
  "$(shown "SELECT count(*) || '/' || bool_and(EXISTS (SELECT 1 FROM public.driver_profiles d
       WHERE floor(ST_Y(d.current_location::geometry) / 0.002) = floor(n.latitude / 0.002)
         AND floor(ST_X(d.current_location::geometry) / 0.002) = floor(n.longitude / 0.002))) FROM n;")" "2/true"
val "N5 the radius is capped at 5 km (no Santiago, no Cienfuegos from Havana)" \
  "$(as $R1 "SELECT count(*) FROM $(fnv "$CAP, NULL, 2000000, 10000");")" "2"
val "N6 at most 50 vehicles per call" \
  "$(as $R1 "SELECT count(*) FROM $(fnv "22.148, -80.434, NULL, 5000, 1000");")" "50"
val "N7 ids are opaque (no driver_profiles id comes back)" \
  "$(shown "SELECT count(*) FROM n WHERE n.driver_profile_id IN (SELECT id FROM public.driver_profiles);")" "0"
val "N8 ids and shown positions are stable between calls (markers keep their identity)" \
  "$(as $R1 "SELECT count(*) FROM ((SELECT driver_profile_id, latitude, longitude FROM $(fnv "$CAP, NULL, 5000, 30"))
     EXCEPT (SELECT driver_profile_id, latitude, longitude FROM $(fnv "23.1300, -82.3700, NULL, 5000, 30"))) x;")" "0"
val "N9 a driver does not get their own vehicle back" \
  "$(as $D1U "SELECT count(*) FROM $(fnv "$CAP, NULL, 5000, 50");")" "1"
val "N10 membership is decided on the shown position: 1 m around the real one finds nobody" \
  "$(as $R1 "SELECT count(*) FROM $(fnv "23.1357123, -82.3666456, NULL, 1, 30");")" "0"
val "N11 the vehicle type filter still works" \
  "$(as $R1 "SELECT string_agg(vehicle_type, ',') FROM $(fnv "$CAP, 'moto', 5000, 30");")" "moto"
val "N12 same columns as before (the apps read them by name)" \
  "$(as $R1 "SELECT count(*) FROM (SELECT driver_profile_id, latitude, longitude, heading, vehicle_type,
     custom_per_km_rate_cup FROM $(fnv "$CAP, NULL, 5000, 30")) x;")" "2"
if [ "$MIG" != none ]; then
  denied "N13 clients cannot read the salt" "$(as $R1 "SELECT salt FROM public.nearby_vehicle_salt;")"
  denied "N14 anon cannot read the salt" "$(as anon "SELECT salt FROM public.nearby_vehicle_salt;")"
fi

# --- Demand hotspots ---------------------------------------------------------------------
denied "H1 a signed-in user cannot read the demand view directly" \
  "$(as $R1 "SELECT count(*) FROM public.hourly_demand_cells;")"
denied "H2 anon cannot read the demand view directly" \
  "$(as anon "SELECT count(*) FROM public.hourly_demand_cells;")"
val "H3 drivers still get the historical and the live hotspot" \
  "$(as $D1U "SELECT count(*) FROM public.get_demand_hotspots($CAP, 5000);")" "2"
val "H4 every hotspot sits on the 0.005-degree grid, not on a pickup" \
  "$(as $D1U "SELECT bool_and(abs(lat / 0.005 - round(lat / 0.005)) < 1e-6 AND abs(lng / 0.005 - round(lng / 0.005)) < 1e-6)
     FROM public.get_demand_hotspots($CAP, 5000);")" "t"

# --- Popular destinations ------------------------------------------------------------------
val "D1 one rider's home is not a popular suggestion for someone else" \
  "$(as $R1 "SELECT count(*) FROM public.get_destination_suggestions('$R1', $CAP, NULL, 10)
     WHERE address LIKE 'Calle 10%';")" "0"
val "D2 a place three different riders went to still is" \
  "$(as $R1 "SELECT string_agg(source, ',') FROM public.get_destination_suggestions('$R1', $CAP, NULL, 10)
     WHERE address LIKE 'Calle 23%';")" "popular"
val "D3 the rider still gets their own home as a personal suggestion" \
  "$(as $R2 "SELECT string_agg(source, ',') FROM public.get_destination_suggestions('$R2', $CAP, NULL, 10)
     WHERE address LIKE 'Calle 10%';")" "personal"
val "D4 nobody gets another rider's personal suggestions" \
  "$(as $R1 "SELECT count(*) FROM public.get_destination_suggestions('$R2', $CAP, NULL, 10);")" "0"

# --- Reviews -------------------------------------------------------------------------------------
val "V1 anon reads no review (and the policy does not fail for anon)" \
  "$(as anon "SELECT count(*) FROM public.reviews;")" "0"
val "V2 a stranger reads only the visible review of the driver" \
  "$(as $R4 "SELECT string_agg(comment, ',') FROM public.reviews;")" "Excelente"
val "V3 the reviewed passenger reads the review about them" \
  "$(as $R1 "SELECT string_agg(comment, ',' ORDER BY comment) FROM public.reviews;")" "Excelente,Llegó tarde y molesto"
val "V4 the driver reads the reviews about them and the one they wrote" \
  "$(as $D1U "SELECT count(*) FROM public.reviews;")" "3"
val "V5 the author reads their own hidden review" \
  "$(as $R2 "SELECT count(*) FROM public.reviews WHERE id = '$REV_H';")" "1"
val "V6 an admin reads every review" \
  "$(as $ADMIN "SELECT count(*) FROM public.reviews;")" "3"
val "V7 review tags follow their review (anon / stranger / passenger)" \
  "$(as anon "SELECT count(*) FROM public.review_tags;");$(as $R4 "SELECT count(*) FROM public.review_tags;");$(as $R1 "SELECT count(*) FROM public.review_tags;")" "0;1;2"
val "V8 a driver's public summary keeps counting the driver's reviews" \
  "$(as $R4 "SELECT (public.get_review_summary('$D1U')->>'total_reviews');")" "1"
val "V9 a passenger's ratings are not summarised for others" \
  "$(as $R4 "SELECT (public.get_review_summary('$R1')->>'total_reviews');")" "0"
val "V10 a rider still reviews the driver of a completed ride and tags it" \
  "$(as $R4 "INSERT INTO public.reviews (id, ride_id, reviewer_id, reviewee_id, rating)
     VALUES ('e0000000-0000-4000-8000-0000000000ff', '$RDONE3', '$R4', '$D2U', 5);
     INSERT INTO public.review_tags (review_id, tag_id) VALUES ('e0000000-0000-4000-8000-0000000000ff', '$TAG');
     SELECT count(*) FROM public.reviews WHERE id = 'e0000000-0000-4000-8000-0000000000ff';")" "1"

# --- Negative proofs of the migration's guards ---------------------------------------------------
if [ "$MIG" != none ]; then
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "SET ROLE tricigo_owner; CREATE OR REPLACE FUNCTION public.find_nearby_vehicles(p_lat double precision, p_lng double precision,
     p_vehicle_type text DEFAULT NULL::text, p_radius_m integer DEFAULT 5000, p_limit integer DEFAULT 50)
     RETURNS TABLE(driver_profile_id uuid, latitude double precision, longitude double precision, heading double precision,
     vehicle_type text, custom_per_km_rate_cup integer) LANGUAGE sql AS 'SELECT NULL::uuid, 0::float8, 0::float8, 0::float8, NULL::text, NULL::int';" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "unexpected body of find_nearby_vehicles" && ok "G1 refuses to replace an unknown find_nearby_vehicles" || ko "G1 refuses an unknown find_nearby_vehicles" "$r"
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "SET ROLE tricigo_owner; DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_destination_suggestions(uuid,double precision,double precision,integer,integer)'::regprocedure),
     'LIMIT v_limit;', 'LIMIT v_limit; -- local edit'); END \$x\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "unexpected body of get_destination_suggestions" && ok "G2 refuses to patch an unknown get_destination_suggestions" || ko "G2 refuses an unknown get_destination_suggestions" "$r"
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "SET ROLE tricigo_owner; CREATE OR REPLACE FUNCTION public.get_demand_hotspots(p_lat double precision, p_lng double precision, p_radius_m integer DEFAULT 5000)
     RETURNS TABLE(id text, lat double precision, lng double precision, intensity double precision, live_rides_count integer,
     historical_rides_count integer) LANGUAGE sql AS 'SELECT NULL::text, 0::float8, 0::float8, 0::float8, 0, 0';" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "unexpected body of get_demand_hotspots" && ok "G3 refuses to replace an unknown get_demand_hotspots" || ko "G3 refuses an unknown get_demand_hotspots" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
