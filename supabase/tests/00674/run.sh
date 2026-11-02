#!/usr/bin/env bash
# Rehearsal runner for migration 00674 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00674/run.sh none
#       -> base (the 00665 scaffold, migration 00665, extra.sql) + tests (RED: 00674 is missing)
#   supabase/tests/00674/run.sh supabase/migrations/00674_missed_ride_apology_coupon.sql
#       -> the same + migration x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00674/run.sh ...
# Another database name (two runs at once): PGDB=<name> ...  (the negative proofs use <name>n)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr674}"
NEG="${PGDB:-pr674}n"
M665="$REPO/supabase/migrations/00665_signup_code_promotion.sql"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

OPS=0b000000-0000-4000-8000-000000000001    # operator
ADM=0b000000-0000-4000-8000-000000000002    # admin
MARK=0b000000-0000-4000-8000-000000000003   # marketing
ANA=a0000000-0000-4000-8000-000000000001    # no driver 3 h ago after 2 min; signup code MOTO (BIENVENIDA)
ANA2=a0000000-0000-4000-8000-000000000011   # ANA's phone on a new account (C10)
BETO=a0000000-0000-4000-8000-000000000002   # no driver 3 days ago, completed a ride since
CARL=a0000000-0000-4000-8000-000000000003   # canceled after 20 s
NORA=a0000000-0000-4000-8000-000000000004   # no driver 1 day ago, phone never confirmed
TINA=a0000000-0000-4000-8000-000000000005   # no driver 1 day ago, test account
OLGA=a0000000-0000-4000-8000-000000000006   # no driver 100 days ago
RIDER2=a0000000-0000-4000-8000-000000000007 # never missed a driver
# Out of the segment, each for one reason (a confirmed phone each, so the phone is not what keeps them out):
BLOK=a0000000-0000-4000-8000-000000000008   # blocked account
CARGO=a0000000-0000-4000-8000-000000000009  # only failed request is a delivery
WDRV=a0000000-0000-4000-8000-000000000012   # the canceled ride had a driver
SCHED=a0000000-0000-4000-8000-000000000013  # scheduled: waited 30 s from its time, 2 days from its creation
DISP=a0000000-0000-4000-8000-000000000014   # a disputed ride after the failure
SYS=00000000-0000-0000-0000-000000000099    # the system account (in the scaffold)
DIEGO=d0000000-0000-4000-8000-000000000001; DP=dd000000-0000-4000-8000-000000000001
PERDON=f1000000-0000-4000-8000-000000000001 # grant-only, 500 CUP, the newest
VIEJO=f1000000-0000-4000-8000-000000000002  # grant-only, 300 CUP, a day older
BIENV=f1000000-0000-4000-8000-000000000003  # public, 25 %, linked to the signup code MOTO
CORP=c0000000-0000-4000-8000-0000000000c0
PICK="'POINT(-82.3666 23.1357)'"
DROP="'POINT(-82.3666 23.1384)'"
R1=22222222-0000-4000-8000-000000000001; R2=22222222-0000-4000-8000-000000000002

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# client USER SQL: SQL from USER's app session (role authenticated), then back to the test superuser with no JWT
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
# ride ID CUSTOMER [PROMO] [RIDE_MODE] [CORPORATE_ACCOUNT]
ride(){ local promo="NULL" mode="${4:-passenger}" corp="NULL"
  [ -n "${3:-}" ] && promo="'$3'"; [ -n "${5:-}" ] && corp="'$5'"
  echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup, promo_code_id, ride_mode, corporate_account_id)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000, $promo, '$mode', $corp);"; }
