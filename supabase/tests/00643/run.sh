#!/usr/bin/env bash
# Rehearsal runner for migration 00643 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00643/run.sh none
#       -> scaffold + seed + tests without the migration (RED: get_my_email_status does not exist)
#   supabase/tests/00643/run.sh supabase/migrations/00643_my_email_status.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-check (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00643/run.sh ...
set -u
unset MSYS_NO_PATHCONV
export PGOPTIONS='-c lc_messages=C'
export PGCLIENTENCODING=UTF8
export LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr640
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run $DB "$2"); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $r"; fi; }

UNC=c0000000-0000-4000-8000-000000000001
FLAG=c0000000-0000-4000-8000-000000000002
GOOG=c0000000-0000-4000-8000-000000000003
PHONE=c0000000-0000-4000-8000-000000000004
NOMAIL=c0000000-0000-4000-8000-000000000005
SPACE=c0000000-0000-4000-8000-000000000006
GNV=c0000000-0000-4000-8000-000000000007
BLANK=c0000000-0000-4000-8000-000000000008
GHOST=c0000000-0000-4000-8000-0000000000ff   # a session whose account has no users row

# me UID -> the caller's row, as PostgREST runs it for a signed-in user
me(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;
  SELECT coalesce(s.email, '') || '|' || s.status || '|' || coalesce(to_char(s.link_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), '')
  FROM public.get_my_email_status() s; ROLLBACK;" "$1"; }

fresh(){ "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-}" = seed ]; then "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || return 1; fi; }
apply(){ local out rc; out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose ${3:-} -c "$AS_OWNER" -f "$2" 2>&1); rc=$?
         echo "$out" | tr -d '\r'; [ $rc -eq 0 ] && echo applied || echo failed; }
apply_err(){ local r; r=$(apply "$1" "$2" -1); if [ "$(echo "$r" | tail -1)" = applied ]; then echo applied; else echo "$r" | grep -m1 ERROR; fi; }
# no_fn_defaults DB -> drop the scaffold's default EXECUTE for the API roles (functions then get only PUBLIC's)
no_fn_defaults(){ run "$1" "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated, service_role" >/dev/null; }
FN="SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE proname = 'get_my_email_status' AND pronamespace = 'public'::regnamespace"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== reset database =="
fresh $DB seed || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod helpers (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('mailable_user_emails', '_user_mailable_email')" \
  "_user_mailable_email:99a0551a2ad5dd6fbf65619c81842e83/72,mailable_user_emails:58def9245ceb43b710a57ef01c450572/479"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  r=$(apply $DB "$MIG" -1); [ "$(echo "$r" | tail -1)" = applied ] || { echo "$r"; echo "migration failed"; exit 1; }
  b1=$(run $DB "$FN")
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  r2=$(apply $DB "$MIG"); [ "$(echo "$r2" | tail -1)" = applied ] || { echo "$r2"; echo "migration NOT idempotent"; exit 1; }
  b2=$(run $DB "$FN")
  [ -n "$b1" ] && [ "$b1" = "$b2" ] && ok "M2 the 2nd apply leaves the body as it was ($b1)" || ko "M2 the 2nd apply leaves the body as it was" "[$b1] vs [$b2]"
  val "M1 STABLE SECURITY DEFINER sql, owner postgres, search_path pg_catalog, public; EXECUTE anon=f authenticated=t service_role=t PUBLIC=f" \
    "SELECT p.provolatile::text || '|' || p.prosecdef || '|' || l.lanname || '|' || pg_get_userbyid(p.proowner) || '|' || array_to_string(p.proconfig, ',')
       || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
       || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')
       || '|' || EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)
     FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.get_my_email_status()'::regprocedure" \
    "s|true|sql|postgres|search_path=pg_catalog, public|false|true|true|false"
fi

echo "== get_my_email_status: who may call it =="
has "E1 anon cannot execute it" \
  "BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.get_my_email_status(); ROLLBACK;" \
  "42501: permission denied for function get_my_email_status"
val "E2 a session with no subject, or with an account that has no users row, gets no row" \
  "BEGIN; SET LOCAL ROLE authenticated; SELECT count(*) FROM public.get_my_email_status();
   SET LOCAL request.jwt.claim.sub = '$GHOST'; SELECT count(*) FROM public.get_my_email_status(); ROLLBACK;" "0;0"

