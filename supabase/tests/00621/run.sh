#!/usr/bin/env bash
# Rehearsal runner for migration 00621 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00621/run.sh none
#       -> the scaffold without the migration (RED: every case fails)
#   supabase/tests/00621/run.sh supabase/migrations/00621_launch_pulse_and_driver_outreach.sql
#       -> the same + migration x2 (idempotency) + tests (GREEN)
# Writes run as anon/authenticated with a JWT subject, as PostgREST would.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00621/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr621
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=terse -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run $DB "$2"); case "$r" in *"$3"*) ok "$1";; *) ko "$1" "expected to contain [$3], got [$r]";; esac; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE tricigo_owner" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# as UID SQL -> SQL as authenticated with JWT subject UID (committed)
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s COMMIT;" "$1" "$2"; }
anon(){ printf "BEGIN; SET LOCAL ROLE anon; %s COMMIT;" "$1"; }

ADMIN=a0000000-0000-4000-8000-000000000001
R1=b0000000-0000-4000-8000-000000000001     # rider: push, MOTORENKO, opted in, completes a ride
R2=b0000000-0000-4000-8000-000000000002     # rider: referred, rides that fail
T=b0000000-0000-4000-8000-0000000000ff      # test rider (left out everywhere)
DRA=c0000000-0000-4000-8000-00000000000a     # approved driver, online, push
DRB=c0000000-0000-4000-8000-00000000000b     # approved driver
DT=c0000000-0000-4000-8000-0000000000ff     # approved test driver
P1=d0000000-0000-4000-8000-000000000001     # pending: nothing uploaded
P2=d0000000-0000-4000-8000-000000000002     # pending: 3 docs + vehicle + push
P3=d0000000-0000-4000-8000-000000000003     # pending: one doc ok, vehicle photo rejected
P4=d0000000-0000-4000-8000-0000000000ff     # pending test driver
U=d0000000-0000-4000-8000-0000000000aa      # under review (finished the signup)
DPA=1c000000-0000-4000-8000-00000000000a; DPB=1c000000-0000-4000-8000-00000000000b; DPT=1c000000-0000-4000-8000-0000000000ff
DP1=1d000000-0000-4000-8000-000000000001; DP2=1d000000-0000-4000-8000-000000000002
DP3=1d000000-0000-4000-8000-000000000003; DP4=1d000000-0000-4000-8000-0000000000ff; DPU=1d000000-0000-4000-8000-0000000000aa

