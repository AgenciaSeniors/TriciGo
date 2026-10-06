#!/usr/bin/env bash
# Rehearsal runner for migration 00616 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00616/run.sh none
#       -> prod as of 2026-10-06 (00612 scaffold + 00612 + 00613 + 00614 + the 00613 seed) + tests
#          (RED: the invitee's card cannot list anything, and invites nobody answered outlive the ride)
#   supabase/tests/00616/run.sh supabase/migrations/00616_ride_splits_invitee_card.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00616/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
M612="$DIR/../../migrations/00612_client_writes_split_docs_test_flag.sql"
M613="$DIR/../../migrations/00613_ride_splits_equal_shares.sql"
M614="$DIR/../../migrations/00614_ride_splits_invitee_can_decline.sql"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr616
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql ends its
# lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines are dropped.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED [DBNAME] -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, asks for every ride
BETO=b0000000-0000-4000-8000-000000000002   # customer, invited on R1, R3 and R4
CORA=c0000000-0000-4000-8000-000000000003   # admin
DANI=d0000000-0000-4000-8000-000000000004   # driver of every ride
EVA=e0000000-0000-4000-8000-000000000005    # customer, invited on R3
GABI=09000000-0000-4000-8000-000000000007   # customer
R1=f1000000-0000-4000-8000-000000000001     # accepted, Beto invited at 50%, not answered
R3=f3000000-0000-4000-8000-000000000003     # accepted, Beto 50% and Eva 33.33%, not answered
R4=f4000000-0000-4000-8000-000000000004     # accepted, Beto at 50% already paid

# Each split prints invitee:share:payment_status:accepted:paid
splits(){ echo "SELECT string_agg(u.full_name || ':' || s.share_pct || ':' || s.payment_status || ':' || (s.accepted_at IS NOT NULL)
  || ':' || (s.paid_at IS NOT NULL), ',' ORDER BY u.full_name)
  FROM public.ride_splits s JOIN public.users u ON u.id = s.user_id WHERE s.ride_id = '$1'"; }
# status RIDE STATUS -> the ride moves to STATUS (the app, an RPC or a cron)
status(){ echo "UPDATE public.rides SET status = '$2' WHERE id = '$1';"; }
# accept RIDE -> the invitee's app accepts their invite on RIDE (acceptSplitInvite)
accept(){ echo "UPDATE public.ride_splits SET accepted_at = now() WHERE ride_id = '$1' AND user_id = auth.uid() AND accepted_at IS NULL;"; }
# MINE -> how many invite cards the caller's app shows (getMySplitInvites -> get_my_split_invites)
MINE="SELECT count(*) FROM public.get_my_split_invites();"
# CARD -> what the caller's cards show: inviter:share:ride status:pickup:fare
CARD="SELECT string_agg(coalesce(inviter_name, '-') || ':' || share_pct || ':' || ride_status || ':' || pickup_address
  || ':' || coalesce(estimated_fare_trc::text, '-'), ',' ORDER BY pickup_address) FROM public.get_my_split_invites();"
