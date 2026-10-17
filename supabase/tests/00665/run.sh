#!/usr/bin/env bash
# Rehearsal runner for migration 00665 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00665/run.sh none
#       -> scaffold (prod's live bodies) + tests (RED: the column and functions are missing)
#   supabase/tests/00665/run.sh supabase/migrations/00665_signup_code_promotion.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see the plan docs/superpowers/plans/2026-10-17-signup-code-promotion.md
# and CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00665/run.sh ...
# Another database name (two runs at once): PGDB=<name> ...  (the negative proofs use <name>n)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr665}"
NEG="${PGDB:-pr665}n"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANON=00000000-0000-0000-0000-000000000099
ANA=a0000000-0000-4000-8000-000000000001      # registered with MOTO, phone 5355500001
ANA2=a0000000-0000-4000-8000-000000000011     # ANA's phone on a new account, also MOTO
NOPH=a0000000-0000-4000-8000-000000000002     # MOTO, phone never confirmed
RIDER2=a0000000-0000-4000-8000-000000000006   # no signup code, phone 5355500006
CARA=c0000000-0000-4000-8000-000000000003     # SINPROMO (a code with no promotion), phone 5355500003
DIEGO=d0000000-0000-4000-8000-000000000004    # driver
EVA=e0000000-0000-4000-8000-000000000005      # platform admin, registered with MOTO
GINA=f0000000-0000-4000-8000-000000000008     # MOTO; her phone already used BIENVENIDA
MARK=f0000000-0000-4000-8000-000000000010     # marketing
DP_DIEGO=dd000000-0000-4000-8000-000000000004
DORA=f0000000-0000-4000-8000-000000000012     # a driver registered with MOTO (S6b)
DP_DORA=dd000000-0000-4000-8000-000000000012  # approved
DP_NOPH=dd000000-0000-4000-8000-000000000002  # NOPH's profile, still pending (S6b)
PROMO=f1000000-0000-4000-8000-000000000001    # BIENVENIDA, 25 %
P20=f1000000-0000-4000-8000-000000000002      # MOTO20, 20 %: the promotion linked to MOTO
CORP=c0000000-0000-4000-8000-0000000000c0
PICK="'POINT(-82.3666 23.1357)'"
DROP="'POINT(-82.3666 23.1384)'"
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002; R3=22222222-0000-4000-8000-000000000003

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# client USER SQL: SQL from USER's app session (role authenticated), then back to the test superuser with no JWT
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
# ride ID CUSTOMER [PROMO] [RIDE_MODE] [CORPORATE_ACCOUNT]
ride(){ local promo="NULL" mode="${4:-passenger}" corp="NULL"
  [ -n "${3:-}" ] && promo="'$3'"; [ -n "${5:-}" ] && corp="'$5'"
  echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, promo_code_id, ride_mode, corporate_account_id)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000, $promo, '$mode', $corp);"; }
state(){ echo "SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$1';"; }
complete(){ echo "UPDATE public.rides SET driver_id = '$2', status = 'completed' WHERE id = '$1';"; }
cancel(){ echo "UPDATE public.rides SET status = 'canceled' WHERE id = '$1';"; }
# del USER: what deleting the account does (00657); the phone's claim stays (00658)
del(){ echo "UPDATE public.promotion_uses SET user_id = '$ANON' WHERE user_id = '$1'; DELETE FROM auth.users WHERE id = '$1';"; }
# again USER PHONE: a new account confirms the phone of a deleted one
again(){ echo "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$1', '$2', now());"; }
link(){ echo "UPDATE public.acquisition_codes SET promotion_id = ${2:-NULL} WHERE code = '$1';"; }
MINE="SELECT code || '|' || type || '|' || coalesce(discount_percent::text, '-') || '|' || first_ride_only || '|' || signup_code FROM public.get_my_signup_promotion();"
COUNT_MINE="SELECT count(*) FROM public.get_my_signup_promotion();"
STATS="SELECT code || '|' || signups || '|' || coalesce(promotion_code, '-') || '|' || promo_rides FROM public.admin_signup_code_stats() ORDER BY code COLLATE \"C\";"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE proname IN ('_my_signup_promotion_id', 'tg_rides_signup_promo', 'get_my_signup_promotion', 'admin_signup_code_stats')"
LIVE="SELECT string_agg(proname || '=' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE proname IN ('uid', 'current_user_role', 'is_admin', 'is_super_admin', 'is_marketing', 'get_platform_config_numeric',
        'tg_rides_validate_promo_discount', 'tg_rides_rollback_promo_on_cancel', '_reward_identity_hash', '_reward_claim_status',
        '_claim_reward', 'admin_signup_code_stats', 'validate_promo_code')"
