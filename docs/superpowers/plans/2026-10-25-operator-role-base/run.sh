#!/usr/bin/env bash
# Rehearsal runner for migrations 00667 + 00668 (operator role, delivery 1).
# Builds prod as captured by capture-prod.sql (prod-objects.sql), on top of stubs.sql, then 00667
# and seed.sql.
#   supabase/tests/00668/run.sh none
#       -> prod + 00667 + tests (RED: the operator reads nothing, every gate refuses it)
#   supabase/tests/00668/run.sh supabase/migrations/00668_operator_role_base.sql
#       -> the same + 00668 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed nothing else, a CRLF copy applied to a fresh database, and negative proofs of
#          the file's own checks
# Cluster: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00668/run.sh ...
# The main database (pr668) stays for inspection; the CRLF and negative-proof ones are dropped.
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr668
ENUM="$ROOT/supabase/migrations/00667_operator_role_enum.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d)
cleanup(){
  local d
  for d in ${DB}crlf ${DB}neg ${DB}noenum; do $BIN/dropdb $CONN --if-exists "$d" >/dev/null 2>&1; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3] in [$r]"; fi; }
hasnt(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ko "$1" "did not expect [$3] in [$r]"; else ok "$1"; fi; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

SAM=a2000000-0000-4000-8000-000000000001
ANA=a2000000-0000-4000-8000-000000000002
MIA=a2000000-0000-4000-8000-000000000003
OLGA=a2000000-0000-4000-8000-000000000004
OTTO=a2000000-0000-4000-8000-000000000005
CARL=a2000000-0000-4000-8000-000000000006
DIEGO=a2000000-0000-4000-8000-000000000007
R1=f2000000-0000-4000-8000-000000000001
R2=f2000000-0000-4000-8000-000000000002
CORP=c2000000-0000-4000-8000-000000000001
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }
as_owner(){ echo "SET LOCAL ROLE postgres;"; }

TABLES="rides ride_transitions ride_pricing_snapshots ride_messages users driver_profiles driver_documents
  driver_score_events driver_contracts selfie_checks wallet_accounts ledger_transactions ledger_entries
  wallet_transfers wallet_recharge_requests wallet_receipts cancellation_penalties reviews ticket_messages
  support_tickets ride_disputes incident_reports lost_items fraud_alerts cancellation_reviews
  corporate_accounts corporate_employees corporate_rides driver_fleets fleet_members promotions referrals
  stuck_ride_alerts"
VIEWS="panel_rides panel_driver_profiles panel_driver_documents panel_driver_churn_risk panel_ride_disputes
  panel_incident_reports panel_lost_items"