# missed USER AGO WAIT: a request USER made AGO, canceled with no driver after WAIT
missed(){ echo "INSERT INTO public.rides (customer_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at, pickup_address, dropoff_address)
        VALUES ('$1', 'auto_standard', 'canceled', $PICK, $DROP, 4000, now() - interval '$2', now() - interval '$2' + interval '$3', 'Capitolio', 'Hotel Nacional');"; }
state(){ echo "SELECT coalesce(promo_code_id::text, 'none') || '|' || discount_amount_cup FROM public.rides WHERE id = '$1';"; }
cancel(){ echo "UPDATE public.rides SET status = 'canceled' WHERE id = '$1';"; }
# expect USER: remember USER's latest cancellation (what the panel shows and sends back)
expect(){ echo "SELECT 1 WHERE set_config('t.failed', coalesce((SELECT max(canceled_at)::text FROM public.rides WHERE customer_id = '$1' AND status = 'canceled'), ''), true) IS NULL;"; }
# contact USER [TIMESTAMP-SQL]: write to USER; prints error-or-true|coupon code|coupon reason
contact(){ local at="${2:-NULLIF(current_setting('t.failed', true), '')::timestamptz}"
  echo "SELECT coalesce(r ->> 'error', r ->> 'success') || '|' || coalesce(r -> 'coupon' ->> 'code', '-') || '|' || coalesce(r ->> 'coupon_reason', '-')
          FROM (SELECT public.ops_contact_missed_rider('$1', $at) AS r) x;"; }
GRANT="$(expect $ANA) $(client $OPS "$(contact $ANA)")"
LIST_PENDING="SELECT string_agg(full_name, ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', NULL);"
MINE="SELECT code || '|' || type || '|' || coalesce(discount_fixed_cup::text, '-') || '|' || signup_code FROM public.get_my_signup_promotion();"
LIVE="SELECT string_agg(proname || '=' || md5(replace(prosrc, chr(13), '')), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('tg_rides_validate_promo_discount', 'validate_promo_code',
        'get_my_signup_promotion', 'tg_rides_signup_promo', '_claim_reward', '_reward_claim_status',
        'tg_rides_rollback_promo_on_cancel', 'is_ops_staff', 'is_operator')"
LIVE_MD5="_claim_reward=d9a8726c2f105908c0df7fe8c59b2982,_reward_claim_status=73d57eecb3631f0db8d1bc9d7a71fb30,get_my_signup_promotion=b4209984f4bd3e9e822e28e3e28eb3c9,is_operator=16438eb527af61eaa2d0b3d9a53f08f9,is_ops_staff=d6774e4677be1072e66b247492e9cb9a,tg_rides_rollback_promo_on_cancel=0fd8994f3d1dd121e5168ff58ab0fdbc,tg_rides_signup_promo=a295af88635a82cf9dbc0b272013ef30,tg_rides_validate_promo_discount=cad4cf62d95e5055950b67564c6da7f4,validate_promo_code=952805817a1ea73ab0fbb93f28884a30"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
          '_my_granted_promotion_id', 'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider',
          'tg_rides_promo_grant', 'tg_promotions_grant_only_frozen', 'tg_rides_validate_promo_discount', 'validate_promo_code',
          'get_my_signup_promotion')"
marker(){ echo "SELECT (length(prosrc) - length(replace(prosrc, '$2', ''))) / length('$2') FROM pg_proc WHERE proname = '$1';"; }
MARKERS="$(marker tg_rides_validate_promo_discount '00674: a grant-only promotion counts only') $(marker validate_promo_code '00674: a grant-only promotion is invalid') $(marker get_my_signup_promotion '00674: an apology coupon goes first')"

