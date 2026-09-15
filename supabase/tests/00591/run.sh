#!/usr/bin/env bash
# Rehearsal runner for migration 00591 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00591/run.sh none                                   -> scaffold + tests (RED: the vulnerabilities are live)
#   supabase/tests/00591/run.sh supabase/migrations/00591_lock_ungated_money_rpcs_and_wallet_helper.sql
#                                                                      -> scaffold + migration x2 (idempotency) + tests (GREEN)
# Cluster setup (sandbox/CI): see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod":
#   useradd -m pgtest; su pgtest -c "/usr/lib/postgresql/16/bin/initdb -D ~/pgdata -U pgtest --auth=trust"
#   su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D ~/pgdata -o '-p 5433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/home/pgtest' -l ~/pg.log start"
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
P="$BIN/psql $CONN -d pr1 -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q NAME SQL            -> SQL must return the single value 't'
q(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\n'); if [ "$r" = "t" ]; then ok "$1"; else ko "$1" "got [$r]"; fi; }
# expect_ok NAME SQL    -> statement(s) must succeed
expect_ok(){ local r; if r=$($P -c "$2" 2>&1); then ok "$1"; else ko "$1" "$(echo "$r" | head -2 | tr '\n' ' ')"; fi; }
# expect_err NAME SQL PATTERN -> statement must fail with an error matching PATTERN
expect_err(){ local r; if r=$($P -c "$2" 2>&1); then ko "$1" "expected error, succeeded with [$r]"; elif echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "wrong error: $(echo "$r" | head -1)"; fi; }

# as_user UUID SQL -> the SQL a PostgREST RPC call would run for that authenticated user (top-level, single transaction)
as_user(){ printf "SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '%s', true); %s" "$1" "$2"; }
as_anon(){ printf "SET ROLE anon; %s" "$1"; }

PLATFORM='00000000-0000-0000-0000-000000000001'
ALICE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
BOB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
CAROL='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
MALLORY='dddddddd-dddd-4ddd-8ddd-dddddddddddd'

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr1" -c "CREATE DATABASE pr1" >/dev/null || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  # 1st pass under an EMPTY search_path: the strictest environment a migration runner can use. Any
  # unqualified type/function name in the migration would make a to_regprocedure() guard return NULL
  # and silently SKIP that lock instead of failing loudly.
  echo "== apply migration (1st, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== tests =="
# --- A. privileges: the 00531 nine + check_rate_limit ---
for fn in 'refund_rate_limit(text,integer)' 'revalue_anchored_wallets()' 'recompute_cup_from_usd_prices()' 'get_ride_with_coords(uuid)' 'notify_offline_drivers_for_searching_rides()' 'check_fraud_signals(uuid)' 'get_driver_weekly_summary(uuid)' 'recalc_ride_estimate_with_waypoints(uuid)' 'auto_offline_stale_drivers()' 'check_rate_limit(text,integer,integer)'; do
  q "A1 anon cannot execute $fn"          "SELECT NOT has_function_privilege('anon', 'public.$fn', 'EXECUTE')"
  q "A2 authenticated cannot execute $fn" "SELECT NOT has_function_privilege('authenticated', 'public.$fn', 'EXECUTE')"
  q "A3 service_role can execute $fn"     "SELECT has_function_privilege('service_role', 'public.$fn', 'EXECUTE')"
done
expect_err "A4 anon calling refund_rate_limit is denied" "$(as_anon "SELECT refund_rate_limit('send-sms-otp:phone:+5355555555', 60)")" "permission denied"
expect_err "A5 authenticated calling check_rate_limit is denied" "$(as_user $MALLORY "SELECT * FROM check_rate_limit('verify-otp:phone:+5355555555', 10, 600)")" "permission denied"

# --- B. send_gift: anon out, authenticated stays ---
q "B1 anon cannot execute send_gift(6-arg)" "SELECT NOT has_function_privilege('anon', 'public.send_gift(uuid,uuid,integer,text,wallet_account_type,text)', 'EXECUTE')"
q "B2 authenticated can still execute send_gift" "SELECT has_function_privilege('authenticated', 'public.send_gift(uuid,uuid,integer,text,wallet_account_type,text)', 'EXECUTE')"

# --- C. ensure_wallet_account: apps keep working, abuse closed ---
q "C1 authenticated keeps EXECUTE on ensure_wallet_account" "SELECT has_function_privilege('authenticated', 'public.ensure_wallet_account(uuid,wallet_account_type)', 'EXECUTE')"
expect_ok  "C2 direct call: own customer_cash (rider wallet screen)"      "$(as_user $ALICE "SELECT ensure_wallet_account('$ALICE', 'customer_cash')")"
expect_ok  "C3 direct call: own tricicoin (driver app)"                    "$(as_user $BOB "SELECT ensure_wallet_account('$BOB', 'tricicoin')")"
expect_ok  "C4 direct call: own corporate_cash (corporate creator)"        "$(as_user $ALICE "SELECT ensure_wallet_account('$ALICE', 'corporate_cash')")"
expect_ok  "C5 direct call: own customer_cash again is idempotent"         "$(as_user $ALICE "SELECT ensure_wallet_account('$ALICE', 'customer_cash')")"
expect_err "C6 direct call for ANOTHER user is denied"                     "$(as_user $MALLORY "SELECT ensure_wallet_account('$ALICE', 'tricicoin')")" "42501\|forbidden\|permission denied"
expect_err "C7 direct call creating own platform_fx_reserve is denied"     "$(as_user $MALLORY "SELECT ensure_wallet_account('$MALLORY', 'platform_fx_reserve')")" "42501\|forbidden\|permission denied"
expect_err "C8 direct call creating own platform_revenue is denied"        "$(as_user $MALLORY "SELECT ensure_wallet_account('$MALLORY', 'platform_revenue')")" "42501\|forbidden\|permission denied"
q "C9 Mallory ended up with no platform-type rows" "SELECT NOT EXISTS (SELECT 1 FROM wallet_accounts WHERE user_id='$MALLORY' AND account_type IN ('platform_fx_reserve','platform_revenue'))"
expect_ok  "C10 nested plpgsql call (send_gift-style) for another user + platform type still works" "$(as_user $ALICE "SELECT _test_nested_ensure('$BOB', 'platform_revenue')")"
expect_ok  "C11 nested SQL-language call for another user still works"     "$(as_user $ALICE "SELECT _test_nested_ensure_sql('$BOB', 'customer_cash')")"
expect_ok  "C12 admin direct call for another user is allowed"             "$(as_user $CAROL "SELECT ensure_wallet_account('$MALLORY', 'customer_cash')")"
expect_ok  "C13 service/cron context (no JWT) direct call is allowed"      "SELECT ensure_wallet_account('$BOB', 'platform_promotions')"

# C14 pins the frame claim to the shape production actually uses: a trigger function
# calling the helper for ANOTHER user with a platform type (handle_corporate_ride_completion,
# the referral triggers). C10/C11 only cover hand-written SECDEF helpers.
$P -c "CREATE TABLE _probe_evt (id serial primary key, who uuid);
       CREATE FUNCTION _probe_trg() RETURNS trigger LANGUAGE plpgsql AS \$f\$
       BEGIN PERFORM ensure_wallet_account(NEW.who, 'platform_revenue'); RETURN NEW; END \$f\$;
       CREATE TRIGGER _probe_t AFTER INSERT ON _probe_evt FOR EACH ROW EXECUTE FUNCTION _probe_trg();
       GRANT INSERT ON _probe_evt TO authenticated; GRANT USAGE, SELECT ON SEQUENCE _probe_evt_id_seq TO authenticated;" >/dev/null 2>&1
expect_ok "C14 trigger-path call for another user + platform type still works" "$(as_user $ALICE "INSERT INTO _probe_evt (who) VALUES ('$BOB')")"

# --- D. wa_insert_own (anchor-mint vector) ---
q "D1 policy wa_insert_own no longer exists" "SELECT NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.wallet_accounts'::regclass AND polname='wa_insert_own')"
# Eve has no customer_cash yet (261 real users are in this state): try to seed a \$1M USD anchor with balance 0
EVE='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
expect_err "D2 authenticated cannot INSERT own customer_cash row with a forged anchor" "$(as_user $EVE "INSERT INTO wallet_accounts (user_id, account_type, balance, held_balance, anchor_usd_cents, unbacked_cup) VALUES ('$EVE', 'customer_cash', 0, 0, 100000000, 5000000)")" "row-level security\|permission denied\|42501"
$P -c "SELECT revalue_anchored_wallets()" >/dev/null 2>&1
q "D3 the daily revaluation minted nothing for Eve" "SELECT COALESCE((SELECT balance FROM wallet_accounts WHERE user_id='$EVE' AND account_type='customer_cash'), 0) = 0"

# --- E. revalue_anchored_wallets picks the PLATFORM reserve, never a look-alike row ---
$P -c "DELETE FROM ledger_entries; DELETE FROM ledger_transactions; DELETE FROM wallet_accounts;" >/dev/null
# Attacker-owned look-alike reserve inserted FIRST so that, on a fresh table, the
# unpinned `LIMIT 1` (no ORDER BY) returns IT and the RED run demonstrates the capture.
# That ordering is heap order, not a guarantee: after a VACUUM/plan change a RED E3/E4
# could pass for the wrong reason. GREEN does not depend on it (the pin is explicit).
$P -c "INSERT INTO wallet_accounts (user_id, account_type, balance) VALUES ('$MALLORY', 'platform_fx_reserve', 0);
       INSERT INTO wallet_accounts (user_id, account_type, balance) VALUES ('$PLATFORM', 'platform_fx_reserve', 0);
       INSERT INTO wallet_accounts (user_id, account_type, balance, anchor_usd_cents, unbacked_cup) VALUES ('$ALICE', 'customer_cash', 0, 1000, 0);" >/dev/null || echo "E fixture failed"
q "E1 revalue_anchored_wallets revalued exactly one wallet" "SELECT revalue_anchored_wallets() = 1"
q "E2 Alice was repriced to 7000 CUP (1000 cents x 700)" "SELECT balance = 7000 FROM wallet_accounts WHERE user_id='$ALICE' AND account_type='customer_cash'"
q "E3 the PLATFORM reserve absorbed the delta (-7000)" "SELECT balance = -7000 FROM wallet_accounts WHERE user_id='$PLATFORM' AND account_type='platform_fx_reserve'"
q "E4 the look-alike reserve stayed untouched (0)" "SELECT balance = 0 FROM wallet_accounts WHERE user_id='$MALLORY' AND account_type='platform_fx_reserve'"
q "E5 live body filters the reserve by the platform user" "SELECT position(\$t\$'platform_fx_reserve' AND user_id = '00000000-0000-0000-0000-000000000001'\$t\$ IN prosrc) > 0 FROM pg_proc WHERE proname='revalue_anchored_wallets' AND pronamespace='public'::regnamespace"

# --- G. the migration's own guards must FAIL LOUDLY, not pass silently ---
# Verification code that was never seen failing is the 00531 lesson all over again.
if [ "$MIG" != "none" ]; then
  # G1: a locked function whose signature drifted -> REVOKE loop misses it -> $verify$ must abort.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr1g1" -c "CREATE DATABASE pr1g1" >/dev/null
  G1="$BIN/psql $CONN -d pr1g1 -qAt -v ON_ERROR_STOP=1"
  $G1 -f "$DIR/scaffold.sql" >/dev/null
  # drift refund_rate_limit(text,integer) -> refund_rate_limit(text) and leave it open to anon
  $G1 -c "DROP FUNCTION public.refund_rate_limit(text, integer);
          CREATE FUNCTION public.refund_rate_limit(p_key text) RETURNS void LANGUAGE sql AS 'SELECT 1';
          GRANT EXECUTE ON FUNCTION public.refund_rate_limit(text) TO anon;" >/dev/null
  if out=$($G1 -c "SET search_path=''" -f "$MIG" 2>&1); then
    ko "G1 signature drift aborts the migration" "migration succeeded and left the function open"
  elif echo "$out" | grep -q "still executable by anon/authenticated"; then
    ok "G1 signature drift aborts the migration"
  else
    ko "G1 signature drift aborts the migration" "wrong error: $(echo "$out" | head -1)"
  fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr1g1" >/dev/null

  # G2: a reserve owned by someone else -> pinning would silence the revaluation -> must abort.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr1g2" -c "CREATE DATABASE pr1g2" >/dev/null
  G2="$BIN/psql $CONN -d pr1g2 -qAt -v ON_ERROR_STOP=1"
  $G2 -f "$DIR/scaffold.sql" >/dev/null
  $G2 -c "UPDATE wallet_accounts SET user_id='$MALLORY' WHERE account_type='platform_fx_reserve'" >/dev/null
  if out=$($G2 -c "SET search_path=''" -f "$MIG" 2>&1); then
    ko "G2 misowned FX reserve aborts the migration" "migration succeeded and pinned anyway"
  elif echo "$out" | grep -q "not owned by the platform user"; then
    ok "G2 misowned FX reserve aborts the migration"
  else
    ko "G2 misowned FX reserve aborts the migration" "wrong error: $(echo "$out" | head -1)"
  fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS pr1g2" >/dev/null
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
