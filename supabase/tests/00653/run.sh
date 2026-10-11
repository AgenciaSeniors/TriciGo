#!/usr/bin/env bash
# Rehearsal runner for migration 00653 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00653/run.sh none
#       -> scaffold (prod's tables, policies and grants for chat, lost items, support and incidents) + tests (RED)
#   supabase/tests/00653/run.sh supabase/migrations/00653_chat_support_lost_items_guards.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00653/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr653
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

RIDER=a0000000-0000-4000-8000-000000000001     # customer of ACTIVE, DONE and NODRIVER
RIDER2=a0000000-0000-4000-8000-000000000002    # customer of FOREIGN
STRANGER=a0000000-0000-4000-8000-000000000003  # party of no ride
DIEGO=d0000000-0000-4000-8000-000000000004     # driver of ACTIVE, DONE and FOREIGN
EVA=e0000000-0000-4000-8000-000000000005       # platform admin
DP_DIEGO=dd000000-0000-4000-8000-000000000004
ACTIVE=11111111-0000-4000-8000-000000000001
DONE=11111111-0000-4000-8000-000000000002
FOREIGN=11111111-0000-4000-8000-000000000003
NODRIVER=11111111-0000-4000-8000-000000000004
TICKET=22222222-0000-4000-8000-000000000001
LI1=33333333-0000-4000-8000-000000000001       # RIDER's report on DONE, still 'reported'
LIF=33333333-0000-4000-8000-000000000002       # RIDER's report on DONE, already 'found'

# as UID SQL -> SQL as authenticated with JWT subject UID; rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
asanon(){ printf "BEGIN; SET LOCAL request.jwt.claims = '{\"role\":\"anon\"}'; SET LOCAL ROLE anon; %s ROLLBACK;" "$1"; }
asservice(){ printf "BEGIN; SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}'; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1"; }
CHAT(){ echo "INSERT INTO public.ride_messages (ride_id, sender_id, body) VALUES ('$1', '$2', '${3:-hola}');"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name) VALUES
    ('$RIDER', 'customer', 'Rider'), ('$RIDER2', 'customer', 'Rider Two'), ('$STRANGER', 'customer', 'Stranger'),
    ('$DIEGO', 'driver', 'Diego'), ('$EVA', 'admin', 'Eva');
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_DIEGO', '$DIEGO');
  INSERT INTO public.rides (id, customer_id, driver_id, status, share_token) VALUES
    ('$ACTIVE', '$RIDER', '$DP_DIEGO', 'in_progress', 'tok-active'),
    ('$DONE', '$RIDER', '$DP_DIEGO', 'completed', 'tok-done'),
    ('$FOREIGN', '$RIDER2', '$DP_DIEGO', 'completed', 'tok-foreign'),
    ('$NODRIVER', '$RIDER', NULL, 'searching', NULL);
  INSERT INTO public.support_tickets (id, user_id, category, subject) VALUES ('$TICKET', '$RIDER', 'other', 'Ayuda');
  INSERT INTO public.lost_items (id, ride_id, reporter_id, driver_id, description, status) VALUES
    ('$LI1', '$DONE', '$RIDER', '$DIEGO', 'mochila', 'reported'),
    ('$LIF', '$DONE', '$RIDER', '$DIEGO', 'llaves', 'found');" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== chat =="
val "C1 rider writes during the ride; the driver gets the push" \
  "$(as $RIDER "$(CHAT $ACTIVE $RIDER) SELECT count(*) FROM public.outbox WHERE kind = 'chat_push' AND target = '$DIEGO';")" "1"
val "C2 driver writes during the ride; the rider gets the push" \
  "$(as $DIEGO "$(CHAT $ACTIVE $DIEGO) SELECT count(*) FROM public.outbox WHERE kind = 'chat_push' AND target = '$RIDER';")" "1"
