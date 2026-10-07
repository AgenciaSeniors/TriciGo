#!/usr/bin/env bash
# Rehearsal runner for migration 00628 (support-assisted matching).
# Local Postgres 16 + PostGIS, no Supabase stack.
#   supabase/tests/00628/run.sh none
#       -> prod as of 2026-10-07 (scaffold + live bodies) + tests
#          (RED: none of the support functions exist)
#   supabase/tests/00628/run.sh supabase/migrations/00628_support_assisted_matching.sql
#       -> the same + the migration applied twice (idempotency) + tests (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner, with an empty
# search_path, so every name in it must be schema-qualified.
# Cluster: Task 1 of docs/superpowers/plans/2026-10-07-support-assisted-matching.md
# (user pgtest, port 5433, PostGIS). Other clusters: PGBIN=<dir with psql> PGPORT=<port>.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr627
RACE=pr627race
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE; empty lines dropped; rows joined with ';'
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED [DBNAME] -> the printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# err NAME SQL PATTERN [DBNAME] -> the statements must fail with an error matching PATTERN
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ADMIN=a0000000-0000-4000-8000-0000000000ad     # admin
SUPER=a0000000-0000-4000-8000-0000000000ee     # super_admin
RIDER=c0000000-0000-4000-8000-000000000001     # Rita, the rider of every test ride
OTHER=c0000000-0000-4000-8000-000000000002     # Oscar, another rider (owns RB)
TESTER=c0000000-0000-4000-8000-000000000003    # Tina, users.is_test
U1=e1000000-0000-4000-8000-000000000001        # D1's user
U5=e5000000-0000-4000-8000-000000000005        # D5's user
D1=d1000000-0000-4000-8000-000000000001        # triciclo, online, ~307 m
D2=d2000000-0000-4000-8000-000000000002        # moto, online
D3=d3000000-0000-4000-8000-000000000003        # triciclo, offline since 2 days
D4=d4000000-0000-4000-8000-000000000004        # triciclo, online, busy with RB
D5=d5000000-0000-4000-8000-000000000005        # auto, online
D6=d6000000-0000-4000-8000-000000000006        # triciclo, online, no balance
D7=d7000000-0000-4000-8000-000000000007        # triciclo, pending_verification
D8=d8000000-0000-4000-8000-000000000008        # triciclo, online, heartbeat 10 min old
R1=f1000000-0000-4000-8000-000000000001
R2=f2000000-0000-4000-8000-000000000002
R3=f3000000-0000-4000-8000-000000000003
R4=f4000000-0000-4000-8000-000000000004
R5=f5000000-0000-4000-8000-000000000005
RB=fb000000-0000-4000-8000-0000000000bb        # Oscar's ride, accepted by D4
PROMO=9a000000-0000-4000-8000-000000000025     # BACO25, 25 %
CORP=c0c00000-0000-4000-8000-000000000001
FLEET=f1ee0000-0000-4000-8000-000000000001
P1=b1000000-0000-4000-8000-000000000001        # a proposal on R1
OF5=0f500000-0000-4000-8000-0000000000d5       # D5's offer on R1 (S15-S17)
SNAP_OLD=5a000000-0000-4000-8000-0000000000a1  # estimate row written by the LIVE trigger
SNAP_NEW=5a000000-0000-4000-8000-0000000000a2  # estimate row written after the migration

# ride ID [SERVICE] [FARE] [AGE]: Rita's searching ride, Vedado -> Capitolio, created AGE ago
ride(){ echo "INSERT INTO public.rides (id, customer_id, service_type, status, payment_method,
  pickup_location, pickup_address, dropoff_location, dropoff_address,
  estimated_fare_cup, estimated_fare_trc, estimated_distance_m, estimated_duration_s, exchange_rate_usd_cup, created_at)
  VALUES ('$1', '$RIDER', '${2:-triciclo_basico}', 'searching', 'cash',
  ST_SetSRID(ST_MakePoint(-82.3830, 23.1330), 4326)::geography, 'Calle 23 e/ L y M, Vedado',
  ST_SetSRID(ST_MakePoint(-82.3590, 23.1350), 4326)::geography, 'Capitolio, Centro Habana',
  ${3:-2000}, ${3:-2000}, 2800, 600, 500, now() - interval '${4:-2 minutes}');"; }