# fresh DB: the base and the seed. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
  (cd "$REPO/supabase/tests/00665" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
    || { echo "-- the 00665 scaffold failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M665" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- migration 00665 failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, is_test) VALUES
    ('$OPS', 'operator', 'Oscar Operador', false), ('$ADM', 'admin', 'Adela', false), ('$MARK', 'marketing', 'Mark', false),
    ('$ANA', 'customer', 'Ana Perez', false), ('$ANA2', 'customer', 'Ana otra vez', false), ('$BETO', 'customer', 'Beto', false),
    ('$CARL', 'customer', 'Carla', false), ('$NORA', 'customer', 'Nora', false), ('$TINA', 'customer', 'Tina', true),
    ('$OLGA', 'customer', 'Olga', false), ('$RIDER2', 'customer', 'Rider Dos', false), ('$DIEGO', 'driver', 'Diego', false),
    ('$CARGO', 'customer', 'Cora', false), ('$WDRV', 'customer', 'Dario', false), ('$SCHED', 'customer', 'Sara', false),
    ('$DISP', 'customer', 'Dina', false);
  INSERT INTO public.users (id, role, full_name, is_active) VALUES ('$BLOK', 'customer', 'Blanca', false);
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$OPS', '5355500021', now()), ('$ADM', '5355500022', now()), ('$MARK', '5355500023', now()),
    ('$ANA', '5355500001', now()), ('$BETO', '5355500002', now()), ('$CARL', '5355500003', now()),
    ('$NORA', '5355500004', NULL), ('$TINA', '5355500005', now()), ('$OLGA', '5355500006', now()),
    ('$RIDER2', '5355500007', now()), ('$DIEGO', '5355500008', now()),
    ('$BLOK', '5355500009', now()), ('$SYS', '5355500010', now()), ('$CARGO', '5355500011', now()),
    ('$WDRV', '5355500012', now()), ('$SCHED', '5355500013', now()), ('$DISP', '5355500014', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP', '$DIEGO');
  INSERT INTO public.corporate_accounts (id, commission_percent) VALUES ('$CORP', 10);
  INSERT INTO public.platform_config (key, value) VALUES ('support_alert_after_s', '60');
  INSERT INTO public.promotions (id, code, type, discount_percent, discount_fixed_cup, created_at) VALUES
    ('$PERDON', 'PERDON', 'fixed_discount', NULL, 500, now()),
    ('$VIEJO', 'VIEJO', 'fixed_discount', NULL, 300, now() - interval '1 day'),
    ('$BIENV', 'BIENVENIDA', 'percentage_discount', 25, NULL, now() - interval '2 days');
  INSERT INTO public.acquisition_codes (code, label, channel, promotion_id) VALUES ('MOTO', 'Motorenko', 'influencer', '$BIENV');
  UPDATE public.users SET signup_code = 'MOTO' WHERE id = '$ANA';
  $(missed $ANA '3 hours' '2 minutes')
  $(missed $BETO '3 days' '5 minutes')
  INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at)
    VALUES ('$BETO', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() - interval '2 days');
  $(missed $CARL '2 hours' '20 seconds')
  $(missed $NORA '1 day' '3 minutes')
  $(missed $TINA '1 day' '3 minutes')
  $(missed $OLGA '100 days' '4 minutes')
  -- out: the account is blocked
  $(missed $BLOK '21 hours' '3 minutes')
  -- out: a team account (marketing)
  $(missed $MARK '20 hours' '3 minutes')
  -- out: the system account
  $(missed $SYS '22 hours' '3 minutes')
  -- out: the only failed request is a delivery
  INSERT INTO public.rides (customer_id, service_type, status, ride_mode, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at)
    VALUES ('$CARGO', 'auto_standard', 'canceled', 'cargo', $PICK, $DROP, 4000, now() - interval '23 hours', now() - interval '23 hours' + interval '3 minutes');
  -- out: a driver had taken the ride before it was canceled
  INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at)
    VALUES ('$WDRV', '$DP', 'auto_standard', 'canceled', $PICK, $DROP, 4000, now() - interval '19 hours', now() - interval '19 hours' + interval '3 minutes');
  -- out: scheduled, canceled 30 s after its time (the wait counts from the later of creation and schedule)
  INSERT INTO public.rides (customer_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at, scheduled_at, canceled_at)
    VALUES ('$SCHED', 'auto_standard', 'canceled', $PICK, $DROP, 4000, now() - interval '2 days', now() - interval '1 hour', now() - interval '1 hour' + interval '30 seconds');
  -- out: a disputed ride (one the person took) after the failure
  $(missed $DISP '2 days' '3 minutes')
  INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at)
    VALUES ('$DISP', '$DP', 'auto_standard', 'disputed', $PICK, $DROP, 4000, now() - interval '1 day');" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- the seed failed:"; cat "$FRESHLOG"; return 1; }; }
