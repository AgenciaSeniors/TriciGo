#!/usr/bin/env bash
# Rehearsal runner for migration 00675 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00675/run.sh none
#       -> scaffold (prod's users and corporate tables, with all their policies) + tests
#          (RED: every UPDATE and DELETE on corporate_employees dies with infinite recursion)
#   supabase/tests/00675/run.sh supabase/migrations/00675_corporate_employee_write_policies.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00675/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr675
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # created company A; its admin
BETO=b0000000-0000-4000-8000-000000000002   # second admin of A; created company D
CORA=c0000000-0000-4000-8000-000000000003   # employee of A
DANI=d0000000-0000-4000-8000-000000000004   # created company B; nothing to do with A
EVA=e0000000-0000-4000-8000-000000000005    # platform admin
FEDE=f0000000-0000-4000-8000-000000000006   # former employee of A
GIL=10000000-0000-4000-8000-000000000007    # belongs to no company
OLGA=20000000-0000-4000-8000-000000000008   # operator: reads everything, writes none of this
GONE=00000000-0000-0000-0000-000000000099   # what account deletion moves references to
A=aaaaaaaa-0000-4000-8000-00000000000a
B=bbbbbbbb-0000-4000-8000-00000000000b

# as UID SQL -> SQL as authenticated with JWT subject UID, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
anon(){ printf "BEGIN; SET LOCAL ROLE anon; %s ROLLBACK;" "$1"; }
service(){ printf "BEGIN; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1"; }
# What corporateService.removeEmployee sends, as PostgREST runs it.
remove(){ echo "WITH u AS (UPDATE public.corporate_employees SET is_active = false
  WHERE corporate_account_id = '$1' AND user_id = '$2' RETURNING id) SELECT count(*) FROM u;"; }
# What corporateService.addEmployee sends after the key says the person already has a row.
readd(){ echo "WITH u AS (UPDATE public.corporate_employees SET is_active = true, role = '$3', added_by = '$4'
  WHERE corporate_account_id = '$1' AND user_id = '$2' AND is_active = false RETURNING role, is_active, added_by)
  SELECT string_agg(role || ':' || is_active || ':' || (added_by = '$4'), ',') FROM u;"; }
add(){ echo "WITH i AS (INSERT INTO public.corporate_employees (corporate_account_id, user_id, role, added_by)
  VALUES ('$1', '$2', 'employee', '$3') RETURNING id) SELECT count(*) FROM i;"; }
erase(){ echo "WITH d AS (DELETE FROM public.corporate_employees
  WHERE corporate_account_id = '$1' AND user_id = '$2' RETURNING id) SELECT count(*) FROM d;"; }
active(){ echo "SELECT is_active FROM public.corporate_employees WHERE corporate_account_id = '$1' AND user_id = '$2';"; }
ride(){ echo "WITH i AS (INSERT INTO public.rides (customer_id, payment_method, estimated_fare_cup, estimated_fare_trc, corporate_account_id)
  VALUES ('$2', 'corporate', 1000, 1000, '$1') RETURNING id) SELECT count(*) FROM i;"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }

echo "== what already worked, with or without the migration =="
val "S0 the two corporate triggers here are prod's, byte for byte" \
  "SELECT md5(prosrc) || ':' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_validate_corporate()'::regprocedure;
   SELECT md5(prosrc) || ':' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_corporate_accounts_protect_admin_fields()'::regprocedure" \
  "1ce7e55f97ad92e5f6e3416e375e374a:5018;a8263f1d55d0af6ade45d972b21e6800:1479"
val "S1 an admin of the company reads its employees" \
  "$(as $BETO "SELECT count(*) FROM public.corporate_employees WHERE corporate_account_id = '$A';")" "4"
val "S2 an admin of the company adds a person" "$(as $ANA "$(add $A $GIL $ANA)")" "1"
err "S3 a former employee keeps their row, so adding them again hits the key" "$(as $ANA "$(add $A $FEDE $ANA)")" "23505"
val "S4 an admin of the company updates its account" \
  "$(as $BETO "WITH u AS (UPDATE public.corporate_accounts SET name = 'Nueva' WHERE id = '$A' RETURNING id) SELECT count(*) FROM u;")" "1"