# offer DRIVER STATUS EXPIRES: an existing ride_offers row on R1
offer(){ echo "INSERT INTO public.ride_offers (ride_id, driver_profile_id, status, expires_at)
  VALUES ('$R1', '$1', '${2:-pending}', now() + interval '${3:-1 minute}');"; }
# prop [STATUS] [EXPIRES]: P1 on R1, triciclo_basico 2000 -> auto_standard 3000
prop(){ echo "INSERT INTO public.ride_service_proposals (id, ride_id, from_service_type, to_service_type,
  from_fare_cup, to_fare_cup, proposed_by, status, expires_at)
  VALUES ('$P1', '$R1', 'triciclo_basico', 'auto_standard', 2000, 3000, '$ADMIN', '${1:-pending}',
  now() + interval '${2:-3 minutes}');"; }
# The scaffold's heartbeats are as old as the load; fresh ones for every online driver but D8.
BEAT="UPDATE public.driver_profiles SET last_heartbeat_at = now() WHERE is_online AND id <> '$D8';"
# Forget the offer pushes a setup's own INSERTs queued.
QUIET="DELETE FROM net.calls;"
# tx SETUP UID CALL CHECK: one transaction, rolled back. SETUP runs without a JWT (as service
# code would), CALL as authenticated with JWT subject UID (as PostgREST would), CHECK without a JWT.
tx(){ printf "BEGIN; %s SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; %s; ROLLBACK;" "$1" "$2" "$3" "$4"; }
# as UID: switch the JWT subject inside an open transaction, as authenticated
as(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
# calls LABEL: how many HTTP calls the label queued through cron_http_post
calls(){ echo "(SELECT count(*) FROM public.cron_http_calls WHERE jobname = '$1')"; }
# pcheck: P1's status and R1's service type
PCHECK="SELECT p.status || '|' || r.service_type FROM public.ride_service_proposals p JOIN public.rides r ON r.id = p.ride_id WHERE p.id = '$P1'"
# rstate: R1's service type and fare
RSTATE="SELECT service_type || '|' || estimated_fare_cup FROM public.rides WHERE id = '$R1'"

load(){ local db=$1
  $BIN/dropdb $CONN --if-exists "$db" >/dev/null 2>&1
  $BIN/createdb $CONN "$db" || { echo "createdb $db failed"; exit 1; }
  $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >"$TMP/scaffold.out" 2>&1 \
    || { echo "scaffold failed:"; cat "$TMP/scaffold.out"; exit 1; }
}
migrate(){ local db=$1 i
  [ "$MIG" = none ] && return 0
  for i in 1 2; do
    $BIN/psql $CONN -d "$db" -q -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >"$TMP/mig.out" 2>&1 \
      || { echo "migration failed on apply $i:"; cat "$TMP/mig.out"; exit 1; }
  done
}

load $DB

# L1: the scaffold carries prod's live bodies (md5 of prosrc read from prod on 2026-10-07)
val L1 "SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname COLLATE \"C\")
  FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace, 'auth'::regnamespace) AND p.proname IN (
  'uid', 'accept_ride_v2', 'cleanup_orphan_searching_rides', 'cron_http_post', 'current_user_role', 'dispatch_ride',
  'driver_can_afford_commission', 'enforce_ride_transition', 'enforce_ride_update_columns', 'find_best_drivers',
  'get_platform_config_numeric', 'get_platform_config_text', 'is_admin', 'is_super_admin', 'log_rpc_attempt',
  'notify_driver_new_offer', 'rides_sync_coords', 'tg_ride_offer_increment_offered', 'tg_ride_offer_refresh_acceptance',
  'tg_rides_create_estimate_snapshot', 'tg_rides_validate_insurance', 'tg_rides_validate_promo_discount')" \
  "accept_ride_v2=b51311095327fa66df27849ec9a4660f,cleanup_orphan_searching_rides=3a43dc26cde6e2a35df3bbba122587b5,cron_http_post=15d9ded451c60f92a0fd0a3c4e1ee0ab,current_user_role=cb4a7c12d4e21fe2997135833f141e25,dispatch_ride=a16ae76866950dedd21d33595f345d63,driver_can_afford_commission=cc0dde026b1e9262afbda4bde8f79723,enforce_ride_transition=35bde4fd60a4a4fa0fc86a237ec4a414,enforce_ride_update_columns=c181b9e3e630e306a329de56398033f5,find_best_drivers=53a6b5d68be18d5369445986a83e2fa9,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,get_platform_config_text=407a7b835c527164a4aa8b3aa8525ba5,is_admin=22cb75e91980d512498034cd33e1eda2,is_super_admin=5655a4615e92e8b1e323d06c7566b058,log_rpc_attempt=0a902c34a1148dac5686403a7c941bc0,notify_driver_new_offer=6226f91fe0acacd99b298718a3c35937,rides_sync_coords=66b9877c7ff14aed2dd133d0d04b64b7,tg_ride_offer_increment_offered=34482879e7d798ba9c96c5c8ae67a993,tg_ride_offer_refresh_acceptance=f9c2c0652ab23eb08f1b2b571a2d8ee6,tg_rides_create_estimate_snapshot=b801283b9dcb6de3e4822992347d962e,tg_rides_validate_insurance=4d5516aca57a3b81076fdad9fdb6f9f6,tg_rides_validate_promo_discount=d4494bd8ab75ce590e1c42743583aec5,uid=cdef18c69c4f4cbbced2eaf81e628b49"

# An estimate row written by the LIVE trigger, for S11. Canceled at once so no alert sees it.
run $DB "$(ride $SNAP_OLD) UPDATE public.rides SET status = 'canceled' WHERE id = '$SNAP_OLD';" >/dev/null
migrate $DB

# --- H: the rider asks for help ----------------------------------------------------------
val H1 "$(tx "$(ride $R1)" $RIDER "SELECT public.request_ride_help('$R1')->>'code';" \
  "SELECT (SELECT help_requested_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R1'),
          $(calls support-help-alert), $(calls support-help-email),
          (SELECT c.body->>'category' || ':' || jsonb_array_length(c.body->'user_ids') || ':' || (c.body->'data'->>'event')
             FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = 'support-help-alert')")" \
  "F1000000;t|1|2|system:2:support_help"
val H2 "$(tx "$(ride $R1)" $RIDER "SELECT public.request_ride_help('$R1')->>'success'; SELECT public.request_ride_help('$R1')->>'success';" \
  "SELECT $(calls support-help-alert)")" "true;true;1"
val H3 "$(tx "$(ride $R1)" $OTHER "SELECT public.request_ride_help('$R1')->>'error';" "SELECT count(*) FROM public.ride_assist")" \
  "ride_not_found;0"
val H4 "$(tx "" $OTHER "SELECT public.request_ride_help('$RB')->>'error';" "SELECT count(*) FROM public.ride_assist")" \
  "ride_not_searching;0"
err H5 "BEGIN; $(ride $R1) SET LOCAL ROLE anon; SELECT public.request_ride_help('$R1'); ROLLBACK;" \
  "permission denied for function request_ride_help"
val H6 "$(tx "$(ride $R1) UPDATE public.platform_config SET value = '\"\"' WHERE key = 'support_alert_email';" $RIDER \
  "SELECT public.request_ride_help('$R1')->>'success';" "SELECT $(calls support-help-alert), $(calls support-help-email)")" \
  "true;1|0"
val H7 "$(tx "$(ride $R1) UPDATE public.rides SET pickup_address = '<script>x</script>' WHERE id = '$R1';" $RIDER \
  "SELECT public.request_ride_help('$R1')->>'success';" \
  "SELECT bool_and(position('&lt;script&gt;' IN c.body->>'template') > 0 AND position('<script>' IN c.body->>'template') = 0
                   AND c.body->>'template' LIKE '%/rides/$R1/assist%')
     FROM net.calls c WHERE c.url LIKE '%/send-email'")" "true;t"
val H8 "$(tx "$(ride $R1) UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R1';" $TESTER \
  "SELECT public.request_ride_help('$R1')->>'success';" "SELECT $(calls support-help-alert)")" "true;1"
# cleanup_orphan_searching_rides (cron) cancels a search the app stopped refreshing. A rider who
# asked for help is in WhatsApp with support, so a help request keeps the ride for
# support_help_keepalive_s (1800 s). R1's app last refreshed its search 15 minutes ago:
STALE="UPDATE public.rides SET searching_seen_at = now() - interval '15 minutes' WHERE id = '$R1';"
# helped AGO: the ride_assist row request_ride_help writes for R1, AGO ago. Skipped where the
# table does not exist, so the RED run shows prod as it is.
helped(){ echo "DO \$h\$ BEGIN IF to_regclass('public.ride_assist') IS NOT NULL THEN
  INSERT INTO public.ride_assist (ride_id, help_requested_at, help_alert_sent_at)
  VALUES ('$R1', now() - interval '$1', now() - interval '$1'); END IF; END \$h\$;"; }
CSTATE="SELECT status || '|' || coalesce(cancellation_reason, '') FROM public.rides WHERE id = '$R1'"
val H9 "BEGIN; $(ride $R1 triciclo_basico 2000 '20 minutes') $STALE
  SELECT public.cleanup_orphan_searching_rides(); $CSTATE; ROLLBACK;" "1;canceled|searching_abandoned"
val H10 "BEGIN; $(ride $R1 triciclo_basico 2000 '20 minutes') $STALE $(helped '5 minutes')
  SELECT public.cleanup_orphan_searching_rides(); $CSTATE; ROLLBACK;" "0;searching|"
val H11 "BEGIN; $(ride $R1 triciclo_basico 2000 '45 minutes') $STALE $(helped '40 minutes')
  SELECT public.cleanup_orphan_searching_rides(); $CSTATE; ROLLBACK;" "1;canceled|searching_abandoned"

# --- C: the one-minute alert cron ---------------------------------------------------------
val C1 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides();
  SELECT (SELECT wait_alert_sent_at IS NOT NULL FROM public.ride_assist WHERE ride_id = '$R1'),
         $(calls support-wait-alert), $(calls support-wait-email); ROLLBACK;" "1;t|1|2"
val C2 "BEGIN; $(ride $R1) SELECT public.notify_support_waiting_rides(); SELECT public.notify_support_waiting_rides(); ROLLBACK;" "1;0"
val C3 "BEGIN; $(ride $R1) $(ride $R2 triciclo_basico 2000 '30 seconds') $(ride $R3 triciclo_basico 2000 '10 minutes') $(ride $R4 triciclo_basico 2000 '7 hours')
  UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R1';
  UPDATE public.rides SET is_scheduled = true, scheduled_at = now() + interval '1 hour' WHERE id = '$R3';
  SELECT public.notify_support_waiting_rides(); ROLLBACK;" "0"
val C4 "BEGIN; $(ride $R1) UPDATE public.platform_config SET value = 'false' WHERE key = 'support_alert_enabled';
  SELECT public.notify_support_waiting_rides(); ROLLBACK;" "0"
val C5 "SELECT schedule || ' / ' || command FROM cron.job WHERE jobname = 'notify-support-waiting-rides'" \
  "* * * * * / SELECT public.notify_support_waiting_rides()"

# --- W: the banner's list -----------------------------------------------------------------
WCOLS="ride_id, code, waiting_since, wait_s, help_requested_at, service_type, estimated_fare_cup, pickup_address, dropoff_address, pending_offers, is_test, ord"
err W1 "$(tx "" $RIDER "SELECT count(*) FROM public.admin_support_waiting_rides();" "SELECT 1")" "forbidden"
val W2 "$(tx "$(ride $R1) $(ride $R2 triciclo_basico 2000 '5 minutes') $(ride $R3 triciclo_basico 2000 '30 seconds') $(ride $R4 triciclo_basico 2000 '3 minutes') $(ride $R5 triciclo_basico 2000 '20 seconds')
  UPDATE public.rides SET customer_id = '$TESTER' WHERE id = '$R4';
  INSERT INTO public.ride_assist (ride_id, help_requested_at) VALUES ('$R3', now());" $ADMIN \
  "SELECT string_agg(w.code || ':' || w.is_test, ',' ORDER BY w.ord) FROM public.admin_support_waiting_rides() WITH ORDINALITY AS w($WCOLS);" \
  "SELECT 1")" "F3000000:false,F2000000:false,F4000000:true,F1000000:false;1"

# --- K: the assist page's context and candidates ------------------------------------------
KCOLS="driver_profile_id, full_name, phone, vehicle_type, vehicle_label, is_online, last_heartbeat_at, distance_m, busy_ride_id, can_afford, offer_status, offer_expires_at, ord"
val K1 "$(tx "$(ride $R1) INSERT INTO public.ride_assist (ride_id, help_requested_at) VALUES ('$R1', now());" $ADMIN \
  "SELECT c->'ride'->>'code', round((c->'ride'->>'pickup_lat')::numeric, 3), c->'ride'->>'customer_phone',
          c->>'help_requested_at' IS NOT NULL, jsonb_array_length(c->'offers'), jsonb_typeof(c->'proposal')
     FROM (SELECT public.admin_ride_assist_context('$R1') AS c) x;" "SELECT 1")" \
  "F1000000|23.133|+5350000101|t|0|null;1"
val K2 "$(tx "$(ride $R1) $BEAT" $ADMIN \
  "SELECT string_agg(left(x.driver_profile_id::text, 2) || ':' || x.is_online || ':' || x.can_afford || ':' || (x.busy_ride_id IS NOT NULL), ',' ORDER BY x.ord)
     FROM public.admin_ride_assist_candidates('$R1') WITH ORDINALITY AS x($KCOLS);" "SELECT 1")" \
  "d1:true:true:false,d6:true:false:false,d8:true:true:false,d4:true:true:true,d3:false:true:false;1"
val K3 "$(tx "$(ride $R1)" $ADMIN \
  "SELECT string_agg(left(x.driver_profile_id::text, 2), ',' ORDER BY x.ord)
     FROM public.admin_ride_assist_candidates('$R1', 'auto_standard') WITH ORDINALITY AS x($KCOLS);" "SELECT 1")" "d5;1"
val K4 "$(tx "$(ride $R1) INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('$RIDER', '$U1');" $ADMIN \
  "SELECT left(x.driver_profile_id::text, 2) FROM public.admin_ride_assist_candidates('$R1') WITH ORDINALITY AS x($KCOLS) ORDER BY x.ord LIMIT 1;" \
  "SELECT 1")" "d6;1"
err K5 "$(tx "$(ride $R1)" $RIDER "SELECT public.admin_ride_assist_candidates('$R1');" "SELECT 1")" "forbidden"

# --- O: support sends an offer --------------------------------------------------------------
OSTATE="SELECT o.status || '|' || (SELECT count(*) FROM net.calls c WHERE c.body->>'user_id' = '$U1') || '|' || extract(epoch FROM o.expires_at - now())::int
  FROM public.ride_offers o WHERE o.ride_id = '$R1' AND o.driver_profile_id = '$D1'"
val O1 "$(tx "$(ride $R1)" $RIDER "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'error';" "SELECT count(*) FROM public.ride_offers")" \
  "forbidden;0"
val O2 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" \
  "SELECT o.status, extract(epoch FROM o.expires_at - now())::int, o.distance_m BETWEEN 250 AND 350,
          (SELECT c.body->>'category' FROM net.calls c WHERE c.body->>'user_id' = '$U1'),
          (SELECT count(*) FROM public.admin_actions WHERE action = 'support_offer_ride')
     FROM public.ride_offers o WHERE o.ride_id = '$R1' AND o.driver_profile_id = '$D1'")" \
  "created;pending|120|t|ride_offer|1"
val O3 "$(tx "$(ride $R1) $(offer $D1 expired '-5 minutes') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "rearmed;pending|1|120"
val O4 "$(tx "$(ride $R1) $(offer $D1 rejected '-1 minute') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "rearmed;pending|1|120"
val O5 "$(tx "$(ride $R1) $(offer $D1 pending '20 seconds') $QUIET" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';" "$OSTATE")" \
  "extended;pending|0|120"
val O6 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D2')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "wrong_vehicle_type;0"
val O7 "$(tx "$(ride $R1)" $ADMIN "SELECT public.admin_offer_ride_to_driver('$R1', '$D7')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "driver_not_approved;0"
val O8 "$(tx "" $ADMIN "SELECT public.admin_offer_ride_to_driver('$RB', '$D1')->>'error';" "SELECT 1")" "ride_not_searching;1"
val O9 "$(tx "$(ride $R1) INSERT INTO public.user_blocks (blocker_id, blocked_id) VALUES ('$U1', '$RIDER');" $ADMIN \
  "SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'error';" "SELECT count(*) FROM public.ride_offers WHERE ride_id = '$R1'")" \
  "blocked;0"
val O10 "BEGIN; $(ride $R1) $BEAT $(as $ADMIN) SELECT public.admin_offer_ride_to_driver('$R1', '$D1')->>'mode';
  $(as $U1) SELECT public.accept_ride_v2('$R1', '$D1')->>'success';
  RESET ROLE; SELECT status || ':' || left(driver_id::text, 2) FROM public.rides WHERE id = '$R1'; ROLLBACK;" \
  "created;true;accepted:d1"

# --- A: support assigns directly -----------------------------------------------------------
ASTATE="SELECT status FROM public.rides WHERE id = '$R1'"
assign(){ echo "SELECT public.admin_assign_ride_to_driver('$R1', '$1', '${2:-Lo coordiné por WhatsApp}')->>'${3:-error}';"; }
val A1 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D1 '   ')" "$ASTATE")" "reason_required;searching"
val A2 "$(tx "$(ride $R1) $BEAT $(offer $D1) $(offer $D6)" $ADMIN "$(assign $D1 'Lo coordiné por WhatsApp' success)" \
  "SELECT r.status || ':' || left(r.driver_id::text, 2),
          (SELECT string_agg(left(o.driver_profile_id::text, 2) || '=' || o.status, ',' ORDER BY o.driver_profile_id) FROM public.ride_offers o WHERE o.ride_id = '$R1'),
          (SELECT (c.body->'data'->>'event') || '@' || (c.body->>'user_id' = '$U1') || '@' || (c.body->>'category')
             FROM net.calls c JOIN public.cron_http_calls h ON h.request_id = c.id WHERE h.jobname = 'support-assign-push'),
          (SELECT reason FROM public.admin_actions WHERE action = 'support_assign_ride'),
          (SELECT actor_role FROM public.ride_transitions WHERE ride_id = '$R1' AND to_status = 'accepted')
     FROM public.rides r WHERE r.id = '$R1'")" \
  "true;accepted:d1|d1=accepted,d6=superseded|ride_assigned@true@system|Lo coordiné por WhatsApp|admin"
val A3 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D3)" "$ASTATE")" "not_online;searching"
val A4 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D8)" "$ASTATE")" "stale_heartbeat;searching"
val A5 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D4)" "$ASTATE")" "busy;searching"
val A6 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D6)" "$ASTATE")" "insufficient_balance;searching"
val A7 "$(tx "$(ride $R1) $BEAT" $ADMIN "$(assign $D2)" "$ASTATE")" "wrong_vehicle_type;searching"
val A8 "$(tx "$(ride $R1) $BEAT UPDATE public.rides SET status = 'canceled' WHERE id = '$R1';" $ADMIN "$(assign $D1)" "$ASTATE")" \
  "ride_not_searching;canceled"
