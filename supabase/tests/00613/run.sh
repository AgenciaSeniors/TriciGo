#!/usr/bin/env bash
# Rehearsal runner for migration 00613 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00613/run.sh none
#       -> prod as of 2026-10-06 (00612 scaffold + 00612 + seed.sql) + tests (RED: the app's
#          shares are kept, so a second invite leaves 50/33.33 and a third one is rejected)
#   supabase/tests/00613/run.sh supabase/migrations/00613_ride_splits_equal_shares.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00613/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
M612="$DIR/../../migrations/00612_client_writes_split_docs_test_flag.sql"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr613
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql ends its
# lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines are dropped.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# err NAME SQL REGEX -> the statements must fail with an error matching REGEX (extended)
err(){ local r; r=$(run $DB "$2"); if echo "$r" | grep -q '^ERROR\|;ERROR' && echo "$r" | grep -qE "$3"; then ok "$1"; else ko "$1" "expected an error matching [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, asks for the rides and invites
BETO=b0000000-0000-4000-8000-000000000002   # customer, invited on R1, R3 and R4
CORA=c0000000-0000-4000-8000-000000000003   # admin
DANI=d0000000-0000-4000-8000-000000000004   # driver of every ride
EVA=e0000000-0000-4000-8000-000000000005    # customer, invited on R3
FEDE=0f000000-0000-4000-8000-000000000006   # customer
GABI=09000000-0000-4000-8000-000000000007   # customer
R1=f1000000-0000-4000-8000-000000000001     # accepted, Beto invited at 50%, not answered
R2=f2000000-0000-4000-8000-000000000002     # searching, no splits
R3=f3000000-0000-4000-8000-000000000003     # accepted, split the old way: Beto 50%, Eva 33.33%
R4=f4000000-0000-4000-8000-000000000004     # accepted, Beto at 50% already paid
S1=51000000-0000-4000-8000-000000000001     # Beto's split on R1

# Each split prints invitee:share:payment_status:accepted:paid:amount:invited_by
splits(){ echo "SELECT string_agg(u.full_name || ':' || s.share_pct || ':' || s.payment_status || ':' || (s.accepted_at IS NOT NULL)
  || ':' || (s.paid_at IS NOT NULL) || ':' || coalesce(s.amount_trc::text, '-') || ':' || i.full_name, ',' ORDER BY u.full_name)
  FROM public.ride_splits s JOIN public.users u ON u.id = s.user_id JOIN public.users i ON i.id = s.invited_by WHERE s.ride_id = '$1'"; }
# invite RIDE USER SHARE -> the app's exact insert (createSplitInvite), as the requester
invite(){ echo "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$1', '$2', '$ANA', $3);"; }
# as UID SQL CHECK -> SQL as authenticated with JWT subject UID (as PostgREST would), then CHECK, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2" "$3"; }
# svc SQL CHECK -> SQL as service_role with no JWT (Edge Functions, cron), then CHECK, rolled back
svc(){ printf "BEGIN; SET LOCAL ROLE service_role; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2"; }
# sub UID -> switch the JWT subject inside a transaction
sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# fresh DBNAME -> a new database as prod is today: the 00612 scaffold, 00612 itself, and seed.sql
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00612/scaffold.sql" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M612" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# race DBNAME -> the requester invites Eva and Beto on R2 from two sessions at the same time (the
# app sends 60% and 50%); the first holds its transaction open while the second runs. Prints the
# second session's outcome and the splits R2 kept, then deletes them.
race(){ local a b
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated; $(invite $R2 $EVA 60)
    SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.5
  if $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated; $(invite $R2 $BETO 50) COMMIT;" >/dev/null 2>&1
  then b=committed; else b=rejected; fi
  wait $a
  echo "$b|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R2)" 2>&1 | tr -d '\r')"
  $BIN/psql $CONN -d "$1" -qAt -c "DELETE FROM public.ride_splits WHERE ride_id = '$R2'" >/dev/null 2>&1; }

# Statements reused by the negative proofs
E2_SQL="$(as $ANA "$(invite $R2 $EVA 50) $(invite $R2 $BETO 33.33)" "$(splits $R2)")"
E8_SQL="$(as $ANA "$(invite $R4 $EVA 50)" "$(splits $R4)")"
E10_SQL="$(as $ANA "$(invite $R2 $EVA 50)
  INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status)
  VALUES ('$R2', '$BETO', '$CORA', 40, now(), 'paid');" \
  "SELECT coalesce(current_setting('app.ride_splits_rebalance', true), 'unset') || '|' || ($(splits $R2))")"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the guard carries the live prod body (00612)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure" \
  "36862c0b2e4bf9a2d505c6d4de288efa/1966"
