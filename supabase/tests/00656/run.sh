#!/usr/bin/env bash
# Rehearsal runner for migration 00656 (team daily digest; local Postgres 16 + PostGIS).
#   supabase/tests/00656/run.sh none
#       -> scaffold + seed + tests without the migration (RED: none of the objects exist)
#   supabase/tests/00656/run.sh supabase/migrations/00656_team_daily_digest.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00656/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr656
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED (\r dropped for Windows)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# txn SQL -> SQL inside a transaction that is always rolled back
txn(){ printf "BEGIN; SET LOCAL client_min_messages = error; %s ROLLBACK;" "$1"; }
# EQ EXPR JSON -> 'ok' when EXPR equals the JSON, else EXPR's value
EQ(){ printf "SELECT t.eq(%s, '%s'::jsonb);" "$1" "$2"; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

D=2026-10-07
M="public.team_daily_metrics('$D')"
ON="UPDATE public.platform_config SET value = '\"true\"' WHERE key = 'team_digest_enabled';"
FNS="'_team_digest_totals', 'team_daily_metrics', 'team_digest_recipients', 'claim_team_digest', 'finish_team_digest', 'set_team_digest_optout', 'dispatch_team_digest', 'check_team_digest_overdue'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"
RECIPIENTS="SELECT coalesce(string_agg(role || ':' || email, ',' ORDER BY role, email), '<none>') FROM public.team_digest_recipients();"
A1=a1000000-0000-4000-8000-000000000001
S1=a1000000-0000-4000-8000-000000000002
ZERO_RIDES='"canceled_by_rider":0,"canceled_by_driver":0,"no_driver":0,"no_driver_with_offer":0,"no_driver_without_offer":0'

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies" \
  "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('_poi_admin_area', 'mailable_user_emails', 'get_platform_config_text')" \
  "_poi_admin_area:f8f7725ad687b5fbea5429d1bcfd23aa,get_platform_config_text:407a7b835c527164a4aa8b3aa8525ba5,mailable_user_emails:58def9245ceb43b710a57ef01c450572"
val "S1 like prod, postgres owns the public functions and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') FROM pg_proc WHERE pronamespace = 'public'::regnamespace" \
  "postgres|false"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 the tables have RLS and only service_role can read them" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('service_role', c.oid, 'SELECT'), ',' ORDER BY c.relname) FROM pg_class c WHERE c.oid IN (to_regclass('public.team_digest_optouts'), to_regclass('public.team_digest_runs'))" \
  "team_digest_optouts:true:falsefalsetrue,team_digest_runs:true:falsefalsetrue"
val "O2 the settings start off, with no preview" \
  "SELECT coalesce(string_agg(key || '=' || (value #>> '{}'), ',' ORDER BY key), '<none>') FROM public.platform_config WHERE key LIKE 'team_digest_%'" \
  "team_digest_enabled=false,team_digest_preview_to="
val "O3 only service_role executes the functions; all are SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') || ':' || p.prosecdef, ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)" \
  "_team_digest_totals:falsefalsetrue:true,check_team_digest_overdue:falsefalsetrue:true,claim_team_digest:falsefalsetrue:true,dispatch_team_digest:falsefalsetrue:true,finish_team_digest:falsefalsetrue:true,set_team_digest_optout:falsefalsetrue:true,team_daily_metrics:falsefalsetrue:true,team_digest_recipients:falsefalsetrue:true"
val "O4 a signed-in client cannot call the metrics" \
  "$(txn "SET LOCAL ROLE authenticated; SELECT t.outcome('SELECT public.team_daily_metrics(''$D'')::text');")" \
  "raised 42501: permission denied for function team_daily_metrics"
val "O5 the two cron jobs exist and are active" \
  "SELECT coalesce(string_agg(jobname || '|' || schedule || '|' || command || '|' || active, ',' ORDER BY jobname), '<none>') FROM cron.job WHERE jobname IN ('send-team-digest', 'check-team-digest-overdue')" \
  "check-team-digest-overdue|*/15 * * * *|SELECT public.check_team_digest_overdue();|true,send-team-digest|5 * * * *|SELECT public.dispatch_team_digest();|true"

echo "== the numbers =="
val "M1 rides requested on D (test accounts out; no double count)" "$(EQ "$M->'current'->'rides'" "{\"requested\":7,\"completed\":2,\"canceled_by_rider\":1,\"canceled_by_driver\":1,\"no_driver\":2,\"no_driver_with_offer\":1,\"no_driver_without_offer\":1,\"hours_without_coverage\":21}")" "ok"
val "M2 sign-ups and drivers on D" "$(EQ "$M->'current'->'signups'" '{"new_riders":2,"drivers_registered":1,"drivers_approved":1,"drivers_online":2,"drivers_with_ride":1}')" "ok"
val "M3 money on D (final snapshots only; failed and test recharges out)" "$(EQ "$M->'current'->'money'" '{"charged":3500,"commission":525,"recharged":5000}')" "ok"
val "M4 marketing totals on D" "$(EQ "$M->'current'->'marketing'" '{"signups_with_code":2,"referrals":1,"first_rides":1,"campaigns_sent":1,"promotion_uses":3}')" "ok"
val "M5 the day before" "$(EQ "$M->'previous'" "{\"rides\":{\"requested\":2,\"completed\":2,$ZERO_RIDES,\"hours_without_coverage\":24},\"signups\":{\"new_riders\":1,\"drivers_registered\":0,\"drivers_approved\":0,\"drivers_online\":0,\"drivers_with_ride\":1},\"money\":{\"charged\":800,\"commission\":120,\"recharged\":3000},\"marketing\":{\"signups_with_code\":0,\"referrals\":0,\"first_rides\":1,\"campaigns_sent\":1,\"promotion_uses\":0}}")" "ok"
val "M6 the same weekday a week before" "$(EQ "$M->'week_ago'" "{\"rides\":{\"requested\":1,\"completed\":1,$ZERO_RIDES,\"hours_without_coverage\":24},\"signups\":{\"new_riders\":0,\"drivers_registered\":0,\"drivers_approved\":0,\"drivers_online\":0,\"drivers_with_ride\":1},\"money\":{\"charged\":1200,\"commission\":180,\"recharged\":0},\"marketing\":{\"signups_with_code\":0,\"referrals\":0,\"first_rides\":0,\"campaigns_sent\":0,\"promotion_uses\":0}}")" "ok"
val "M7 by pickup municipality (no location or outside every polygon -> null)" "$(EQ "$M->'breakdowns'->'municipalities'" '[{"name":"Plaza","requested":3,"completed":1,"no_driver":0},{"name":"Centro Habana","requested":2,"completed":1,"no_driver":1},{"name":null,"requested":2,"completed":0,"no_driver":1}]')" "ok"
val "M8 by vehicle type" "$(EQ "$M->'breakdowns'->'vehicles'" '[{"slug":"auto_standard","name":"Auto","requested":2,"completed":1,"no_driver":0},{"slug":"moto_standard","name":"Moto","requested":2,"completed":0,"no_driver":2},{"slug":"triciclo_basico","name":"Triciclo","requested":2,"completed":1,"no_driver":0},{"slug":"auto_confort","name":"Confort","requested":1,"completed":0,"no_driver":0}]')" "ok"
val "M9 by time band (00:00 is dawn, 23:59 is night)" "$(EQ "$M->'breakdowns'->'bands'" '[{"band":"dawn","requested":2,"no_driver":1},{"band":"morning","requested":1,"no_driver":0},{"band":"afternoon","requested":1,"no_driver":0},{"band":"night","requested":3,"no_driver":1}]')" "ok"
val "M10 pending now" "$(EQ "$M->'pending'" '{"drivers_under_review":1,"incidents_open":2,"sos_open":1,"disputes_open":2,"disputes_overdue":1}')" "ok"
val "M11 lists (test account's code out; failed campaign listed)" "$(EQ "$M->'lists'" '{"signup_codes":[{"code":"BACO1","label":"Baco Instagram","signups":1},{"code":"RADIO","label":"Radio Taino","signups":1}],"campaigns":[{"name":"Promo sabado","status":"sent","push_sent":10,"email_sent":4},{"name":"Prueba","status":"failed","push_sent":0,"email_sent":0}],"promotions":[{"code":"BIENVENIDA","uses":2},{"code":"SUPERFLA","uses":1}]}')" "ok"
val "M12 the day field" "SELECT $M->>'day';" "$D"
val "M13 a day with nothing" "$(EQ "public.team_daily_metrics('2026-08-01')->'current'->'rides'" "{\"requested\":0,\"completed\":0,$ZERO_RIDES,\"hours_without_coverage\":24}") $(EQ "public.team_daily_metrics('2026-08-01')->'breakdowns'" '{"municipalities":[],"vehicles":[],"bands":[{"band":"dawn","requested":0,"no_driver":0},{"band":"morning","requested":0,"no_driver":0},{"band":"afternoon","requested":0,"no_driver":0},{"band":"night","requested":0,"no_driver":0}]}')" "ok;ok"
val "M14 daylight-saving days have 25 and 23 hours" \
  "SELECT public._team_digest_totals('2026-11-01')->'rides'->>'hours_without_coverage'; SELECT public._team_digest_totals('2027-03-14')->'rides'->>'hours_without_coverage';" "25;23"
val "M15 a missing day is refused" "SELECT t.outcome('SELECT public.team_daily_metrics(NULL)::text');" \
  "raised P0001: team_daily_metrics: p_day is required [team_digest_bad_day]"

echo "== recipients =="
val "R1 panel roles with a proven address; blocked, unproven and platform accounts out" "$RECIPIENTS" \
  "admin:ana@example.com,marketing:mia@example.com,super_admin:sam@example.com"
val "R2 an opt-out removes the person and an opt-in brings them back" \
  "$(txn "SELECT public.set_team_digest_optout('$A1', true); $RECIPIENTS SELECT public.set_team_digest_optout('$A1', false); $RECIPIENTS")" \
  "t;marketing:mia@example.com,super_admin:sam@example.com;t;admin:ana@example.com,marketing:mia@example.com,super_admin:sam@example.com"
val "R3 opting out an account that does not exist answers false" \
  "SELECT public.set_team_digest_optout('00000000-0000-4000-8000-00000000dead', true);" "f"
val "R4 preview mode sends only to that account" \
  "$(txn "UPDATE public.platform_config SET value = to_jsonb('$S1'::text) WHERE key = 'team_digest_preview_to'; $RECIPIENTS")" \
  "super_admin:sam@example.com"
val "R5 a preview value that is no account sends to nobody" \
  "$(txn "UPDATE public.platform_config SET value = '\"nadie\"' WHERE key = 'team_digest_preview_to'; $RECIPIENTS")" "<none>"
val "R6 the recipient's name comes along" \
  "SELECT full_name FROM public.team_digest_recipients() WHERE role = 'admin';" "Ana Admin"

echo "== run log =="
val "C1 a day is claimed once" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.claim_team_digest('$D'); SELECT status FROM public.team_digest_runs WHERE day = '$D';")" \
  "t;f;sending"
val "C2 a send stuck for 30 minutes becomes failed and is not claimed again" \
  "$(txn "SELECT public.claim_team_digest('$D'); UPDATE public.team_digest_runs SET started_at = now() - interval '31 minutes'; SELECT public.claim_team_digest('2026-10-08'); SELECT day || ':' || status || ':' || coalesce(last_error, '') FROM public.team_digest_runs ORDER BY day; SELECT public.claim_team_digest('$D');")" \
  "t;t;2026-10-07:failed:interrupted;2026-10-08:sending:;f"
val "C3 a partial send is 'sent' with its failures; a second finish does nothing" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 3, 2, 1, 'x: boom'); SELECT status || ':' || recipients || ':' || sent || ':' || failed || ':' || last_error FROM public.team_digest_runs; SELECT public.finish_team_digest('$D', 3, 3, 0, NULL);")" \
  "t;t;sent:3:2:1:x: boom;f"