echo "== get_my_email_status: what it says =="
val "E3 UNC: unconfirmed, link = newest valid token for its own address (used, expired, other address and another account's token ignored)" \
  "$(me $UNC)" "unc@x.test|unconfirmed|2026-01-01 11:00"
val "E4 FLAG: proven by email_verified_at, no link pending" "$(me $FLAG)" "flag@x.test|proven|"
val "E5 GOOG: proven by a verified Google identity with the same address (other case)" "$(me $GOOG)" "goog@x.test|proven|"
val "E6 PHONE: the phone-OTP placeholder is no address" "$(me $PHONE)" "|none|"
val "E7 NOMAIL and BLANK: no address" "$(me $NOMAIL) $(me $BLANK)" "|none|;|none|"
val "E8 SPACE: address trimmed, capitals kept; the lowercased token still counts" "$(me $SPACE)" "Spaced@X.test|unconfirmed|2026-01-01 09:00"
val "E9 GNV: a Google identity that Google did not verify proves nothing" "$(me $GNV)" "gnv@x.test|unconfirmed|"
val "E10 a caller gets exactly one row, its own" \
  "BEGIN; SET LOCAL request.jwt.claim.sub = '$UNC'; SET LOCAL ROLE authenticated;
   SELECT count(*) || '|' || string_agg(email, ',') FROM public.get_my_email_status(); ROLLBACK;" "1|unc@x.test"
val "E11 the caller still cannot read the tokens table or ask about another account's address" \
  "BEGIN; SET LOCAL request.jwt.claim.sub = '$UNC'; SET LOCAL ROLE authenticated;
   SELECT has_table_privilege('authenticated', 'public.email_verification_tokens', 'SELECT')
     || '|' || has_function_privilege('authenticated', 'public.mailable_user_emails(uuid[])', 'EXECUTE'); ROLLBACK;" "false|false"

if [ "$MIG" != "none" ]; then
  echo "== without default EXECUTE for the API roles (functions get only PUBLIC's) =="
  fresh ${DB}n seed; no_fn_defaults ${DB}n
  r=$(apply_err ${DB}n "$MIG")
  v=$(run ${DB}n "SELECT has_function_privilege('anon', 'public.get_my_email_status()', 'EXECUTE') || '|'
     || has_function_privilege('authenticated', 'public.get_my_email_status()', 'EXECUTE') || '|'
     || has_function_privilege('service_role', 'public.get_my_email_status()', 'EXECUTE')")
  [ "$r" = applied ] && [ "$v" = "false|true|true" ] \
    && ok "M3 without default privileges the grants still come out right (anon f, authenticated t, service_role t)" \
    || ko "M3 without default privileges the grants still come out right" "$r / $v"

  echo "== negative proofs of the migration's self-check =="
  # N1: the REVOKE forgets anon -> the scaffold's default privileges leave anon with EXECUTE -> abort.
  "$PY" - "$MIG" "$T/n1.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
old = 'REVOKE ALL ON FUNCTION public.get_my_email_status() FROM PUBLIC, anon;'
assert s.count(old) == 1, 'N1 anchor not found'
s2 = s.replace(old, 'REVOKE ALL ON FUNCTION public.get_my_email_status() FROM PUBLIC;')
assert s2 != s
open(sys.argv[2], 'w', encoding='utf-8').write(s2)
PYEOF
  fresh ${DB}n seed; r=$(apply_err ${DB}n "$T/n1.sql")
  echo "$r" | grep -qF "00643: anon can execute public.get_my_email_status()" \
    && ok "N1 a REVOKE that misses anon aborts the migration" || ko "N1 a REVOKE that misses anon aborts the migration" "$r"
  # N2: the GRANT forgets authenticated, on a base without default EXECUTE -> abort.
  "$PY" - "$MIG" "$T/n2.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
old = 'GRANT EXECUTE ON FUNCTION public.get_my_email_status() TO authenticated, service_role;'
assert s.count(old) == 1, 'N2 anchor not found'
s2 = s.replace(old, 'GRANT EXECUTE ON FUNCTION public.get_my_email_status() TO service_role;')
assert s2 != s
open(sys.argv[2], 'w', encoding='utf-8').write(s2)
PYEOF
  fresh ${DB}n seed; no_fn_defaults ${DB}n; r=$(apply_err ${DB}n "$T/n2.sql")
  echo "$r" | grep -qF "00643: authenticated cannot execute public.get_my_email_status()" \
    && ok "N2 a GRANT that misses authenticated aborts the migration" || ko "N2 a GRANT that misses authenticated aborts the migration" "$r"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
