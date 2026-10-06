#!/usr/bin/env bash
# Rehearsal runner for migration 00611 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00611/run.sh none
#       -> scaffold + tests (RED: a user can mark their own email verified, and a
#          verified flag survives a change of address)
#   supabase/tests/00611/run.sh supabase/migrations/00611_users_email_verification_is_server_only.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00611/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr611
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, address not verified
BETO=b0000000-0000-4000-8000-000000000002   # customer, address verified
CORA=c0000000-0000-4000-8000-000000000003   # admin
# as UID ROLE SQL -> SQL as that role with JWT subject UID (as PostgREST would), then
# prints the flag of every row as name:verified(t/f), rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s; %s RESET ROLE;
  SELECT string_agg(full_name || ':' || (email_verified_at IS NOT NULL)::text, ',' ORDER BY full_name) FROM public.users; ROLLBACK;" "$1" "$2" "$3"; }
# svc SQL -> SQL as service_role with no JWT (Edge Functions), same printout
svc(){ printf "BEGIN; SET LOCAL ROLE service_role; %s RESET ROLE;
  SELECT string_agg(full_name || ':' || (email_verified_at IS NOT NULL)::text, ',' ORDER BY full_name) FROM public.users; ROLLBACK;" "$1"; }
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 is_admin carries the live prod body (00592)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE proname = 'is_admin'" \
  "22cb75e91980d512498034cd33e1eda2/285"
val "S1 like prod, authenticated may UPDATE email and email_verified_at" \
  "SELECT has_column_privilege('authenticated','public.users','email','UPDATE')::text || '/' ||
          has_column_privilege('authenticated','public.users','email_verified_at','UPDATE')::text" "true/true"
val "S2 seed: only Beto is verified" \
  "SELECT string_agg(full_name || ':' || (email_verified_at IS NOT NULL)::text, ',' ORDER BY full_name) FROM public.users" \
  "Ana:false,Beto:true,Cora:false"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 exactly one trigger, BEFORE UPDATE OF email, email_verified_at" \
    "SELECT count(*) || '|' || string_agg(pg_get_triggerdef(oid), '') FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'trg_users_protect_email_verification'" \
    "1|CREATE TRIGGER trg_users_protect_email_verification BEFORE UPDATE OF email, email_verified_at ON public.users FOR EACH ROW EXECUTE FUNCTION tg_users_protect_email_verification()"
  val "M2 clients cannot call the trigger function" \
    "SELECT has_function_privilege('anon','public.tg_users_protect_email_verification()','EXECUTE')::text || '/' ||
            has_function_privilege('authenticated','public.tg_users_protect_email_verification()','EXECUTE')::text" "false/false"
  val "M3 lock_timeout does not outlive the file" "SHOW lock_timeout" "0"
fi

echo "== a signed-in user =="
val "V1 cannot mark their own address verified" \
  "$(as $ANA authenticated "UPDATE public.users SET email_verified_at = now() WHERE id = '$ANA';")" "Ana:false,Beto:true,Cora:false"
val "V2 loses the flag when they change their address" \
  "$(as $BETO authenticated "UPDATE public.users SET email = 'victim@example.com' WHERE id = '$BETO';")" "Ana:false,Beto:false,Cora:false"
val "V3 loses it even when they also try to keep it in the same update" \
  "$(as $BETO authenticated "UPDATE public.users SET email = 'victim@example.com', email_verified_at = now() WHERE id = '$BETO';")" "Ana:false,Beto:false,Cora:false"
val "V4 cannot clear their own flag either" \
  "$(as $BETO authenticated "UPDATE public.users SET email_verified_at = NULL WHERE id = '$BETO';")" "Ana:false,Beto:true,Cora:false"
val "V5 keeps the flag when editing anything else" \
  "$(as $BETO authenticated "UPDATE public.users SET full_name = 'Beto' WHERE id = '$BETO';")" "Ana:false,Beto:true,Cora:false"

echo "== the server and admins =="
val "K1 confirm-email (service key, no JWT) stamps the flag" \
  "$(svc "UPDATE public.users SET email_verified_at = now() WHERE id = '$ANA';")" "Ana:true,Beto:true,Cora:false"
val "K2 add-email-with-verification (service key) sets a new address and the flag goes" \
  "$(svc "UPDATE public.users SET email = 'nuevo@example.com', email_verified_at = NULL WHERE id = '$BETO';")" "Ana:false,Beto:false,Cora:false"
val "K3 an address written by the server also starts unverified (e.g. the auth sync trigger)" \
  "$(svc "UPDATE public.users SET email = 'otro@example.com' WHERE id = '$BETO';")" "Ana:false,Beto:false,Cora:false"
val "K4 an admin may set the flag" \
  "$(as $CORA authenticated "UPDATE public.users SET email_verified_at = now() WHERE id = '$CORA';")" "Ana:false,Beto:true,Cora:true"

if [ "$MIG" != "none" ]; then
  echo "== negative proof: the migration's own check catches a missing trigger =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T/g1.sql" <<'PYEOF'
import sys
src, dst = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
old = """CREATE TRIGGER trg_users_protect_email_verification
  BEFORE UPDATE OF email, email_verified_at ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.tg_users_protect_email_verification();"""
assert s.count(old) == 1
s2 = s.replace(old, ''); assert s2 != s
open(dst, 'w', encoding='utf-8').write(s2)
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "00611: trg_users_protect_email_verification is missing" && ok "G1 a migration that forgets the trigger aborts" || ko "G1 a migration that forgets the trigger aborts" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
