#!/usr/bin/env bash
# Rehearsal runner for migration 00614 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00614/run.sh none
#       -> prod as of 2026-10-06 (00612 scaffold + 00612 + 00613 + the 00613 seed) + tests
#          (RED: the invitee's "Rechazar" deletes 0 rows)
#   supabase/tests/00614/run.sh supabase/migrations/00614_ride_splits_invitee_can_decline.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00614/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
M612="$DIR/../../migrations/00612_client_writes_split_docs_test_flag.sql"
M613="$DIR/../../migrations/00613_ride_splits_equal_shares.sql"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr614
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql ends its
# lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines are dropped.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, asks for the rides and invites
BETO=b0000000-0000-4000-8000-000000000002   # customer, invited on R1, R3 and R4
CORA=c0000000-0000-4000-8000-000000000003   # admin
DANI=d0000000-0000-4000-8000-000000000004   # driver of every ride
EVA=e0000000-0000-4000-8000-000000000005    # customer, invited on R3
GABI=09000000-0000-4000-8000-000000000007   # customer
R1=f1000000-0000-4000-8000-000000000001     # accepted, Beto invited at 50%, not answered
R3=f3000000-0000-4000-8000-000000000003     # accepted, Beto 50% and Eva 33.33%, not answered
R4=f4000000-0000-4000-8000-000000000004     # accepted, Beto at 50% already paid
S1=51000000-0000-4000-8000-000000000001     # Beto's split on R1

# Each split prints invitee:share:payment_status:accepted:paid
splits(){ echo "SELECT string_agg(u.full_name || ':' || s.share_pct || ':' || s.payment_status || ':' || (s.accepted_at IS NOT NULL)
  || ':' || (s.paid_at IS NOT NULL), ',' ORDER BY u.full_name)
  FROM public.ride_splits s JOIN public.users u ON u.id = s.user_id WHERE s.ride_id = '$1'"; }