val "S5 an employee asks a ride on the company" "$(as $CORA "$(ride $A $CORA)")" "1"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 no policy of the table reads the table: that is what recursed" \
    "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'corporate_employees'
       AND concat_ws(' ', qual, with_check) ~* 'from[[:space:]]+(public\.)?corporate_employees'" "0"
  val "M2 the guard fires before each UPDATE or DELETE row, and it is on" \
    "SELECT tgenabled::text || ':' || (tgtype = 27) FROM pg_trigger
     WHERE tgrelid = 'public.corporate_employees'::regclass AND tgname = 'trg_corporate_employees_protect_creator'" "O:true"
  val "M3 its function is SECURITY DEFINER and no client can call it" \
    "SELECT prosecdef || ':' || has_function_privilege('anon', oid, 'EXECUTE') || ':' || has_function_privilege('authenticated', oid, 'EXECUTE')
     FROM pg_proc WHERE oid = 'public.tg_corporate_employees_protect_creator()'::regprocedure" "true:false:false"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" -c "SELECT current_user" -c "SELECT coalesce(current_setting('request.jwt.claim.sub', true), '')" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;"";tricigo_owner' ] && ok "M4 the migration leaves no lock_timeout, role or JWT behind" \
    || ko "M4 the migration leaves no lock_timeout, role or JWT behind" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== removing an employee =="
val "U1 the creator removes an employee" "$(as $ANA "$(remove $A $CORA) $(active $A $CORA)")" "1;f"
val "U2 so does the second admin" "$(as $BETO "$(remove $A $CORA) $(active $A $CORA)")" "1;f"
val "U3 so does a platform admin" "$(as $EVA "$(remove $A $CORA)")" "1"
val "U4 an employee cannot" "$(as $CORA "$(remove $A $BETO)")" "0"
val "U5 nor can the admin of another company" "$(as $DANI "$(remove $A $CORA)")" "0"
val "U6 nor an operator, who only reads" "$(as $OLGA "$(remove $A $CORA)")" "0"
val "U7 nor the publishable key alone" "$(anon "$(remove $A $CORA)")" "0"
val "U8 an admin who was removed can no longer remove anyone" \
  "$(as $ANA "$(remove $A $BETO) SET LOCAL request.jwt.claim.sub = '$BETO'; $(remove $A $CORA)")" "1;0"
val "U9 a removed employee stops seeing the company" \
  "$(as $ANA "$(remove $A $CORA) SET LOCAL request.jwt.claim.sub = '$CORA'; SELECT count(*) FROM public.corporate_accounts WHERE id = '$A';")" "1;0"
err "U10 a row cannot be moved to a company the caller does not manage" \
  "$(as $ANA "UPDATE public.corporate_employees SET corporate_account_id = '$B' WHERE corporate_account_id = '$A' AND user_id = '$CORA';")" "42501"
err "U11 a removed employee can no longer ask a ride on the company" \
  "$(as $ANA "$(remove $A $CORA) SET LOCAL request.jwt.claim.sub = '$CORA'; $(ride $A $CORA)")" "corporate_not_employee"

echo "== adding a former employee back =="
val "R1 an admin brings the row back, with the role chosen now" "$(as $ANA "$(readd $A $FEDE admin $ANA)")" "admin:true:true"
val "R2 so does the second admin" "$(as $BETO "$(readd $A $FEDE employee $BETO)")" "employee:true:true"
val "R3 a former employee cannot bring themselves back" "$(as $FEDE "$(readd $A $FEDE admin $FEDE)")" ""
val "R4 an active employee has nothing to bring back: addEmployee reports the duplicate" \
  "$(as $ANA "$(readd $A $CORA employee $ANA)")" ""
val "R5 once back, they ride on the company again" \
  "$(as $ANA "$(remove $A $CORA) $(readd $A $CORA employee $ANA) SET LOCAL request.jwt.claim.sub = '$CORA'; $(ride $A $CORA)")" "1;employee:true:true;1"

echo "== deleting a row (no screen does, the policy stays usable) =="
val "D1 an admin of the company can" "$(as $BETO "$(erase $A $CORA)")" "1"
val "D2 so can a platform admin" "$(as $EVA "$(erase $A $CORA)")" "1"
val "D3 an employee cannot" "$(as $CORA "$(erase $A $FEDE)")" "0"
val "D4 nor can the admin of another company" "$(as $DANI "$(erase $A $CORA)")" "0"

