#!/usr/bin/env bash
# Rehearsal runner for migration 00605 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00605/run.sh none
#       -> scaffold + tests (RED: an account without its public.users row inserts
#          one as super_admin through the users_insert_own policy)
#   supabase/tests/00605/run.sh supabase/migrations/00605_users_no_client_insert.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00605/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr605
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

SEED="$(cat "$DIR/seed.sql")"
ALICE=a0000000-0000-4000-8000-000000000001   # customer, confirmed +5355550001
BOB=a0000000-0000-4000-8000-000000000002     # approved driver, confirmed +5355550002
CAROL=a0000000-0000-4000-8000-000000000003   # admin
OLGA=a0000000-0000-4000-8000-000000000008    # auth.users account whose public.users row is gone
NINA=a0000000-0000-4000-8000-000000000009    # signs up during a test
DENIED="42501:permission denied for table users"   # the grant layer refusing
# try ROLE UID SQL -> runs SQL as that role with JWT subject UID (as PostgREST would) and prints 'ok',
#                     or 'SQLSTATE:message' of the error; everything it wrote is rolled back on error
try(){ printf "CREATE TEMP TABLE IF NOT EXISTS r (v text); GRANT ALL ON r TO anon, authenticated, supabase_auth_admin;
  SET request.jwt.claim.sub = '%s'; SET ROLE %s;
  DO \$t\$ BEGIN BEGIN %s INSERT INTO r VALUES ('ok'); EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES (SQLSTATE || ':' || SQLERRM); END; END \$t\$;
  RESET ROLE; RESET request.jwt.claim.sub; SELECT string_agg(v, ',') FROM r; TRUNCATE r;" "$2" "$1" "$3"; }
# as UID SQL -> SQL run as that signed-in account, then back to the test role
as(){ printf "SET request.jwt.claim.sub = '%s'; SET ROLE authenticated; %s RESET ROLE; RESET request.jwt.claim.sub;" "$1" "$2"; }
# SIGNUP -> what GoTrue does for a new account: INSERT into auth.users as supabase_auth_admin
SIGNUP="INSERT INTO auth.users (id, email, phone, phone_confirmed_at, raw_user_meta_data) VALUES ('$NINA', 'phone_5355550009@tricigo.app', '5355550009', now(), '{\"full_name\": \"Nina\"}');"
ROWS="SELECT md5(coalesce((SELECT string_agg(u::text, ',' ORDER BY u.id) FROM public.users u), '')
          || coalesce((SELECT string_agg(a::text, ',' ORDER BY a.id) FROM auth.users a), '')
          || coalesce((SELECT string_agg(w::text, ',' ORDER BY w.id) FROM public.wallet_accounts w), '')
          || coalesce((SELECT string_agg(d::text, ',' ORDER BY d.id) FROM public.driver_profiles d), '')
          || coalesce((SELECT string_agg(l::text, ',' ORDER BY l.id) FROM public.rpc_attempt_log l), ''))"
# fresh DBNAME [SETUP] -> a new database with the scaffold and the accounts, plus optional setup SQL
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SEED ${2:-}" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('handle_new_user', 'ensure_tricicoin_wallet_for_driver',
         'tg_users_protect_admin_fields', 'tg_users_normalize_phone', 'is_admin', 'is_super_admin', 'current_user_role')" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,ensure_tricicoin_wallet_for_driver:13634635d7764a3bb48ba863cf387376/240,handle_new_user:c42fa89f6155a50a1cc4198255dd9d77/299,is_admin:22cb75e91980d512498034cd33e1eda2/285,is_super_admin:5655a4615e92e8b1e323d06c7566b058/105,tg_users_normalize_phone:c0491b42cf36767c3911fb8a3fda9f04/147,tg_users_protect_admin_fields:377912e83023297eda4761622a113364/2995"
val "S1 like prod, a non-superuser owns public.users and handle_new_user, and RLS is on but not forced" \
  "SELECT pg_get_userbyid(c.relowner) || '|' || r.rolsuper || '|' || (p.proowner = c.relowner) || '|' || p.prosecdef || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity
   FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner, pg_proc p
   WHERE c.oid = 'public.users'::regclass AND p.oid = 'public.handle_new_user()'::regprocedure" \
  "tricigo_owner|false|true|true|true|false"