val A9 "$(tx "$(ride $R1) $BEAT" $RIDER "$(assign $D1)" "$ASTATE")" "forbidden;searching"
val A10 "$(tx "$(ride $R1) $BEAT UPDATE public.corporate_accounts SET is_fleet_owner = true WHERE id = '$CORP';
  INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FLEET', '$CORP', 'Flota Uno');
  INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status) VALUES ('$FLEET', '$U5', 'Daniel Cinco', '+5350000205', 'active');
  UPDATE public.rides SET corporate_account_id = '$CORP' WHERE id = '$R1';" $ADMIN "$(assign $D1)" "$ASTATE")" "not_in_fleet;searching"

# --- S: support switches the vehicle type with WhatsApp consent -----------------------------
apply(){ echo "SELECT public.admin_change_ride_service('$R1', '$1', $2, 'apply', ${3:-'Aceptó por WhatsApp'})->>'${4:-error}';"; }
val S1 "$(tx "$(ride $R1) $BEAT UPDATE public.rides SET shared_ride = true, shared_ride_seats_occupied = 1 WHERE id = '$R1'; $(offer $D1)" $ADMIN \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" \
  "SELECT r.service_type, r.estimated_fare_cup, r.estimated_fare_trc, r.shared_ride, r.shared_ride_discount_cup, r.discount_amount_cup,
          (SELECT count(*) || ':' || max(s.total) || ':' || max(s.base_fare) FROM public.ride_pricing_snapshots s WHERE s.ride_id = '$R1' AND s.snapshot_type = 'estimate'),
          (SELECT string_agg(left(o.driver_profile_id::text, 2) || '=' || o.status, ',' ORDER BY o.driver_profile_id) FROM public.ride_offers o WHERE o.ride_id = '$R1'),
          r.dispatch_round, (SELECT count(*) FROM public.admin_actions WHERE action = 'support_change_service')
     FROM public.rides r WHERE r.id = '$R1'")" \
  "apply;auto_standard|3000|3000|f|0|0|1:3000:700|d1=superseded,d5=pending|1|1"