# deleted WHERE -> a DELETE that prints how many rows it removed
deleted(){ echo "WITH d AS (DELETE FROM public.ride_splits WHERE $1 RETURNING 1) SELECT count(*) FROM d;"; }
# The rider app's and the web's "Rechazar" until this PR: rideService.removeSplitInvite(rideId, splitId)
OLD_DECLINE="$(deleted "id = '$S1' AND ride_id = '$R1'")"
# The new rideService.declineSplitInvite(splitId, userId)
NEW_DECLINE="$(deleted "id = '$S1' AND user_id = '$BETO' AND accepted_at IS NULL")"
ACCEPT_S1="UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1' AND user_id = '$BETO' AND accepted_at IS NULL;"
# as UID SQL CHECK -> SQL as authenticated with JWT subject UID (as PostgREST would), then CHECK, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2" "$3"; }
# anon SQL CHECK -> SQL as anon with no JWT (the publishable key alone), then CHECK, rolled back
anon(){ printf "BEGIN; SET LOCAL ROLE anon; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2"; }
# svc SQL -> SQL as service_role with no JWT (Edge Functions, cron), inside the caller's transaction
svc(){ printf "SET LOCAL ROLE service_role; %s RESET ROLE;" "$1"; }
# fresh DBNAME -> a new database as prod is today: the 00612 scaffold, 00612, 00613 and its seed,
# plus SELECT on rides for anon (prod grants it; split_delete reads rides)
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00612/scaffold.sql" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M612" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M613" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00613/seed.sql" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER; GRANT SELECT ON public.rides TO anon" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# race DBNAME -> Beto accepts S1 in one session and, while that transaction is still open, taps
# "Rechazar" (the old app's DELETE, which does not filter on accepted_at) in another. Prints how
# many rows the DELETE removed and what R1 kept, then restores S1.
race(){ local a n
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$BETO'; SET LOCAL ROLE authenticated;
    $ACCEPT_S1 SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.5
  n=$($BIN/psql $CONN -d "$1" -qAt -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$BETO'; SET LOCAL ROLE authenticated;
    $OLD_DECLINE COMMIT;" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  wait $a
  echo "$n|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R1)" 2>&1 | tr -d '\r')"
  $BIN/psql $CONN -d "$1" -qAt -c "DELETE FROM public.ride_splits WHERE ride_id = '$R1';
    INSERT INTO public.ride_splits (id, ride_id, user_id, share_pct, invited_by) VALUES ('$S1', '$R1', '$BETO', 50, '$ANA');" >/dev/null 2>&1; }

# Statements reused by the negative proofs
D4_SQL="$(as $BETO "$ACCEPT_S1 $OLD_DECLINE" "$(splits $R1)")"
D6_SQL="$(as $EVA "$OLD_DECLINE" "$(splits $R1)")"
# The requester sees the invite but, once the trip started, split_delete no longer lets them remove it
D14_SQL="BEGIN; UPDATE public.rides SET status = 'in_progress' WHERE id = '$R1';
  SET LOCAL request.jwt.claim.sub = '$ANA'; SET LOCAL ROLE authenticated; $OLD_DECLINE RESET ROLE; ROLLBACK;"
# Gabi's invite on R4 that a service-side writer marked paid without accepted_at, and one marked
# with paid_at but still 'pending': neither should ever exist, and neither may be declined.
D7_SQL="BEGIN; $(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, payment_status, paid_at)
    VALUES ('$R4', '$GABI', '$ANA', 10, 'paid', NULL);")
  SET LOCAL request.jwt.claim.sub = '$GABI'; SET LOCAL ROLE authenticated;
  $(deleted "ride_id = '$R4' AND user_id = '$GABI'") RESET ROLE; ROLLBACK;"
D8_SQL="BEGIN; $(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, paid_at)
    VALUES ('$R4', '$GABI', '$ANA', 10, now());")
  SET LOCAL request.jwt.claim.sub = '$GABI'; SET LOCAL ROLE authenticated;
  $(deleted "ride_id = '$R4' AND user_id = '$GABI'") RESET ROLE; ROLLBACK;"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the guard carries the live prod body (00613)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure" \
  "43e9014cc1d383d833806df8a4a66500/3221"
val "S1 seed: R1 Beto pending; R3 Beto and Eva pending; R4 Beto paid" \
  "$(splits $R1); $(splits $R3); $(splits $R4)" \
  "Beto:50.00:pending:false:false;Beto:50.00:pending:false:false,Eva:33.33:pending:false:false;Beto:50.00:paid:true:true"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 one new DELETE policy, for authenticated only; the requester's is unchanged" \
    "SELECT string_agg(policyname || ' ' || roles::text, ',' ORDER BY policyname) FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'ride_splits' AND cmd = 'DELETE'" \
    "split_delete {public},split_delete_invitee {authenticated}"
  val "M2 the other policies of ride_splits are untouched" \
    "SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ride_splits'" \
    "split_delete,split_delete_invitee,split_insert,split_select,split_update"
fi

echo "== the invitee declines =="
val "D1 with the app's DELETE until now (id and ride), the invite is gone" \
  "$(as $BETO "$OLD_DECLINE" "$(splits $R1)")" "1"
val "D2 with the new service's DELETE (id, user and unanswered), the invite is gone" \
  "$(as $BETO "$NEW_DECLINE" "$(splits $R1)")" "1"
val "D3 declining raises nobody: Eva keeps 33.33% and the requester pays Beto's part" \
  "$(as $BETO "$(deleted "ride_id = '$R3' AND user_id = '$BETO'")" "$(splits $R3)")" \
  "1;Eva:33.33:pending:false:false"
val "D4 an accepted invite cannot be declined any more" \
  "$D4_SQL" "0;Beto:50.00:pending:true:false"
val "D5 a paid split cannot be deleted" \
  "$(as $BETO "$(deleted "ride_id = '$R4' AND user_id = '$BETO'")" "$(splits $R4)")" \
  "0;Beto:50.00:paid:true:true"
val "D6 nobody declines someone else's invite (split_select hides it from them too)" \
  "$D6_SQL" "0;Beto:50.00:pending:false:false"
val "D7 a split marked paid is kept even without accepted_at" "$D7_SQL" "0"
val "D8 a split with paid_at is kept even while 'pending'" "$D8_SQL" "0"
val "D9 the driver of the ride cannot delete it" \
  "$(as $DANI "$OLD_DECLINE" "$(splits $R1)")" "0;Beto:50.00:pending:false:false"
val "D10 the publishable key alone cannot delete it" \
  "$(anon "$OLD_DECLINE" "$(splits $R1)")" "0;Beto:50.00:pending:false:false"
val "D11 the invitee can decline after the trip started (an unanswered invite is never charged)" \
  "BEGIN; UPDATE public.rides SET status = 'in_progress' WHERE id = '$R1';
   SET LOCAL request.jwt.claim.sub = '$BETO'; SET LOCAL ROLE authenticated; $OLD_DECLINE RESET ROLE; ROLLBACK;" "1"
val "D12 the requester still withdraws an invite" \
  "$(as $ANA "$OLD_DECLINE" "$(splits $R1)")" "1"
val "D13 the old app's follow-up (no splits left → is_split = false) does not touch the requester's ride" \
  "$(as $BETO "$OLD_DECLINE UPDATE public.rides SET is_split = false WHERE id = '$R1';" \
     "SELECT is_split FROM public.rides WHERE id = '$R1'")" "1;t"

val "D14 the new policy does not widen the requester's window: once the trip started they cannot remove the invite" \
  "$D14_SQL" "0"

echo "== accept and decline at the same time =="
r=$(race $DB)
[ "$r" = "0|Beto:50.00:pending:true:false" ] \
  && ok "C1 a decline that waits for an accept sees it accepted and deletes nothing" \
  || ko "C1 a decline that waits for an accept sees it accepted and deletes nothing" "got [$r]"

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
policy = "      USING (user_id = (SELECT auth.uid())\n             AND accepted_at IS NULL\n             AND paid_at IS NULL\n             AND payment_status = 'pending');\n"
assert s.count(policy) == 1
def cut_policy(name, old, new):
    s2 = s.replace(policy, policy.replace(old, new)); assert s2 != s, name
    open(f'{out}/{name}.pol', 'w', encoding='utf-8').write(s2)
cut_policy('no_owner', "user_id = (SELECT auth.uid())\n             AND ", "")
cut_policy('no_accepted', "\n             AND accepted_at IS NULL", "")
cut_policy('no_paid_at', "\n             AND paid_at IS NULL", "")
cut_policy('no_status', "\n             AND payment_status = 'pending'", "")
PYEOF
  # proof NAME FILE SQL EXPECTED -> on a fresh database where FILE's policy was created without the
  # migration's check (the check would reject it), SQL must print EXPECTED
  proof(){ local r body; fresh ${DB}g
    body=$("$PY" -c "import sys,re; s=open(sys.argv[1],encoding='utf-8').read(); print(re.search(r'\\\$policy\\\$\n(.*?)\n\\\$policy\\\$', s, re.S).group(1))" "$2")
    r=$(run ${DB}g "$AS_OWNER; DO \$p\$ $body \$p\$;")
    if [ -z "$r" ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "create: $r"; fi; }
  proof "N1 without the owner check, the requester removes an invite after the trip started (so D14 tests it)" \
    "$T/no_owner.pol" "$D14_SQL" "1"
  proof "N2 without the accepted_at check, an accepted invite is deleted and escapes the charge (so D4 tests it)" \
    "$T/no_accepted.pol" "$D4_SQL" "1"
  r=$(race ${DB}g)
  [ "$r" = "1|" ] \
    && ok "N2b without the accepted_at check, a decline racing an accept deletes it (so C1 tests it)" \
    || ko "N2b without the accepted_at check, a decline racing an accept deletes it (so C1 tests it)" "got [$r]"
  proof "N3 without the paid_at check, a split with paid_at is deleted (so D8 tests it)" "$T/no_paid_at.pol" \
    "$D8_SQL" "1"
  proof "N4 without the status check, a split marked paid is deleted (so D7 tests it)" "$T/no_status.pol" \
    "$D7_SQL" "1"
  for f in no_owner no_accepted no_paid_at no_status; do
    fresh ${DB}g
    body=$("$PY" -c "import sys,re; s=open(sys.argv[1],encoding='utf-8').read(); print(re.search(r'\\\$policy\\\$\n(.*?)\n\\\$policy\\\$', s, re.S).group(1))" "$T/$f.pol")
    run ${DB}g "$AS_OWNER; DO \$p\$ $body \$p\$;" >/dev/null
    r=$(apply_err ${DB}g "$MIG")
    echo "$r" | grep -q "00614: split_delete_invitee has an unexpected condition" \
      && ok "N5 a policy of that name without the $f part is not accepted" \
      || ko "N5 a policy of that name without the $f part is not accepted" "$r"
  done
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE POLICY split_delete_invitee ON public.ride_splits FOR DELETE
    USING (user_id = (SELECT auth.uid()) AND accepted_at IS NULL AND paid_at IS NULL AND payment_status = 'pending');" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00614: split_delete_invitee is missing or not a permissive DELETE policy for authenticated" \
    && ok "N6 a policy of that name for every role (anon included) is not accepted" \
    || ko "N6 a policy of that name for every role (anon included) is not accepted" "$r"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE POLICY split_delete_invitee ON public.ride_splits FOR DELETE TO authenticated
    USING (user_id = (SELECT auth.uid()) AND accepted_at IS NULL AND paid_at IS NULL AND payment_status = 'pending' OR true);" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00614: split_delete_invitee has an unexpected condition" \
    && ok "N7 a policy of that name with an extra OR is not accepted" \
    || ko "N7 a policy of that name with an extra OR is not accepted" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