# The bodies 00668 patches, as measured in prod on 2026-10-25 (md5 of prosrc).
OLD_BODIES="_panel_driver_churn_risk()=20240a8b10635d4349bc31b96ef0eb50,_support_alert(uuid,text)=1ee5af719375723f47a7e17e037c0781,_team_lock_target(uuid,uuid)=bf7977def160b0af45d331f6c8ba6aa8,_team_role_rank(text)=b4d7921637a5ce8ac112b1ccf2b4c47e,admin_active_ride_context(uuid)=648f573019cac9a07b8f6c0bc9b53cf1,admin_get_online_fleet()=16cae4581898b17f1f0da664e1424c9e,admin_incomplete_driver_signups()=65aad048b3031c8398c21cf3649bd47f,admin_launch_pulse(integer)=bb5d37a5bca57a64d3e3409ada2dd6b6,admin_ride_assist_candidates(uuid,text)=8fc752f5230186f458d8b81ce1f82bad,admin_ride_assist_context(uuid)=b4f972c16a8105000b473584b2d9972e,admin_support_waiting_rides()=cf28c7189a299171fbc876981cab0fde,apply_user_rating(uuid)=96be8c154990651738312ef44861242f,create_team_invitation(text,text,text)=208a91a24bdde5104dc298616aa41668,enforce_ride_transition()=f806997fab31c18e7b369e69f5321c30,ensure_driver_role_and_tricicoin_on_approval()=1940d4379a446c8afdf0d47434945c07,get_admin_dashboard_metrics()=32cec76d3f079f6938b09f8bb7e919b2,get_admin_wallet_stats()=0f937c94cda1d26e7dd2da7d574949dd,get_corporate_balance(uuid)=3f0a78535f6f62def35d7544abead12c,get_corporate_employees(uuid)=707be40934363bf3444de3c66d573e4c,get_driver_utilization()=deb8280b477f4dc4ccf64acfcdd0cafa,get_peak_hours(integer)=29e882b3dfbf6c3f2d5ad5946d04e3d8,get_product_failures(integer)=57a40ccc37b3efd3f6053804d922b03e,get_rides_by_day(integer)=fd5363b072a17da61325a23cfd1486af,get_rides_by_payment_method(integer)=2ecacefdfef6c96da84d3b2f20a0b138,get_rides_by_service_type(integer)=ffd6c633752a21bba4945625fc9aaaaf,get_top_drivers(integer)=03e7be0213769612782ed3bcb0183f3a,list_team()=3caa19878a9f42757340073dd44a8e63,set_team_member_role(uuid,text,text)=0efaca07aab64cbebde239d4db8515b6,team_digest_recipients()=07045d8aa3abed148082614ba441e01e"
NEW_BODIES="_panel_driver_churn_risk()=afa2e6a392bdf498d226d1e8db94ebf9,_support_alert(uuid,text)=992c2ce11b664d72e437a683170abb97,_team_lock_target(uuid,uuid)=de70508776541e934d4225ce6e3c3510,_team_role_rank(text)=149307088a8dbbcb9eebb662187e260b,admin_active_ride_context(uuid)=76344d251a2f75b1d4c9f4f059131668,admin_get_online_fleet()=09160feb71a0436f0ceb5648ccba2081,admin_incomplete_driver_signups()=8b9c5c6014c48768b51735b199d34d81,admin_launch_pulse(integer)=8a1937bbe51baf3772cfd067f7d3df2e,admin_ride_assist_candidates(uuid,text)=18ec24b4eff82a82c401df6889eb399c,admin_ride_assist_context(uuid)=2b7a2a9cb6ca0566c3fde8614220e91a,admin_support_waiting_rides()=6220ecbb3b398b62c22dc2534ce55570,apply_user_rating(uuid)=855ff6a7587434d60c8e45c2112cf7a3,create_team_invitation(text,text,text)=fba442720206be555335875c37968405,enforce_ride_transition()=0f18b49d2d65e00923fa7f8d136b2387,ensure_driver_role_and_tricicoin_on_approval()=ee418d59c865532fcdb6df0af3b991b2,get_admin_dashboard_metrics()=8b5f98c002141541b6837511ccee100c,get_admin_wallet_stats()=21cd9a7f16058d01740029b430cf13d9,get_corporate_balance(uuid)=b607f588cce860b868a53755ecbbcd7a,get_corporate_employees(uuid)=64e9679cb6d0b677dda93a6490bd465b,get_driver_utilization()=1f4c8030ad426c728d47008afe6567fb,get_peak_hours(integer)=9cc7e8ba4a44a026e5c7a02c939ad466,get_product_failures(integer)=f735ec7c60ad2405226983505677fe0a,get_rides_by_day(integer)=339b0f0dbf075ea8c470097be5495bb1,get_rides_by_payment_method(integer)=beb36eb41b576ec41e81430e9f6e8308,get_rides_by_service_type(integer)=1cd2058668e150fb7ce5d228cb9ab389,get_top_drivers(integer)=b3b7bfa483c01f678c53b05fb35d2942,list_team()=54b81a4f2941beff89205a37c95f8fc9,set_team_member_role(uuid,text,text)=e835ab6ff0f4b4f7310aca565ba08e80,team_digest_recipients()=a64e560f1aef14b8b1a782865d5624c9"
CREATED="_sos_staff_alert()=48cd587078324579a75543d10f809436,is_operator()=16438eb527af61eaa2d0b3d9a53f08f9,is_ops_staff()=d6774e4677be1072e66b247492e9cb9a"
PATCHED_LIST="'_panel_driver_churn_risk()','_support_alert(uuid,text)','_team_lock_target(uuid,uuid)','_team_role_rank(text)','admin_active_ride_context(uuid)','admin_get_online_fleet()','admin_incomplete_driver_signups()','admin_launch_pulse(integer)','admin_ride_assist_candidates(uuid,text)','admin_ride_assist_context(uuid)','admin_support_waiting_rides()','apply_user_rating(uuid)','create_team_invitation(text,text,text)','enforce_ride_transition()','ensure_driver_role_and_tricicoin_on_approval()','get_admin_dashboard_metrics()','get_admin_wallet_stats()','get_corporate_balance(uuid)','get_corporate_employees(uuid)','get_driver_utilization()','get_peak_hours(integer)','get_product_failures(integer)','get_rides_by_day(integer)','get_rides_by_payment_method(integer)','get_rides_by_service_type(integer)','get_top_drivers(integer)','list_team()','set_team_member_role(uuid,text,text)','team_digest_recipients()'"
BODIES="SET search_path = public, pg_catalog; SELECT string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text COLLATE \"C\")
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.oid::regprocedure::text IN ($PATCHED_LIST)"
CREATED_BODIES="SET search_path = public, pg_catalog; SELECT string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc), ',' ORDER BY p.oid::regprocedure::text COLLATE \"C\")
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('is_operator','is_ops_staff','_sos_staff_alert')"
# The views as deparsed with search_path = pg_catalog, measured in prod on 2026-10-25.
OLD_VIEWS="panel_driver_churn_risk=b87b6f0bc8d28b876f83689b321f9186,panel_driver_documents=6d67c1d2cd218577e1d04c2778ffc163,panel_driver_profiles=0b033cc9fdbf0e9f2baa1c392e1e0dfc,panel_incident_reports=4188a17c7cc3a7de1038bc9097f0c4e8,panel_lost_items=ae8852916298e3a732f6f121c885568c,panel_ride_disputes=8ea3d38235a707ca52f26f245f5340f4,panel_rides=5669aa5ad6fc84317a5ae8eb9f48a40c"
VIEW_MD5="SET search_path = pg_catalog; SELECT string_agg(c.relname || '=' || md5(pg_get_viewdef(c.oid)), ',' ORDER BY c.relname COLLATE \"C\")
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname LIKE 'panel\_%'"
# G0: everything 00668 must leave as it was. Function bodies and grants (minus the ones it patches
# or creates), policies (minus the ones it creates or alters), views (minus the panel ones and its
# own), table grants, constraints (minus the team CHECK) and triggers (minus its own).
SNAP="SET search_path = pg_catalog; SELECT md5(string_agg(x, '|' ORDER BY x COLLATE \"C\")) FROM (
  SELECT 'f:' || p.oid::regprocedure::text || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef::text AS x
  FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'storage'::regnamespace, 'auth'::regnamespace)
    AND replace(p.oid::regprocedure::text, 'public.', '') NOT IN ($PATCHED_LIST, 'is_operator()', 'is_ops_staff()', '_sos_staff_alert()')
  UNION ALL
  SELECT 'p:' || schemaname || '.' || tablename || '.' || policyname || ':' || cmd || ':' || roles::text || ':' || permissive || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
  FROM pg_policies WHERE policyname NOT LIKE '%\_operator' AND NOT (tablename = 'vehicles' AND policyname = 'v_admin_select')
  UNION ALL
  SELECT 'v:' || c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
    AND c.relname NOT LIKE 'panel\_%' AND c.relname <> 'ops_delivery_details'
  UNION ALL
  SELECT 'g:' || table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type
  FROM information_schema.role_table_grants WHERE table_schema IN ('public', 'storage') AND table_name <> 'ops_delivery_details'
  UNION ALL
  SELECT 'c:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname <> 'team_invitations_role_check'
  UNION ALL
  SELECT 't:' || tgrelid::regclass::text || ':' || tgname || ':' || tgenabled FROM pg_trigger
  WHERE NOT tgisinternal AND tgname <> 'incident_reports_sos_staff_alert'
) s"

