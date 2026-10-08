#!/usr/bin/env bash
# Rehearsal runner for migrations 00641 + 00642 (marketing role in the admin panel).
# Builds prod as of 2026-10-08 from scaffold.sql (tables, policies, triggers) and live-bodies.sql
# (the live functions 00642 patches or calls; L1 checks each against prod's md5), applies 00641
# twice (the enum value, harmless on its own) and turns Mara into a marketing account.
#   supabase/tests/00642/run.sh none
#       -> prod + 00641 + tests (RED: marketing reads nothing, cannot ride, loses its role as a driver)
#          The scaffold's last tests commit a canceled ride that names a promotion (K4): keep them last.
#   supabase/tests/00642/run.sh supabase/migrations/00642_marketing_role_permissions.sql
#       -> the same + 00642 applied twice, each time in one transaction (GREEN) + negative proofs
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr642
GUARD=pr642guard
ENUM="$ROOT/supabase/migrations/00641_marketing_role_enum.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001     # admin
SARA=a0000000-0000-4000-8000-000000000002    # super_admin
CARLA=c0000000-0000-4000-8000-000000000001   # customer
DIEGO=c0000000-0000-4000-8000-000000000002   # approved driver
MARA=c0000000-0000-4000-8000-000000000003    # marketing
CARLA_DP=d0000000-0000-4000-8000-000000000001
DIEGO_DP=d0000000-0000-4000-8000-000000000002
MARA_DP=d0000000-0000-4000-8000-000000000003
RIDE_C=f0000000-0000-4000-8000-000000000001  # Carla's searching ride
RIDE_M=f0000000-0000-4000-8000-000000000003
P_LIVE=e0000000-0000-4000-8000-000000000001  # LIVE10: active, unused
P_USED=e0000000-0000-4000-8000-000000000002  # USED5: inactive, used 3 times
P_REF=e0000000-0000-4000-8000-000000000003   # REF15: committed by K4, paused, unused, named by a canceled ride
P_DRAFT=e0000000-0000-4000-8000-000000000004 # a promotion created inside one test
RIDE_K=f0000000-0000-4000-8000-000000000004  # Carla's canceled ride with REF15 (committed by K4)
RIDE_P=f0000000-0000-4000-8000-000000000005  # a ride with a promo code, inside one test

# as ID: the rest of the transaction runs as an API user with that JWT subject
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }

LIVE_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','current_user_role',
  'enforce_ride_transition','ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids',
  'get_admin_dashboard_metrics','get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method',
  'get_rides_by_service_type','get_top_drivers','is_admin','is_super_admin','promote_user_role',
  'tg_acquisition_codes_guard','tg_rides_rollback_promo_on_cancel','tg_rides_validate_promo_discount'"
LIVE_MD5="admin_launch_pulse=21c359c7427f75016c38b6b758ad23a7,admin_signup_code_stats=079bc5a6c046e6896c62200f71fc7740,apply_user_rating=8d0b0de3bf82f6d15d8da36462cbbe9c,current_user_role=cb4a7c12d4e21fe2997135833f141e25,enforce_ride_transition=35bde4fd60a4a4fa0fc86a237ec4a414,ensure_driver_role_and_tricicoin_on_approval=ed41bc2fe192ceb6dbafd163507934f3,get_active_push_user_ids=e3d6f508efe28decb7141f3251410f50,get_admin_dashboard_metrics=0c99d4e89b08ad2da5989642e09ba5bf,get_admin_wallet_stats=86c6ef03c7c39d56e9f84cc8795dfbfd,get_rides_by_day=68dcc98aaa0919c942eafc22e6cfe06a,get_rides_by_payment_method=351484791e08451565cc6fbae34fef2e,get_rides_by_service_type=c94b1028a03b16d34d25f4a2a56d4bd6,get_top_drivers=cb273bf7da9f5c3d58b495ba08d6714b,is_admin=22cb75e91980d512498034cd33e1eda2,is_super_admin=5655a4615e92e8b1e323d06c7566b058,promote_user_role=6d7f90376c85173c104a86003e684e1e,tg_acquisition_codes_guard=383b43d28d0e0598a9233fafd1eba296,tg_rides_rollback_promo_on_cancel=02515bc12de7afbc36f60e709daa18ba,tg_rides_validate_promo_discount=b70dc359fccf82f5d5b3209ca03e9816"
PATCHED_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','enforce_ride_transition',
  'ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids','get_admin_dashboard_metrics',
  'get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method','get_rides_by_service_type','get_top_drivers'"
