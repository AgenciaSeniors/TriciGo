#!/usr/bin/env bash
# Rehearsal runner for migration 00617 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00617/run.sh none
#       -> prod as of 2026-10-06 (00612 scaffold + 00612 + 00613 + 00614 + the 00613 seed + 00616) + tests
#          (RED: a decline racing an invite is counted by the invite, and there is no decline function)
#   supabase/tests/00617/run.sh supabase/migrations/00617_ride_splits_decline_takes_ride_lock.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migrations are applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00617/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
M612="$DIR/../../migrations/00612_client_writes_split_docs_test_flag.sql"
M613="$DIR/../../migrations/00613_ride_splits_equal_shares.sql"
M614="$DIR/../../migrations/00614_ride_splits_invitee_can_decline.sql"
M616="$DIR/../../migrations/00616_ride_splits_invitee_card.sql"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
# The SQL files are UTF-8. psql on Windows otherwise reads them in the console code page
# when its output is redirected, and "más" in the guard comes out one character longer.
export PGCLIENTENCODING=UTF8
DB=pr617
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql ends its
# lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines are dropped.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED [DBNAME] -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# err NAME SQL PATTERN [DBNAME] -> the statements must fail with an error matching PATTERN
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, asks for every ride and invites
BETO=b0000000-0000-4000-8000-000000000002   # customer, invited on R1, R3 and R4
DANI=d0000000-0000-4000-8000-000000000004   # driver of every ride
EVA=e0000000-0000-4000-8000-000000000005    # customer, invited on R3
FEDE=0f000000-0000-4000-8000-000000000006   # customer, invited by Ana in the races
GABI=09000000-0000-4000-8000-000000000007   # customer
R1=f1000000-0000-4000-8000-000000000001     # accepted, Beto invited at 50%, not answered
R3=f3000000-0000-4000-8000-000000000003     # accepted, Beto 50% and Eva 33.33%, not answered
R4=f4000000-0000-4000-8000-000000000004     # accepted, Beto at 50% already paid
S1=51000000-0000-4000-8000-000000000001     # Beto's split on R1

# Each split prints invitee:share:payment_status:accepted:paid
splits(){ echo "SELECT string_agg(u.full_name || ':' || s.share_pct || ':' || s.payment_status || ':' || (s.accepted_at IS NOT NULL)
  || ':' || (s.paid_at IS NOT NULL), ',' ORDER BY u.full_name)
  FROM public.ride_splits s JOIN public.users u ON u.id = s.user_id WHERE s.ride_id = '$1'"; }
# split_of RIDE USER -> the id of USER's split on RIDE
split_of(){ echo "(SELECT id FROM public.ride_splits WHERE ride_id = '$1' AND user_id = '$2')"; }
# decline RIDE -> the caller declines their invite on RIDE the way the app does: through
# decline_split_invite when it exists (00617), else with 00614's direct DELETE (the fallback)
decline(){ if [ "$MIG" = none ]; then
    echo "WITH d AS (DELETE FROM public.ride_splits WHERE ride_id = '$1' AND user_id = auth.uid() AND accepted_at IS NULL RETURNING 1)
          SELECT CASE WHEN count(*) > 0 THEN 'declined' ELSE 'none' END FROM d;"
  else echo "SELECT public.decline_split_invite((SELECT id FROM public.ride_splits WHERE ride_id = '$1' AND user_id = auth.uid()));"; fi; }