# the coupons exist only with the migration; without it this fails and the tests below are RED.
# grant_only is chosen at creation (the freeze trigger refuses any later change); the seed runs
# before the column exists, so the rehearsal marks them with the triggers off.
mark(){ "$BIN/psql" $CONN -d "$1" -qAt -c "SET session_replication_role = replica; UPDATE public.promotions SET grant_only = true, is_public = false WHERE id IN ('$PERDON', '$VIEJO');" >/dev/null 2>&1; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  mark $DB   # set between the two runs: the second one must leave it alone
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "S1 two runs: two triggers, two constraints, each patch once, and the marked coupons survive" \
    "SELECT count(*) FROM pg_trigger WHERE tgname IN ('rides_promo_grant', 'promotions_grant_only_frozen'); SELECT count(*) FROM pg_constraint WHERE conname IN ('promotions_grant_only_private', 'promotions_grant_only_any_ride'); $MARKERS SELECT count(*) FROM public.promotions WHERE grant_only;" \
    "2;2;1;1;1;2"
else
  mark $DB   # RED: grant_only does not exist yet
fi

echo "== 1. who is on the list =="
val "L1 pending: no driver after 60 s and no ride since; not the 20 s one, not the one who rode, not the test account" \
  "$(tx "$(client $OPS "$LIST_PENDING")")" "Ana Perez,Nora,Olga"
val "L2 the 30-day window leaves the 100-day-old one out" \
  "$(tx "$(client $OPS "SELECT string_agg(full_name, ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', 30);")")" "Ana Perez,Nora"
val "L3 the confirmed phone, or nothing" \
  "$(tx "$(client $OPS "SELECT string_agg(coalesce(phone, '-'), ',' ORDER BY last_failed_at DESC) FROM public.admin_missed_riders('pending', NULL);")")" "5355500001,-,5355500006"
val "L4 the request count and the last one's addresses" \
  "$(tx "$(client $OPS "SELECT failed_requests || '|' || last_pickup || '|' || last_dropoff || '|' || in_segment FROM public.admin_missed_riders('pending', NULL) WHERE user_id = '$ANA';")")" \
  "1|Capitolio|Hotel Nacional|true"
err "L5 marketing does not see it" "$(tx "$(client $MARK "$LIST_PENDING")")" "forbidden"
err "L6 a passenger does not see it" "$(tx "$(client $RIDER2 "$LIST_PENDING")")" "forbidden"
val "L7 an admin sees it" "$(tx "$(client $ADM "$LIST_PENDING")")" "Ana Perez,Nora,Olga"
err "L8 an unknown view is refused" "$(tx "$(client $OPS "SELECT count(*) FROM public.admin_missed_riders('everyone', NULL);")")" "invalid_view"
err "L9 a period under one day is refused" "$(tx "$(client $OPS "SELECT count(*) FROM public.admin_missed_riders('pending', 0);")")" "DETAIL:  invalid_days"

echo "== 2. writing to someone =="
val "C1 an operator writes to Ana: success, the newest coupon" "$(tx "$GRANT")" "true|PERDON|-"
val "C2 ... one grant, one contact, the phone's claim and one admin_actions row" \
  "$(tx "$GRANT SELECT count(*) FROM public.promotion_grants WHERE user_id = '$ANA' AND promotion_id = '$PERDON'; SELECT count(*) FROM public.missed_ride_contacts WHERE user_id = '$ANA' AND contacted_by = '$OPS' AND grant_id IS NOT NULL; SELECT count(*) FROM public.reward_claims WHERE claim = 'missed_ride_coupon' AND user_id = '$ANA' AND released_at IS NULL; SELECT count(*) FROM public.admin_actions WHERE action = 'missed_rider_contacted' AND admin_id = '$OPS' AND target_id = '$ANA';")" \
  "true|PERDON|-;1;1;1;1"
val "C3 writing again returns the same coupon and adds a contact, not a grant" \
  "$(tx "$GRANT $(client $OPS "$(contact $ANA)") SELECT count(*) FROM public.promotion_grants WHERE user_id = '$ANA'; SELECT count(*) FROM public.missed_ride_contacts WHERE user_id = '$ANA';")" \
  "true|PERDON|-;true|PERDON|-;1;2"
val "C4 a stale failure time is refused and records nothing" \
  "$(tx "SELECT 1 WHERE set_config('t.failed', (now() - interval '5 hours')::text, true) IS NULL; $(client $OPS "$(contact $ANA)") SELECT count(*) FROM public.missed_ride_contacts;")" \
  "missed_rider_changed|-|-;0"
val "C5 no confirmed phone: refused, nothing recorded" \
  "$(tx "$(expect $NORA) $(client $OPS "$(contact $NORA)") SELECT count(*) FROM public.missed_ride_contacts;")" "no_phone|-|-;0"
val "C6 not in the segment: rode since, canceled at once, test account, never missed" \
  "$(tx "$(expect $BETO) $(client $OPS "$(contact $BETO)") $(expect $CARL) $(client $OPS "$(contact $CARL)") $(expect $TINA) $(client $OPS "$(contact $TINA)") $(client $OPS "$(contact $RIDER2 'now()')")")" \
  "not_eligible|-|-;not_eligible|-|-;not_eligible|-|-;not_eligible|-|-"
val "C7 nobody writes to themselves" "$(tx "$(client $OPS "$(contact $OPS 'now()')")")" "self_action|-|-"
val "C8 marketing and a passenger cannot write" \
  "$(tx "$(expect $ANA) $(client $MARK "$(contact $ANA)") $(client $RIDER2 "$(contact $ANA)")")" "forbidden|-|-;forbidden|-|-"
val "C9 with no active coupon the contact is recorded without one" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE id IN ('$PERDON', '$VIEJO'); $GRANT SELECT count(*) FROM public.promotion_grants; SELECT count(*) FROM public.missed_ride_contacts WHERE grant_id IS NULL;")" \
  "true|-|no_coupon_available;0;1"
val "C10 the same phone on a new account gets no second coupon" \
  "$(tx "$GRANT UPDATE auth.users SET phone = NULL WHERE id = '$ANA'; INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$ANA2', '5355500001', now()); $(missed $ANA2 '2 hours' '3 minutes') $(expect $ANA2) $(client $OPS "$(contact $ANA2)")")" \
  "true|PERDON|-;true|-|already_given"
val "C11 a used coupon is not offered again" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(client $OPS "$(contact $ANA)")")" "true|PERDON|-;true|-|coupon_used"
val "C12 a paused coupon is not offered again" \
  "$(tx "$GRANT UPDATE public.promotions SET is_active = false WHERE id = '$PERDON'; $(client $OPS "$(contact $ANA)")")" "true|PERDON|-;true|-|coupon_unusable"
val "C13 the contacted view shows the coupon and who wrote; pending drops her" \
  "$(tx "$GRANT $(client $OPS "$LIST_PENDING SELECT full_name || '|' || coupon_status || '|' || coupon_code || '|' || contacts || '|' || last_contacted_by FROM public.admin_missed_riders('contacted', NULL);")")" \
  "true|PERDON|-;Nora,Olga;Ana Perez|granted|PERDON|1|Oscar Operador"
val "C14 a completed ride after the contact shows as riding again" \
  "$(tx "$GRANT INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at) VALUES ('$ANA', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() + interval '1 minute'); $(client $OPS "SELECT rode_after_contact || '|' || in_segment FROM public.admin_missed_riders('contacted', NULL) WHERE user_id = '$ANA';")")" \
  "true|PERDON|-;true|false"
