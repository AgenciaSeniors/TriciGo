#!/usr/bin/env bash
# Rehearsal runner for migration 00612 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00612/run.sh none
#       -> scaffold + tests (RED: a requester pre-accepts a split for someone else at any
#          share, an invitee rewrites their split, a driver uploads documents already
#          verified, a user marks themselves as a test account)
#   supabase/tests/00612/run.sh supabase/migrations/00612_client_writes_split_docs_test_flag.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00612/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr612
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE (VERBOSITY=verbose). On Windows psql ends its
# lines with \r\n: the \r is dropped so the suite reads the same on both. Empty lines (a void
# function's result, an empty string_agg) are dropped.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# err NAME SQL REGEX -> the statements must fail with an error matching REGEX (extended)
err(){ local r; r=$(run $DB "$2"); if echo "$r" | grep -q '^ERROR\|;ERROR' && echo "$r" | grep -qE "$3"; then ok "$1"; else ko "$1" "expected an error matching [$3], got [$r]"; fi; }

ANA=a0000000-0000-4000-8000-000000000001    # customer, asks for the rides and invites
BETO=b0000000-0000-4000-8000-000000000002   # customer, invited on R1, a test account
CORA=c0000000-0000-4000-8000-000000000003   # admin
DANI=d0000000-0000-4000-8000-000000000004   # driver of R1 and R2
EVA=e0000000-0000-4000-8000-000000000005    # another customer
DP=d1000000-0000-4000-8000-000000000004     # Dani's driver_profiles.id
R1=f1000000-0000-4000-8000-000000000001     # accepted, Beto invited at 50%, not answered
R2=f2000000-0000-4000-8000-000000000002     # searching, no splits
S1=51000000-0000-4000-8000-000000000001     # Beto's split on R1
DOC=dd000000-0000-4000-8000-000000000001    # Dani's national_id, not reviewed

# Each split prints invitee:share:payment_status:accepted:paid:amount:invited_by
splits(){ echo "SELECT string_agg(u.full_name || ':' || s.share_pct || ':' || s.payment_status || ':' || (s.accepted_at IS NOT NULL)
  || ':' || (s.paid_at IS NOT NULL) || ':' || coalesce(s.amount_trc::text, '-') || ':' || i.full_name, ',' ORDER BY u.full_name)
  FROM public.ride_splits s JOIN public.users u ON u.id = s.user_id JOIN public.users i ON i.id = s.invited_by WHERE s.ride_id = '$1'"; }
# A document prints is_verified and then, for each review field, whether it is empty
REVIEW="is_verified || ':' || (verified_by IS NULL) || ':' || (verified_at IS NULL) || ':' || (rejection_reason IS NULL)
  || ':' || (verification_notes IS NULL) || ':' || (face_match_score IS NULL) || ':' || (liveness_passed IS NULL)"
doc(){ echo "SELECT string_agg($REVIEW, ',') FROM public.driver_documents WHERE $1"; }
USERS="SELECT string_agg(full_name || ':' || is_test, ',' ORDER BY full_name) FROM public.users"
# as UID SQL CHECK -> SQL as authenticated with JWT subject UID (as PostgREST would), then CHECK, rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2" "$3"; }
# svc SQL CHECK -> SQL as service_role with no JWT (Edge Functions, cron), then CHECK, rolled back
svc(){ printf "BEGIN; SET LOCAL ROLE service_role; %s RESET ROLE; %s; ROLLBACK;" "$1" "$2"; }
# sub UID -> switch the JWT subject inside a transaction
sub(){ printf "SET LOCAL request.jwt.claim.sub = '%s';" "$1"; }
# fresh DBNAME -> a new database with the scaffold
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# race DBNAME -> two requesters' sessions invite on R2 at the same time (60% and 50%); the first
# holds its transaction open while the second runs. Prints the second session's outcome and the
# splits R2 kept, then deletes them.
race(){ local a b
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated;
    INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 60);
    SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.5
  if $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "BEGIN; $(sub $ANA) SET LOCAL ROLE authenticated;
    INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$BETO', '$ANA', 50); COMMIT;" >/dev/null 2>&1
  then b=committed; else b=rejected; fi
  wait $a
  echo "$b|$($BIN/psql $CONN -d "$1" -qAt -c "$(splits $R2)" 2>&1 | tr -d '\r')"
  $BIN/psql $CONN -d "$1" -qAt -c "DELETE FROM public.ride_splits WHERE ride_id = '$R2'" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 is_admin carries the live prod body (00592)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE proname = 'is_admin'" \
  "22cb75e91980d512498034cd33e1eda2/285"
