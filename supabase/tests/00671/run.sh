#!/usr/bin/env bash
# Rehearsal runner for migration 00671 (operator role, delivery 3: live rides).
# Builds the rides triggers and the eleven functions 00671 patches as they are in prod
# (live-bodies.sql, byte for byte), on the tables and role checks of base.sql and tables.sql.
#   supabase/tests/00671/run.sh none
#       -> prod as captured + tests (RED: the operator cannot cancel, release or move a ride)
#   supabase/tests/00671/run.sh supabase/migrations/00671_operator_live_rides.sql
#       -> the same + 00671 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed no other function, a CRLF copy applied to a fresh database, and negative proofs
#          of the file's own checks
# The ride functions that need PostGIS, pg_net and the wallets (offer, assign, release, advance,
# complete) are exercised in prod inside a rolled-back block instead (see the PR); here only their
# bodies, md5 and grants are checked.
# Cluster: any Postgres 16 with a superuser. Default: psql on 127.0.0.1:${PGPORT:-5433} as pgtest.
#   PSQL="docker exec -i <container> psql -U pgtest" supabase/tests/00671/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
PSQL="${PSQL:-psql -h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest}"
DB=pr671
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# run DB SQL: one transaction, output rows joined by ';', errors included.
run(){ echo "$2" | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3] in [$r]"; fi; }
# apply DB FILE: as the owner, in one transaction; prints "applied" or the first ERROR line.
apply(){ local out; if out=$({ echo "$AS_OWNER"; cat "$2"; } | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f - 2>&1); then echo applied;
         else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
mkdb(){
  echo "DROP DATABASE IF EXISTS $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1
  echo "CREATE DATABASE $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1 || { echo "cannot create $1"; exit 1; }
  if ! cat "$DIR/scaffold.sql" "$DIR/tables.sql" "$DIR/base.sql" "$DIR/live-bodies.sql" "$DIR/wiring.sql" \
       | $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
}

OP=a6710000-0000-4000-8000-000000000001     # operator
ADM=a6710000-0000-4000-8000-000000000002    # admin
MKT=a6710000-0000-4000-8000-000000000003    # marketing
CUS=a6710000-0000-4000-8000-000000000004    # customer
DRV=a6710000-0000-4000-8000-000000000005    # driver
DP=d6710000-0000-4000-8000-000000000001     # DRV's approved profile
DPOP=d6710000-0000-4000-8000-000000000002   # an approved profile of the operator
R1=f6710000-0000-4000-8000-000000000001     # accepted: CUS rides, DRV drives
R2=f6710000-0000-4000-8000-000000000002     # searching: CUS rides
R3=f6710000-0000-4000-8000-000000000003     # accepted: the operator rides, DRV drives
R4=f6710000-0000-4000-8000-000000000004     # accepted: CUS rides, the operator drives
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }
# ops IDS: what an ops function does before writing (only the owner may call _ops_allow).
ops(){ echo "SELECT public._ops_allow(ARRAY['$1']::uuid[]);"; }
# Every test runs in a transaction that is rolled back.
tx(){ echo "BEGIN; $1 ROLLBACK;"; }

SEED="
INSERT INTO public.users (id, role, is_active) VALUES
  ('$OP', 'operator', true), ('$ADM', 'admin', true), ('$MKT', 'marketing', true),
  ('$CUS', 'customer', true), ('$DRV', 'driver', true);
INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$DP', '$DRV', 'approved'), ('$DPOP', '$OP', 'approved');
INSERT INTO public.rides (id, customer_id, driver_id, status, estimated_distance_m, estimated_duration_s) VALUES
  ('$R1', '$CUS', '$DP', 'accepted', 3000, 600), ('$R2', '$CUS', NULL, 'searching', 3000, 600),
  ('$R3', '$OP', '$DP', 'accepted', 3000, 600), ('$R4', '$CUS', '$DPOP', 'accepted', 3000, 600);"

PATCHED_LIST="'enforce_ride_transition','enforce_ride_update_columns','tg_rides_validate_actuals','complete_ride_and_pay',
  'admin_offer_ride_to_driver','admin_assign_ride_to_driver','admin_change_ride_service','admin_release_active_ride',
  'admin_advance_active_ride','admin_complete_active_ride','admin_cancel_ride'"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED_LIST)"