val "C15 the coupon header shows the newest active coupon" \
  "$(tx "$(client $OPS "SELECT public.admin_missed_ride_coupon() ->> 'code';")")" "PERDON"
err "C16 marketing does not read the coupon header" "$(tx "$(client $MARK "SELECT public.admin_missed_ride_coupon();")")" "forbidden"
val "C17 an admin writes to Ana and gets the coupon" "$(tx "$(expect $ANA) $(client $ADM "$(contact $ANA)")")" "true|PERDON|-"
val "C18 with PERDON out of uses the coupon header falls back to VIEJO" \
  "$(tx "UPDATE public.promotions SET max_uses = 1, current_uses = 1 WHERE id = '$PERDON'; $(client $OPS "SELECT public.admin_missed_ride_coupon() ->> 'code';")")" "VIEJO"
val "C19 the same phone on a new account: the contacted view shows no coupon and the phone already rewarded" \
  "$(tx "$GRANT UPDATE auth.users SET phone = NULL WHERE id = '$ANA'; INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$ANA2', '5355500001', now()); $(missed $ANA2 '2 hours' '3 minutes') $(expect $ANA2) $(client $OPS "$(contact $ANA2) SELECT full_name || '|' || coupon_status || '|' || phone_already_rewarded FROM public.admin_missed_riders('contacted', NULL) WHERE user_id = '$ANA2';")")" \
  "true|PERDON|-;true|-|already_given;Ana otra vez|none|true"