val "S1 seed: Beto invited on R1 at 50%, unanswered; R2 has no splits" \
  "$(splits $R1); $(splits $R2)" "Beto:50.00:pending:false:false:-:Ana"
val "S2 like prod, authenticated may UPDATE users.is_test and write ride_splits and driver_documents" \
  "SELECT has_column_privilege('authenticated','public.users','is_test','UPDATE') || '/' ||
          has_table_privilege('authenticated','public.ride_splits','INSERT,UPDATE') || '/' ||
          has_table_privilege('authenticated','public.driver_documents','INSERT')" "true/true/true"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the three triggers, once each" \
    "SELECT string_agg(pg_get_triggerdef(oid), ';' ORDER BY tgname) FROM pg_trigger
     WHERE tgname IN ('trg_ride_splits_guard', 'trg_driver_documents_protect_review', 'trg_users_protect_is_test')" \
    "CREATE TRIGGER trg_driver_documents_protect_review BEFORE INSERT OR UPDATE ON public.driver_documents FOR EACH ROW EXECUTE FUNCTION tg_driver_documents_protect_review();CREATE TRIGGER trg_ride_splits_guard BEFORE INSERT OR UPDATE ON public.ride_splits FOR EACH ROW EXECUTE FUNCTION tg_ride_splits_guard();CREATE TRIGGER trg_users_protect_is_test BEFORE UPDATE OF is_test ON public.users FOR EACH ROW EXECUTE FUNCTION tg_users_protect_is_test()"
  val "M2 the share range is a validated constraint, once" \
    "SELECT count(*) || '|' || bool_and(convalidated) || '|' || string_agg(pg_get_constraintdef(oid), '') FROM pg_constraint
     WHERE conrelid = 'public.ride_splits'::regclass AND conname = 'ride_splits_share_pct_range'" \
    "1|true|CHECK (((share_pct > (0)::numeric) AND (share_pct <= (100)::numeric)))"
  val "M3 clients cannot call the trigger functions" \
    "SELECT string_agg(has_function_privilege(r, f, 'EXECUTE')::text, '/' ORDER BY f, r)
     FROM unnest(ARRAY['anon','authenticated']) r,
          unnest(ARRAY['public.tg_ride_splits_guard()','public.tg_driver_documents_protect_review()','public.tg_users_protect_is_test()']) f" \
    "false/false/false/false/false/false"
  val "M4 lock_timeout does not outlive the file" "SHOW lock_timeout" "0"
fi

echo "== the requester's invite =="
val "P1 starts pending, unaccepted, unpaid and from the requester, whatever they send" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status, paid_at, amount_trc)
     VALUES ('$R2', '$EVA', '$CORA', 50, now(), 'paid', now(), 999);" "$(splits $R2)")" \
  "Eva:50.00:pending:false:false:-:Ana"
val "P2 the app's exact invite still lands" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 33.33);" "$(splits $R2)")" \
  "Eva:33.33:pending:false:false:-:Ana"
err "P3 a negative share is rejected" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', -500);" "SELECT 1")" \
  "ride_splits_share_pct_range"
err "P4 a zero share is rejected" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 0);" "SELECT 1")" \
  "ride_splits_share_pct_range"
