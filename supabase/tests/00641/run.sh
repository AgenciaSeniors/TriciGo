#!/usr/bin/env bash
# Rehearsal runner for migrations 00640 + 00641 (marketing role in the admin panel).
# Builds prod as of 2026-10-08 from scaffold.sql (tables, policies, triggers) and live-bodies.sql
# (the live functions 00641 patches or calls; L1 checks each against prod's md5), applies 00640
# twice (the enum value, harmless on its own) and turns Mara into a marketing account.
#   supabase/tests/00641/run.sh none
#       -> prod + 00640 + tests (RED: marketing reads nothing, cannot ride, loses its role as a driver)
#   supabase/tests/00641/run.sh supabase/migrations/00641_marketing_role_permissions.sql
#       -> the same + 00641 applied twice, each time in one transaction (GREEN) + negative proofs
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr641
GUARD=pr641guard
ENUM="$ROOT/supabase/migrations/00640_marketing_role_enum.sql"
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

# as ID: the rest of the transaction runs as an API user with that JWT subject
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }

LIVE_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','current_user_role',
  'enforce_ride_transition','ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids',
  'get_admin_dashboard_metrics','get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method',
  'get_rides_by_service_type','get_top_drivers','is_admin','is_super_admin','promote_user_role',
  'tg_acquisition_codes_guard'"
LIVE_MD5="admin_launch_pulse=21c359c7427f75016c38b6b758ad23a7,admin_signup_code_stats=079bc5a6c046e6896c62200f71fc7740,apply_user_rating=8d0b0de3bf82f6d15d8da36462cbbe9c,current_user_role=cb4a7c12d4e21fe2997135833f141e25,enforce_ride_transition=35bde4fd60a4a4fa0fc86a237ec4a414,ensure_driver_role_and_tricicoin_on_approval=ed41bc2fe192ceb6dbafd163507934f3,get_active_push_user_ids=e3d6f508efe28decb7141f3251410f50,get_admin_dashboard_metrics=0c99d4e89b08ad2da5989642e09ba5bf,get_admin_wallet_stats=86c6ef03c7c39d56e9f84cc8795dfbfd,get_rides_by_day=68dcc98aaa0919c942eafc22e6cfe06a,get_rides_by_payment_method=351484791e08451565cc6fbae34fef2e,get_rides_by_service_type=c94b1028a03b16d34d25f4a2a56d4bd6,get_top_drivers=cb273bf7da9f5c3d58b495ba08d6714b,is_admin=22cb75e91980d512498034cd33e1eda2,is_super_admin=5655a4615e92e8b1e323d06c7566b058,promote_user_role=6d7f90376c85173c104a86003e684e1e,tg_acquisition_codes_guard=383b43d28d0e0598a9233fafd1eba296"
PATCHED_NAMES="'admin_launch_pulse','admin_signup_code_stats','apply_user_rating','enforce_ride_transition',
  'ensure_driver_role_and_tricicoin_on_approval','get_active_push_user_ids','get_admin_dashboard_metrics',
  'get_admin_wallet_stats','get_rides_by_day','get_rides_by_payment_method','get_rides_by_service_type','get_top_drivers'"
# Computed in prod on 2026-10-08 as md5(replace(prosrc, <target>, <replacement>)): the bodies 00641 must leave.
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
      || { echo "00640 failed on apply $i:"; cat "$TMP/enum.out"; exit 1; }
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
# E1: 00640 added the value at the end, twice without error, and Mara is marketing
val E1 "SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum
  WHERE enumtypid = 'public.user_role'::regtype; SELECT role FROM public.users WHERE id = '$MARA'" \
  "customer,driver,admin,super_admin,marketing;marketing"
migrate $DB

# --- G: the file did what it says -------------------------------------------------------
val G1 "SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\")
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($PATCHED_NAMES)" "$PATCHED_MD5"
val G2 "SELECT p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE p.oid = 'public.is_marketing()'::regprocedure" "f|t|t"
val G3 "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE '%\\_marketing'" "13"

# --- M: is_marketing() ------------------------------------------------------------------
val M1 "BEGIN; $(as_user $MARA) SELECT public.is_marketing(), public.is_admin(); ROLLBACK;" "t|f"
val M2 "BEGIN; $(as_user $ANA) SELECT public.is_marketing(); $(as_user $CARLA) SELECT public.is_marketing(); ROLLBACK;" "f;f"
# anon may not call current_user_role(): is_marketing() must return before it, without an error
val M3 "BEGIN; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT public.is_marketing(); ROLLBACK;" "f"

# --- R: what marketing reads, and what it still cannot touch ----------------------------
val R1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.users),
  (SELECT count(*) FROM public.driver_profiles), (SELECT count(*) FROM public.referrals); ROLLBACK;" "1|5|1|1"
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
# The gate is the first statement of each. Past it, the reduced scaffold may lack a table: any error
# then is fine, as long as it is not the gate's.
for f in $METRICS; do
  r=$(run $DB "BEGIN; $(as_user $CARLA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ok "F1 customer refused: $f"; else ko "F1 customer refused: $f" "got [$r]"; fi
  r=$(run $DB "BEGIN; $(as_user $MARA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ko "F2 marketing passes the gate: $f" "got [$r]"; else ok "F2 marketing passes the gate: $f"; fi
  r=$(run $DB "BEGIN; $(as_user $ANA) SELECT public.$f; ROLLBACK;")
  if echo "$r" | grep -q "$GATE"; then ko "F3 admin passes the gate: $f" "got [$r]"; else ok "F3 admin passes the gate: $f"; fi
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

# --- PR: granting the role --------------------------------------------------------------
val PR1 "BEGIN; $(as_user $SARA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)') ->> 'new_role';
  RESET ROLE; SELECT role FROM public.users WHERE id = '$CARLA';
  SELECT count(*) FROM public.admin_actions WHERE action = 'promote_user_role'; ROLLBACK;" "marketing;marketing;1"
err PR2 "BEGIN; $(as_user $ANA) SELECT public.promote_user_role('$CARLA', 'marketing', 'Equipo de marketing (prueba)'); ROLLBACK;" \
  "only super_admin can promote user roles"

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
  run $GUARD "$AS_OWNER CREATE POLICY rides_select_marketing ON public.rides FOR SELECT TO authenticated USING (false);" >/dev/null
  r=$(apply_once $GUARD)
  if echo "$r" | grep -q "policy rides_select_marketing on rides does not use is_marketing()"; then ok N4; else ko N4 "got [$r]"; fi
  $BIN/dropdb $CONN --if-exists $GUARD >/dev/null 2>&1
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