# md5 of prosrc in prod on 2026-11-02, and after 00671.
OLD_BODIES="admin_advance_active_ride=a713704024143056009faf750f838209,admin_assign_ride_to_driver=3b082adbd39a6b3c0104bbd7ca3a4aa6,admin_cancel_ride=bf69819d3f06ba41fc2f1d3ee1f433d1,admin_change_ride_service=35d88994a7e3978a478c06d6d499e4b6,admin_complete_active_ride=8297bfe04b2b95f5321c5a15381631dd,admin_offer_ride_to_driver=fdbb9def0cc026200a6671b472343979,admin_release_active_ride=3b8023a9675a976787964ad18f487a45,complete_ride_and_pay=dc8ddf9007b362ec0629d32a16d94920,enforce_ride_transition=0f18b49d2d65e00923fa7f8d136b2387,enforce_ride_update_columns=31af7a0b024555f25320def803642dba,tg_rides_validate_actuals=5266e8d49fcd97eba56294556e886b85"
NEW_BODIES="admin_advance_active_ride=bc7187cb8d4dbde6c64886e2ee9e3ff8,admin_assign_ride_to_driver=ae15385d1c9cfbc109fe50d1ee396a4d,admin_cancel_ride=21b4dfa6427e7c8976ef1324ddfa732b,admin_change_ride_service=06b0af6654384570c38a76389681d43a,admin_complete_active_ride=149e13089c12d43458a75ee58dd2a9d3,admin_offer_ride_to_driver=0085408045cc5fbf2dbc3e2eb0da92f5,admin_release_active_ride=8f18bf4984f52e41c93cdb16b062eeff,complete_ride_and_pay=62298c877be639dbf69545f3c70d654e,enforce_ride_transition=8081889db255282b67aaed2bfc9e458a,enforce_ride_update_columns=0b912f46f8ec7e63eca4777c4b28c495,tg_rides_validate_actuals=801600c034effe8a139944be5c4ec82a"
# Every other function of public, to show 00671 changed nothing else.
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ($PATCHED_LIST, '_ops_allow', '_ops_acting_on')"

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's bodies" "$BODIES" "$OLD_BODIES"
OTHERS_BEFORE=$(run $DB "$OTHERS")

if [ "$MIG" != none ]; then
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M1 00671 applies (1st)" || ko "M1 00671 applies (1st)" "$r"
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M2 00671 applies again" || ko "M2 00671 applies again" "$r"
  val "M3 the patched bodies are 00671's" "$BODIES" "$NEW_BODIES"
  val "M4 no other function changed" "$OTHERS" "$OTHERS_BEFORE"
fi

# ── Helpers ───────────────────────────────────────────────────
for role in anon authenticated service_role; do
  has "H1 $role cannot set the ops list" "$(tx "SET LOCAL ROLE $role; SELECT public._ops_allow(ARRAY['$R1']::uuid[]);")" \
      "permission denied for function _ops_allow"
done
val "H2 operator acting on a listed ride" "$(tx "$(ops $R1) $(as_user $OP) SELECT public._ops_acting_on('$R1');")" "t"
val "H3 operator, a ride not listed" "$(tx "$(ops $R1) $(as_user $OP) SELECT public._ops_acting_on('$R2');")" "f"
val "H4 operator, no list" "$(tx "$(as_user $OP) SELECT public._ops_acting_on('$R1');")" "f"
val "H5 customer, marketing and anon never act" \
    "$(tx "$(ops $R1) $(as_user $CUS) SELECT public._ops_acting_on('$R1'); $(as_user $MKT) SELECT public._ops_acting_on('$R1'); $(as_anon) SELECT public._ops_acting_on('$R1');")" "f;f;f"
val "H6 two calls add up" "$(tx "$(ops $R1) $(ops $R2) $(as_user $OP) SELECT public._ops_acting_on('$R1'), public._ops_acting_on('$R2');")" "t|t"

# ── Triggers ──────────────────────────────────────────────────
RELEASE="UPDATE public.rides SET status = 'searching', driver_id = NULL WHERE id = '$R1';"
has "T1 operator outside an ops function moves a ride as a customer" "$(tx "$(as_user $OP) $RELEASE")" \
    "Invalid ride transition from accepted to searching for role customer"
val "T2 operator inside, on that ride: moved, recorded as admin by the operator" \
    "$(tx "$(ops $R1) $(as_user $OP) $RELEASE RESET ROLE; SELECT status, driver_id IS NULL FROM public.rides WHERE id = '$R1'; SELECT actor_role || ',' || actor_id FROM public.ride_transitions WHERE ride_id = '$R1';")" \
    "searching|t;admin,$OP"
has "T3 operator, ops list for another ride" "$(tx "$(ops $R2) $(as_user $OP) $RELEASE")" "for role customer"
has "T4 marketing with the list stays a customer" "$(tx "$(ops $R1) $(as_user $MKT) $RELEASE")" "for role customer"
has "T5 the ride's customer with the list stays a customer" "$(tx "$(ops $R1) $(as_user $CUS) $RELEASE")" "for role customer"
has "T6 operator outside clears driver_id: refused" "$(tx "$(as_user $OP) UPDATE public.rides SET driver_id = NULL WHERE id = '$R1';")" \
    "cannot modify driver_id"
val "T7 operator inside clears driver_id" "$(tx "$(ops $R1) $(as_user $OP) UPDATE public.rides SET driver_id = NULL WHERE id = '$R1'; RESET ROLE; SELECT count(*) FROM public.rides WHERE id = '$R1' AND driver_id IS NULL;")" "1"
has "T8 operator outside, 11 h of actuals: refused" "$(tx "$(as_user $OP) UPDATE public.rides SET actual_duration_s = 40000 WHERE id = '$R1';")" \
    "exceeds 8h"