val "C4 nothing sent to anyone is 'failed'" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 2, 0, 2, 'all bad'); SELECT status FROM public.team_digest_runs;")" \
  "t;t;failed"
val "C5 an error before sending is 'failed'; no recipients and no error is 'sent'" \
  "$(txn "SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 0, 0, 0, 'metrics: x'); SELECT public.claim_team_digest('2026-10-08'); SELECT public.finish_team_digest('2026-10-08', 0, 0, 0, NULL); SELECT string_agg(status, ',' ORDER BY day) FROM public.team_digest_runs;")" \
  "t;t;t;t;failed,sent"

echo "== dispatch (p_now: 11:05 UTC = 07:05 Havana in October) =="
CALLS="SELECT coalesce(string_agg(jobname || '|' || url || '|' || body::text || '|' || (headers->>'apikey'), ','), '<none>') FROM public.cron_http_post_calls;"
val "DS1 switched off: nothing" \
  "$(txn "SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" "disabled;<none>"
val "DS2 on, 06:30 Havana: not yet" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 10:30+00'); $CALLS")" "not_now;<none>"
val "DS3 on, 07:05 Havana: calls send-team-digest for the day before" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" \
  "dispatched;send-team-digest|https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-team-digest|{\"day\": \"2026-10-07\"}|test-service-key"
val "DS4 a day that already has a run is not dispatched again" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); $CALLS")" "t;already;<none>"
val "DS5 09:05 Havana is past the window" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-10-08 13:05+00'); $CALLS")" "not_now;<none>"
val "DS6 winter time: 12:05 UTC is 07:05 Havana, 11:05 UTC is 06:05" \
  "$(txn "$ON SELECT public.dispatch_team_digest('2026-12-10 11:05+00'); SELECT public.dispatch_team_digest('2026-12-10 12:05+00'); SELECT body::text FROM public.cron_http_post_calls;")" \
  "not_now;dispatched;{\"day\": \"2026-12-09\"}"
