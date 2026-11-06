#!/usr/bin/env bash
# Rehearsal runner for migration 00677 (company rides skip the driver's wallet check).
#   supabase/tests/00677/run.sh none
#       -> scaffold with prod's bodies + tests (RED: a driver with no balance cannot take a company ride)
#   supabase/tests/00677/run.sh supabase/migrations/00677_corporate_rides_skip_wallet_check.sql
#       -> the same + migration x2 + tests + a CRLF copy + negative proofs (GREEN)
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00677/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr677
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
mkdb(){
  $BIN/psql $CONN -d postgres -q -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1
  $BIN/psql $CONN -d postgres -q -c "CREATE DATABASE $1" >/dev/null 2>&1 || { echo "cannot create $1"; exit 1; }
  if ! cat "$DIR/scaffold.sql" "$DIR/live-bodies.sql" "$DIR/live-ops.sql" | $BIN/psql $CONN -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
}
apply(){ local out; if out=$({ echo "$AS_OWNER;"; cat "$2"; } | $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f - 2>&1); then echo applied;
         else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

ADM=a6770000-0000-4000-8000-000000000001   # admin
CUS=a6770000-0000-4000-8000-000000000002   # passenger
DRV=a6770000-0000-4000-8000-000000000003   # the fleet driver, with no balance
DRV2=a6770000-0000-4000-8000-000000000004  # a driver outside the fleet, no balance
DP=d6770000-0000-4000-8000-000000000001    # DRV's profile
DP2=d6770000-0000-4000-8000-000000000002   # DRV2's profile
CORP=c6770000-0000-4000-8000-000000000001  # a fleet company
FL=e6770000-0000-4000-8000-000000000001    # its fleet
RC=f6770000-0000-4000-8000-000000000001    # company ride, searching
RK=f6770000-0000-4000-8000-000000000002    # cash ride, searching
RX=f6770000-0000-4000-8000-000000000003    # corporate_account_id set but paid in cash
RN=f6770000-0000-4000-8000-000000000004    # payment_method corporate, no account
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
tx(){ echo "BEGIN; $1 ROLLBACK;"; }
SEED="
INSERT INTO public.users (id, role) VALUES ('$ADM','admin'), ('$CUS','customer'), ('$DRV','driver'), ('$DRV2','driver');
INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP','$DRV'), ('$DP2','$DRV2');
INSERT INTO public.corporate_accounts (id, is_fleet_owner) VALUES ('$CORP', true);
INSERT INTO public.driver_fleets (id, corporate_account_id) VALUES ('$FL', '$CORP');
INSERT INTO public.fleet_members (fleet_id, driver_id, status) VALUES ('$FL', '$DRV', 'active');
INSERT INTO public.service_type_configs (slug, min_fare_cup, is_active) VALUES ('triciclo_basico', 1000, true);
INSERT INTO public.vehicles (driver_id, type) VALUES ('$DP', 'triciclo'), ('$DP2', 'triciclo');
INSERT INTO public.rides (id, customer_id, status, service_type, payment_method, corporate_account_id, estimated_fare_cup) VALUES
  ('$RC','$CUS','searching','triciclo_basico','corporate','$CORP',2000),
  ('$RK','$CUS','searching','triciclo_basico','cash',NULL,2000),
  ('$RX','$CUS','searching','triciclo_basico','cash','$CORP',2000),
  ('$RN','$CUS','searching','triciclo_basico','corporate',NULL,2000);
INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at)
  SELECT r.id, d.id, 'pending', now() + interval '5 minutes' FROM public.rides r, public.driver_profiles d;"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('accept_ride_v2','admin_assign_ride_to_driver','admin_ride_assist_candidates')"
# md5 of prosrc in prod on 2026-11-06, and after 00677.
OLD_BODIES="accept_ride_v2=b51311095327fa66df27849ec9a4660f,admin_assign_ride_to_driver=ae15385d1c9cfbc109fe50d1ee396a4d,admin_ride_assist_candidates=18ec24b4eff82a82c401df6889eb399c"
NEW_BODIES="accept_ride_v2=bf48ed429bebee25eccf9390ac3b56c0,admin_assign_ride_to_driver=96a14f1ef39f9d397884457278efd699,admin_ride_assist_candidates=c97a27059673affa5f75bc024e09f6bb"
accept(){ echo "$(as_user $2) SELECT coalesce(public.accept_ride_v2('$1', '$3')->>'error', 'accepted');"; }
assign(){ echo "$(as_user $ADM) SELECT coalesce(public.admin_assign_ride_to_driver('$1', '$2', 'prueba')->>'error', 'assigned');"; }
cand(){ echo "$(as_user $ADM) SELECT can_afford FROM public.admin_ride_assist_candidates('$1') WHERE driver_profile_id = '$2';"; }

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's bodies" "$BODIES" "$OLD_BODIES"

if [ "$MIG" != none ]; then
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M1 00677 applies (1st)" || ko "M1 00677 applies (1st)" "$r"
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M2 00677 applies again" || ko "M2 00677 applies again" "$r"
  val "M3 the patched bodies are 00677's" "$BODIES" "$NEW_BODIES"
fi