val "C20 a disputed ride after the contact also counts as riding again" \
  "$(tx "$GRANT INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at) VALUES ('$ANA', '$DP', 'auto_standard', 'disputed', $PICK, $DROP, 4000, now() + interval '1 minute'); $(client $OPS "SELECT rode_after_contact || '|' || in_segment FROM public.admin_missed_riders('contacted', NULL) WHERE user_id = '$ANA';")")" \
  "true|PERDON|-;true|false"

echo "== 3. the coupon on the next ride =="
val "A1 Ana's next ride gets the coupon, before her signup promotion" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "true|PERDON|-;$PERDON|500"
val "A2 a code she types wins" "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA $BIENV)") $(state $R1)")" "true|PERDON|-;$BIENV|1000"
val "A3 not on a delivery or a ride a company pays" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA '' cargo) $(ride $R2 $ANA '' passenger $CORP)") $(state $R1) $(state $R2)")" \
  "true|PERDON|-;none|0;none|0"
val "A4 once used, the next ride gets the signup promotion instead" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA) $(ride $R2 $ANA)") $(state $R1) $(state $R2)")" "true|PERDON|-;$PERDON|500;$BIENV|1000"
val "A5 a canceled ride gives the coupon back" \
  "$(tx "$GRANT $(client $ANA "$(ride $R1 $ANA)") $(cancel $R1) $(client $ANA "$(ride $R2 $ANA)") $(state $R2)")" "true|PERDON|-;$PERDON|500"
val "A6 someone else typing the code gets nothing" \
  "$(tx "$GRANT $(client $RIDER2 "$(ride $R1 $RIDER2 $PERDON)") $(state $R1)")" "true|PERDON|-;none|0"
val "A7 the code's preview: valid for Ana, invalid for anyone else" \
  "$(tx "$GRANT $(client $ANA "SELECT (r ->> 'valid') || '|' || (r ->> 'discount_amount') FROM (SELECT public.validate_promo_code('PERDON', '$ANA', 4000) AS r) x;") $(client $RIDER2 "SELECT public.validate_promo_code('PERDON', '$RIDER2', 4000) ->> 'error';")")" \
  "true|PERDON|-;true|500;invalid"
val "A8 the apps' prefill: the coupon first, then the signup promotion once it is used" \
  "$(tx "$(client $ANA "$MINE") $GRANT $(client $ANA "$MINE") $(client $ANA "$(ride $R1 $ANA) $MINE")")" \
  "BIENVENIDA|percentage_discount|-|MOTO;true|PERDON|-;PERDON|fixed_discount|500|PERDON;BIENVENIDA|percentage_discount|-|MOTO"
val "A9 a ride made with no JWT is left alone" "$(tx "$GRANT $(ride $R1 $ANA) $(state $R1)")" "true|PERDON|-;none|0"
val "A10 a paused coupon leaves the next ride to the signup promotion" \
  "$(tx "$GRANT UPDATE public.promotions SET is_active = false WHERE id = '$PERDON'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "true|PERDON|-;$BIENV|1000"
val "A11 an admin with a grant gets no coupon on a ride, and no prefill" \
  "$(tx "INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by) VALUES ('$PERDON', '$ADM', 'missed_ride', '$OPS'); $(client $ADM "$(ride $R1 $ADM) SELECT count(*) FROM public.get_my_signup_promotion();") $(state $R1)")" \
  "0;none|0"
val "A12 a coupon out of uses leaves the next ride to the signup promotion" \
  "$(tx "$GRANT UPDATE public.promotions SET max_uses = 1, current_uses = 1 WHERE id = '$PERDON'; $(client $ANA "$(ride $R1 $ANA)") $(state $R1)")" "true|PERDON|-;$BIENV|1000"