DSTATE="SELECT discount_amount_cup || '|' || (promo_code_id IS NOT NULL) FROM public.rides WHERE id = '$R1'"
val S2 "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $ADMIN \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" "$DSTATE")" "apply;750|true"
val S3 "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $SUPER \
  "$(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)" "$DSTATE")" "apply;750|true"
# The super_admin escape hatch of the discount trigger still works outside a service change.
val S3b "$(tx "$(ride $R1) UPDATE public.rides SET promo_code_id = '$PROMO' WHERE id = '$R1';" $SUPER \
  "UPDATE public.rides SET discount_amount_cup = 123 WHERE id = '$R1';" "$DSTATE")" "123|true"
val S4 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 1000)" "$RSTATE")" "fare_below_minimum;triciclo_basico|2000"
val S5 "$(tx "$(ride $R1) UPDATE public.rides SET corporate_account_id = '$CORP' WHERE id = '$R1';" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "corporate_not_supported;triciclo_basico|2000"
val S6 "$(tx "$(ride $R1) UPDATE public.rides SET ride_mode = 'cargo' WHERE id = '$R1';" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "cargo_not_supported;triciclo_basico|2000"
val S7 "$(tx "$(ride $R1)" $ADMIN "$(apply triciclo_basico 2500)" "$RSTATE")" "same_service_type;triciclo_basico|2000"
val S8 "$(tx "$(ride $R1) UPDATE public.rides SET passenger_count = 2 WHERE id = '$R1';" $ADMIN "$(apply moto_standard 1000)" "$RSTATE")" \
  "too_many_passengers;triciclo_basico|2000"