if [ "$MIG" != "none" ]; then
  # A fresh environment (local stack, branch) has no accounts: the migration must apply there too.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
  $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
  if out=$($BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" 2>&1); then
    if echo "$out" | grep -q "probe not run"; then ko "M0 on a database with no accounts the migration applies, probe included" "the INSERT probe did not run"
    else ok "M0 on a database with no accounts the migration applies, probe included"; fi
  else ko "M0 on a database with no accounts the migration applies, probe included" "$(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; fi
  BEFORE=$($P -c "$ROWS" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration's self-test leaves every row exactly as it was" "$ROWS" "$BEFORE"
  # Same session before and after the file, as in `supabase db push` or MCP's pooled connection.
  r=$($P -c "SET lock_timeout = '0'" -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" 2>/dev/null | tr -d '\r' | tail -1)
  if [ "$r" = "0" ]; then ok "M2 the lock timeout the migration sets does not outlive it"
  else ko "M2 the lock timeout the migration sets does not outlive it" "expected [0], got [$r]"; fi
fi

echo "== tests =="
# I. no client can insert a users row any more: the grant refuses before RLS is even consulted
val "I1 an account without its users row cannot insert one as super_admin" \
  "$SEED $(try authenticated $OLGA "INSERT INTO public.users (id, full_name, role, level) VALUES ('$OLGA', 'Olga', 'super_admin', 'diamante');")
   SELECT count(*) FROM public.users WHERE id = '$OLGA';" "$DENIED;0"
val "I2 ...nor as a driver, so no TriciCoin wallet appears either" \
  "$SEED $(try authenticated $OLGA "INSERT INTO public.users (id, full_name, role) VALUES ('$OLGA', 'Olga', 'driver');")
   SELECT count(*) FROM public.users WHERE id = '$OLGA'; SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$OLGA';" "$DENIED;0;0"
val "I3 ...nor a plain row with only its id" \
  "$SEED $(try authenticated $OLGA "INSERT INTO public.users (id) VALUES ('$OLGA');") SELECT count(*) FROM public.users WHERE id = '$OLGA';" "$DENIED;0"
val "I4 an upsert on an existing row is refused too (INSERT ... ON CONFLICT needs INSERT)" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.users (id, full_name) VALUES ('$ALICE', 'Alice U') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;")
   SELECT full_name FROM public.users WHERE id = '$ALICE';" "$DENIED;Alice"
val "I5 a row for someone else's id is refused by the grant, not only by RLS" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.users (id, full_name) VALUES ('$OLGA', 'Olga');") SELECT count(*) FROM public.users WHERE id = '$OLGA';" "$DENIED;0"
val "I6 anon is refused by the grant too" \
  "$SEED $(try anon '' "INSERT INTO public.users (id, full_name) VALUES ('$OLGA', 'Olga');") SELECT count(*) FROM public.users WHERE id = '$OLGA';" "$DENIED;0"

# R. what keeps working
val "R1 GoTrue sign-up still creates the users row, as a customer with the copied phone" \
  "$SEED $(try supabase_auth_admin '' "$SIGNUP")
   SELECT role || '|' || phone || '|' || full_name || '|' || coalesce(email, '-') FROM public.users WHERE id = '$NINA';" "ok;customer|+5355550009|Nina|-"
val "R2 the service role can still recreate a missing row (operator repair)" \
  "$SEED SET ROLE service_role; INSERT INTO public.users (id, full_name, phone) VALUES ('$OLGA', 'Olga', '+5355550008'); RESET ROLE;
   SELECT role || '|' || full_name || '|' || phone FROM public.users WHERE id = '$OLGA';" "customer|Olga|+5355550008"
val "R3 an account still edits its own name, and still cannot change its role" \
  "$SEED $(as $ALICE "UPDATE public.users SET full_name = 'Alice P', role = 'admin' WHERE id = '$ALICE';")
   SELECT full_name || '|' || role FROM public.users WHERE id = '$ALICE';" "Alice P|customer"
val "R4 an account still reads its own row and nobody else's" \
  "$SEED $(as $ALICE "SELECT count(*) || '|' || count(*) FILTER (WHERE id = '$ALICE') FROM public.users;")" "1|1"
val "R5 an admin still reads every row" "$SEED $(as $CAROL "SELECT count(*) FROM public.users;")" "3"
# Canary: the scaffold owns things like prod, so the one change that would break every sign-up is visible here.
val "R6 canary: forcing RLS on users would break sign-up (never do it)" \
  "$SEED ALTER TABLE public.users FORCE ROW LEVEL SECURITY; $(try supabase_auth_admin '' "$SIGNUP") ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;" \
  "42501:new row violates row-level security policy for table \"users\""

# C. contract: only the INSERT path changes
val "C1 no policy lets anyone INSERT into public.users; the other three are untouched" \
  "SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users'" \
  "users_admin_select:SELECT,users_select_own:SELECT,users_update_own:UPDATE"
val "C2 anon and authenticated lost INSERT (table and every column) and nothing else" \
  "SELECT string_agg(r || ':' || has_any_column_privilege(r, 'public.users', 'INSERT') || '/' || has_table_privilege(r, 'public.users', 'SELECT')
                     || '/' || has_table_privilege(r, 'public.users', 'UPDATE') || '/' || has_table_privilege(r, 'public.users', 'DELETE')
                     || '/' || has_table_privilege(r, 'public.users', 'TRUNCATE') || '/' || has_table_privilege(r, 'public.users', 'REFERENCES')
                     || '/' || has_table_privilege(r, 'public.users', 'TRIGGER'), ',' ORDER BY r)
   FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r" \
  "anon:false/true/true/true/true/true/true,authenticated:false/true/true/true/true/true/true,service_role:true/true/true/true/true/true/true"
val "C3 RLS stays on and not forced" "SELECT relrowsecurity || '|' || relforcerowsecurity FROM pg_class WHERE oid = 'public.users'::regclass" "true|false"
val "C4 the sign-up trigger and its function are untouched" \
  "SELECT md5(prosrc) || '/' || length(prosrc) || '|' || (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_created')
   FROM pg_proc WHERE oid = 'public.handle_new_user()'::regprocedure" \
  "c42fa89f6155a50a1cc4198255dd9d77/299|CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()"

# N. negative proofs: a copy of the migration with a hole put back, or a database it must refuse; its self-test must abort
if [ "$MIG" != "none" ]; then
  WORK="$(mktemp -d)"
  # buggy NAME START END [START END ...] -> copy of the migration without each START..END span
  #                                         (an empty END removes exactly the line START)
  buggy(){
    local name="$1"; shift
    "$PY" - "$MIG" "$WORK/$name.sql" "$@" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
out, args = src, sys.argv[3:]
assert len(args) % 2 == 0
for start, end in zip(args[0::2], args[1::2]):
    if end == "":
        line = start + "\n"
        assert out.count(line) == 1, f"expected {line!r} once, found {out.count(line)}"
        out = out.replace(line, "")
    else:
        assert out.count(start) == 1 and out.count(end) == 1, (start, end)
        i, j = out.index(start), out.index(end)
        assert i < j
        out = out[:i] + out[j:]
assert out != src
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(out)
PYEOF
  }
  # expect_abort FILE TEST [SETUP] -> FILE must fail on a fresh database (plus SETUP), with the self-test's message
  expect_abort(){
    local db="${DB}n" out
    fresh $db "${3:-}"
    if out=$($BIN/psql $CONN -d $db -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$1" 2>&1); then
      ko "$2" "the migration succeeded"
    elif echo "$out" | grep -q "00605 self-test"; then
      ok "$2"
    else
      ko "$2" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
    fi
  }
  POLICY_LINE="DROP POLICY IF EXISTS users_insert_own ON public.users;"
  REVOKE_LINE="REVOKE INSERT ON public.users FROM anon, authenticated;"
  if buggy n1 "$REVOKE_LINE" ""; then expect_abort "$WORK/n1.sql" "N1 the self-test aborts a migration that leaves the INSERT grant"
  else ko "N1 the self-test aborts a migration that leaves the INSERT grant" "could not build the buggy copy"; fi
  if buggy n2 "$POLICY_LINE" ""; then expect_abort "$WORK/n2.sql" "N2 the self-test aborts a migration that leaves the INSERT policy"
  else ko "N2 the self-test aborts a migration that leaves the INSERT policy" "could not build the buggy copy"; fi
  # N3: neither layer and no static checks left, so only the INSERT probe can notice
  if buggy n3 "$POLICY_LINE" "" "$REVOKE_LINE" "" "  IF EXISTS (SELECT 1 FROM pg_policies" "  IF NOT has_table_privilege('service_role'"; then
    expect_abort "$WORK/n3.sql" "N3 the INSERT probe on its own aborts a migration that leaves both layers"
  else ko "N3 the INSERT probe on its own aborts a migration that leaves both layers" "could not build the buggy copy"; fi
  expect_abort "$MIG" "N4 the migration refuses a users table whose RLS is forced (sign-up would break)" \
    "ALTER TABLE public.users FORCE ROW LEVEL SECURITY;"
  rm -rf "$WORK"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
