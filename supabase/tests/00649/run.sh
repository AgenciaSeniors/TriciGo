#!/usr/bin/env bash
# Rehearsal runner for migration 00649 (scheduled campaigns). Local Postgres 16, no Supabase stack.
#   supabase/tests/00649/run.sh none
#       -> scaffold + seed + tests (RED: none of the 00649 objects exist)
#   supabase/tests/00649/run.sh supabase/migrations/00649_scheduled_campaigns.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# REHEARSAL_DB=<name> uses another database (default pr649), e.g. to run a mutated migration.
# Cluster: CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB="${REHEARSAL_DB:-pr649}"
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r'); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $(echo "$r" | paste -sd' ' -)"; fi; }
# hasv: like has, with VERBOSITY verbose (an error prints "ERROR:  <SQLSTATE>: ..." and its DETAIL)
# and the whole output on one line, so one regex can check SQLSTATE, message and DETAIL together.
hasv(){ local r; r=$($P -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | paste -sd' ' -); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $r"; fi; }
# as UID -> become an authenticated user with that JWT subject, for the rest of the transaction
# (SET LOCAL prints nothing; a SELECT set_config would add a row to every output)
as(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
SVC="SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role;"
A=a0000000-0000-4000-8000-0000000000a1; M1=a0000000-0000-4000-8000-0000000000b1
M2=a0000000-0000-4000-8000-0000000000b2; CU=a0000000-0000-4000-8000-0000000000e1
# rcp CAMPAIGN_ID -> the labels of its recipients, sorted
rcp(){ echo "SELECT coalesce(string_agg(u.full_name, ',' ORDER BY u.full_name COLLATE \"C\"), '-')
              FROM unnest(public.campaign_recipient_ids('$1')) r JOIN public.users u ON u.id = r;"; }
# mk ID NAME STATUS SCHEDULED_AT STARTED_AT CREATED_BY -> a campaign written as the owner (no guard)
mk(){ echo "INSERT INTO public.campaigns (id, name, segment_type, audience_role, message_title, message_body, status, scheduled_at, started_at, created_by)
            VALUES ('$1', '$2', 'all', 'customer', 't', 'b', '$3', $4, $5, $6);"; }

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
$P -f "$DIR/seed.sql" >/dev/null 2>&1 || { echo "seed failed"; exit 1; }
$P -c "GRANT UPDATE (name) ON public.campaigns TO authenticated" >/dev/null || { echo "column grant failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres) =="
  $P -1 -c "SET ROLE postgres" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  $P -1 -c "SET ROLE postgres" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== recipients (campaign_recipient_ids, as service_role) =="
R(){ val "$1" "BEGIN; $SVC $(rcp "$2") ROLLBACK;" "$3"; }
R "R1 all customers, blocked excluded"            ca000000-0000-4000-8000-000000000001 "c_active,c_new,c_power,caller"
R "R2 new customers (7 days)"                      ca000000-0000-4000-8000-000000000002 "c_new"
R "R3 power customers (>10 rides, any status)"     ca000000-0000-4000-8000-000000000003 "c_power"
R "R4 inactive customers (no ride in 30 days)"     ca000000-0000-4000-8000-000000000004 "c_new,c_power"
R "R5 customers in La Habana, blocked and drivers excluded" ca000000-0000-4000-8000-000000000005 "c_new"
R "R6 by_city without a city reaches nobody"       ca000000-0000-4000-8000-000000000006 "-"
R "R7 all drivers, blocked excluded"               ca000000-0000-4000-8000-000000000007 "d_hav,d_idle,d_power"
R "R8 new drivers, blocked excluded"               ca000000-0000-4000-8000-000000000008 "d_idle"
R "R9 power drivers (>10 completed), blocked excluded" ca000000-0000-4000-8000-000000000009 "d_power"
R "R10 inactive drivers (drove no ride in 30 days), blocked excluded" ca000000-0000-4000-8000-000000000010 "d_idle"
# R11: 00649's CHECK refuses an unknown segment, so the row is planted with the CHECK dropped, inside
# the test's own transaction. It proves the function's own fallback, should the CHECK ever go.
val "R11 an unknown segment reaches nobody" \
  "BEGIN; SET LOCAL ROLE postgres; ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_segment_type_chk;
   INSERT INTO public.campaigns (id, name, segment_type, audience_role, message_title, message_body, status)
   VALUES ('ca000000-0000-4000-8000-000000000011', 'unknown', 'whatever', 'customer', 't', 'b', 'draft');
   RESET ROLE; $SVC $(rcp ca000000-0000-4000-8000-000000000011) ROLLBACK;" "-"
val "R12 a missing campaign reaches nobody" \
  "BEGIN; $SVC $(rcp 00000000-0000-4000-8000-000000000000) ROLLBACK;" "-"
R "R13 drivers in La Habana, blocked and customers excluded" ca000000-0000-4000-8000-000000000012 "d_hav"

echo "== privileges =="
val "P1 clients cannot run the server-only functions; authenticated can cancel" \
  "SELECT has_function_privilege('authenticated', 'public.campaign_recipient_ids(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.claim_campaigns(uuid, integer)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.dispatch_due_campaigns()', 'EXECUTE') || ',' ||
          has_function_privilege('anon', 'public.cancel_campaign(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('authenticated', 'public.cancel_campaign(uuid)', 'EXECUTE') || ',' ||
          has_function_privilege('service_role', 'public.claim_campaigns(uuid, integer)', 'EXECUTE') || ',' ||
          has_function_privilege('service_role', 'public.cancel_campaign(uuid)', 'EXECUTE')" \
  "false,false,false,false,true,true,false"
val "P2 clients cannot UPDATE, TRUNCATE or add triggers to campaigns, anon cannot INSERT; service_role keeps UPDATE" \
  "SELECT has_table_privilege('authenticated', 'public.campaigns', 'UPDATE') || ',' ||
          has_table_privilege('authenticated', 'public.campaigns', 'TRUNCATE') || ',' ||
          has_table_privilege('authenticated', 'public.campaigns', 'TRIGGER') || ',' ||
          has_table_privilege('anon', 'public.campaigns', 'INSERT') || ',' ||
          has_table_privilege('service_role', 'public.campaigns', 'UPDATE')" \
  "false,false,false,false,true"
# P3: the scaffold grants UPDATE (name) to authenticated before the migration runs; revoking the
# table privilege revokes the column privileges too (in RED the grant simply stays).
val "P3 a column-level UPDATE grant given before the migration does not survive it" \
  "SELECT has_any_column_privilege('authenticated', 'public.campaigns', 'UPDATE')::text" "false"

echo "== client inserts (insert guard) =="
NEW_ROW="INSERT INTO public.campaigns (name, segment_type, message_title, message_body, status, sent_count, scheduled_at, created_by)"
val "I1 marketing insert becomes scheduled, every counter and lifecycle column reset, created_by forced, past time clamped to now" \
  "BEGIN; $(as $M1) INSERT INTO public.campaigns (name, segment_type, message_title, message_body, status, sent_count,
     scheduled_at, created_by, push_sent, email_sent, recipient_count, last_error, canceled_at, canceled_by, started_at, sent_at)
   VALUES ('i1', 'all', 't', 'b', 'draft', 99, '2000-01-01', '$M2', 7, 8, 9, 'forged', now(), '$M2', now(), now());
   SELECT status || ',' || sent_count || ',' || push_sent || ',' || email_sent || ',' || recipient_count || ',' ||
          (created_by = '$M1') || ',' || (scheduled_at = now()) || ',' || coalesce(last_error, 'NULL') || ',' ||
          coalesce(canceled_at::text, 'NULL') || ',' || coalesce(canceled_by::text, 'NULL') || ',' ||
          coalesce(started_at::text, 'NULL') || ',' || coalesce(sent_at::text, 'NULL')
   FROM public.campaigns WHERE name = 'i1'; ROLLBACK;" \
  "scheduled,0,0,0,0,true,true,NULL,NULL,NULL,NULL,NULL"
val "I2 a future scheduled_at is kept" \
  "BEGIN; $(as $M1) $NEW_ROW VALUES ('i2', 'all', 't', 'b', 'scheduled', 0, now() + interval '2 hours', NULL);
   SELECT status || ',' || (scheduled_at > now() + interval '1 hour') FROM public.campaigns WHERE name = 'i2'; ROLLBACK;" \
  "scheduled,true"
val "I3 legacy: an insert that says sent is kept as sent (old panel already delivered it), created_by still forced" \
  "BEGIN; $(as $A) $NEW_ROW VALUES ('i3', 'all', 't', 'b', 'sent', 5, NULL, '$M2');
   SELECT status || ',' || sent_count || ',' || (created_by = '$A') FROM public.campaigns WHERE name = 'i3'; ROLLBACK;" \
  "sent,5,true"
val "I4 an admin insert that says sending becomes scheduled, a NULL scheduled_at becomes now()" \
  "BEGIN; $(as $A) $NEW_ROW VALUES ('i4', 'all', 't', 'b', 'sending', 0, NULL, NULL);
   SELECT status || ',' || coalesce((scheduled_at = now())::text, 'NULL') FROM public.campaigns WHERE name = 'i4'; ROLLBACK;" \
  "scheduled,true"
val "I5 service_role keeps what it writes" \
  "BEGIN; $SVC $NEW_ROW VALUES ('i5', 'all', 't', 'b', 'draft', 3, NULL, NULL);
   SELECT status || ',' || sent_count FROM public.campaigns WHERE name = 'i5'; ROLLBACK;" \
  "draft,3"
has "I6 a customer cannot insert" \
  "BEGIN; $(as $CU) $NEW_ROW VALUES ('i6', 'all', 't', 'b', 'draft', 0, NULL, NULL); ROLLBACK;" \
  "row-level security"
has "I7 marketing cannot UPDATE a campaign directly" \
  "BEGIN; $(as $M1) UPDATE public.campaigns SET status = 'sent'; ROLLBACK;" \
  "permission denied for table campaigns"
has "I8 the status CHECK rejects an unknown status" \
  "BEGIN; SET LOCAL ROLE postgres; $NEW_ROW VALUES ('i8', 'all', 't', 'b', 'bogus', 0, NULL, NULL); ROLLBACK;" \
  "campaigns_status_chk"
OWN_ROW="INSERT INTO public.campaigns (name, segment_type, audience_role, channel, message_title, message_body, status, scheduled_at)"
has "I9 a scheduled campaign without a time is refused (it would never be due)" \
  "BEGIN; SET LOCAL ROLE postgres; $OWN_ROW VALUES ('i9', 'all', 'customer', 'push', 't', 'b', 'scheduled', NULL); ROLLBACK;" \
  "campaigns_scheduled_at_chk"
has "I10 an unknown channel is refused" \
  "BEGIN; SET LOCAL ROLE postgres; $OWN_ROW VALUES ('i10', 'all', 'customer', 'sms', 't', 'b', 'draft', NULL); ROLLBACK;" \
  "campaigns_channel_chk"
has "I11 an unknown segment is refused" \
  "BEGIN; SET LOCAL ROLE postgres; $OWN_ROW VALUES ('i11', 'whatever', 'customer', 'push', 't', 'b', 'draft', NULL); ROLLBACK;" \
  "campaigns_segment_type_chk"
has "I12 an unknown audience is refused" \
  "BEGIN; SET LOCAL ROLE postgres; $OWN_ROW VALUES ('i12', 'all', 'admin', 'push', 't', 'b', 'draft', NULL); ROLLBACK;" \
  "campaigns_audience_role_chk"
has "I13 canceled_by must be an existing account" \
  "BEGIN; SET LOCAL ROLE postgres; INSERT INTO public.campaigns (name, segment_type, message_title, message_body, status, canceled_by)
   VALUES ('i13', 'all', 't', 'b', 'cancelled', '00000000-0000-4000-8000-0000000000ff'); ROLLBACK;" \
  "campaigns_canceled_by_fkey"
val "I14 deleting the account that cancelled keeps the campaign, with canceled_by emptied" \
  "BEGIN; SET LOCAL ROLE postgres; INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-0000000000fe');
   INSERT INTO public.campaigns (name, segment_type, message_title, message_body, status, canceled_by)
   VALUES ('i14', 'all', 't', 'b', 'cancelled', '00000000-0000-4000-8000-0000000000fe');
   DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000fe';
   SELECT status || ',' || coalesce(canceled_by::text, 'NULL') FROM public.campaigns WHERE name = 'i14'; ROLLBACK;" \
  "cancelled,NULL"

echo "== claim =="
K1=cb000000-0000-4000-8000-000000000001; K2=cb000000-0000-4000-8000-000000000002
K3=cb000000-0000-4000-8000-000000000003; K4=cb000000-0000-4000-8000-000000000004
SETUP_K="SET LOCAL ROLE postgres;
  $(mk $K1 k1 scheduled "now() - interval '10 minutes'" NULL "'$M1'")
  $(mk $K2 k2 scheduled "now() - interval '5 minutes'" NULL "'$M1'")
  $(mk $K3 k3 scheduled "now() + interval '1 hour'" NULL "'$M1'")
  $(mk $K4 k4 cancelled "now() - interval '20 minutes'" NULL "'$M1'")
  RESET ROLE;"
val "C1 claim takes only due scheduled campaigns, oldest first, and marks them sending" \
  "BEGIN; $SETUP_K $SVC SELECT string_agg(name || ':' || status || ':' || (started_at IS NOT NULL), ',' ORDER BY scheduled_at)
   FROM public.claim_campaigns(NULL, 5); ROLLBACK;" \
  "k1:sending:true,k2:sending:true"
val "C2 a campaign scheduled for later cannot be claimed by id" \
  "BEGIN; $SETUP_K $SVC SELECT count(*) FROM public.claim_campaigns('$K3', 1); ROLLBACK;" "0"
val "C3 p_limit is respected" \
  "BEGIN; $SETUP_K $SVC SELECT string_agg(name, ',') FROM public.claim_campaigns(NULL, 1); ROLLBACK;" "k1"
val "C4 a claimed campaign cannot be claimed again" \
  "BEGIN; $SETUP_K $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1);
   SELECT count(*) FROM public.claim_campaigns('$K1', 1); ROLLBACK;" "1;0"
# C5: two sessions at once. A holds the claim open for 3 s; B, meanwhile, skips the locked row
# at once (SKIP LOCKED): B's whole transaction must take under 1 s, not wait for A's commit.
$P -c "SET ROLE postgres; $(mk $K1 k1 scheduled "now() - interval '10 minutes'" NULL "'$M1'")" >/dev/null
( $P -c "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
val "C5 while another session holds the claim, a second claim gets nothing at once (no wait, no double send)" \
  "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1);
   SELECT (clock_timestamp() - now() < interval '1 second')::text; ROLLBACK;" "0;true"
wait
val "C6 after both sessions, the campaign is sending exactly once" \
  "SELECT status FROM public.campaigns WHERE id = '$K1'" "sending"
$P -c "SET ROLE postgres; DELETE FROM public.campaigns WHERE id = '$K1'" >/dev/null

echo "== cancel =="
SETUP_X="SET LOCAL ROLE postgres;
  $(mk $K1 x1 scheduled "now() + interval '1 hour'" NULL "'$M1'")
  $(mk $K2 x2 sending "now() - interval '1 minute'" "now()" "'$M1'")
  RESET ROLE;"
val "X1 marketing cancels its own scheduled campaign" \
  "BEGIN; $SETUP_X $(as $M1) SELECT public.cancel_campaign('$K1'); RESET ROLE;
   SELECT status || ',' || (canceled_by = '$M1') || ',' || (canceled_at IS NOT NULL) FROM public.campaigns WHERE id = '$K1'; ROLLBACK;" \
  "cancelled;cancelled,true,true"
FORBIDDEN="ERROR: +42501: Solo puedes cancelar las campañas que creaste\\. DETAIL: +campaign_cancel_forbidden( |\$)"
hasv "X2 marketing cannot cancel another account's campaign (42501, campaign_cancel_forbidden)" \
  "BEGIN; $SETUP_X $(as $M2) SELECT public.cancel_campaign('$K1'); ROLLBACK;" "$FORBIDDEN"
val "X3 an admin cancels any scheduled campaign" \
  "BEGIN; $SETUP_X $(as $A) SELECT public.cancel_campaign('$K1'); ROLLBACK;" "cancelled"
val "X4 a campaign already sending is not cancelled; its status comes back" \
  "BEGIN; $SETUP_X $(as $A) SELECT public.cancel_campaign('$K2'); RESET ROLE;
   SELECT status FROM public.campaigns WHERE id = '$K2'; ROLLBACK;" "sending;sending"
hasv "X5 a customer cannot cancel (42501, campaign_cancel_forbidden)" \
  "BEGIN; $SETUP_X $(as $CU) SELECT public.cancel_campaign('$K1'); ROLLBACK;" "$FORBIDDEN"
has "X6 anon cannot call cancel" \
  "BEGIN; SET LOCAL ROLE anon; SELECT public.cancel_campaign('$K1'); ROLLBACK;" "permission denied for function cancel_campaign"
val "X7 cancelling a missing campaign returns not_found" \
  "BEGIN; $(as $A) SELECT public.cancel_campaign('00000000-0000-4000-8000-000000000000'); ROLLBACK;" "not_found"
# X8: a claim holds the row (scheduled -> sending, not committed) for 3 s; a cancel in the meantime
# must wait for it and then see 'sending', not overwrite it with 'cancelled'.
$P -c "SET ROLE postgres; $(mk $K1 x8 scheduled "now() - interval '1 minute'" NULL "'$M1'")" >/dev/null
( $P -c "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
val "X8 a cancel during a claim waits for it and returns sending; the campaign keeps sending" \
  "BEGIN; $(as $A) SELECT public.cancel_campaign('$K1'); COMMIT; SELECT status FROM public.campaigns WHERE id = '$K1'" \
  "sending;sending"
wait
$P -c "SET ROLE postgres; DELETE FROM public.campaigns WHERE id = '$K1'" >/dev/null
# X9: the other order. The cancel holds the row for 3 s; the claim skips it (SKIP LOCKED), and once
# the cancel commits the campaign stays cancelled and nobody can claim it.
$P -c "SET ROLE postgres; $(mk $K1 x9 scheduled "now() - interval '1 minute'" NULL "'$M1'")" >/dev/null
( $P -c "BEGIN; $(as $A) SELECT public.cancel_campaign('$K1'); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 ) &
sleep 1
val "X9 a claim during a cancel gets nothing at once" \
  "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); ROLLBACK;" "0"
wait
val "X10 after the cancel commits, the campaign is cancelled and cannot be claimed" \
  "BEGIN; $SVC SELECT count(*) FROM public.claim_campaigns('$K1', 1); RESET ROLE;
   SELECT status FROM public.campaigns WHERE id = '$K1'; ROLLBACK;" "0;cancelled"
$P -c "SET ROLE postgres; DELETE FROM public.campaigns WHERE id = '$K1'" >/dev/null

echo "== dispatcher and cron job =="
val "D1 nothing due (one scheduled for later): returns 0 and calls nothing" \
  "BEGIN; SET LOCAL ROLE postgres; $(mk $K3 d1 scheduled "now() + interval '1 hour'" NULL "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE; SELECT count(*) FROM public.cron_http_post_calls; ROLLBACK;" "0;0"
val "D2 one due campaign: one call to send-campaign with the service key and {due:true}" \
  "BEGIN; SET LOCAL ROLE postgres; $(mk $K1 d2 scheduled "now() - interval '1 minute'" NULL "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT jobname || '|' || (url LIKE '%/functions/v1/send-campaign') || '|' || body::text || '|' || timeout_ms || '|' ||
          (headers->>'Authorization') || '|' || (headers->>'apikey') FROM public.cron_http_post_calls; ROLLBACK;" \
  "1;send-due-campaigns|true|{\"due\": true}|30000|Bearer test-service-key|test-service-key"
val "D3 a campaign stuck in sending for 20 minutes fails as interrupted; one 5 minutes old is left" \
  "BEGIN; SET LOCAL ROLE postgres;
   $(mk $K1 d3a sending "now() - interval '30 minutes'" "now() - interval '20 minutes'" "'$M1'")
   $(mk $K2 d3b sending "now() - interval '10 minutes'" "now() - interval '5 minutes'" "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT string_agg(name || ':' || status || ':' || coalesce(last_error, '-'), ',' ORDER BY name)
   FROM public.campaigns WHERE name IN ('d3a', 'd3b'); ROLLBACK;" \
  "0;d3a:failed:interrupted,d3b:sending:-"
val "D4 the cron job runs the dispatcher every minute" \
  "SELECT string_agg(jobname || '|' || schedule || '|' || command, ',') FROM cron.job WHERE jobname = 'send-due-campaigns'" \
  "send-due-campaigns|* * * * *|SELECT public.dispatch_due_campaigns();"
val "D5 the dispatcher swallows no error (its failures reach check_cron_sql_failures)" \
  "SELECT (prosrc !~* 'exception\\s+when')::text FROM pg_proc WHERE proname = 'dispatch_due_campaigns'" "true"
val "D6 the sweep leaves sent, cancelled and failed campaigns alone, however old their started_at" \
  "BEGIN; SET LOCAL ROLE postgres;
   $(mk $K1 d6a sent "now() - interval '30 minutes'" "now() - interval '20 minutes'" "'$M1'")
   $(mk $K2 d6b cancelled "now() - interval '30 minutes'" "now() - interval '20 minutes'" "'$M1'")
   $(mk $K3 d6c failed "now() - interval '30 minutes'" "now() - interval '20 minutes'" "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT string_agg(name || ':' || status || ':' || coalesce(last_error, '-'), ',' ORDER BY name)
   FROM public.campaigns WHERE name LIKE 'd6_'; ROLLBACK;" \
  "0;d6a:sent:-,d6b:cancelled:-,d6c:failed:-"
val "D7 two due campaigns make exactly one call (send-campaign takes them one at a time)" \
  "BEGIN; SET LOCAL ROLE postgres;
   $(mk $K1 d7a scheduled "now() - interval '2 minutes'" NULL "'$M1'")
   $(mk $K2 d7b scheduled "now() - interval '1 minute'" NULL "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT count(*) FROM public.cron_http_post_calls; ROLLBACK;" "2;1"
# NO_KEY: the vault has no service role key, for the rest of the transaction.
NO_KEY="CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text
  LANGUAGE sql SECURITY DEFINER AS \$\$ SELECT NULL::text \$\$;"
hasv "D8 a due campaign without the vault key fails the run (the watchdog sees it) and calls nothing" \
  "BEGIN; $NO_KEY SET LOCAL ROLE postgres; $(mk $K1 d8 scheduled "now() - interval '1 minute'" NULL "'$M1'") RESET ROLE;
   $SVC SELECT public.dispatch_due_campaigns(); ROLLBACK;" \
  "ERROR: +P0001: dispatch_due_campaigns: no service role key in the vault, 1 due campaign\\(s\\) not sent DETAIL: +campaign_dispatch_no_service_key"
val "D9 without the vault key and nothing due, the run is quiet" \
  "BEGIN; $NO_KEY $SVC SELECT public.dispatch_due_campaigns(); RESET ROLE;
   SELECT count(*) FROM public.cron_http_post_calls; ROLLBACK;" "0;0"

echo "== re-applying the migration =="
if [ "$MIG" = "none" ]; then
  ko "A1 a paused cron job is switched back on" "no migration"
  ko "A2 a copy pasted from Windows (CRLF) leaves the same function bodies" "no migration"
else
  $P -c "UPDATE cron.job SET active = false WHERE jobname = 'send-due-campaigns'" >/dev/null
  $P -1 -c "SET ROLE postgres" -f "$MIG" >/dev/null 2>&1 || ko "A1 a paused cron job is switched back on" "re-apply failed"
  val "A1 a paused cron job is switched back on" \
    "SELECT active FROM cron.job WHERE jobname = 'send-due-campaigns'" "t"
  BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
          WHERE proname IN ('tg_campaigns_client_insert', 'campaign_recipient_ids', 'claim_campaigns',
                            'cancel_campaign', 'dispatch_due_campaigns')"
  LF_BODIES=$($P -c "$BODIES")
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  if ! grep -q $'\r' "$CRLF"; then ko "A2 a copy pasted from Windows (CRLF) leaves the same function bodies" "the copy has no CR"
  elif ! $P -1 -c "SET ROLE postgres" -f "$CRLF" >/dev/null 2>&1; then ko "A2 a copy pasted from Windows (CRLF) leaves the same function bodies" "CRLF apply failed"
  else val "A2 a copy pasted from Windows (CRLF) leaves the same function bodies" "$BODIES" "$LF_BODIES"; fi
  val "A3 after the CRLF copy no body carries a carriage return" \
    "SELECT count(*) FROM pg_proc WHERE proname IN ('tg_campaigns_client_insert', 'campaign_recipient_ids',
       'claim_campaigns', 'cancel_campaign', 'dispatch_due_campaigns') AND position(chr(13) IN prosrc) > 0" "0"
  rm -f "$CRLF"

  echo "== self-checks abort a broken migration (each on a fresh database) =="
  # neg LABEL SED_EXPR REGEX: apply a mutated copy of the migration to a fresh scaffold and expect it to
  # abort with REGEX. The mutation must change the file, or the test proves nothing.
  NEGDB="${DB}_neg"
  neg(){
    local copy out
    copy=$(mktemp); sed "$2" "$MIG" > "$copy"
    if cmp -s "$copy" "$MIG"; then ko "$1" "the mutation changed nothing"; rm -f "$copy"; return; fi
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEGDB" -c "CREATE DATABASE $NEGDB" >/dev/null 2>&1
    $BIN/psql $CONN -d $NEGDB -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { ko "$1" "scaffold failed"; rm -f "$copy"; return; }
    $BIN/psql $CONN -d $NEGDB -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || { ko "$1" "seed failed"; rm -f "$copy"; return; }
    out=$($BIN/psql $CONN -d $NEGDB -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE postgres" -f "$copy" 2>&1 | tr -d '\r' | paste -sd' ' -)
    if echo "$out" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $out"; fi
    rm -f "$copy"
  }
  neg "N1 without the REVOKE on the table, the migration aborts" \
    '/^REVOKE UPDATE, TRUNCATE, TRIGGER ON public.campaigns FROM PUBLIC, anon, authenticated;$/d' \
    "a client role can still write public.campaigns outside the functions"
  neg "N2 without the REVOKE on claim_campaigns, the migration aborts" \
    '/^REVOKE ALL ON FUNCTION public.claim_campaigns(uuid, integer) FROM PUBLIC, anon, authenticated;$/d' \
    "a client role can execute a server-only campaign function"
  neg "N3 with a cron job every 5 minutes, the migration aborts" \
    "/v_job := cron.schedule/s/'\\* \\* \\* \\* \\*'/'*\\/5 * * * *'/" \
    "cron job send-due-campaigns is missing or inactive"
  neg "N4 with an AFTER insert trigger, the migration aborts" \
    's/^  BEFORE INSERT ON public.campaigns$/  AFTER INSERT ON public.campaigns/' \
    "trigger trg_campaigns_client_insert is missing or disabled"
  neg "N5 with the channel CHECK under another name, the migration aborts" \
    "s/('campaigns_channel_chk', \\\$c/('campaigns_channel_chk_x', \\\$c/" \
    "CHECK campaigns_channel_chk is missing"
  neg "N6 with the foreign key under another name, the migration aborts" \
    's/ADD CONSTRAINT campaigns_canceled_by_fkey/ADD CONSTRAINT campaigns_canceled_by_fk_x/' \
    "foreign key campaigns_canceled_by_fkey is missing"
  neg "N7 with cancel_campaign left to anon, the migration aborts" \
    's/^REVOKE ALL ON FUNCTION public.cancel_campaign(uuid) FROM PUBLIC, anon, service_role;$/REVOKE ALL ON FUNCTION public.cancel_campaign(uuid) FROM service_role;/' \
    "a client role can execute a server-only campaign function"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEGDB" >/dev/null 2>&1
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