val S9 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 10001)" "$RSTATE")" "fare_out_of_range;triciclo_basico|2000"
val S10 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 3000 NULL)" "$RSTATE")" "reason_required;triciclo_basico|2000"
val S11 "BEGIN; $(ride $SNAP_NEW)
  SELECT (SELECT count(*) FROM (SELECT DISTINCT base_fare, per_km_rate, per_minute_rate, distance_m, duration_s,
            surge_multiplier, subtotal, commission_rate, commission_amount, total, pricing_rule_id,
            exchange_rate_usd_cup, total_trc, min_fare, corporate_commission_rate, default_commission_rate_snapshot
          FROM public.ride_pricing_snapshots WHERE ride_id IN ('$SNAP_OLD', '$SNAP_NEW') AND snapshot_type = 'estimate') d),
         (SELECT count(*) FROM public.ride_pricing_snapshots WHERE ride_id IN ('$SNAP_OLD', '$SNAP_NEW'));
  ROLLBACK;" "1|2"
val S12 "$(tx "$(ride $R1)" $ADMIN "$(apply auto_standard 3000 "'ok'" mode)" \
  "SELECT '[' || coalesce(current_setting('app.force_discount_recompute', true), '') || ']'")" "apply;[]"
val S13 "$(tx "$(ride $R1)" $ADMIN "$(apply mensajeria 3000) $(apply triciclo_premium 5000)" "$RSTATE")" \
  "service_type_unavailable;service_type_unavailable;triciclo_basico|2000"