# Computed in prod on 2026-10-08 as md5(replace(prosrc, <target>, <replacement>)): the bodies 00642 must leave.
PATCHED_MD5="admin_launch_pulse=bb5d37a5bca57a64d3e3409ada2dd6b6,admin_signup_code_stats=16a8ed1ebe03aa82f2f75676783a9099,apply_user_rating=96be8c154990651738312ef44861242f,enforce_ride_transition=f806997fab31c18e7b369e69f5321c30,ensure_driver_role_and_tricicoin_on_approval=1940d4379a446c8afdf0d47434945c07,get_active_push_user_ids=875f787da6a1c0fcce8708404efd72d8,get_admin_dashboard_metrics=32cec76d3f079f6938b09f8bb7e919b2,get_admin_wallet_stats=0f937c94cda1d26e7dd2da7d574949dd,get_rides_by_day=fd5363b072a17da61325a23cfd1486af,get_rides_by_payment_method=2ecacefdfef6c96da84d3b2f20a0b138,get_rides_by_service_type=ffd6c633752a21bba4945625fc9aaaaf,get_top_drivers=03e7be0213769612782ed3bcb0183f3a"
GATE='Admin only\|forbidden\|Forbidden'
METRICS="admin_launch_pulse(4) admin_signup_code_stats() get_admin_dashboard_metrics() get_admin_wallet_stats()
  get_rides_by_day(7) get_rides_by_service_type(7) get_rides_by_payment_method(7) get_top_drivers(5)
  get_active_push_user_ids(30)"

load(){ local db=$1 i
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >"$TMP/scaffold.out" 2>&1 \
    || { echo "scaffold failed:"; cat "$TMP/scaffold.out"; exit 1; }
  for i in 1 2; do
    $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$ENUM" >"$TMP/enum.out" 2>&1 \
      || { echo "00641 failed on apply $i:"; cat "$TMP/enum.out"; exit 1; }
  done
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "UPDATE public.users SET role = 'marketing' WHERE id = '$MARA'" \
    >"$TMP/mara.out" 2>&1 || { echo "could not make Mara marketing:"; cat "$TMP/mara.out"; exit 1; }
}
migrate(){ local db=$1 i
  [ "$MIG" = none ] && return 0
  for i in 1 2; do
    # one transaction per apply, as apply_migration runs it
    $BIN/psql $CONN -d "$db" -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >"$TMP/mig.out" 2>&1 \
      || { echo "migration failed on apply $i:"; cat "$TMP/mig.out"; exit 1; }
  done
}

load $DB
# L1: the live bodies are prod's (md5 of prosrc read from prod on 2026-10-08)
val L1 "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\")
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($LIVE_NAMES)" "$LIVE_MD5"
# E1: 00641 added the value at the end, twice without error, and Mara is marketing
val E1 "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum
  WHERE enumtypid = 'public.user_role'::regtype; SELECT role FROM public.users WHERE id = '$MARA'" \
  "customer,driver,admin,super_admin,marketing;marketing"
migrate $DB

# --- G: the file did what it says -------------------------------------------------------
val G1 "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\")
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($PATCHED_NAMES)" "$PATCHED_MD5"
val G2 "SELECT p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE p.oid = 'public.is_marketing()'::regprocedure" "f|t|t"
val G3 "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\\_marketing'" "11"
# G4: the promotions guard is SECURITY INVOKER (its marketing test reads current_user), with this body
val G4 "SELECT prosecdef, md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_promotions_marketing_guard()'::regprocedure" \
  "f|afc29bdae032dbc90721e3e0ad228721"
# G5: promotion_is_referenced(): definer, empty search_path, executable by authenticated only, this body
val G5 "SELECT p.prosecdef, array_to_string(p.proconfig, ','), md5(p.prosrc), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
  has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE'),
  EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
  FROM pg_proc p WHERE p.oid = 'public.promotion_is_referenced(uuid)'::regprocedure" \
  "t|search_path=\"\"|0ecca19fbed155c5908ce88c62c719da|t|f|f|f"
val G6 "SELECT data_type, is_nullable, column_default FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'promotions' AND column_name = 'revision'" "integer|NO|0"
# G7: the panel views read as their owner behind a barrier, and the API roles may only read them
val G7 "SELECT c.relname, array_to_string(c.reloptions, ','), has_table_privilege('authenticated', c.oid, 'SELECT'),
  has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE'), has_table_privilege('service_role', c.oid, 'SELECT'),
  has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('panel_rides', 'panel_driver_profiles')
  ORDER BY c.relname" \
  "panel_driver_profiles|security_barrier=true,security_invoker=false|t|f|f|t|f;panel_rides|security_barrier=true,security_invoker=false|t|f|f|t|f"

# --- M: is_marketing() ------------------------------------------------------------------
val M1 "BEGIN; $(as_user $MARA) SELECT public.is_marketing(), public.is_admin(); ROLLBACK;" "t|f"
val M2 "BEGIN; $(as_user $ANA) SELECT public.is_marketing(); $(as_user $CARLA) SELECT public.is_marketing(); ROLLBACK;" "f;f"
# anon may not call current_user_role(): is_marketing() must return before it, without an error
val M3 "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT public.is_marketing(); ROLLBACK;" "f"

# --- R: what marketing reads, and what it still cannot touch ----------------------------
# R1: marketing reads users and referrals; rides and driver profiles only through the panel views
# (W1), so directly it sees its own and nothing else (it has neither)
val R1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.users),
  (SELECT count(*) FROM public.driver_profiles), (SELECT count(*) FROM public.referrals); ROLLBACK;" "0|5|0|1"
val R2 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.users),
  (SELECT count(*) FROM public.driver_profiles), (SELECT count(*) FROM public.referrals); ROLLBACK;" "1|1|0|1"
val R3 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.wallet_accounts), (SELECT count(*) FROM public.admin_actions); ROLLBACK;" "0|0"
val R4 "BEGIN; $(as_user $MARA) WITH u AS (UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_C' RETURNING 1)
  SELECT count(*) FROM u; ROLLBACK;" "0"
