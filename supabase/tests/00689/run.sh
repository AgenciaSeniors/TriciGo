#!/usr/bin/env bash
# Rehearsal runner for migration 00689 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00689/run.sh none
#       -> the 00612 scaffold (users, driver_profiles, auth.uid(), the API roles) + tests (RED: no table, no function)
#   supabase/tests/00689/run.sh supabase/migrations/00689_driver_overlay_status.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Two privilege modes: 'prod' grants every new public table to anon, authenticated and
# service_role by default (prod until 2026-10-30); 'strict' grants nothing by default (after).
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00689/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8
DB=pr689
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # a customer: no driver profile
DANI=d0000000-0000-4000-8000-000000000004   # a driver (has a driver_profiles row in the scaffold)
EVA=e0000000-0000-4000-8000-000000000005    # given a driver profile below: the cap test starts from zero
DEV=11111111-1111-4111-8111-111111111111
SIG="public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text)"

sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# as UID SQL -> SQL as authenticated with JWT subject UID, committed (the table keeps the rows)
as(){ printf "BEGIN; %s SET LOCAL ROLE authenticated; %s COMMIT;" "$(sub "$1")" "$2"; }
# report DEVICE GRANTED XIAOMI_OK LAUNCH_RESULT(sql literal, e.g. NULL or 'foreground')
report(){ echo "SELECT public.report_driver_overlay('$1', 'Xiaomi', 'Redmi', '14', '1.8.0', true, $2, $3, $4);"; }
# row -> Dani's row as granted:xiaomi_ok:fg/nfg/np:last_result
ROW="SELECT overlay_granted || ':' || xiaomi_ok || ':' || launches_foreground || '/' || launches_not_foreground || '/'
  || launches_no_permission || ':' || coalesce(last_launch_result, '-') FROM public.driver_overlay_status
  WHERE user_id = '$DANI' AND device_id = '$DEV'"

# fresh DBNAME MODE -> the 00612 scaffold + a driver profile for Eva; MODE 'prod' adds prod's default privileges
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00612/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "INSERT INTO public.driver_profiles (id, user_id)
           VALUES ('e1000000-0000-4000-8000-000000000005', '$EVA')" >/dev/null 2>&1 || return 1
         if [ "${2:-prod}" = prod ]; then
           $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
             GRANT ALL ON TABLES TO anon, authenticated, service_role;" >/dev/null 2>&1 || return 1
         fi; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

R4_SQL="$(as $ANA "$(report $DEV true false NULL)") SELECT count(*) FROM public.driver_overlay_status"
R5_SQL="$(as $DANI "$(report $DEV true false "'weird'") $(report '' true false NULL) $(report "$(printf 'x%.0s' $(seq 129))" true false NULL)") SELECT count(*) FROM public.driver_overlay_status"
R7_SQL="BEGIN; RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role; $(report $DEV true false NULL) ROLLBACK;"
# 20 installs for Eva, then a 21st, then a report from an install she already has
R9_SQL="BEGIN; $(sub $EVA) SET LOCAL ROLE authenticated;
  SELECT count(*) FROM generate_series(1, 20) g
    WHERE public.report_driver_overlay('eva-' || g, 'samsung', 'samsung', '15', '1.8.0', true, false, false, NULL) = 'recorded';
  $(report eva-21 true false NULL) $(report eva-1 true false "'foreground'")
  RESET ROLE; SELECT count(*) FROM public.driver_overlay_status WHERE user_id = '$EVA';
  SELECT launches_foreground FROM public.driver_overlay_status WHERE user_id = '$EVA' AND device_id = 'eva-1'; ROLLBACK;"

