#!/usr/bin/env bash
# Rehearsal runner for migration 00658 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00658/run.sh none
#       -> scaffold (prod's live bodies) + tests (RED: the same phone cobra twice)
#   supabase/tests/00658/run.sh supabase/migrations/00658_rewards_once_per_phone.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Needs PostGIS for Postgres 16 (Ubuntu: apt-get install postgresql-16-postgis-3).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00658/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr658
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANON=00000000-0000-0000-0000-000000000099
ANA=a0000000-0000-4000-8000-000000000001      # rider, phone 5355500001
ANA2=a0000000-0000-4000-8000-000000000011     # ANA signed up again, same phone
NOPH=a0000000-0000-4000-8000-000000000002     # rider whose phone was never confirmed
RIDER2=a0000000-0000-4000-8000-000000000006   # rider, phone 5355500006
BETO=b0000000-0000-4000-8000-000000000002     # referrer, phone 5355500002
CARA=c0000000-0000-4000-8000-000000000003     # referee rider, phone 5355500003
CARA2=c0000000-0000-4000-8000-000000000013    # CARA signed up again, same phone
DANI=d0000000-0000-4000-8000-000000000005     # referee driver, phone 5355500005
DANI2=d0000000-0000-4000-8000-000000000015    # DANI signed up again, same phone
DIEGO=d0000000-0000-4000-8000-000000000004    # driver, no referral ties
EVA=e0000000-0000-4000-8000-000000000005      # platform admin
FEDE=f0000000-0000-4000-8000-000000000007     # referee paid BEFORE the migration
GINA=f0000000-0000-4000-8000-000000000008     # used the promo BEFORE the migration
HUGO=f0000000-0000-4000-8000-000000000009     # referee with a phone, paid by an admin
DP_DIEGO=dd000000-0000-4000-8000-000000000004
DP_DANI=dd000000-0000-4000-8000-000000000005
DP_DANI2=dd000000-0000-4000-8000-000000000015
PROMO=f1000000-0000-4000-8000-000000000001    # BIENVENIDA, 25 %
PICK="ST_SetSRID(ST_MakePoint(-82.3666, 23.1357), 4326)::geography"
DROP="ST_SetSRID(ST_MakePoint(-82.3666, 23.1384), 4326)::geography"
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002
R3=22222222-0000-4000-8000-000000000003

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
# ride ID CUSTOMER [PROMO]
ride(){ local promo="NULL"; [ -n "${3:-}" ] && promo="'$3'"
  echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, promo_code_id)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000, $promo);"; }