echo "== the creator stays an active admin of the company =="
err "K1 the second admin cannot remove the creator" "$(as $BETO "$(remove $A $ANA)")" "corporate_creator_protected"
err "K2 nor demote them" \
  "$(as $BETO "UPDATE public.corporate_employees SET role = 'employee' WHERE corporate_account_id = '$A' AND user_id = '$ANA';")" "corporate_creator_protected"
err "K3 nor delete their row" "$(as $BETO "$(erase $A $ANA)")" "corporate_creator_protected"
err "K4 nor put someone else on their row" \
  "$(as $BETO "UPDATE public.corporate_employees SET user_id = '$GIL' WHERE corporate_account_id = '$A' AND user_id = '$ANA';")" "corporate_creator_protected"
err "K5 nor move their row to another company of the caller" \
  "$(as $BETO "UPDATE public.corporate_employees SET corporate_account_id = 'dddddddd-0000-4000-8000-00000000000d' WHERE corporate_account_id = '$A' AND user_id = '$ANA';")" "corporate_creator_protected"
err "K6 the creator cannot remove themselves either" "$(as $ANA "$(remove $A $ANA)")" "corporate_creator_protected"
val "K7 the second admin is no creator of A: the guard does not cover them" "$(as $ANA "$(remove $A $BETO)")" "1"
val "K8 a platform admin can, for the rare case of a company changing hands" "$(as $EVA "$(remove $A $ANA)")" "1"
val "K9 a change that leaves the creator an active admin goes through" \
  "$(as $BETO "WITH u AS (UPDATE public.corporate_employees SET added_by = '$BETO' WHERE corporate_account_id = '$A' AND user_id = '$ANA' RETURNING id) SELECT count(*) FROM u;")" "1"
val "K10 the service role still moves the row when the creator deletes their account (00657)" \
  "$(service "WITH u AS (UPDATE public.corporate_employees SET user_id = '$GONE', added_by = '$GONE' WHERE corporate_account_id = '$A' AND user_id = '$ANA' RETURNING id) SELECT count(*) FROM u;")" "1"
val "K11 deleting the company takes its employee rows with it" \
  "$(service "DELETE FROM public.corporate_accounts WHERE id = '$A'; SELECT count(*) FROM public.corporate_employees WHERE corporate_account_id = '$A';")" "0"
err "K12 the second admin cannot walk around the guard by taking created_by first" \
  "$(as $BETO "UPDATE public.corporate_accounts SET created_by = '$BETO' WHERE id = '$A'; $(remove $A $ANA)")" "corporate_creator_protected"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8', newline='').read().replace('\r\n', '\n')
def write(name, text):
    open(f'{out}/{name}.sql', 'w', encoding='utf-8', newline='').write(text)
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    write(name, v)
variant('no_update_fix', ("""ALTER POLICY corporate_employees_corp_admin_update ON public.corporate_employees
  USING (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()))
  WITH CHECK (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()));
""", ""))
variant('no_delete_fix', ("""ALTER POLICY corporate_employees_corp_admin_delete ON public.corporate_employees
  USING (public.is_corp_admin(corporate_account_id) OR (SELECT public.is_admin()));
""", ""))
variant('no_trigger', ("""CREATE OR REPLACE TRIGGER trg_corporate_employees_protect_creator
  BEFORE UPDATE OR DELETE ON public.corporate_employees
  FOR EACH ROW EXECUTE FUNCTION public.tg_corporate_employees_protect_creator();
""", ""))
variant('no_revoke', ("REVOKE ALL ON FUNCTION public.tg_corporate_employees_protect_creator() FROM PUBLIC, anon, authenticated;\n", ""))
variant('no_admin_exemption', ("     AND NOT public.is_admin()\n", ""))
variant('no_jwt_check', ("  IF auth.uid() IS NOT NULL\n     AND NOT public.is_admin()\n", "  IF NOT public.is_admin()\n"))
variant('no_role_check', ("          OR NEW.role <> 'admin'\n", ""))
variant('no_active_check', ("          OR NOT NEW.is_active\n", ""))
variant('no_user_check', ("          OR NEW.user_id <> OLD.user_id\n", ""))
variant('no_account_check', ("          OR NEW.corporate_account_id <> OLD.corporate_account_id) THEN\n", "          ) THEN\n"))
variant('no_delete_check', ("TG_OP = 'DELETE'\n          OR NOT NEW.is_active", "TG_OP <> 'DELETE' AND (NOT NEW.is_active"),
        ("          OR NEW.corporate_account_id <> OLD.corporate_account_id) THEN\n", "          OR NEW.corporate_account_id <> OLD.corporate_account_id)) THEN\n"))
