#!/usr/bin/env bash
# Rehearsal runner for migration 00615 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00615/run.sh none
#       -> prod as of 2026-10-06 (scaffold with the live referral payers) + tests
#          (RED: approval pays the driver-referral bonus, the first ride does not)
#   supabase/tests/00615/run.sh supabase/migrations/00615_referral_driver_bonus_on_first_ride.sql
#       -> the same + migration x2 (idempotency) + tests + negative proof of its assertion (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00615/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr615
AS_OWNER="SET ROLE tricigo_owner"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=terse -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | grep -v '^WARNING' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

PLAT=00000000-0000-0000-0000-000000000001
REF=a1000000-0000-4000-8000-000000000001    # customer; refers DRV and RIDER
DRV=b2000000-0000-4000-8000-000000000002    # driver referred by REF
PAS=c3000000-0000-4000-8000-000000000003    # customer with no referral
VET=d4000000-0000-4000-8000-000000000004    # driver who already drove before applying a code
REF2=e5000000-0000-4000-8000-000000000005   # driver; refers VET
RIDER=f6000000-0000-4000-8000-000000000006  # customer referred by REF (rider path)
BOOM=07000000-0000-4000-8000-000000000007   # referrer whose wallet lookup fails
DRV3=08000000-0000-4000-8000-000000000008   # driver referred by BOOM
DRV4=09000000-0000-4000-8000-000000000009   # driver referred by REF2 (flag-off case)
RIDER2=0a000000-0000-4000-8000-00000000000a # customer referred by REF2
DRV5=0b000000-0000-4000-8000-00000000000b   # driver referred by REF (both payers on one ride)
DP_DRV=1b000000-0000-4000-8000-000000000002
DP_VET=1d000000-0000-4000-8000-000000000004
DP_DRV3=18000000-0000-4000-8000-000000000008
DP_DRV4=19000000-0000-4000-8000-000000000009
DP_DRV5=1a000000-0000-4000-8000-00000000000b

SEED="
INSERT INTO users (id, role, full_name) VALUES
  ('$PLAT','admin','Plataforma'), ('$REF','customer','Refe'), ('$DRV','driver','Dario'),
  ('$PAS','customer','Pasa'), ('$VET','driver','Veterano'), ('$REF2','driver','Refe Dos'),
  ('$RIDER','customer','Rita'), ('$BOOM','customer','BOOM'), ('$DRV3','driver','Tercero'),
  ('$DRV4','driver','Cuarto'), ('$RIDER2','customer','Rita Dos'), ('$DRV5','driver','Quinto');
INSERT INTO driver_profiles (id, user_id, status) VALUES
  ('$DP_DRV','$DRV','pending_verification'), ('$DP_VET','$VET','approved'),
  ('$DP_DRV3','$DRV3','approved'), ('$DP_DRV4','$DRV4','approved'), ('$DP_DRV5','$DRV5','approved');
INSERT INTO feature_flags (key, value) VALUES ('referral_program_enabled', true);
INSERT INTO platform_config (key, value) VALUES
  ('referral_bonus_cup','500'), ('referral_bonus_driver_cup','1000'),
  ('referral_welcome_bonus_cup','0'), ('referral_welcome_bonus_driver_cup','0');
INSERT INTO referrals (referrer_id, referee_id, code) VALUES
  ('$REF','$DRV','REFE1'), ('$REF','$RIDER','REFE1'), ('$BOOM','$DRV3','BOOM1'),
  ('$REF2','$DRV4','REFE2'), ('$REF2','$RIDER2','REFE2'), ('$REF','$DRV5','REFE1');
-- VET drove twice before anyone referred him.
INSERT INTO rides (customer_id, driver_id, status) VALUES
  ('$PAS','$DP_VET','completed'), ('$PAS','$DP_VET','completed');
INSERT INTO referrals (referrer_id, referee_id, code) VALUES ('$REF2','$VET','REFE2');"

