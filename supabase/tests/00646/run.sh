#!/usr/bin/env bash
# Rehearsal runner for migration 00646 (local Postgres 16 + PostGIS, no Supabase stack needed).
#   supabase/tests/00646/run.sh none
#       -> scaffold (prod's live bodies) + tests (RED: a name or an address written as HTML
#          becomes markup in the operations e-mail)
#   supabase/tests/00646/run.sh supabase/migrations/00646_ops_alert_emails_escape_user_text.sql
#       -> the same + migration x2 (idempotency), a CRLF copy, tests and negative proofs (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod"
# (user pgtest, port 5433). Other clusters: PGBIN=<dir> PGPORT=<port> supabase/tests/00646/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr646
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
MD5(){ printf "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.%s()'::regprocedure" "$1"; }

RIDER=a0000000-0000-4000-8000-000000000001
DRIVER=a0000000-0000-4000-8000-0000000000d1; DP=b0000000-0000-4000-8000-000000000001
STUCK=c0000000-0000-4000-8000-000000000001   # in_progress, blocked at the destination pin
DEAD=c0000000-0000-4000-8000-000000000002    # in_progress, driver app silent
SEED="
INSERT INTO public.platform_config VALUES ('business_notification_email', '\"ops@example.com\"');
INSERT INTO public.users VALUES
  ('$RIDER', '<a href=\"https://evil.example\">Ver viaje</a>', '+5355500001'),
  ('$DRIVER', 'Juan <img src=x onerror=alert(1)>', '+53555<b>0002</b>');
INSERT INTO public.driver_profiles VALUES ('$DP', '$DRIVER');
INSERT INTO public.rides (id, status, pickup_address, dropoff_address, customer_id, driver_id, accepted_at) VALUES
  ('$STUCK', 'in_progress', 'Calle 23 <b>e/</b> L', 'Viazul Santa Clara -> Varadero', '$RIDER', '$DP', now() - interval '20 minutes'),
  ('$DEAD', 'in_progress', 'O''Reilly & Cuba', '<script>x</script>', '$RIDER', '$DP', now() - interval '20 minutes');
INSERT INTO public.validation_events (ride_id, event_type) VALUES ('$STUCK', 'complete_blocked_distance');
INSERT INTO public.stuck_ride_alerts (ride_id, reason, details) VALUES ('$DEAD', 'dead_driver_app', '{\"minutes_silent\": 12}');"
# The body each function would send: what the e-mail shows, as stored by the cron_http_post stub.
SENT(){ printf "SELECT body->>'template' FROM public.sent_emails WHERE jobname = '%s'" "$1"; }

fresh $DB || { echo "scaffold failed"; exit 2; }
val "S0a scaffold carries prod's notify_dead_driver_alert" "$(MD5 notify_dead_driver_alert)" "aa6a768cbd67d7b2cd7bfa4e135875f3"
val "S0b scaffold carries prod's check_stuck_active_rides" "$(MD5 check_stuck_active_rides)" "8478bba2e479523f4d52855adf7454ca"

if [ "$MIG" != none ]; then
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  ok "M1 migration applies twice (idempotent)"
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh ${DB}w || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}w "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ]; then
    val "M2 a CRLF copy applies and leaves the same bodies" \
      "$(MD5 notify_dead_driver_alert) UNION ALL $(MD5 check_stuck_active_rides)" \
      "$(run $DB "$(MD5 notify_dead_driver_alert) UNION ALL $(MD5 check_stuck_active_rides)")" ${DB}w
  else ko "M2 a CRLF copy applies" "$r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}w" >/dev/null 2>&1
fi

run $DB "$SEED" >/dev/null
val "R0 check_stuck_active_rides alerts the blocked ride and sends one e-mail" \
  "SELECT public.check_stuck_active_rides()->>'emails_sent'" "1"
val "R1 notify_dead_driver_alert sends one e-mail" \
  "SELECT public.notify_dead_driver_alert()->>'emails_sent'" "1"

for job in stuck-ride-alert dead-driver-alert; do
  HTML=$(run $DB "$(SENT $job)")
  for raw in '<a href="https://evil.example"' '<img src=x' '<b>0002' '<script>' '<b>e/'; do
    case "$HTML" in *"$raw"*) ko "E $job: user text stays text ($raw)" "found as markup";;
                    *) ok "E $job: user text stays text ($raw)";; esac
  done
  case "$HTML" in *'&lt;a href=&quot;https://evil.example&quot;&gt;Ver viaje&lt;/a&gt;'*) ok "E $job: the rider's name is shown escaped";;
                  *) ko "E $job: the rider's name is shown escaped" "not found";; esac
  case "$HTML" in *'href="https://admin.tricigo.com/rides/'*) ok "E $job: its own admin link is kept";;
                  *) ko "E $job: its own admin link is kept" "missing";; esac
done
HTML=$(run $DB "$(SENT stuck-ride-alert)")
case "$HTML" in *'Viazul Santa Clara -&gt; Varadero'*) ok "E stuck-ride-alert: a POI name with -> reads as written";;
                *) ko "E stuck-ride-alert: a POI name with -> reads as written" "not found";; esac
HTML=$(run $DB "$(SENT dead-driver-alert)")
case "$HTML" in *'O&#39;Reilly &amp; Cuba → &lt;script&gt;x&lt;/script&gt;'*) ok "E dead-driver-alert: the route keeps its arrow and escapes both ends";;
                *) ko "E dead-driver-alert: the route keeps its arrow and escapes both ends" "not found";; esac
val "E dead-driver-alert: a driver without a phone still gets a body (no NULL in the chain)" \
  "BEGIN; UPDATE public.users SET phone = NULL WHERE id = '$DRIVER';
   UPDATE public.stuck_ride_alerts SET emailed_at = NULL WHERE ride_id = '$DEAD';
   DELETE FROM public.sent_emails; SELECT public.notify_dead_driver_alert()->>'emails_sent';
   SELECT ($(SENT dead-driver-alert)) IS NOT NULL; ROLLBACK;" "1;t"

# --- Negative proofs of the migration's guards ---------------------------------------------
if [ "$MIG" != none ]; then
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "CREATE OR REPLACE FUNCTION public.notify_dead_driver_alert() RETURNS jsonb LANGUAGE sql AS \$\$ SELECT '{}'::jsonb \$\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "unexpected body of notify_dead_driver_alert" && ok "G1 refuses to patch an unknown body" || ko "G1 refuses an unknown body" "$r"
  fresh ${DB}g || { echo "scaffold failed"; exit 2; }
  run ${DB}g "CREATE OR REPLACE FUNCTION public._html_escape(p_text text) RETURNS text LANGUAGE sql AS \$\$ SELECT p_text \$\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "does not escape as expected" && ok "G2 aborts when _html_escape does not escape" || ko "G2 aborts on a broken _html_escape" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