val "A13 an expired coupon, or one not valid yet, is not prefilled: the signup promotion is" \
  "$(tx "$GRANT UPDATE public.promotions SET valid_until = now() - interval '1 minute' WHERE id = '$PERDON'; $(client $ANA "$MINE") UPDATE public.promotions SET valid_until = NULL, valid_from = now() + interval '1 day' WHERE id = '$PERDON'; $(client $ANA "$MINE")")" \
  "true|PERDON|-;BIENVENIDA|percentage_discount|-|MOTO;BIENVENIDA|percentage_discount|-|MOTO"

echo "== 4. data rules =="
err "D1 a grant-only promotion cannot be public" "$(tx "UPDATE public.promotions SET is_public = true WHERE id = '$PERDON';")" "promotions_grant_only_private"
err "D2 a coupon someone holds cannot be deleted" "$(tx "$GRANT DELETE FROM public.promotions WHERE id = '$PERDON';")" "promotion_grants_promotion_id_fkey"
err "D3 one coupon per account" \
  "$(tx "$GRANT INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by) VALUES ('$VIEJO', '$ANA', 'missed_ride', '$OPS');")" \
  "promotion_grants_user_source_key"
err "D4 the apps cannot read the grants" "$(tx "$(client $ANA "SELECT count(*) FROM public.promotion_grants;")")" "permission denied for table promotion_grants"
err "D5 ... nor the contacts, not even an operator" "$(tx "$(client $OPS "SELECT count(*) FROM public.missed_ride_contacts;")")" "permission denied for table missed_ride_contacts"
err "D6 anon cannot call the list" "$(tx "SET LOCAL ROLE anon; SELECT count(*) FROM public.admin_missed_riders('pending', NULL);")" "permission denied for function admin_missed_riders"
err "D7 a grant-only promotion cannot be first-ride-only" "$(tx "UPDATE public.promotions SET first_ride_only = true WHERE id = '$PERDON';")" "promotions_grant_only_any_ride"
d8_off=$(run $DB "$(tx "UPDATE public.promotions SET grant_only = false WHERE id = '$PERDON';")")
d8_on=$(run $DB "$(tx "UPDATE public.promotions SET grant_only = true, is_public = false WHERE id = '$BIENV';")")
if echo "$d8_off" | grep -q "DETAIL:  grant_only_frozen" && echo "$d8_on" | grep -q "DETAIL:  grant_only_frozen"; then
  ok "D8 grant_only cannot be switched off on a coupon, nor on for a public promotion"
else ko "D8 grant_only cannot be switched off on a coupon, nor on for a public promotion" "off [$d8_off], on [$d8_on]"; fi

echo "== 5. shape =="
val "G1 the ride trigger function is SECURITY INVOKER" "SELECT prosecdef FROM pg_proc WHERE proname = 'tg_rides_promo_grant';" "f"
val "G2 BEFORE INSERT row triggers on rides fire in this order" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.rides'::regclass AND NOT tgisinternal AND (tgtype & 7) = 7;" \
  "rides_promo_grant,rides_signup_promo,rides_validate_promo_discount"
val "G3 anon calls none; authenticated calls the four the panel and the apps use, not the two helpers" \
  "SELECT string_agg(has_function_privilege('anon', u.f, 'EXECUTE') || '/' || has_function_privilege('authenticated', u.f, 'EXECUTE'), ',' ORDER BY u.i)
     FROM unnest(ARRAY['public.admin_missed_riders(text,integer)', 'public.admin_missed_ride_coupon()',
                       'public.ops_contact_missed_rider(uuid,timestamptz)', 'public._my_granted_promotion_id()',
                       'public._missed_rider_summary(uuid)', 'public._missed_ride_current_coupon()']) WITH ORDINALITY AS u(f, i);" \
  "false/true,false/true,false/true,false/true,false/false,false/false"