val "DS7 without a service key the run fails, so the cron watchdog sees it" \
  "$(txn "$ON SET LOCAL test.no_key = '1'; SELECT t.outcome('SELECT public.dispatch_team_digest(''2026-10-08 11:05+00'')');")" \
  "raised P0001: dispatch_team_digest: no service role key in the vault, the digest for 2026-10-07 was not sent [team_digest_no_service_key]"
val "DS8 the dispatcher marks a stuck send failed even when switched off" \
  "$(txn "SELECT public.claim_team_digest('2026-10-01'); UPDATE public.team_digest_runs SET started_at = now() - interval '31 minutes'; SELECT public.dispatch_team_digest('2026-10-08 11:05+00'); SELECT status FROM public.team_digest_runs WHERE day = '2026-10-01';")" \
  "t;disabled;failed"

echo "== overdue check =="
val "OV1 switched off: quiet" "SELECT public.check_team_digest_overdue('2026-10-08 13:15+00');" "disabled"
val "OV2 on, 08:30 Havana: not yet" "$(txn "$ON SELECT public.check_team_digest_overdue('2026-10-08 12:30+00');")" "not_yet"
val "OV3 on, 09:15 Havana, nothing sent: fails" \
  "$(txn "$ON SELECT t.outcome('SELECT public.check_team_digest_overdue(''2026-10-08 13:15+00'')');")" \
  "raised P0001: check_team_digest_overdue: the digest for 2026-10-07 is not sent [team_digest_overdue]"
