#!/usr/bin/env bash
# Rehearsal runner for migration 00632 (support alerts name the vehicle).
# Builds prod as of 2026-10-07 from the 00628 rehearsal: its scaffold plus 00628 itself, whose
# function bodies are byte for byte prod's (md5 read from prod on 2026-10-07).
#   supabase/tests/00632/run.sh none
#       -> prod + tests (RED: no alert names the vehicle)
#   supabase/tests/00632/run.sh supabase/migrations/00632_support_alerts_vehicle_type.sql
#       -> the same + the migration applied twice (idempotency) + tests (GREEN)
# Cluster: the one of supabase/tests/00628 (user pgtest, port 5433, PostGIS).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr632
GUARD=pr632guard
BASE="$ROOT/supabase/migrations/00628_support_assisted_matching.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=c0000000-0000-4000-8000-000000000001
R1=f1000000-0000-4000-8000-000000000001
R2=f2000000-0000-4000-8000-000000000002

# ride ID [SERVICE] [AGE] [MODE]: Rita's searching ride, Vedado -> Capitolio, created AGE ago
ride(){ echo "INSERT INTO public.rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_fare_trc, estimated_distance_m, estimated_duration_s, exchange_rate_usd_cup,
  ride_mode, created_at)
  VALUES ('$1', '$RIDER', '${2:-triciclo_basico}', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3830, 23.1330), 4326)::geography, 'Calle 23 e/ L y M, Vedado',
  ST_SetSRID(ST_MakePoint(-82.3590, 23.1350), 4326)::geography, 'Capitolio, Centro Habana',
  5000, 5000, 2800, 600, 500, '${4:-passenger}', now() - interval '${3:-2 minutes}');"; }
# the title of every push LABEL queued, joined with ' | '
titles(){ echo "(SELECT string_agg(c.body->>'title', ' | ' ORDER BY c.body->>'title')
  FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = '$1')"; }
# the HTML of the first support e-mail queued
MAIL="(SELECT c.body->>'template' FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id
  WHERE h.jobname = 'support-alert-email' ORDER BY c.id LIMIT 1)"
CELL='<td style="padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top">'
MD5="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname)
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_support_alert', 'notify_support_waiting_rides')"

load(){ local db=$1
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/00628/scaffold.sql" >"$TMP/scaffold.out" 2>&1 \
    || { echo "scaffold failed:"; cat "$TMP/scaffold.out"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$BASE" >"$TMP/base.out" 2>&1 \
    || { echo "00628 failed:"; cat "$TMP/base.out"; exit 1; }
}
migrate(){ local db=$1 i
  [ "$MIG" = none ] && return 0
  for i in 1 2; do
    $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >"$TMP/mig.out" 2>&1 \
      || { echo "migration failed on apply $i:"; cat "$TMP/mig.out"; exit 1; }
  done
}

load $DB
# L1: the two bodies the migration patches are prod's (md5 of prosrc read from prod on 2026-10-07)
val L1 "$MD5" "_support_alert=63c4d28507585e3d92f74dfc84ddbe74,notify_support_waiting_rides=94fbc129807e30c0bdc10cd55ae99b4f"
migrate $DB

# --- T: the vehicle in every alert --------------------------------------------------------
# T1: the one-minute cron's push names the vehicle
val T1 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides(); SELECT $(titles support-wait-alert); ROLLBACK;" \
  "1;Viaje sin conductor · Triciclo · F1000000"
# T2: so does the rider's "Pedir ayuda" push
val T2 "BEGIN; $(ride $R1 triciclo_basico '30 seconds')
  SET LOCAL request.jwt.claim.sub = '$RIDER'; SET LOCAL ROLE authenticated;
  SELECT public.request_ride_help('$R1')->>'success'; RESET ROLE; SET LOCAL request.jwt.claim.sub = '';
  SELECT $(titles support-help-alert); ROLLBACK;" \
  "true;Pasajero pide ayuda · Triciclo · F1000000"