build(){ # build DB [noenum] -> stubs, prod objects, 00667 (unless noenum), seed (unless noenum)
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/stubs.sql" >/dev/null || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "SET ROLE postgres" -f "$DIR/prod-objects.sql" >/dev/null || return 1
  [ "${2:-}" = noenum ] && return 0
  [ "$(apply_err "$1" "$ENUM")" = applied ] || return 1
  $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null || return 1
}

echo "== building $DB"
build "$DB" || { echo "FATAL: could not build $DB"; exit 2; }

# S0: the scaffold is prod -------------------------------------------------------------------
val "S0.1 the patched functions have prod's bodies" "$BODIES" "$OLD_BODIES"
val "S0.2 the panel views have prod's definitions" "$VIEW_MD5" "$OLD_VIEWS"
val "S0.3 is_admin() has prod's body (00592)" "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.is_admin()'::regprocedure" "22cb75e91980d512498034cd33e1eda2"
val "S0.4 00667 added the operator value" "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'user_role' AND e.enumlabel = 'operator'" "1"

# What the other roles read before 00668, and the snapshot of everything else.
for who in CARL MIA ANA; do
  uid=${!who}
  for t in $TABLES $VIEWS; do
    echo "$who:$t:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM public.$t; ROLLBACK;")"
  done
  echo "$who:storage:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM storage.objects; ROLLBACK;")"
  echo "$who:vehicles:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM public.vehicles; ROLLBACK;")"
