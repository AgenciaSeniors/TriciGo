#!/usr/bin/env bash
# Rehearsal runner for migration 00627 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00627/run.sh none
#       -> scaffold (the seven money tables with prod's grants and live policies) + tests (RED:
#          an admin writes raw money rows, truncates the ledger and approves their own recharge)
#   supabase/tests/00627/run.sh supabase/migrations/00627_admin_money_through_rpcs.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Each test runs as PostgREST would: role authenticated (or anon) with the JWT subject set,
# inside a transaction that is rolled back.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00627/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr627
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# blocked NAME SQL -> the write is refused: a privilege/RLS error, or 0 rows touched
blocked(){ local r; r=$(run "${3:-$DB}" "$2")
  if [ "$r" = 0 ] || echo "$r" | grep -Eq "permission denied|row-level security|42501|Forbidden"; then ok "$1"; else ko "$1" "not blocked: [$r]"; fi; }

ADA=a0000000-0000-4000-8000-0000000000ad     # admin
SUSI=a0000000-0000-4000-8000-00000000005a    # super_admin
CARL=a0000000-0000-4000-8000-00000000000c    # customer
CORA=a0000000-0000-4000-8000-0000000000c0    # customer
WA_ADA=b0000000-0000-4000-8000-0000000000ad
WA_CARL=b0000000-0000-4000-8000-00000000000c
WA_CORA=b0000000-0000-4000-8000-0000000000c0
RQ_ADA=c0000000-0000-4000-8000-0000000000ad   # pending recharge request of the admin herself
RQ_CARL=c0000000-0000-4000-8000-00000000000c  # pending request of Carl
RQ_CORA=c0000000-0000-4000-8000-0000000000c0  # Cora's request, already rejected
PI_CARL=d0000000-0000-4000-8000-00000000000c
SEED="INSERT INTO public.users (id, role) VALUES ('$ADA','admin'),('$SUSI','super_admin'),('$CARL','customer'),('$CORA','customer');
INSERT INTO public.wallet_accounts (id, user_id, account_type, balance, anchor_usd_cents) VALUES
  ('$WA_ADA','$ADA','customer_cash',500,100),('$WA_CARL','$CARL','customer_cash',1000,200),('$WA_CORA','$CORA','customer_cash',2000,400);
INSERT INTO public.ledger_transactions (id, idempotency_key, type, status, created_by) VALUES
  ('e0000000-0000-4000-8000-00000000000c','seed:carl','recharge','posted','$CARL');
INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after) VALUES
  ('e0000000-0000-4000-8000-00000000000c','$WA_CARL',1000,1000);
INSERT INTO public.payment_intents (id, user_id, amount_cup, status) VALUES ('$PI_CARL','$CARL',1000,'paid');
INSERT INTO public.wallet_receipts (user_id, payment_intent_id, receipt_no, tc_credited) VALUES ('$CARL','$PI_CARL','R-1',1000);
INSERT INTO public.wallet_transfers (from_user_id, to_user_id, amount) VALUES ('$CARL','$CORA',50);
INSERT INTO public.wallet_recharge_requests (id, user_id, amount, status) VALUES
  ('$RQ_ADA','$ADA',99999,'pending'),('$RQ_CARL','$CARL',300,'pending'),('$RQ_CORA','$CORA',700,'rejected');"