$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
SEED=$(run $DB "
  INSERT INTO public.users (id, role, full_name, phone, is_test, signup_code, marketing_opt_in, marketing_opt_in_at) VALUES
   ('$ADMIN','admin','Ada',NULL,false,NULL,NULL,NULL),
   ('$R1','customer','Rita',NULL,false,'MOTORENKO',true,now()),
   ('$R2','customer','Rolo',NULL,false,NULL,false,now()),
   ('$T','customer','Test',NULL,true,'MOTORENKO',true,now()),
   ('$DRA','customer','Dani',NULL,false,NULL,NULL,NULL), ('$DRB','customer','Beto',NULL,false,NULL,NULL,NULL),
   ('$DT','customer','Tester',NULL,true,NULL,NULL,NULL),
   ('$P1','customer','Pepe','+5355500001',false,NULL,NULL,NULL), ('$P2','customer','Paula','+5355500002',false,NULL,NULL,NULL),
   ('$P3','customer','Pedro','+5355500003',false,NULL,NULL,NULL), ('$P4','customer','Prueba','+5355500004',true,NULL,NULL,NULL),
   ('$U','customer','Ursula','+5355500005',false,NULL,NULL,NULL);
  INSERT INTO auth.users (id, last_sign_in_at) VALUES ('$P1', '2026-10-01 12:00+00'), ('$P2', NULL);
  INSERT INTO public.driver_profiles (id, user_id, status, is_online, approved_at) VALUES
   ('$DPA','$DRA','approved',true,now()), ('$DPB','$DRB','approved',false,now()), ('$DPT','$DT','approved',true,now()),
   ('$DP1','$P1','pending_verification',false,NULL), ('$DP2','$P2','pending_verification',false,NULL),
   ('$DP3','$P3','pending_verification',false,NULL), ('$DP4','$P4','pending_verification',false,NULL),
   ('$DPU','$U','under_review',false,NULL);
  INSERT INTO public.user_devices (user_id, push_token) VALUES ('$R1','t1'), ('$DRA','t2'), ('$P2','t3');
  INSERT INTO public.driver_documents (driver_id, document_type, uploaded_at, rejection_reason) VALUES
   ('$DP2','national_id',now(),NULL), ('$DP2','selfie',now(),NULL),
   ('$DP2','drivers_license',now() - interval '2 days','Borrosa'), ('$DP2','drivers_license',now(),NULL),
   ('$DP2','operating_license',now(),NULL),
   ('$DP3','national_id',now(),NULL),
   ('$DP3','vehicle_photo',now() - interval '2 days',NULL), ('$DP3','vehicle_photo',now(),'No se ve la chapa');
  INSERT INTO public.referrals (referrer_id, referee_id, rewarded_at) VALUES ('$R1','$R2',now()), ('$R1','$T',now());
  -- Heartbeats around the last hours (H = start of the current UTC hour).
  INSERT INTO public.driver_heartbeat_log (driver_profile_id, beat_at, is_online) VALUES
   ('$DPA', date_trunc('hour', now(), 'UTC') - interval '5 hours' + interval '10 minutes', true),
   ('$DPA', date_trunc('hour', now(), 'UTC') - interval '4 hours' + interval '5 minutes', true),
   ('$DPA', date_trunc('hour', now(), 'UTC') - interval '4 hours' + interval '40 minutes', true),
   ('$DPA', date_trunc('hour', now(), 'UTC') - interval '3 hours' + interval '5 minutes', true),
   ('$DPB', date_trunc('hour', now(), 'UTC') - interval '3 hours' + interval '10 minutes', true),
   ('$DPT', date_trunc('hour', now(), 'UTC') - interval '3 hours' + interval '20 minutes', true),
   ('$DPB', date_trunc('hour', now(), 'UTC') - interval '2 hours' + interval '5 minutes', false);
  -- Ride requests this week.
  INSERT INTO public.rides (id, customer_id, driver_id, status, accepted_at) VALUES
   ('e0000000-0000-4000-8000-000000000001','$R1','$DPA','completed',now()),
   ('e0000000-0000-4000-8000-000000000002','$R1','$DPB','canceled',now()),
   ('e0000000-0000-4000-8000-000000000003','$R2',NULL,'canceled',NULL),
   ('e0000000-0000-4000-8000-000000000004','$R2',NULL,'canceled',NULL),
   ('e0000000-0000-4000-8000-000000000005','$R2',NULL,'searching',NULL),
   ('e0000000-0000-4000-8000-000000000006','$T',NULL,'canceled',NULL);
  INSERT INTO public.ride_offers (ride_id, driver_profile_id) VALUES
   ('e0000000-0000-4000-8000-000000000001','$DPA'), ('e0000000-0000-4000-8000-000000000003','$DPB');")
[ -z "$SEED" ] || { echo "seed failed: $SEED"; exit 1; }

if [ "$MIG" != none ]; then
  r1=$(apply_err $DB "$MIG"); r2=$(apply_err $DB "$MIG")
  [ "$r1" = applied ] && [ "$r2" = applied ] && ok "migration applies twice" || ko "migration applies twice" "[$r1] [$r2]"
fi

H="date_trunc('hour', now(), 'UTC')"

# --- online drivers per hour --------------------------------------------------------------
val "S1 the backfill writes every complete hour the log covers, test drivers and offline beats left out" \
  "SELECT string_agg((extract(epoch FROM $H - hour_start)/3600)::int || 'h:' || drivers_online, ',' ORDER BY hour_start) FROM public.driver_online_hourly" \
  "4h:1,3h:2,2h:0,1h:0"
val "S2 the first, partial hour of the log and the current hour are not written" \
  "SELECT (min(hour_start) = $H - interval '4 hours') || ':' || (max(hour_start) = $H - interval '1 hour') FROM public.driver_online_hourly" \
  "true:true"
val "S3 who was online is kept" \
  "SELECT array_to_string(driver_ids, ',') FROM public.driver_online_hourly WHERE hour_start = $H - interval '3 hours'" \
  "$DPA,$DPB"
# A statement does not see its own function's writes: read the table in the next one.
val "S4 a run recomputes the last hours" "SELECT public.snapshot_driver_online_hours()" "3"
val "S4 without duplicating them" "SELECT count(*) FROM public.driver_online_hourly" "4"
run $DB "DELETE FROM public.driver_online_hourly WHERE hour_start > $H - interval '4 hours'" >/dev/null
val "S5 after a cron outage it fills every missing hour, not only the last p_hours" \
  "SELECT public.snapshot_driver_online_hours(1)" "3"
val "S5 with the same values" \
  "SELECT string_agg(drivers_online::text, ',' ORDER BY hour_start) FROM public.driver_online_hourly" "1,2,0,0"
val "S6 the cron job is scheduled once, every hour" \
  "SELECT count(*) || ':' || max(schedule) FROM cron.job WHERE jobname = 'snapshot-driver-online-hours'" "1:7 * * * *"
has "S7 a client cannot read the hourly table" "$(as $ADMIN "SELECT count(*) FROM public.driver_online_hourly;")" "permission denied"
has "S8 a client cannot run the snapshot" "$(as $ADMIN "SELECT public.snapshot_driver_online_hours();")" "permission denied"

# --- the weekly pulse ---------------------------------------------------------------------
P="(SELECT public.admin_launch_pulse(2) AS j)"
val "P1 two Havana weeks, newest first" \
  "$(as $ADMIN "SELECT jsonb_array_length(j->'weeks') || ':' || (j->'weeks'->0->>'is_current') || ':' || (j->'weeks'->1->>'is_current') FROM $P p;")" \
  "2:true:false"
val "P2 this week's request funnel (test riders left out)" \
  "$(as $ADMIN "SELECT concat_ws('/', w->>'requests', w->>'riders_requesting', w->>'completed', w->>'riders_completed', w->>'accepted_canceled', w->>'offered_not_accepted', w->>'no_offer', w->>'open') FROM $P p, jsonb_extract_path(j, 'weeks', '0') w;")" \
  "5/2/1/1/1/1/1/1"
val "P3 this week's signups, drivers, codes, push, consents and referrals" \
  "$(as $ADMIN "SELECT concat_ws('/', w->>'signups', w->>'rider_signups', w->>'driver_signups', w->>'drivers_approved', w->>'coded_signups', w->>'signups_with_push', w->>'marketing_opt_ins', w->>'referrals_created', w->>'referrals_rewarded') FROM $P p, jsonb_extract_path(j, 'weeks', '0') w;")" \
  "9/3/6/2/1/3/1/1/1"
val "P4 every measured hour lands in one of the weeks" \
  "$(as $ADMIN "SELECT sum((w->>'hours_measured')::int) FROM $P p, jsonb_array_elements(j->'weeks') w;")" "4"
SAMEWEEK=$(run $DB "SELECT date_trunc('week', ($H - interval '4 hours') AT TIME ZONE 'America/Havana') = date_trunc('week', now() AT TIME ZONE 'America/Havana')")
if [ "$SAMEWEEK" = t ]; then
  val "P5 online average, hours with nobody and distinct drivers this week" \
    "$(as $ADMIN "SELECT concat_ws('/', w->>'online_avg', w->>'hours_nobody_pct', w->>'drivers_seen_online') FROM $P p, jsonb_extract_path(j, 'weeks', '0') w;")" \
    "0.75/50.0/2"
else
  echo "SKIP  P5 (the measured hours straddle the start of the Havana week)"
fi
val "P6 the current totals" \
  "$(as $ADMIN "SELECT concat_ws('/', n->>'users', n->>'users_with_push', n->>'users_opted_in', n->>'drivers_approved', n->>'drivers_approved_with_push', n->>'drivers_pending', n->>'drivers_under_review', n->>'drivers_online_now') FROM $P p, jsonb_extract_path(j, 'now') n;")" \
  "9/3/1/2/1/3/1/1"
has "P7 a non-admin cannot read the pulse" "$(as $R1 "SELECT public.admin_launch_pulse();")" "Admin only"
has "P8 anon cannot call the pulse" "$(anon "SELECT public.admin_launch_pulse();")" "permission denied"

# --- incomplete driver signups + outreach ------------------------------------------------
I="public.admin_incomplete_driver_signups()"
val "I1 only non-test drivers stuck in pending_verification" \
  "$(as $ADMIN "SELECT string_agg(full_name, ',' ORDER BY full_name) FROM $I;")" "Paula,Pedro,Pepe"
val "I2 nothing uploaded: every required document missing, in onboarding order" \
  "$(as $ADMIN "SELECT concat_ws('|', phone, docs_uploaded, array_to_string(missing_docs, ','), has_push, last_sign_in_at = '2026-10-01 12:00+00') FROM $I WHERE full_name = 'Pepe';")" \
  "+5355500001|0|national_id,selfie,drivers_license,vehicle_registration,vehicle_photo|f|t"
val "I3 a re-upload replaces a rejected document; optional documents do not count" \
  "$(as $ADMIN "SELECT concat_ws('|', docs_uploaded, array_to_string(missing_docs, ','), cardinality(rejected_docs), has_push) FROM $I WHERE full_name = 'Paula';")" \
  "3|vehicle_registration,vehicle_photo|0|t"
val "I4 a document whose latest upload was rejected is listed as rejected, not missing" \
  "$(as $ADMIN "SELECT concat_ws('|', docs_uploaded, array_to_string(missing_docs, ','), array_to_string(rejected_docs, ',')) FROM $I WHERE full_name = 'Pedro';")" \
  "1|selfie,drivers_license,vehicle_registration|vehicle_photo"
run $DB "$(as $ADMIN "INSERT INTO public.driver_outreach_log (driver_profile_id, admin_id, note, created_at) VALUES ('$DP1', '$R1', '  Le escribí por WhatsApp  ', '2020-01-01');")" >/dev/null
val "O1 who and when come from the session; the note is trimmed" \
  "SELECT (admin_id = '$ADMIN') || '|' || (created_at > now() - interval '1 minute') || '|' || note || '|' || channel FROM public.driver_outreach_log" \
  "true|true|Le escribí por WhatsApp|whatsapp"
run $DB "$(as $ADMIN "INSERT INTO public.driver_outreach_log (driver_profile_id, channel, note) VALUES ('$DP1', 'llamada', '   ');")" >/dev/null
val "O2 the view shows the count and the latest contact" \
  "$(as $ADMIN "SELECT concat_ws('|', contact_count, last_contact_by, last_contact_channel, coalesce(last_contact_note, 'null'), last_contact_at > now() - interval '1 minute') FROM $I WHERE full_name = 'Pepe';")" \
  "2|Ada|llamada|null|t"
val "O3 drivers never contacted show zero" \
  "$(as $ADMIN "SELECT contact_count || '|' || coalesce(last_contact_at::text, 'null') FROM $I WHERE full_name = 'Paula';")" "0|null"
has "O4 a non-admin cannot log a contact" \
  "$(as $R1 "INSERT INTO public.driver_outreach_log (driver_profile_id, note) VALUES ('$DP1', 'x');")" "row-level security"
val "O5 a non-admin sees no contacts" "$(as $R1 "SELECT count(*) FROM public.driver_outreach_log;")" "0"
has "O6 the log is append-only for the admin (no update)" \
  "$(as $ADMIN "UPDATE public.driver_outreach_log SET note = 'x';")" "permission denied"
has "O7 the log is append-only for the admin (no delete)" \
  "$(as $ADMIN "DELETE FROM public.driver_outreach_log;")" "permission denied"
has "O7b nor truncate it (TRUNCATE ignores RLS, so only the grants stop it)" \
  "$(as $ADMIN "TRUNCATE public.driver_outreach_log;")" "permission denied"
has "O8 anon cannot read the log" "$(anon "SELECT count(*) FROM public.driver_outreach_log;")" "permission denied"
has "O9 a non-admin cannot list the drivers" "$(as $R1 "SELECT count(*) FROM $I;")" "Admin only"
has "O10 anon cannot list the drivers" "$(anon "SELECT count(*) FROM $I;")" "permission denied"

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