done > "$TMP/before"
SNAP_BEFORE=$(run "$DB" "$SNAP")

if [ "$MIG" != none ]; then
  for i in 1 2; do
    r=$(apply_err "$DB" "$MIG")
    if [ "$r" = applied ]; then ok "M$i 00668 applies (run $i)"; else ko "M$i 00668 applies (run $i)" "$r"; fi
  done
fi

# T1: helpers --------------------------------------------------------------------------------
val "T1.1 operator: is_operator and is_ops_staff" "BEGIN; $(as_user $OLGA) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "t|t"
val "T1.2 admin: ops staff, not an operator" "BEGIN; $(as_user $ANA) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "f|t"
val "T1.3 super admin: ops staff" "BEGIN; $(as_user $SAM) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "f|t"
val "T1.4 marketing: neither" "BEGIN; $(as_user $MIA) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "f|f"
val "T1.5 customer: neither" "BEGIN; $(as_user $CARL) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "f|f"
val "T1.6 anon: neither, without an error" "BEGIN; $(as_anon) SELECT public.is_operator(), public.is_ops_staff(); ROLLBACK;" "f|f"

# T2: the operator reads every table of its pages -------------------------------------------
for t in $TABLES; do
  total=$(run "$DB" "SELECT count(*) FROM public.$t")
  got=$(run "$DB" "BEGIN; $(as_user $OLGA) SELECT count(*) FROM public.$t; ROLLBACK;")
  if [ "$total" -ge 1 ] 2>/dev/null && [ "$got" = "$total" ]; then ok "T2 operator reads $t"; else ko "T2 operator reads $t" "$got of $total"; fi
done
val "T2.v operator reads vehicles" "BEGIN; $(as_user $OLGA) SELECT count(*) FROM public.vehicles; ROLLBACK;" "1"
val "T2.s operator reads the three buckets and nothing else" \
  "BEGIN; $(as_user $OLGA) SELECT string_agg(bucket_id, ',' ORDER BY bucket_id) FROM storage.objects; ROLLBACK;" \
  "driver-contracts,driver-documents,receipts"