val "S1 seed: R1 Beto 50% pending; R3 split the old way; R4 Beto paid" \
  "$(splits $R1); $(splits $R2); $(splits $R3); $(splits $R4)" \
  "Beto:50.00:pending:false:false:-:Ana;Beto:50.00:pending:false:false:-:Ana,Eva:33.33:pending:false:false:-:Ana;Beto:50.00:paid:true:true:2500:Ana"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN=$(grep -oE "'[0-9a-f]{32}'\) THEN -- 00613" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the body the migration accepts as its own is the one it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure" "$OWN"
  val "M2 the trigger is unchanged, once" \
    "SELECT string_agg(pg_get_triggerdef(oid), ';') FROM pg_trigger WHERE tgname = 'trg_ride_splits_guard'" \
    "CREATE TRIGGER trg_ride_splits_guard BEFORE INSERT OR UPDATE ON public.ride_splits FOR EACH ROW EXECUTE FUNCTION tg_ride_splits_guard()"
  val "M3 clients cannot call the guard" \
    "SELECT has_function_privilege('anon', 'public.tg_ride_splits_guard()', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.tg_ride_splits_guard()', 'EXECUTE')" "false/false"
  val "M4 lock_timeout does not outlive the file" "SHOW lock_timeout" "0"
fi

echo "== equal parts =="
val "E1 the first invite takes half, whatever share the app sends" \
  "$(as $ANA "$(invite $R2 $EVA 99)" "$(splits $R2)")" \
  "Eva:50.00:pending:false:false:-:Ana"
val "E2 the second invite makes three equal parts: the first invitee goes down to 33.33%" \
  "$E2_SQL" \
  "Beto:33.33:pending:false:false:-:Ana,Eva:33.33:pending:false:false:-:Ana"
val "E3 the third invite, which 00612 rejected with the apps' shares, makes four parts of 25%" \
  "$(as $ANA "$(invite $R2 $EVA 50) $(invite $R2 $BETO 33.33) $(invite $R2 $FEDE 25)" "$(splits $R2)")" \
  "Beto:25.00:pending:false:false:-:Ana,Eva:25.00:pending:false:false:-:Ana,Fede:25.00:pending:false:false:-:Ana"
val "E4 five people pay 20% each" \
  "$(as $ANA "$(invite $R2 $EVA 50) $(invite $R2 $BETO 33.33) $(invite $R2 $FEDE 25) $(invite $R2 $GABI 20)" "$(splits $R2)")" \
  "Beto:20.00:pending:false:false:-:Ana,Eva:20.00:pending:false:false:-:Ana,Fede:20.00:pending:false:false:-:Ana,Gabi:20.00:pending:false:false:-:Ana"
val "E5 an accepted share goes down too, and stays accepted" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1' AND user_id = '$BETO' AND accepted_at IS NULL;
     $(sub $ANA) $(invite $R1 $EVA 33.33)" "$(splits $R1)")" \
  "Beto:33.33:pending:true:false:-:Ana,Eva:33.33:pending:false:false:-:Ana"
val "E6 withdrawing an invite raises nobody: the requester pays the freed part" \
  "$(as $ANA "$(invite $R2 $EVA 50) $(invite $R2 $BETO 33.33) $(invite $R2 $FEDE 25)
     DELETE FROM public.ride_splits WHERE ride_id = '$R2' AND user_id = '$FEDE';" "$(splits $R2)")" \
  "Beto:25.00:pending:false:false:-:Ana,Eva:25.00:pending:false:false:-:Ana"
val "E7 a ride split the old way is evened out by its next invite" \
  "$(as $ANA "$(invite $R3 $FEDE 25)" "$(splits $R3)")" \
  "Beto:25.00:pending:false:false:-:Ana,Eva:25.00:pending:false:false:-:Ana,Fede:25.00:pending:false:false:-:Ana"
val "E8 a paid split is never re-priced" \
  "$E8_SQL" \
  "Beto:50.00:paid:true:true:2500:Ana,Eva:33.33:pending:false:false:-:Ana"
val "E9 one INSERT with two invitees makes three equal parts" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 60), ('$R2', '$BETO', '$ANA', 50);" "$(splits $R2)")" \
  "Beto:33.33:pending:false:false:-:Ana,Eva:33.33:pending:false:false:-:Ana"

echo "== the rebalance flag =="
val "E10 it does not outlive the invite: a second insert in the same transaction is held" \
  "$E10_SQL" \
  "|Beto:33.33:pending:false:false:-:Ana,Eva:33.33:pending:false:false:-:Ana"
val "E11 on a pooled connection where an earlier transaction set it, the next client is still held" \
  "BEGIN; SELECT set_config('app.ride_splits_rebalance', '1', true) IS NULL; COMMIT;
   $(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status)
     VALUES ('$R2', '$EVA', '$CORA', 50, now(), 'paid');" "SELECT current_setting('app.ride_splits_rebalance') || '|' || ($(splits $R2))")" \
  "f;|Eva:50.00:pending:false:false:-:Ana"

