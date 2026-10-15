#!/usr/bin/env bash
# Rehearsal runner for migration 00663 (marketing reads more of the admin panel).
# Builds prod as of 2026-10-15: the 00642 rehearsal scaffold (prod on 2026-10-08) with 00641 and
# 00642 applied and Mara made marketing, then scaffold.sql and seed.sql of this folder.
#   supabase/tests/00663/run.sh none
#       -> prod + tests (RED: marketing reads none of the new data and cannot answer support)
#   supabase/tests/00663/run.sh supabase/migrations/00663_marketing_wider_view.sql
#       -> the same + 00663 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed nothing else, a CRLF copy applied to a fresh database, and negative proofs of
#          the file's own checks
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
# The main database (pr663) stays for inspection; the CRLF and negative-proof ones are dropped.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr663
ENUM="$ROOT/supabase/migrations/00641_marketing_role_enum.sql"
M642="$ROOT/supabase/migrations/00642_marketing_role_permissions.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d)
cleanup(){
  local d
  for d in ${DB}crlf ${DB}neg; do $BIN/dropdb $CONN --if-exists "$d" >/dev/null 2>&1; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }
nomatch(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ko "$1" "did not expect [$3], got [$r]"; else ok "$1"; fi; }

ANA=a0000000-0000-4000-8000-000000000001
CARLA=c0000000-0000-4000-8000-000000000001
DIEGO=c0000000-0000-4000-8000-000000000002
MARA=c0000000-0000-4000-8000-000000000003
SAM=c0000000-0000-4000-8000-000000000009
TESTU=c0000000-0000-4000-8000-000000000008
SYS1=00000000-0000-0000-0000-000000000001
SYS99=00000000-0000-0000-0000-000000000099
DIEGO_DP=d0000000-0000-4000-8000-000000000002
RIDE_X=f0000000-0000-4000-8000-000000000010
RIDE_C=f0000000-0000-4000-8000-000000000011
REV_PUB=b0000000-0000-4000-8000-000000000001
REV_PRIV=b0000000-0000-4000-8000-000000000002
T1=b1000000-0000-4000-8000-000000000001
T_MARA=b1000000-0000-4000-8000-000000000003
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }

LIVE_OLD="admin_incomplete_driver_signups=2841ccd9b2c3f9cb3804a361097e22d3,admin_list_pois=c4646cc85b1bd83c65bf11974d49fbfd,get_auto_accept_rate=d287cc0735f48cb5d621d71b82bd0456,get_auto_nav_rate=ea732c6b23a1f3654f44d52077e3bd70,get_override_frequency=32d90734b10ec562591c9362b61f11a7,list_poi_submissions=6b1551aa33141886c0a9d0ac9a6bb616,tg_ticket_messages_client_guard=27dfd5fae754370a8554fd7c52f993cc"
# Computed in prod on 2026-10-15 as md5(replace(prosrc, <target>, <replacement>)).
LIVE_NEW="admin_incomplete_driver_signups=65aad048b3031c8398c21cf3649bd47f,admin_list_pois=0fd97f9da45bb7fddce9350acfec7fe6,get_auto_accept_rate=6f20da2215bf11febeeba716589ca74a,get_auto_nav_rate=c763c447e0ac0d61f150757efc543bad,get_override_frequency=e7ad623472e2f8f2e180f05bf2c172fb,list_poi_submissions=5bb221cc967fa33857a39ea963cd560c,tg_ticket_messages_client_guard=96297a4de1f620d1e545e21643268224"
LIVE_NAMES="'admin_incomplete_driver_signups','admin_list_pois','get_auto_accept_rate','get_auto_nav_rate','get_override_frequency','list_poi_submissions','tg_ticket_messages_client_guard'"
CREATED_FNS="'_panel_driver_churn_risk','get_product_failures','tg_support_tickets_client_update_guard'"
BODIES="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN ($LIVE_NAMES)"
CREATED_BODIES="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN ($CREATED_FNS)"
VIEWS="'panel_rides','panel_driver_profiles','panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports','panel_lost_items'"
NEW_VIEWS="'panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports','panel_lost_items'"
NEW_POLICIES="'reviews_select_marketing','support_tickets_select_marketing','support_tickets_update_marketing','ticket_messages_select_marketing','ticket_messages_insert_marketing','ride_transitions_select_marketing','ride_pricing_snapshots_select_marketing','driver_score_events_select_marketing','driver_outreach_log_select_marketing'"
# Columns no panel view may carry (the migration's global list).
FORBIDDEN="'share_token','share_token_expires_at','pickup_location','dropoff_location','actual_dropoff_location',
  'pickup_lat','pickup_lng','dropoff_lat','dropoff_lng','current_location','current_heading','identity_number',
  'address','has_criminal_record','criminal_record_details','negative_balance_since','storage_path','file_name',
  'face_match_score','liveness_passed','evidence_urls','respondent_evidence_urls','refund_amount_trc',
  'refund_transaction_id','admin_notes','earnings_this_week','earnings_last_week','pickup_notes','dropoff_notes',
  'wallet_amount_cup','cash_amount_cup','payment_intent_id','return_location','return_notes'"
# G0: everything 00663 must leave as it was. Functions (body, except the seven it patches; grants;
# definer; settings), policies, table and view grants, RLS flags and options, view definitions,
# column grants and triggers, minus only what the file creates.
SNAP="SELECT md5(string_agg(x, '|' ORDER BY x COLLATE \"C\")) FROM (
  SELECT 'f:' || p.oid::regprocedure || ':' || CASE WHEN p.proname IN ($LIVE_NAMES) THEN '' ELSE md5(p.prosrc) END
         || ':' || coalesce(p.proacl::text, '') || ':' || p.prosecdef || ':' || coalesce(array_to_string(p.proconfig, ','), '') AS x
  FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND p.proname NOT IN ($CREATED_FNS)
  UNION ALL SELECT 'p:' || tablename || ':' || policyname || ':' || permissive || ':' || cmd || ':' || roles::text
         || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '')
  FROM pg_policies WHERE schemaname IN ('public', 'auth') AND policyname NOT IN ($NEW_POLICIES)
  UNION ALL SELECT 'g:' || c.oid::regclass || ':' || c.relkind::text || ':' || coalesce(c.relacl::text, '') || ':' || c.relrowsecurity
         || ':' || c.relforcerowsecurity || ':' || coalesce(array_to_string(c.reloptions, ','), '')
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND c.relname NOT IN ($NEW_VIEWS)
  UNION ALL SELECT 'v:' || c.oid::regclass || ':' || md5(pg_get_viewdef(c.oid))
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND c.relname NOT LIKE 'panel\\_%'
  UNION ALL SELECT 'a:' || a.attrelid::regclass || '.' || a.attname || ':' || a.attacl::text
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  WHERE c.relnamespace = 'public'::regnamespace AND a.attacl IS NOT NULL
  UNION ALL SELECT 't:' || tgrelid::regclass || ':' || tgname || ':' || tgfoid::regprocedure || ':' || tgenabled::text
         || ':' || tgtype || ':' || tgattr::text || ':' || coalesce(pg_get_triggerdef(oid), '')
  FROM pg_trigger WHERE NOT tgisinternal AND tgname <> 'trg_support_tickets_client_update_guard') s"

