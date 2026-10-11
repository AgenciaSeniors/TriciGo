#!/usr/bin/env bash
# Rehearsal runner for migration 00650 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00650/run.sh none
#       -> scaffold (LIVE bodies of the driver-profile, document and dispatch functions;
#          prod's policies, triggers and grants on driver_profiles, vehicles,
#          driver_documents, selfie_checks, driver_contracts) + tests
#          (RED: an approved driver changes or adds a vehicle and earns rides of the new
#          type without review; Confort bookings reach plain Auto vehicles; a document
#          row points at another driver's file; a selfie check is inserted as passed)
#   supabase/tests/00650/run.sh supabase/migrations/00650_driver_vehicle_review.sql
#       -> the same + migration on the scaffold, x2 (idempotency), a CRLF copy, tests and
#          negative proofs of its guards (GREEN)
# Client tests run as PostgREST would (role authenticated, JWT subject set), each rolled
# back. Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar
# prod" (user pgtest, port 5433; PostGIS: postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00650/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr650
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# refused NAME SQL CODE -> the statement fails with that DETAIL code
refused(){ local r; r=$(run "${4:-$DB}" "$2")
  if echo "$r" | grep -q "DETAIL:  $3"; then ok "$1"; else ko "$1" "not refused with $3: [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-0000000000aa
C1=a0000000-0000-4000-8000-000000000001
D1U=a0000000-0000-4000-8000-0000000000d1; DP1=b0000000-0000-4000-8000-000000000001   # approved triciclo, online
D2U=a0000000-0000-4000-8000-0000000000d2; DP2=b0000000-0000-4000-8000-000000000002   # approved auto, online
D3U=a0000000-0000-4000-8000-0000000000d3; DP3=b0000000-0000-4000-8000-000000000003   # approved confort, online
D4U=a0000000-0000-4000-8000-0000000000d4; DP4=b0000000-0000-4000-8000-000000000004   # signing up, no vehicle yet
D5U=a0000000-0000-4000-8000-0000000000d5; DP5=b0000000-0000-4000-8000-000000000005   # suspended, moto
D6U=a0000000-0000-4000-8000-0000000000d6; DP6=b0000000-0000-4000-8000-000000000006   # approved auto, ride in progress
D7U=a0000000-0000-4000-8000-0000000000d7; DP7=b0000000-0000-4000-8000-000000000007   # approved auto, offline
D8U=a0000000-0000-4000-8000-0000000000d8; DP8=b0000000-0000-4000-8000-000000000008   # approved confort, offline
D9U=a0000000-0000-4000-8000-0000000000d9; DP9=b0000000-0000-4000-8000-000000000009   # approved before, back in review
V1=c0000000-0000-4000-8000-000000000001; V2=c0000000-0000-4000-8000-000000000002
V3=c0000000-0000-4000-8000-000000000003; V5=c0000000-0000-4000-8000-000000000005
V6=c0000000-0000-4000-8000-000000000006
OTHER_DOC="driver-docs/$DP2/drivers_license/licencia.jpg"
pt(){ printf "ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography" "$2" "$1"; }   # pt LAT LNG
SEED="
INSERT INTO public.users (id, role) VALUES ('$ADMIN','admin'), ('$C1','customer'), ('$D1U','driver'),
  ('$D2U','driver'), ('$D3U','driver'), ('$D4U','customer'), ('$D5U','driver'), ('$D6U','driver'),
  ('$D7U','driver'), ('$D8U','driver'), ('$D9U','driver');
INSERT INTO public.driver_profiles (id, user_id, status, is_online, current_location, approved_at, identity_number, has_criminal_record) VALUES
  ('$DP1','$D1U','approved',true,  $(pt 23.1357 -82.3666), now() - interval '30 days', '85010112345', false),
  ('$DP2','$D2U','approved',true,  $(pt 23.1360 -82.3670), now() - interval '30 days', NULL, NULL),
  ('$DP3','$D3U','approved',true,  $(pt 23.1365 -82.3675), now() - interval '30 days', NULL, NULL),
  ('$DP4','$D4U','pending_verification',false, NULL, NULL, '90020212345', false),
  ('$DP5','$D5U','suspended',false, $(pt 23.1370 -82.3680), now() - interval '30 days', NULL, NULL),
  ('$DP6','$D6U','approved',true,  $(pt 23.1371 -82.3681), now() - interval '30 days', NULL, NULL),
  ('$DP7','$D7U','approved',false, $(pt 23.1372 -82.3682), now() - interval '30 days', NULL, NULL),
  ('$DP8','$D8U','approved',false, $(pt 23.1373 -82.3683), now() - interval '30 days', NULL, NULL),
  ('$DP9','$D9U','under_review',false, $(pt 23.1374 -82.3684), now() - interval '30 days', '77010112345', false);
INSERT INTO public.vehicles (id, driver_id, type, plate_number) VALUES
  ('$V1','$DP1','triciclo','P123456'), ('$V2','$DP2','auto','B111111'), ('$V3','$DP3','confort','B333333'),
  ('$V5','$DP5','moto','M555555'), ('$V6','$DP6','auto','B666666');
INSERT INTO public.vehicles (driver_id, type, plate_number) VALUES ('$DP7','auto','B777777'), ('$DP8','confort','B888888'),
  ('$DP9','moto','M999999');
INSERT INTO public.rides (customer_id, driver_id, status, service_type) VALUES ('$C1','$DP6','in_progress','auto_standard');
INSERT INTO public.driver_documents (driver_id, document_type, storage_path) VALUES ('$DP2','drivers_license','$OTHER_DOC');
INSERT INTO public.platform_config (key, value) VALUES ('reactivation_push_after_s', '0'::jsonb);"

# as SUB SQL -> SQL as that signed-in account, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
# owner SQL -> SQL as the owner (service role, cron), rolled back
owner(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
fbd(){ printf "(SELECT string_agg(f.id::text, ',' ORDER BY f.id) FROM public.find_best_drivers(23.1357, -82.3666, '%s', 50, 5000) f)" "$1"; }
ST1="(SELECT status || ':' || is_online FROM public.driver_profiles WHERE id = '$DP1')"

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "SET ROLE tricigo_owner; $SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('find_best_drivers', 'notify_offline_drivers_for_searching_rides', 'tg_driver_documents_protect_review',
                        'tg_driver_profiles_protect_admin_fields', 'tg_selfie_checks_protect_insert', 'tg_vehicles_client_guard')"

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('find_best_drivers', 'is_admin',
   'notify_offline_drivers_for_searching_rides', 'tg_driver_documents_protect_review',
   'tg_driver_profiles_protect_admin_fields', 'tg_driver_profiles_protect_insert')" \
  "find_best_drivers:53a6b5d68be18d5369445986a83e2fa9/5543,is_admin:22cb75e91980d512498034cd33e1eda2/285,notify_offline_drivers_for_searching_rides:39582fd79f216e6002e028fa25c4dc96/5456,tg_driver_documents_protect_review:83b86da7634898190e9deaf438e1d6c9/720,tg_driver_profiles_protect_admin_fields:d32c7b58038d3c5658d7388392f56925/5069,tg_driver_profiles_protect_insert:058a94b679a9a9c635e507aa61b26d9f/762"
val "S1 baseline: the triciclo driver gets triciclo offers" "SELECT $(fbd triciclo_basico)" "$DP1"

if [ "$MIG" != none ]; then
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M0 migration applies" || ko "M0 migration applies" "$r"
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M1 migration re-applies (idempotent)" || ko "M1 migration re-applies" "$r"
fi

# --- 1. The vehicle of an approved driver ---------------------------------------------
val "V1 changing the type sends an approved driver back to review, offline" \
  "$(as $D1U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V1'; SELECT $ST1;")" "under_review:false"