err "P5 a share over 100 is rejected" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 100.01);" "SELECT 1")" \
  "ride_splits_share_pct_range|split_over_100"
val "P6 one invitee may take the whole fare" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 100);" "$(splits $R2)")" \
  "Eva:100.00:pending:false:false:-:Ana"
err "P7 the shares of a ride cannot pass 100% (23514, says how much is taken)" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R1', '$EVA', '$ANA', 60);" "SELECT 1")" \
  "23514: Las partes de este viaje no pueden sumar más del 100% \(ya hay 50\.00%\)\.;DETAIL:  split_over_100"
val "P8 they may add up to exactly 100%" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R1', '$EVA', '$ANA', 50);" "$(splits $R1)")" \
  "Beto:50.00:pending:false:false:-:Ana,Eva:50.00:pending:false:false:-:Ana"
err "P9 one INSERT whose rows together pass 100% is rejected" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 60), ('$R2', '$BETO', '$ANA', 50);" "SELECT 1")" \
  "split_over_100"
err "P10 the service key is held to 100% too" \
  "$(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R1', '$EVA', '$ANA', 60);" "SELECT 1")" \
  "split_over_100"
val "P11 the service key keeps the rest of its values" \
  "$(svc "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status) VALUES ('$R2', '$EVA', '$CORA', 30, now(), 'paid');" "$(splits $R2)")" \
  "Eva:30.00:paid:true:false:-:Cora"
val "P12 the requester can still withdraw an invite" \
  "$(as $ANA "DELETE FROM public.ride_splits WHERE id = '$S1';" "$(splits $R1)")" ""
val "P13 on a pooled connection where an earlier transaction set the flag, the next client is still held" \
  "BEGIN; SELECT set_config('app.trusted_driver_update', '1', true) IS NULL; COMMIT;
   $(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status)
     VALUES ('$R2', '$EVA', '$CORA', 50, now(), 'paid');" "SELECT current_setting('app.trusted_driver_update') || '|' || ($(splits $R2))")" \
  "f;|Eva:50.00:pending:false:false:-:Ana"

echo "== the invitee =="
val "I1 accepts with the app's exact update" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1' AND user_id = '$BETO' AND accepted_at IS NULL;" "$(splits $R1)")" \
  "Beto:50.00:pending:true:false:-:Ana"
val "I2 acceptance carries the server's clock, not the client's" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = '2000-01-01' WHERE id = '$S1';" "SELECT (accepted_at = now())::text FROM public.ride_splits WHERE id = '$S1'")" \
  "true"
val "I3 cannot change their share, the payment fields, the inviter or the ride" \
  "$(as $BETO "UPDATE public.ride_splits SET share_pct = 1, payment_status = 'paid', paid_at = now(), amount_trc = 0,
     invited_by = '$BETO', ride_id = '$R2' WHERE id = '$S1';" "$(splits $R1)")" \
  "Beto:50.00:pending:false:false:-:Ana"
val "I4 an accepted split can be neither withdrawn nor re-dated" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1';
     UPDATE public.ride_splits SET accepted_at = NULL WHERE id = '$S1';
     UPDATE public.ride_splits SET accepted_at = '2030-01-01' WHERE id = '$S1';" \
     "SELECT coalesce((accepted_at = now())::text, 'null') FROM public.ride_splits WHERE id = '$S1'")" \
  "true"

echo "== complete_ride_and_pay =="
val "T1 under app.trusted_driver_update, the driver's call marks the accepted split paid" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1'; $(sub $DANI) SELECT public.sim_pay_splits('$R1', 5000);" "$(splits $R1)")" \
  "Beto:50.00:paid:true:true:2500:Ana"
val "T2 the same definer code without the flag is held like a client" \
  "$(as $BETO "UPDATE public.ride_splits SET accepted_at = now() WHERE id = '$S1'; $(sub $DANI) SELECT public.sim_pay_splits('$R1', 5000, false);" "$(splits $R1)")" \
  "Beto:50.00:pending:true:false:-:Ana"
