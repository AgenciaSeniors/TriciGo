#!/usr/bin/env bash
# Rehearsal runner for migration 00639 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00639/run.sh none
#       -> scaffold (payment_intents and the wallet tables as live, the LIVE refund and
#          anchor bodies) + tests (RED: a rider inserts payment_intents, two intents can
#          share a NETOPIA id, and a refund the wallet cannot cover fails with 23514)
#   supabase/tests/00639/run.sh supabase/migrations/00639_recharge_intents_server_only_and_refund_shortfall.sql
#       -> the same + migration x2 (idempotency) + a CRLF copy + tests + negative proofs (GREEN)
# Client tests run as PostgREST would (role authenticated or anon, JWT subject set);
# refunds run as the service role, like the webhook. Every test is rolled back.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00639/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr639
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# blocked NAME SQL -> the write is refused: a privilege/RLS error, or 0 rows touched
blocked(){ local r; r=$(run "${3:-$DB}" "$2")
  if [ "$r" = 0 ] || echo "$r" | grep -Eq "permission denied|row-level security|42501"; then ok "$1"; else ko "$1" "not blocked: [$r]"; fi; }

RIDER1=a0000000-0000-4000-8000-000000000001   # spent part of two recharges
RIDER2=a0000000-0000-4000-8000-000000000002   # anchored above what the refund removes
RIDER3=a0000000-0000-4000-8000-000000000003   # spent everything
DRIVER=a0000000-0000-4000-8000-0000000000d1
CREATOR=a0000000-0000-4000-8000-0000000000c1
CORP=c0000000-0000-4000-8000-0000000000c1
PI_A=d0000000-0000-4000-8000-00000000000a   # rider1, $20  -> 15,400 CUP, covered
PI_B=d0000000-0000-4000-8000-00000000000b   # rider1, $100 -> 77,000 CUP, not covered
PI_C=d0000000-0000-4000-8000-00000000000c   # rider2, $20, wallet 10,000 with a $25 anchor
PI_D=d0000000-0000-4000-8000-00000000000d   # rider3, $20, wallet empty
PI_E=d0000000-0000-4000-8000-00000000000e   # driver tricicoin, $20
PI_F=d0000000-0000-4000-8000-00000000000f   # company, $100
SEED="INSERT INTO public.platform_config VALUES ('business_notification_email', to_jsonb('ops1@example.test, ops2@example.test'::text));
INSERT INTO public.corporate_accounts VALUES ('$CORP', '$CREATOR');
INSERT INTO public.wallet_accounts (user_id, account_type, balance, anchor_usd_cents, unbacked_cup) VALUES
  ('$RIDER1','customer_cash',46593,6051,0), ('$RIDER2','customer_cash',10000,2500,300),
  ('$RIDER3','customer_cash',0,0,0), ('$DRIVER','tricicoin',1000,130,0), ('$CREATOR','corporate_cash',500,65,0);
INSERT INTO public.payment_intents (id, user_id, amount_cup, amount_usd, exchange_rate, status, payment_provider, intent_type,
  recharge_type, corporate_account_id, stripe_payment_intent_id) VALUES
  ('$PI_A','$RIDER1',15400,20,770,'completed','netopia','recharge','customer',NULL,'111'),
  ('$PI_B','$RIDER1',77000,100,770,'completed','netopia','recharge','customer',NULL,'222'),
  ('$PI_C','$RIDER2',15400,20,770,'completed','netopia','recharge','customer',NULL,'333'),
  ('$PI_D','$RIDER3',15400,20,770,'completed','netopia','recharge','customer',NULL,'444'),
  ('$PI_E','$DRIVER',15400,20,770,'completed','netopia','recharge','tricicoin',NULL,'555'),
  ('$PI_F','$CREATOR',77000,100,770,'completed','netopia','recharge','customer','$CORP','666');"

# as SUB|anon SQL -> SQL as that signed-in account (or anon), rolled back
as(){ local who
  if [ "$1" = anon ]; then who="SET LOCAL ROLE anon;"
  else who="SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; fi
  printf "BEGIN; %s %s ROLLBACK;" "$who" "$2"; }