psqlf(){ $BIN/psql $CONN -d "$1" -q -v ON_ERROR_STOP=1 "${@:2}"; }
load(){ local db=$1 i
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  psqlf "$db" -f "$ROOT/supabase/tests/00642/scaffold.sql" >"$TMP/s642.out" 2>&1 || { echo "00642 scaffold failed:"; cat "$TMP/s642.out"; exit 1; }
  for i in 1 2; do psqlf "$db" -c "$AS_OWNER" -f "$ENUM" >"$TMP/enum.out" 2>&1 || { echo "00641 failed:"; cat "$TMP/enum.out"; exit 1; }; done
  psqlf "$db" -c "UPDATE public.users SET role = 'marketing' WHERE id = '$MARA'" >/dev/null 2>&1 || { echo "could not make Mara marketing"; exit 1; }
  psqlf "$db" -1 -c "$AS_OWNER" -f "$M642" >"$TMP/m642.out" 2>&1 || { echo "00642 failed:"; cat "$TMP/m642.out"; exit 1; }
  psqlf "$db" -f "$DIR/scaffold.sql" >"$TMP/s663.out" 2>&1 || { echo "00663 scaffold failed:"; cat "$TMP/s663.out"; exit 1; }
  psqlf "$db" -f "$DIR/seed.sql" >"$TMP/seed.out" 2>&1 || { echo "seed failed:"; cat "$TMP/seed.out"; exit 1; }
}
apply(){ psqlf "$1" -1 -c "$AS_OWNER" -f "$2" >"$TMP/mig.out" 2>&1; }

load $DB
# L1: the live bodies are prod's (before the migration).
val L1 "$BODIES" "$LIVE_OLD"
BEFORE=$(run $DB "$SNAP")

if [ "$MIG" != none ]; then
  apply $DB "$MIG" || { echo "migration failed on apply 1:"; cat "$TMP/mig.out"; exit 1; }
  apply $DB "$MIG" || { echo "migration failed on apply 2:"; cat "$TMP/mig.out"; exit 1; }
fi

# G0: nothing outside what 00663 creates or patches changed. A snapshot that failed would print an
# error, and two errors compare equal: each side must be an md5 first.
AFTER=$(run $DB "$SNAP")
if ! echo "$BEFORE" | grep -qE '^[0-9a-f]{32}$'; then ko G0 "the snapshot before the migration failed: [$BEFORE]"
elif ! echo "$AFTER" | grep -qE '^[0-9a-f]{32}$'; then ko G0 "the snapshot after the migration failed: [$AFTER]"
elif [ "$BEFORE" != "$AFTER" ]; then ko G0 "the migration changed something it does not own ($BEFORE -> $AFTER)"
else ok G0; fi

# --- Views ---------------------------------------------------------------------------------
val V1 "BEGIN; $(as_user $MARA) SELECT canceled_by_role, cancellation_reason FROM public.panel_rides WHERE id = '$RIDE_X'; ROLLBACK;" "customer|changed_plans"
# V2: not canceled (null), the customer, the driver, nobody (system), an admin (staff), and a
# customer who is not the ride's (unknown).
val V2 "BEGIN; $(as_user $MARA) SELECT string_agg(coalesce(canceled_by_role, '-'), ',' ORDER BY id) FROM public.panel_rides; ROLLBACK;" \
  "-,customer,-,driver,system,staff,unknown"
val V3 "BEGIN; $(as_user $MARA) SELECT full_name, plate_number, vehicle_type, municipality FROM public.panel_driver_profiles WHERE id = '$DIEGO_DP'; ROLLBACK;" "Diego Driver|P123456|triciclo|Plaza"
val V4 "BEGIN; $(as_user $MARA) SELECT document_type, is_verified FROM public.panel_driver_documents; ROLLBACK;" "national_id|t"
# V5: churn through the definer (the view under it is security_invoker over tables with RLS). Diego
# completed a ride two days ago: 2 days x 2 points, low. Pablo is not approved: no row.
val V5 "BEGIN; $(as_user $MARA) SELECT risk_level, churn_risk_score, days_since_last_ride,
  (SELECT count(*) FROM public.panel_driver_churn_risk) FROM public.panel_driver_churn_risk WHERE driver_profile_id = '$DIEGO_DP'; ROLLBACK;" "low|4|2|1"
val V6 "BEGIN; $(as_user $MARA) SELECT reason FROM public.panel_ride_disputes; ROLLBACK;" "overcharge"
val V7 "BEGIN; $(as_user $MARA) SELECT type FROM public.panel_incident_reports; ROLLBACK;" "rude_behavior"
val V8 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles),
  (SELECT count(*) FROM public.panel_driver_documents), (SELECT count(*) FROM public.panel_driver_churn_risk),
  (SELECT count(*) FROM public.panel_ride_disputes), (SELECT count(*) FROM public.panel_incident_reports),
  (SELECT count(*) FROM public.panel_lost_items); ROLLBACK;" "0|0|0|0|0|0|0"
val V10 "BEGIN; $(as_user $ANA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_documents),
  (SELECT count(*) FROM public.panel_ride_disputes), (SELECT count(*) FROM public.panel_lost_items); ROLLBACK;" "7|1|1|1"
# V11: no panel view carries a column that the spec keeps hidden (by name, so a later column fails
# too), nor one named like a coordinate.
val V11 "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name IN ($VIEWS) AND column_name IN ($FORBIDDEN)" "0"
val V11b "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'panel\\_%'
  AND column_name ~* '(_location|_lat|_lng|_lon|_coords?)\$'" "0"
val V12 "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ($NEW_VIEWS)" "5"
# V13: the live wait columns come through.
val V13 "BEGIN; $(as_user $MARA) SELECT wait_time_minutes, wait_time_charge_cup FROM public.panel_rides WHERE id = '$RIDE_C'; ROLLBACK;" "4|120"