# T3: views ----------------------------------------------------------------------------------
for v in $VIEWS; do
  base=$(run "$DB" "SET search_path = pg_catalog; SELECT count(*) FROM public.$v")
  got=$(run "$DB" "BEGIN; $(as_user $OLGA) SELECT count(*) FROM public.$v; ROLLBACK;")
  # As the owner every gate is false (no JWT), so compare with what an admin reads.
  adm=$(run "$DB" "BEGIN; $(as_user $ANA) SELECT count(*) FROM public.$v; ROLLBACK;")
  if [ "$got" = "$adm" ]; then ok "T3 operator reads $v like an admin ($got rows)"; else ko "T3 operator reads $v like an admin" "operator $got, admin $adm (owner $base)"; fi
done
val "T3.d ops_delivery_details: the operator reads the delivery" \
  "BEGIN; $(as_user $OLGA) SELECT recipient_name FROM public.ops_delivery_details; ROLLBACK;" "Rosa"
val "T3.e ops_delivery_details has no delivery code" \
  "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ops_delivery_details' AND column_name = 'delivery_otp'" "0"
val "T3.f ops_delivery_details shows a customer nothing" \
  "BEGIN; $(as_user $CARL) SELECT count(*) FROM public.ops_delivery_details; ROLLBACK;" "0"
has "T3.g ops_delivery_details refuses anon" \
  "BEGIN; $(as_anon) SELECT count(*) FROM public.ops_delivery_details; ROLLBACK;" "permission denied"
val "T3.h panel_rides counts an operator's cancel as staff's" \
  "BEGIN; $(as_user $ANA) UPDATE public.rides SET status = 'canceled', canceled_by = '$OLGA' WHERE id = '$R1'; SELECT canceled_by_role FROM public.panel_rides WHERE id = '$R1'; ROLLBACK;" "staff"

# T4: the other roles read exactly what they read before --------------------------------------
if [ "$MIG" != none ]; then
  for who in CARL MIA ANA; do
    uid=${!who}
    for t in $TABLES $VIEWS; do
      echo "$who:$t:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM public.$t; ROLLBACK;")"
    done
    echo "$who:storage:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM storage.objects; ROLLBACK;")"
    echo "$who:vehicles:$(run "$DB" "BEGIN; $(as_user "$uid") SELECT count(*) FROM public.vehicles; ROLLBACK;")"
  done > "$TMP/after"
  if diff -q "$TMP/before" "$TMP/after" >/dev/null; then ok "T4 customer, marketing and admin read what they read before"
  else ko "T4 customer, marketing and admin read what they read before" "$(diff "$TMP/before" "$TMP/after" | tr '\n' ' ')"; fi
fi

# T5: read gates -----------------------------------------------------------------------------
gate(){ # gate NAME SQL MESSAGE
  local r
  r=$(run "$DB" "BEGIN; $(as_user $CARL) $2; ROLLBACK;")
  if echo "$r" | grep -q -- "$3"; then ok "T5 $1 refuses a customer"; else ko "T5 $1 refuses a customer" "got [$r]"; fi
  r=$(run "$DB" "BEGIN; $(as_user $OLGA) $2; ROLLBACK;")
  if echo "$r" | grep -q -- "$3"; then ko "T5 $1 lets the operator through" "got [$r]"; else ok "T5 $1 lets the operator through"; fi
}
gate get_admin_dashboard_metrics "SELECT public.get_admin_dashboard_metrics()" "forbidden: admin only"
gate get_admin_wallet_stats "SELECT public.get_admin_wallet_stats()" "forbidden: admin only"
gate get_rides_by_day "SELECT count(*) FROM public.get_rides_by_day(7)" "Forbidden: admin role required"
gate get_rides_by_service_type "SELECT count(*) FROM public.get_rides_by_service_type(7)" "Forbidden: admin role required"
gate get_rides_by_payment_method "SELECT count(*) FROM public.get_rides_by_payment_method(7)" "Forbidden: admin role required"
gate get_top_drivers "SELECT count(*) FROM public.get_top_drivers(5)" "forbidden: admin only"
gate get_peak_hours "SELECT count(*) FROM public.get_peak_hours(7)" "forbidden: admin only"
gate get_driver_utilization "SELECT count(*) FROM public.get_driver_utilization()" "forbidden: admin only"
gate get_product_failures "SELECT public.get_product_failures(7)" "Admin only"
gate admin_launch_pulse "SELECT public.admin_launch_pulse(8)" "Admin only"
gate admin_incomplete_driver_signups "SELECT count(*) FROM public.admin_incomplete_driver_signups()" "Admin only"
gate admin_support_waiting_rides "SELECT public.admin_support_waiting_rides()" "forbidden"
gate admin_ride_assist_context "SELECT public.admin_ride_assist_context('$R1')" "forbidden"
gate admin_ride_assist_candidates "SELECT public.admin_ride_assist_candidates('$R1', 'triciclo_basico')" "forbidden"
gate admin_active_ride_context "SELECT public.admin_active_ride_context('$R1')" "forbidden"
gate admin_get_online_fleet "SELECT count(*) FROM public.admin_get_online_fleet()" "Forbidden: admin role required"
gate get_corporate_balance "SELECT public.get_corporate_balance('$CORP')" "Solo un administrador de la empresa"
gate get_corporate_employees "SELECT count(*) FROM public.get_corporate_employees('$CORP')" "Solo un administrador de la empresa"
val "T5.f the live fleet lists the online driver to the operator" \
  "BEGIN; $(as_user $OLGA) SELECT full_name FROM public.admin_get_online_fleet(); ROLLBACK;" "Diego Conductor"
