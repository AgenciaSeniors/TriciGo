#!/usr/bin/env bash
# Rehearsal runner for migration 00663 (marketing reads more of the admin panel).
# Builds prod as of 2026-10-15: the 00642 rehearsal scaffold (prod on 2026-10-08) with 00641 and
# 00642 applied and Mara made marketing, then scaffold.sql and seed.sql of this folder.
#   supabase/tests/00663/run.sh none
#       -> prod + tests (RED: marketing reads none of the new data and cannot answer support)
#   supabase/tests/00663/run.sh supabase/migrations/00663_marketing_wider_view.sql
#       -> the same + 00663 applied twice, each in one transaction (GREEN), a CRLF copy applied to a
#          fresh database, and negative proofs of the file's own checks
# Cluster: user pgtest, port 5433. Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
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
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
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
DIEGO_DP=d0000000-0000-4000-8000-000000000002
RIDE_X=f0000000-0000-4000-8000-000000000010
T1=b1000000-0000-4000-8000-000000000001
T_MARA=b1000000-0000-4000-8000-000000000003
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }

LIVE_OLD="admin_incomplete_driver_signups=2841ccd9b2c3f9cb3804a361097e22d3,admin_list_pois=c4646cc85b1bd83c65bf11974d49fbfd,get_auto_accept_rate=d287cc0735f48cb5d621d71b82bd0456,get_auto_nav_rate=ea732c6b23a1f3654f44d52077e3bd70,get_override_frequency=32d90734b10ec562591c9362b61f11a7,list_poi_submissions=6b1551aa33141886c0a9d0ac9a6bb616,tg_ticket_messages_client_guard=27dfd5fae754370a8554fd7c52f993cc"
# Computed in prod on 2026-10-15 as md5(replace(prosrc, <target>, <replacement>)).
LIVE_NEW="admin_incomplete_driver_signups=65aad048b3031c8398c21cf3649bd47f,admin_list_pois=0fd97f9da45bb7fddce9350acfec7fe6,get_auto_accept_rate=6f20da2215bf11febeeba716589ca74a,get_auto_nav_rate=c763c447e0ac0d61f150757efc543bad,get_override_frequency=e7ad623472e2f8f2e180f05bf2c172fb,list_poi_submissions=5bb221cc967fa33857a39ea963cd560c,tg_ticket_messages_client_guard=96297a4de1f620d1e545e21643268224"
LIVE_NAMES="'admin_incomplete_driver_signups','admin_list_pois','get_auto_accept_rate','get_auto_nav_rate','get_override_frequency','list_poi_submissions','tg_ticket_messages_client_guard'"
BODIES="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace AND proname IN ($LIVE_NAMES)"
FORBIDDEN="'share_token','share_token_expires_at','pickup_location','dropoff_location','actual_dropoff_location',
  'pickup_lat','pickup_lng','dropoff_lat','dropoff_lng','current_location','current_heading','identity_number',
  'address','has_criminal_record','criminal_record_details','negative_balance_since','storage_path','file_name',
  'face_match_score','liveness_passed','evidence_urls','respondent_evidence_urls','refund_amount_trc',
  'refund_transaction_id','admin_notes','earnings_this_week','earnings_last_week','pickup_notes','dropoff_notes',
  'wallet_amount_cup','cash_amount_cup','payment_intent_id'"

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

if [ "$MIG" != none ]; then
  apply $DB "$MIG" || { echo "migration failed on apply 1:"; cat "$TMP/mig.out"; exit 1; }
  apply $DB "$MIG" || { echo "migration failed on apply 2:"; cat "$TMP/mig.out"; exit 1; }
fi