# invite RIDE USER -> the app's exact insert (createSplitInvite), as the requester
invite(){ echo "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$1', '$2', '$ANA', 10);"; }
# accept RIDE -> the invitee accepts their invite on RIDE (acceptSplitInvite)
accept(){ echo "UPDATE public.ride_splits SET accepted_at = now() WHERE ride_id = '$1' AND user_id = auth.uid() AND accepted_at IS NULL;"; }
# status RIDE STATUS -> the ride moves to STATUS
status(){ echo "UPDATE public.rides SET status = '$2' WHERE id = '$1';"; }
# sub UID -> set the JWT subject inside a transaction
sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# as UID SQL CHECK -> SQL as authenticated with JWT subject UID (as PostgREST would), then CHECK, rolled back
as(){ printf "BEGIN; %s SET LOCAL ROLE authenticated; %s RESET ROLE; %s; ROLLBACK;" "$(sub "$1")" "$2" "$3"; }
# svc SQL -> SQL as service_role with no JWT (Edge Functions, cron), inside the caller's transaction
svc(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE service_role; %s RESET ROLE;" "$1"; }

# The decline function, called by id (the app passes the split id it listed)
DECLINE_FN(){ echo "SELECT public.decline_split_invite($1);"; }

# fresh DBNAME -> a new database as prod is today: the 00612 scaffold, 00612, 00613, 00614, the
# 00613 seed, prod's driver policies on rides (r_select_driver without the offers branch, r_update),
# the ride and user columns 00616 reads, and 00616
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
           ALTER TABLE public.users ADD COLUMN is_active boolean NOT NULL DEFAULT true;" >/dev/null 2>&1 &&
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M616" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# fresh_mig DBNAME -> fresh, plus the migration under test (if any)
fresh_mig(){ fresh "$1" && { [ "$MIG" = none ] || [ "$(apply_err "$1" "$MIG")" = applied ]; }; }

# race DBNAME FIRST SECOND -> FIRST runs in one session, whose transaction stays open 1.5 s;
# 0.4 s in, SECOND runs in another session. FIRST and SECOND are "who:sql" pairs. Prints what
# SECOND printed (or 'failed: <sqlstate>'), and then R3's or R1's splits.
race(){ local a out who1 sql1 who2 sql2
  who1=${2%%:*}; sql1=${2#*:}; who2=${3%%:*}; sql2=${3#*:}
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; $(sub "$who1") SET LOCAL ROLE authenticated; $sql1
    SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.4
  out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "BEGIN; $(sub "$who2") SET LOCAL ROLE authenticated; $sql2 COMMIT;" 2>&1 \
        | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  case "$out" in *ERROR*) out="failed: $(echo "$out" | grep -oE 'ERROR: +[0-9A-Z]{5}' | head -1)";; esac
  wait $a
  echo "$out|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R3)" 2>&1 | tr -d '\r')|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R1)" 2>&1 | tr -d '\r')"; }

C1_FIRST="$BETO:$(decline $R3)"
C1_SECOND="$ANA:$(invite $R3 $FEDE)"
D3_SQL="$(as $BETO "$(accept $R1) $(DECLINE_FN "'$S1'")" "$(splits $R1)")"
D5_SQL="$(as $EVA "$(DECLINE_FN "'$S1'")" "$(splits $R1)")"

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 prod's guard (00613), decline policy (00614) and invite card (00616) are in place" \
  "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_splits_guard()'::regprocedure;
   SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE tablename = 'ride_splits' AND cmd = 'DELETE';
   SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_my_split_invites()'::regprocedure" \
  "43e9014cc1d383d833806df8a4a66500;split_delete,split_delete_invitee;5f2b71ad0929ad378d5a3cf39c0b033b"
val "S1 seed: R1 Beto pending; R3 Beto and Eva pending; R4 Beto paid" \
  "$(splits $R1); $(splits $R3); $(splits $R4)" \
  "Beto:50.00:pending:false:false;Beto:50.00:pending:false:false,Eva:33.33:pending:false:false;Beto:50.00:paid:true:true"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  OWN=$(grep -oE "'[0-9a-f]{32}' THEN -- 00617 decline" "$MIG" | grep -oE '[0-9a-f]{32}')
  val "M1 the body the migration accepts as its own is the one it installs" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.decline_split_invite(uuid)'::regprocedure" "$OWN"
  val "M2 only the requester's policy deletes splits; the other policies are untouched" \
    "SELECT string_agg(policyname || ':' || cmd, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ride_splits'" \
    "split_delete:DELETE,split_insert:INSERT,split_select:SELECT,split_update:UPDATE"
  val "M3 only signed-in users can call it" \
    "SELECT has_function_privilege('anon', 'public.decline_split_invite(uuid)', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.decline_split_invite(uuid)', 'EXECUTE')" "false/true"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;""' ] && ok "M4 lock_timeout and search_path do not outlive the file" \
    || ko "M4 lock_timeout and search_path do not outlive the file" "got [$r]"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== the invitee declines =="
val "D1 the invitee declines their invite: it is gone" \
  "$(as $BETO "$(DECLINE_FN "'$S1'")" "$(splits $R1)")" "declined"
val "D2 declining raises nobody: Eva keeps 33.33% and the requester pays Beto's part" \
  "$(as $BETO "$(DECLINE_FN "$(split_of $R3 $BETO)")" "$(splits $R3)")" "declined;Eva:33.33:pending:false:false"
