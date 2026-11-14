#!/usr/bin/env bash
# Rehearsal runner for migration 00681 (local Postgres 16, no PostGIS needed).
#   supabase/tests/00681/run.sh none
#       -> base (00665 scaffold, migration 00665, tests/00674/extra.sql, migration 00674, extra.sql) + tests (RED)
#   supabase/tests/00681/run.sh supabase/migrations/00681_missed_ride_auto_apology.sql
#       -> the same + migration x2 + tests + CRLF copy + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> ...   Another database name: PGDB=<name> ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr681}"
NEG="${DB}n"
M665="$REPO/supabase/migrations/00665_signup_code_promotion.sql"
M674="$REPO/supabase/migrations/00674_missed_ride_apology_coupon.sql"
FRESHLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

PLAT=00000000-0000-0000-0000-000000000001   # the platform account (grants and support messages)
ANA=a1000000-0000-4000-8000-000000000001    # "Ana Pérez", confirmed phone
ANA2=a1000000-0000-4000-8000-000000000011   # gets ANA's phone in B2
BETO=a1000000-0000-4000-8000-000000000002   # no name, confirmed phone
NORA=a1000000-0000-4000-8000-000000000004   # phone never confirmed
TINA=a1000000-0000-4000-8000-000000000005   # test account
MARK=a1000000-0000-4000-8000-000000000006   # marketing (team)
COMP=a1000000-0000-4000-8000-000000000007   # takes a ride after the failure
DIEGO=d1000000-0000-4000-8000-000000000001; DP=dd100000-0000-4000-8000-000000000001
PICK="'POINT(-82.3666 23.1357)'"
DROP="'POINT(-82.3666 23.1384)'"
R1=33333333-0000-4000-8000-000000000001

tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
client(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; SET LOCAL request.jwt.claim.sub = '';" "$1" "$2"; }
ride(){ echo "INSERT INTO public.rides (id, customer_id, service_type, pickup_location, dropoff_location, estimated_fare_cup)
        VALUES ('$1', '$2', 'auto_standard', $PICK, $DROP, 4000);"; }
# missed USER AGO WAIT [MODE] [DRIVER]: a request USER made AGO, canceled after WAIT
missed(){ local drv="NULL"; [ -n "${5:-}" ] && drv="'$5'"
  echo "INSERT INTO public.rides (customer_id, driver_id, service_type, status, ride_mode, pickup_location, dropoff_location, estimated_fare_cup, created_at, canceled_at)
        VALUES ('$1', $drv, 'auto_standard', 'canceled', '${4:-passenger}', $PICK, $DROP, 4000, now() - interval '$2', now() - interval '$2' + interval '$3');"; }
JOB="DO \$j\$ BEGIN PERFORM public.grant_missed_ride_apologies(); END \$j\$;"
# out USER: the outcomes recorded for USER's rides, oldest failure first
out(){ echo "SELECT coalesce(string_agg(a.outcome, ',' ORDER BY r.canceled_at), '') FROM public.missed_ride_auto_apologies a
             JOIN public.rides r ON r.id = a.ride_id WHERE a.user_id = '$1';"; }
COUNTS="SELECT (SELECT count(*) FROM public.missed_ride_auto_apologies) || '|' || (SELECT count(*) FROM public.support_tickets)
        || '|' || (SELECT count(*) FROM public.test_http_calls);"
PUSH="SELECT string_agg(jobname || '|' || (body ->> 'user_id') || '|' || (body ->> 'category') || '|' || (body ->> 'title') || '|'
        || (body ->> 'body') || '|' || (body -> 'data' ->> 'event'), ';') FROM public.test_http_calls;"
NEWFNS="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('grant_missed_ride_apologies', '_apology_discount_text')"
LIVE="SELECT string_agg(proname || '=' || left(md5(replace(prosrc, chr(13), '')), 8), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('_missed_rider_summary', '_missed_ride_current_coupon',
        '_third_party_person_name', 'log_rpc_attempt')"
LIVE_MD5="_missed_ride_current_coupon=02b7b414,_missed_rider_summary=000c363a,_third_party_person_name=5cf39558,log_rpc_attempt=0a902c34"

# fresh DB [no674]: the base and the seed. On a failure it prints what psql said and returns 1.
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- create database failed:"; cat "$FRESHLOG"; return 1; }
  (cd "$REPO/supabase/tests/00665" && "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f scaffold.sql >/dev/null 2>>"$FRESHLOG") \
    || { echo "-- the 00665 scaffold failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M665" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- migration 00665 failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/00674/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- tests/00674/extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  if [ "${2:-}" != no674 ]; then
    "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M674" >/dev/null 2>>"$FRESHLOG" \
      || { echo "-- migration 00674 failed:"; cat "$FRESHLOG"; return 1; }
  fi
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/extra.sql" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- extra.sql failed:"; cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO public.users (id, role, full_name, is_test) VALUES
    ('$PLAT', 'customer', 'TriciGo', false), ('$ANA', 'customer', 'Ana Pérez', false), ('$ANA2', 'customer', 'Ana otra vez', false),
    ('$BETO', 'customer', NULL, false), ('$NORA', 'customer', 'Nora', false), ('$TINA', 'customer', 'Tina', true),
    ('$MARK', 'marketing', 'Mark', false), ('$COMP', 'customer', 'Coco', false), ('$DIEGO', 'driver', 'Diego', false);
  INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
    ('$ANA', '5355510001', now()), ('$BETO', '5355510002', now()), ('$NORA', '5355510004', NULL),
    ('$TINA', '5355510005', now()), ('$MARK', '5355510006', now()), ('$COMP', '5355510007', now()),
    ('$DIEGO', '5355510008', now());
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP', '$DIEGO');
  INSERT INTO public.platform_config (key, value) VALUES ('support_alert_after_s', '60');" >/dev/null 2>>"$FRESHLOG" \
    || { echo "-- seed failed:"; cat "$FRESHLOG"; return 1; }; }

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's live bodies" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  run $DB "UPDATE cron.job SET active = false WHERE jobname = 'grant-missed-ride-apologies';
           UPDATE public.promotions SET discount_percent = 15 WHERE code = 'PERDON10';" >/dev/null
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  "$BIN/psql" $CONN -d "$DB" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1 || { echo "migration NOT idempotent"; exit 1; }
  val "M1 a paused job is switched back on" "SELECT active FROM cron.job WHERE jobname = 'grant-missed-ride-apologies';" "t"
  val "M2 the second run leaves an edited promotion alone" "SELECT discount_percent FROM public.promotions WHERE code = 'PERDON10';" "15"
  # Back to 10 %, and rides from the last day count (the migration sets the start to its own run).
  run $DB "UPDATE public.promotions SET discount_percent = 10 WHERE code = 'PERDON10';
           UPDATE public.platform_config SET value = to_jsonb(now() - interval '1 day') WHERE key = 'missed_ride_auto_apology_since';" >/dev/null
fi

echo "== 1. the apology goes out =="
val "A1 a ride with no driver after 2 min gives the coupon" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" "granted"
val "A2 the grant is PERDON10, given by the platform" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB SELECT p.code || '|' || g.granted_by FROM public.promotion_grants g JOIN public.promotions p ON p.id = g.promotion_id WHERE g.user_id = '$ANA';")" \
  "PERDON10|$PLAT"
val "A3 a support ticket with the apology" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB SELECT t.status || '|' || t.category || '|' || t.priority || '|' || (t.ride_id IS NOT NULL) || '|' || m.is_admin || '|' || m.sender_id || '|' || m.message FROM public.support_tickets t JOIN public.ticket_messages m ON m.ticket_id = t.id WHERE t.user_id = '$ANA';")" \
  "waiting_user|ride_issue|low|true|true|$PLAT|Hola Ana, sentimos que no encontraras chofer para tu viaje. Para agradecerte la paciencia, tu próximo viaje tiene 10 % de descuento: se aplica solo cuando lo pidas. Si necesitas algo más, respóndenos aquí."
val "A4 a push to the person" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $PUSH")" \
  "missed-ride-apology|$ANA|system|Perdón, no encontramos chofer|Te regalamos 10 % de descuento en tu próximo viaje. Se aplica solo cuando lo pidas.|missed_ride_apology"
val "A5 a second run sends nothing new" "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $JOB $COUNTS")" "1|1|1"
val "A6 the next ride carries the coupon" \
  "$(tx "$(missed $ANA '10 minutes' '2 minutes') $JOB $(client $ANA "$(ride $R1 $ANA)") SELECT coalesce(p.code, 'none') FROM public.rides r LEFT JOIN public.promotions p ON p.id = r.promo_code_id WHERE r.id = '$R1';")" \
  "PERDON10"
val "A7 without a name it starts with Hola," \
  "$(tx "$(missed $BETO '10 minutes' '2 minutes') $JOB SELECT left(m.message, 15) FROM public.ticket_messages m JOIN public.support_tickets t ON t.id = m.ticket_id WHERE t.user_id = '$BETO';")" \
  "Hola, sentimos "

echo "== 2. once per phone, and who is left out =="
val "B1 a second failure of the same person" "$(tx "$(missed $ANA '20 minutes' '2 minutes') $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" "granted,already_given"
val "B2 the same phone on another account" \
  "$(tx "$(missed $ANA '20 minutes' '2 minutes') $JOB UPDATE auth.users SET phone = NULL WHERE id = '$ANA'; INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$ANA2', '5355510001', now()); $(missed $ANA2 '10 minutes' '2 minutes') $JOB $(out $ANA2)")" \
  "already_given"
val "B3 a coupon given by WhatsApp first" \
  "$(tx "INSERT INTO public.promotion_grants (promotion_id, user_id, source, granted_by) SELECT id, '$ANA', 'missed_ride', '$PLAT' FROM public.promotions WHERE code = 'PERDON10'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" \
  "already_given"
val "B4 no confirmed phone" "$(tx "$(missed $NORA '10 minutes' '2 minutes') $JOB $(out $NORA)")" "no_phone"
val "B5 a test account" "$(tx "$(missed $TINA '10 minutes' '2 minutes') $JOB $(out $TINA)")" "not_eligible"
val "B6 a team account" "$(tx "$(missed $MARK '10 minutes' '2 minutes') $JOB $(out $MARK)")" "not_eligible"
val "B7 took a ride since" \
  "$(tx "$(missed $COMP '30 minutes' '2 minutes') INSERT INTO public.rides (customer_id, driver_id, service_type, status, pickup_location, dropoff_location, estimated_fare_cup, created_at) VALUES ('$COMP', '$DP', 'auto_standard', 'completed', $PICK, $DROP, 4000, now() - interval '5 minutes'); $JOB $(out $COMP)")" \
  "not_eligible"
val "B8 waited 20 s" "$(tx "$(missed $ANA '10 minutes' '20 seconds') $JOB $(out $ANA)")" ""
val "B9 the ride had a driver" "$(tx "$(missed $ANA '10 minutes' '2 minutes' passenger $DP) $JOB $(out $ANA)")" ""
val "B10 a delivery" "$(tx "$(missed $ANA '10 minutes' '2 minutes' cargo) $JOB $(out $ANA)")" ""
val "B11 canceled more than 2 hours ago" "$(tx "$(missed $ANA '3 hours' '2 minutes') $JOB $(out $ANA)")" ""
val "B12 canceled before the start date" \
  "$(tx "UPDATE public.platform_config SET value = to_jsonb(now()) WHERE key = 'missed_ride_auto_apology_since'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" ""
val "B13 the off switch" \
  "$(tx "UPDATE public.platform_config SET value = '\"false\"' WHERE key = 'missed_ride_auto_apology_enabled'; $(missed $ANA '10 minutes' '2 minutes') $JOB $(out $ANA)")" ""
val "B14 no usable promotion: recorded, nothing sent" \
  "$(tx "UPDATE public.promotions SET is_active = false WHERE grant_only; $(missed $ANA '10 minutes' '2 minutes') $JOB SELECT ($(out $ANA | sed 's/;$//')) || '|' || (SELECT count(*) FROM public.support_tickets) || '|' || (SELECT count(*) FROM public.test_http_calls);")" \
  "no_coupon|0|0"
val "B15 a fixed-amount coupon says so" \
  "$(tx "INSERT INTO public.promotions (code, type, discount_fixed_cup, is_public, grant_only, created_at) VALUES ('PERDON500', 'fixed_discount', 500, false, true, now() + interval '1 second'); $(missed $ANA '10 minutes' '2 minutes') $JOB SELECT body ->> 'body' FROM public.test_http_calls;")" \
  "Te regalamos 500 CUP de descuento en tu próximo viaje. Se aplica solo cuando lo pidas."
val "B16 the discount text" \
  "$(tx "INSERT INTO public.promotions (id, code, type, discount_percent, is_public, grant_only) VALUES ('$R1', 'P125', 'percentage_discount', 12.5, false, true); SELECT coalesce(public._apology_discount_text('$R1'), 'null');")" \
  "12,5 % de descuento"

echo "== 3. errors =="
FAILBETO="CREATE FUNCTION public.zz_fail() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN IF NEW.user_id = '$BETO' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END \$f\$;
          CREATE TRIGGER zz_fail BEFORE INSERT ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.zz_fail();"
FAILALL="CREATE FUNCTION public.zz_fail() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RAISE EXCEPTION 'boom'; END \$f\$;
         CREATE TRIGGER zz_fail BEFORE INSERT ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.zz_fail();"
NOKEY="CREATE OR REPLACE FUNCTION public.get_service_role_key() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';"
val "C1 one failing ride does not stop the others, and leaves nothing behind" \
  "$(tx "$FAILBETO $(missed $ANA '10 minutes' '2 minutes') $(missed $BETO '9 minutes' '2 minutes') $JOB SELECT (SELECT string_agg(outcome, ',') FROM public.missed_ride_auto_apologies) || '|' || (SELECT count(*) FROM public.rpc_attempt_log WHERE rpc_name = 'grant_missed_ride_apologies' AND outcome = 'failed') || '|' || (SELECT count(*) FROM public.promotion_grants WHERE user_id = '$BETO');")" \
  "granted|1|0"
err "C2 when every ride fails, the run fails" "$(tx "$FAILALL $(missed $ANA '10 minutes' '2 minutes') $JOB")" "none processed"
err "C3 no service key fails the run" "$(tx "$NOKEY $(missed $ANA '10 minutes' '2 minutes') $JOB")" "no service role key"
val "C4 nothing to do needs no key" "$(tx "$NOKEY $JOB")" ""

echo "== 4. shape =="
val "D1 the apology promotion" \
  "SELECT count(*) || '|' || string_agg(code || ',' || discount_percent || ',' || is_public || ',' || first_ride_only || ',' || notify_on_publish || ',' || is_active, ';') FROM public.promotions WHERE grant_only;" \
  "1|PERDON10,10,false,false,false,true"
val "D2 the job runs every minute" \
  "SELECT schedule || '|' || command || '|' || active FROM cron.job WHERE jobname = 'grant-missed-ride-apologies';" \
  "* * * * *|SELECT public.grant_missed_ride_apologies();|true"
val "D3 no client can call the functions" \
  "SELECT string_agg(has_function_privilege('anon', u.f, 'EXECUTE') || '/' || has_function_privilege('authenticated', u.f, 'EXECUTE'), ',' ORDER BY u.i)
     FROM unnest(ARRAY['public.grant_missed_ride_apologies()', 'public._apology_discount_text(uuid)']) WITH ORDINALITY AS u(f, i);" \
  "false/false,false/false"
val "D4 no client can read or write the tracking table" \
  "SELECT has_table_privilege('anon', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE') || '/' || has_table_privilege('authenticated', 'public.missed_ride_auto_apologies', 'SELECT,INSERT,UPDATE,DELETE');" \
  "false/false"
val "D5 switched on by default" "SELECT value #>> '{}' FROM public.platform_config WHERE key = 'missed_ride_auto_apology_enabled';" "true"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  fresh_neg(){ fresh $NEG ${1:-} || { echo "negative-proof database failed"; exit 1; }; }
  mutant(){ sed -e "$2" "$MIG" > "$1"; ! cmp -s "$MIG" "$1"; }
  neg_mutant(){ local id="$1" label="$2" script="$3" want="$4" f r; f="$(mktemp)"
    if ! mutant "$f" "$script"; then ko "$id $label" "setup did not change the migration copy"; rm -f "$f"; return; fi
    fresh_neg; r=$(apply_err $NEG "$f"); rm -f "$f"
    echo "$r" | grep -q "$want" && ok "$id $label" || ko "$id $label" "got [$r]"; }
  neg_mutant N1 "a job open to the apps aborts it" \
    's/^REVOKE ALL ON FUNCTION public.grant_missed_ride_apologies() FROM PUBLIC, anon, authenticated;$/GRANT EXECUTE ON FUNCTION public.grant_missed_ride_apologies() TO authenticated;/' \
    "is open to a client"
  neg_mutant N2 "a tracking table open to the apps aborts it" \
    's/^REVOKE ALL ON public.missed_ride_auto_apologies FROM PUBLIC, anon, authenticated;$/GRANT SELECT ON public.missed_ride_auto_apologies TO authenticated;/' \
    "missed_ride_auto_apologies is open to a client"
  fresh_neg
  run $NEG "INSERT INTO public.promotions (code, type, discount_fixed_cup, is_public, grant_only) VALUES ('PERDON', 'fixed_discount', 500, false, true);" >/dev/null
  r=$(apply_err $NEG "$MIG")
  [ "$r" = applied ] && [ "$(run $NEG "SELECT string_agg(code, ',') FROM public.promotions WHERE grant_only;")" = "PERDON" ] \
    && ok "N3 an existing apology promotion is kept, not doubled" || ko "N3 an existing apology promotion is kept, not doubled" "apply [$r]"
  fresh_neg no674
  r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "needs 00674" \
    && ok "N4 without 00674 it aborts" || ko "N4 without 00674 it aborts" "got [$r]"
  fresh_neg
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $NEG "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ] && [ "$(run $NEG "$NEWFNS")" = "$(run $DB "$NEWFNS")" ]; then
    ok "N5 pasted with CRLF line ends, the bodies match the LF ones"
  else ko "N5 pasted with CRLF line ends, the bodies match the LF ones" "apply [$r], bodies [$(run $NEG "$NEWFNS")]"; fi
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1
  echo "== bodies after 00681 (copy into CLAUDE.md) =="
  "$BIN/psql" $CONN -d "$DB" -qAt -c "SELECT string_agg(proname || ' ' || md5(prosrc) || '/' || length(prosrc), E'\n' ORDER BY proname COLLATE \"C\") FROM pg_proc
           WHERE pronamespace = 'public'::regnamespace AND proname IN ('grant_missed_ride_apologies', '_apology_discount_text')" | tr -d '\r'
fi

echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