# ── accept_ride_v2 ────────────────────────────────────────────
val "A1 company ride, fleet driver with no balance: accepted" "$(tx "$(accept $RC $DRV $DP)")" "accepted"
val "A2 cash ride, the same driver: insufficient_balance" "$(tx "$(accept $RK $DRV $DP)")" "insufficient_balance"
val "A3 company ride, driver outside the fleet: not_in_fleet still" "$(tx "$(accept $RC $DRV2 $DP2)")" "not_in_fleet"
val "A4 company account on a cash ride: the check stays" "$(tx "$(accept $RX $DRV $DP)")" "insufficient_balance"
val "A5 company payment without account: the check stays" "$(tx "$(accept $RN $DRV $DP)")" "insufficient_balance"
val "A6 company ride accepted: the ride belongs to the driver" \
    "$(tx "$(accept $RC $DRV $DP) RESET ROLE; SELECT status || ',' || driver_id FROM public.rides WHERE id = '$RC';")" "accepted;accepted,$DP"
val "A7 cash ride with balance still accepted" \
    "$(tx "INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES ('$DRV','tricicoin',1000); $(accept $RK $DRV $DP)")" "accepted"

# ── admin_assign_ride_to_driver ───────────────────────────────
val "S1 assign a company ride to the fleet driver with no balance" "$(tx "$(assign $RC $DP)")" "assigned"
val "S2 assign a cash ride: insufficient_balance" "$(tx "$(assign $RK $DP)")" "insufficient_balance"
val "S3 company ride, driver outside the fleet: not_in_fleet still" "$(tx "$(assign $RC $DP2)")" "not_in_fleet"
val "S4 company account on a cash ride: the check stays" "$(tx "$(assign $RX $DP)")" "insufficient_balance"

# ── admin_ride_assist_candidates ──────────────────────────────
val "K1 company ride: the driver with no balance can afford it" "$(tx "$(cand $RC $DP)")" "t"
val "K2 cash ride: cannot afford" "$(tx "$(cand $RK $DP)")" "f"
val "K3 company account on a cash ride: cannot afford" "$(tx "$(cand $RX $DP)")" "f"
val "K4 company payment without account: cannot afford" "$(tx "$(cand $RN $DP)")" "f"

if [ "$MIG" != none ]; then
  CRLF=$(mktemp); sed 's/$/\r/' "$ROOT/$MIG" > "$CRLF"
  mkdb ${DB}crlf
  r=$(apply ${DB}crlf "$CRLF"); [ "$r" = applied ] && ok "R1 a CRLF copy applies" || ko "R1 a CRLF copy applies" "$r"
  val "R2 the CRLF copy leaves the same bodies, without carriage returns" \
      "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
      "$NEW_BODIES;0" ${DB}crlf
  rm -f "$CRLF"

  neg(){ # neg NAME SETUP_SQL EXPECTED_ERROR [FILE]
    mkdb ${DB}neg
    run ${DB}neg "SET ROLE postgres; $2" >/dev/null
    local r; r=$(apply ${DB}neg "${4:-$ROOT/$MIG}")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi
  }
  neg "N1 an unknown accept_ride_v2 body stops it" \
      "CREATE OR REPLACE FUNCTION public.accept_ride_v2(p_ride_id uuid, p_driver_id uuid) RETURNS jsonb LANGUAGE sql AS \$f\$ SELECT NULL::jsonb \$f\$;" \
      "accept_ride_v2(uuid,uuid) has an unknown body"
  neg "N2 an unknown admin_assign_ride_to_driver body stops it" \
      "CREATE OR REPLACE FUNCTION public.admin_assign_ride_to_driver(p_ride_id uuid, p_driver_profile_id uuid, p_reason text) RETURNS jsonb LANGUAGE sql AS \$f\$ SELECT NULL::jsonb \$f\$;" \
      "admin_assign_ride_to_driver(uuid,uuid,text) has an unknown body"
  neg "N3 an unknown admin_ride_assist_candidates body stops it" \
      "DROP FUNCTION public.admin_ride_assist_candidates(uuid,text); CREATE FUNCTION public.admin_ride_assist_candidates(p_ride_id uuid, p_service_type text DEFAULT NULL) RETURNS TABLE(x int) LANGUAGE sql AS \$f\$ SELECT 1 \$f\$;" \
      "admin_ride_assist_candidates(uuid,text) has an unknown body"
  neg "N5 a changed driver_can_afford_commission stops the self-check" \
      "CREATE OR REPLACE FUNCTION public.driver_can_afford_commission(p_driver_id uuid, p_estimated_fare_cup integer) RETURNS jsonb LANGUAGE sql AS \$f\$ SELECT '{}'::jsonb \$f\$;" \
      "driver_can_afford_commission changed"
  # The self-check: a migration whose patch lands wrong must abort. Weaken the condition in the file.
  BAD=$(mktemp); sed "s/corporate_account_id IS NOT NULL THEN/corporate_account_id IS NULL THEN/" "$ROOT/$MIG" > "$BAD"
  neg "N4 a patch that lands wrong stops it" "SELECT 1;" "00677" "$BAD"
  rm -f "$BAD"
  for d in ${DB}crlf ${DB}neg; do $BIN/psql $CONN -d postgres -q -c "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done
fi
echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