# svc SQL -> SQL as the service role (the webhook), rolled back
svc(){ printf "BEGIN; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1"; }
refund(){ printf "PERFORM public.process_recharge_refund('%s', '{\"netopia_status\":17}'::jsonb);" "$1"; }
# do_svc BODY SELECT -> run a plpgsql BODY as the service role, then SELECT, rolled back
do_svc(){ printf "BEGIN; SET LOCAL ROLE service_role; DO \$t\$ BEGIN %s END \$t\$; %s ROLLBACK;" "$1" "$2"; }
wa(){ printf "(SELECT balance || '/' || coalesce(anchor_usd_cents::int::text,'null') || '/' || unbacked_cup FROM public.wallet_accounts WHERE user_id = '%s')" "$1"; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SEED" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

fresh $DB || { echo "scaffold or seed failed"; exit 2; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('process_recharge_refund', 'tg_ledger_maintain_usd_anchor')" \
  "process_recharge_refund:640a94e7d03fe6e84dcb3240a6db4de2/4091,tg_ledger_maintain_usd_anchor:8456580fb85a99fbe8c523ed396ab37d/2554"

if [ "$MIG" != none ]; then
  # A fresh environment (local stack, branch) has no rows: the migration must apply there too.
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
  $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 applies on an empty database" || ko "M0 applies on an empty database" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
  for i in 1 2; do
    r=$(apply_err $DB "$MIG"); [ "$r" = applied ] || { echo "migration failed (run $i): $r"; exit 2; }
  done
  ok "M1 migration applies twice (idempotent)"
  # Pasted from Windows into the SQL Editor: the same text with CRLF line endings.
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh ${DB}w || { echo "scaffold failed"; exit 2; }
  r=$(apply_err ${DB}w "$CRLF"); rm -f "$CRLF"
  if [ "$r" = applied ]; then
    val "M2 a CRLF copy applies and leaves the bodies of git" \
      "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('_alert_recharge_refund_shortfall', 'process_recharge_refund')" \
      "$(run $DB "SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('_alert_recharge_refund_shortfall', 'process_recharge_refund')")" ${DB}w
  else ko "M2 a CRLF copy applies" "$r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}w" >/dev/null 2>&1
fi

# --- Clients and payment_intents -------------------------------------------------
blocked "I1 a rider cannot insert a payment intent for herself" \
  "$(as $RIDER1 "WITH x AS (INSERT INTO public.payment_intents (user_id, amount_cup, status, payment_provider, stripe_payment_intent_id)
     VALUES ('$RIDER1', 9999999, 'completed', 'netopia', '111x') RETURNING 1) SELECT count(*) FROM x;")"
blocked "I2 a rider cannot insert a payment intent for someone else" \
  "$(as $RIDER1 "WITH x AS (INSERT INTO public.payment_intents (user_id, amount_cup) VALUES ('$RIDER2', 1) RETURNING 1) SELECT count(*) FROM x;")"
blocked "I3 anon cannot insert a payment intent" \
  "$(as anon "WITH x AS (INSERT INTO public.payment_intents (user_id, amount_cup) VALUES ('$RIDER1', 1) RETURNING 1) SELECT count(*) FROM x;")"
val "I4 a rider still reads her own intents (payment history)" \
  "$(as $RIDER1 "SELECT count(*) FROM public.payment_intents;")" "2"
blocked "I5 a rider cannot update or delete her intents" \
  "$(as $RIDER1 "WITH x AS (UPDATE public.payment_intents SET amount_cup = 1 RETURNING 1) SELECT count(*) FROM x;")"

# --- One NETOPIA transaction per intent --------------------------------------------
val "U1 a second intent cannot carry a NETOPIA id that another intent holds" \
  "$(do_svc "CREATE TEMP TABLE u1 (v text);
     BEGIN
       INSERT INTO public.payment_intents (user_id, amount_cup, stripe_payment_intent_id) VALUES ('$RIDER2', 1, '111');
       INSERT INTO u1 VALUES ('inserted');
     EXCEPTION WHEN unique_violation THEN INSERT INTO u1 VALUES ('duplicate key');
     END;" "SELECT v FROM u1;")" \
  "duplicate key"
val "U2 intents without a NETOPIA id are not limited" \
  "$(svc "INSERT INTO public.payment_intents (user_id, amount_cup) VALUES ('$RIDER2', 1), ('$RIDER2', 2); SELECT count(*) FROM public.payment_intents WHERE stripe_payment_intent_id IS NULL;")" \
  "2"

# --- Refunds ---------------------------------------------------------------------------
val "R1 a refund the wallet covers debits the refund at today's rate" \
  "$(do_svc "$(refund $PI_A)" "SELECT $(wa $RIDER1) || ' ' || status || ' ' || coalesce(error_message, '-') || ' ' ||
     (SELECT count(*) FROM public.test_http_calls) FROM public.payment_intents WHERE id = '$PI_A';")" \
  "31193/4051/0 refunded - 0"
val "R2 a refund the wallet cannot cover takes what is left and records the rest" \
  "$(do_svc "$(refund $PI_B)" "SELECT $(wa $RIDER1) || ' ' || status || ' ' || error_message || ' ' ||
     (SELECT (metadata->>'refund_debited_cup') || '+' || (metadata->>'refund_shortfall_cup') FROM public.ledger_transactions
       WHERE idempotency_key = 'recharge_refund_$PI_B') || ' ' ||
     (SELECT amount FROM public.ledger_entries e JOIN public.ledger_transactions t ON t.id = e.transaction_id
       WHERE t.idempotency_key = 'recharge_refund_$PI_B')
     FROM public.payment_intents WHERE id = '$PI_B';")" \
  "0/0/0 refunded refund_shortfall: 30407 CUP not recovered from the wallet 46593+30407 -46593"
val "R3 ops get one e-mail per address, through cron_http_post" \
  "$(do_svc "$(refund $PI_B)" "SELECT string_agg(jobname || ':' || (body->>'recipient_email') || ':' || (position('30407 CUP' IN body->>'subject') > 0)::text, ',' ORDER BY body->>'recipient_email') FROM public.test_http_calls;")" \
  "refund-shortfall-alert:ops1@example.test:true,refund-shortfall-alert:ops2@example.test:true"
val "R4 an emptied wallet keeps no anchor or unbacked CUP (the next revaluation would rebuild it)" \
  "$(do_svc "$(refund $PI_C)" "SELECT $(wa $RIDER2) || ' ' || (SELECT metadata->>'refund_shortfall_cup' FROM public.ledger_transactions WHERE idempotency_key = 'recharge_refund_$PI_C');")" \
  "0/0/0 5400"
val "R5 a refund on an empty wallet is still recorded" \
  "$(do_svc "$(refund $PI_D)" "SELECT $(wa $RIDER3) || ' ' || status || ' ' ||
     (SELECT e.amount FROM public.ledger_entries e JOIN public.ledger_transactions t ON t.id = e.transaction_id
       WHERE t.idempotency_key = 'recharge_refund_$PI_D') FROM public.payment_intents WHERE id = '$PI_D';")" \
  "0/0/0 refunded 0"
val "R6 a replayed refund IPN debits nothing more" \
  "$(do_svc "$(refund $PI_B) $(refund $PI_B)" "SELECT $(wa $RIDER1) || ' ' ||
     (SELECT count(*) FROM public.ledger_transactions WHERE idempotency_key = 'recharge_refund_$PI_B') || ' ' ||
     (SELECT count(*) FROM public.test_http_calls);")" \
  "0/0/0 1 2"
val "R7 a driver wallet is debited in full, below zero, with no alert (unchanged)" \
  "$(do_svc "$(refund $PI_E)" "SELECT (SELECT balance FROM public.wallet_accounts WHERE user_id = '$DRIVER') || ' ' ||
     (SELECT count(*) FROM public.test_http_calls) || ' ' ||
     coalesce((SELECT metadata->>'refund_shortfall_cup' FROM public.ledger_transactions WHERE idempotency_key = 'recharge_refund_$PI_E'), 'none');")" \
  "-14400 0 none"
val "R8 a company wallet is debited in full, below zero (unchanged)" \
  "$(do_svc "$(refund $PI_F)" "SELECT (SELECT balance FROM public.wallet_accounts WHERE user_id = '$CREATOR') || ' ' ||
     (SELECT count(*) FROM public.test_http_calls);")" \
  "-76500 0"
val "R9 with no ops address the refund is still recorded" \
  "$(do_svc "DELETE FROM public.platform_config; $(refund $PI_B)" "SELECT status || ' ' || $(wa $RIDER1) || ' ' ||
     (SELECT count(*) FROM public.test_http_calls) FROM public.payment_intents WHERE id = '$PI_B';")" \
  "WARNING:  _alert_recharge_refund_shortfall: business_notification_email unset (intent $PI_B);refunded 0/0/0 0"
val "R10 an alert that cannot be sent does not stop the refund" \
  "$(do_svc "PERFORM set_config('app.test_http_fail', '1', true); $(refund $PI_B)" "SELECT status || ' ' || $(wa $RIDER1) FROM public.payment_intents WHERE id = '$PI_B';")" \
  "WARNING:  _alert_recharge_refund_shortfall failed for intent $PI_B: P0001 test: http unavailable;refunded 0/0/0"
val "R11 a refund debits today's rate, also when the wallet falls short" \
  "$(do_svc "PERFORM set_config('app.test_rate', '900', true); $(refund $PI_C)" "SELECT $(wa $RIDER2) || ' ' ||
     (SELECT (metadata->>'refund_debited_cup') || '+' || (metadata->>'refund_shortfall_cup') FROM public.ledger_transactions WHERE idempotency_key = 'recharge_refund_$PI_C');")" \
  "0/0/0 10000+8000"

# --- Grants ------------------------------------------------------------------------------
val "G1 clients cannot run the refund or the alert" \
  "SELECT bool_or(has_function_privilege(r, p.oid, 'EXECUTE')) FROM pg_proc p, unnest(ARRAY['anon','authenticated']) r
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('process_recharge_refund', '_alert_recharge_refund_shortfall')
   HAVING count(*) = 4" "f"

if [ "$MIG" != none ]; then
  # --- Negative proofs: the migration refuses what it cannot handle ----------------------
  N=${DB}n
  fresh $N || { echo "scaffold failed"; exit 2; }
  run $N "$AS_OWNER; CREATE OR REPLACE FUNCTION public.process_recharge_refund(p_payment_intent_id uuid, p_webhook_payload jsonb DEFAULT NULL::jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS \$f\$ BEGIN RETURN NULL; END \$f\$;" >/dev/null
  r=$(apply_err $N "$MIG"); echo "$r" | grep -q "unexpected body of process_recharge_refund" && ok "N1 refuses a refund body it does not know" || ko "N1 refuses a refund body it does not know" "$r"
  fresh $N
  run $N "INSERT INTO public.payment_intents (user_id, amount_cup, stripe_payment_intent_id) VALUES ('$RIDER2', 1, '111');" >/dev/null
  r=$(apply_err $N "$MIG"); echo "$r" | grep -q "stored on more than one intent" && ok "N2 refuses repeated NETOPIA ids" || ko "N2 refuses repeated NETOPIA ids" "$r"
  fresh $N
  run $N "$AS_OWNER; CREATE POLICY pi_extra ON public.payment_intents FOR UPDATE USING (user_id = auth.uid());" >/dev/null
  r=$(apply_err $N "$MIG"); echo "$r" | grep -q "still has a policy that lets clients write" && ok "N3 refuses a client write policy left behind" || ko "N3 refuses a client write policy left behind" "$r"
  fresh $N
  run $N "$AS_OWNER; DROP INDEX public.idx_payment_intents_stripe_pi_id; CREATE INDEX payment_intents_provider_txn_key ON public.payment_intents (stripe_payment_intent_id);" >/dev/null
  r=$(apply_err $N "$MIG"); echo "$r" | grep -q "unique index on the provider transaction id is missing" && ok "N4 refuses a non-unique index under the expected name" || ko "N4 refuses a non-unique index under the expected name" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $N" >/dev/null 2>&1
fi

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