# --- Views ---------------------------------------------------------------------------------
val V1 "BEGIN; $(as_user $MARA) SELECT canceled_by_role, cancellation_reason FROM public.panel_rides WHERE id = '$RIDE_X'; ROLLBACK;" "customer|changed_plans"
val V2 "BEGIN; $(as_user $MARA) SELECT string_agg(coalesce(canceled_by_role, '-'), ',' ORDER BY id) FROM public.panel_rides; ROLLBACK;" "-,customer,-,driver,system"
val V3 "BEGIN; $(as_user $MARA) SELECT full_name, plate_number, vehicle_type, municipality FROM public.panel_driver_profiles WHERE id = '$DIEGO_DP'; ROLLBACK;" "Diego Driver|P123456|triciclo|Plaza"
val V4 "BEGIN; $(as_user $MARA) SELECT document_type, is_verified FROM public.panel_driver_documents; ROLLBACK;" "national_id|t"
val V5 "BEGIN; $(as_user $MARA) SELECT risk_level FROM public.panel_driver_churn_risk WHERE driver_profile_id = '$DIEGO_DP'; ROLLBACK;" "medium"
val V6 "BEGIN; $(as_user $MARA) SELECT reason FROM public.panel_ride_disputes; ROLLBACK;" "overcharge"
val V7 "BEGIN; $(as_user $MARA) SELECT type FROM public.panel_incident_reports; ROLLBACK;" "rude_behavior"
val V8 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_profiles),
  (SELECT count(*) FROM public.panel_driver_documents), (SELECT count(*) FROM public.panel_driver_churn_risk),
  (SELECT count(*) FROM public.panel_ride_disputes), (SELECT count(*) FROM public.panel_incident_reports); ROLLBACK;" "0|0|0|0|0|0"
err V9 "BEGIN; $(as_anon) SELECT count(*) FROM public.panel_driver_documents; ROLLBACK;" "permission denied"
val V10 "BEGIN; $(as_user $ANA) SELECT (SELECT count(*) FROM public.panel_rides), (SELECT count(*) FROM public.panel_driver_documents),
  (SELECT count(*) FROM public.panel_ride_disputes); ROLLBACK;" "5|1|1"
# V11: no panel view carries a column that the spec keeps hidden (by name, so a later column fails too).
val V11 "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
  AND table_name IN ('panel_rides','panel_driver_profiles','panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports')
  AND column_name IN ($FORBIDDEN)" "0"
val V12 "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
  AND table_name IN ('panel_driver_documents','panel_driver_churn_risk','panel_ride_disputes','panel_incident_reports')" "4"

# --- Policies ------------------------------------------------------------------------------
val P1 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.reviews), (SELECT count(*) FROM public.review_tags),
  (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.ticket_messages),
  (SELECT count(*) FROM public.lost_items), (SELECT count(*) FROM public.ride_transitions WHERE ride_id = '$RIDE_X'),
  (SELECT count(*) FROM public.ride_pricing_snapshots WHERE ride_id = 'f0000000-0000-4000-8000-000000000011'),
  (SELECT count(*) FROM public.driver_score_events),
  (SELECT count(*) FROM public.driver_outreach_log); ROLLBACK;" "1|1|2|1|1|1|1|1|1"
# P2: tables marketing reads only through views, or not at all.
val P2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.rides), (SELECT count(*) FROM public.driver_profiles),
  (SELECT count(*) FROM public.vehicles), (SELECT count(*) FROM public.driver_documents),
  (SELECT count(*) FROM public.ride_disputes), (SELECT count(*) FROM public.incident_reports),
  (SELECT count(*) FROM public.payment_intents), (SELECT count(*) FROM public.user_devices); ROLLBACK;" "0|0|0|0|0|0|0|0"
val P3 "BEGIN; $(as_user $CARLA) SELECT (SELECT count(*) FROM public.support_tickets), (SELECT count(*) FROM public.reviews); ROLLBACK;" "1|1"

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

# --- RPCs ----------------------------------------------------------------------------------
val R1 "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "0"
val R2 "BEGIN; $(as_user $MARA) SELECT (SELECT count(*) FROM public.get_auto_accept_rate(7)), (SELECT count(*) FROM public.get_auto_nav_rate(7)),
  (SELECT count(*) FROM public.get_override_frequency(7, 20)); ROLLBACK;" "1|1|1"