val "G4 no client can call the two trigger functions" \
  "SELECT string_agg(has_function_privilege('anon', u.f, 'EXECUTE') || '/' || has_function_privilege('authenticated', u.f, 'EXECUTE'), ',' ORDER BY u.i)
     FROM unnest(ARRAY['public.tg_rides_promo_grant()', 'public.tg_promotions_grant_only_frozen()']) WITH ORDINALITY AS u(f, i);" \
  "false/false,false/false"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration refuses or catches what it must =="
  fresh_neg(){ fresh $NEG || { echo "negative-proof database failed"; exit 1; }; }
  # mutant FILE SED-SCRIPT: FILE is a copy of the migration with one sed edit; returns 1 when the edit changed nothing
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  # neg_mutant ID LABEL SED-SCRIPT WANT: a fresh database, the migration with one edit; it has to abort with WANT
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    echo "$r" | grep -q "$want" && ok "$id $label" || ko "$id $label" "got [$r]"; }
  # drift ID LABEL FUNCTION OLD NEW WANT: one live body differs from prod; the migration has to abort with WANT
  drift(){ local r; fresh_neg
    run $NEG "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('$3'::regprocedure), '$4', '$5'); END \$d\$;" >/dev/null
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "$6" && ok "$1 $2" || ko "$1 $2" "got [$r]"; }
  drift N1 "a validator it does not know aborts it" 'public.tg_rides_validate_promo_discount()' \
    'v_cap INTEGER;' 'v_cap INTEGER; -- drift' "tg_rides_validate_promo_discount() is not the body read from prod"
  drift N2 "a validate_promo_code it does not know aborts it" 'public.validate_promo_code(text,uuid,integer)' \
    'v_discount INTEGER := 0;' 'v_discount INTEGER := 0; -- drift' "validate_promo_code(text,uuid,integer) is not the body read from prod"
  drift N3 "a get_my_signup_promotion it does not know aborts it" 'public.get_my_signup_promotion()' \
    'v_uid uuid := auth.uid();' 'v_uid uuid := auth.uid(); -- drift' "get_my_signup_promotion() is not the body read from prod"
  fresh_neg
  run $NEG "ALTER TRIGGER rides_validate_promo_discount ON public.rides RENAME TO rides_a_validate_promo_discount;" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "rides_promo_grant has to fire before" \
    && ok "N4 a validator that would fire first aborts it" || ko "N4 a validator that would fire first aborts it" "got [$r]"
  fresh_neg
  run $NEG "CREATE FUNCTION public.zz_rogue() RETURNS boolean LANGUAGE sql AS 'SELECT public.is_ops_staff()';" >/dev/null
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "other functions call the ops checks" \
    && ok "N5 another function calling the ops checks aborts it" || ko "N5 another function calling the ops checks aborts it" "got [$r]"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ] \
     && [ "$(run $NEG "SELECT count(*) FROM pg_proc WHERE position(chr(13) IN prosrc) > 0")" = "0" ]; then
    ok "N6 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N6 pasted with CRLF line ends, the bodies match the LF ones" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  neg_mutant N7 "a SECURITY DEFINER trigger function aborts it" \
    '/^CREATE OR REPLACE FUNCTION public.tg_rides_promo_grant()$/,/^AS \$function\$$/s/^ LANGUAGE plpgsql$/ LANGUAGE plpgsql SECURITY DEFINER/' \
    "must be SECURITY INVOKER"
  neg_mutant N8 "a grants table open to the apps aborts it" \
    's/^REVOKE ALL ON public.promotion_grants FROM PUBLIC, anon, authenticated;$/GRANT SELECT ON public.promotion_grants TO authenticated;/' \
    "is open to a client"
  neg_mutant N9 "an ops function that logs nothing aborts it" \
    's/INSERT INTO public.admin_actions (admin_id/INSERT INTO public.not_admin_actions (admin_id/' \
    "is not a proper ops function"
  neg_mutant N10 "a missing first-ride-only constraint aborts it" \
    '/^    ALTER TABLE public.promotions ADD CONSTRAINT promotions_grant_only_any_ride$/,/^      CHECK (NOT (grant_only AND COALESCE(first_ride_only, false)));$/d' \
    "a grant-only promotion could be first-ride-only"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00674 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
             '_my_granted_promotion_id', 'admin_missed_riders', 'admin_missed_ride_coupon', 'ops_contact_missed_rider',
             'tg_rides_promo_grant', 'tg_promotions_grant_only_frozen', 'tg_rides_validate_promo_discount', 'validate_promo_code',
             'get_my_signup_promotion')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