val R5 "BEGIN; $(as_user $MARA) WITH u AS (UPDATE public.cms_content SET title_es = 'x' RETURNING 1) SELECT count(*) FROM u; ROLLBACK;" "0"
err R5b "BEGIN; $(as_user $MARA) INSERT INTO public.cms_content (slug, title_es, title_en, body_es, body_en)
  VALUES ('x', 'x', 'x', 'x', 'x'); ROLLBACK;" "new row violates row-level security policy"
# R6: approving a driver or rewarding a referral is still admin work (0 rows, no policy lets it through)
val R6 "BEGIN; $(as_user $MARA)
  WITH d AS (UPDATE public.driver_profiles SET status = 'suspended' WHERE id = '$DIEGO_DP' RETURNING 1),
       r AS (UPDATE public.referrals SET status = 'rewarded', bonus_amount = 500 RETURNING 1)
  SELECT (SELECT count(*) FROM d), (SELECT count(*) FROM r); ROLLBACK;" "0|0"

# --- W: the panel views (rides and drivers without the share token or the GPS) -----------
# W1: marketing reads every ride and driver profile through the views
val W1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles),
  (SELECT customer_id = '$CARLA' FROM public.panel_rides);
  RESET ROLE; SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.driver_profiles); ROLLBACK;" "1|1|t;1|1"
# W2: directly, only its own ride and its own driver profile
val W2 "BEGIN; INSERT INTO public.rides (customer_id) VALUES ('$MARA');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$MARA_DP', '$MARA');
  $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.driver_profiles),
  (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles); ROLLBACK;" "1|1|2|2"
# W3: exactly the listed columns; no share token, no GPS
val W3 "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'panel_rides';
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'panel_driver_profiles';
  SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name IN ('panel_rides', 'panel_driver_profiles')
  AND column_name IN ('share_token', 'share_token_expires_at', 'current_location', 'current_heading', 'last_heartbeat_at')" \
  "id,created_at,status,customer_id,driver_id,service_type,city_id,estimated_fare_cup,final_fare_cup,final_fare_trc,payment_method,pickup_address,dropoff_address,promo_code_id,discount_amount_cup,shared_ride_discount_cup,dispatch_round;id,user_id,is_online,total_rides_completed,total_rides;0"
# W4: a customer gets no row from either view, not even its own ride
val W4 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles); ROLLBACK;" "0|0"
# W5: anon may not read them at all
err W5a "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT count(*) FROM public.panel_rides; ROLLBACK;" \
  "permission denied for view panel_rides"
err W5b "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT count(*) FROM public.panel_driver_profiles; ROLLBACK;" \
  "permission denied for view panel_driver_profiles"
# W6: an admin sees every row
val W6 "BEGIN; $(as_user $ANA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles); ROLLBACK;" "1|1"
# W7: nobody writes through them (they read as their owner, past the base tables' RLS)
err W7a "BEGIN; $(as_user $MARA) UPDATE public.panel_rides SET status = 'canceled'; ROLLBACK;" "permission denied for view panel_rides"
err W7b "BEGIN; $(as_user $ANA) DELETE FROM public.panel_driver_profiles; ROLLBACK;" "permission denied for view panel_driver_profiles"
# W8: the dispatch round and the drivers' ride counters come through, as the base tables hold them
val W8 "BEGIN; $(as_user $MARA) SELECT (SELECT dispatch_round FROM public.panel_rides WHERE id = '$RIDE_C'),
  (SELECT total_rides_completed || '/' || total_rides FROM public.panel_driver_profiles WHERE id = '$DIEGO_DP'); ROLLBACK;" "2|12/9"

# --- P: promotions, draft and approval --------------------------------------------------
# P1: whatever marketing sends, a new promotion is an inactive draft of its own, unused, unapproved
val P1 "BEGIN; $(as_user $MARA)
  INSERT INTO public.promotions (code, type, discount_percent, is_active, created_by, approved_by, approved_at, current_uses)
  VALUES ('MKT1', 'percentage_discount', 10, true, '$ANA', '$ANA', now(), 7);
  RESET ROLE;
  SELECT is_active, pending_approval, created_by = '$MARA', approved_by IS NULL, approved_at IS NULL, current_uses
  FROM public.promotions WHERE code = 'MKT1'; ROLLBACK;" "f|t|t|t|t|0"
# P2: an edited draft goes back to the admins
val P2 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET title_es = 'Nuevo' WHERE id = '$P_USED'; RESET ROLE;
  SELECT title_es, pending_approval, is_active FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "Nuevo|t|f"
err P3 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET is_active = true WHERE id = '$P_USED'; ROLLBACK;" \
  "promo_activation_requires_admin"
err P4 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET discount_percent = 50 WHERE id = '$P_LIVE'; ROLLBACK;" \
  "promo_active_locked"
