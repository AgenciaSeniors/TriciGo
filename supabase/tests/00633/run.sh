#!/usr/bin/env bash
# Rehearsal runner for migration 00633 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00633/run.sh none
#       -> scaffold (prod's _waypoint_pricing, recalc and waypoint trigger) + tests (RED)
#   supabase/tests/00633/run.sh supabase/migrations/00633_preview_stops_surcharge.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Needs PostGIS for Postgres 16 (Ubuntu: apt-get install postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00633/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr633
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
SIG="public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric)"
NEW_MD5="a5ee2672e5ec5425dba514fc61dc16fc"
tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
as(){ printf "BEGIN; SET LOCAL ROLE %s; %s ROLLBACK;" "$1" "$2"; }

# Capitolio -> Hotel Nacional via the Plaza de la Revolucion (the prod probe).
CAP="23.1352, -82.3599"; NAC="23.1375, -82.3964"
STOP='[{"lat": 23.1225, "lng": -82.3866}]'

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "S1 the body is the 00633 one" "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$SIG'::regprocedure" "$NEW_MD5"
fi

echo "== 1. a booking with stops is charged what the app showed =="
# What the apps do now: quote = direct fare + preview; create the ride with the direct fare;
# the snapshot keeps it; insert the stops; the trigger adds the surcharge.
BOOK="CREATE TEMP TABLE q AS SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 1) AS surcharge;
      WITH r AS (
        INSERT INTO public.rides (service_type, pickup_location, dropoff_location, estimated_fare_cup)
        VALUES ('auto_standard', ST_SetSRID(ST_MakePoint(-82.3599, 23.1352), 4326)::geography,
                ST_SetSRID(ST_MakePoint(-82.3964, 23.1375), 4326)::geography, 7484) RETURNING id)
      INSERT INTO public.ride_pricing_snapshots (ride_id, snapshot_type, total) SELECT id, 'estimate', 7484 FROM r;
      INSERT INTO public.ride_waypoints (ride_id, sort_order, location)
      SELECT id, 1, ST_SetSRID(ST_MakePoint(-82.3866, 23.1225), 4326)::geography FROM public.rides;"
val "B1 the preview is the prod probe's surcharge (1,516 CUP)" \
  "SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 1)" "1516"
val "B2 the snapshot charged = direct fare + preview, exactly" \
  "$(tx "$BOOK SELECT (SELECT total FROM public.ride_pricing_snapshots) = 7484 + (SELECT surcharge FROM q);")" "t"

echo "== 2. the same number as _waypoint_pricing, on 500 random rides =="
EQ="DO \$eq\$
DECLARE
  i int; n int; v_id uuid; v_stops jsonb; v_surge numeric; v_svc text;
  p_lat float8; p_lng float8; d_lat float8; d_lng float8; s_lat float8; s_lng float8;
  v_srv int; v_prev int; v_bad int := 0;
BEGIN
  PERFORM setseed(0.631);
  FOR i IN 1..500 LOOP
    p_lat := 22.95 + random() * 0.30; p_lng := -82.55 + random() * 0.40;
    d_lat := 22.95 + random() * 0.30; d_lng := -82.55 + random() * 0.40;
    v_surge := round((1 + random() * 2)::numeric, 2);
    v_svc := (ARRAY['auto_standard','auto_confort','triciclo_basico','moto_standard','mensajeria'])[1 + floor(random() * 5)::int];
    INSERT INTO public.rides (service_type, pickup_location, dropoff_location, surge_multiplier)
    VALUES (v_svc, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
            ST_SetSRID(ST_MakePoint(d_lng, d_lat), 4326)::geography, v_surge)
    RETURNING id INTO v_id;
    v_stops := '[]'::jsonb;
    FOR n IN 1..(1 + floor(random() * 3)::int) LOOP
      s_lat := 22.95 + random() * 0.30; s_lng := -82.55 + random() * 0.40;
      INSERT INTO public.ride_waypoints (ride_id, sort_order, location)
      VALUES (v_id, n, ST_SetSRID(ST_MakePoint(s_lng, s_lat), 4326)::geography);
      v_stops := v_stops || jsonb_build_array(jsonb_build_object('lat', s_lat, 'lng', s_lng));
    END LOOP;
    SELECT surcharge_cup INTO v_srv FROM public._waypoint_pricing(v_id);
    v_prev := public.preview_stops_surcharge(v_svc, p_lat, p_lng, d_lat, d_lng, v_stops, v_surge);
    IF v_srv IS DISTINCT FROM v_prev THEN v_bad := v_bad + 1; END IF;
  END LOOP;
  RAISE NOTICE 'mismatches=%', v_bad;