state(){ echo "SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$1';"; }
complete(){ echo "UPDATE public.rides SET driver_id = '$2', status = 'completed' WHERE id = '$1';"; }
cancel(){ echo "UPDATE public.rides SET status = 'canceled' WHERE id = '$1';"; }
# del USER: what deleting the account does to these rows (00657), and the phone is free again
del(){ echo "UPDATE public.promotion_uses SET user_id = '$ANON' WHERE user_id = '$1';
             UPDATE public.referrals SET referee_id = '$ANON' WHERE referee_id = '$1';
             DELETE FROM auth.users WHERE id = '$1';"; }
# again NEW PHONE [DRIVER_PROFILE]: a new account confirms the phone of a deleted one
again(){ local dp=""; [ -n "${3:-}" ] && dp="INSERT INTO public.driver_profiles (id, user_id) VALUES ('$3', '$1');"
  echo "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$1', '$2', now()); $dp"; }
validate(){ echo "SELECT (public.validate_promo_code('bienvenida', '$1', 4000))->>coalesce(nullif('${2:-}', ''), 'error');"; }
balance(){ echo "SELECT coalesce((SELECT balance FROM public.wallet_accounts WHERE user_id = '$1' AND account_type = '${2:-customer_cash}'), 0);"; }
ref_state(){ echo "SELECT status FROM public.referrals WHERE referee_id = '$1';"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$ANA', 'customer', 'Ana'), ('$ANA2', 'customer', 'Ana otra vez'), ('$NOPH', 'customer', 'Sin teléfono'),
    ('$RIDER2', 'customer', 'Rider Two'), ('$BETO', 'customer', 'Beto'), ('$CARA', 'customer', 'Cara'),
    ('$CARA2', 'customer', 'Cara otra vez'), ('$DANI', 'driver', 'Dani'), ('$DANI2', 'driver', 'Dani otra vez'),
    ('$DIEGO', 'driver', 'Diego'), ('$EVA', 'admin', 'Eva'), ('$FEDE', 'customer', 'Fede'),
    ('$GINA', 'customer', 'Gina'), ('$HUGO', 'customer', 'Hugo');
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$ANA', '5355500001', now()), ('$NOPH', '5355500099', NULL), ('$RIDER2', '5355500006', now()),
    ('$BETO', '5355500002', now()), ('$CARA', '5355500003', now()), ('$DANI', '5355500005', now()),
    ('$DIEGO', '5355500004', now()), ('$EVA', '5355500010', now()), ('$FEDE', '5355500007', now()),
    ('$GINA', '5355500008', now()), ('$HUGO', '5355500009', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO'), ('$DP_DANI', '$DANI');
  INSERT INTO public.promotions (id, code, type, discount_percent) VALUES ('$PROMO', 'BIENVENIDA', 'percentage_discount', 25);
  INSERT INTO public.referral_codes (user_id, code) VALUES ('$BETO', 'BETO1');
  -- paid and used before the migration (the backfill claims them)
  INSERT INTO public.referrals (referrer_id, referee_id, code, status, rewarded_at) VALUES ('$BETO', '$FEDE', 'BETO1', 'rewarded', now() - interval '1 day');
  INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$PROMO', '$GINA');" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
FNS="('tg_rides_validate_promo_discount', 'tg_rides_rollback_promo_on_cancel', 'validate_promo_code', 'apply_referral_code',
      'trg_referral_reward_on_complete', 'trg_referral_reward_on_driver_first_ride', 'trg_referral_reward_on_driver_approved',
      'admin_reward_referral')"
HELPERS="SELECT string_agg(md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('_reward_identity_hash', '_reward_claim_status', '_claim_reward')"
HELPERS_MD5="d9a8726c2f105908c0df7fe8c59b2982,73d57eecb3631f0db8d1bc9d7a71fb30,4f1942d94b70a77d6b5007d776f5b425"
bodies(){ echo "SELECT string_agg(md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname) FROM pg_proc WHERE proname IN $FNS"; }
OLD_MD5="1e241e471b6225c45c592a45f251e5a2,5090797ad15e4ac76b82961849f241e5,02515bc12de7afbc36f60e709daa18ba,b70dc359fccf82f5d5b3209ca03e9816,2f0a51cac7603e1c7bda7228e06e97f6,18ba26bd32bd10f5f9ce43aab8cb9849,66be7c5cfe89ea9f2df27f405b6147b7,ed42f3a7a8be2e7367f38f0da2f5ca79"
NEW_MD5="0d9b9f8b7fb753465290e281091a03da,51e1c19964c02c7a5b054d8f3b222f16,0fd8994f3d1dd121e5168ff58ab0fdbc,cad4cf62d95e5055950b67564c6da7f4,20d16698a937f65b06fb304f8741be8b,3bc3a0dae8246b17284d19908a615acb,d26ecb59805e46327b893a17f5c488a8,952805817a1ea73ab0fbb93f28884a30"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" = "none" ]; then
  val "S0 the scaffold carries prod's live bodies" "$(bodies)" "$OLD_MD5"
fi

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "S1 the eight bodies are the 00658 ones" "$(bodies)" "$NEW_MD5"
  val "S2 the second run did not change the salt or add claims" \
    "SELECT count(*) FROM public.reward_identity_salt; SELECT count(*) FROM public.reward_claims;" "1;2"
fi

echo "== 1. a promo is used once per phone =="
CLAIMS="SELECT count(*) FILTER (WHERE released_at IS NULL) || '|' || count(*) FROM public.reward_claims WHERE claim = 'promo:$PROMO';"
val "P1 a rider with a confirmed phone gets the promo" "$(tx "$(ride $R1 $ANA $PROMO) $(state $R1)")" "$PROMO|1000"
val "P2 ... and the phone holds it (GINA's, from before, too)" "$(tx "$(ride $R1 $ANA $PROMO) $CLAIMS")" "2|2"
val "P3 the same phone on a new account does not get it again" \
  "$(tx "$(ride $R1 $ANA $PROMO) $(del $ANA) $(again $ANA2 5355500001) $(ride $R2 $ANA2 $PROMO) $(state $R2)")" "none|0"
val "P4 ... and validate_promo_code says so before the ride" \
  "$(tx "$(ride $R1 $ANA $PROMO) $(del $ANA) $(again $ANA2 5355500001)
         SET LOCAL request.jwt.claim.sub = '$ANA2'; SET LOCAL ROLE authenticated; $(validate $ANA2)")" "already_used"
val "P5 a rider without a confirmed phone does not get it" "$(tx "$(ride $R1 $NOPH $PROMO) $(state $R1)")" "none|0"
val "P6 ... and validate_promo_code asks for the phone" \
  "$(as $NOPH "$(validate $NOPH)")" "phone_required"
val "P7 a canceled ride gives the phone its promo back" \
  "$(tx "$(ride $R1 $ANA $PROMO) $(cancel $R1) $(del $ANA) $(again $ANA2 5355500001) $(ride $R2 $ANA2 $PROMO) $(state $R2)")" "$PROMO|1000"
val "P8 ... and to the same account" \
  "$(tx "$(ride $R1 $ANA $PROMO) $(cancel $R1) $(ride $R2 $ANA $PROMO) $(state $R2)")" "$PROMO|1000"
val "P9 a promo out of uses leaves the phone's claim free" \
  "$(tx "UPDATE public.promotions SET max_uses = 0 WHERE id = '$PROMO'; $(ride $R1 $ANA $PROMO) $(state $R1)
         UPDATE public.promotions SET max_uses = NULL WHERE id = '$PROMO'; $(ride $R2 $ANA $PROMO) $(state $R2)")" "none|0;$PROMO|1000"
val "P10 another phone is not affected" \
  "$(tx "$(ride $R1 $ANA $PROMO) $(ride $R2 $RIDER2 $PROMO) $(state $R2)")" "$PROMO|1000"
val "P11 the valid answer is unchanged for a fresh phone" "$(as $RIDER2 "$(validate $RIDER2 valid)")" "true"

echo "== 2. a phone is paid for as a referee once =="
APPLY(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated; SELECT public.apply_referral_code('beto1') IS NOT NULL; RESET ROLE;"; }
PAID_CARA="$(APPLY $CARA) $(ride $R1 $CARA) $(complete $R1 $DP_DIEGO)"
val "R1 the first referral of a phone pays" "$(tx "$PAID_CARA $(ref_state $CARA) $(balance $BETO)")" "t;rewarded;500"
err "R2 the same phone on a new account cannot apply a code again" \
  "$(tx "$PAID_CARA $(del $CARA) $(again $CARA2 5355500003) $(APPLY $CARA2)")" "Ya usaste un codigo de referido"
val "R3 a pending referral of that phone (from before) pays nothing" \
  "$(tx "$PAID_CARA $(del $CARA) $(again $CARA2 5355500003)
         INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$CARA2', 'BETO1');
         $(ride $R2 $CARA2) $(complete $R2 $DP_DIEGO) $(ref_state $CARA2) $(balance $BETO)")" "t;pending;500"
err "R4 an account without a confirmed phone cannot apply a code" "$(tx "$(APPLY $NOPH)")" "Confirma tu teléfono"
err "R5 ... with its own error code" "$(tx "$(APPLY $NOPH)")" "P0004"
val "R6 a referred driver's first ride pays" \
  "$(tx "$(APPLY $DANI) $(ride $R1 $RIDER2) $(complete $R1 $DP_DANI) $(ref_state $DANI) $(balance $BETO)")" "t;rewarded;500"
val "R7 ... and the same phone as a new driver does not pay again" \
  "$(tx "$(APPLY $DANI) $(ride $R1 $RIDER2) $(complete $R1 $DP_DANI) $(del $DANI) $(again $DANI2 5355500005 $DP_DANI2)
         INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$DANI2', 'BETO1');
         $(ride $R2 $RIDER2) $(complete $R2 $DP_DANI2) $(ref_state $DANI2) $(balance $BETO)")" "t;pending;500"
val "R8 a reward that fails gives the phone's claim back" \
  "$(tx "SET LOCAL client_min_messages = error; $(APPLY $CARA) ALTER TABLE public.ledger_entries ADD CONSTRAINT boom CHECK (false) NOT VALID;
         $(ride $R1 $CARA) $(complete $R1 $DP_DIEGO) $(ref_state $CARA)
         SELECT count(*) FROM public.reward_claims WHERE referral_id IS NOT NULL AND user_id = '$CARA';")" "t;pending;0"
ADMIN_PAY(){ echo "SET LOCAL request.jwt.claim.sub = '$EVA'; SET LOCAL ROLE authenticated;
                   SELECT public.admin_reward_referral(id) FROM public.referrals WHERE referee_id = '$1'; RESET ROLE;"; }
err "R9 an admin cannot pay a phone that was already paid for" \
  "$(tx "$PAID_CARA $(del $CARA) $(again $CARA2 5355500003)
         INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$CARA2', 'BETO1');
         $(ADMIN_PAY $CARA2)")" "referral_phone_already_rewarded"
val "R10 an admin pays a fresh phone and the phone holds it" \
  "$(tx "INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$HUGO', 'BETO1');
         $(ADMIN_PAY $HUGO) $(ref_state $HUGO)
         SELECT count(*) FROM public.reward_claims WHERE claim = 'referral_referee' AND user_id = '$HUGO';")" "rewarded;1"
val "R11 an admin can still pay a referee without a confirmed phone" \
  "$(tx "INSERT INTO public.referrals (referrer_id, referee_id, code) VALUES ('$BETO', '$NOPH', 'BETO1');
         $(ADMIN_PAY $NOPH) $(ref_state $NOPH)")" "rewarded"

echo "== 3. what was paid or used before the migration =="
val "B1 the referee paid before is claimed by the phone" \
  "SELECT count(*) FROM public.reward_claims WHERE claim = 'referral_referee' AND user_id = '$FEDE' AND released_at IS NULL;" "1"
val "B2 the promo used before is claimed by the phone" \
  "SELECT count(*) FROM public.reward_claims WHERE claim = 'promo:$PROMO' AND user_id = '$GINA' AND released_at IS NULL;" "1"
err "B3 so that phone on a new account cannot be referred again" \
  "$(tx "$(del $FEDE) $(again $CARA2 5355500007) $(APPLY $CARA2)")" "Ya usaste un codigo de referido"

echo "== 4. clients reach none of it =="
val "G1 clients cannot read the claims or the salt" \
  "SELECT has_table_privilege('authenticated', 'public.reward_claims', 'SELECT') || '|' || has_table_privilege('anon', 'public.reward_claims', 'SELECT')
       || '|' || has_table_privilege('authenticated', 'public.reward_identity_salt', 'SELECT') || '|' || has_table_privilege('anon', 'public.reward_identity_salt', 'SELECT')" \
  "false|false|false|false"
val "G2 ... nor call the helpers" \
  "SELECT has_function_privilege('authenticated', 'public._claim_reward(uuid, text, uuid, uuid)', 'EXECUTE')
       || '|' || has_function_privilege('authenticated', 'public._reward_identity_hash(uuid)', 'EXECUTE')
       || '|' || has_function_privilege('anon', 'public._reward_claim_status(uuid, text)', 'EXECUTE')" "false|false|false"
val "G3 the service role keeps its grants" \
  "SELECT has_table_privilege('service_role', 'public.reward_claims', 'SELECT, INSERT, UPDATE, DELETE')
       || '|' || has_table_privilege('service_role', 'public.reward_identity_salt', 'SELECT')" "true|true"
val "G4 the claims hold no phone, only its hash" \
  "SELECT count(*) FROM public.reward_claims WHERE identity_hash ~ '5355' OR length(identity_hash) <> 64;" "0"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  NEG=pr658n
  fresh $NEG
  run $NEG "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_rides_validate_promo_discount()'::regprocedure),
            E'  RETURN NEW;\nEND;', E'  RETURN NEW; -- local edit\nEND;'); END \$x\$;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "is not the body read from prod" \
    && ok "N1 a body it does not know is not replaced" || ko "N1" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; CREATE TABLE public.reward_claims (identity_hash text NOT NULL, claim text NOT NULL,
            user_id uuid NOT NULL, ride_id uuid, referral_id uuid, claimed_at timestamptz NOT NULL DEFAULT now(),
            released_at timestamptz, PRIMARY KEY (identity_hash, claim)); GRANT SELECT ON public.reward_claims TO PUBLIC;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "clients can read the reward salt or claims" \
    && ok "N2 a read grant through PUBLIC aborts it" || ko "N2" "got [$r]"
  fresh $NEG
  run $NEG "SET ROLE tricigo_owner; CREATE TABLE public.reward_identity_salt (id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), salt text NOT NULL);
            INSERT INTO public.reward_identity_salt VALUES (1, 'x');" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "reward_identity_salt has no salt" \
    && ok "N3 a missing salt aborts it" || ko "N3" "got [$r]"
  fresh $NEG
  SALT="$(printf 'a%.0s' $(seq 64))"
  run $NEG "SET ROLE tricigo_owner;
            CREATE TABLE public.reward_identity_salt (id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), salt text NOT NULL);
            INSERT INTO public.reward_identity_salt VALUES (1, '$SALT');
            CREATE TABLE public.reward_claims (identity_hash text NOT NULL, claim text NOT NULL,
            user_id uuid NOT NULL, ride_id uuid, referral_id uuid, claimed_at timestamptz NOT NULL DEFAULT now(),
            released_at timestamptz, PRIMARY KEY (identity_hash, claim));
            INSERT INTO public.reward_claims (identity_hash, claim, user_id, released_at)
            VALUES (encode(sha256(convert_to('$SALT:5355500007', 'UTF8')), 'hex'), 'referral_referee', '$FEDE', now());" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "paid referrals without a claim" \
    && ok "N4 a paid referral left unclaimed aborts it" || ko "N4" "got [$r]"
  fresh $NEG
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$(bodies)")" = "$NEW_MD5" ] && [ "$(run $NEG "$HELPERS")" = "$HELPERS_MD5" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N5 pasted with CRLF line ends, the bodies still match git"
  else ko "N5" "apply [$r], bodies [$(run $NEG "$(bodies)")]"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