# T3: a shipment says so, with its vehicle
val T3 "BEGIN; $(ride $R1 moto_standard '2 minutes' cargo) $(ride $R2 auto_confort)
  SELECT public.notify_support_waiting_rides(); SELECT $(titles support-wait-alert); ROLLBACK;" \
  "2;Viaje sin conductor · Confort · F2000000 | Viaje sin conductor · Envío · Moto · F1000000"
# T4: the e-mail has a Vehículo column after the code, one cell per ride
val T4 "BEGIN; $(ride $R1) $(ride $R2 moto_standard '3 minutes' cargo) SELECT public.notify_support_waiting_rides();
  SELECT $MAIL LIKE '%<th style=\"padding:6px\">Código</th><th style=\"padding:6px\">Vehículo</th>%',
         $MAIL LIKE '%<b>F1000000</b></td>${CELL}Triciclo</td>${CELL}Sin conductor</td>%',
         $MAIL LIKE '%<b>F2000000</b></td>${CELL}Envío · Moto</td>%'; ROLLBACK;" \
  "2;t|t|t"
# T5: a name renamed in the admin applies at once, escaped in the e-mail
val T5 "BEGIN; $(ride $R1) UPDATE public.service_type_configs SET name_es = 'Tri <b>&' WHERE slug = 'triciclo_basico';
  SELECT public.notify_support_waiting_rides();
  SELECT $(titles support-wait-alert), $MAIL LIKE '%${CELL}Tri &lt;b&gt;&amp;</td>%'; ROLLBACK;" \
  "1;Viaje sin conductor · Tri <b>& · F1000000|t"
# T6: a type without a name shows its slug; no type at all shows a dash, never an empty title
val T6 "SELECT public._ride_type_label('triciclo_x', 'passenger'), public._ride_type_label(NULL, NULL),
  public._ride_type_label('  ', 'cargo'), public._ride_type_label('mensajeria', 'cargo')" \
  "triciclo_x|—|Envío · —|Envío · Mensajería"
# T7: everything 00628 did around the push is unchanged: one push per waiting ride, to the
# admins, category system, with the assist link, and one e-mail per address
val T7 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides();
  SELECT (SELECT c.body->>'body' || '|' || (c.body->>'category') || '|' || jsonb_array_length(c.body->'user_ids')
             || '|' || (c.body->'data'->>'url')
            FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = 'support-wait-alert'),
         (SELECT count(*) FROM public.cron_http_calls WHERE jobname = 'support-alert-email'); ROLLBACK;" \
  "1;Espera 2 min · Calle 23 e/ L y M, Vedado → Capitolio, Centro Habana|system|2|https://admin.tricigo.com/rides/$R1/assist|2"

# --- G: who may call the label -----------------------------------------------------------
err G1 "BEGIN; SET LOCAL ROLE authenticated; SELECT public._ride_type_label('moto_standard', 'passenger'); ROLLBACK;" \
  "permission denied for function _ride_type_label"
err G2 "BEGIN; SET LOCAL ROLE anon; SELECT public._ride_type_label('moto_standard', 'passenger'); ROLLBACK;" \
  "permission denied for function _ride_type_label"

# --- N: the guards refuse a body they do not know (separate database) ----------------------
if [ "$MIG" != none ]; then
  load $GUARD
  # a live body that drifted from 00628: the migration must stop, not patch it blindly
  run $GUARD "$AS_OWNER DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public._support_alert(uuid, text)'::regprocedure),
    'v_wait_min integer;', 'v_wait_min integer; -- drift'); END \$d\$;" >/dev/null
  # one transaction, as apply_migration runs it
  r=$($BIN/psql $CONN -d $GUARD -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "_support_alert has a body this file does not know"; then ok N1; else ko N1 "got [$r]"; fi
  # nothing of the file stayed behind
  val N2 "SELECT count(*) FROM pg_proc WHERE proname = '_ride_type_label'" "0" $GUARD
  $BIN/dropdb $CONN --if-exists $GUARD >/dev/null 2>&1
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