err R3 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_incomplete_driver_signups(); ROLLBACK;" "Admin only"
# R4: marketing gets past admin_list_pois' gate (without PostGIS the body then fails on geometry).
nomatch R4 "BEGIN; $(as_user $MARA) SELECT count(*) FROM public.admin_list_pois(); ROLLBACK;" "forbidden"
err R5 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.admin_list_pois(); ROLLBACK;" "forbidden"
val R6 "$BODIES" "$( [ "$MIG" = none ] && echo "$LIVE_OLD" || echo "$LIVE_NEW" )"
val R7 "BEGIN; $(as_user $CARLA) SELECT count(*) FROM public.list_poi_submissions('all', 10, 0); ROLLBACK;" "0"

# --- Product failures ----------------------------------------------------------------------
val F1 "BEGIN; $(as_user $MARA) SELECT r->'places_not_found'->0->>'name', r->'places_not_found'->0->>'searches',
  jsonb_array_length(r->'failed_payments'), r->'failed_payments'->0->>'reason', r->'failed_payments'->0->>'payments',
  jsonb_array_length(r->'app_versions'), jsonb_array_length(r->'push_outcomes'),
  r->'push_reach'->>'riders_active', r->'push_reach'->>'riders_reachable',
  r->'push_reach'->>'drivers_active', r->'push_reach'->>'drivers_reachable'
  FROM (SELECT public.get_product_failures(30) AS r) x; ROLLBACK;" "Paladar X|2|2|Invalid card number|2|1|2|1|0|1|1"
err F2 "BEGIN; $(as_user $CARLA) SELECT public.get_product_failures(30); ROLLBACK;" "Admin only"
err F3 "BEGIN; $(as_anon) SELECT public.get_product_failures(30); ROLLBACK;" "permission denied"
nomatch F4 "BEGIN; $(as_user $MARA) SELECT public.get_product_failures(30)::text; ROLLBACK;" "$CARLA"
val F5 "BEGIN; $(as_user $ANA) SELECT (public.get_product_failures(0)->>'days'), (public.get_product_failures(9999)->>'days'); ROLLBACK;" "1|365"

if [ "$MIG" != none ]; then
  # CR1: a CRLF copy applies to a fresh database and leaves the same bodies.
  tr -d '\r' < "$MIG" | sed 's/$/\r/' > "$TMP/crlf.sql"
  load ${DB}crlf
  apply ${DB}crlf "$TMP/crlf.sql" && ok CR1a || ko CR1a "CRLF copy failed: $(cat "$TMP/mig.out")"
  val CR1b "$BODIES" "$LIVE_NEW" ${DB}crlf

  # N1: a patched function with a body the file does not know aborts the file.
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE OR REPLACE FUNCTION public.get_auto_nav_rate(p_days_back integer DEFAULT 7)
    RETURNS TABLE(total bigint, triggered bigint, cancelled bigint, follow_rate numeric) LANGUAGE sql AS \$f\$ SELECT 0::bigint, 0::bigint, 0::bigint, 0::numeric \$f\$" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N1 "the file applied over an unknown body" || { grep -q "does not know" "$TMP/mig.out" && ok N1 || ko N1 "$(cat "$TMP/mig.out")"; }

  # N2: a marketing policy on vehicles aborts the file (marketing reads vehicles only through the view).
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE POLICY vehicles_select_marketing ON public.vehicles FOR SELECT TO authenticated USING ((SELECT public.is_marketing()))" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N2 "the file applied with a marketing policy on vehicles" || { grep -q "through the panel views" "$TMP/mig.out" && ok N2 || ko N2 "$(cat "$TMP/mig.out")"; }

  # N3: any panel_ view with a hidden column aborts the file.
  load ${DB}neg
  psqlf ${DB}neg -c "$AS_OWNER" -c "CREATE VIEW public.panel_extra AS SELECT id, share_token FROM public.rides" >/dev/null 2>&1
  apply ${DB}neg "$MIG" && ko N3 "the file applied with a panel view exposing share_token" || { grep -q "hidden column" "$TMP/mig.out" && ok N3 || ko N3 "$(cat "$TMP/mig.out")"; }
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