# as UID SQL CHECK -> SQL as authenticated with JWT subject UID (as PostgREST would), then CHECK, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2" "$3"; }
# asq UID SQL -> SQL as authenticated with JWT subject UID, printing its rows, rolled back
asq(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
# sub UID -> switch the JWT subject inside a transaction
sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# svc SQL -> SQL as service_role with no JWT (Edge Functions, cron), inside the caller's transaction
svc(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role; %s RESET ROLE;" "$1"; }
# fresh DBNAME -> a new database as prod is today: the 00612 scaffold, 00612, 00613, 00614 and the
# 00613 seed, plus prod's driver policies on rides (r_select_driver without the offers branch, r_update)
# and the ride and user columns the invitee's card reads (pickup "Calle f1", fare 1000 × the ride number)
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00612/scaffold.sql" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M612" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M613" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M614" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/../00613/seed.sql" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER;
           CREATE POLICY r_select_driver ON public.rides FOR SELECT USING (driver_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.user_id = (SELECT auth.uid())));
           CREATE POLICY r_update ON public.rides FOR UPDATE USING (customer_id = (SELECT auth.uid())
             OR driver_id IN (SELECT dp.id FROM public.driver_profiles dp WHERE dp.user_id = (SELECT auth.uid())) OR public.is_admin());
           ALTER TABLE public.rides ADD COLUMN pickup_address text NOT NULL DEFAULT '',
             ADD COLUMN dropoff_address text NOT NULL DEFAULT '', ADD COLUMN estimated_fare_trc integer;
           ALTER TABLE public.users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
           UPDATE public.rides SET pickup_address = 'Calle ' || left(id::text, 2), dropoff_address = 'Destino ' || left(id::text, 2),
             estimated_fare_trc = 1000 * (ascii(substr(id::text, 2, 1)) - 48);" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# race DBNAME HOLD -> Beto accepts his invite on R1 and keeps that transaction open HOLD seconds;
# 0.4 s in, Dani completes R1. Prints whether the completion committed, whether it finished before
# Beto's commit, the ride's status and R1's splits.
race(){ local a t0 t1 res when
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; $(sub $BETO) SET LOCAL ROLE authenticated; $(accept $R1)
    SELECT pg_sleep($2); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.4; t0=$(date +%s.%N)
  if $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "BEGIN; $(sub $DANI) SET LOCAL ROLE authenticated; $(status $R1 completed) COMMIT;" >/dev/null 2>&1
  then res=committed; else res=failed; fi
  t1=$(date +%s.%N); wait $a
  when=$("$PY" -c "import sys; print('before_accept_commit' if float(sys.argv[2]) - float(sys.argv[1]) < float(sys.argv[3]) - 0.6 else 'after_accept_commit')" "$t0" "$t1" "$2")
  echo "$res|$when|$($BIN/psql $CONN -d "$1" -qAt -c "SELECT status FROM public.rides WHERE id = '$R1'" 2>&1 | tr -d '\r')|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R1)" 2>&1 | tr -d '\r')"; }

# Statements reused by the negative proofs
E1_SQL="$(as $BETO "$(accept $R3) $(sub $DANI) $(status $R3 completed)" "$(splits $R3)")"
E8_SQL="BEGIN; $(svc "$(status $R4 completed)
  INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R4', '$GABI', '$ANA', 10);
  $(status $R4 disputed)") $(splits $R4); ROLLBACK;"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 the guard and the decline policy are prod's (00613, 00614)" \
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure;
   SELECT count(*) FROM pg_policies WHERE tablename = 'ride_splits' AND policyname = 'split_delete_invitee'" \
  "43e9014cc1d383d833806df8a4a66500;1"
val "S1 seed: R1 Beto pending; R3 Beto and Eva pending; R4 Beto paid" \
  "$(splits $R1); $(splits $R3); $(splits $R4)" \
  "Beto:50.00:pending:false:false;Beto:50.00:pending:false:false,Eva:33.33:pending:false:false;Beto:50.00:paid:true:true"

val "S2 the apps' query today (ride_splits with rides!inner): the invitee sees the split but never its ride" \
  "$(asq $BETO "SELECT count(*) FROM public.ride_splits WHERE user_id = '$BETO';
     SELECT count(*) FROM public.ride_splits s JOIN public.rides r ON r.id = s.ride_id WHERE s.user_id = '$BETO';")" "3;0"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN_T=$(grep -oE "'[0-9a-f]{32}' THEN -- 00616 trigger" "$MIG" | grep -oE '[0-9a-f]{32}')
  OWN_I=$(grep -oE "'[0-9a-f]{32}' THEN -- 00616 invites" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the bodies the migration accepts as its own are the ones it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_rides_drop_unanswered_split_invites()'::regprocedure;
     SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_my_split_invites()'::regprocedure" "$OWN_T;$OWN_I"
  val "M2 one trigger, after a status change to an end state" \
    "SELECT string_agg(pg_get_triggerdef(oid), ';') FROM pg_trigger WHERE tgname = 'trg_rides_drop_unanswered_split_invites'" \
    "CREATE TRIGGER trg_rides_drop_unanswered_split_invites AFTER UPDATE OF status ON public.rides FOR EACH ROW WHEN (((new.status = ANY (ARRAY['completed'::ride_status, 'canceled'::ride_status, 'disputed'::ride_status])) AND (old.status <> ALL (ARRAY['completed'::ride_status, 'canceled'::ride_status, 'disputed'::ride_status])))) EXECUTE FUNCTION tg_rides_drop_unanswered_split_invites()"
  val "M3 clients cannot call the trigger function; only signed-in users list their invites" \
    "SELECT has_function_privilege('anon', 'public.tg_rides_drop_unanswered_split_invites()', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.tg_rides_drop_unanswered_split_invites()', 'EXECUTE') || ' ' ||
            has_function_privilege('anon', 'public.get_my_split_invites()', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.get_my_split_invites()', 'EXECUTE')" "false/false false/true"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M4 lock_timeout and search_path do not outlive the file" \
    || ko "M4 lock_timeout and search_path do not outlive the file" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== the invitee's card =="
val "F1 the invitee sees their open invites of rides in progress, with what the card shows (not the paid one)" \
  "$(asq $BETO "$CARD")" "Ana:50.00:accepted:Calle f1:1000,Ana:50.00:accepted:Calle f3:3000"
val "F2 an invite accepted from the card leaves the list" \
  "$(asq $BETO "$(accept $R1) $MINE")" "1"
val "F3 each user sees only their own invites: Eva hers, Ana none" \
  "$(asq $EVA "$MINE") $(asq $ANA "$MINE")" "1;0"
val "F4 an invite of a ride that already ended is not listed, even one added after the end" \
  "BEGIN; $(svc "$(status $R4 completed)
    INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R4', '$GABI', '$ANA', 10);")
   $(sub $GABI) SET LOCAL ROLE authenticated; $MINE ROLLBACK;" "0"
val "F5 without a session the list is empty; without a name the card leaves it out" \
  "$(asq "" "$MINE") BEGIN; UPDATE public.users SET is_active = false WHERE id = '$ANA';
   $(sub $BETO) SET LOCAL ROLE authenticated; SELECT string_agg(coalesce(inviter_name, '-'), ',') FROM public.get_my_split_invites(); ROLLBACK;" \
  "0;-,-"

echo "== a ride that ends drops the invites nobody answered =="
val "E1 the driver completes the ride: the accepted invite stays, the unanswered one goes" \
  "$E1_SQL" "Beto:50.00:pending:true:false"
val "E2 after payment: the paid split stays with its amount marks, the unanswered one goes" \
  "$(as $BETO "$(accept $R3) $(sub $DANI) SELECT public.sim_pay_splits('$R3', 1000); $(status $R3 completed)" "$(splits $R3)")" \
  "Beto:50.00:paid:true:true"
val "E3 the rider cancels: the invite goes" \
  "$(as $ANA "$(status $R1 canceled)" "$(splits $R1)")" ""
val "E4 a cron cancels (service role, no JWT): the invite goes" \
  "BEGIN; $(svc "$(status $R1 canceled)") $(splits $R1); ROLLBACK;" ""
val "E5 an admin moves the ride to disputed: the invite goes" \
  "$(as $CORA "$(status $R1 disputed)" "$(splits $R1)")" ""
val "E6 the ride moving along keeps the invite: it can still be accepted and charged" \
  "$(as $DANI "$(status $R1 driver_en_route) $(status $R1 arrived_at_pickup) $(status $R1 in_progress) $(status $R1 arrived_at_destination)" "$(splits $R1)")" \
  "Beto:50.00:pending:false:false"
val "E7 ending one ride leaves the invites of others" \
  "$(as $DANI "$(status $R3 completed)" "$(splits $R1); $(splits $R3)")" \
  "Beto:50.00:pending:false:false"
val "E8 a later change between end states drops nothing (an invite added after the end stays)" \
  "$E8_SQL" "Beto:50.00:paid:true:true,Gabi:10.00:pending:false:false"
val "E9 the invitee's card stops listing the invite of the ride that ended" \
  "$(as $BETO "$MINE $(sub $DANI) $(status $R3 completed) $(sub $BETO) $MINE" "SELECT 'ok'")" "2;1;ok"

echo "== an accept at the same time as the completion =="
# fresh_mig DBNAME -> fresh, plus the migration under test (if any)
fresh_mig(){ fresh "$1" && { [ "$MIG" = none ] || [ "$(apply_err "$1" "$MIG")" = applied ]; }; }
fresh_mig ${DB}r || ko "C0 race database" "setup failed"
r=$(race ${DB}r 1)
[ "$r" = "committed|after_accept_commit|completed|Beto:50.00:pending:true:false" ] \
  && ok "C1 the completion waits for an accept in flight, and keeps it" \
  || ko "C1 the completion waits for an accept in flight, and keeps it" "got [$r]"
fresh_mig ${DB}r || ko "C0 race database" "setup failed"
r=$(race ${DB}r 3)
[ "$r" = "committed|before_accept_commit|completed|Beto:50.00:pending:true:false" ] \
  && ok "C2 the completion never waits more than 2 s for it, and still completes" \
  || ko "C2 the completion never waits more than 2 s for it, and still completes" "got [$r]"
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}r" >/dev/null 2>&1

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import re, sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
check = s[s.index('DO $check$'):s.index('$check$;') + len('$check$;')]
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('no_definer', (" LANGUAGE plpgsql\n SECURITY DEFINER\n", " LANGUAGE plpgsql\n"), (check, ""))
variant('card_no_definer', (" STABLE SECURITY DEFINER\n", " STABLE\n"), (check, ""))
variant('card_no_user', ("WHERE s.user_id = (SELECT auth.uid())\n    AND s.accepted_at IS NULL", "WHERE s.accepted_at IS NULL"))
variant('card_no_status', ("""    AND r.status IN ('searching', 'accepted', 'driver_en_route', 'arrived_at_pickup',
                     'in_progress', 'arrived_at_destination')
""", ""))
variant('card_no_accepted', ("\n    AND s.accepted_at IS NULL", ""))
variant('card_no_revoke', ("REVOKE ALL ON FUNCTION public.get_my_split_invites() FROM PUBLIC, anon;\n", ""))
variant('no_accepted', ("\n      AND accepted_at IS NULL", ""))
variant('no_old', ("\n            AND OLD.status NOT IN ('completed', 'canceled', 'disputed')", ""), (check, ""))
variant('no_exception', ("""  BEGIN
    DELETE FROM public.ride_splits
    WHERE ride_id = NEW.id
      AND accepted_at IS NULL
      AND paid_at IS NULL
      AND payment_status = 'pending';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '00616: unanswered split invites of ride % kept: % %', NEW.id, SQLSTATE, SQLERRM;
  END;
""", """  DELETE FROM public.ride_splits
  WHERE ride_id = NEW.id
    AND accepted_at IS NULL
    AND paid_at IS NULL
    AND payment_status = 'pending';
"""))
variant('no_lock_timeout', (" SET lock_timeout TO '2s'\n", ""))
PYEOF
  # proof NAME FILE SQL EXPECTED -> on a fresh database with FILE applied, SQL must print EXPECTED
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  proof "N1 without SECURITY DEFINER, the driver's completion cannot drop Eva's invite (so E1 tests it)" \
    "$T/no_definer.sql" "$E1_SQL" "Beto:50.00:pending:true:false,Eva:33.33:pending:false:false"
  proof "N2 without the accepted_at check, the accepted invite goes too (so E1 tests it)" \
    "$T/no_accepted.sql" "$E1_SQL" ""
  proof "N3 without the OLD check, a change between end states drops the late invite (so E8 tests it)" \
    "$T/no_old.sql" "$E8_SQL" "Beto:50.00:paid:true:true"
  proof "N8 without SECURITY DEFINER, the invitee cannot read the ride and the card is empty (so F1 tests it)" \
    "$T/card_no_definer.sql" "$(asq $BETO "$CARD")" ""
  proof "N9 without the user filter, a caller lists other people's invites (so F3 tests it)" \
    "$T/card_no_user.sql" "$(asq $EVA "$MINE") $(asq $ANA "$MINE")" "3;3"
  proof "N10 without the ride status filter, an invite of an ended ride is listed (so F4 tests it)" \
    "$T/card_no_status.sql" "BEGIN; $(svc "$(status $R4 completed)
      INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R4', '$GABI', '$ANA', 10);")
     $(sub $GABI) SET LOCAL ROLE authenticated; $MINE ROLLBACK;" "1"
  proof "N11 without the accepted_at filter, an accepted invite stays listed (so F2 tests it)" \
    "$T/card_no_accepted.sql" "$(asq $BETO "$(accept $R1) $MINE")" "2"
  fresh ${DB}g
  r=$(apply_err ${DB}g "$T/card_no_revoke.sql")
  echo "$r" | grep -q "00616: get_my_split_invites must be callable by signed-in users only" \
    && ok "N12 the migration refuses to finish if anon can list invites" || ko "N12 the migration refuses to finish if anon can list invites" "$r"
  # raceproof NAME FILE HOLD EXPECTED
  raceproof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(race ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  raceproof "N4 without the exception block, an accept in flight makes the completion fail (so C2 tests it)" \
    "$T/no_exception.sql" 3 "failed|before_accept_commit|accepted|Beto:50.00:pending:true:false"
  raceproof "N5 without lock_timeout, the completion waits the whole accept (so C2 tests it)" \
    "$T/no_lock_timeout.sql" 3 "committed|after_accept_commit|completed|Beto:50.00:pending:true:false"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE FUNCTION public.tg_rides_drop_unanswered_split_invites() RETURNS trigger
    LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NULL; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00616: unexpected body of tg_rides_drop_unanswered_split_invites" \
    && ok "N6 a function body it does not know is not replaced" || ko "N6 a function body it does not know is not replaced" "$r"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE FUNCTION public.x_other() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NULL; END \$f\$;
    CREATE TRIGGER trg_rides_drop_unanswered_split_invites AFTER UPDATE ON public.rides
    FOR EACH ROW EXECUTE FUNCTION public.x_other();" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00616: trg_rides_drop_unanswered_split_invites is missing or different" \
    && ok "N7 a trigger of that name with another definition is not accepted" \
    || ko "N7 a trigger of that name with another definition is not accepted" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