# X1: the exact columns of every view the file creates or extends. panel_rides keeps 00642's
# first, in order; disputes show resolution_notes but not the ride's fares; incidents hide theirs.
X1_RIDES="panel_rides:id,created_at,status,customer_id,driver_id,service_type,city_id,estimated_fare_cup,final_fare_cup,final_fare_trc,payment_method,pickup_address,dropoff_address,promo_code_id,discount_amount_cup,shared_ride_discount_cup,dispatch_round,ride_mode,is_scheduled,scheduled_at,accepted_at,driver_arrived_at,pickup_at,arrived_at_destination_at,completed_at,canceled_at,canceled_by,canceled_by_role,cancellation_reason,cancellation_reason_code,estimated_distance_m,actual_distance_m,estimated_duration_s,actual_duration_s,wait_time_minutes,wait_time_charge_cup,passenger_count,shared_ride,is_split,corporate_account_id,partner_place_id,partner_discount_cup,tip_amount,surge_multiplier,driver_gps_status,searching_seen_at,last_dispatched_at,payment_status"
X1_DRIVERS="panel_driver_profiles:id,user_id,is_online,total_rides_completed,total_rides,status,rating_avg,acceptance_rate,total_rides_offered,city_id,zone_id,municipality,province,created_at,approved_at,suspended_at,suspended_reason,is_on_break,auto_accept_enabled,last_heartbeat_at,auto_offline_at,terms_accepted_at,full_name,phone,email,vehicle_type,plate_number,vehicle_make,vehicle_model,vehicle_color,vehicle_year"
X1_DOCS="panel_driver_documents:id,driver_id,document_type,uploaded_at,is_verified,verified_at,rejection_reason"
X1_CHURN="panel_driver_churn_risk:driver_profile_id,user_id,full_name,rating_avg,total_rides_completed,acceptance_rate,is_online,status,days_since_last_ride,churn_risk_score,risk_level"
X1_DISPUTES="panel_ride_disputes:id,ride_id,opened_by,reason,description,status,priority,respondent_id,respondent_message,respondent_replied_at,resolution,resolution_notes,assigned_to,sla_first_response_at,sla_resolution_deadline,support_ticket_id,incident_report_id,created_at,updated_at,resolved_at"
X1_INCIDENTS="panel_incident_reports:id,ride_id,reported_by,against_user_id,type,severity,description,status,resolved_by,resolved_at,created_at,updated_at,review_id"
X1_LOST="panel_lost_items:id,ride_id,reporter_id,driver_id,description,category,photo_urls,status,driver_response,driver_found,return_fee_cup,resolved_by,created_at,updated_at,resolved_at"
val X1 "SELECT string_agg(table_name || ':' || cols, ';' ORDER BY table_name) FROM (SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) cols
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ($VIEWS) GROUP BY table_name) x" \
  "$X1_CHURN;$X1_DOCS;$X1_DRIVERS;$X1_INCIDENTS;$X1_LOST;$X1_DISPUTES;$X1_RIDES"
# X1b: the columns each view keeps to admins, by name.
val X1b "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (
  ('panel_rides', 'wallet_ratio'), ('panel_ride_disputes', 'ride_estimated_fare_trc'), ('panel_ride_disputes', 'ride_final_fare_trc'),
  ('panel_incident_reports', 'resolution_notes'), ('panel_lost_items', 'return_location'), ('panel_lost_items', 'return_notes'),
  ('panel_lost_items', 'admin_notes'), ('panel_driver_churn_risk', 'earnings_this_week'))" "0"
# X2: the grant matrix of the seven views: SELECT for authenticated and service_role, nothing else.
X2_ROW="security_barrier=true,security_invoker=false:truefalsefalsetruefalse"
val X2 "SELECT string_agg(c.relname || ':' || array_to_string(c.reloptions, ',') || ':' || has_table_privilege('authenticated', c.oid, 'SELECT')
  || has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  || has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
  || has_table_privilege('service_role', c.oid, 'SELECT')
  || has_table_privilege('service_role', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'), ';' ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ($VIEWS)" \
  "panel_driver_churn_risk:$X2_ROW;panel_driver_documents:$X2_ROW;panel_driver_profiles:$X2_ROW;panel_incident_reports:$X2_ROW;panel_lost_items:$X2_ROW;panel_ride_disputes:$X2_ROW;panel_rides:$X2_ROW"
# X3: nobody writes through the views (simple views are auto-updatable; only the grants stop it).
err X3a "BEGIN; $(as_user $MARA) UPDATE public.panel_driver_documents SET is_verified = false; ROLLBACK;" "permission denied for view panel_driver_documents"
err X3b "BEGIN; $(as_user $MARA) UPDATE public.panel_ride_disputes SET status = 'resolved'; ROLLBACK;" "permission denied for view panel_ride_disputes"
err X3c "BEGIN; $(as_user $ANA) DELETE FROM public.panel_incident_reports; ROLLBACK;" "permission denied for view panel_incident_reports"
err X3d "BEGIN; $(as_user $MARA) UPDATE public.panel_rides SET status = 'completed' WHERE id = '$RIDE_X'; ROLLBACK;" "permission denied for view panel_rides"
err X3e "BEGIN; $(as_user $MARA) UPDATE public.panel_lost_items SET status = 'returned'; ROLLBACK;" "permission denied for view panel_lost_items"
# X4: anon reads none of the views.
for v in panel_rides panel_driver_profiles panel_driver_documents panel_driver_churn_risk panel_ride_disputes panel_incident_reports panel_lost_items; do
  err "X4.$v" "BEGIN; $(as_anon) SELECT count(*) FROM public.$v; ROLLBACK;" "permission denied for view $v"
done

# --- Lost items: through the view only ----------------------------------------------------------
val LI1 "BEGIN; $(as_user $MARA) SELECT description, category, status, driver_response, driver_found, return_fee_cup
  FROM public.panel_lost_items; ROLLBACK;" "Mochila azul|bag|driver_responded|La tengo|t|200"
err LI2 "BEGIN; $(as_user $MARA) SELECT return_notes FROM public.panel_lost_items; ROLLBACK;" 'column "return_notes" does not exist'
val LI3 "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.lost_items; ROLLBACK;" "0"
val LI4 "BEGIN; $(as_user $ANA) SELECT admin_notes, return_location, return_notes FROM public.lost_items; ROLLBACK;" "nota interna|Calle 23 y L|Entregar de 5 a 6"
val LI5 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.lost_items; ROLLBACK;" "1"

# --- Policies ------------------------------------------------------------------------------
val P1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.reviews), (SELECT count(*) FROM public.review_tags),
  (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.ticket_messages),
  (SELECT count(*) FROM public.ride_transitions WHERE ride_id = '$RIDE_X'),
  (SELECT count(*) FROM public.ride_pricing_snapshots WHERE ride_id = '$RIDE_C'),
  (SELECT count(*) FROM public.driver_score_events),
  (SELECT count(*) FROM public.driver_outreach_log); ROLLBACK;" "2|2|2|1|1|1|1|1"