err "C3 rider cannot write once the ride is completed" "$(as $RIDER "$(CHAT $DONE $RIDER)")" "chat_closed"
err "C4 driver cannot write once the ride is completed" "$(as $DIEGO "$(CHAT $DONE $DIEGO)")" "chat_closed"
err "C5 a ride still searching has no chat" "$(as $RIDER "$(CHAT $NODRIVER $RIDER)")" "chat_closed"
err "C6 blank message" "$(as $RIDER "$(CHAT $ACTIVE $RIDER '   ')")" "chat_message_length"
err "C7 message over 1000 characters" \
  "$(as $RIDER "INSERT INTO public.ride_messages (ride_id, sender_id, body) VALUES ('$ACTIVE', '$RIDER', repeat('x', 1001));")" "chat_message_length"
val "C8 created_at is the server's and read_at starts empty" \
  "$(as $RIDER "INSERT INTO public.ride_messages (ride_id, sender_id, body, created_at, read_at) VALUES ('$ACTIVE', '$RIDER', 'c8', '2020-01-01', now());
     SELECT (created_at > now() - interval '1 minute') || '|' || (read_at IS NULL) FROM public.ride_messages WHERE body = 'c8';")" "true|true"
val "C9 the service role still writes on a closed ride" \
  "$(asservice "$(CHAT $DONE $DIEGO) SELECT count(*) FROM public.ride_messages WHERE ride_id = '$DONE';")" "1"

echo "== lost items =="
err "L1 a stranger cannot report on someone else's ride" \
  "$(as $STRANGER "INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description) VALUES ('$FOREIGN', '$STRANGER', '$DIEGO', 'texto');")" \
  "lost_item_not_your_ride"
val "L2 the rider's report gets the ride's driver and starts clean" \
  "$(as $RIDER "INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description, status, admin_notes, return_fee_cup, resolved_by)
                VALUES ('$DONE', '$RIDER', '$STRANGER', 'L2', 'returned', 'nota', 999, '$EVA');
     SELECT driver_id || '|' || status || '|' || coalesce(admin_notes, '-') || '|' || coalesce(return_fee_cup::text, '-') || '|' || coalesce(resolved_by::text, '-')
       FROM public.lost_items WHERE description = 'L2';")" "$DIEGO|reported|-|-|-"
val "L2b and the push goes to the ride's driver" \
  "$(as $RIDER "INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description) VALUES ('$DONE', '$RIDER', '$STRANGER', 'L2b');
     SELECT string_agg(target::text, ',') FROM public.outbox WHERE kind = 'lost_item_push' AND detail = 'L2b';")" "$DIEGO"
err "L3 at most 5 reports per ride" \
  "$(as $RIDER "INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description) VALUES
                 ('$DONE', '$RIDER', '$DIEGO', 'a'), ('$DONE', '$RIDER', '$DIEGO', 'b'), ('$DONE', '$RIDER', '$DIEGO', 'c');
               INSERT INTO public.lost_items (ride_id, reporter_id, driver_id, description) VALUES ('$DONE', '$RIDER', '$DIEGO', 'd');")" \
  "lost_item_limit"
err "L4 a ride without a driver" \
  "$(as $RIDER "INSERT INTO public.lost_items (ride_id, reporter_id, description) VALUES ('$NODRIVER', '$RIDER', 'x');")" "lost_item_not_your_ride"
val "L5 driver answers, arranges and returns; resolved_by is the driver" \
  "$(as $DIEGO "UPDATE public.lost_items SET driver_found = true, status = 'found', driver_response = 'la tengo' WHERE id = '$LI1';
     UPDATE public.lost_items SET status = 'return_arranged', return_fee_cup = 200, return_location = 'Parque Central', return_notes = 'a las 5' WHERE id = '$LI1';
     UPDATE public.lost_items SET status = 'returned', resolved_by = '$STRANGER', resolved_at = '2020-01-01' WHERE id = '$LI1';
     SELECT status || '|' || resolved_by || '|' || (resolved_at > now() - interval '1 minute') || '|' || return_fee_cup FROM public.lost_items WHERE id = '$LI1';")" \
  "returned|$DIEGO|true|200"