# P5: marketing may pause a live promotion; pausing is not a new draft
val P5 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT is_active, pending_approval FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "f|f"
# P6: and stamp the push "Notificar ahora" just sent
val P6 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET notified_at = now() WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT is_active, notified_at IS NOT NULL FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "t|t"
# P7: marketing cannot write the approval columns
val P7 "BEGIN; $(as_user $MARA) UPDATE public.promotions SET pending_approval = false, approved_by = '$ANA', approved_at = now()
  WHERE id = '$P_USED'; RESET ROLE;
  SELECT pending_approval, approved_by IS NULL, approved_at IS NULL FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "t|t|t"
val P8 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKT2', 'percentage_discount', 5);
  DELETE FROM public.promotions WHERE code = 'MKT2'; RESET ROLE;
  SELECT count(*) FROM public.promotions WHERE code = 'MKT2'; ROLLBACK;" "0"
err P9 "BEGIN; $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "promo_delete_blocked"
err P10 "BEGIN; $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "promo_delete_blocked"
# P11: an admin turning a draft on is the approval
val P11 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKT3', 'percentage_discount', 5);
  $(as_user $ANA) UPDATE public.promotions SET is_active = true WHERE code = 'MKT3'; RESET ROLE;
  SELECT is_active, pending_approval, approved_by = '$ANA', approved_at IS NOT NULL FROM public.promotions WHERE code = 'MKT3';
  ROLLBACK;" "t|f|t|t"
# P12: an admin's own promotions are never pending; creating one active stamps the approval
val P12 "BEGIN; $(as_user $ANA) INSERT INTO public.promotions (code, type, discount_percent, is_active)
  VALUES ('ADM1', 'percentage_discount', 5, false), ('ADM2', 'percentage_discount', 5, true); RESET ROLE;
  SELECT code, is_active, pending_approval, approved_by IS NOT NULL FROM public.promotions
  WHERE code IN ('ADM1', 'ADM2') ORDER BY code; ROLLBACK;" "ADM1|f|f|f;ADM2|t|f|t"
# P13: service role and SQL without a JWT: unchanged
val P13 "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;
  UPDATE public.promotions SET is_active = true WHERE id = '$P_USED'; RESET ROLE;
  SELECT is_active, approved_by IS NULL FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "t|t"
val P14 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.promotions; ROLLBACK;" "0"
err P14b "BEGIN; $(as_user $CARLA) INSERT INTO public.promotions (code, type, discount_percent)
  VALUES ('CLI1', 'percentage_discount', 5); ROLLBACK;" "new row violates row-level security policy"
val P15 "BEGIN; $(as_user $ANA) UPDATE public.promotions SET discount_percent = 50 WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT discount_percent FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "50"
val P16 "BEGIN; $(as_user $ANA) DELETE FROM public.promotions WHERE id = '$P_USED'; RESET ROLE;
  SELECT count(*) FROM public.promotions WHERE id = '$P_USED'; ROLLBACK;" "0"

# --- V: the revision an approval binds to, and activation --------------------------------
# V1: marketing editing a draft makes a new revision
val V1 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKTR', 'percentage_discount', 5);
  RESET ROLE; SELECT revision FROM public.promotions WHERE code = 'MKTR';
  $(as_user $MARA) UPDATE public.promotions SET title_es = 'Editado' WHERE code = 'MKTR';
  RESET ROLE; SELECT revision, pending_approval FROM public.promotions WHERE code = 'MKTR'; ROLLBACK;" "0;1|t"
# V2: an approval of the revision the admin saw before that edit matches no row
val V2 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKTR', 'percentage_discount', 5);
  UPDATE public.promotions SET title_es = 'Editado' WHERE code = 'MKTR';
  $(as_user $ANA) WITH u AS (UPDATE public.promotions SET is_active = true
    WHERE code = 'MKTR' AND revision = 0 AND is_active = false RETURNING 1) SELECT count(*) FROM u;
  RESET ROLE; SELECT is_active, pending_approval, approved_by IS NULL FROM public.promotions WHERE code = 'MKTR'; ROLLBACK;" "0;f|t|t"
# V3: with the current revision it activates and stamps the approval
val V3 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKTR', 'percentage_discount', 5);
  UPDATE public.promotions SET title_es = 'Editado' WHERE code = 'MKTR';
  $(as_user $ANA) WITH u AS (UPDATE public.promotions SET is_active = true
    WHERE code = 'MKTR' AND revision = 1 AND is_active = false RETURNING 1) SELECT count(*) FROM u;
  RESET ROLE; SELECT is_active, pending_approval, approved_by = '$ANA', approved_at IS NOT NULL, revision
  FROM public.promotions WHERE code = 'MKTR'; ROLLBACK;" "1;t|f|t|t|1"
# V4: marketing cannot write the revision: not on a new draft, an edited draft, or a pause
val V4 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent, revision)
  VALUES ('MKTV', 'percentage_discount', 5, 42);
  UPDATE public.promotions SET revision = 99 WHERE id = '$P_USED';
  UPDATE public.promotions SET is_active = false, revision = 99 WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT (SELECT revision FROM public.promotions WHERE code = 'MKTV'), (SELECT revision FROM public.promotions WHERE id = '$P_USED'),
  (SELECT is_active::text || '/' || revision FROM public.promotions WHERE id = '$P_LIVE'); ROLLBACK;" "0|0|false/0"