# P1b: marketing reads every review, also one that is not public (a driver's review of a rider).
val P1b "BEGIN; $(as_user $MARA) SELECT comment FROM public.reviews WHERE id = '$REV_PRIV'; ROLLBACK;" "No estaba en la esquina"
# P2: tables marketing reads only through views, or not at all.
val P2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.driver_profiles),
  (SELECT count(*) FROM public.vehicles), (SELECT count(*) FROM public.driver_documents),
  (SELECT count(*) FROM public.ride_disputes), (SELECT count(*) FROM public.incident_reports),
  (SELECT count(*) FROM public.lost_items), (SELECT count(*) FROM public.payment_intents),
  (SELECT count(*) FROM public.user_devices); ROLLBACK;" "0|0|0|0|0|0|0|0|0"
val P3 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.reviews); ROLLBACK;" "1|2"
# X5: a signed-in user with no role and no rides reads nothing 00663 opens. Reviews keep prod's rule
# (00645): the public one (a visible review of a ride's driver) and its tag, never the private one.
val X5 "BEGIN; $(as_user $SAM) SELECT (SELECT string_agg(id::text, ',') FROM public.reviews), (SELECT count(*) FROM public.review_tags),
  (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.ticket_messages),
  (SELECT count(*) FROM public.lost_items), (SELECT count(*) FROM public.ride_transitions),
  (SELECT count(*) FROM public.ride_pricing_snapshots), (SELECT count(*) FROM public.driver_score_events),
  (SELECT count(*) FROM public.driver_outreach_log), (SELECT count(*) FROM public.panel_rides),
  (SELECT count(*) FROM public.panel_driver_profiles), (SELECT count(*) FROM public.panel_driver_documents),
  (SELECT count(*) FROM public.panel_driver_churn_risk), (SELECT count(*) FROM public.panel_ride_disputes),
  (SELECT count(*) FROM public.panel_incident_reports), (SELECT count(*) FROM public.panel_lost_items); ROLLBACK;" \
  "$REV_PUB|1|0|0|0|0|0|0|0|0|0|0|0|0|0|0"
# X6: marketing writes nothing besides the reply and the status.
val X6 "BEGIN; $(as_user $MARA) WITH a AS (UPDATE public.reviews SET is_visible = false RETURNING 1),
  b AS (UPDATE public.lost_items SET admin_notes = 'x' RETURNING 1), c AS (DELETE FROM public.support_tickets RETURNING 1),
  d AS (DELETE FROM public.ticket_messages RETURNING 1), e AS (UPDATE public.ticket_messages SET is_admin = true RETURNING 1),
  f AS (UPDATE public.ride_transitions SET reason = 'x' RETURNING 1), g AS (DELETE FROM public.driver_score_events RETURNING 1),
  h AS (UPDATE public.driver_outreach_log SET note = 'x' RETURNING 1), i AS (DELETE FROM public.ride_pricing_snapshots RETURNING 1),
  j AS (DELETE FROM public.reviews RETURNING 1)
  SELECT (SELECT count(*) FROM a), (SELECT count(*) FROM b), (SELECT count(*) FROM c), (SELECT count(*) FROM d), (SELECT count(*) FROM e),
  (SELECT count(*) FROM f), (SELECT count(*) FROM g), (SELECT count(*) FROM h), (SELECT count(*) FROM i), (SELECT count(*) FROM j); ROLLBACK;" \
  "0|0|0|0|0|0|0|0|0|0"
err X6b "BEGIN; $(as_user $MARA) INSERT INTO public.driver_outreach_log (driver_profile_id, admin_id, channel) VALUES ('$DIEGO_DP', '$MARA', 'call'); ROLLBACK;" "row-level security"
err X6c "BEGIN; $(as_user $MARA) INSERT INTO public.ride_transitions (ride_id, to_status) VALUES ('$RIDE_X', 'completed'); ROLLBACK;" "row-level security"
err X7 "BEGIN; $(as_user $MARA) INSERT INTO public.support_tickets (user_id, subject) VALUES ('$CARLA', 'x'); ROLLBACK;" "row-level security"

# --- Support -------------------------------------------------------------------------------
val S1 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T1', '$MARA', 'Te ayudamos', false) RETURNING is_admin; ROLLBACK;" "t"
val S2 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T_MARA', '$MARA', 'Soy pasajera', true) RETURNING is_admin; ROLLBACK;" "f"
val S3 "BEGIN; $(as_user $CARLA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin)
  VALUES ('$T1', '$CARLA', 'Soy soporte', true) RETURNING is_admin; ROLLBACK;" "f"
err S4 "BEGIN; $(as_user $MARA) INSERT INTO public.ticket_messages (ticket_id, sender_id, message)
  VALUES ('$T1', '$CARLA', 'en nombre de Carla'); ROLLBACK;" "row-level security"
val S5 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'resolved' WHERE id = '$T1'
  RETURNING status, resolved_at IS NOT NULL, updated_at IS NOT NULL; ROLLBACK;" "resolved|t|t"
err S6 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET priority = 'urgent' WHERE id = '$T1'; ROLLBACK;" "ticket_column_staff_only"
err S7 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'bogus' WHERE id = '$T1'; ROLLBACK;" "ticket_status_invalid"
val S8 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1';
  UPDATE public.support_tickets SET status = 'open' WHERE id = '$T1' RETURNING resolved_at IS NULL; ROLLBACK;" "t"
val S9 "BEGIN; $(as_user $ANA) UPDATE public.support_tickets SET priority = 'urgent' WHERE id = '$T1' RETURNING priority; ROLLBACK;" "urgent"
val S10 "BEGIN; $(as_user $CARLA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1' RETURNING id; ROLLBACK;" ""
# X8: every ticket column but the status is staff-only for marketing (X8.cover: the list is all of them).
X8_COLS="assigned_to,category,created_at,description,id,priority,ride_id,subject,user_id"
val X8.cover "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name NOT IN ('status', 'resolved_at', 'updated_at')" "$X8_COLS"
for c in "assigned_to = '$ANA'" "category = 'x'" "created_at = now() - interval '1 day'" "description = 'x'" "id = gen_random_uuid()" \
         "priority = 'urgent'" "ride_id = '$RIDE_X'" "subject = 'x'" "user_id = '$MARA'"; do
  err "X8.${c%% *}" "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET $c WHERE id = '$T1'; ROLLBACK;" "ticket_column_staff_only"