val "T3 end to end with the app's calls: invite, accept, pay" \
  "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct) VALUES ('$R2', '$EVA', '$ANA', 50);
     $(sub $EVA) UPDATE public.ride_splits SET accepted_at = now() WHERE ride_id = '$R2' AND user_id = '$EVA' AND accepted_at IS NULL;
     $(sub $DANI) SELECT public.sim_pay_splits('$R2', 5000);" "$(splits $R2)")" \
  "Eva:50.00:paid:true:true:2500:Ana"

echo "== two invites at the same time =="
r=$(race $DB)
[ "$r" = "rejected|Eva:60.00:pending:false:false:-:Ana" ] && ok "C1 the second invite waits for the first and is rejected" \
  || ko "C1 the second invite waits for the first and is rejected" "got [$r]"

echo "== driver documents =="
val "D1 a driver's own upload cannot arrive reviewed" \
  "$(as $DANI "INSERT INTO public.driver_documents (driver_id, document_type, storage_path, file_name, is_verified, verified_by, verified_at,
     rejection_reason, verification_notes, face_match_score, liveness_passed)
     VALUES ('$DP', 'selfie', 'driver-docs/d/s.jpg', 's.jpg', true, '$CORA', now(), 'r', 'n', 0.99, true);" "$(doc "document_type = 'selfie'")")" \
  "false:true:true:true:true:true:true"
val "D2 the app's exact upload still lands" \
  "$(as $DANI "INSERT INTO public.driver_documents (driver_id, document_type, storage_path, file_name, mime_type)
     VALUES ('$DP', 'selfie', 'driver-docs/d/s.jpg', 's.jpg', 'image/jpeg');" "$(doc "document_type = 'selfie'")")" \
  "false:true:true:true:true:true:true"
val "D3 an admin verifies a document" \
  "$(as $CORA "UPDATE public.driver_documents SET is_verified = true, verified_by = '$CORA', verified_at = now() WHERE id = '$DOC';" "$(doc "id = '$DOC'")")" \
  "true:false:false:true:true:true:true"
val "D4 an admin may upload a reviewed document" \
  "$(as $CORA "INSERT INTO public.driver_documents (driver_id, document_type, storage_path, is_verified, verified_by, verified_at)
     VALUES ('$DP', 'selfie', 'driver-docs/d/s.jpg', true, '$CORA', now());" "$(doc "document_type = 'selfie'")")" \
  "true:false:false:true:true:true:true"
val "D5 the service key keeps the face match and liveness it writes" \
  "$(svc "INSERT INTO public.driver_documents (driver_id, document_type, storage_path, face_match_score, liveness_passed)
     VALUES ('$DP', 'selfie', 'driver-docs/d/s.jpg', 0.8, true);" "$(doc "document_type = 'selfie'")")" \
  "false:true:true:true:true:false:false"
val "D6 if a policy ever lets drivers update, the review fields still stay" \
  "$(printf "BEGIN; CREATE POLICY tmp_open ON public.driver_documents FOR UPDATE USING (true); %s SET LOCAL ROLE authenticated;
     UPDATE public.driver_documents SET storage_path = 'driver-docs/d/new.jpg', is_verified = true, verified_by = '%s', face_match_score = 1 WHERE id = '%s';
     RESET ROLE; SELECT storage_path || '|' || %s FROM public.driver_documents WHERE id = '%s'; ROLLBACK;" "$(sub $DANI)" "$CORA" "$DOC" "$REVIEW" "$DOC")" \
  "driver-docs/d/new.jpg|false:true:true:true:true:true:true"

echo "== users.is_test =="
val "U1 a user cannot mark themselves as a test account" \
  "$(as $ANA "UPDATE public.users SET is_test = true WHERE id = '$ANA';" "$USERS")" \
  "Ana:false,Beto:true,Cora:false,Dani:false,Eva:false"