val "L5b driver answers not found" \
  "$(as $DIEGO "UPDATE public.lost_items SET driver_found = false, status = 'not_found', driver_response = 'no está' WHERE id = '$LI1';
     SELECT status || '|' || driver_found FROM public.lost_items WHERE id = '$LI1';")" "not_found|false"
err "L6 driver cannot write admin notes" "$(as $DIEGO "UPDATE public.lost_items SET admin_notes = 'x' WHERE id = '$LI1';")" "lost_item_column"
err "L7 driver cannot move the report to someone else" \
  "$(as $DIEGO "UPDATE public.lost_items SET reporter_id = '$STRANGER' WHERE id = '$LI1';")" "lost_item_column"
err "L8 driver cannot jump from reported to returned" \
  "$(as $DIEGO "UPDATE public.lost_items SET status = 'returned' WHERE id = '$LI1';")" "lost_item_status"
err "L9 driver cannot close the case" "$(as $DIEGO "UPDATE public.lost_items SET status = 'closed' WHERE id = '$LIF';")" "lost_item_status"
err "L10 negative return fee" \
  "$(as $DIEGO "UPDATE public.lost_items SET status = 'return_arranged', return_fee_cup = -5 WHERE id = '$LIF';")" "lost_item_fee"
val "L11 reporter edits the description while it is reported" \
  "$(as $RIDER "UPDATE public.lost_items SET description = 'mochila azul', category = 'bag' WHERE id = '$LI1';
     SELECT description || '|' || category FROM public.lost_items WHERE id = '$LI1';")" "mochila azul|bag"
err "L12 reporter cannot change the status" "$(as $RIDER "UPDATE public.lost_items SET status = 'returned' WHERE id = '$LI1';")" "lost_item_column"
err "L13 reporter cannot edit once the driver answered" \
  "$(as $RIDER "UPDATE public.lost_items SET description = 'otra' WHERE id = '$LIF';")" "lost_item_locked"
err "L14 reporter cannot stamp resolved_by" \
  "$(as $RIDER "UPDATE public.lost_items SET resolved_by = '$RIDER' WHERE id = '$LI1';")" "lost_item_column"
val "L15 an admin still writes admin notes and closes" \
  "$(as $EVA "UPDATE public.lost_items SET admin_notes = 'nota', status = 'closed', resolved_by = '$EVA' WHERE id = '$LI1';
     SELECT admin_notes || '|' || status FROM public.lost_items WHERE id = '$LI1';")" "nota|closed"

echo "== support =="
val "T1 a ticket starts open, normal and unassigned" \
  "$(as $RIDER "INSERT INTO public.support_tickets (user_id, category, subject, status, priority, assigned_to, resolved_at)
                VALUES ('$RIDER', 'other', 'T1', 'resolved', 'urgent', '$EVA', now());
     SELECT status || '|' || priority || '|' || coalesce(assigned_to::text, '-') || '|' || (resolved_at IS NULL) FROM public.support_tickets WHERE subject = 'T1';")" \
  "open|normal|-|true"
err "T2 a ticket cannot point at someone else's ride" \
  "$(as $RIDER "INSERT INTO public.support_tickets (user_id, ride_id, category, subject) VALUES ('$RIDER', '$FOREIGN', 'other', 'T2');")" "ticket_ride_not_yours"
val "T3 a ticket on the user's own ride" \
  "$(as $RIDER "INSERT INTO public.support_tickets (user_id, ride_id, category, subject) VALUES ('$RIDER', '$DONE', 'other', 'T3');
     SELECT count(*) FROM public.support_tickets WHERE subject = 'T3';")" "1"
val "T4 a user's message is never from staff" \
  "$(as $RIDER "INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin) VALUES ('$TICKET', '$RIDER', 'T4', true);
     SELECT is_admin FROM public.ticket_messages WHERE message = 'T4';")" "f"