has "T5.m marketing still has no live fleet" \
  "BEGIN; $(as_user $MIA) SELECT count(*) FROM public.admin_get_online_fleet(); ROLLBACK;" "Forbidden: admin role required"

# T6: an operator rides as a passenger --------------------------------------------------------
val "T6.1 the operator cancels its own search, as a customer" \
  "BEGIN; $(as_user $OLGA) UPDATE public.rides SET status = 'canceled' WHERE id = '$R2'; RESET ROLE; SELECT actor_role FROM public.ride_transitions WHERE ride_id = '$R2' ORDER BY created_at DESC LIMIT 1; ROLLBACK;" \
  "customer"

# T7: support alert pushes --------------------------------------------------------------------
val "T7.1 a help alert reaches active operators and admins, not marketing nor an inactive operator" \
  "BEGIN; $(as_owner) DELETE FROM public.test_http_calls; SELECT public._support_alert('$R1', 'help'); SELECT string_agg(u, ',' ORDER BY u) FROM public.test_http_calls c, jsonb_array_elements_text(c.body->'user_ids') u; ROLLBACK;" \
  "$SAM,$ANA,$OLGA"

# T8: SOS push --------------------------------------------------------------------------------
SOS1=b2000000-0000-4000-8000-000000000001
SOS2=b2000000-0000-4000-8000-000000000002
SOS3=b2000000-0000-4000-8000-000000000003
val "T8.1 an SOS pushes active operators and admins, with the incident link" \
  "BEGIN; $(as_owner) DELETE FROM public.test_http_calls; INSERT INTO public.incident_reports (id, type, reported_by) VALUES ('$SOS1', 'sos', '$CARL'); SELECT c.jobname || ' ' || (SELECT string_agg(u, ',' ORDER BY u) FROM jsonb_array_elements_text(c.body->'user_ids') u) || ' ' || (c.body->'data'->>'url') FROM public.test_http_calls c; ROLLBACK;" \
  "sos-staff-alert $SAM,$ANA,$OLGA https://admin.tricigo.com/incidents/$SOS1"
val "T8.2 a second SOS of the same person within a minute pushes once" \
  "BEGIN; $(as_owner) DELETE FROM public.test_http_calls; INSERT INTO public.incident_reports (id, type, reported_by) VALUES ('$SOS1', 'sos', '$CARL'), ('$SOS2', 'sos', '$CARL'); SELECT count(*) FROM public.test_http_calls; ROLLBACK;" \
  "1"
val "T8.3 an operator's own SOS does not push the operator" \
  "BEGIN; $(as_owner) DELETE FROM public.test_http_calls; INSERT INTO public.incident_reports (id, type, reported_by) VALUES ('$SOS3', 'sos', '$OLGA'); SELECT string_agg(u, ',' ORDER BY u) FROM public.test_http_calls c, jsonb_array_elements_text(c.body->'user_ids') u; ROLLBACK;" \
  "$SAM,$ANA"