write('crlf', s.replace('\n', '\r\n'))
PYEOF
  refuses(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  # proof NAME MIGRATION SQL EXPECTED -> with this broken copy applied, SQL gives EXPECTED
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  # proof_err NAME MIGRATION SQL PATTERN -> with this broken copy applied, SQL fails like PATTERN
  proof_err(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); echo "$r" | grep -q "$4" && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  refuses "N1 leaving the UPDATE policy as it was aborts the migration" "$T/no_update_fix.sql" "still reads corporate_employees"
  refuses "N2 leaving the DELETE policy as it was aborts the migration" "$T/no_delete_fix.sql" "still reads corporate_employees"
  refuses "N3 without the trigger the migration aborts" "$T/no_trigger.sql" "the creator guard is not on"
  refuses "N4 without the REVOKE the migration aborts" "$T/no_revoke.sql" "no client may call the creator guard"
  proof_err "N5 without the admin exemption a platform admin is refused (so K8 tests it)" \
    "$T/no_admin_exemption.sql" "$(as $EVA "$(remove $A $ANA)")" "corporate_creator_protected"
  proof_err "N6 without the JWT check the service role is refused (so K10 tests it)" \
    "$T/no_jwt_check.sql" "$(service "$(remove $A $ANA)")" "corporate_creator_protected"
  proof "N7 without the role check the creator can be demoted (so K2 tests it)" \
    "$T/no_role_check.sql" "$(as $BETO "WITH u AS (UPDATE public.corporate_employees SET role = 'employee' WHERE corporate_account_id = '$A' AND user_id = '$ANA' RETURNING id) SELECT count(*) FROM u;")" "1"
  proof "N8 without the active check the creator can be removed (so K1 tests it)" \
    "$T/no_active_check.sql" "$(as $BETO "$(remove $A $ANA)")" "1"
  proof "N9 without the user check someone else can take the creator's row (so K4 tests it)" \
    "$T/no_user_check.sql" "$(as $BETO "WITH u AS (UPDATE public.corporate_employees SET user_id = '$GIL' WHERE corporate_account_id = '$A' AND user_id = '$ANA' RETURNING id) SELECT count(*) FROM u;")" "1"
  proof "N10 without the company check the row can leave the company (so K5 tests it)" \
    "$T/no_account_check.sql" "$(as $BETO "WITH u AS (UPDATE public.corporate_employees SET corporate_account_id = 'dddddddd-0000-4000-8000-00000000000d' WHERE corporate_account_id = '$A' AND user_id = '$ANA' RETURNING id) SELECT count(*) FROM u;")" "1"
  proof "N11 without the DELETE case the creator's row can be deleted (so K3 tests it)" \
    "$T/no_delete_check.sql" "$(as $BETO "$(erase $A $ANA)")" "1"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql")
  want=$(run $DB "SELECT md5(prosrc) || ':' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_corporate_employees_protect_creator()'::regprocedure")
  got=$(run ${DB}g "SELECT md5(prosrc) || ':' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_corporate_employees_protect_creator()'::regprocedure")
  [ "$r" = applied ] && [ "$got" = "$want" ] && ok "N12 pasted with CRLF line endings the migration gives the same body" \
    || ko "N12 pasted with CRLF line endings the migration gives the same body" "$r / $got / $want"
  err "N13 ...and the same guard" "$(as $BETO "$(remove $A $ANA)")" "corporate_creator_protected" ${DB}g
  val "N14 ...and the same fix" "$(as $BETO "$(remove $A $CORA)")" "1" ${DB}g
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
