#!/usr/bin/env bash
# Rehearsal runner for migration 00631 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00631/run.sh none
#       -> scaffold (prod's bodies of the four functions, their triggers, referrals) + tests (RED)
#   supabase/tests/00631/run.sh supabase/migrations/00631_free_money_guards.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Needs PostGIS for Postgres 16 (Ubuntu: apt-get install postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00631/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr631
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001     # customer
RIDER2=a0000000-0000-4000-8000-000000000002    # customer
BETO=b0000000-0000-4000-8000-000000000002      # customer who refers, and also drives (DP_BETO)
CARA=c0000000-0000-4000-8000-000000000003      # referred by BETO
CIRO=c0000000-0000-4000-8000-000000000006      # referred by BETO
DIEGO=d0000000-0000-4000-8000-000000000004     # driver (DP_DIEGO), no referral ties
EVA=e0000000-0000-4000-8000-000000000005       # platform admin
DP_BETO=db000000-0000-4000-8000-000000000002
DP_DIEGO=dd000000-0000-4000-8000-000000000004
PROMO=f1000000-0000-4000-8000-000000000001     # SUPERFLA, 25 %
RIDE=11111111-0000-4000-8000-000000000001
PICK="ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography"
D300="ST_SetSRID(ST_MakePoint(-82.3666, 23.1384), 4326)::geography"     # ~300 m north
D301="ST_SetSRID(ST_MakePoint(-82.3667, 23.1384), 4326)::geography"
D20K="ST_SetSRID(ST_MakePoint(-82.3666, 23.3157), 4326)::geography"     # ~20 km north

# ride CUSTOMER FARE [SURGE] [DROPOFF] [PROMO|NULL] [SERVICE] -> INSERT ... RETURNING estimated_fare_cup || '|' || surge
ride(){ local promo="NULL"; [ "${5:-NULL}" != NULL ] && promo="'$5'"
  echo "INSERT INTO public.rides (customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, surge_multiplier, promo_code_id)
        VALUES ('$1', '${6:-auto_standard}', $PICK, ${4:-$D300}, $2, ${3:-1}, $promo)
        RETURNING estimated_fare_cup || '|' || surge_multiplier::float8;"; }
tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# as UID SQL -> SQL as authenticated with JWT subject UID, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
# ceiling SERVICE BASE PERKM PERMIN MINFARE DROPOFF -> the 00631 formula, written out independently
ceiling(){ echo "SELECT ceil(GREATEST($5, $2 + $3 * (ST_Distance($PICK, $6) / 1000.0 * 4 + 5)
                                     + $4 * (ST_Distance($PICK, $6) / 1000.0 * 4 + 5) * 6) * 1.5)::int"; }
