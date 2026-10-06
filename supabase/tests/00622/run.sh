#!/usr/bin/env bash
# Rehearsal runner for migration 00622 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00622/run.sh none
#       -> the 00612 scaffold (users, auth.uid(), the API roles) + tests (RED: no table, no function)
#   supabase/tests/00622/run.sh supabase/migrations/00622_app_opens.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Two privilege modes: 'prod' grants every new public table to anon, authenticated and
# service_role by default (prod until 2026-10-30); 'strict' grants nothing by default (after).
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00622/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8
DB=pr622
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001
BETO=b0000000-0000-4000-8000-000000000002
EVA=e0000000-0000-4000-8000-000000000005    # no rows anywhere: the cap test starts from zero
DEV=11111111-1111-4111-8111-111111111111

sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# as UID SQL -> SQL as authenticated with JWT subject UID, committed (the table keeps the rows)
as(){ printf "BEGIN; %s SET LOCAL ROLE authenticated; %s COMMIT;" "$(sub "$1")" "$2"; }
# report APP DEVICE VERSION PLATFORM
report(){ echo "SELECT public.report_app_open('$1', '$2', '$3', '$4');"; }
# rows -> every row as user:app:device:version:platform, ordered
ROWS="SELECT string_agg(u.full_name || ':' || o.app || ':' || left(o.device_id, 8) || ':' || coalesce(o.app_version, '-')
  || ':' || coalesce(o.platform, '-'), ',' ORDER BY u.full_name, o.app, o.device_id)
  FROM public.app_opens o JOIN public.users u ON u.id = o.user_id"

# fresh DBNAME MODE -> the 00612 scaffold; MODE 'prod' adds prod's default privileges on new tables
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00612/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-prod}" = prod ]; then
           $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "ALTER DEFAULT PRIVILEGES FOR ROLE tricigo_owner IN SCHEMA public
             GRANT ALL ON TABLES TO anon, authenticated, service_role;" >/dev/null 2>&1 || return 1
         fi; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

R1_SQL="$(as $ANA "$(report client $DEV 1.7.4 android)") $ROWS"
R5_SQL="$(as $ANA "$(report admin $DEV 1.7.4 android) $(report client '' 1.7.4 android) $(report client "$(printf 'x%.0s' $(seq 129))" 1.7.4 android)") SELECT count(*) FROM public.app_opens"
R7_SQL="BEGIN; RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role; $(report client $DEV 1.7.4 android) ROLLBACK;"
# 20 installs for Eva's client, then a 21st, then an open of an install she already has
R9_SQL="BEGIN; $(sub $EVA) SET LOCAL ROLE authenticated;
  SELECT count(*) FROM generate_series(1, 20) g WHERE public.report_app_open('client', 'eva-' || g, '1.7.4', 'ios') = 'recorded';
  $(report client eva-21 1.7.4 ios) $(report client eva-1 1.7.5 ios) $(report driver eva-21 1.7.4 ios)
  RESET ROLE; SELECT count(*) FROM public.app_opens WHERE user_id = '$EVA' AND app = 'client';
  SELECT app_version FROM public.app_opens WHERE user_id = '$EVA' AND device_id = 'eva-1'; ROLLBACK;"