val "V2 ...and the new type earns no offers until approved again" \
  "$(as $D1U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V1'; RESET ROLE; SELECT coalesce($(fbd auto_standard), '-');")" \
  "$DP2,$DP3"
val "V3 changing the plate sends the driver back to review too" \
  "$(as $D1U "UPDATE public.vehicles SET plate_number = 'P999999' WHERE id = '$V1'; SELECT $ST1;")" "under_review:false"
val "V4 rewriting the same plate with spaces/dashes/lowercase is not a change" \
  "$(as $D1U "UPDATE public.vehicles SET plate_number = 'p 123-456' WHERE id = '$V1'; SELECT $ST1;")" "approved:true"
val "V5 make, model, year, color, capacity and cargo still save without review" \
  "$(as $D1U "UPDATE public.vehicles SET make = 'Lada', model = '2107', year = 1990, color = 'azul', capacity = 4,
              accepts_cargo = true, max_cargo_weight_kg = 50 WHERE id = '$V1';
              SELECT $ST1 || ':' || (SELECT color || capacity FROM public.vehicles WHERE id = '$V1');")" "approved:true:azul4"
refused "V6 an approved driver cannot add a second vehicle" \
  "$(as $D1U "INSERT INTO public.vehicles (driver_id, type, plate_number) VALUES ('$DP1', 'moto', 'M000001'); SELECT 1;")" \
  "vehicle_add_after_approval"