done
# X9-X11: the server stamps the dates, whatever the client sends.
val X9 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'resolved', resolved_at = '2000-01-01', updated_at = '2000-01-01'
  WHERE id = '$T1' RETURNING status, resolved_at = now(), updated_at = now(); ROLLBACK;" "resolved|t|t"
val X10 "BEGIN; UPDATE public.support_tickets SET status = 'resolved', resolved_at = '2026-10-01 12:00+00' WHERE id = '$T1';
  $(as_user $MARA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1' RETURNING resolved_at = '2026-10-01 12:00+00'; ROLLBACK;" "t"
# X10b: resolved without a date, then closed by marketing: the date is set now.
val X10b "BEGIN; UPDATE public.support_tickets SET status = 'resolved', resolved_at = NULL WHERE id = '$T1';
  $(as_user $MARA) UPDATE public.support_tickets SET status = 'closed' WHERE id = '$T1' RETURNING resolved_at = now(); ROLLBACK;" "t"
val X11 "BEGIN; $(as_user $MARA) UPDATE public.support_tickets SET status = 'in_progress', resolved_at = now() WHERE id = '$T1'
  RETURNING status, resolved_at IS NULL; ROLLBACK;" "in_progress|t"
# X12: admin writes unchanged: any column, dates as sent.
val X12 "BEGIN; $(as_user $ANA) UPDATE public.support_tickets SET status = 'resolved', resolved_at = '2026-01-01 00:00+00', assigned_to = '$ANA'
  WHERE id = '$T1' RETURNING resolved_at = '2026-01-01 00:00+00', assigned_to = '$ANA', updated_at IS NULL; ROLLBACK;" "t|t|t"
# X13: someone else cannot post into Carla's ticket.
err X13 "BEGIN; $(as_user $DIEGO) INSERT INTO public.ticket_messages (ticket_id, sender_id, message) VALUES ('$T1', '$DIEGO', 'x'); ROLLBACK;" "row-level security"

# --- RPCs ----------------------------------------------------------------------------------
val R1 "BEGIN; $(as_user $MARA) SELECT count(*), max(full_name) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "1|Pablo Pendiente"
val R2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.get_auto_accept_rate(7)), (SELECT count(*) FROM public.get_auto_nav_rate(7)),
  (SELECT count(*) FROM public.get_override_frequency(7, 20)); ROLLBACK;" "1|1|1"
err R3 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "Admin only"
val R4 "BEGIN; $(as_user $MARA) SELECT count(*), max(name), max(latitude) FROM public.admin_list_pois(); ROLLBACK;" "1|Coppelia|23.14"
err R5 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_list_pois(); ROLLBACK;" "forbidden"
val R6 "$BODIES" "$( [ "$MIG" = none ] && echo "$LIVE_OLD" || echo "$LIVE_NEW" )"
val R7 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.list_poi_submissions('all', 10, 0); ROLLBACK;" "0"
val X15 "BEGIN; $(as_user $MARA) SELECT count(*), max(name), max(lng) FROM public.list_poi_submissions('all', 10, 0); ROLLBACK;" "1|Paladar Nuevo|-82.4"
# X14: the widened read RPCs still refuse a customer.
for f in "get_auto_accept_rate(7)" "get_auto_nav_rate(7)" "get_override_frequency(7, 20)"; do
  err "X14.${f%%(*}" "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.$f; ROLLBACK;" "admin only"
done
# X24: the definer behind panel_driver_churn_risk answers marketing, no rider, and not anon.
val X24 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public._panel_driver_churn_risk(); ROLLBACK;" "0"
err X24b "BEGIN; $(as_anon) SELECT count(*) FROM public._panel_driver_churn_risk(); ROLLBACK;" "permission denied for function _panel_driver_churn_risk"
val X24c "BEGIN; $(as_user $MARA) SELECT count(*) FROM public._panel_driver_churn_risk(); ROLLBACK;" "1"

# --- Product failures ----------------------------------------------------------------------
# F1: the seed's queue rows have no ride: the two Paladar X rows are one place, asked by no ride.
val F1 "BEGIN; $(as_user $MARA) SELECT (SELECT string_agg(e->>'name' || ':' || (e->>'rides') || ':' || (e->>'riders') || ':' || (e->>'imported'),
    ',' ORDER BY o) FROM jsonb_array_elements(r->'places_not_found') WITH ORDINALITY a(e, o)),
  jsonb_array_length(r->'failed_payments'), r->'failed_payments'->0->>'reason', r->'failed_payments'->0->>'payments',
  jsonb_array_length(r->'app_versions'), jsonb_array_length(r->'push_outcomes'),
  r->'push_reach'->>'riders_active', r->'push_reach'->>'riders_reachable',
  r->'push_reach'->>'drivers_active', r->'push_reach'->>'drivers_reachable'
  FROM (SELECT public.get_product_failures(30) AS r) x; ROLLBACK;" "Hotel Y:0:0:1,Paladar X:0:0:0|2|Invalid card number|2|1|2|1|0|1|1"
err F2 "BEGIN; $(as_user $CARLA) SELECT public.get_product_failures(30); ROLLBACK;" "Admin only"
err F3 "BEGIN; $(as_anon) SELECT public.get_product_failures(30); ROLLBACK;" "permission denied"
# X16: exactly these keys (no ids, amounts, emails or phones by construction), and no uuid in the text.
# X16b (in F4) walks every key at every depth on data where every block has rows.
val X16 "BEGIN; $(as_user $MARA) SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r) k),
  (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(r->'places_not_found') e, jsonb_object_keys(e) k),
  (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(r->'failed_payments') e, jsonb_object_keys(e) k),
  (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(r->'app_versions') e, jsonb_object_keys(e) k),
  (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(r->'push_outcomes') e, jsonb_object_keys(e) k),
  (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'push_reach') k),
  r::text !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  FROM (SELECT public.get_product_failures(30) r) x; ROLLBACK;" \
  "app_versions,days,failed_payments,places_not_found,push_outcomes,push_reach|imported,last_seen,name,riders,rides|last_seen,payments,reason|app,installs,platform,version|app,outcome,users|drivers_active,drivers_reachable,riders_active,riders_reachable|t"
# X17: the period is clamped to 1..365 days, 30 by default.
val X17 "BEGIN; $(as_user $ANA) SELECT public.get_product_failures(0)->>'days', public.get_product_failures(9999)->>'days',
  public.get_product_failures(NULL)->>'days', public.get_product_failures(-5)->>'days'; ROLLBACK;" "1|365|30|1"
# X18: every block keeps to the period: one row 40 days old in each, seen at 90 days and not at 30.
PF_SIZES="jsonb_array_length(r->'places_not_found'), jsonb_array_length(r->'failed_payments'), jsonb_array_length(r->'push_outcomes'),
  jsonb_array_length(r->'app_versions'), (r->'push_reach'->>'riders_active')::int, (r->'push_reach'->>'drivers_active')::int"