echo "== reset database (prod privileges) =="
fresh $DB prod || { echo "scaffold failed"; exit 1; }
val "S0 no app_opens table and no report_app_open yet" \
  "SELECT to_regclass('public.app_opens') IS NULL; SELECT to_regprocedure('public.report_app_open(text, text, text, text)') IS NULL" "t;t"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN=$(grep -oE "'[0-9a-f]{32}' THEN -- 00622 report" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the body the migration accepts as its own is the one it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.report_app_open(text, text, text, text)'::regprocedure" "$OWN"
  GRANTS="SELECT string_agg(grantee || ':' || privs, ',' ORDER BY grantee) FROM (SELECT grantee, string_agg(privilege_type, '/' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'app_opens'
    AND grantee IN ('anon', 'authenticated', 'service_role') GROUP BY grantee) g"
  val "M2 with prod's default privileges, the API roles end with nothing and service_role can write" \
    "$GRANTS" "service_role:DELETE/INSERT/REFERENCES/SELECT/TRIGGER/TRUNCATE/UPDATE"
  fresh ${DB}s strict
  r=$(apply_err ${DB}s "$MIG")
  [ "$r" = applied ] && val "M3 without default privileges (after 2026-10-30), service_role still can write" \
    "$GRANTS" "service_role:DELETE/INSERT/SELECT/UPDATE" ${DB}s || ko "M3 strict mode apply" "$r"
  val "M4 RLS on, no policies; the function is SECURITY DEFINER and only signed-in users can call it" \
    "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.app_opens'::regclass;
     SELECT count(*) FROM pg_policy WHERE polrelid = 'public.app_opens'::regclass;
     SELECT prosecdef FROM pg_proc WHERE oid = 'public.report_app_open(text, text, text, text)'::regprocedure;
     SELECT has_function_privilege('anon', 'public.report_app_open(text, text, text, text)', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.report_app_open(text, text, text, text)', 'EXECUTE')" \
    "t;0;t;false/true"
  fresh ${DB}m prod
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M5 lock_timeout and search_path do not outlive the file" \
    || ko "M5 lock_timeout and search_path do not outlive the file" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" -c "DROP DATABASE IF EXISTS ${DB}s" >/dev/null 2>&1
fi

echo "== an app reports its open =="
val "R1 the first open of an install is recorded with its version and platform" "$R1_SQL" "recorded;Ana:client:11111111:1.7.4:android"
val "R2 the next open of the same install updates it, and keeps when it was first seen" \
  "$(as $ANA "$(report client $DEV 1.7.5 android)")
   SELECT app_version, last_opened_at > first_opened_at FROM public.app_opens WHERE user_id = '$ANA' AND app = 'client'" \
  "updated;1.7.5|t"
val "R3 the driver app on the same phone is its own row; another account is its own row" \
  "$(as $ANA "$(report driver $DEV 1.7.5 android)") $(as $BETO "$(report client $DEV 1.7.3 ios)") $ROWS" \
  "recorded;recorded;Ana:client:11111111:1.7.5:android,Ana:driver:11111111:1.7.5:android,Beto:client:11111111:1.7.3:ios"
val "R4 a version or platform that is too long is cut to 32; an empty one is stored as null" \
  "$(as $ANA "$(report client $DEV "$(printf 'v%.0s' $(seq 40))" '')")
   SELECT length(app_version), platform IS NULL FROM public.app_opens WHERE user_id = '$ANA' AND app = 'client'" \
  "updated;32|t"
val "R5 an unknown app, an empty install id or one over 128 characters is refused and records nothing" \
  "$R5_SQL" "invalid;invalid;invalid;3"
err "R6 the publishable key alone cannot call it" \
  "BEGIN; SET LOCAL ROLE anon; $(report client $DEV 1.7.4 android) ROLLBACK;" "42501"
err "R7 the service role with no user is refused" "$R7_SQL" "42501"
err "R8 a signed-in user cannot read app_opens directly" \
  "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated; SELECT count(*) FROM public.app_opens; ROLLBACK;" "42501"
err "R9 nor write it directly" \
  "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated; INSERT INTO public.app_opens (user_id, app, device_id) VALUES ('$ANA', 'client', 'x'); ROLLBACK;" "42501"
val "R10 an account keeps 20 installs per app: the 21st is not recorded, known ones still update, the other app has its own count" \
  "$R9_SQL" "20;capped;updated;recorded;20;1.7.5"
val "R11 deleting the account deletes its rows" \
  "BEGIN; DELETE FROM public.users WHERE id = '$BETO'; SELECT count(*) FROM public.app_opens WHERE user_id = '$BETO'; ROLLBACK;" "0"
if [ "$MIG" = none ]; then
  echo "(R1-R11 use app_opens and report_app_open, which do not exist before 00622: they fail on the baseline)"
fi

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
check = s[s.index('DO $check$'):s.index('$check$;') + len('$check$;')]
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('no_cap', ("""  IF (SELECT count(*) FROM public.app_opens WHERE user_id = v_uid AND app = p_app) >= 20 THEN
    RETURN 'capped';
  END IF;
""", ""))
variant('no_uid_check', ("""  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'report_app_open needs a signed-in user';
  END IF;
""", ""))
variant('no_app_check', ("  IF p_app IS NULL OR p_app NOT IN ('client', 'driver')\n     OR p_device_id", "  IF p_device_id"))
variant('no_revoke', ("REVOKE ALL ON public.app_opens FROM anon, authenticated;\n", ""))
variant('no_service_grant', ("GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_opens TO service_role;\n", ""))
variant('no_fn_revoke', ("REVOKE ALL ON FUNCTION public.report_app_open(text, text, text, text) FROM PUBLIC, anon;\n", ""))
PYEOF
  proof(){ local r; fresh ${DB}g "${5:-prod}"; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  refuses(){ local r; fresh ${DB}g "$4"; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  proof "N1 without the cap, a 21st install is recorded (so R10 tests it)" \
    "$T/no_cap.sql" "$R9_SQL" "20;recorded;updated;recorded;21;1.7.5"
  r=$(fresh ${DB}g prod; apply_err ${DB}g "$T/no_uid_check.sql"; run ${DB}g "$R7_SQL")
  echo "$r" | grep -q "23502" && ok "N2 without the signed-in check, the service role reaches the insert (so R7 tests it)" \
    || ko "N2 without the signed-in check, the service role reaches the insert (so R7 tests it)" "got [$r]"
  r=$(fresh ${DB}g prod; apply_err ${DB}g "$T/no_app_check.sql"; run ${DB}g "$(as $ANA "$(report admin $DEV 1.7.4 android)")")
  echo "$r" | grep -q "23514" && ok "N3 without the app check, an unknown app reaches the table's CHECK (so R5 tests it)" \
    || ko "N3 without the app check, an unknown app reaches the table's CHECK (so R5 tests it)" "got [$r]"
  refuses "N4 the migration refuses to finish if the API roles keep prod's default access" \
    "$T/no_revoke.sql" "00622: the API roles must have no access to app_opens" prod
  refuses "N5 the migration refuses to finish if service_role cannot write (after 2026-10-30)" \
    "$T/no_service_grant.sql" "00622: service_role must be able to write app_opens" strict
  refuses "N6 the migration refuses to finish if anon can call the function" \
    "$T/no_fn_revoke.sql" "00622: report_app_open must be callable by signed-in users only" prod
  fresh ${DB}g prod
  run ${DB}g "$AS_OWNER; CREATE FUNCTION public.report_app_open(p_app text, p_device_id text, p_app_version text, p_platform text)
    RETURNS text LANGUAGE plpgsql AS \$f\$ BEGIN RETURN 'other'; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00622: unexpected body of report_app_open" \
    && ok "N7 a function body it does not know is not replaced" || ko "N7 a function body it does not know is not replaced" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