echo "== what 00612 already held =="
val "H1 the invitee still cannot change their share, and still accepts with the app's update" \
  "$(as $BETO "UPDATE public.ride_splits SET share_pct = 1 WHERE id = '$S1';
     UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1' AND user_id = '$BETO' AND accepted_at IS NULL;" "$(splits $R1)")" \
  "Beto:50.00:pending:true:false:-:Ana"
val "H2 the service key keeps the share it sends, and nobody else's share moves" \
  "$(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R1', '$EVA', '$ANA', 30);" "$(splits $R1)")" \
  "Beto:50.00:pending:false:false:-:Ana,Eva:30.00:pending:false:false:-:Ana"
err "H3 the service key is still held to 100%" \
  "$(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R1', '$EVA', '$ANA', 60);" "SELECT 1")" \
  "23514: Las partes de este viaje no pueden sumar más del 100% \(ya hay 50\.00%\)\.;DETAIL:  split_over_100"
val "H4 end to end: three people split 1000 TRC, 333 and 333 for the invitees (the requester pays 334)" \
  "$(as $ANA "$(invite $R2 $EVA 50) $(invite $R2 $BETO 33.33)
     $(sub $EVA) UPDATE public.ride_splits SET accepted_at = now() WHERE ride_id = '$R2' AND user_id = '$EVA' AND accepted_at IS NULL;
     $(sub $BETO) UPDATE public.ride_splits SET accepted_at = now() WHERE ride_id = '$R2' AND user_id = '$BETO' AND accepted_at IS NULL;
     $(sub $DANI) SELECT public.sim_pay_splits('$R2', 1000);" "$(splits $R2)")" \
  "Beto:33.33:paid:true:true:333:Ana,Eva:33.33:paid:true:true:333:Ana"

echo "== two invites at the same time =="
r=$(race $DB)
[ "$r" = "committed|Beto:33.33:pending:false:false:-:Ana,Eva:33.33:pending:false:false:-:Ana" ] \
  && ok "C1 the second invite waits for the first, and both end at a third" \
  || ko "C1 the second invite waits for the first, and both end at a third" "got [$r]"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
def cut(name, old, new=''):
    assert s.count(old) == 1, name
    s2 = s.replace(old, new); assert s2 != s, name
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(s2)
cut('no_lock', "      PERFORM 1 FROM public.rides WHERE id = NEW.ride_id FOR UPDATE; -- serializes invites\n")
cut('no_lowering', "        UPDATE public.ride_splits SET share_pct = v_share\n        WHERE ride_id = NEW.ride_id AND share_pct > v_share;\n")
cut('no_flag', "\n               OR coalesce(current_setting('app.ride_splits_rebalance', true), '') = '1'")
cut('no_restore', "        PERFORM set_config('app.ride_splits_rebalance', coalesce(v_prev, ''), true);\n")
cut('no_paid_check', "(payment_status <> 'pending' OR paid_at IS NOT NULL)", "false")
PYEOF
  # proof NAME FILE SQL EXPECTED -> on a fresh database with FILE applied, SQL must print EXPECTED
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/no_lock.sql")
  if [ "$r" = applied ]; then
    r=$(race ${DB}g)
    [ "$r" = "committed|Beto:50.00:pending:false:false:-:Ana,Eva:50.00:pending:false:false:-:Ana" ] \
      && ok "N1 without the lock, two invites at once both take half and the requester pays nothing (so C1 tests it)" \
      || ko "N1 without the lock, two invites at once both take half and the requester pays nothing (so C1 tests it)" "got [$r]"
  else ko "N1 without the lock, two invites at once both take half and the requester pays nothing (so C1 tests it)" "apply: $r"; fi
  proof "N2 without the lowering UPDATE, the first invitee keeps 50% (so E2 tests it)" "$T/no_lowering.sql" \
    "$E2_SQL" "Beto:33.33:pending:false:false:-:Ana,Eva:50.00:pending:false:false:-:Ana"
  proof "N3 if the guard does not trust its own flag, it reverts the lowering (so E2 tests it)" "$T/no_flag.sql" \
    "$E2_SQL" "Beto:33.33:pending:false:false:-:Ana,Eva:50.00:pending:false:false:-:Ana"
  proof "N4 without restoring the flag, the next insert of the transaction keeps forged values (so E10 tests it)" "$T/no_restore.sql" \
    "$E10_SQL" "1|Beto:40.00:paid:true:false:-:Cora,Eva:50.00:pending:false:false:-:Ana"
  proof "N5 without the paid check, a paid split is re-priced (so E8 tests it)" "$T/no_paid_check.sql" \
    "$E8_SQL" "Beto:33.33:paid:true:true:2500:Ana,Eva:33.33:pending:false:false:-:Ana"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; DO \$e\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_ride_splits_guard()'::regprocedure),
    '-- For everyone', '-- Edited elsewhere. For everyone'); END \$e\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00613: unexpected body of tg_ride_splits_guard" \
    && ok "N6 a guard body it does not know is not replaced" || ko "N6 a guard body it does not know is not replaced" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