# ride CUSTOMER DRIVER_PROFILE -> a ride in progress that then completes (two statements: an UPDATE
# cannot see a row inserted by a CTE of the same statement). Only one ride is ever in progress.
ride(){ echo "INSERT INTO rides (customer_id, driver_id, status) VALUES ('$1','$2','in_progress');
  UPDATE rides SET status = 'completed' WHERE status = 'in_progress';"; }
# ref REFEREE -> status:bonus_amount:ledger rows for that referral
ref(){ echo "SELECT r.status || ':' || r.bonus_amount || ':' || (SELECT count(*) FROM ledger_transactions t WHERE t.reference_id = r.id)
  FROM referrals r WHERE r.referee_id = '$1';"; }
bal(){ echo "SELECT COALESCE((SELECT balance FROM wallet_accounts WHERE user_id = '$1' AND account_type = '$2'), 0);"; }

$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 1; }

val "scaffold: live payers are byte-exact with prod" \
  "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('trg_referral_reward_on_complete','trg_referral_reward_on_driver_approved')" \
  "trg_referral_reward_on_complete=7f5dcb0663accaf345f2e16374a0545c,trg_referral_reward_on_driver_approved=18ba26bd32bd10f5f9ce43aab8cb9849"

if [ "$MIG" != none ]; then
  r1=$(apply_err $DB "$MIG"); r2=$(apply_err $DB "$MIG")
  [ "$r1" = applied ] && [ "$r2" = applied ] && ok "migration applies twice" || ko "migration applies twice" "[$r1] [$r2]"
fi

run $DB "$SEED" >/dev/null

# --- driver referral -------------------------------------------------------------------
run $DB "UPDATE driver_profiles SET status = 'approved' WHERE id = '$DP_DRV';" >/dev/null
val "D1 approving the referred driver pays nothing"            "$(ref $DRV)" "pending:500:0"

run $DB "$(ride $REF $DP_DRV)" >/dev/null
val "D2 a ride requested by the referrer does not pay"         "$(ref $DRV)" "pending:500:0"

run $DB "$(ride $PAS $DP_DRV)" >/dev/null
val "D4 his first ride with another customer pays the driver bonus" "$(ref $DRV)" "rewarded:1000:1"
val "D4 the referrer's wallet got it"                          "$(bal $REF customer_cash)" "1000"
val "D4 with the driver-referral idempotency key" \
  "SELECT count(*) FROM ledger_transactions WHERE idempotency_key LIKE 'referral_bonus_driver:%'" "1"
val "D4 the platform paid it" "$(bal $PLAT platform_promotions)" "-1000"

run $DB "$(ride $PAS $DP_DRV)" >/dev/null
val "D5 his second ride pays nothing more"                     "$(bal $REF customer_cash)" "1000"

run $DB "$(ride $PAS $DP_VET)" >/dev/null
val "D6 a code applied after the driver already drove never pays" "$(ref $VET)" "pending:500:0"

run $DB "$(ride $PAS $DP_DRV3)" >/dev/null
val "D7 a failing payout leaves the ride completed" \
  "SELECT count(*) FROM rides WHERE driver_id = '$DP_DRV3' AND status = 'completed'" "1"
val "D7 and the referral pending, with no money moved"        "$(ref $DRV3)" "pending:500:0"

run $DB "UPDATE feature_flags SET value = false WHERE key = 'referral_program_enabled'; $(ride $PAS $DP_DRV4)
         UPDATE feature_flags SET value = true WHERE key = 'referral_program_enabled';" >/dev/null
val "D8 with the program off, nothing is paid"                 "$(ref $DRV4)" "pending:500:0"

run $DB "UPDATE rides SET status = 'completed' WHERE driver_id = '$DP_DRV' AND status = 'completed';" >/dev/null
val "D9 re-saving a completed ride pays nothing"               "$(bal $REF customer_cash)" "1000"

# --- rider referral stays as it was ------------------------------------------------------
run $DB "$(ride $RIDER $DP_DRV)" >/dev/null
val "R1 a referred rider's first ride still pays the rider bonus" "$(ref $RIDER)" "rewarded:500:1"
val "R1 the referrer now holds both bonuses"                   "$(bal $REF customer_cash)" "1500"

run $DB "$(ride $RIDER2 $DP_DRV5)" >/dev/null
val "R2 one ride, referred rider and referred driver: both get paid" \
  "SELECT ($(ref $RIDER2 | sed 's/;$//')) || ',' || ($(ref $DRV5 | sed 's/;$//'))" "rewarded:500:1,rewarded:1000:1"
val "R2 each referrer got its own bonus" \
  "SELECT ($(bal $REF2 tricicoin | sed 's/;$//')) || ',' || ($(bal $REF customer_cash | sed 's/;$//'))" "500,2500"

# --- the migration's own assertion -------------------------------------------------------
if [ "$MIG" != none ]; then
  ASSERT=$(sed -n '/^DO \$assert\$/,/^END \$assert\$;/p' "$MIG")
  run $DB "CREATE TRIGGER trg_referral_reward_on_driver_approved AFTER UPDATE ON driver_profiles FOR EACH ROW
           EXECUTE FUNCTION trg_referral_reward_on_driver_approved();" >/dev/null
  out=$(run $DB "$ASSERT")
  case "$out" in *"still pays the driver-referral bonus on approval"*) ok "N1 the assertion catches a leftover approval trigger";;
       *) ko "N1 the assertion catches a leftover approval trigger" "got [$out]";; esac
  run $DB "DROP TRIGGER trg_referral_reward_on_driver_approved ON driver_profiles; DROP TRIGGER trg_referral_reward_on_driver_first_ride ON rides;" >/dev/null
  out=$(run $DB "$ASSERT")
  case "$out" in *"is missing on rides"*) ok "N2 the assertion catches a missing first-ride trigger";;
       *) ko "N2 the assertion catches a missing first-ride trigger" "got [$out]";; esac
fi

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