refused "V7 a driver cannot activate or deactivate a vehicle" \
  "$(as $D1U "UPDATE public.vehicles SET is_active = false WHERE id = '$V1'; SELECT 1;")" "vehicle_active_locked"
# Already refused before 00650 by RLS (v_update has no WITH CHECK, so USING checks the new row too).
refused_any(){ local r; r=$(run "$DB" "$2")
  if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "not refused: [$r]"; fi; }
refused_any "V8 a driver cannot move a vehicle to another account" \
  "$(as $D1U "UPDATE public.vehicles SET driver_id = '$DP2' WHERE id = '$V1'; SELECT 1;")" "vehicle_owner_locked|row-level security"
refused "V9 not with a ride in progress" \
  "$(as $D6U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V6'; SELECT 1;")" "vehicle_change_during_ride"
refused "V10 not while suspended (support does it)" \
  "$(as $D5U "UPDATE public.vehicles SET type = 'auto' WHERE id = '$V5'; SELECT 1;")" "vehicle_change_while_suspended"
val "V11 a suspended driver still edits make and color" \
  "$(as $D5U "UPDATE public.vehicles SET color = 'negro' WHERE id = '$V5'; SELECT color FROM public.vehicles WHERE id = '$V5';")" "negro"
val "V12 while signing up, registering again keeps one active vehicle (the new one)" \
  "$(as $D4U "INSERT INTO public.vehicles (driver_id, type, plate_number) VALUES ('$DP4', 'moto', 'M444444');
              INSERT INTO public.vehicles (driver_id, type, plate_number) VALUES ('$DP4', 'auto', 'B444444');
              SELECT string_agg(type::text || ':' || is_active, ',' ORDER BY type) FROM public.vehicles WHERE driver_id = '$DP4';")" \
  "moto:false,auto:true"
val "V13 while signing up, the type changes freely (no status change)" \
  "$(as $D4U "INSERT INTO public.vehicles (driver_id, type, plate_number) VALUES ('$DP4', 'moto', 'M444444');
              UPDATE public.vehicles SET type = 'confort', plate_number = 'B444444' WHERE driver_id = '$DP4';
              SELECT status FROM public.driver_profiles WHERE id = '$DP4';")" "pending_verification"
val "V14 an admin changes the type without a re-review" \
  "$(as $ADMIN "UPDATE public.vehicles SET type = 'auto' WHERE id = '$V1'; SELECT $ST1;")" "approved:true"
val "V15 back in review, the driver cannot approve themselves" \
  "$(as $D1U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V1';
              UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$DP1'; SELECT $ST1;")" "under_review:false"
val "V16 back in review, the identity the admin checked stays" \
  "$(as $D1U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V1';
              UPDATE public.driver_profiles SET identity_number = '99999999999', has_criminal_record = true WHERE id = '$DP1';
              SELECT identity_number || ':' || has_criminal_record FROM public.driver_profiles WHERE id = '$DP1';")" "85010112345:false"
val "V16b a driver approved before and back in review keeps that identity" \
  "$(as $D9U "UPDATE public.driver_profiles SET identity_number = '99999999999', has_criminal_record = true WHERE id = '$DP9';
              SELECT identity_number || ':' || has_criminal_record FROM public.driver_profiles WHERE id = '$DP9';")" "77010112345:false"
val "V17 a driver signing up for the first time still fills their identity" \
  "$(as $D4U "UPDATE public.driver_profiles SET identity_number = '90020299999' WHERE id = '$DP4';
              SELECT identity_number FROM public.driver_profiles WHERE id = '$DP4';")" "90020299999"