# as SUB|anon SQL -> SQL as that signed-in account (or anon), rolled back
as(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; %s %s ROLLBACK;" "$who" "$2"; }
n(){ printf "WITH x AS (%s RETURNING 1) SELECT count(*) FROM x;" "$1"; }   # rows touched by a DML statement

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('approve_wallet_recharge', 'ensure_wallet_account', 'is_admin', 'current_user_role')" \
  "approve_wallet_recharge:a3c8a6fd82ebbe2c1e4d15e7852ffba8/2004,current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,ensure_wallet_account:6f01c44a2ecd5afe0b625347b43c203f/1678,is_admin:22cb75e91980d512498034cd33e1eda2/285"

if [ "$MIG" != none ]; then
  # A fresh environment (local stack, branch) has no rows: the migration must apply there too.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
  $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 applies on an empty database" || ko "M0 applies on an empty database" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  echo "migration applied twice"
fi

echo "== an admin cannot write money rows directly =="
blocked "A1 admin raises her own balance"            "$(as $ADA "$(n "UPDATE public.wallet_accounts SET balance = balance + 100000 WHERE id = '$WA_ADA'")")"
blocked "A2 admin raises her own USD anchor"         "$(as $ADA "$(n "UPDATE public.wallet_accounts SET anchor_usd_cents = 999999 WHERE id = '$WA_ADA'")")"
blocked "A3 admin creates a wallet with a balance"   "$(as $ADA "$(n "INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES ('$ADA','tricicoin',50000)")")"
blocked "A4 admin writes a ledger transaction"       "$(as $ADA "$(n "INSERT INTO public.ledger_transactions (idempotency_key, type, status, created_by) VALUES ('x','adjustment','posted','$ADA')")")"
blocked "A5 admin writes a ledger entry"             "$(as $ADA "$(n "INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after) VALUES ('e0000000-0000-4000-8000-00000000000c','$WA_ADA',50000,50500)")")"
blocked "A6 admin deletes a transfer"                "$(as $ADA "$(n "DELETE FROM public.wallet_transfers")")"
blocked "A7 admin marks a payment intent"            "$(as $ADA "$(n "UPDATE public.payment_intents SET status = 'refunded'")")"
blocked "A8 admin forges a receipt"                  "$(as $ADA "$(n "INSERT INTO public.wallet_receipts (user_id, payment_intent_id, receipt_no, tc_credited) VALUES ('$ADA','$PI_CARL','R-X',1)")")"
blocked "A9 admin files a recharge request for Carl" "$(as $ADA "$(n "INSERT INTO public.wallet_recharge_requests (user_id, amount) VALUES ('$CARL',5000)")")"
blocked "A10 admin edits a pending request and keeps it pending" "$(as $ADA "$(n "UPDATE public.wallet_recharge_requests SET amount = 999999, user_id = '$ADA' WHERE id = '$RQ_CARL'")")"
blocked "A11 admin deletes recharge requests"        "$(as $ADA "$(n "DELETE FROM public.wallet_recharge_requests")")"
blocked "A12 admin truncates the ledger (TRUNCATE skips RLS)" "$(as $ADA "TRUNCATE public.ledger_entries; SELECT 'truncated';")"
blocked "A13 a super_admin cannot either"            "$(as $SUSI "$(n "UPDATE public.wallet_accounts SET balance = 1 WHERE id = '$WA_CARL'")")"
blocked "A14 admin approves her own recharge request" "$(as $ADA "SELECT public.approve_wallet_recharge('$RQ_ADA', '$ADA') IS NOT NULL;")"
blocked "A15 admin rejects a request under someone else's name" "$(as $ADA "$(n "UPDATE public.wallet_recharge_requests SET status = 'rejected', processed_by = '$SUSI' WHERE id = '$RQ_CARL'")")"

echo "== what the panel does keeps working =="
val "K1 admin reads every wallet"                 "$(as $ADA "SELECT count(*) FROM public.wallet_accounts;")" "3"
val "K2 admin reads ledger, intents and requests" "$(as $ADA "SELECT (SELECT count(*) FROM public.ledger_transactions) || '/' || (SELECT count(*) FROM public.ledger_entries) || '/' || (SELECT count(*) FROM public.payment_intents) || '/' || (SELECT count(*) FROM public.wallet_recharge_requests);")" "1/1/1/3"
val "K3 admin reads receipts and transfers"       "$(as $ADA "SELECT (SELECT count(*) FROM public.wallet_receipts) || '/' || (SELECT count(*) FROM public.wallet_transfers);")" "1/1"
val "K4 admin rejects Carl's pending request"     "$(as $ADA "$(n "UPDATE public.wallet_recharge_requests SET status = 'rejected', processed_by = '$ADA', processed_at = now(), rejection_reason = 'x' WHERE id = '$RQ_CARL'")")" "1"
val "K5 admin approves Carl's request: credited through the ledger" \
  "$(as $ADA "SELECT public.approve_wallet_recharge('$RQ_CARL', '$ADA') IS NOT NULL; SELECT balance FROM public.wallet_accounts WHERE id = '$WA_CARL'; SELECT status FROM public.wallet_recharge_requests WHERE id = '$RQ_CARL';")" "t;1300;approved"
val "K6 a super_admin approves the admin's request" \
  "$(as $SUSI "SELECT public.approve_wallet_recharge('$RQ_ADA', '$SUSI') IS NOT NULL; SELECT balance FROM public.wallet_accounts WHERE id = '$WA_ADA';")" "t;100499"
val "K7 a rejected request stays rejected"        "$(as $ADA "$(n "UPDATE public.wallet_recharge_requests SET status = 'rejected', processed_by = '$ADA' WHERE id = '$RQ_CORA'")")" "0"
val "K8 Carl files his own recharge request"      "$(as $CARL "$(n "INSERT INTO public.wallet_recharge_requests (user_id, amount) VALUES ('$CARL',500)")")" "1"
val "K9 Carl sees only his wallet, receipt and transfer" \
  "$(as $CARL "SELECT (SELECT count(*) FROM public.wallet_accounts) || '/' || (SELECT count(*) FROM public.wallet_receipts) || '/' || (SELECT count(*) FROM public.wallet_transfers);")" "1/1/1"
val "K10 Cora does not see Carl's receipt"        "$(as $CORA "SELECT count(*) FROM public.wallet_receipts;")" "0"
blocked "K11 Carl cannot raise his balance"       "$(as $CARL "$(n "UPDATE public.wallet_accounts SET balance = 99999")")"
blocked "K12 Carl cannot reject or approve his own request" "$(as $CARL "$(n "UPDATE public.wallet_recharge_requests SET status = 'approved' WHERE id = '$RQ_CARL'")")"
blocked "K13 anon cannot file a recharge request" "$(as anon "$(n "INSERT INTO public.wallet_recharge_requests (user_id, amount) VALUES ('$CARL',5)")")"
val "K14 the service role still writes wallets"   "BEGIN; SET LOCAL ROLE service_role; $(n "UPDATE public.wallet_accounts SET balance = balance WHERE id = '$WA_CARL'") ROLLBACK;" "1"
val "K15 the service role still writes the ledger" "BEGIN; SET LOCAL ROLE service_role; $(n "INSERT INTO public.ledger_entries (transaction_id, account_id, amount, balance_after) VALUES ('e0000000-0000-4000-8000-00000000000c','$WA_CARL',1,1001)") ROLLBACK;" "1"

if [ "$MIG" = none ]; then
  echo "(the A tests check what 00627 closes, and A14/A15 its new rules: they fail on the baseline)"
else
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
        v = v.replace(old, new)
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('keeps_wa_admin', ("DROP POLICY IF EXISTS wa_admin ON public.wallet_accounts;\n", ""))
variant('keeps_truncate', ("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON\n", "REVOKE INSERT, UPDATE, DELETE ON\n"))
variant('reject_any_status', ("USING ((SELECT public.is_admin()) AND status = 'pending')\n  WITH CHECK ((SELECT public.is_admin()) AND status = 'rejected' AND processed_by = (SELECT auth.uid()));",
                              "USING ((SELECT public.is_admin()))\n  WITH CHECK ((SELECT public.is_admin()));"))
PYEOF
  refuses(){ local r; fresh ${DB}g; [ -n "${4:-}" ] && run ${DB}g "$4" >/dev/null; r=$(apply_err ${DB}g "$2")
    echo "$r" | grep -q "$3" && ok "$1" || ko "$1" "$r"; }
  refuses "N1 the migration refuses to finish with an admin write policy left" "$T/keeps_wa_admin.sql" "write policies left on money tables"
  refuses "N2 the migration refuses to finish with TRUNCATE still granted" "$T/keeps_truncate.sql" "clients can still write money tables"
  refuses "N3 the migration refuses an approve_wallet_recharge it does not know" "$MIG" "not the body this migration knows" \
    "CREATE OR REPLACE FUNCTION public.approve_wallet_recharge(p_request_id uuid, p_admin_id uuid) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'"
  # The end-state check does not inspect the reject policy's expression: A10/A15/K7 do. Prove they would see it.
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/reject_any_status.sql")
  if [ "$r" = applied ]; then
    r=$(run ${DB}g "$(as $ADA "$(n "UPDATE public.wallet_recharge_requests SET amount = 999999 WHERE id = '$RQ_CARL'")")")
    [ "$r" = 1 ] && ok "N4 a loose reject policy fails A10 (so A10 tests it)" || ko "N4 a loose reject policy fails A10" "got [$r]"
  else ko "N4" "apply: $r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