val "T8.4 another kind of incident pushes nobody" \
  "BEGIN; $(as_owner) DELETE FROM public.test_http_calls; INSERT INTO public.incident_reports (type, reported_by) VALUES ('safety_concern', '$CARL'); SELECT count(*) FROM public.test_http_calls; ROLLBACK;" \
  "0"
val "T8.5 a failing push never refuses the SOS, and is logged" \
  "BEGIN; SET LOCAL test.http_fail = '1'; $(as_owner) INSERT INTO public.incident_reports (id, type, reported_by) VALUES ('$SOS1', 'sos', '$CARL'); SELECT (SELECT count(*) FROM public.incident_reports WHERE id = '$SOS1') || ' ' || (SELECT outcome FROM public.test_rpc_log WHERE rpc_name = '_sos_staff_alert'); ROLLBACK;" \
  "1 alert_failed"
val "T8.6 without the service key the SOS is kept and the failure logged" \
  "BEGIN; SET LOCAL test.no_key = '1'; $(as_owner) INSERT INTO public.incident_reports (id, type, reported_by) VALUES ('$SOS1', 'sos', '$CARL'); SELECT (SELECT count(*) FROM public.incident_reports WHERE id = '$SOS1') || ' ' || (SELECT metadata->>'error' FROM public.test_rpc_log WHERE rpc_name = '_sos_staff_alert'); ROLLBACK;" \
  "1 no service role key"

# T9: team -----------------------------------------------------------------------------------
val "T9.1 an operator ranks with marketing" "SELECT public._team_role_rank('operator'), public._team_role_rank('marketing')" "1|1"
hasnt "T9.2 a super admin invites an operator" \
  "BEGIN; $(as_user $SAM) SELECT public.create_team_invitation('nueva@example.com', 'operator', 'Nueva Operadora'); ROLLBACK;" "team_bad_role"
val "T9.3 the invitation is stored for the operator role" \
  "BEGIN; $(as_user $SAM) SELECT public.create_team_invitation('nueva@example.com', 'operator', 'Nueva Operadora'); RESET ROLE; SELECT role FROM public.team_invitations WHERE email = 'nueva@example.com'; ROLLBACK;" "operator"
has "T9.4 the team list shows the operator" \
  "BEGIN; $(as_user $SAM) SELECT public.list_team()::text; ROLLBACK;" "$OLGA"
val "T9.5 a super admin moves marketing to operator" \
  "BEGIN; $(as_user $SAM) SELECT public.set_team_member_role('$MIA', 'operator', 'Pasa a operaciones'); RESET ROLE; SELECT role FROM public.users WHERE id = '$MIA'; ROLLBACK;" "operator"
val "T9.6 the daily digest goes to the active operator" \
  "BEGIN; $(as_owner) SELECT string_agg(role::text, ',') FROM public.team_digest_recipients() WHERE user_id = '$OLGA'; ROLLBACK;" "operator"

# T10: nothing of money, roles or settings opens -----------------------------------------------
has "T10.1 the operator cannot change a level" \
  "BEGIN; $(as_user $OLGA) SELECT public.admin_set_user_level('$CARL', 'oro', 'Prueba de nivel'); ROLLBACK;" "ERROR"
has "T10.2 the operator cannot promote anyone" \
  "BEGIN; $(as_user $OLGA) SELECT public.promote_user_role('$CARL', 'admin', 'Prueba de rol'); ROLLBACK;" "ERROR"
has "T10.3 the operator cannot block an account yet" \
  "BEGIN; $(as_user $OLGA) SELECT public.admin_set_user_active('$CARL', false, 'Prueba de bloqueo'); ROLLBACK;" "ERROR"