LIVE_MD5="_claim_reward=d9a8726c2f105908c0df7fe8c59b2982,_reward_claim_status=73d57eecb3631f0db8d1bc9d7a71fb30,_reward_identity_hash=4f1942d94b70a77d6b5007d776f5b425,admin_signup_code_stats=16a8ed1ebe03aa82f2f75676783a9099,current_user_role=cb4a7c12d4e21fe2997135833f141e25,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,is_admin=22cb75e91980d512498034cd33e1eda2,is_marketing=1903156b6a1218a543888ae2ebfb3656,is_super_admin=5655a4615e92e8b1e323d06c7566b058,tg_rides_rollback_promo_on_cancel=0fd8994f3d1dd121e5168ff58ab0fdbc,tg_rides_validate_promo_discount=cad4cf62d95e5055950b67564c6da7f4,uid=cdef18c69c4f4cbbced2eaf81e628b49,validate_promo_code=952805817a1ea73ab0fbb93f28884a30"

# fresh DB: a new database with the scaffold and the seed. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
         "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
           || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
         (cd "$DIR" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
           || { echo "-- scaffold.sql failed:"; cat "$FRESHLOG"; return 1; }
         "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$ANA', 'customer', 'Ana'), ('$ANA2', 'customer', 'Ana otra vez'), ('$NOPH', 'customer', U&'Sin tel\00E9fono'),
    ('$RIDER2', 'customer', 'Rider Two'), ('$CARA', 'customer', 'Cara'), ('$DIEGO', 'driver', 'Diego'),
    ('$EVA', 'admin', 'Eva'), ('$GINA', 'customer', 'Gina'), ('$MARK', 'marketing', 'Mark');
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$ANA', '5355500001', now()), ('$NOPH', '5355500099', NULL), ('$RIDER2', '5355500006', now()),
    ('$CARA', '5355500003', now()), ('$DIEGO', '5355500004', now()), ('$EVA', '5355500010', now()),
    ('$GINA', '5355500008', now()), ('$MARK', '5355500011', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO');
  INSERT INTO public.corporate_accounts (id, commission_percent) VALUES ('$CORP', 10);
  INSERT INTO public.promotions (id, code, type, discount_percent) VALUES
    ('$PROMO', 'BIENVENIDA', 'percentage_discount', 25), ('$P20', 'MOTO20', 'percentage_discount', 20);
  INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('MOTO', 'Motorenko', 'influencer'), ('SINPROMO', U&'Sin promoci\00F3n', 'otro');
  UPDATE public.users SET signup_code = 'MOTO' WHERE id IN ('$ANA', '$ANA2', '$NOPH', '$EVA', '$GINA');
  UPDATE public.users SET signup_code = 'SINPROMO' WHERE id = '$CARA';
  -- GINA's phone used BIENVENIDA before
  INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$PROMO', '$GINA');
  SELECT public._claim_reward('$GINA', 'promo:$PROMO');
  -- a SECURITY DEFINER function that creates a ride for the caller (recurring rides, support do this)
  CREATE FUNCTION public.test_definer_ride(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog' AS \$f\$
    INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
    VALUES (p_id, auth.uid(), 'auto_standard', 'POINT(-82.3666 23.1357)', 'POINT(-82.3666 23.1384)', 4000);
  \$f\$;
  ALTER FUNCTION public.test_definer_ride(uuid) OWNER TO tricigo_owner;
  GRANT EXECUTE ON FUNCTION public.test_definer_ride(uuid) TO authenticated;" >/dev/null 2>>"$FRESHLOG" \
           || { echo "-- the seed failed:"; cat "$FRESHLOG"; return 1; }; }
# the link exists only with the migration; without it this fails and the tests below are RED
link_moto(){ "$BIN/psql" $CONN -d "$1" -qAt -c "$(link MOTO "'$P20'")" >/dev/null 2>&1; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the scaffold carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  link_moto $DB   # set between the two runs: the second one must leave it alone
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "S1 one trigger and one link column after two runs, and the link survived the second" \
    "SELECT count(*) FROM pg_trigger WHERE tgname = 'rides_signup_promo'; SELECT count(*) FROM information_schema.columns WHERE table_name = 'acquisition_codes' AND column_name = 'promotion_id'; SELECT coalesce(promotion_id::text, 'none') FROM public.acquisition_codes WHERE code = 'MOTO';" "1;1;$P20"
else
  link_moto $DB   # RED: the column is missing, so this fails and the tests below are RED
fi

echo "== 1. the linked promotion is applied when a person creates a ride =="
USES="SELECT count(*) FROM public.promotion_uses WHERE promotion_id = '$P20';"
CLAIMED="SELECT count(*) FROM public.reward_claims WHERE claim = 'promo:$P20' AND released_at IS NULL;"
val "A1 a ride with no code gets the code's promotion" "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "$P20|800"
val "A2 ... and takes a use and the phone's claim" "$(tx "$(client $ANA "$(ride $R1 $ANA)") $USES $CLAIMED")" "1;1"
val "A3 a code the person typed wins" "$(tx "$(client $ANA "$(ride $R1 $ANA $PROMO)") $(state $R1)")" "$PROMO|1000"
val "A4 someone with no signup code gets nothing" "$(tx "$(client $RIDER2 "$(ride $R1 $RIDER2)") $(state $R1)")" "none|0"
val "A5 a code with no promotion gives nothing" "$(tx "$(client $CARA "$(ride $R1 $CARA)") $(state $R1)")" "none|0"
val "A6 a paused or pending promotion gives nothing, and the ride is created" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A7 a promotion that has not started gives nothing" \
  "$(tx "UPDATE public.promotions SET valid_from = now() + interval '1 day' WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A8 an expired promotion gives nothing" \
  "$(tx "UPDATE public.promotions SET valid_until = now() - interval '1 minute' WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A9 a promotion out of uses gives nothing" \
  "$(tx "UPDATE public.promotions SET max_uses = 0 WHERE id = '$P20'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
val "A10 a phone that already used the promotion gets nothing" \
  "$(tx "$(link MOTO "'$PROMO'") $(client $GINA "$(ride $R1 $GINA)") $(state $R1)")" "none|0"
val "A11 ... also from a new account after deleting the old one" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(del $ANA) $(again $ANA2 5355500001) $(client $ANA2 "$(ride $R2 $ANA2)") $(state $R2)")" "none|0"
val "A12 a first-ride-only promotion after a completed ride gives nothing" \
  "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$P20'; $(ride $R1 $ANA) $(complete $R1 $DP_DIEGO)
         $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "none|0"
val "A13 a delivery does not spend it" "$(tx "$(client $ANA "$(ride $R1 $ANA '' cargo)") $(state $R1)")" "none|0"
val "A14 a ride a company pays does not spend it" "$(tx "$(client $ANA "$(ride $R1 $ANA '' passenger $CORP)") $(state $R1)")" "none|0"
val "A15 an admin's own ride is left alone" "$(tx "$(client $EVA "$(ride $R1 $EVA)") $(state $R1)")" "none|0"
val "A16 a ride a SECURITY DEFINER function creates is left alone" \
  "$(tx "$(client $ANA "SELECT public.test_definer_ride('$R1');") $(state $R1)")" "none|0"
val "A17 a ride created with no JWT (cron, SQL) is left alone" "$(tx "$(ride $R1 $ANA) $(state $R1)")" "none|0"
val "A18 the link is read when the ride is created, not at signup" \
  "$(tx "$(link MOTO) $(client $ANA "$(ride $R1 $ANA)") $(state $R1) $(cancel $R1) $(link MOTO "'$P20'") $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "none|0;$P20|800"
val "A19 a canceled ride gives it back for the next one" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "$P20|800"
val "A20 a phone that was never confirmed gets nothing" "$(tx "$(client $NOPH "$(ride $R1 $NOPH)") $(state $R1)")" "none|0"
val "A21 deleting the promotion clears the link" \
  "$(tx "DELETE FROM public.promotions WHERE id = '$P20'; SELECT coalesce(promotion_id::text, 'none') FROM public.acquisition_codes WHERE code = 'MOTO';")" "none"
val "A22 a code closed to new signups still gives its promotion" \
  "$(tx "UPDATE public.acquisition_codes SET is_active = false WHERE code = 'MOTO'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "$P20|800"
val "A23 a use recorded before 00658 (no phone claim) still counts" \
  "$(tx "INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$P20', '$ANA'); $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "none|0"
# the lookup fails (here: the client lost EXECUTE on it): the ride is still created, without the promotion, and the trigger warns
r=$(run $DB "$(tx "REVOKE EXECUTE ON FUNCTION public._my_signup_promotion_id() FROM authenticated; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")")
if echo "$r" | grep -q "lookup failed" && [ "${r##*;}" = "none|0" ]; then ok "A24 a failed lookup leaves the ride, without the promotion"; else ko "A24 a failed lookup leaves the ride, without the promotion" "got [$r]"; fi
# a policy that lets anyone insert a ride for anyone (prod has none): the trigger still gives nothing to a ride that is not the caller's
val "A25 a ride created for someone else does not get the creator's promotion" \
  "$(tx "CREATE POLICY t_any_insert ON public.rides FOR INSERT TO authenticated WITH CHECK (true); $(client $GINA "$(ride $R1 $RIDER2)") $(state $R1)")" "none|0"

echo "== 2. get_my_signup_promotion() =="
val "M1 a person registered with the code sees the promotion" "$(tx "$(client $ANA "$MINE")")" "MOTO20|percentage_discount|20|false|MOTO"
val "M2 nothing without a signup code" "$(tx "$(client $RIDER2 "$COUNT_MINE")")" "0"
val "M3 nothing once it is used" "$(tx "$(client $ANA "$(ride $R1 $ANA) $COUNT_MINE")")" "0"
val "M4 nothing while the promotion is paused" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M5 nothing for a phone that already used it" "$(tx "$(link MOTO "'$PROMO'") $(client $GINA "$COUNT_MINE")")" "0"
val "M6 nothing for a first-ride-only promotion after a completed ride" \
  "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$P20'; $(ride $R1 $ANA) $(complete $R1 $DP_DIEGO) $(client $ANA "$COUNT_MINE")")" "0"
val "M7 nothing without a confirmed phone" "$(tx "$(client $NOPH "$COUNT_MINE")")" "0"
val "M8 nothing when it is out of uses" \
  "$(tx "UPDATE public.promotions SET max_uses = 0 WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M9 it shows again after a canceled ride" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$COUNT_MINE")")" "1"
err "M10 anon cannot call it" "BEGIN; SET LOCAL ROLE anon; SELECT * FROM public.get_my_signup_promotion(); ROLLBACK;" \
  "permission denied for function get_my_signup_promotion"
err "M11 ... nor the lookup the trigger uses" "BEGIN; SET LOCAL ROLE anon; SELECT public._my_signup_promotion_id(); ROLLBACK;" \
  "permission denied for function _my_signup_promotion_id"
val "M12 the lookup answers only for the caller" "$(tx "$(client $RIDER2 "SELECT coalesce(public._my_signup_promotion_id()::text, 'none');")")" "none"
# the same rules as the validator (A7, A8, A10, A11, A12, A22, A23)
val "M13 nothing before the promotion starts" \
  "$(tx "UPDATE public.promotions SET valid_from = now() + interval '1 day' WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M14 nothing once it expired" \
  "$(tx "UPDATE public.promotions SET valid_until = now() - interval '1 minute' WHERE id = '$P20'; $(client $ANA "$COUNT_MINE")")" "0"
val "M15 nothing for a new account on a phone that already used it" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(del $ANA) $(again $ANA2 5355500001) $(client $ANA2 "$COUNT_MINE")")" "0"
val "M16 nothing after a use recorded before 00658 (no phone claim)" \
  "$(tx "INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$P20', '$ANA'); $(client $ANA "$COUNT_MINE")")" "0"
val "M17 someone else's completed ride does not hide a first-ride promotion" \
  "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$P20'; $(ride $R1 $RIDER2) $(complete $R1 $DP_DIEGO) $(client $ANA "$COUNT_MINE")")" "1"
val "M18 a code closed to new signups still shows its promotion" \
  "$(tx "UPDATE public.acquisition_codes SET is_active = false WHERE code = 'MOTO'; $(client $ANA "$COUNT_MINE")")" "1"

echo "== 3. admin_signup_code_stats() =="
val "S2 an admin sees the promotion and the completed rides that used it" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(complete $R1 $DP_DIEGO) $(client $EVA "$STATS")")" "MOTO|5|MOTO20|1;SINPROMO|1|-|0"
val "S3 marketing sees it too" "$(tx "$(client $MARK "SELECT count(*) FROM public.admin_signup_code_stats();")")" "2"
err "S4 a passenger does not" "$(tx "$(client $ANA "SELECT count(*) FROM public.admin_signup_code_stats();")")" "Admin only"
val "S5 a use by someone who did not register with the code does not count" \
  "$(tx "$(client $RIDER2 "$(ride $R1 $RIDER2 $P20)") $(complete $R1 $DP_DIEGO) $(client $EVA "$STATS")")" "MOTO|5|MOTO20|0;SINPROMO|1|-|0"
val "S6 the twelve columns from before are unchanged" \
  "$(tx "$(client $EVA "SELECT code || '|' || label || '|' || channel || '|' || audience || '|' || is_active || '|' || rider_signups || '|' || driver_signups
           || '|' || drivers_approved || '|' || riders_with_ride || '|' || drivers_with_ride FROM public.admin_signup_code_stats() WHERE code = 'MOTO';")")" \
  "MOTO|Motorenko|influencer|ambos|true|5|0|0|0|0"
# S6 has zeros in half of its columns; this one has data in each, so a column that moved shows up
val "S6b the old columns, on data where none of them is 0" \
  "$(tx "INSERT INTO public.users (id, role, full_name, signup_code) VALUES ('$DORA', 'driver', 'Dora', 'MOTO');
         INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$DP_DORA', '$DORA', 'approved'), ('$DP_NOPH', '$NOPH', 'pending');
         $(ride $R1 $ANA) $(complete $R1 $DP_DORA)
         $(client $EVA "SELECT code || '|' || signups || '|' || rider_signups || '|' || driver_signups || '|' || drivers_approved || '|' || riders_with_ride || '|' || drivers_with_ride FROM public.admin_signup_code_stats() WHERE code = 'MOTO';")")" \
  "MOTO|6|4|2|1|1|1"
val "S7 the panel can preselect the linked promotion" \
  "$(tx "$(client $EVA "SELECT promotion_id FROM public.admin_signup_code_stats() WHERE code = 'MOTO';")")" "$P20"
val "S8 promo_rides counts completed rides with the linked promotion, by people registered with the code" \
  "$(tx "$(client $ANA "$(ride $R1 $ANA)") $(complete $R1 $DP_DIEGO) $(client $GINA "$(ride $R2 $GINA)") $(ride $R3 $NOPH) $(complete $R3 $DP_DIEGO) $(client $EVA "$STATS")")" \
  "MOTO|5|MOTO20|1;SINPROMO|1|-|0"
val "S9 rows come most signups first" \
  "$(tx "$(client $EVA "SELECT string_agg(t.code, ',' ORDER BY t.ordinality) FROM public.admin_signup_code_stats() WITH ORDINALITY t;")")" "MOTO,SINPROMO"

echo "== 4. permissions and shape =="
val "G1 the trigger function is SECURITY INVOKER" "SELECT prosecdef FROM pg_proc WHERE proname = 'tg_rides_signup_promo';" "f"
val "G2 anon calls none of the three" \
  "SELECT has_function_privilege('anon', 'public.get_my_signup_promotion()', 'EXECUTE') || '|' || has_function_privilege('anon', 'public._my_signup_promotion_id()', 'EXECUTE')
       || '|' || has_function_privilege('anon', 'public.admin_signup_code_stats()', 'EXECUTE');" "false|false|false"
val "G3 authenticated calls the three" \
  "SELECT has_function_privilege('authenticated', 'public.get_my_signup_promotion()', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public._my_signup_promotion_id()', 'EXECUTE')
       || '|' || has_function_privilege('authenticated', 'public.admin_signup_code_stats()', 'EXECUTE');" "true|true|true"
val "G4 BEFORE INSERT row triggers fire in this order" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal AND (tgtype & 7) = 7;" \
  "rides_signup_promo,rides_validate_promo_discount"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  # a fresh negative-proof database (the proofs are worthless on a half-built one)
  fresh_neg(){ fresh $NEG || { echo "negative-proof database failed"; exit 1; }; }
  body_md5(){ run "$1" "SELECT md5(prosrc) FROM pg_proc WHERE proname = '$2'"; }
  # mutant FILE SED-SCRIPT: FILE is a copy of the migration with one sed edit; returns 1 when the edit changed nothing
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  # neg_mutant ID LABEL SED-SCRIPT WANT: a fresh database, the migration with one edit; it has to abort with WANT
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    if echo "$r" | grep -q "$want"; then ok "$id $label"; else ko "$id $label" "expected an abort like [$want], got [$r]"; fi; }

  fresh_neg
  b=$(body_md5 $NEG tg_rides_validate_promo_discount)
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure),
            E'  RETURN NEW;\nEND;', E'  RETURN NEW; -- local edit\nEND;'); END \$x\$;" >/dev/null
  if [ "$(body_md5 $NEG tg_rides_validate_promo_discount)" = "$b" ]; then ko "N1 a validator body it does not know aborts it" "setup did not change the body"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "tg_rides_validate_promo_discount() is not the body read from prod" \
      && ok "N1 a validator body it does not know aborts it" || ko "N1 a validator body it does not know aborts it" "got [$r]"
  fi
  fresh_neg
  b=$(body_md5 $NEG admin_signup_code_stats)
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.admin_signup_code_stats()'::regprocedure),
            'ORDER BY count(u.id) DESC', 'ORDER BY count(u.id) ASC'); END \$x\$;" >/dev/null
  if [ "$(body_md5 $NEG admin_signup_code_stats)" = "$b" ]; then ko "N2 a stats body it does not know aborts it" "setup did not change the body"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "admin_signup_code_stats() is not the body read from prod" \
      && ok "N2 a stats body it does not know aborts it" || ko "N2 a stats body it does not know aborts it" "got [$r]"
  fi
  fresh_neg
  run $NEG "ALTER TRIGGER rides_validate_promo_discount ON public.rides RENAME TO rides_a_validate_promo_discount;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "has to fire before the promo validator" \
    && ok "N3 a validator that would fire first aborts it" || ko "N3" "got [$r]"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N4 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N4" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  # the self-checks at the end of the migration, each seen to fire
  fresh_neg
  run $NEG "ALTER TABLE public.acquisition_codes ADD COLUMN promotion_id uuid;" >/dev/null
  if [ "$(run $NEG "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'acquisition_codes' AND column_name = 'promotion_id')
                    || '|' || (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.acquisition_codes'::regclass AND contype = 'f' AND confrelid = 'public.promotions'::regclass)")" != "1|0" ]; then
    ko "N5 a link column with no ON DELETE SET NULL key aborts it" "setup did not leave a column without its key"
  else
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "has to reference promotions ON DELETE SET NULL" \
      && ok "N5 a link column with no ON DELETE SET NULL key aborts it" || ko "N5 a link column with no ON DELETE SET NULL key aborts it" "got [$r]"
  fi
  neg_mutant N6 "a SECURITY DEFINER trigger function aborts it" \
    '/^ RETURNS trigger$/{n;s/^ LANGUAGE plpgsql$/ LANGUAGE plpgsql SECURITY DEFINER/;}' "must be SECURITY INVOKER"
  neg_mutant N7 "anon keeping EXECUTE on get_my_signup_promotion aborts it" \
    's/^REVOKE ALL ON FUNCTION public.get_my_signup_promotion() FROM PUBLIC, anon;$/REVOKE ALL ON FUNCTION public.get_my_signup_promotion() FROM PUBLIC;/' \
    "anon can call a function it must not"
  neg_mutant N8 "a stats function without the marketing gate aborts it" \
    '/IF NOT (public.is_admin() OR public.is_marketing()) THEN/s/ OR public.is_marketing()//' "lost its admin-or-marketing gate"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00665 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE proname IN ('_my_signup_promotion_id', 'tg_rides_signup_promo', 'get_my_signup_promotion', 'admin_signup_code_stats')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
