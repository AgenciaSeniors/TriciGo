#!/usr/bin/env bash
# Rehearsal runner for migration 00625 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00625/run.sh none
#       -> scaffold (prod's corporate tables, wallets, rides, policies and triggers) + tests (RED)
#   supabase/tests/00625/run.sh supabase/migrations/00625_corporate_prepaid_rides_and_company_limits.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00625/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr625
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # created A, C (approved) and P (pending); admin of all three
BETO=b0000000-0000-4000-8000-000000000002   # second admin of A; created D, which has no wallet
CORA=c0000000-0000-4000-8000-000000000003   # employee of A, C, P and D, not an admin
DANI=d0000000-0000-4000-8000-000000000004   # created B (wallet 777)
EVA=e0000000-0000-4000-8000-000000000005    # platform admin
FEDE=f0000000-0000-4000-8000-000000000006   # former employee of A
A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b
C=cccccccc-0000-4000-8000-00000000000c
D=dddddddd-0000-4000-8000-00000000000d
P=99999999-0000-4000-8000-000000000009

# ride CUSTOMER COMPANY|NULL FARE [PAYMENT] [STATUS] -> INSERT ... RETURNING 'ok'
ride(){ local co="NULL"; [ "$2" != NULL ] && co="'$2'"
  echo "INSERT INTO public.rides (customer_id, corporate_account_id, payment_method, status, estimated_fare_cup, estimated_fare_trc)
        VALUES ('$1', $co, '${4:-corporate}', '${5:-searching}', $3, $3) RETURNING 'ok';"; }
tx(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# as UID SQL -> SQL as authenticated with JWT subject UID, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
limits(){ echo "SELECT monthly_budget_trc || '|' || per_ride_cap_trc FROM public.corporate_accounts WHERE id = '$1';"; }
MONTH_START="(date_trunc('month', now() AT TIME ZONE 'America/Havana') AT TIME ZONE 'America/Havana')"

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# Two rides of 3000 on A asked at the same time: the first commits after 2 s.
race(){ local db="$1" first second
  first=$( { $BIN/psql $CONN -d "$db" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
      -c "BEGIN; $(ride $CORA $A 3000) SELECT pg_sleep(2); COMMIT;" 2>&1; } | tr -d '\r' | sed '/^$/d' | paste -sd';' - ) &
  local pid=$!
  sleep 0.7
  second=$(run "$db" "$(ride $CORA $C 3000)")
  wait $pid
  run "$db" "DELETE FROM public.rides" >/dev/null
  echo "$second"; }

G3_SQL="$(tx "$(ride $CORA $A 3000) $(ride $CORA $C 2000)")"
G2_SQL="$(tx "$(ride $CORA $A 4901)")"
P1_SQL="$(as $ANA "UPDATE public.corporate_accounts SET monthly_budget_trc = 20000, per_ride_cap_trc = 3000 WHERE id = '$A'; $(limits $A)")"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" = "none" ]; then
  val "S0 the scaffold carries prod's bodies of both triggers" \
    "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tg_rides_validate_corporate';
     SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tg_corporate_accounts_protect_admin_fields'" \
    "a638a60e8f3e244c3136846a3ea4bbe0;6516f2cfecb1374af6295a28b61c8aef"
fi

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  own(){ grep -oE "'[0-9a-f]{32}' THEN -- 00625 $1" "$MIG" | grep -oE '[0-9a-f]{32}'; }
  val "M1 the bodies the migration accepts as its own are the ones it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_validate_corporate()'::regprocedure;
     SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_corporate_accounts_protect_admin_fields()'::regprocedure;
     SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_corporate_month_spend()'::regprocedure" \
    "$(own validate);$(own protect);$(own refresh)"
  val "M2 a second apply leaves one cron job" "SELECT count(*) FROM cron.job WHERE jobname = 'refresh-corporate-month-spend'" "1"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | tail -2 | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M3 lock_timeout and search_path do not outlive the file" \
    || ko "M3 lock_timeout and search_path do not outlive the file" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== prepaid: a company ride needs the money to pay it =="
val "G1 a ride the wallet covers is accepted (5000 balance - 100 held)" "$(tx "$(ride $CORA $A 4900)")" "ok"
err "G2 one peso more is rejected" "$G2_SQL" "DETAIL:  corporate_insufficient_balance"
err "G3 an in-flight ride of another company of the same creator counts (they share the wallet)" \
  "$G3_SQL" "ok;ERROR:.*DETAIL:  corporate_insufficient_balance"
err "G4 every in-flight status holds its estimate" \
  "$(tx "$(ride $CORA $A 1000 corporate accepted) $(ride $CORA $A 1000 corporate driver_en_route)
         $(ride $CORA $A 1000 corporate arrived_at_pickup) $(ride $CORA $A 1000 corporate in_progress)
         $(ride $CORA $C 500 corporate arrived_at_destination) $(ride $CORA $A 401)")" \
  "ok;ok;ok;ok;ok;ERROR:.*DETAIL:  corporate_insufficient_balance"
val "G5 ...and what is left can still be spent" \
  "$(tx "$(ride $CORA $A 1000 corporate accepted) $(ride $CORA $A 1000 corporate driver_en_route)
         $(ride $CORA $A 1000 corporate arrived_at_pickup) $(ride $CORA $A 1000 corporate in_progress)
         $(ride $CORA $C 500 corporate arrived_at_destination) $(ride $CORA $A 400)")" "ok;ok;ok;ok;ok;ok"
val "G6 finished rides hold nothing" \
  "$(tx "$(ride $CORA $A 3000) $(ride $CORA $C 1000)
         UPDATE public.rides SET status = 'completed'; $(ride $CORA $A 4900)
         UPDATE public.rides SET status = 'canceled' WHERE estimated_fare_trc = 4900; $(ride $CORA $C 4900)")" "ok;ok;ok;ok"
val "G7 another creator's wallet is its own (Dani: 777)" \
  "$(tx "$(ride $CORA $A 4900) $(ride $DANI $B 777)")" "ok;ok"
err "G8 ...and it stops at its own balance" "$(tx "$(ride $DANI $B 778)")" "DETAIL:  corporate_insufficient_balance"
err "G9 a company with no corporate wallet cannot pay any ride" "$(tx "$(ride $CORA $D 1)")" \
  "DETAIL:  corporate_insufficient_balance"
val "G10 a ride that names the company but is paid in cash is not charged to it, so not gated" \
  "$(tx "$(ride $CORA $D 1000 cash)")" "ok"
err "G11 switching an in-flight ride to the company's payment is gated" \
  "$(tx "$(ride $CORA $D 1000 cash) UPDATE public.rides SET payment_method = 'corporate';")" \
  "ok;ERROR:.*DETAIL:  corporate_insufficient_balance"
err "G12 raising the estimate of an in-flight company ride is gated" \
  "$(tx "$(ride $CORA $A 4000) UPDATE public.rides SET estimated_fare_trc = 5000;")" \
  "ok;ERROR:.*DETAIL:  corporate_insufficient_balance"
val "G13 lowering it is not" \
  "$(tx "$(ride $CORA $A 4000) UPDATE public.rides SET estimated_fare_trc = 3000 RETURNING 'ok';")" "ok;ok"
val "G14 a status change never re-checks money: an emptied wallet does not stop a ride under way" \
  "$(tx "$(ride $CORA $A 4900) UPDATE public.wallet_accounts SET balance = 0 WHERE account_type = 'corporate_cash';
         UPDATE public.rides SET status = 'in_progress' RETURNING 'ok'; UPDATE public.rides SET status = 'completed' RETURNING 'ok';")" \
  "ok;ok;ok"
val "G15 a ride that is not in flight is not gated (an admin moving a finished ride to the company)" \
  "$(tx "$(ride $CORA NULL 9000 cash completed) UPDATE public.rides SET corporate_account_id = '$D', payment_method = 'corporate' RETURNING 'ok';")" \
  "ok;ok"

echo "== the monthly budget =="
BUDGET="UPDATE public.corporate_accounts SET monthly_budget_trc = 3000 WHERE id = '$A';
        UPDATE public.wallet_accounts SET balance = 100000 WHERE account_type = 'corporate_cash';"
err "B1 in-flight rides of the company count against its budget" \
  "$(tx "$BUDGET $(ride $CORA $A 2000) $(ride $CORA $A 1500)")" \
  "ok;ERROR:.*quedan 1000 CUP.*DETAIL:  corporate_over_monthly_budget"
val "B2 ...rides of the creator's other companies do not" \
  "$(tx "$BUDGET $(ride $CORA $C 2000) $(ride $CORA $A 3000)")" "ok;ok"
err "B3 this month's completed rides count, last month's (Havana) do not" \
  "$(tx "$BUDGET $(ride $CORA NULL 1 cash completed)
         INSERT INTO public.corporate_rides (corporate_account_id, ride_id, employee_user_id, fare_trc, created_at)
           SELECT '$A', id, '$CORA', 2500, $MONTH_START + interval '1 minute' FROM public.rides;
         INSERT INTO public.corporate_rides (corporate_account_id, ride_id, employee_user_id, fare_trc, created_at)
           SELECT '$A', id, '$CORA', 9999, $MONTH_START - interval '1 minute' FROM public.rides;
         $(ride $CORA $A 500) $(ride $CORA $A 1)")" \
  "ok;ok;ERROR:.*DETAIL:  corporate_over_monthly_budget"

echo "== every rejection is in Spanish with a code =="
err "R1 company payment with no company" "$(tx "$(ride $CORA NULL 1000)")" \
  "Elige la empresa que paga el viaje.*DETAIL:  corporate_account_required"
err "R2 an unknown company" "$(tx "$(ride $CORA 12345678-0000-4000-8000-000000000000 1000)")" \
  "La empresa que paga el viaje no existe.*DETAIL:  corporate_not_found"
err "R3 a company that is not approved" "$(tx "$(ride $CORA $P 1000)")" \
  "no está habilitada para pagar viajes.*DETAIL:  corporate_not_approved"
err "R4 someone who is not its employee" "$(tx "$(ride $DANI $A 1000)")" \
  "No eres empleado activo de esta empresa.*DETAIL:  corporate_not_employee"
err "R5 a former employee" "$(tx "$(ride $FEDE $A 1000)")" "DETAIL:  corporate_not_employee"
err "R6 no fare estimate" "$(tx "$(ride $CORA $A 0)")" \
  "No se pudo calcular el precio del viaje.*DETAIL:  corporate_fare_required"
err "R7 over the per-ride cap" \
  "$(tx "UPDATE public.corporate_accounts SET per_ride_cap_trc = 1000 WHERE id = '$A'; $(ride $CORA $A 1001)")" \
  "El viaje cuesta 1001 CUP y la empresa paga hasta 1000 CUP por viaje.*DETAIL:  corporate_over_ride_cap"
err "R8 not enough money" "$G2_SQL" "La empresa no tiene saldo suficiente para este viaje"

echo "== the company sets its budget and cap =="
val "P1 the creator sets them and they stay" "$P1_SQL" "20000|3000"
val "P2 so does a second admin of the company" \
  "$(as $BETO "UPDATE public.corporate_accounts SET monthly_budget_trc = 7000, per_ride_cap_trc = 0 WHERE id = '$A'; $(limits $A)")" "7000|0"
val "P3 an employee who is not an admin cannot" \
  "$(as $CORA "UPDATE public.corporate_accounts SET monthly_budget_trc = 7000 WHERE id = '$A'; $(limits $A)")" "0|0"
val "P4 the admin still cannot touch anything else that is protected" \
  "$(as $ANA "UPDATE public.corporate_accounts SET status = 'suspended', commission_percent = 1, current_month_spent = 5,
       is_fleet_owner = true, approved_at = now(), suspended_reason = 'x', created_by = '$BETO' WHERE id = '$A';
     SELECT status || '|' || coalesce(commission_percent::text, '-') || '|' || current_month_spent || '|' || is_fleet_owner
       || '|' || coalesce(approved_at::text, '-') || '|' || coalesce(suspended_reason, '-') || '|' || (created_by = '$ANA')
     FROM public.corporate_accounts WHERE id = '$A';")" "approved|-|0|false|-|-|true"
err "P5 a negative budget is rejected" \
  "$(as $ANA "UPDATE public.corporate_accounts SET monthly_budget_trc = -1 WHERE id = '$A';")" "23514"
err "P6 a negative cap is rejected" \
  "$(as $ANA "UPDATE public.corporate_accounts SET per_ride_cap_trc = -1 WHERE id = '$A';")" "23514"
val "P7 a platform admin sets them as before" \
  "$(as $EVA "UPDATE public.corporate_accounts SET monthly_budget_trc = 9000, per_ride_cap_trc = 900 WHERE id = '$A'; $(limits $A)")" "9000|900"
val "P8 the completion path (trusted flag) moves the spend and nothing else" \
  "$(tx "SET LOCAL request.jwt.claim.sub = '$CORA'; SELECT set_config('app.trusted_corporate_update', '1', true) IS NOT NULL;
         UPDATE public.corporate_accounts SET monthly_budget_trc = 1, per_ride_cap_trc = 1, current_month_spent = current_month_spent + 500 WHERE id = '$A';
         SELECT monthly_budget_trc || '|' || per_ride_cap_trc || '|' || current_month_spent FROM public.corporate_accounts WHERE id = '$A';")" \
  "t;0|0|500"

echo "== this month's spend =="
SPEND="UPDATE public.corporate_accounts SET current_month_spent = 999999 WHERE id IN ('$A', '$B');
       $(ride $CORA NULL 1 cash completed)
       INSERT INTO public.corporate_rides (corporate_account_id, ride_id, employee_user_id, fare_trc, created_at)
         SELECT v.co, r.id, '$CORA', v.fare, $MONTH_START + v.offs
         FROM public.rides r, (VALUES ('$A'::uuid, 1200, interval '1 minute'), ('$A'::uuid, 5000, interval '-1 minute'),
                                      ('$C'::uuid, 300, interval '20 days')) v(co, fare, offs)
         WHERE v.offs < now() - $MONTH_START;"
val "S1 the refresh sets each company to its completed rides of this month in Havana" \
  "$(tx "$SPEND SELECT public.refresh_corporate_month_spend();
         SELECT string_agg(name || ':' || current_month_spent, ',' ORDER BY name) FROM public.corporate_accounts;")" \
  "ok;$(run $DB "SELECT CASE WHEN now() - $MONTH_START > interval '20 days' THEN 3 ELSE 2 END");Empresa A:1200,Empresa B:0,Empresa C:$(run $DB "SELECT CASE WHEN now() - $MONTH_START > interval '20 days' THEN 300 ELSE 0 END"),Empresa D:0,Empresa P:0"
val "S2 a second run changes nothing" \
  "$(tx "$SPEND SELECT public.refresh_corporate_month_spend(); SELECT public.refresh_corporate_month_spend();")" \
  "ok;$(run $DB "SELECT CASE WHEN now() - $MONTH_START > interval '20 days' THEN 3 ELSE 2 END");0"
val "S3 it runs every hour at minute 2" \
  "SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'refresh-corporate-month-spend'" \
  "2 * * * *|SELECT public.refresh_corporate_month_spend();"
val "S4 only the service role can call it" \
  "SELECT has_function_privilege('anon', 'public.refresh_corporate_month_spend()', 'EXECUTE') || '|'
       || has_function_privilege('authenticated', 'public.refresh_corporate_month_spend()', 'EXECUTE') || '|'
       || has_function_privilege('service_role', 'public.refresh_corporate_month_spend()', 'EXECUTE')" "false|false|true"

echo "== two rides asked at the same time =="
r=$(race $DB)
echo "$r" | grep -q "DETAIL:  corporate_insufficient_balance" && ok "C1 the second waits for the first and is rejected" \
  || ko "C1 the second waits for the first and is rejected" "got [$r]"

if [ "$MIG" = none ]; then
  echo "(the G, B, R, P1/P2/P5/P6, S and C tests check what 00625 adds: they fail on the baseline)"
fi

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys, re
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
i = s.index('-- Assert the end state.'); j = s.index('RESET lock_timeout;')
no_assert = s[:i] + s[j:]
def variant(name, base, *pairs):
    v = base
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('no_lock', no_assert, ("  WHERE user_id = v_creator AND account_type = 'corporate_cash'\n  FOR UPDATE;\n",
                               "  WHERE user_id = v_creator AND account_type = 'corporate_cash';\n"))
variant('no_in_flight', no_assert, ("v_fare > v_balance - v_held - v_in_flight THEN", "v_fare > v_balance - v_held THEN"))
variant('no_held', no_assert, ("v_fare > v_balance - v_held - v_in_flight THEN", "v_fare > v_balance - v_in_flight THEN"))
variant('budget_reverted', no_assert, ("  NEW.commission_percent  := OLD.commission_percent;\n  NEW.current_month_spent := OLD.current_month_spent;\n",
                                       "  NEW.commission_percent  := OLD.commission_percent;\n  NEW.monthly_budget_trc  := OLD.monthly_budget_trc;\n  NEW.current_month_spent := OLD.current_month_spent;\n"))
variant('body_changed', s, ("  NEW.commission_percent  := OLD.commission_percent;\n  NEW.current_month_spent := OLD.current_month_spent;\n",
                            "  NEW.commission_percent  := OLD.commission_percent;\n  NEW.monthly_budget_trc  := OLD.monthly_budget_trc;\n  NEW.current_month_spent := OLD.current_month_spent;\n"))
variant('no_revoke', s, ("REVOKE ALL ON FUNCTION public.refresh_corporate_month_spend() FROM PUBLIC, anon, authenticated;\n", ""))
variant('no_cron', s, ("SELECT cron.schedule('refresh-corporate-month-spend', '2 * * * *',\n  'SELECT public.refresh_corporate_month_spend();');\n", ""))
PYEOF
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); echo "$r" | grep -q "$4" && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  refuses(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/no_lock.sql")
  if [ "$r" = applied ]; then r=$(race ${DB}g); echo "$r" | grep -q "^ok$" && ok "N1 without the lock both rides go through (so C1 tests it)" \
    || ko "N1 without the lock both rides go through (so C1 tests it)" "got [$r]"; else ko "N1" "apply: $r"; fi
  proof "N2 without the in-flight rides, G3 would pass (so G3 tests them)" "$T/no_in_flight.sql" "$G3_SQL" "^ok;ok$"
  proof "N3 without held_balance, G2 would pass (so G2 tests it)" "$T/no_held.sql" "$G2_SQL" "^ok$"
  proof "N4 if the budget were still reverted, P1 would see it (so P1 tests it)" "$T/budget_reverted.sql" "$P1_SQL" "^0|3000$"
  refuses "N5 the migration refuses to finish with a body that is not its own" \
    "$T/body_changed.sql" "00625: tg_corporate_accounts_protect_admin_fields is not the 00625 body"
  refuses "N6 ...or if clients can run the refresh" "$T/no_revoke.sql" "00625: refresh_corporate_month_spend must not be callable by clients"
  refuses "N7 ...or if the cron job is missing" "$T/no_cron.sql" "00625: the refresh-corporate-month-spend cron job is not scheduled"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE OR REPLACE FUNCTION public.tg_rides_validate_corporate() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00625: unexpected body of tg_rides_validate_corporate" \
    && ok "N8 a body it does not know is not replaced" || ko "N8 a body it does not know is not replaced" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