val "D3 an invite accepted first is kept, and the app is told" "$D3_SQL" "accepted;Beto:50.00:pending:true:false"
val "D4 a paid split stays; a split with paid_at but still pending, never accepted, stays too" \
  "$(as $BETO "$(DECLINE_FN "$(split_of $R4 $BETO)")" "$(splits $R4)")
   BEGIN; $(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, paid_at) VALUES ('$R4', '$GABI', '$ANA', 10, now());")
   $(sub $GABI) SET LOCAL ROLE authenticated; $(DECLINE_FN "$(split_of $R4 $GABI)") ROLLBACK;" \
  "accepted;Beto:50.00:paid:true:true;kept"
val "D5 nobody declines someone else's invite: it looks like there is none" "$D5_SQL" "gone;Beto:50.00:pending:false:false"
val "D6 an id that does not exist" \
  "$(as $BETO "$(DECLINE_FN "'00000000-0000-4000-8000-000000000000'")" "SELECT 'ok'")" "gone;ok"
err "D7 the publishable key alone cannot call it" \
  "BEGIN; SET LOCAL ROLE anon; $(DECLINE_FN "'$S1'") ROLLBACK;" "42501"
err "D8 the service role with no user is refused" \
  "BEGIN; $(svc "$(DECLINE_FN "'$S1'")") ROLLBACK;" "42501"
val "D9 the old direct DELETE no longer deletes the invitee's invite; the requester still withdraws one" \
  "$(as $BETO "WITH d AS (DELETE FROM public.ride_splits WHERE id = '$S1' RETURNING 1) SELECT count(*) FROM d;" "$(splits $R1)")
   $(as $ANA "WITH d AS (DELETE FROM public.ride_splits WHERE id = '$S1' RETURNING 1) SELECT count(*) FROM d;" "$(splits $R1)")" \
  "0;Beto:50.00:pending:false:false;1"
val "D10 the invitee can decline after the trip started" \
  "BEGIN; $(status $R1 in_progress) $(sub $BETO) SET LOCAL ROLE authenticated; $(DECLINE_FN "'$S1'") ROLLBACK;" "declined"
val "D11 the ride is not touched; once the ride ended (00616 removed the invite) it answers gone" \
  "$(as $BETO "$(DECLINE_FN "'$S1'")" "SELECT is_split FROM public.rides WHERE id = '$R1'")
   BEGIN; $(sub $DANI) SET LOCAL ROLE authenticated; $(status $R1 completed) $(sub $BETO) $(DECLINE_FN "'$S1'") ROLLBACK;" \
  "declined;t;gone"
if [ "$MIG" = none ]; then
  echo "(D1-D11 call decline_split_invite, which does not exist before 00617: they fail on the baseline)"
fi

echo "== a decline and an invite at the same time (R3: Beto 50%, Eva 33.33%) =="
fresh_mig ${DB}r || ko "C0 race database" "setup failed"
r=$(race ${DB}r "$C1_FIRST" "$C1_SECOND")
[ "$r" = "|Eva:33.33:pending:false:false,Fede:33.33:pending:false:false|Beto:50.00:pending:false:false" ] \
  && ok "C1 Beto declines first: Ana's invite waits for it and counts three people (33.33% each)" \
  || ko "C1 Beto declines first: Ana's invite waits for it and counts three people (33.33% each)" "got [$r]"
fresh_mig ${DB}r || ko "C0 race database" "setup failed"
r=$(race ${DB}r "$ANA:$(invite $R3 $FEDE)" "$BETO:$(decline $R3)")
[ "$r" = "declined|Eva:25.00:pending:false:false,Fede:25.00:pending:false:false|Beto:50.00:pending:false:false" ] \
  && ok "C2 Ana invites first: the decline waits for it, and the shares end as that order leaves them" \
  || ko "C2 Ana invites first: the decline waits for it, and the shares end as that order leaves them" "got [$r]"
if [ "$MIG" != none ]; then
  fresh_mig ${DB}r || ko "C0 race database" "setup failed"
  r=$(race ${DB}r "$BETO:$(accept $R1)" "$BETO:$(DECLINE_FN "'$S1'")")
  [ "$r" = "accepted|Beto:50.00:pending:false:false,Eva:33.33:pending:false:false|Beto:50.00:pending:true:false" ] \
    && ok "C3 a decline from another device while accepting: it waits, sees the accept and keeps it" \
    || ko "C3 a decline from another device while accepting: it waits, sees the accept and keeps it" "got [$r]"
  fresh_mig ${DB}r || ko "C0 race database" "setup failed"
  r=$(race ${DB}r "$DANI:$(status $R1 completed)" "$BETO:$(DECLINE_FN "'$S1'")")
  [ "$r" = "gone|Beto:50.00:pending:false:false,Eva:33.33:pending:false:false|" ] \
    && ok "C4 a decline while the ride is completing: it waits, and the invite is already gone" \
    || ko "C4 a decline while the ride is completing: it waits, and the invite is already gone" "got [$r]"