val "T5 an admin's reply stays from staff" \
  "$(as $EVA "INSERT INTO public.ticket_messages (ticket_id, sender_id, message, is_admin) VALUES ('$TICKET', '$EVA', 'T5', true);
     SELECT is_admin FROM public.ticket_messages WHERE message = 'T5';")" "t"

echo "== incidents =="
val "I1 the chat report against the other party starts open and medium" \
  "$(as $RIDER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, severity, description, status)
                VALUES ('$DONE', '$RIDER', '$DIEGO', 'driver_behavior', 'critical', 'I1', 'open');
     SELECT status || '|' || severity FROM public.incident_reports WHERE description = 'I1';")" "open|medium"
val "I1b the driver reports the rider" \
  "$(as $DIEGO "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description)
                VALUES ('$DONE', '$DIEGO', '$RIDER', 'passenger_behavior', 'I1b');
     SELECT count(*) FROM public.incident_reports WHERE description = 'I1b';")" "1"
err "I2 a stranger cannot report someone else's ride" \
  "$(as $STRANGER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description)
                   VALUES ('$FOREIGN', '$STRANGER', '$DIEGO', 'safety_concern', 'I2');")" "incident_not_your_ride"
err "I3 a report only names the other party of the ride" \
  "$(as $RIDER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description)
                VALUES ('$DONE', '$RIDER', '$STRANGER', 'safety_concern', 'I3');")" "incident_wrong_party"
err "I3b without a ride it names nobody" \
  "$(as $RIDER "INSERT INTO public.incident_reports (reported_by, against_user_id, type, description)
                VALUES ('$RIDER', '$STRANGER', 'safety_concern', 'I3b');")" "incident_wrong_party"
val "I4 a report cannot be born resolved" \
  "$(as $RIDER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description, status, resolved_by, resolved_at, resolution_notes, review_id)
                VALUES ('$DONE', '$RIDER', '$DIEGO', 'safety_concern', 'I4', 'resolved', '$EVA', now(), 'x', gen_random_uuid());
     SELECT status || '|' || coalesce(resolved_by::text, '-') || '|' || coalesce(resolution_notes, '-') || '|' || coalesce(review_id::text, '-')
       FROM public.incident_reports WHERE description = 'I4';")" "open|-|-|-"
val "I5 an SOS on someone else's ride goes through without the ride, and texts no foreign link" \
  "$(as $STRANGER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description)
                   VALUES ('$FOREIGN', '$STRANGER', '$DIEGO', 'sos', 'I5');
     SELECT coalesce(ride_id::text, '-') || '|' || coalesce(against_user_id::text, '-') || '|' || severity
         || '|' || (SELECT detail FROM public.outbox WHERE kind = 'sos_sms' AND target = '$STRANGER')
       FROM public.incident_reports WHERE description = 'I5';")" "-|-|critical|-"
val "I6 an SOS on the rider's own ride keeps the ride, the driver and the link" \
  "$(as $RIDER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, severity, description, status)
                VALUES ('$ACTIVE', '$RIDER', '$DIEGO', 'sos', 'critical', 'I6', 'open');
     SELECT ride_id || '|' || against_user_id || '|' || severity || '|' || (SELECT detail FROM public.outbox WHERE kind = 'sos_sms' AND target = '$RIDER')
       FROM public.incident_reports WHERE description = 'I6';")" "$ACTIVE|$DIEGO|critical|tok-active"
val "I7 an SOS naming a wrong person still goes through, without the name" \
  "$(as $RIDER "INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, type, description)
                VALUES ('$ACTIVE', '$RIDER', '$STRANGER', 'sos', 'I7');
     SELECT ride_id || '|' || coalesce(against_user_id::text, '-') FROM public.incident_reports WHERE description = 'I7';")" "$ACTIVE|-"