# V5: neither can an admin or the service role; an admin's content edit counts as a revision
val V5 "BEGIN; $(as_user $ANA) UPDATE public.promotions SET revision = 7 WHERE id = '$P_LIVE';
  UPDATE public.promotions SET discount_percent = 20 WHERE id = '$P_USED';
  RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;
  UPDATE public.promotions SET revision = 5 WHERE id = '$P_LIVE'; RESET ROLE;
  SELECT (SELECT revision FROM public.promotions WHERE id = '$P_LIVE'), (SELECT revision FROM public.promotions WHERE id = '$P_USED');
  ROLLBACK;" "0|1"
# V6: turned on without a JWT, a draft stops waiting for approval but gets no approver
val V6 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (code, type, discount_percent) VALUES ('MKTS', 'percentage_discount', 5);
  RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;
  UPDATE public.promotions SET is_active = true WHERE code = 'MKTS'; RESET ROLE;
  SELECT is_active, pending_approval, approved_by IS NULL, approved_at IS NULL FROM public.promotions WHERE code = 'MKTS';
  ROLLBACK;" "t|f|t|t"

# --- C, A, B, Q: campaigns, announcements, blog, signup codes ----------------------------
val C1 "BEGIN; $(as_user $MARA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Lanzamiento', 'all', 'Hola', 'Cuerpo', '$MARA'); SELECT count(*) FROM public.campaigns; ROLLBACK;" "1"
err C2 "BEGIN; $(as_user $MARA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Ajena', 'all', 'Hola', 'Cuerpo', '$ANA'); ROLLBACK;" "new row violates row-level security policy"
err C3 "BEGIN; $(as_user $CARLA) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by)
  VALUES ('Cliente', 'all', 'Hola', 'Cuerpo', '$CARLA'); ROLLBACK;" "new row violates row-level security policy"
val A1 "BEGIN; $(as_user $MARA) INSERT INTO public.home_announcements (title_es) VALUES ('Novedad');
  UPDATE public.home_announcements SET is_active = true WHERE title_es = 'Novedad';
  SELECT count(*) FILTER (WHERE is_active) FROM public.home_announcements; ROLLBACK;" "1"
val B1 "BEGIN; $(as_user $MARA) INSERT INTO public.blog_posts (slug, title_es, title_en) VALUES ('borrador', 'Borrador', 'Draft');
  SELECT count(*) FROM public.blog_posts;
  SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT count(*) FROM public.blog_posts; ROLLBACK;" "2;1"
val Q1 "BEGIN; $(as_user $MARA) INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('mkt-ig', 'Instagram', 'influencer');
  RESET ROLE; SELECT code, created_by = '$MARA' FROM public.acquisition_codes; ROLLBACK;" "MKT-IG|t"

