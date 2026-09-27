#!/usr/bin/env bash
# Rehearsal runner for migration 00601 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00601/run.sh none -> scaffold + tests (RED: register_corporate_account does not exist)
#   supabase/tests/00601/run.sh supabase/migrations/00601_register_corporate_account.sql
#                                    -> scaffold + migration x2 (idempotency) + tests (GREEN)
# Cluster setup (sandbox/CI): same as supabase/tests/00591/run.sh, i.e.
#   useradd -m pgtest; su pgtest -c "/usr/lib/postgresql/16/bin/initdb -D ~/pgdata -U pgtest --auth=trust"
#   su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D ~/pgdata -o '-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/home/pgtest' -l ~/pg.log start"
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
P="$BIN/psql $CONN -d pr601 -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q NAME SQL            -> SQL must return the single value 't'
q(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\n'); if [ "$r" = "t" ]; then ok "$1"; else ko "$1" "got [$r]"; fi; }
# expect_ok NAME SQL    -> statement(s) must succeed
expect_ok(){ local r; if r=$($P -c "$2" 2>&1); then ok "$1"; else ko "$1" "$(echo "$r" | head -2 | tr '\n' ' ')"; fi; }
# expect_err NAME SQL PATTERN -> statement must fail with an error matching PATTERN
expect_err(){ local r; if r=$($P -c "$2" 2>&1); then ko "$1" "expected error, succeeded with [$r]"; elif echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "wrong error: $(echo "$r" | head -2 | tr '\n' ' ')"; fi; }

# as_user UUID SQL -> what a PostgREST request from that signed-in user runs
as_user(){ printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
as_anon(){ printf "SET ROLE anon; %s" "$1"; }

ALICE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'   # customer
BOB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'     # customer
CAROL='cccccccc-cccc-4ccc-8ccc-cccccccccccc'   # admin
DAVE='dddddddd-dddd-4ddd-8ddd-dddddddddddd'    # driver (fleet request)
DAVE_ACC='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
FN="public.register_corporate_account(uuid,text,text,text,text)"
ALICE_ACC="(SELECT id FROM corporate_accounts WHERE created_by = '$ALICE' ORDER BY created_at, id LIMIT 1)"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr601" -c "CREATE DATABASE pr601" >/dev/null || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  # Under an EMPTY search_path, the strictest environment a migration runner can use.
  echo "== apply migration (1st, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== tests =="
# --- P. privileges ---
q "P1 anon cannot execute register_corporate_account" "SELECT NOT has_function_privilege('anon', '$FN', 'EXECUTE')"
q "P2 authenticated can execute it"                    "SELECT has_function_privilege('authenticated', '$FN', 'EXECUTE')"
q "P3 it is SECURITY DEFINER"                          "SELECT prosecdef FROM pg_proc WHERE oid = '$FN'::regprocedure"
expect_err "P4 anon calling it is denied" "$(as_anon "SELECT register_corporate_account('$ALICE', 'Acme', '+5351111111')")" "permission denied"

# --- R. a non-admin registers ---
q "R1 Alice registers and gets her account back" "$(as_user $ALICE "SELECT (register_corporate_account('$ALICE', 'Acme', '+5351111111')->>'created_by') = '$ALICE'")"
q "R2 one pending account, admin-only fields reset by the INSERT trigger" \
  "SELECT count(*) = 1 AND bool_and(status = 'pending' AND NOT is_fleet_owner AND commission_percent IS NULL AND current_month_spent = 0) FROM corporate_accounts WHERE created_by = '$ALICE'"
q "R3 Alice is its active admin" \
  "SELECT count(*) = 1 FROM corporate_employees WHERE corporate_account_id = $ALICE_ACC AND user_id = '$ALICE' AND role = 'admin' AND is_active AND added_by = '$ALICE'"
q "R4 Alice has one corporate_cash wallet, anchored at 0" \
  "SELECT count(*) = 1 AND bool_and(balance = 0 AND anchor_usd_cents = 0) FROM wallet_accounts WHERE user_id = '$ALICE' AND account_type = 'corporate_cash'"
q "R5 Alice can manage it (is_corp_admin)" "$(as_user $ALICE "SELECT is_corp_admin($ALICE_ACC)")"
q "R6 Alice sees it through her own RLS" "$(as_user $ALICE "SELECT count(*) = 1 FROM corporate_accounts")"
expect_err "R7 Alice cannot register an account for Bob"  "$(as_user $ALICE "SELECT register_corporate_account('$BOB', 'Bob SA', '+5352222222')")" "session_mismatch"
expect_err "R8 an admin cannot register one for Bob either" "$(as_user $CAROL "SELECT register_corporate_account('$BOB', 'Bob SA', '+5352222222')")" "session_mismatch"
expect_err "R9 no JWT (service or cron context) is refused" "SELECT register_corporate_account('$BOB', 'Bob SA', '+5352222222')" "session_mismatch"
q "R10 nothing was created for Bob" \
  "SELECT NOT EXISTS (SELECT 1 FROM corporate_accounts WHERE created_by = '$BOB') AND NOT EXISTS (SELECT 1 FROM wallet_accounts WHERE user_id = '$BOB')"
expect_ok "R11 an admin registers an account for herself" "$(as_user $CAROL "SELECT register_corporate_account('$CAROL', 'Carol Corp', '+5355555555')")"

# --- A. atomicity: the last step fails, so nothing of the call may remain ---
# The sabotage is a CHECK that only rejects Bob's corporate wallet. It commits
# with the call if the function ever swallows the wallet error, so it must not
# be able to break the tests that follow.
expect_err "A1 a failing wallet step fails the whole call" "BEGIN;
ALTER TABLE public.wallet_accounts ADD CONSTRAINT zz_no_corporate_wallet_for_bob
  CHECK (user_id IS DISTINCT FROM '$BOB' OR account_type <> 'corporate_cash') NOT VALID;
$(as_user $BOB "SELECT register_corporate_account('$BOB', 'Bob SA', '+5353333333');")
COMMIT;" "zz_no_corporate_wallet_for_bob"
q "A2 ...and left no account, admin row or wallet for Bob" \
  "SELECT NOT EXISTS (SELECT 1 FROM corporate_accounts WHERE created_by = '$BOB') AND NOT EXISTS (SELECT 1 FROM corporate_employees WHERE user_id = '$BOB') AND NOT EXISTS (SELECT 1 FROM wallet_accounts WHERE user_id = '$BOB')"
q "A3 ...and the sabotage rolled back with it" \
  "SELECT NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'zz_no_corporate_wallet_for_bob')"

# --- S. a second account of the same creator ---
expect_ok "S1 Alice registers a second account" "$(as_user $ALICE "SELECT register_corporate_account('$ALICE', 'Acme Norte', '+5351111112')")"
q "S2 two accounts, Alice admin of both" \
  "SELECT (SELECT count(*) FROM corporate_accounts WHERE created_by = '$ALICE') = 2
      AND (SELECT count(*) FROM corporate_employees e JOIN corporate_accounts a ON a.id = e.corporate_account_id
            WHERE a.created_by = '$ALICE' AND e.user_id = '$ALICE' AND e.role = 'admin') = 2"
q "S3 still ONE corporate_cash wallet: the server keys it by user, not by account" \
  "SELECT count(*) = 1 FROM wallet_accounts WHERE user_id = '$ALICE' AND account_type = 'corporate_cash'"

# --- F. the client-side steps registerAccount runs while 00601 is missing ---
expect_ok  "F1 step 1: Dave creates his own corporate_cash wallet" "$(as_user $DAVE "SELECT ensure_wallet_account('$DAVE', 'corporate_cash')")"
expect_ok  "F2 step 2: Dave inserts the account and reads it back" "$(as_user $DAVE "INSERT INTO corporate_accounts (id, name, contact_phone, created_by) VALUES ('$DAVE_ACC', 'Flota Dave', '+5354444444', '$DAVE') RETURNING id")"
expect_ok  "F3 step 3: Dave adds himself as its admin" "$(as_user $DAVE "INSERT INTO corporate_employees (corporate_account_id, user_id, role, added_by) VALUES ('$DAVE_ACC', '$DAVE', 'admin', '$DAVE')")"
expect_err "F4 the old key, the account id, is refused" "$(as_user $DAVE "SELECT ensure_wallet_account('$DAVE_ACC', 'corporate_cash')")" "forbidden"

# --- G. the migration's own checks, seen failing: each mutant must abort it ---
# mutant NAME SED_EXPR EXPECTED_ERROR -> the migration edited by SED_EXPR must fail with EXPECTED_ERROR
mutant(){
  local db=pr601g mig out
  mig=$(mktemp); sed "$2" "$MIG" > "$mig"
  if cmp -s "$mig" "$MIG"; then ko "$1" "the edit did not change the migration"; rm -f "$mig"; return; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null 2>&1
  $BIN/psql $CONN -d $db -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null
  if out=$($BIN/psql $CONN -d $db -qAt -v ON_ERROR_STOP=1 -c "SET search_path = ''" -f "$mig" 2>&1); then
    ko "$1" "the migration succeeded"
  elif echo "$out" | grep -q "$3"; then
    ok "$1"
  else
    ko "$1" "wrong error: $(echo "$out" | grep ERROR | head -1)"
  fi
  rm -f "$mig"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $db" >/dev/null 2>&1
}
if [ "$MIG" != "none" ]; then
  mutant "G1 without the REVOKE, anon keeps EXECUTE and the migration aborts" \
    '/^REVOKE ALL ON FUNCTION public.register_corporate_account/d' "anon can execute register_corporate_account"
  mutant "G2 without SECURITY DEFINER the migration aborts" \
    '/^SECURITY DEFINER$/d' "must be SECURITY DEFINER"
  mutant "G3 without the GRANT, authenticated loses EXECUTE and the migration aborts" \
    '/^GRANT EXECUTE ON FUNCTION public.register_corporate_account/d' "authenticated cannot execute register_corporate_account"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