val "OV4 sent: ok" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 1, 1, 0, NULL); SELECT public.check_team_digest_overdue('2026-10-08 13:15+00');")" "t;t;ok"
val "OV5 failed: fails" \
  "$(txn "$ON SELECT public.claim_team_digest('$D'); SELECT public.finish_team_digest('$D', 1, 0, 1, 'x'); SELECT t.outcome('SELECT public.check_team_digest_overdue(''2026-10-08 13:15+00'')');")" \
  "t;t;raised P0001: check_team_digest_overdue: the digest for 2026-10-07 is failed [team_digest_overdue]"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  T=$(mktemp -d)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  want=$($P -c "$BODIES" 2>&1 | tr -d '\r')
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$want" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  sabotage g1 "REVOKE ALL ON FUNCTION public.team_daily_metrics(date) FROM PUBLIC, anon, authenticated;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "team_daily_metrics(date) is executable by a client role" && ok "G1 a function a client can execute aborts the migration" || ko "G1 a function a client can execute aborts the migration" "$r"

  sabotage g2 "cron.schedule('send-team-digest', '5 * * * *'" "cron.schedule('send-team-digest', '7 * * * *'"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "a team digest cron job is missing or inactive" && ok "G2 a wrong cron schedule aborts the migration" || ko "G2 a wrong cron schedule aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -c "SET ROLE postgres; INSERT INTO cron.job (jobname, schedule, command, active) VALUES ('send-team-digest', '5 * * * *', 'SELECT 1;', false);" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG"); a=$($BIN/psql $CONN -d ${DB}g -qAt -c "SELECT command || '|' || active FROM cron.job WHERE jobname = 'send-team-digest'" 2>&1)
  [ "$r" = applied ] && [ "$a" = "SELECT public.dispatch_team_digest();|true" ] && ok "G3 a paused job is switched back on" || ko "G3 a paused job is switched back on" "$r / $a"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