val "U2 a test account cannot unmark itself" \
  "$(as $BETO "UPDATE public.users SET is_test = false WHERE id = '$BETO';" "$USERS")" \
  "Ana:false,Beto:true,Cora:false,Dani:false,Eva:false"
val "U3 their other edits go through and keep the flag" \
  "$(as $ANA "UPDATE public.users SET full_name = 'Ana B', is_test = true WHERE id = '$ANA';" "$USERS")" \
  "Ana B:false,Beto:true,Cora:false,Dani:false,Eva:false"
val "U4 an admin's definer RPC may set it" \
  "$(as $CORA "SELECT public.sim_definer_set_is_test('$ANA', true);" "$USERS")" \
  "Ana:true,Beto:true,Cora:false,Dani:false,Eva:false"
val "U5 the same RPC called by someone else is held" \
  "$(as $EVA "SELECT public.sim_definer_set_is_test('$ANA', true);" "$USERS")" \
  "Ana:false,Beto:true,Cora:false,Dani:false,Eva:false"
val "U6 the service key may set it" \
  "$(svc "UPDATE public.users SET is_test = true WHERE id = '$ANA';" "$USERS")" \
  "Ana:true,Beto:true,Cora:false,Dani:false,Eva:false"

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
cut('no_trigger', """CREATE TRIGGER trg_ride_splits_guard
  BEFORE INSERT OR UPDATE ON public.ride_splits
  FOR EACH ROW EXECUTE FUNCTION public.tg_ride_splits_guard();""")
cut('not_validated', "ALTER TABLE public.ride_splits VALIDATE CONSTRAINT ride_splits_share_pct_range;\n")
cut('no_lock', "    PERFORM 1 FROM public.rides WHERE id = NEW.ride_id FOR UPDATE;\n")
cut('no_coalesce', "coalesce(current_setting('app.trusted_driver_update', true), '') = '1'",
    "current_setting('app.trusted_driver_update', true) = '1'")
PYEOF
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/no_trigger.sql")
  echo "$r" | grep -q "00612: missing or wrong trigger(s): trg_ride_splits_guard" && ok "N1 a migration that forgets a trigger aborts" || ko "N1 a migration that forgets a trigger aborts" "$r"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/not_validated.sql")
  echo "$r" | grep -q "00612: ride_splits_share_pct_range is missing or not validated" && ok "N2 a constraint left NOT VALID aborts" || ko "N2 a constraint left NOT VALID aborts" "$r"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/no_lock.sql")
  if [ "$r" = applied ]; then
    r=$(race ${DB}g)
    [ "$r" = "committed|Beto:50.00:pending:false:false:-:Ana,Eva:60.00:pending:false:false:-:Ana" ] \
      && ok "N3 without the lock on the ride, two concurrent invites pass 100% (so C1 tests the lock)" \
      || ko "N3 without the lock on the ride, two concurrent invites pass 100% (so C1 tests the lock)" "got [$r]"
  else ko "N3 without the lock on the ride, two concurrent invites pass 100% (so C1 tests the lock)" "apply: $r"; fi
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/no_coalesce.sql")
  if [ "$r" = applied ]; then
    r=$(run ${DB}g "$(as $ANA "INSERT INTO public.ride_splits (ride_id, user_id, invited_by, share_pct, accepted_at, payment_status)
      VALUES ('$R2', '$EVA', '$CORA', 50, now(), 'paid');" "$(splits $R2)")")
    [ "$r" = "Eva:50.00:paid:true:false:-:Cora" ] \
      && ok "N4 without the coalesce, a session that never set the flag skips the guard (so P1 tests it)" \
      || ko "N4 without the coalesce, a session that never set the flag skips the guard (so P1 tests it)" "got [$r]"
  else ko "N4 without the coalesce, a session that never set the flag skips the guard (so P1 tests it)" "apply: $r"; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