val S14 "$(tx "$(ride $R1) INSERT INTO public.ride_waypoints (ride_id, sort_order, location, address)
  VALUES ('$R1', 1, ST_SetSRID(ST_MakePoint(-82.3700, 23.1350), 4326)::geography, 'Parada');" $ADMIN "$(apply auto_standard 3000)" "$RSTATE")" \
  "waypoints_not_supported;triciclo_basico|2000"
# A driver who can still serve the new type keeps the ride (auto_standard and auto_confort share
# their drivers). offer5 [STATUS] [EXPIRES]: D5's offer on R1, with a known id.
offer5(){ echo "INSERT INTO public.ride_offers (id, ride_id, driver_profile_id, status, expires_at)
  VALUES ('$OF5', '$R1', '$D5', '${1:-pending}', now() + interval '${2:-1 minute}');"; }
# D5's only offer on R1: the same row, pending, live, unanswered, and its pushes at 4000 CUP.
O5STATE="SELECT o.id = '$OF5', o.status, o.expires_at > now(), o.responded_at IS NULL,
    (SELECT count(*) FROM net.calls c WHERE c.body->>'user_id' = '$U5' AND c.body->'data'->>'offer_id' = '$OF5'
       AND c.body->>'body' LIKE '%4000 CUP')
  FROM public.ride_offers o WHERE o.ride_id = '$R1' AND o.driver_profile_id = '$D5'"
# Fare up: re-offered at once, on the same row, with a push at the new fare.
val S15 "$(tx "$(ride $R1 auto_standard 3000) $BEAT $(offer5) $QUIET" $ADMIN \
  "$(apply auto_confort 4000 "'Aceptó por WhatsApp'" mode)" "$O5STATE")" "apply;t|pending|t|t|1"
# Fare down: the offer only expires, so the old card, at the higher price, cannot be accepted; once
# the cooldown has passed, re-dispatch (here dispatch_ride as the cron) re-offers it at the new fare.
val S16 "BEGIN; $(ride $R1 auto_confort 4000) $BEAT $(offer5) $QUIET
  $(as $ADMIN) $(apply auto_standard 3000 "'Aceptó por WhatsApp'" mode)
  RESET ROLE; SELECT status FROM public.ride_offers WHERE id = '$OF5';
  $(as $U5) SELECT public.accept_ride_v2('$R1', '$D5')->>'error';
  RESET ROLE; SET LOCAL request.jwt.claim.sub = '';
  UPDATE public.ride_offers SET expires_at = now() - interval '121 seconds' WHERE id = '$OF5';
  SET LOCAL ROLE postgres; SELECT public.dispatch_ride('$R1')->>'offers_created'; RESET ROLE;
  SELECT o.status || '|' || (SELECT count(*) FROM net.calls c WHERE c.body->>'user_id' = '$U5' AND c.body->>'body' LIKE '%3000 CUP')
    FROM public.ride_offers o WHERE o.id = '$OF5'; ROLLBACK;" \
  "apply;expired;offer_not_found_or_expired;1;pending|1"
# An offer that expired 5 s ago, inside the 120 s cooldown, is re-offered at once by a fare up.
val S17 "$(tx "$(ride $R1 auto_standard 3000) $BEAT $(offer5 expired '-5 seconds') $QUIET" $ADMIN \
  "$(apply auto_confort 4000 "'Aceptó por WhatsApp'" mode)" "$O5STATE")" "apply;t|pending|t|t|1"

# --- P: proposals the rider answers in the app ----------------------------------------------
propose(){ echo "SELECT public.admin_change_ride_service('$R1', '$1', $2, 'propose', NULL)->>'mode';"; }
respond(){ echo "SELECT public.respond_ride_service_proposal('$P1', $1)->>'${2:-error}';"; }
val P1 "$(tx "$(ride $R1)" $ADMIN "$(propose auto_standard 3000)" \
  "SELECT p.status, extract(epoch FROM p.expires_at - now())::int, p.from_service_type || '>' || p.to_service_type,
          p.from_fare_cup || '>' || p.to_fare_cup, r.service_type, r.estimated_fare_cup,
          (SELECT count(*) FROM public.admin_actions WHERE action = 'support_propose_service')
     FROM public.ride_service_proposals p JOIN public.rides r ON r.id = p.ride_id WHERE p.ride_id = '$R1'")" \
  "propose;pending|180|triciclo_basico>auto_standard|2000>3000|triciclo_basico|2000|1"
val P2 "$(tx "$(ride $R1)" $ADMIN "$(propose auto_standard 3000) $(propose auto_confort 4000)" \
  "SELECT string_agg(to_service_type || '=' || status, ',' ORDER BY to_service_type) FROM public.ride_service_proposals WHERE ride_id = '$R1'")" \
  "propose;propose;auto_confort=pending,auto_standard=superseded"
val P3 "BEGIN; $(ride $R1) $(as $ADMIN) $(propose auto_standard 3000)
  $(as $RIDER) SELECT public.get_my_ride_service_proposal('$R1')->>'to_service_type';
  $(as $OTHER) SELECT public.get_my_ride_service_proposal('$R1') IS NULL; ROLLBACK;" "propose;auto_standard;t"
val P4 "BEGIN; $(ride $R1) $BEAT $(as $ADMIN) $(propose auto_standard 3000)
  $(as $RIDER) SELECT public.respond_ride_service_proposal((public.get_my_ride_service_proposal('$R1')->>'id')::uuid, true)->>'accepted';
  RESET ROLE; SELECT r.service_type || '|' || r.estimated_fare_cup || '|' || p.status
    FROM public.rides r JOIN public.ride_service_proposals p ON p.ride_id = r.id WHERE r.id = '$R1'; ROLLBACK;" \
  "propose;true;auto_standard|3000|accepted"
val P5 "$(tx "$(ride $R1) $(prop)" $RIDER "$(respond false accepted)" "$PCHECK")" "false;rejected|triciclo_basico"
val P6 "$(tx "$(ride $R1) $(prop pending '-1 second')" $RIDER "$(respond true)" "$PCHECK")" "proposal_expired;pending|triciclo_basico"
val P7 "$(tx "$(ride $R1) $(prop superseded)" $RIDER "$(respond true)" "$PCHECK")" "proposal_not_pending;superseded|triciclo_basico"
val P8 "$(tx "$(ride $R1) $(prop)" $OTHER "$(respond true)" "$PCHECK")" "proposal_not_found;pending|triciclo_basico"
val P9 "$(tx "$(ride $R1) $(prop) $BEAT UPDATE public.rides SET status = 'accepted', driver_id = '$D1', accepted_at = now() WHERE id = '$R1';" $RIDER \
  "$(respond true)" "$PCHECK")" "ride_not_searching;pending|triciclo_basico"
val P10 "BEGIN; $(ride $R1) $(prop) $(as $ADMIN) $(apply auto_confort 4000 "'Aceptó por WhatsApp'" mode)
  $(as $RIDER) $(respond true) RESET ROLE; $PCHECK; ROLLBACK;" "apply;proposal_not_pending;superseded|auto_confort"
val P11 "$(tx "$(ride $R1) $(prop) UPDATE public.service_type_configs SET min_fare_cup = 5000 WHERE slug = 'auto_standard';" $RIDER \
  "$(respond true)" "$PCHECK")" "fare_below_minimum;pending|triciclo_basico"

# --- G: who may call what -----------------------------------------------------------------
err G1 "$(tx "$(ride $R1)" $ADMIN "SELECT public._apply_ride_service_change('$R1', 'auto_standard', 3000);" "SELECT 1")" \
  "permission denied for function _apply_ride_service_change"
err G2 "$(tx "" $RIDER "SELECT count(*) FROM public.ride_assist;" "SELECT 1")" "permission denied for table ride_assist"
err G3 "$(tx "" $RIDER "SELECT count(*) FROM public.ride_service_proposals;" "SELECT 1")" "permission denied for table ride_service_proposals"
err G4 "BEGIN; $(ride $R1) SET LOCAL ROLE anon; SELECT public.admin_offer_ride_to_driver('$R1', '$D1'); ROLLBACK;" \
  "permission denied for function admin_offer_ride_to_driver"
err G5 "$(tx "" $ADMIN "SELECT public.notify_support_waiting_rides();" "SELECT 1")" \
  "permission denied for function notify_support_waiting_rides"

# --- P12: a rider's answer racing support's apply (committed data, separate database) --------
load $RACE
migrate $RACE
run $RACE "$(ride $R1) $(prop)" >/dev/null
( run $RACE "BEGIN; $(as $ADMIN) $(apply auto_confort 4000 "'carrera'" mode) SELECT pg_sleep(2); COMMIT;" > "$TMP/race_admin" ) &
sleep 1
RIDER_OUT=$(run $RACE "SET request.jwt.claim.sub = '$RIDER'; SET ROLE authenticated; $(respond true)")
wait
ADMIN_OUT=$(cat "$TMP/race_admin")
FINAL=$(run $RACE "$PCHECK")
if [ "$ADMIN_OUT" = "apply" ] && [ "$RIDER_OUT" = "proposal_not_pending" ] && [ "$FINAL" = "superseded|auto_confort" ]; then
  ok P12
else
  ko P12 "admin [$ADMIN_OUT] rider [$RIDER_OUT] final [$FINAL]"
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