val "V18 the admin approves the new vehicle and the driver gets offers of its type" \
  "$(as $D1U "UPDATE public.vehicles SET type = 'confort' WHERE id = '$V1';
              SET LOCAL request.jwt.claim.sub = '$ADMIN';
              UPDATE public.driver_profiles SET status = 'approved', approved_at = now(), is_online = true WHERE id = '$DP1';
              RESET ROLE; SELECT $(fbd auto_confort);")" "$DP1,$DP3"

# --- 2. Confort bookings ---------------------------------------------------------------
val "C1 a Confort booking goes only to Confort vehicles" "SELECT $(fbd auto_confort)" "$DP3"
val "C2 an Auto booking still goes to Auto and Confort" "SELECT $(fbd auto_standard)" "$DP2,$DP3"
val "C3 the reactivation push for a Confort booking only calls offline Confort drivers" \
  "$(owner "INSERT INTO public.rides (customer_id, status, service_type, created_at) VALUES ('$C1', 'searching', 'auto_confort', now() - interval '5 minutes');
            SELECT public.notify_offline_drivers_for_searching_rides();
            SELECT body->>'user_ids' FROM net.sent ORDER BY id DESC LIMIT 1;")" \
  "1;[\"$D8U\"]"

# --- 3. Documents ----------------------------------------------------------------------
refused "D1 a driver's document cannot point at another driver's file" \
  "$(as $D1U "INSERT INTO public.driver_documents (driver_id, document_type, storage_path) VALUES ('$DP1', 'drivers_license', '$OTHER_DOC'); SELECT 1;")" \
  "document_path_not_own"
refused "D2 ...nor climb out of its folder" \
  "$(as $D1U "INSERT INTO public.driver_documents (driver_id, document_type, storage_path) VALUES ('$DP1', 'drivers_license', 'driver-docs/$DP1/../$DP2/drivers_license/licencia.jpg'); SELECT 1;")" \
  "document_path_not_own"
val "D3 a document in its own folder saves, unreviewed" \
  "$(as $D1U "INSERT INTO public.driver_documents (driver_id, document_type, storage_path, is_verified, verified_by) VALUES ('$DP1', 'drivers_license', 'driver-docs/$DP1/drivers_license/lic.jpg', true, '$ADMIN');
              SELECT is_verified || ':' || coalesce(verified_by::text, '-') FROM public.driver_documents WHERE driver_id = '$DP1';")" "false:-"
val "D4 an admin inserts any path" \
  "$(as $ADMIN "INSERT INTO public.driver_documents (driver_id, document_type, storage_path) VALUES ('$DP1', 'selfie', 'selfie-checks/$DP1/x.jpg');
                SELECT count(*) FROM public.driver_documents WHERE driver_id = '$DP1';")" "1"

# --- 4. Selfie checks ------------------------------------------------------------------
val "F1 a selfie check a driver opens starts pending, without a result" \
  "$(as $D1U "INSERT INTO public.selfie_checks (driver_id, storage_path, status, face_match_score, liveness_passed, completed_at)
              VALUES ('$DP1', 'x', 'passed', 0.99, true, now());
              SELECT status || ':' || coalesce(face_match_score::text, '-') || ':' || coalesce(completed_at::text, '-') FROM public.selfie_checks WHERE driver_id = '$DP1';")" \
  "pending:-:-"
val "F2 verify-selfie (service role) still records a result" \
  "$(owner "INSERT INTO public.selfie_checks (driver_id, status, face_match_score) VALUES ('$DP1', 'passed', 0.9);
            SELECT status FROM public.selfie_checks WHERE driver_id = '$DP1';")" "passed"

# --- 5. Grants -------------------------------------------------------------------------
val "G1 clients hold no TRUNCATE, TRIGGER or DELETE on these tables" \
  "SELECT count(*) FROM unnest(ARRAY['public.vehicles','public.driver_profiles','public.driver_documents','public.selfie_checks','public.driver_contracts']) t,
          unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['TRUNCATE','TRIGGER','DELETE']) p WHERE has_table_privilege(r, t, p)" "0"