complete(){ echo "UPDATE public.rides SET driver_id = '$2', status = 'completed' WHERE id = '$1';"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER', 'customer', 'Rider'), ('$RIDER2', 'customer', 'Rider Two'), ('$BETO', 'customer', 'Beto'),
    ('$CARA', 'customer', 'Cara'), ('$CIRO', 'customer', 'Ciro'), ('$DIEGO', 'driver', 'Diego'), ('$EVA', 'admin', 'Eva');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_BETO', '$BETO'), ('$DP_DIEGO', '$DIEGO');
  INSERT INTO public.promotions (id, code, type, discount_percent) VALUES ('$PROMO', 'SUPERFLA', 'percentage_discount', 25);
  INSERT INTO public.referral_codes (user_id, code) VALUES ('$BETO', 'BETO1');" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
bodies(){ echo "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN
  ('tg_rides_validate_estimated_fare', 'tg_rides_validate_promo_discount', 'trg_referral_reward_on_complete', 'admin_send_gift')"; }
OLD_MD5="2654fff52873011b822f4d44db72ef7d,4dda5399794d28088b3537488516073d,ae9f33f11fe3b6a3cd0f118e3bf7a0c4,7f5dcb0663accaf345f2e16374a0545c"
NEW_MD5="8aac30f1c704121c8f7152b2f310f7ec,bd038e5d88e99e3377b5d8787d8f68b1,b70dc359fccf82f5d5b3209ca03e9816,2f0a51cac7603e1c7bda7228e06e97f6"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" = "none" ]; then
  val "S0 the scaffold carries prod's bodies of the four functions" "$(bodies)" "$OLD_MD5"
fi

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "S1 the four bodies are the 00631 ones" "$(bodies)" "$NEW_MD5"
fi

CEIL300=$(run $DB "$(ceiling auto_standard 599 947 77 3288 "$D300")")
CEIL300M=$(run $DB "$(ceiling mensajeria 453 300 30 2038 "$D300")")
echo "   (ceiling for 300 m: auto_standard $CEIL300, mensajeria $CEIL300M)"

echo "== 1. fare ceiling and surge at ride creation =="
val "C1 an honest 300 m fare is accepted" "$(as $RIDER "$(ride $RIDER 5000)")" "5000|1"
err "C2 a rider cannot ask a 300 m ride at 1,000,000" "$(as $RIDER "$(ride $RIDER 1000000)")" "fare_above_ceiling"
err "C3 the rejection names its cause and speaks Spanish" "$(as $RIDER "$(ride $RIDER 1000000)")" "No pudimos confirmar el precio"
val "C4 exactly the ceiling is accepted (inactive bands do not count)" "$(as $RIDER "$(ride $RIDER $CEIL300)")" "$CEIL300|1"
err "C5 one peso over the ceiling is not" "$(as $RIDER "$(ride $RIDER $((CEIL300+1)))")" "fare_above_ceiling"
val "C6 a declared surge of 10 is stored as 3" "$(as $RIDER "$(ride $RIDER 5000 10)")" "5000|3"
val "C7 a declared surge of 0.5 is stored as 1" "$(as $RIDER "$(ride $RIDER 5000 0.5)")" "5000|1"
val "C8 a real surge widens the ceiling" "$(as $RIDER "$(ride $RIDER $((CEIL300*19/10)) 2)")" "$((CEIL300*19/10))|2"
val "C9 an honest 20 km fare is accepted" "$(as $RIDER "$(ride $RIDER 40000 1 "$D20K")")" "40000|1"
val "C10 a service without pricing rules uses its config (at the ceiling)" \
  "$(as $RIDER "$(ride $RIDER $CEIL300M 1 "$D300" NULL mensajeria)")" "$CEIL300M|1"
err "C11 ... and rejects one peso over it" "$(as $RIDER "$(ride $RIDER $((CEIL300M+1)) 1 "$D300" NULL mensajeria)")" "fare_above_ceiling"
err "C12 the floor is unchanged" "$(as $RIDER "$(ride $RIDER 100)")" "below the minimum fare"
val "C13 an admin is not capped (fare and surge kept)" "$(as $EVA "$(ride $EVA 1000000 10)")" "1000000|10"
val "C14 the service role is not capped" "$(tx "$(ride $RIDER 1000000 10)")" "1000000|10"

echo "== 2. the promo is fixed when the ride is created =="
PROMO_RIDE="INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, promo_code_id)
            VALUES ('$RIDE', '$RIDER', 'auto_standard', $PICK, $D300, 4000, '$PROMO');"
PLAIN_RIDE="INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
            VALUES ('$RIDE', '$RIDER2', 'auto_standard', $PICK, $D300, 4000);"
STATE="SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$RIDE';"
USES="RESET ROLE; SELECT count(*) || '|' || (SELECT current_uses FROM public.promotions WHERE id = '$PROMO') FROM public.promotion_uses;"
val "P1 a promo asked at creation is applied and claimed once" "$(as $RIDER "$PROMO_RIDE $STATE $USES")" "$PROMO|1000;1|1"
val "P2 a rider cannot add a promo to a ride already created" \
  "$(as $RIDER2 "$PLAIN_RIDE UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$RIDE'; $STATE $USES")" "none|0;0|0"
val "P3 ... nor drop the one it has" \
  "$(as $RIDER "$PROMO_RIDE UPDATE public.rides SET promo_code_id = NULL WHERE id = '$RIDE'; $STATE")" "$PROMO|1000"
val "P4 an admin still can attach one" \
  "$(tx "$PLAIN_RIDE SET LOCAL request.jwt.claim.sub = '$EVA'; SET LOCAL ROLE authenticated;
         UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$RIDE'; $STATE")" "$PROMO|1000"
val "P5 deleting the promotion still clears it from a ride in flight" \
  "$(tx "$PROMO_RIDE DELETE FROM public.promotions WHERE id = '$PROMO'; $STATE")" "none|0"

echo "== 3. a client recompute never raises the promo =="
SNAP(){ echo "UPDATE public.ride_pricing_snapshots SET pre_waypoints_total = coalesce(pre_waypoints_total, total), total = $1 WHERE ride_id = '$RIDE';"; }
REFIRE="UPDATE public.rides SET dropoff_location = $D301 WHERE id = '$RIDE';"
val "W1 a recompute after a far stop keeps the promo of the ride's own fare" \
  "$(tx "$PROMO_RIDE $(SNAP 400000) SET LOCAL request.jwt.claim.sub = '$RIDER'; SET LOCAL ROLE authenticated; $REFIRE $STATE")" "$PROMO|1000"
val "W2 a recompute on a smaller fare lowers it" \
  "$(tx "$PROMO_RIDE $(SNAP 2000) SET LOCAL request.jwt.claim.sub = '$RIDER'; SET LOCAL ROLE authenticated; $REFIRE $STATE")" "$PROMO|500"
val "W3 a type change from support (00628's flag) recomputes freely" \
  "$(tx "$PROMO_RIDE $(SNAP 8000) SET LOCAL request.jwt.claim.sub = '$RIDER'; SET LOCAL ROLE authenticated;
         SET LOCAL app.force_discount_recompute = '1'; $REFIRE $STATE")" "$PROMO|2000"
val "W4 so does an admin" \
  "$(tx "$PROMO_RIDE $(SNAP 8000) SET LOCAL request.jwt.claim.sub = '$EVA'; SET LOCAL ROLE authenticated; $REFIRE $STATE")" "$PROMO|2000"

echo "== 4. the rider referral does not pay for rides between the two =="
REF="INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$CARA', 'BETO1');"
RIDE_OF(){ echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
                VALUES ('$1', '$2', 'auto_standard', $PICK, $D300, 4000);"; }
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002
REWARD="SELECT r.status || '|' || coalesce((SELECT balance FROM public.wallet_accounts WHERE user_id = '$BETO' AND account_type = 'customer_cash'), 0)
        FROM public.referrals r WHERE r.referee_id = '$CARA';"
val "R1 a first ride driven by the referrer pays nothing" \
  "$(tx "$REF $(RIDE_OF $R1 $CARA) $(complete $R1 $DP_BETO) $REWARD")" "pending|0"
val "R2 ... and the referee's next ride with another driver pays" \
  "$(tx "$REF $(RIDE_OF $R1 $CARA) $(complete $R1 $DP_BETO) $(RIDE_OF $R2 $CARA) $(complete $R2 $DP_DIEGO) $REWARD")" "rewarded|500"
val "R3 a first ride with another driver pays at once" \
  "$(tx "$REF $(RIDE_OF $R1 $CARA) $(complete $R1 $DP_DIEGO) $REWARD")" "rewarded|500"
val "R4 only the first qualifying ride pays" \
  "$(tx "$REF $(RIDE_OF $R1 $CARA) $(complete $R1 $DP_DIEGO) $(RIDE_OF $R2 $CARA) $(complete $R2 $DP_DIEGO)
         SELECT count(*) FROM public.ledger_transactions WHERE idempotency_key LIKE 'referral_bonus:%';")" "1"

echo "== 5. an admin cannot gift themselves =="
GIFT(){ echo "SELECT public.admin_send_gift('$1', 100, 'prueba', '$EVA') IS NOT NULL;"; }
err "G1 an admin cannot gift their own wallet" "$(as $EVA "$(GIFT $EVA)")" "gift_to_self"
val "G2 an admin can gift a rider" \
  "$(as $EVA "$(GIFT $RIDER) RESET ROLE; SELECT balance FROM public.wallet_accounts WHERE user_id = '$RIDER' AND account_type = 'customer_cash';")" "t;100"
err "G3 a rider cannot gift at all" "$(as $RIDER "SELECT public.admin_send_gift('$RIDER', 100, 'prueba', '$RIDER');")" "admin role required"

echo "== 6. referrals are written only by their functions =="
err "F1 a rider cannot insert a referral row directly" \
  "$(as $CIRO "INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$CIRO', 'X') RETURNING 'ok';")" "permission denied"
val "F2 apply_referral_code still works, and the rider sees the row" \
  "$(as $CIRO "SELECT public.apply_referral_code('beto1') IS NOT NULL; SELECT code || '|' || status FROM public.referrals;")" "t;BETO1|pending"
val "F3 authenticated keeps no write privilege on referrals" \
  "SELECT has_table_privilege('authenticated', 'public.referrals', 'INSERT, UPDATE, DELETE, TRUNCATE')
       || '|' || has_table_privilege('anon', 'public.referrals', 'INSERT, UPDATE, DELETE, TRUNCATE')
       || '|' || has_table_privilege('authenticated', 'public.referrals', 'SELECT')" "false|false|true"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  NEG=pr631n
  fresh $NEG
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure),
            E'  RETURN NEW;\nEND;', E'  RETURN NEW; -- local edit\nEND;'); END \$x\$;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "unexpected body of tg_rides_validate_promo_discount" \
    && ok "N1 a body it does not know is not replaced" || ko "N1" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; CREATE POLICY ref_update ON public.referrals FOR UPDATE USING (true);" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "referrals still has a write policy" \
    && ok "N2 a leftover write policy on referrals aborts it" || ko "N2" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; GRANT INSERT ON public.referrals TO PUBLIC;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "can still write referrals" \
    && ok "N3 a write grant through PUBLIC aborts it" || ko "N3" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; ALTER TABLE public.rides DISABLE TRIGGER trg_rides_validate_estimated_fare;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "missing or disabled" \
    && ok "N4 a disabled ceiling trigger aborts it" || ko "N4" "got [$r]"
  fresh $NEG
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$(bodies)")" = "$NEW_MD5" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N5 pasted with CRLF line ends, the bodies still match git"
  else ko "N5" "apply [$r], bodies [$(run $NEG "$(bodies)")]"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