fi
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}r" >/dev/null 2>&1

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
check = s[s.index('DO $check$'):s.index('$check$;') + len('$check$;')]
def variant(name, *pairs):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old)
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    open(f'{out}/{name}.sql', 'w', encoding='utf-8').write(v)
variant('no_lock', ("  PERFORM 1 FROM public.rides r WHERE r.id = v_ride FOR UPDATE;\n", ""))
variant('no_accepted', ("\n    AND d.accepted_at IS NULL", ""))
variant('no_owner', ("WHERE s.id = p_split_id AND s.user_id = v_uid;", "WHERE s.id = p_split_id;"),
        ("WHERE d.id = p_split_id AND d.user_id = v_uid", "WHERE d.id = p_split_id"))
variant('no_definer', (" LANGUAGE plpgsql\n SECURITY DEFINER\n", " LANGUAGE plpgsql\n"), (check, ""))
variant('no_revoke', ("REVOKE ALL ON FUNCTION public.decline_split_invite(uuid) FROM PUBLIC, anon;\n", ""))
variant('no_drop', ("DROP POLICY IF EXISTS split_delete_invitee ON public.ride_splits;\n", ""))
variant('no_uid_check', ("""  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'decline_split_invite needs a signed-in user';
  END IF;
""", ""))
PYEOF
  # proof NAME FILE SQL EXPECTED -> on a fresh database with FILE applied, SQL must print EXPECTED
  proof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(run ${DB}g "$3"); [ "$r" = "$4" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  # raceproof NAME FILE FIRST SECOND EXPECTED
  raceproof(){ local r; fresh ${DB}g; r=$(apply_err ${DB}g "$2")
    if [ "$r" = applied ]; then r=$(race ${DB}g "$3" "$4"); [ "$r" = "$5" ] && ok "$1" || ko "$1" "got [$r]"
    else ko "$1" "apply: $r"; fi; }
  raceproof "N1 without the ride lock, the invite counts the invitee who is leaving (so C1 tests it)" \
    "$T/no_lock.sql" "$C1_FIRST" "$C1_SECOND" \
    "|Eva:25.00:pending:false:false,Fede:25.00:pending:false:false|Beto:50.00:pending:false:false"
  proof "N2 without the accepted_at check, an accepted invite is deleted and escapes the charge (so D3 tests it)" \
    "$T/no_accepted.sql" "$D3_SQL" "declined"
  proof "N3 without the owner check, one invitee deletes another's invite (so D5 tests it)" \
    "$T/no_owner.sql" "$D5_SQL" "declined"
  proof "N4 without SECURITY DEFINER, the invitee cannot delete anything (so D1 tests it)" \
    "$T/no_definer.sql" "$(as $BETO "$(DECLINE_FN "'$S1'")" "$(splits $R1)")" "kept;Beto:50.00:pending:false:false"
  proof "N5 without the signed-in check, the service role gets 'gone' instead of an error (so D8 tests it)" \
    "$T/no_uid_check.sql" "BEGIN; $(svc "$(DECLINE_FN "'$S1'")") ROLLBACK;" "gone"
  fresh ${DB}g
  r=$(apply_err ${DB}g "$T/no_revoke.sql")
  echo "$r" | grep -q "00617: decline_split_invite must be callable by signed-in users only" \
    && ok "N6 the migration refuses to finish if anon can call it" || ko "N6 the migration refuses to finish if anon can call it" "$r"
  fresh ${DB}g
  r=$(apply_err ${DB}g "$T/no_drop.sql")
  echo "$r" | grep -q "00617: the policies that delete splits should be split_delete only, found split_delete,split_delete_invitee" \
    && ok "N7 the migration refuses to finish while the invitee can still delete without the lock" \
    || ko "N7 the migration refuses to finish while the invitee can still delete without the lock" "$r"
  fresh ${DB}g
  run ${DB}g "$AS_OWNER; CREATE FUNCTION public.decline_split_invite(p_split_id uuid) RETURNS text
    LANGUAGE plpgsql AS \$f\$ BEGIN RETURN 'other'; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "00617: unexpected body of decline_split_invite" \
    && ok "N8 a function body it does not know is not replaced" || ko "N8 a function body it does not know is not replaced" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