val X18 "BEGIN; INSERT INTO public.poi_import_queue (name, created_at) VALUES ('Viejo', now() - interval '40 days');
  INSERT INTO public.payment_intents (user_id, status, error_message, created_at) VALUES ('$CARLA', 'failed', 'Declined', now() - interval '40 days');
  UPDATE public.push_registration_status SET updated_at = now() - interval '40 days' WHERE user_id = '$CARLA';
  INSERT INTO public.app_opens (user_id, app, device_id, app_version, platform, last_opened_at)
    VALUES ('$DIEGO', 'driver', 'dev-2', '1.7.2', 'android', now() - interval '40 days');
  INSERT INTO public.rides (customer_id, status, created_at) VALUES ('$SAM', 'completed', now() - interval '40 days');
  UPDATE public.driver_profiles SET last_heartbeat_at = now() - interval '40 days' WHERE user_id = 'c0000000-0000-4000-8000-000000000005';
  $(as_user $MARA) SELECT $PF_SIZES FROM (SELECT public.get_product_failures(30) r) x
  UNION ALL SELECT $PF_SIZES FROM (SELECT public.get_product_failures(90) r) x; ROLLBACK;" "2|2|1|1|1|1;3|3|2|2|2|2"
# X19: test and system accounts are left out of every block (a row of each in each block changes
# nothing), while the same rows of a real user (X19c) show up in every block.
PF_ROWS(){ # $1 user for the rows, $2 a ride id, $3 a name suffix
  echo "INSERT INTO public.rides (id, customer_id, status, pickup_address) VALUES ('$2', '$1', 'completed', 'Paladar X, Obispo $3');
  INSERT INTO public.poi_import_queue (ride_id, name) VALUES ('$2', 'Lugar $3');
  INSERT INTO public.push_registration_status (user_id, app, outcome) VALUES ('$1', 'client', 'error')
    ON CONFLICT (user_id, app) DO UPDATE SET outcome = 'error', updated_at = now();
  INSERT INTO public.driver_profiles (user_id, status, last_heartbeat_at) VALUES ('$1', 'pending_verification', now());
  INSERT INTO public.user_devices (user_id, push_token) VALUES ('$1', 'tok-$3');
  INSERT INTO public.app_opens (user_id, app, device_id, app_version, platform) VALUES ('$1', 'client', 'dev-$3', '9.9.$3', 'ios');
  INSERT INTO public.payment_intents (user_id, status, error_message) VALUES ('$1', 'failed', 'Fallo $3');"
}
val X19 "BEGIN; SET LOCAL request.jwt.claim.sub = '$MARA';
  CREATE TEMP TABLE pf0 ON COMMIT DROP AS SELECT public.get_product_failures(30) AS r;
  INSERT INTO public.users (id, full_name, is_test) VALUES ('$TESTU', 'Cuenta de prueba', true);
  $(PF_ROWS $TESTU f0000000-0000-4000-8000-000000000081 1)
  $(PF_ROWS $SYS1 f0000000-0000-4000-8000-000000000082 2)
  $(PF_ROWS $SYS99 f0000000-0000-4000-8000-000000000083 3)
  SELECT (SELECT r FROM pf0) = public.get_product_failures(30), $PF_SIZES, (SELECT e->>'rides' || '/' || (e->>'riders') FROM jsonb_array_elements(r->'places_not_found') e WHERE e->>'name' = 'Paladar X')
  FROM (SELECT public.get_product_failures(30) r) x; ROLLBACK;" "t|2|2|2|1|1|1|0/0"
val X19c "BEGIN; SET LOCAL request.jwt.claim.sub = '$MARA';
  $(PF_ROWS $SAM f0000000-0000-4000-8000-000000000084 4)
  SELECT $PF_SIZES, (SELECT e->>'rides' || '/' || (e->>'riders') FROM jsonb_array_elements(r->'places_not_found') e WHERE e->>'name' = 'Paladar X') FROM (SELECT public.get_product_failures(30) r) x; ROLLBACK;" "3|3|3|2|2|2|1/1"
# X25: a reason (the provider's code too) is cut to 60 characters and a place name to 80.
val X25 "BEGIN; INSERT INTO public.poi_import_queue (name) VALUES (repeat('n', 120));
  INSERT INTO public.payment_intents (user_id, status, provider_error_code) VALUES ('$CARLA', 'failed', repeat('c', 100));
  $(as_user $MARA) SELECT (SELECT max(length(e->>'name')) FROM jsonb_array_elements(r->'places_not_found') e),
  (SELECT max(length(e->>'reason')) FROM jsonb_array_elements(r->'failed_payments') e)
  FROM (SELECT public.get_product_failures(30) r) x; ROLLBACK;" "80|60"
# F4: places_not_found counts rides and riders, not queue rows (00584 keeps one pending row per name
# within ~200 m). Paladar Z has a single queue row and is asked by three rides of two riders in the
# period, written with other case and spaces (Sam's ride names it at both ends: one ride), by a test
# account and a system account (left out), and by a ride 40 days old (outside 30 days, inside 90).
# last_seen is Sam's ride a day ago, later than the queue row: the test account's ride of today
# does not count.
PZ="f0000000-0000-4000-8000-0000000000"
PZ_SETUP="INSERT INTO public.users (id, full_name, is_test) VALUES ('$TESTU', 'Cuenta de prueba', true);
  INSERT INTO public.rides (id, customer_id, status, pickup_address, dropoff_address, created_at) VALUES
    ('${PZ}91', '$CARLA', 'completed', 'Paladar Z, Calle 23 e/ L y M, Plaza', 'Prado 100', now() - interval '3 days'),
    ('${PZ}92', '$CARLA', 'completed', 'Obispo 5', '  paladar z , Vedado', now() - interval '2 days'),
    ('${PZ}93', '$SAM', 'canceled', 'PALADAR Z', 'Paladar Z, La Habana', now() - interval '1 day'),
    ('${PZ}94', '$TESTU', 'completed', 'Paladar Z', 'Prado 1', now()),
    ('${PZ}95', '$SYS99', 'completed', 'Paladar Z, Obispo', 'Prado 1', now()),
    ('${PZ}96', '$CARLA', 'completed', 'Paladar Z', 'Prado 1', now() - interval '40 days');
  INSERT INTO public.poi_import_queue (ride_id, name, created_at) VALUES ('${PZ}91', 'Paladar Z', now() - interval '3 days');"