echo "== reset database (prod privileges) =="
fresh $DB prod || { echo "scaffold failed"; exit 1; }
val "S0 no driver_overlay_status table and no report_driver_overlay yet" \
  "SELECT to_regclass('public.driver_overlay_status') IS NULL; SELECT to_regprocedure('$SIG') IS NULL" "t;t"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN=$(grep -oE "'[0-9a-f]{32}' THEN -- 00689 report" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the body the migration accepts as its own is the one it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$SIG'::regprocedure" "$OWN"
  GRANTS="SELECT string_agg(grantee || ':' || privs, ',' ORDER BY grantee) FROM (SELECT grantee, string_agg(privilege_type, '/' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'driver_overlay_status'
    AND grantee IN ('anon', 'authenticated', 'service_role') GROUP BY grantee) g"
  val "M2 with prod's default privileges, the API roles end with nothing and service_role can write" \
    "$GRANTS" "service_role:DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE"
  fresh ${DB}s strict
  r=$(apply_err ${DB}s "$MIG")
  [ "$r" = applied ] && val "M3 without default privileges (after 2026-10-30), service_role still can write" \
    "$GRANTS" "service_role:DELETE/INSERT/SELECT/UPDATE" ${DB}s || ko "M3 strict mode apply" "$r"
  val "M4 RLS on, no policies; the function is SECURITY DEFINER and only signed-in users can call it" \
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.driver_overlay_status'::regclass;
     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.driver_overlay_status'::regclass;
     SELECT prosecdef FROM pg_proc WHERE oid = '$SIG'::regprocedure;
     SELECT has_function_privilege('anon', '$SIG', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', '$SIG', 'EXECUTE')" \
    "t;0;t;false/true"
  fresh ${DB}m prod
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M5 lock_timeout and search_path do not outlive the file" \
    || ko "M5 lock_timeout and search_path do not outlive the file" "got [$r]"
  fresh ${DB}c prod
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err ${DB}c "$CRLF")
  [ "$r" = applied ] && val "M6 a copy with Windows line endings applies and installs the same body" \
    "SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '$SIG'::regprocedure" "$OWN" ${DB}c \
    || ko "M6 a copy with Windows line endings applies" "$r"
  rm -f "$CRLF"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" -c "DROP DATABASE IF EXISTS ${DB}s" -c "DROP DATABASE IF EXISTS ${DB}c" >/dev/null 2>&1
fi

echo "== a driver's phone reports =="
val "R1 the first report of an install is recorded with what the phone sent" \
  "$(as $DANI "$(report $DEV false false NULL)") $ROW;
   SELECT manufacturer || '/' || brand || '/' || os_version || '/' || app_version || '/' || module_available
   FROM public.driver_overlay_status WHERE user_id = '$DANI'" \
  "recorded;false:false:0/0/0:-;Xiaomi/Redmi/14/1.8.0/true"
val "R2 the next report of the same install updates it and keeps when it was first seen" \
  "$(as $DANI "$(report $DEV true true NULL)") $ROW;
   SELECT updated_at > first_reported_at FROM public.driver_overlay_status WHERE user_id = '$DANI'" \
  "updated;true:true:0/0/0:-;t"
val "R3 each launch result bumps its own counter and becomes the last result" \
  "$(as $DANI "$(report $DEV true true "'foreground'") $(report $DEV true true "'foreground'") $(report $DEV true true "'not_foreground'") $(report $DEV false true "'no_permission'")") $ROW;
   SELECT last_launch_at IS NOT NULL FROM public.driver_overlay_status WHERE user_id = '$DANI'" \
  "updated;updated;updated;updated;false:true:2/1/1:no_permission;t"
val "R12 a plain status report does not touch the counters or the last launch" \
  "$(as $DANI "$(report $DEV true true NULL)") $ROW" "updated;true:true:2/1/1:no_permission"
val "R4 an account without a driver profile is refused and records nothing" "$R4_SQL" "invalid;1"
val "R5 an unknown launch result, an empty install id or one over 128 characters is refused" \
  "$R5_SQL" "invalid;invalid;invalid;1"
err "R6 the publishable key alone cannot call it" \
  "BEGIN; SET LOCAL ROLE anon; $(report $DEV true false NULL) ROLLBACK;" "42501"
err "R7 the service role with no user is refused" "$R7_SQL" "42501"
err "R8 a signed-in driver cannot read the table directly" \
  "BEGIN; $(sub $DANI) SET LOCAL ROLE authenticated; SELECT count(*) FROM public.driver_overlay_status; ROLLBACK;" "42501"
err "R8b nor write it directly" \
  "BEGIN; $(sub $DANI) SET LOCAL ROLE authenticated; INSERT INTO public.driver_overlay_status (user_id, device_id, module_available, overlay_granted) VALUES ('$DANI', 'x', true, true); ROLLBACK;" "42501"