# --- F: the metrics RPCs' gate -----------------------------------------------------------
# The gate is the first statement of each. Past it, the reduced scaffold may lack a table or a column:
# a caller that passes the gate gets a result, or an error saying something does not exist. Any other
# error (the gate's, a permission, a type) fails.
past_gate(){ ! echo "$1" | grep -q 'ERROR:' || echo "$1" | grep -q 'ERROR:  42703: column .* does not exist\|ERROR:  42P01: relation .* does not exist'; }
for f in $METRICS; do
  r=$(run $DB "BEGIN; $(as_user $CARLA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ok "F1 customer refused: $f"; else ko "F1 customer refused: $f" "got [$r]"; fi
  r=$(run $DB "BEGIN; $(as_user $MARA) SELECT public.$f; ROLLBACK;")
  if past_gate "$r"; then ok "F2 marketing passes the gate: $f"; else ko "F2 marketing passes the gate: $f" "got [$r]"; fi
  r=$(run $DB "BEGIN; $(as_user $ANA) SELECT public.$f; ROLLBACK;")
  if past_gate "$r"; then ok "F3 admin passes the gate: $f"; else ko "F3 admin passes the gate: $f" "got [$r]"; fi
done

# --- T, D, U: the live functions that list roles ----------------------------------------
# T1: marketing rides as a passenger and cancels its own search (RED: "for role marketing")
val T1 "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id) VALUES ('$RIDE_M', '$MARA');
  UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_M'; RESET ROLE;
  SELECT r.status, t.actor_role FROM public.rides r JOIN public.ride_transitions t ON t.ride_id = r.id
  WHERE r.id = '$RIDE_M'; ROLLBACK;" "canceled|customer"
# T2: marketing with an approved driver profile accepts the ride assigned to it, as a driver
val T2 "BEGIN; INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$MARA_DP', '$MARA', 'approved');
  UPDATE public.rides SET driver_id = '$MARA_DP' WHERE id = '$RIDE_C';
  $(as_user $MARA) UPDATE public.rides SET status = 'accepted' WHERE id = '$RIDE_C'; RESET ROLE;
  SELECT r.status, t.actor_role FROM public.rides r JOIN public.ride_transitions t ON t.ride_id = r.id
  WHERE r.id = '$RIDE_C'; ROLLBACK;" "accepted|driver"
err T3 "BEGIN; UPDATE public.rides SET driver_id = '$DIEGO_DP' WHERE id = '$RIDE_C';
  $(as_user $CARLA) UPDATE public.rides SET status = 'accepted' WHERE id = '$RIDE_C'; ROLLBACK;" \
  "Invalid ride transition from searching to accepted for role customer"
# D1: approved as a driver, marketing keeps its role and gets a tricicoin wallet (RED: role becomes driver)
val D1 "BEGIN; INSERT INTO public.driver_profiles (id, user_id) VALUES ('$MARA_DP', '$MARA');
  UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$MARA_DP';
  SELECT (SELECT role FROM public.users WHERE id = '$MARA'),
         (SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$MARA' AND account_type = 'tricicoin'); ROLLBACK;" \
  "marketing|1"
val D2 "BEGIN; INSERT INTO public.driver_profiles (id, user_id) VALUES ('$CARLA_DP', '$CARLA');
  UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$CARLA_DP';
  SELECT (SELECT role FROM public.users WHERE id = '$CARLA'),
         (SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$CARLA' AND account_type = 'tricicoin'); ROLLBACK;" \
  "driver|1"
# U1: a marketing passenger gets its rating (RED: 5.00, untouched)
val U1 "BEGIN; SELECT public.apply_user_rating('$MARA'); SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$MARA';
  ROLLBACK;" "4.25"

# --- K: a marketing passenger with a promo code ------------------------------------------
# The ride triggers claim and give back the use inside SECURITY DEFINER functions, with the
# passenger's JWT set: the promotions guard must leave those writes alone.
# K1: the ride is created with the discount and claims one use; nothing about approval moves
val K1 "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup)
  VALUES ('$RIDE_P', '$MARA', '$P_LIVE', 1000); RESET ROLE;
  SELECT p.current_uses, p.pending_approval, p.revision, r.promo_code_id = p.id, r.discount_amount_cup,
  (SELECT count(*) FROM public.promotion_uses u WHERE u.ride_id = r.id)
  FROM public.promotions p, public.rides r WHERE p.id = '$P_LIVE' AND r.id = '$RIDE_P'; ROLLBACK;" "1|f|0|t|100|1"
# K2: canceling gives the use back
val K2 "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup)
  VALUES ('$RIDE_P', '$MARA', '$P_LIVE', 1000);
  UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_P'; RESET ROLE;
  SELECT r.status, p.current_uses, p.pending_approval, p.revision, (SELECT count(*) FROM public.promotion_uses u WHERE u.ride_id = r.id)
  FROM public.promotions p, public.rides r WHERE p.id = '$P_LIVE' AND r.id = '$RIDE_P'; ROLLBACK;" "canceled|0|f|0|0"
# K3: also when marketing paused the promotion in between: the use comes back, no draft appears
val K3 "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup)
  VALUES ('$RIDE_P', '$MARA', '$P_LIVE', 1000);
  UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE';
  UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_P'; RESET ROLE;
  SELECT is_active, current_uses, pending_approval, revision FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "f|0|f|0"

# --- PR: granting the role --------------------------------------------------------------
val PR1 "BEGIN; $(as_user $SARA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)') ->> 'new_role';
  RESET ROLE; SELECT role FROM public.users WHERE id = '$CARLA';
  SELECT count(*) FROM public.admin_actions WHERE action = 'promote_user_role'; ROLLBACK;" "marketing;marketing;1"
err PR2 "BEGIN; $(as_user $ANA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)'); ROLLBACK;" \
  "only super_admin can promote user roles"

# --- K4-K10: deleting a promotion something points at (COMMITS: keep these last) ---------
# K4: Carla rode with REF15 and canceled, then it was paused: inactive, unused, still named by her ride
val K4 "BEGIN;
  INSERT INTO public.promotions (id, code, type, discount_percent, is_active) VALUES ('$P_REF', 'REF15', 'percentage_discount', 15, true);
  $(as_user $CARLA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup) VALUES ('$RIDE_K', '$CARLA', '$P_REF', 1000);
  UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_K';
  RESET ROLE; UPDATE public.promotions SET is_active = false WHERE id = '$P_REF';
  COMMIT;
  SELECT p.is_active, p.current_uses, r.status, r.promo_code_id = p.id, r.discount_amount_cup,
  (SELECT count(*) FROM public.promotion_uses u WHERE u.promotion_id = p.id)
  FROM public.promotions p JOIN public.rides r ON r.id = '$RIDE_K' WHERE p.id = '$P_REF'" "f|0|canceled|t|150|0"
# K5: marketing may not delete it
err K5 "BEGIN; $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_REF'; ROLLBACK;" "promo_delete_blocked"
# K6: and both the promotion and the ride's reference (with its discount) are still there
val K6 "SELECT (SELECT count(*) FROM public.promotions WHERE id = '$P_REF'),
  (SELECT promo_code_id = '$P_REF' FROM public.rides WHERE id = '$RIDE_K'),
  (SELECT discount_amount_cup FROM public.rides WHERE id = '$RIDE_K')" "1|t|150"
# K7: a draft a campaign names cannot be deleted by marketing either
err K7 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (id, code, type, discount_percent) VALUES ('$P_DRAFT', 'MKTC', 'percentage_discount', 5);
  INSERT INTO public.campaigns (name, segment_type, message_title, message_body, created_by, promo_code_id)
  VALUES ('Con código', 'all', 'Hola', 'Cuerpo', '$MARA', '$P_DRAFT');
  DELETE FROM public.promotions WHERE id = '$P_DRAFT'; ROLLBACK;" "promo_delete_blocked"
# K8: nor one with a recorded use (prod lets a passenger insert its own use row: pu_insert)
err K8 "BEGIN; $(as_user $MARA) INSERT INTO public.promotions (id, code, type, discount_percent) VALUES ('$P_DRAFT', 'MKTU', 'percentage_discount', 5);
  RESET ROLE; INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$P_DRAFT', '$CARLA');
  $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_DRAFT'; ROLLBACK;" "promo_delete_blocked"
# K9: a paused promotion nothing points at is still marketing's to delete (P8: a fresh draft too)
val K9 "BEGIN; INSERT INTO public.promotions (id, code, type, discount_percent, is_active) VALUES ('$P_DRAFT', 'PAUSADA', 'percentage_discount', 5, false);
  $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_DRAFT'; RESET ROLE;
  SELECT count(*) FROM public.promotions WHERE id = '$P_DRAFT'; ROLLBACK;" "0"
# K10: an admin still can: the ride's reference goes NULL and its discount stays (00492)
val K10 "BEGIN; $(as_user $ANA) DELETE FROM public.promotions WHERE id = '$P_REF'; RESET ROLE;
  SELECT (SELECT count(*) FROM public.promotions WHERE id = '$P_REF'),
  (SELECT promo_code_id IS NULL FROM public.rides WHERE id = '$RIDE_K'),
  (SELECT discount_amount_cup FROM public.rides WHERE id = '$RIDE_K'); ROLLBACK;" "0|t|150"

# --- X: the tests above can fail (GREEN only) --------------------------------------------
if [ "$MIG" != none ]; then
  # X1: without the current_user test, the guard treats the ride trigger's claim as marketing's own
  # write on a live promotion and the marketing passenger cannot ride with a code (K1 would fail)
  err X1 "BEGIN; DO \$d\$ DECLARE v text := pg_get_functiondef('public.tg_promotions_marketing_guard()'::regprocedure);
    t text := 'current_user IN (''anon'', ''authenticated'') AND ';
    BEGIN IF position(t IN v) = 0 THEN RAISE EXCEPTION 'X1: condition not found'; END IF; EXECUTE replace(v, t, ''); END \$d\$;
    $(as_user $MARA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup)
    VALUES ('$RIDE_P', '$MARA', '$P_LIVE', 1000); ROLLBACK;" "promo_active_locked"
  # X1b: same, on the cancel after marketing paused the promotion: the use is not given back and the
  # promotion turns into a pending draft (K3 would fail)
  val X1b "BEGIN; $(as_user $MARA) INSERT INTO public.rides (id, customer_id, promo_code_id, estimated_fare_cup)
    VALUES ('$RIDE_P', '$MARA', '$P_LIVE', 1000);
    UPDATE public.promotions SET is_active = false WHERE id = '$P_LIVE'; RESET ROLE;
    DO \$d\$ DECLARE v text := pg_get_functiondef('public.tg_promotions_marketing_guard()'::regprocedure);
    t text := 'current_user IN (''anon'', ''authenticated'') AND ';
    BEGIN IF position(t IN v) = 0 THEN RAISE EXCEPTION 'X1b: condition not found'; END IF; EXECUTE replace(v, t, ''); END \$d\$;
    $(as_user $MARA) UPDATE public.rides SET status = 'canceled' WHERE id = '$RIDE_P'; RESET ROLE;
    SELECT is_active, current_uses, pending_approval FROM public.promotions WHERE id = '$P_LIVE'; ROLLBACK;" "f|1|t"
  # X2: without the reference check, marketing deletes REF15 and Carla's canceled ride loses both its
  # promotion and its discount: the cascade runs with Mara's JWT, so the 00631 revert skips 00492
  val X2 "BEGIN; DO \$d\$ DECLARE v text := pg_get_functiondef('public.tg_promotions_marketing_guard()'::regprocedure);
    w text := regexp_replace(v, '\\s+OR public\\.promotion_is_referenced\\(OLD\\.id\\)', '');
    BEGIN IF w = v THEN RAISE EXCEPTION 'X2: check not found'; END IF; EXECUTE w; END \$d\$;
    $(as_user $MARA) DELETE FROM public.promotions WHERE id = '$P_REF'; RESET ROLE;
    SELECT (SELECT count(*) FROM public.promotions WHERE id = '$P_REF'),
    (SELECT promo_code_id IS NULL FROM public.rides WHERE id = '$RIDE_K'),
    (SELECT discount_amount_cup FROM public.rides WHERE id = '$RIDE_K'); ROLLBACK;" "0|t|0"
  # X3: without the WHERE gate, a customer reads every ride and driver through the views (W4 would fail)
  val X3 "BEGIN; INSERT INTO public.rides (customer_id) VALUES ('$MARA');
    DO \$d\$ DECLARE r text; v text; w text;
    BEGIN FOREACH r IN ARRAY ARRAY['panel_rides', 'panel_driver_profiles'] LOOP
      v := pg_get_viewdef(('public.' || r)::regclass);
      w := regexp_replace(v, '\\s+WHERE .*$', '');
      IF w = v THEN RAISE EXCEPTION 'X3: gate not found'; END IF;
      EXECUTE format('CREATE OR REPLACE VIEW public.%I WITH (security_barrier = true, security_invoker = false) AS %s', r, w);
    END LOOP; END \$d\$;
    $(as_user $CARLA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles); ROLLBACK;" "3|1"
fi

# --- N: the guards refuse what they do not know (separate database, GREEN only) ----------
apply_once(){ $BIN/psql $CONN -d "$1" -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" 2>&1 | tr -d '\r'; }
if [ "$MIG" != none ]; then
  # N1: a metrics RPC whose live body drifted: the file stops instead of patching it blindly
  load $GUARD
  run $GUARD "$AS_OWNER DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_rides_by_day(integer)'::regprocedure),
    'IF NOT is_admin() THEN', 'IF NOT is_admin() THEN -- drift'); END \$d\$;" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "get_rides_by_day(integer) has a body this file does not know"; then ok N1; else ko N1 "got [$r]"; fi
  # N2: and nothing of the file stayed behind
  val N2 "SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'is_marketing'),
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'promotions' AND column_name = 'pending_approval'),
    (SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\\_marketing')" "0|0|0" $GUARD
  # N3: same for a role-list function
  load $GUARD
  run $GUARD "$AS_OWNER DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.enforce_ride_transition()'::regprocedure),
    'RETURN NEW;', 'RETURN NEW; -- drift'); END \$d\$;" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "enforce_ride_transition() has a body this file does not know"; then ok N3; else ko N3 "got [$r]"; fi
  # N4: a policy that already has one of the names but does not use is_marketing(): the final check refuses it
  load $GUARD
  run $GUARD "$AS_OWNER CREATE POLICY users_select_marketing ON public.users FOR SELECT TO authenticated USING (false);" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "policy users_select_marketing on users does not use is_marketing()"; then ok N4; else ko N4 "got [$r]"; fi
  # N5-N10: the final check refuses each way the trigger, the guard or a policy could be wrong.
  # One database: each failed apply rolls back, and the policy planted for it is removed after.
  load $GUARD
  run $GUARD "$AS_OWNER CREATE FUNCTION public.is_marketing() RETURNS boolean LANGUAGE sql AS 'SELECT false';" >/dev/null
  bad_apply(){ $BIN/psql $CONN -d $GUARD -q -1 -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$1" 2>&1 | tr -d '\r'; }
  # N5: the trigger misses DELETE
  python3 - "$MIG" "$TMP/n5.sql" <<'PY'
import sys
s = open(sys.argv[1]).read(); old = "BEFORE INSERT OR UPDATE OR DELETE ON public.promotions"
assert s.count(old) == 1; open(sys.argv[2], 'w').write(s.replace(old, "BEFORE INSERT OR UPDATE ON public.promotions"))
PY
  r=$(bad_apply "$TMP/n5.sql")
  if echo "$r" | grep -q "trg_promotions_marketing_guard must fire BEFORE INSERT OR UPDATE OR DELETE"; then ok N5; else ko N5 "got [$r]"; fi
  # N6: the guard is a SECURITY DEFINER (current_user would always be its owner)
  python3 - "$MIG" "$TMP/n6.sql" <<'PY'
import sys
s = open(sys.argv[1]).read(); old = "\nSECURITY INVOKER\n"
assert s.count(old) == 1; open(sys.argv[2], 'w').write(s.replace(old, "\nSECURITY DEFINER\n"))
PY
  r=$(bad_apply "$TMP/n6.sql")
  if echo "$r" | grep -q "tg_promotions_marketing_guard() must be SECURITY INVOKER"; then ok N6; else ko N6 "got [$r]"; fi
  # N7-N10: a policy that already exists with one of the names, but is wrong
  for c in \
    "N7|campaigns_insert_marketing ON public.campaigns FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_marketing()))|campaigns_insert_marketing does not tie created_by to auth.uid()" \
    "N8|promotions_select_marketing ON public.promotions FOR ALL TO authenticated USING ((SELECT public.is_marketing())) WITH CHECK ((SELECT public.is_marketing()))|promotions_select_marketing on promotions is FOR ALL, not FOR SELECT" \
    "N9|users_select_marketing ON public.users FOR SELECT USING ((SELECT public.is_marketing()))|users_select_marketing on users must be PERMISSIVE and TO authenticated only" \
    "N10|rides_select_marketing ON public.rides FOR SELECT TO authenticated USING ((SELECT public.is_marketing()))|rides.rides_select_marketing let marketing read rides or driver_profiles directly"; do
    id=${c%%|*}; rest=${c#*|}; pol=${rest%%|*}; msg=${rest#*|}
    run $GUARD "$AS_OWNER CREATE POLICY $pol;" >/dev/null
    r=$(apply_once $GUARD)
    if echo "$r" | grep -qF "$msg"; then ok "$id"; else ko "$id" "got [$r]"; fi
    run $GUARD "$AS_OWNER DROP POLICY ${pol%% *} ON public.$(echo "$pol" | sed -E 's/^[^ ]+ ON public\.([^ ]+) .*/\1/');" >/dev/null
  done
  $BIN/dropdb $CONN --if-exists $GUARD >/dev/null 2>&1
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