val "I8 report_review (SECURITY DEFINER) keeps its review_id and severity" \
  "$(as $RIDER "SELECT public.report_review_standin('$DONE', '$DIEGO', '44444444-0000-4000-8000-000000000001');
     SELECT type || '|' || severity || '|' || review_id FROM public.incident_reports WHERE type = 'review_abuse';")" \
  "review_abuse|low|44444444-0000-4000-8000-000000000001"

echo "== helper =="
err "H1 anon cannot call _ride_context_for_caller" \
  "$(asanon "SELECT * FROM public._ride_context_for_caller('$DONE');")" "permission denied"
val "H2 it tells a stranger nothing" "$(as $STRANGER "SELECT count(*) FROM public._ride_context_for_caller('$DONE');")" "0"
val "H3 it tells the rider their side" \
  "$(as $RIDER "SELECT caller_role || '|' || ride_status || '|' || other_user_id FROM public._ride_context_for_caller('$DONE');")" "customer|completed|$DIEGO"
val "H4 and the driver theirs" \
  "$(as $DIEGO "SELECT caller_role || '|' || other_user_id FROM public._ride_context_for_caller('$DONE');")" "driver|$RIDER"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  TMP=$(mktemp -d)
  # N1: without the status check, C3 passes again.
  sed "s/'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination') THEN/'accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination', 'completed') THEN/" "$MIG" > "$TMP/n1.sql"
  if cmp -s "$MIG" "$TMP/n1.sql"; then ko "N1 mutation" "sed changed nothing"; else
    fresh pr653n >/dev/null && $BIN/psql $CONN -d pr653n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n1.sql" >/dev/null 2>&1
    val "N1 C3 catches a missing status check" "$(as $RIDER "$(CHAT $DONE $RIDER) SELECT 'written';")" "written" pr653n; fi
  # N2: without dropping the foreign ride, the SOS texts that ride's link.
  grep -v "      NEW.ride_id := NULL;" "$MIG" > "$TMP/n2.sql"
  if cmp -s "$MIG" "$TMP/n2.sql"; then ko "N2 mutation" "grep removed nothing"; else
    fresh pr653n >/dev/null && $BIN/psql $CONN -d pr653n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n2.sql" >/dev/null 2>&1
    val "N2 I5 catches a leaked share link" \
      "$(as $STRANGER "INSERT INTO public.incident_reports (ride_id, reported_by, type, description) VALUES ('$FOREIGN', '$STRANGER', 'sos', 'n2');
         SELECT detail FROM public.outbox WHERE kind = 'sos_sms';")" "tok-foreign" pr653n; fi
  # N3: the verification block refuses a missing trigger.
  python3 - "$MIG" "$TMP/n3.sql" <<'PY'
import sys
s = open(sys.argv[1]).read()
block = "CREATE OR REPLACE TRIGGER trg_ticket_messages_client_guard\n  BEFORE INSERT ON public.ticket_messages\n  FOR EACH ROW EXECUTE FUNCTION public.tg_ticket_messages_client_guard();\n"
assert s.count(block) == 1
open(sys.argv[2], 'w').write(s.replace(block, ''))
PY
  fresh pr653n >/dev/null
  r=$($BIN/psql $CONN -d pr653n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n3.sql" 2>&1 | tr -d '\r')
  if echo "$r" | grep -q "triggers missing or disabled: trg_ticket_messages_client_guard"; then ok "N3 the verification block refuses a missing trigger"; else ko "N3" "got [$r]"; fi
  # N4: a CRLF copy (SQL Editor pasted from Windows) applies and behaves.
  sed 's/$/\r/' "$MIG" > "$TMP/n4.sql"
  fresh pr653n >/dev/null
  if $BIN/psql $CONN -d pr653n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$TMP/n4.sql" >/dev/null 2>&1; then
    err "N4 a CRLF copy applies and still closes the chat" "$(as $RIDER "$(CHAT $DONE $RIDER)")" "chat_closed" pr653n
  else ko "N4" "CRLF copy did not apply"; fi
  rm -rf "$TMP"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr653n" >/dev/null 2>&1
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