val "R9 an account keeps 20 installs: the 21st is not recorded, a known one still updates" \
  "$R9_SQL" "20;capped;updated;20;1"
val "R10 a maker over 64 characters is cut to 64; an empty one is stored as null" \
  "BEGIN; $(sub $DANI) SET LOCAL ROLE authenticated;
   SELECT public.report_driver_overlay('$DEV', '$(printf 'm%.0s' $(seq 70))', '', '14', '1.8.0', true, true, true, NULL);
   RESET ROLE; SELECT length(manufacturer), brand IS NULL FROM public.driver_overlay_status WHERE user_id = '$DANI'; ROLLBACK;" \
  "updated;64|t"
val "R11 deleting the account deletes its rows" \
  "BEGIN; DELETE FROM public.users WHERE id = '$DANI'; SELECT count(*) FROM public.driver_overlay_status WHERE user_id = '$DANI'; ROLLBACK;" "0"
if [ "$MIG" = none ]; then
  echo "(R1-R12 use driver_overlay_status and report_driver_overlay, which do not exist before 00689: they fail on the baseline)"
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
variant('no_cap', ("""  IF (SELECT count(*) FROM public.driver_overlay_status WHERE user_id = v_uid) >= 20 THEN
    RETURN 'capped';
  END IF;
""", ""))
variant('no_uid_check', ("""  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'report_driver_overlay needs a signed-in user';
  END IF;
""", ""))
variant('no_driver_check', ("""  IF NOT EXISTS (SELECT 1 FROM public.driver_profiles WHERE user_id = v_uid) THEN
    RETURN 'invalid';
  END IF;
""", ""))
variant('no_result_check', ("""     OR (p_launch_result IS NOT NULL
         AND p_launch_result NOT IN ('foreground', 'not_foreground', 'no_permission'))""", ""))
variant('no_revoke', ("REVOKE ALL ON public.driver_overlay_status FROM anon, authenticated;\n", ""))
variant('no_service_grant', ("GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_overlay_status TO service_role;\n", ""))
variant('no_fn_revoke', ("REVOKE ALL ON FUNCTION public.report_driver_overlay(text, text, text, text, text, boolean, boolean, boolean, text) FROM PUBLIC, anon;\n", ""))
PYEOF
  proof(){ local r; fresh ${DB}g "${5:-prod}"; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  refuses(){ local r; fresh ${DB}g "$4"; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  proof "N1 without the cap, a 21st install is recorded (so R9 tests it)" \
    "$T/no_cap.sql" "$R9_SQL" "20;recorded;updated;21;1"
  proof "N2 without the signed-in check, the service role gets an answer instead of an error (so R7 tests it)" \
    "$T/no_uid_check.sql" "$R7_SQL" "invalid"
  proof "N3 without the driver check, a customer is recorded (so R4 tests it)" \
    "$T/no_driver_check.sql" "$R4_SQL" "recorded;1"
  r=$(fresh ${DB}g prod; apply_err ${DB}g "$T/no_result_check.sql"; run ${DB}g "$(as $DANI "$(report $DEV true false "'weird'")")")
  echo "$r" | grep -q "23514" && ok "N4 without the result check, an unknown result reaches the table's CHECK (so R5 tests it)" \
    || ko "N4 without the result check, an unknown result reaches the table's CHECK (so R5 tests it)" "got [$r]"
  refuses "N5 the migration refuses to finish if the API roles keep prod's default access" \
    "$T/no_revoke.sql" "00689: the API roles must have no access to driver_overlay_status" prod
  refuses "N6 the migration refuses to finish if service_role cannot write (after 2026-10-30)" \
    "$T/no_service_grant.sql" "00689: service_role must be able to write driver_overlay_status" strict
  refuses "N7 the migration refuses to finish if anon can call the function" \
    "$T/no_fn_revoke.sql" "00689: report_driver_overlay must be callable by signed-in users only" prod
  fresh ${DB}g prod
  run ${DB}g "$AS_OWNER; CREATE FUNCTION $SIG
    RETURNS text LANGUAGE plpgsql AS \$f\$ BEGIN RETURN 'other'; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00689: unexpected body of report_driver_overlay" \
    && ok "N8 a function body it does not know is not replaced" || ko "N8 a function body it does not know is not replaced" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