val "G2 anon cannot write them; nobody but the service role writes contracts" \
  "SELECT has_table_privilege('anon','public.vehicles','INSERT') OR has_table_privilege('anon','public.driver_profiles','UPDATE')
       OR has_table_privilege('authenticated','public.driver_contracts','INSERT')" "f"
val "G3 drivers keep the writes the app uses" \
  "SELECT has_table_privilege('authenticated','public.vehicles','INSERT') AND has_table_privilege('authenticated','public.vehicles','UPDATE')
      AND has_table_privilege('authenticated','public.driver_profiles','UPDATE') AND has_table_privilege('authenticated','public.driver_documents','INSERT')
      AND has_table_privilege('authenticated','public.selfie_checks','INSERT') AND has_table_privilege('authenticated','public.selfie_checks','UPDATE')" "t"

if [ "$MIG" != none ]; then
  # Pasted from Windows into the SQL Editor: the same text with CRLF line endings.
  fresh ${DB}w || { echo "scaffold failed"; exit 2; }
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err ${DB}w "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ]; then
    val "M2 a CRLF copy applies and leaves the bodies of git" "$BODIES" "$(run $DB "$BODIES")" ${DB}w
  else ko "M2 a CRLF copy applies" "$r"; fi

  # Negative proofs: the guards stop on what this migration does not know.
  fresh ${DB}n || { echo "scaffold failed"; exit 2; }
  run ${DB}n "SET ROLE tricigo_owner; DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure), 'v_is_long_trip := ', 'v_is_long_trip :=  '); END \$\$;" >/dev/null
  r=$(apply_err ${DB}n "$MIG")
  if echo "$r" | grep -q "unexpected body of public.find_best_drivers"; then ok "N1 an unknown body of find_best_drivers stops the migration"; else ko "N1 unknown body" "$r"; fi
  val "N2 ...and nothing was half-applied" \
    "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_vehicles_client_guard','trg_selfie_checks_protect_insert'))
            || ':' || (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tg_driver_profiles_protect_admin_fields')" \
    "0:d32c7b58038d3c5658d7388392f56925" ${DB}n

  fresh ${DB}n || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}n "$MIG")
  run ${DB}n "SET ROLE tricigo_owner; DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_vehicles_client_guard()'::regprocedure), 'RETURN NEW;', 'RETURN NEW; '); END \$\$;" >/dev/null
  r=$(apply_err ${DB}n "$MIG")
  if echo "$r" | grep -q "tg_vehicles_client_guard exists with an unknown body"; then ok "N3 a changed vehicle guard is not overwritten"; else ko "N3 changed guard" "$r"; fi

  # The final check, run alone: passes on the migrated database, stops on a client grant.
  fresh ${DB}n || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}n "$MIG")
  CHECK=$(mktemp); awk '/^DO \$check\$/,/^\$check\$;/' "$MIG" > "$CHECK"
  r=$(apply_err ${DB}n "$CHECK"); [ "$r" = applied ] && ok "N4 the final check passes on the migrated database" || ko "N4 final check" "$r"
  run ${DB}n "GRANT DELETE ON public.vehicles TO authenticated" >/dev/null
  r=$(apply_err ${DB}n "$CHECK")
  if echo "$r" | grep -q "clients still hold public.vehicles:authenticated:DELETE"; then ok "N5 ...and stops on a client DELETE grant"; else ko "N5 grant check" "$r"; fi
  run ${DB}n "REVOKE DELETE ON public.vehicles FROM authenticated; SET ROLE tricigo_owner; DO \$\$ BEGIN EXECUTE replace(pg_get_functiondef('public.find_best_drivers(double precision,double precision,text,integer,integer,boolean,integer,text,numeric,integer,integer,integer,uuid)'::regprocedure), 'WHEN p_service_type = ''auto_confort'' THEN ARRAY[''confort''::vehicle_type]', 'WHEN p_service_type = ''auto_confort'' THEN ARRAY[''confort''::vehicle_type, ''auto''::vehicle_type]'); END \$\$;" >/dev/null
  r=$(apply_err ${DB}n "$CHECK"); rm -f "$CHECK"
  if echo "$r" | grep -q "bodies are not the ones of git: public.find_best_drivers"; then ok "N6 ...and on a dispatch body that is not the one of git"; else ko "N6 body check" "$r"; fi
  for d in ${DB}w ${DB}n; do $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done
fi

echo "---"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
