#!/usr/bin/env bash
# Rehearsal runner for migration 00624 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00624/run.sh none
#       -> scaffold (prod's corporate tables, wallets, policies and grants) + tests (RED: no functions)
#   supabase/tests/00624/run.sh supabase/migrations/00624_corporate_balance_and_employees_readers.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00624/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8
DB=pr624
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # created company A (and C); admin of both
BETO=b0000000-0000-4000-8000-000000000002   # second admin of A; created D, which has no wallet
CORA=c0000000-0000-4000-8000-000000000003   # employee of A, not an admin
DANI=d0000000-0000-4000-8000-000000000004   # created company B; nothing to do with A
EVA=e0000000-0000-4000-8000-000000000005    # platform admin
A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b
C=cccccccc-0000-4000-8000-00000000000c
D=dddddddd-0000-4000-8000-00000000000d

# as UID SQL -> SQL as authenticated with JWT subject UID, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
bal(){ echo "SELECT available || '|' || held FROM public.get_corporate_balance('$1');"; }
emps(){ echo "SELECT string_agg(full_name || ':' || role || ':' || is_active || ':' || coalesce(phone, '-'), ',' ORDER BY created_at DESC, id)
  FROM public.get_corporate_employees('$1');"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

B3_SQL="$(as $CORA "$(bal $A)")"
E2_SQL="$(as $CORA "$(emps $A)")"
B6_SQL="BEGIN; SET LOCAL ROLE anon; $(bal $A) ROLLBACK;"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 neither function exists yet" \
  "SELECT to_regprocedure('public.get_corporate_balance(uuid)') IS NULL; SELECT to_regprocedure('public.get_corporate_employees(uuid)') IS NULL" "t;t"
val "S1 baseline: a second admin of A cannot read the wallet that funds A (it is the creator's)" \
  "$(as $BETO "SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$ANA' AND account_type = 'corporate_cash';")" "0"
val "S2 baseline: nobody has a wallet row under the company id" \
  "SELECT count(*) FROM public.wallet_accounts WHERE user_id IN ('$A', '$B', '$C', '$D')" "0"
val "S3 baseline: the creator sees the other employees' rows but not their names" \
  "$(as $ANA "SELECT count(*) || '/' || count(u.id) FROM public.corporate_employees ce LEFT JOIN public.users u ON u.id = ce.user_id WHERE ce.corporate_account_id = '$A';")" "4/1"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN_B=$(grep -oE "'[0-9a-f]{32}' THEN -- 00624 balance" "$MIG" | grep -oE '[0-9a-f]{32}')
  OWN_E=$(grep -oE "'[0-9a-f]{32}' THEN -- 00624 employees" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the bodies the migration accepts as its own are the ones it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_corporate_balance(uuid)'::regprocedure;
     SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_corporate_employees(uuid)'::regprocedure" "$OWN_B;$OWN_E"
  val "M2 both are SECURITY DEFINER and only signed-in users can call them" \
    "SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')
       || ':' || has_function_privilege('authenticated', p.oid, 'EXECUTE'), ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.proname IN ('get_corporate_balance', 'get_corporate_employees')" \
    "get_corporate_balance:true:false:true,get_corporate_employees:true:false:true"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M3 lock_timeout and search_path do not outlive the file" \
    || ko "M3 lock_timeout and search_path do not outlive the file" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== the company balance =="
val "B1 the creator sees the balance of the wallet that funds the company" "$(as $ANA "$(bal $A)")" "5000|100"
val "B2 so does a second admin of the company, who cannot read that wallet directly" "$(as $BETO "$(bal $A)")" "5000|100"
err "B3 an employee who is not an admin cannot" "$B3_SQL" "42501"
err "B4 nor can the admin of another company" "$(as $DANI "$(bal $A)")" "42501"
val "B5 a platform admin can, for any company" "$(as $EVA "$(bal $A) $(bal $B)")" "5000|100;777|0"
err "B6 the publishable key alone cannot call it" "$B6_SQL" "42501"
val "B7 a company whose creator has no corporate wallet yet shows 0" "$(as $BETO "$(bal $D)")" "0|0"
val "B8 two companies of the same creator show the same wallet" "$(as $ANA "$(bal $C)")" "5000|100"
val "B9 an unknown company gives no row to a platform admin" \
  "$(as $EVA "SELECT count(*) FROM public.get_corporate_balance('99999999-0000-4000-8000-000000000099');")" "0"

echo "== the company's employees =="
val "E1 an admin of the company sees every employee with name, role, status and phone, newest first" \
  "$(as $BETO "$(emps $A)")" \
  "Fede:employee:false:+5350000006,Cora:employee:true:+5350000003,Beto:admin:true:+5350000002,Ana:admin:true:+5350000001"
err "E2 an employee who is not an admin cannot" "$E2_SQL" "42501"
err "E3 nor can the admin of another company" "$(as $DANI "$(emps $A)")" "42501"
val "E4 a platform admin can" "$(as $EVA "SELECT count(*) FROM public.get_corporate_employees('$A');")" "4"
err "E5 the publishable key alone cannot call it" "BEGIN; SET LOCAL ROLE anon; $(emps $A) ROLLBACK;" "42501"
val "E6 it reads only the asked company" "$(as $ANA "$(emps $C)")" "Ana:admin:true:+5350000001"
if [ "$MIG" = none ]; then
  echo "(B1-B9 and E1-E6 call functions that do not exist before 00624: they fail on the baseline)"
fi

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('no_balance_gate', ("""  IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador de la empresa puede ver su saldo.',
      DETAIL = 'not_corporate_admin';
  END IF;
""", ""))
variant('no_employees_gate', ("""  IF NOT (public.is_admin() OR public.is_corp_admin(p_account_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Solo un administrador de la empresa puede ver sus empleados.',
      DETAIL = 'not_corporate_admin';
  END IF;
""", ""))
variant('no_balance_revoke', ("REVOKE ALL ON FUNCTION public.get_corporate_balance(uuid) FROM PUBLIC, anon;\n", ""))
variant('no_employees_revoke', ("REVOKE ALL ON FUNCTION public.get_corporate_employees(uuid) FROM PUBLIC, anon;\n", ""))
PYEOF
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  refuses(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  proof "N1 without the gate, a plain employee reads the balance (so B3 tests it)" \
    "$T/no_balance_gate.sql" "$B3_SQL" "5000|100"
  r=$(fresh ${DB}g; apply_err ${DB}g "$T/no_employees_gate.sql"; run ${DB}g "$E2_SQL")
  echo "$r" | grep -q "Ana:admin" && ok "N2 without the gate, a plain employee reads the list (so E2 tests it)" \
    || ko "N2 without the gate, a plain employee reads the list (so E2 tests it)" "got [$r]"
  refuses "N3 the migration refuses to finish if anon can read the balance" \
    "$T/no_balance_revoke.sql" "00624: get_corporate_balance must be callable by signed-in users only"
  refuses "N4 the migration refuses to finish if anon can read the employees" \
    "$T/no_employees_revoke.sql" "00624: get_corporate_employees must be callable by signed-in users only"
  for fn in "get_corporate_balance(p_account_id uuid) RETURNS TABLE(available integer, held integer)" \
            "get_corporate_employees(p_account_id uuid) RETURNS TABLE(id uuid)"; do
    fresh ${DB}g
    run ${DB}g "$AS_OWNER; CREATE FUNCTION public.$fn LANGUAGE plpgsql AS \$f\$ BEGIN RETURN; END \$f\$;" >/dev/null
    r=$(apply_err ${DB}g "$MIG")
    echo "$r" | grep -q "00624: unexpected body of" \
      && ok "N5 a body it does not know is not replaced (${fn%%(*})" || ko "N5 a body it does not know is not replaced (${fn%%(*})" "$r"
  done
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