if [ "$MIG" != none ]; then
  # G: what 00668 leaves -----------------------------------------------------------------------
  val "G1 the patched bodies are the expected ones" "$BODIES" "$NEW_BODIES"
  val "G2 the created bodies are the expected ones" "$CREATED_BODIES" "$CREATED"
  val "G0 nothing else changed" "$SNAP" "$SNAP_BEFORE"

  # CRLF copy on a fresh database ---------------------------------------------------------------
  "$PY" -c "import sys; s=open(sys.argv[1], encoding='utf-8', newline='').read().replace('\r\n', '\n'); open(sys.argv[2], 'w', encoding='utf-8', newline='').write(s.replace('\n', '\r\n'))" "$MIG" "$TMP/crlf.sql"
  if build "${DB}crlf"; then
    r=$(apply_err "${DB}crlf" "$TMP/crlf.sql")
    if [ "$r" = applied ]; then ok "C2 the CRLF copy applies"; else ko "C2 the CRLF copy applies" "$r"; fi
    val "C3 the CRLF copy leaves the expected bodies" "$CREATED_BODIES" "$CREATED" "${DB}crlf"
    val "C4 the CRLF copy patches to the expected bodies" "$BODIES" "$NEW_BODIES" "${DB}crlf"
  else
    ko "C2 the CRLF copy applies" "could not build ${DB}crlf"
  fi

  # Negative proofs of the file's checks --------------------------------------------------------
  neg(){ # neg NAME TAMPER_SQL EXPECTED_ERROR -> on a copy of the GREEN database
    $BIN/dropdb $CONN --if-exists "${DB}neg" >/dev/null 2>&1
    $BIN/createdb $CONN -T "$DB" "${DB}neg" >/dev/null 2>&1 || { ko "$1" "could not copy $DB"; return; }
    run "${DB}neg" "SET ROLE postgres; $2" >/dev/null
    local r; r=$(apply_err "${DB}neg" "$MIG")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi
  }
  neg "N1 a wider policy that mentions the operator aborts" \
    "CREATE POLICY rides_insert_operator ON public.rides FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_operator()));" \
    "unexpected policies mention the operator"
  neg "N2 a function that mentions the operator aborts" \
    "CREATE FUNCTION public.zz_probe() RETURNS boolean LANGUAGE sql AS 'SELECT public.is_operator()';" \
    "unexpected functions mention the operator"
  neg "N3 a money function that names the operator aborts" \
    "DO \$d\$ DECLARE v regprocedure := (SELECT oid FROM pg_proc WHERE proname = 'freeze_wallet' AND pronamespace = 'public'::regnamespace LIMIT 1); BEGIN EXECUTE replace(pg_get_functiondef(v), 'BEGIN', E'BEGIN\n  -- ''operator''\n'); END \$d\$;" \
    "must stay closed to the operator"
  neg "N4 a panel view without the gate aborts" \
    "CREATE VIEW public.panel_probe AS SELECT 1 AS x;" \
    "does not end in the admin, marketing or operator gate"
  neg "N5 a changed is_admin() aborts" \
    "CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS \$f\$ BEGIN RETURN false; END \$f\$;" \
    "is_admin() is not the body of 00592"
  neg "N6 a widened table policy aborts" \
    "ALTER POLICY rides_select_operator ON public.rides USING (true);" \
    "policy rides_select_operator is"
  neg "N7 a widened storage policy aborts" \
    "ALTER POLICY storage_receipts_select_operator ON storage.objects USING (true);" \
    "storage policy storage_receipts_select_operator is"
  neg "N8 a body this file does not know aborts" \
    "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.get_peak_hours(integer)'::regprocedure), 'IF NOT', '-- changed
  IF NOT'); END \$d\$;" \
    "has a body this file does not know"

  # Without 00667 the file refuses to run -------------------------------------------------------
  if build "${DB}noenum" noenum; then
    r=$(apply_err "${DB}noenum" "$MIG")
    if echo "$r" | grep -q "needs 00667"; then ok "N0 without 00667 the file refuses"; else ko "N0 without 00667 the file refuses" "$r"; fi
  else
    ko "N0 without 00667 the file refuses" "could not build ${DB}noenum"
  fi
fi

echo
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