val "T9 operator inside, 11 h of actuals" "$(tx "$(ops $R1) $(as_user $OP) UPDATE public.rides SET actual_duration_s = 40000 WHERE id = '$R1'; RESET ROLE; SELECT actual_duration_s FROM public.rides WHERE id = '$R1';")" "40000"

# ── admin_cancel_ride ─────────────────────────────────────────
cancel(){ echo "$(as_user $1) SELECT public.admin_cancel_ride('$2', 'prueba'); RESET ROLE;"; }
val "C1 operator cancels: canceled by them, recorded as admin, logged" \
    "$(tx "$(cancel $OP $R1) SELECT status || ',' || canceled_by FROM public.rides WHERE id = '$R1'; SELECT actor_role FROM public.ride_transitions WHERE ride_id = '$R1'; SELECT action || ',' || admin_id FROM public.admin_actions WHERE target_id = '$R1';")" \
    "{\"ride_id\": \"$R1\", \"success\": true, \"previous_status\": \"accepted\"};canceled,$OP;admin;cancel_ride,$OP"
val "C2 operator, their own ride as a passenger" "$(tx "$(cancel $OP $R3) SELECT status FROM public.rides WHERE id = '$R3';")" \
    "{\"error\": \"self_ride\"};accepted"
val "C3 operator, a ride they drive" "$(tx "$(cancel $OP $R4) SELECT status FROM public.rides WHERE id = '$R4';")" \
    "{\"error\": \"self_ride\"};accepted"
val "C4 marketing cannot cancel" "$(tx "$(cancel $MKT $R1)")" "{\"error\": \"forbidden\"}"
val "C5 a customer cannot cancel as support" "$(tx "$(cancel $CUS $R1)")" "{\"error\": \"forbidden\"}"
val "C6 an admin still cancels, recorded as admin" \
    "$(tx "$(cancel $ADM $R2) SELECT status || ',' || canceled_by FROM public.rides WHERE id = '$R2'; SELECT actor_role FROM public.ride_transitions WHERE ride_id = '$R2';")" \
    "{\"ride_id\": \"$R2\", \"success\": true, \"previous_status\": \"searching\"};canceled,$ADM;admin"
val "C7 the operator's own ride: still cancelable by an admin" "$(tx "$(cancel $ADM $R3) SELECT status FROM public.rides WHERE id = '$R3';")" \
    "{\"ride_id\": \"$R3\", \"success\": true, \"previous_status\": \"accepted\"};canceled"

# ── Grants of the opened functions ────────────────────────────
val "G1 anon cannot call the opened functions; authenticated can" \
    "SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('complete_ride_and_pay','admin_offer_ride_to_driver',
       'admin_assign_ride_to_driver','admin_change_ride_service','admin_release_active_ride','admin_advance_active_ride',
       'admin_complete_active_ride','admin_cancel_ride')" "t"

if [ "$MIG" != none ]; then
  # ── A CRLF copy (pasted from Windows into the SQL Editor) ──
  CRLF=$(mktemp); sed 's/$/\r/' "$ROOT/$MIG" > "$CRLF"
  mkdb ${DB}crlf
  r=$(apply ${DB}crlf "$CRLF"); [ "$r" = applied ] && ok "R1 a CRLF copy applies" || ko "R1 a CRLF copy applies" "$r"
  val "R2 the CRLF copy leaves the same bodies, without carriage returns" \
      "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
      "$NEW_BODIES;0" ${DB}crlf
  rm -f "$CRLF"

  # ── Negative proofs of the file's own checks ──
  neg(){ # neg NAME SETUP_SQL EXPECTED_ERROR [FILE]
    mkdb ${DB}neg
    run ${DB}neg "SET ROLE postgres; $2" >/dev/null
    local r; r=$(apply ${DB}neg "${4:-$ROOT/$MIG}")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi
  }
  neg "N1 a body it does not know stops it" \
      "CREATE OR REPLACE FUNCTION public.admin_cancel_ride(p_ride_id uuid, p_reason text DEFAULT NULL::text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN NULL; END \$f\$;" \
      "admin_cancel_ride(uuid,text) has an unknown body"
  neg "N2 another function calling the ops checks stops it" \
      "CREATE FUNCTION public.zz_probe() RETURNS boolean LANGUAGE sql AS \$f\$ SELECT public.is_ops_staff() \$f\$;" \
      "other functions call the ops checks: zz_probe()"
  neg "N3 a role function naming the operator stops it" \
      "CREATE FUNCTION public.promote_user_role() RETURNS text LANGUAGE sql AS \$f\$ SELECT 'operator'::text \$f\$;" \
      "a money or role function names the operator"
  NOREVOKE=$(mktemp); grep -v '^REVOKE ALL ON FUNCTION public._ops_allow' "$ROOT/$MIG" > "$NOREVOKE"
  neg "N4 the ops list open to clients stops it" "SELECT 1;" "the helpers have the wrong permissions" "$NOREVOKE"
  rm -f "$NOREVOKE"
  for d in ${DB}crlf ${DB}neg; do echo "DROP DATABASE IF EXISTS $d;" | $PSQL -d postgres -q -f - >/dev/null 2>&1; done
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