PZ_ROW="e->>'name', e->>'rides', e->>'riders', e->>'imported', (e->>'last_seen')::timestamptz = now() - interval '1 day'"
val F4 "BEGIN; $PZ_SETUP $(as_user $MARA)
  SELECT $PZ_ROW FROM (SELECT public.get_product_failures(30)->'places_not_found'->0 e) x
  UNION ALL SELECT $PZ_ROW FROM (SELECT public.get_product_failures(90)->'places_not_found'->0 e) x; ROLLBACK;" \
  "Paladar Z|3|2|0|t;Paladar Z|4|2|0|t"
# X16b: on the same data, every block has rows. Every key at every depth is one of these (so the walk
# reaches the items of each block), none names a person, a ride or a coordinate, and no value is a uuid.
PF_KEYS="app,app_versions,days,drivers_active,drivers_reachable,failed_payments,imported,installs,last_seen,name,outcome,payments,places_not_found,platform,push_outcomes,push_reach,reason,riders,riders_active,riders_reachable,rides,users,version"
val X16b "BEGIN; $PZ_SETUP $(as_user $MARA)
  SELECT (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_path_query(r, 'strict \$.** ? (@.type() == \"object\")') o, jsonb_object_keys(o) k),
  (SELECT count(*) FROM jsonb_path_query(r, 'strict \$.** ? (@.type() == \"object\")') o, jsonb_object_keys(o) k
    WHERE k IN ('user_id', 'customer_id', 'driver_id', 'ride_id', 'phone', 'email', 'lat', 'lng')),
  r::text !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  jsonb_array_length(r->'places_not_found') > 0 AND jsonb_array_length(r->'failed_payments') > 0
    AND jsonb_array_length(r->'app_versions') > 0 AND jsonb_array_length(r->'push_outcomes') > 0
  FROM (SELECT public.get_product_failures(30) r) x; ROLLBACK;" "$PF_KEYS|0|t|t"
# F5: a place whose only queue row is older than the period is listed when a ride of the period asks
# for it (the queue does not add a row while that one is pending), seen last on that ride's date,
# inside the period; one asked by no ride of the period is not (X18's Viejo).
val F5 "BEGIN; INSERT INTO public.rides (customer_id, status, dropoff_address, created_at)
    VALUES ('$CARLA', 'completed', 'Cafe Viejo, Obispo', now() - interval '5 days');
  INSERT INTO public.poi_import_queue (name, created_at) VALUES ('Cafe Viejo', now() - interval '45 days'),
                                                               ('Cafe Olvidado', now() - interval '45 days');
  $(as_user $MARA) SELECT string_agg(e->>'name' || ':' || (e->>'rides') || ':' || (e->>'riders') || ':'
      || ((e->>'last_seen')::timestamptz = now() - interval '5 days')::text || ':'
      || ((e->>'last_seen')::timestamptz >= now() - interval '30 days')::text, ',')
  FROM (SELECT public.get_product_failures(30) r) x, jsonb_array_elements(r->'places_not_found') e
  WHERE e->>'name' LIKE 'Cafe%'; ROLLBACK;" "Cafe Viejo:1:1:true:true"

# --- What is left as it was ----------------------------------------------------------------
# X20: the marketing policies: 00642's eleven and this file's nine.
val X20 "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
  AND (position('is_marketing' IN coalesce(qual, '')) > 0 OR position('is_marketing' IN coalesce(with_check, '')) > 0)" "20"
# X21: the driver's active vehicle, not a newer inactive one.
val X21 "BEGIN; INSERT INTO public.vehicles (driver_id, type, plate_number, is_active, created_at) VALUES ('$DIEGO_DP', 'moto', 'OLD999', false, now() + interval '1 hour');
  $(as_user $MARA) SELECT plate_number || '/' || vehicle_type FROM public.panel_driver_profiles WHERE id = '$DIEGO_DP'; ROLLBACK;" "P123456/triciclo"
# X22: marketing reads the product-failure sources only through the RPC.
val X22 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.poi_import_queue), (SELECT count(*) FROM public.push_registration_status),
  (SELECT count(*) FROM public.validation_events); ROLLBACK;" "0|0|0"
err X22b "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.app_opens; ROLLBACK;" "permission denied for table app_opens"
# X23: admins still read the raw tables, sensitive columns included.
val X23 "BEGIN; $(as_user $ANA) SELECT (SELECT share_token FROM public.rides WHERE id = '$RIDE_X'), (SELECT storage_path FROM public.driver_documents),
  (SELECT admin_notes FROM public.ride_disputes), (SELECT count(*) FROM public.incident_reports), (SELECT count(*) FROM public.lost_items),
  (SELECT count(*) FROM public.driver_score_events), (SELECT count(*) FROM public.reviews); ROLLBACK;" "tok-secret|driver-docs/d2/id.jpg|nota de admin|1|1|1|2"

if [ "$MIG" != none ]; then
  # CR1: a CRLF copy applies to a fresh database and leaves the same bodies, without a \r.
  tr -d '\r' < "$MIG" | sed 's/$/\r/' > "$TMP/crlf.sql"
  if [ "$(grep -c $'\r' "$TMP/crlf.sql")" -gt 100 ]; then ok CR1z; else ko CR1z "the CRLF copy has no carriage returns"; fi
  load ${DB}crlf
  apply ${DB}crlf "$TMP/crlf.sql" && ok CR1a || ko CR1a "CRLF copy failed: $(cat "$TMP/mig.out")"
  val CR1b "$BODIES" "$LIVE_NEW" ${DB}crlf
  val CR1c "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(chr(13) IN prosrc) > 0;
    $CREATED_BODIES" "0;$(run $DB "$CREATED_BODIES")" ${DB}crlf
  $BIN/dropdb $CONN --if-exists ${DB}crlf >/dev/null 2>&1

  # Negative proofs: each sabotage, of the database or of the file, makes the file abort with its
  # check's message. A sabotage that cannot be set up fails the test.
  NEG=${DB}neg
  neg(){ # id, migration file, expected message, [SQL run as the owner before applying]
    local id=$1 file=$2 want=$3 setup=${4:-}
    load $NEG
    if [ -n "$setup" ] && ! psqlf $NEG -c "$AS_OWNER" -c "$setup" >"$TMP/setup.out" 2>&1; then
      ko "$id" "the sabotage could not be set up: $(cat "$TMP/setup.out")"; return
    fi
    if apply $NEG "$file"; then ko "$id" "the file applied"; return; fi
    if grep -qF -- "$want" "$TMP/mig.out"; then ok "$id"; else ko "$id" "$(cat "$TMP/mig.out")"; fi
  }
  sabotage(){ python3 - "$MIG" "$TMP/$1.sql" "$2" "$3" <<'PY'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new)
assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PY
  }
  negfile(){ # id, text of the file, its replacement, expected message
    if ! sabotage "$1" "$2" "$3" >"$TMP/sab.out" 2>&1; then ko "$1" "the file could not be sabotaged: $(cat "$TMP/sab.out")"; return; fi
    neg "$1" "$TMP/$1.sql" "$4"
  }

  neg N1 "$MIG" "has a body this file does not know" \
    "CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
     RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric) LANGUAGE sql
     AS \$f\$ SELECT 0::bigint, 0::bigint, 0::bigint, 0::numeric \$f\$"
  neg N2 "$MIG" "vehicles.vehicles_select_marketing let marketing read a table it must reach only through the panel views" \
    "CREATE POLICY vehicles_select_marketing ON public.vehicles FOR SELECT TO authenticated USING ((SELECT public.is_marketing()))"
  neg N2b "$MIG" "lost_items.lost_items_select_marketing let marketing read a table it must reach only through the panel views" \
    "CREATE POLICY lost_items_select_marketing ON public.lost_items FOR SELECT TO authenticated USING ((SELECT public.is_marketing()))"
  neg N3 "$MIG" "panel_extra.share_token is a hidden column in a panel view" \
    "CREATE VIEW public.panel_extra AS SELECT id, share_token FROM public.rides"
  neg N4 "$MIG" "policy ticket_messages_insert_marketing on ticket_messages is not the one this file creates" \
    "CREATE POLICY ticket_messages_insert_marketing ON public.ticket_messages FOR INSERT TO authenticated WITH CHECK ((SELECT public.is_marketing()))"
  neg N5 "$MIG" "policy support_tickets_update_marketing on support_tickets is not the one this file creates" \
    "CREATE POLICY support_tickets_update_marketing ON public.support_tickets FOR ALL TO authenticated USING ((SELECT public.is_marketing())) WITH CHECK ((SELECT public.is_marketing()))"
  neg N6 "$MIG" "policy reviews_select_marketing on reviews is not the one this file creates" \
    "CREATE POLICY reviews_select_marketing ON public.reviews FOR SELECT TO authenticated USING (true)"
  negfile N7 "BEFORE UPDATE ON public.support_tickets" "BEFORE UPDATE OF status ON public.support_tickets" \
    "trg_support_tickets_client_update_guard must fire BEFORE UPDATE FOR EACH ROW"
  negfile N8 "REVOKE ALL ON public.panel_ride_disputes FROM PUBLIC, anon, authenticated, service_role;" "-- sabotaged" \
    "view panel_ride_disputes must be readable by authenticated and service_role only"
  negfile N9 "REVOKE ALL ON FUNCTION public.get_product_failures(integer) FROM PUBLIC, anon;" "-- sabotaged" \
    "public.get_product_failures(integer) must be executable by authenticated and service_role, not by anon or PUBLIC"
  negfile N10 "LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS \$fn\$
DECLARE
  c_free" "LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS \$fn\$
DECLARE
  c_free" "tg_support_tickets_client_update_guard() must be SECURITY INVOKER"
  # N11 (M1): a policy of the same name that still uses is_marketing() but lets more through.
  neg N11 "$MIG" "policy reviews_select_marketing on reviews is not the one this file creates" \
    "CREATE POLICY reviews_select_marketing ON public.reviews FOR SELECT TO authenticated USING (((SELECT public.is_marketing()) OR true))"
  # N12 (M2): a column one view must leave out, though another view may show it.
  negfile N12 "i.created_at, i.updated_at, i.review_id
FROM public.incident_reports i" "i.created_at, i.updated_at, i.review_id, i.resolution_notes
FROM public.incident_reports i" "panel_incident_reports.resolution_notes is a column that view must leave out"
  # N13 (M4): a BEFORE UPDATE row trigger that sorts before the guard.
  neg N13 "$MIG" "trg_support_tickets_a_first fires before trg_support_tickets_client_update_guard" \
    "CREATE FUNCTION public.tg_noop() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;
     CREATE TRIGGER trg_support_tickets_a_first BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.tg_noop()"
  # N14 (M9): a created body that is not the one the file checks.
  negfile N14 "'sin motivo'" "'sin dato'" "public.get_product_failures(integer) does not have the body of this file"
  # N15: a view the file creates without its gate, and one whose gate lets more through.
  negfile N15 "FROM public.driver_documents d
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());" "FROM public.driver_documents d;" \
    "view panel_driver_documents does not end in the gate"
  negfile N15b "FROM public.lost_items l
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing());" "FROM public.lost_items l
WHERE (SELECT public.is_admin()) OR (SELECT public.is_marketing()) OR true;" \
    "view panel_lost_items does not end in the gate"
  # N15c: any other panel_ view of public answers to the same checks.
  neg N15c "$MIG" "view panel_extra does not end in the gate" \
    "CREATE VIEW public.panel_extra WITH (security_barrier = true, security_invoker = false) AS SELECT id, status FROM public.rides"
  # N3b: a column named like a coordinate, though not in the list of hidden names.
  neg N3b "$MIG" "panel_extra.actual_pickup_location is a hidden column in a panel view" \
    "CREATE VIEW public.panel_extra AS SELECT id, pickup_location AS actual_pickup_location FROM public.rides"
  # N16-N18: a definer this file creates without SECURITY DEFINER or without its search_path.
  negfile N16 "LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''" "LANGUAGE plpgsql
STABLE
SET search_path = ''" "public.get_product_failures(integer) must be SECURITY DEFINER with search_path = ''"
  negfile N17 "STABLE
SECURITY DEFINER
SET search_path = ''
AS \$fn\$
DECLARE
  c_system" "STABLE
SECURITY DEFINER
AS \$fn\$
DECLARE
  c_system" "public.get_product_failures(integer) must be SECURITY DEFINER with search_path = ''"
  negfile N18 "LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''" "LANGUAGE sql
STABLE
SET search_path = ''" "public._panel_driver_churn_risk() must be SECURITY DEFINER with search_path = ''"
  negfile N18b "SECURITY DEFINER
SET search_path = ''
AS \$fn\$
  SELECT c.driver_profile_id" "SECURITY DEFINER
AS \$fn\$
  SELECT c.driver_profile_id" "public._panel_driver_churn_risk() must be SECURITY DEFINER with search_path = ''"
  # N19: the support guard without its search_path.
  negfile N19 "LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS \$fn\$
DECLARE
  c_free" "LANGUAGE plpgsql
AS \$fn\$
DECLARE
  c_free" "tg_support_tickets_client_update_guard() must SET search_path = public, pg_catalog"
  $BIN/dropdb $CONN --if-exists $NEG >/dev/null 2>&1
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
