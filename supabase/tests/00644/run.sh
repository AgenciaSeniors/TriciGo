#!/usr/bin/env bash
# Rehearsal runner for migration 00644 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00644/run.sh none
#       -> scaffold (vehicles with prod's policies) + tests (RED: any signed-in user lists
#          every active vehicle with its plate)
#   supabase/tests/00644/run.sh supabase/migrations/00644_vehicle_plates_private.sql
#       -> the same + migration on an empty DB, x2 (idempotency), a CRLF copy, tests and
#          negative proofs of its guard and its check (GREEN)
# Client tests run as PostgREST would (role authenticated or anon, JWT subject set),
# each rolled back. Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad
# sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00644/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr644
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
denied(){ local r; r=$(run "${3:-$DB}" "$2")
  if echo "$r" | grep -Eq "permission denied|42501"; then ok "$1"; else ko "$1" "not refused: [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-0000000000aa
R1=a0000000-0000-4000-8000-000000000001     # rode with D1
R2=a0000000-0000-4000-8000-000000000002     # never rode with anyone
D1U=a0000000-0000-4000-8000-0000000000d1; DP1=b0000000-0000-4000-8000-000000000001
D2U=a0000000-0000-4000-8000-0000000000d2; DP2=b0000000-0000-4000-8000-000000000002
D3U=a0000000-0000-4000-8000-0000000000d3; DP3=b0000000-0000-4000-8000-000000000003
SEED="
INSERT INTO public.users (id, role) VALUES ('$ADMIN','admin'), ('$R1','customer'), ('$R2','customer'),
  ('$D1U','driver'), ('$D2U','driver'), ('$D3U','driver');
INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP1','$D1U'), ('$DP2','$D2U'), ('$DP3','$D3U');
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number, is_active, accepts_cargo,
  max_cargo_weight_kg, max_cargo_length_cm, max_cargo_width_cm, max_cargo_height_cm, accepted_cargo_categories) VALUES
  ('$DP1','moto','Suzuki','GN','2015','Rojo','P111111',true, true, 10, 50, NULL, 30, '{documentos}'),
  ('$DP1','auto','Lada','2107','1988','Blanco','P111OLD',false,false, NULL, NULL, NULL, NULL, '{}'),
  ('$DP2','moto','Honda','CG','2018','Negro','P222222',true, true, 20, 40, 35, NULL, '{comida,documentos}'),
  ('$DP3','triciclo','Local','T','2020','Azul','P333333',true, true, NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number)
  SELECT '$DP3', 'auto', 'Geely', 'CK', 2012, 'Gris', 'P3' || g FROM generate_series(1, 3) g;
INSERT INTO public.rides (customer_id, driver_id, status) VALUES ('$R1','$DP1','completed');"

as(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; %s %s ROLLBACK;" "$who" "$2"; }
# The query the rider app runs for the assigned driver's vehicle (ride.service).
ride_vehicle(){ printf "SELECT coalesce(string_agg(plate_number, ','), '-') FROM (SELECT make, model, color, plate_number, photo_url, year
  FROM public.vehicles WHERE driver_id = '%s' AND is_active = true LIMIT 1) v;" "$1"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "SET ROLE tricigo_owner; $SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
BODY="SELECT md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_cargo_vehicle_caps'"

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries prod's v_select (as deparsed in prod, PG 17)" \
  "SELECT md5(pg_get_expr(polqual, polrelid)) FROM pg_policy WHERE polrelid = 'public.vehicles'::regclass AND polname = 'v_select'" \
  "37c6d1cabde3fd9d2a518b6aaffa8d0f"

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
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh ${DB}w || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}w "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ]; then
    val "M2 a CRLF copy applies and leaves the body of git" "$BODY" "$(run $DB "$BODY")" ${DB}w
  else ko "M2 a CRLF copy applies" "$r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}w" >/dev/null 2>&1
fi

# --- Who reads a vehicle ------------------------------------------------------------
val "P1 a rider who never rode with anyone lists no vehicle" \
  "$(as $R2 "SELECT count(*) FROM public.vehicles;")" "0"
val "P2 a rider reads the vehicle of the driver they rode with (the active-ride query)" \
  "$(as $R1 "$(ride_vehicle $DP1)")" "P111111"
val "P3 ... and not the vehicle of a driver they never rode with" \
  "$(as $R1 "$(ride_vehicle $DP2)")" "-"
val "P4 a driver reads their own vehicles, inactive ones too" \
  "$(as $D1U "SELECT string_agg(plate_number, ',' ORDER BY plate_number) FROM public.vehicles;")" "P111111,P111OLD"
val "P5 a driver does not read another driver's vehicle" \
  "$(as $D1U "SELECT count(*) FROM public.vehicles WHERE driver_id = '$DP2';")" "0"
val "P6 an admin reads every vehicle" \
  "$(as $ADMIN "SELECT count(*) FROM public.vehicles;")" "7"
val "P7 anon reads no vehicle, without an error" \
  "$(as anon "SELECT count(*) FROM public.vehicles;")" "0"
val "P8 a driver still adds a vehicle and gets it back (insert ... returning)" \
  "$(as $D2U "INSERT INTO public.vehicles (driver_id, type, make, model, year, color, plate_number)
     VALUES ('$DP2', 'auto', 'Kia', 'Rio', 2019, 'Verde', 'P2NEW') RETURNING plate_number;")" "P2NEW"

# --- Delivery selector ---------------------------------------------------------------
val "C1 get_cargo_vehicle_caps aggregates every active cargo vehicle per type" \
  "$(as $R2 "SELECT string_agg(vehicle_type || ':' || coalesce(max_weight_kg::text, '-') || '/' || coalesce(max_length_cm::text, '-') || '/'
     || coalesce(max_width_cm::text, '-') || '/' || coalesce(max_height_cm::text, '-') || '/' || array_to_string(accepted_categories, '+')
     || '/' || available_count, ' ' ORDER BY vehicle_type) FROM public.get_cargo_vehicle_caps();" 2>&1)" \
  "moto:20/50/35/30/comida+documentos/2 triciclo:-/-/-/-//1"
denied "C2 anon cannot call get_cargo_vehicle_caps" \
  "$(as anon "SELECT count(*) FROM public.get_cargo_vehicle_caps();")"
val "C3 old builds' direct read of cargo vehicles now returns nothing (owner's decision)" \
  "$(as $R2 "SELECT count(*) FROM public.vehicles WHERE accepts_cargo = true AND is_active = true;")" "0"

# --- Negative proofs of the migration's guard and check -------------------------------
if [ "$MIG" != none ]; then
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "SET ROLE tricigo_owner; ALTER POLICY v_select ON public.vehicles USING (true);" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "v_select is not the policy this migration replaces" && ok "G1 refuses to replace an unknown v_select" || ko "G1 refuses an unknown v_select" "$r"
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "SET ROLE tricigo_owner; CREATE POLICY v_public ON public.vehicles FOR SELECT USING (true);" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "another SELECT policy on vehicles" && ok "G2 aborts when another SELECT policy would keep plates readable" || ko "G2 aborts on another SELECT policy" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