END
\$eq\$;"
r=$($BIN/psql $CONN -d $DB -qAt -c "BEGIN; $EQ ROLLBACK;" 2>&1 | tr -d '\r' | grep -o 'mismatches=[0-9]*\|ERROR.*' | head -1)
[ "$r" = "mismatches=0" ] && ok "E1 preview == _waypoint_pricing on 500 random rides (1-3 stops, surge 1-3, 5 services)" || ko "E1" "got [$r]"

echo "== 3. edge cases =="
val "X1 no stops is 0" "SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '[]'::jsonb, 1)
  || '|' || coalesce(public.preview_stops_surcharge('auto_standard', $CAP, $NAC, NULL, 1)::text, 'null')" "0|0"
val "X2 a stop on the straight line costs nothing" \
  "SELECT public.preview_stops_surcharge('auto_standard', 23.0, -82.4, 23.2, -82.4, '[{\"lat\": 23.1, \"lng\": -82.4}]'::jsonb, 1)" "0"
val "X3 the surge is clamped to [1, 3] like an insert (0.5 -> 1, 10 -> 3)" \
  "SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 0.5)
          = public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 1)
      AND public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 10)
          = public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 3)
      AND public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 3) > 1516 * 2" "t"
val "X4 an inactive or unknown service is 0" \
  "SELECT public.preview_stops_surcharge('triciclo_premium', $CAP, $NAC, '$STOP'::jsonb, 1)
   || '|' || public.preview_stops_surcharge('nope', $CAP, $NAC, '$STOP'::jsonb, 1)" "0|0"
err "X5 more than 10 stops is refused" \
  "SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC,
     (SELECT jsonb_agg(jsonb_build_object('lat', 23.1, 'lng', -82.4)) FROM generate_series(1, 11)), 1)" "stops_limit"

echo "== 4. who can call it =="
val "G1 anon and authenticated can (the web quotes before sign-in)" \
  "$(as anon "SELECT public.preview_stops_surcharge('auto_standard', $CAP, $NAC, '$STOP'::jsonb, 1);")" "1516"
val "G2 it runs as the caller (SECURITY INVOKER)" "SELECT prosecdef FROM pg_proc WHERE oid = '$SIG'::regprocedure" "f"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  NEG=pr633n
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; CREATE FUNCTION public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric DEFAULT 1)
            RETURNS integer LANGUAGE sql AS 'SELECT 0'; ALTER FUNCTION public.preview_stops_surcharge(text, double precision, double precision, double precision, double precision, jsonb, numeric) SECURITY DEFINER;" >/dev/null
  r=$(apply_err $NEG "$MIG"); [ "$r" = applied ] && [ "$(run $NEG "SELECT prosecdef FROM pg_proc WHERE oid = '$SIG'::regprocedure")" = f ] \
    && ok "N1 a SECURITY DEFINER leftover is replaced by the INVOKER body" || ko "N1" "apply [$r], secdef [$(run $NEG "SELECT prosecdef FROM pg_proc WHERE oid = '$SIG'::regprocedure")]"
  fresh $NEG
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  [ "$r" = applied ] && [ "$(run $NEG "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$SIG'::regprocedure")" = "$NEW_MD5" ] \
    && ok "N2 pasted with CRLF line ends, the body still matches git" || ko "N2" "apply [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
