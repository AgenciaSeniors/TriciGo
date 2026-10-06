#!/usr/bin/env bash
# Rehearsal runner for migration 00604 (local Postgres 16 with pgcrypto, no Supabase stack needed).
#   supabase/tests/00604/run.sh none
#       -> scaffold + tests (RED: the seeded system accounts take their published passwords)
#   supabase/tests/00604/run.sh supabase/migrations/00604_neutralize_seeded_system_accounts.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00604/run.sh ...
set -u
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr604
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }

# The auth.users columns involved, the two accounts as 00007 and 00287 seed them, and a real account as a control.
SCAFFOLD="CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto SCHEMA extensions; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password varchar(255), banned_until timestamptz);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id));
INSERT INTO auth.users (id, email, encrypted_password) VALUES
  ('00000000-0000-0000-0000-000000000001', 'platform@tricigo.system', extensions.crypt('not-a-real-password', extensions.gen_salt('bf'))),
  ('00000000-0000-0000-0000-000000000099', 'anonymized@tricigo.internal', extensions.crypt('not-a-real-password-disabled-account', extensions.gen_salt('bf'))),
  ('11111111-1111-4111-8111-111111111111', 'real@example.com', extensions.crypt('keep-me', extensions.gen_salt('bf')));
INSERT INTO auth.sessions (user_id) VALUES ('00000000-0000-0000-0000-000000000001'), ('11111111-1111-4111-8111-111111111111');"
# STATE -> per account: does its known password still work | banned | sessions
STATE="SELECT string_agg(email || ':' || (encrypted_password = extensions.crypt(CASE email WHEN 'platform@tricigo.system' THEN 'not-a-real-password'
         WHEN 'anonymized@tricigo.internal' THEN 'not-a-real-password-disabled-account' ELSE 'keep-me' END, encrypted_password))
         || '|' || (banned_until IS NOT NULL) || '|' || (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id), ',' ORDER BY email)
       FROM auth.users u"
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1; $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SCAFFOLD" >/dev/null 2>&1; }
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== tests =="
r=$($P -c "$STATE" 2>&1 | tr -d '\r')
expected="anonymized@tricigo.internal:false|true|0,platform@tricigo.system:false|true|0,real@example.com:true|false|1"
if [ "$r" = "$expected" ]; then ok "T1 neither published password works, both system accounts are banned without sessions, the real account is untouched"
else ko "T1 neither published password works, both system accounts are banned without sessions, the real account is untouched" "expected [$expected], got [$r]"; fi

if [ "$MIG" != "none" ]; then
  # N1: a copy of the migration without its UPDATE must be aborted by the self-test.
  WORK="$(mktemp -d)"
  sed '/^UPDATE auth.users$/,/^WHERE id IN/d' "$MIG" > "$WORK/n1.sql"
  if grep -q "^UPDATE auth.users$" "$WORK/n1.sql" || cmp -s "$MIG" "$WORK/n1.sql"; then
    ko "N1 the self-test aborts a migration that leaves the published passwords" "could not build the buggy copy"
  else
    fresh ${DB}n1
    if out=$($BIN/psql $CONN -d ${DB}n1 -qAt -v ON_ERROR_STOP=1 -1 -c "SET search_path = ''" -f "$WORK/n1.sql" 2>&1); then
      ko "N1 the self-test aborts a migration that leaves the published passwords" "the migration succeeded"
    elif echo "$out" | grep -q "00604 self-test"; then ok "N1 the self-test aborts a migration that leaves the published passwords"
    else ko "N1 the self-test aborts a migration that leaves the published passwords" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; fi
  fi
  rm -rf "$WORK"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
