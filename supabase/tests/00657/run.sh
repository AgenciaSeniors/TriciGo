#!/usr/bin/env bash
# Rehearsal runner for migration 00657 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00657/run.sh none
#       -> scaffold (prod's tables, keys and live function bodies) + tests (RED)
#   supabase/tests/00657/run.sh supabase/migrations/00657_account_deletion_atomic_and_gated.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00657/run.sh ...
#
# try_delete(user) plays the Edge Function: without the migration it runs today's
# two calls (settle, then anonymize; in prod each is its own transaction), with it
# prepare_account_deletion; then it deletes the auth user the way GoTrue does.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr657
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''; SET client_min_messages = warning"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
err(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "expected an error like [$3], got [$r]"; fi; }

PLAT=00000000-0000-0000-0000-000000000001
ANON=00000000-0000-0000-0000-000000000099
REF=a0000000-0000-4000-8000-000000000001       # referred A and B
A=a0000000-0000-4000-8000-000000000002         # driver, referee, 5000 CUP
B=a0000000-0000-4000-8000-000000000003         # driver, referee, 11000 CUP
P1=a0000000-0000-4000-8000-000000000004        # used PROMO
P2=a0000000-0000-4000-8000-000000000005        # used PROMO
E1=a0000000-0000-4000-8000-000000000006        # employee of CORP
E2=a0000000-0000-4000-8000-000000000007        # employee of CORP
C1=a0000000-0000-4000-8000-000000000008        # rider of DONE, reviewed D1
D1=a0000000-0000-4000-8000-000000000009        # driver of DONE, reviewed C1
RA=a0000000-0000-4000-8000-000000000010        # rider of LIVE (in progress), 300 CUP
DA=a0000000-0000-4000-8000-000000000011        # driver of LIVE
RS=a0000000-0000-4000-8000-000000000012        # rider with a pending scheduled ride
INV=a0000000-0000-4000-8000-000000000013       # accepted split invite on LIVE
ACC=a0000000-0000-4000-8000-000000000014       # accused in an open incident
REP=a0000000-0000-4000-8000-000000000015       # reported that incident
OPN=a0000000-0000-4000-8000-000000000016       # opened an open dispute
RSP=a0000000-0000-4000-8000-000000000017       # respondent of that dispute
OLD=a0000000-0000-4000-8000-000000000018       # opened a dispute already resolved
DEB=a0000000-0000-4000-8000-000000000019       # tricicoin -500
PAY=a0000000-0000-4000-8000-000000000020       # payment started 10 minutes ago
STALE=a0000000-0000-4000-8000-000000000021     # payment started 3 hours ago, never finished
DP_D1=dd000000-0000-4000-8000-000000000009
DP_DA=dd000000-0000-4000-8000-000000000011
DP_A=dd000000-0000-4000-8000-000000000002
DP_B=dd000000-0000-4000-8000-000000000003
DONE=11111111-0000-4000-8000-000000000001
LIVE=11111111-0000-4000-8000-000000000002
SCHED=11111111-0000-4000-8000-000000000003
DONE2=11111111-0000-4000-8000-000000000004
PROMO=22222222-0000-4000-8000-000000000001
CORP=cc000000-0000-4000-8000-000000000001
ALL_USERS="'$PLAT','$ANON','$REF','$A','$B','$P1','$P2','$E1','$E2','$C1','$D1','$RA','$DA','$RS','$INV','$ACC','$REP','$OPN','$RSP','$OLD','$DEB','$PAY','$STALE'"

TRY='CREATE FUNCTION pg_temp.try_delete(u uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE d text;
BEGIN
  BEGIN
    IF to_regprocedure($$public.prepare_account_deletion(uuid)$$) IS NOT NULL THEN
      PERFORM public.prepare_account_deletion(u);
    ELSE
      PERFORM public.settle_and_scrub_for_deletion(u);
      PERFORM public.anonymize_user_references(u);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
    RETURN $$refused:$$ || coalesce(nullif(d, $$$$), SQLERRM);
  END;
  BEGIN
    DELETE FROM auth.users WHERE id = u;
    RETURN $$deleted$$;
  EXCEPTION WHEN OTHERS THEN
    RETURN $$auth_delete_failed$$;
  END;
END $f$;'
# tx SQL -> rolled-back transaction with try_delete available
tx(){ printf "BEGIN; %s %s ROLLBACK;" "$TRY" "$1"; }
bal(){ echo "(SELECT coalesce(sum(balance), 0) FROM public.wallet_accounts WHERE user_id = '$1')"; }
plat(){ echo "(SELECT coalesce(sum(balance), 0) FROM public.wallet_accounts WHERE user_id = '$PLAT' AND account_type = 'platform_revenue')"; }

seed(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "
  INSERT INTO auth.users (id) SELECT unnest(ARRAY[$ALL_USERS])::uuid;
  INSERT INTO public.users (id, role, full_name) SELECT unnest(ARRAY[$ALL_USERS])::uuid, 'customer', 'X';
  INSERT INTO public.driver_profiles (id, user_id) VALUES ('$DP_D1', '$D1'), ('$DP_DA', '$DA'), ('$DP_A', '$A'), ('$DP_B', '$B');
  INSERT INTO public.referrals (referrer_id, referee_id) VALUES ('$REF', '$A'), ('$REF', '$B');
  INSERT INTO public.wallet_accounts (user_id, account_type, balance) VALUES
    ('$A', 'tricicoin', 5000), ('$B', 'tricicoin', 11000), ('$RA', 'customer_cash', 300), ('$DEB', 'tricicoin', -500),
    ('$PLAT', 'platform_revenue', 0);
  INSERT INTO public.promotions (id, code) VALUES ('$PROMO', 'BIENVENIDA');
  INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$PROMO', '$P1'), ('$PROMO', '$P2');
  INSERT INTO public.corporate_accounts (id, created_by) VALUES ('$CORP', '$E1');
  INSERT INTO public.corporate_employees (corporate_account_id, user_id) VALUES ('$CORP', '$E1'), ('$CORP', '$E2');
  INSERT INTO public.rides (id, customer_id, driver_id, status, is_scheduled, scheduled_notified) VALUES
    ('$DONE', '$C1', '$DP_D1', 'completed', false, false),
    ('$LIVE', '$RA', '$DP_DA', 'in_progress', false, false),
    ('$SCHED', '$RS', NULL, 'searching', true, false),
    ('$DONE2', '$OPN', '$DP_D1', 'completed', false, false);
  INSERT INTO public.ride_splits (ride_id, user_id, accepted_at) VALUES ('$LIVE', '$INV', now());
  INSERT INTO public.reviews (ride_id, reviewer_id, reviewee_id, rating, comment) VALUES
    ('$DONE', '$C1', '$D1', 5, 'Bien'), ('$DONE', '$D1', '$C1', 5, 'Puntual');
  INSERT INTO public.incident_reports (ride_id, reported_by, against_user_id, status, description) VALUES
    ('$DONE', '$REP', '$ACC', 'open', 'Maltrato');
  INSERT INTO public.ride_disputes (ride_id, opened_by, respondent_id, status, resolved_at) VALUES
    ('$DONE2', '$OPN', '$RSP', 'open', NULL),
    ('$DONE', '$OLD', '$D1', 'resolved_rider', now() - interval '1 day');
  INSERT INTO public.payment_intents (user_id, status, created_at) VALUES
    ('$PAY', 'pending', now() - interval '10 minutes'), ('$STALE', 'pending', now() - interval '3 hours');
  INSERT INTO public.trusted_contacts (user_id, phone) VALUES ('$B', '+5355550000');" >/dev/null; }

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         seed "$1" 2>&1 || return 1; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }
val "S0 scaffold bodies are prod's" \
  "SELECT string_agg(proname || '=' || md5(prosrc), ' ' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('settle_and_scrub_for_deletion', 'anonymize_user_references', 'ensure_wallet_account');" \
  "anonymize_user_references=eaa9e7adb090aed60d7b88b2e9ebb245 ensure_wallet_account=6f01c44a2ecd5afe0b625347b43c203f settle_and_scrub_for_deletion=bdd55bcb414a9355487bb425c5aa27dc"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== several deleted accounts can share the anonymous user =="
val "D1 the second referee is deleted too, and both balances reach the platform" \
  "$(tx "SELECT pg_temp.try_delete('$A') || '|' || pg_temp.try_delete('$B'); SELECT $(plat) || '|' || (SELECT count(*) FROM public.referrals WHERE referee_id = '$ANON');")" \
  "deleted|deleted;16000|2"
val "D2 two accounts that used the same promotion" \
  "$(tx "SELECT pg_temp.try_delete('$P1') || '|' || pg_temp.try_delete('$P2');")" "deleted|deleted"
val "D3 two employees of the same company" \
  "$(tx "SELECT pg_temp.try_delete('$E1') || '|' || pg_temp.try_delete('$E2');")" "deleted|deleted"
val "D4 the rider and the driver who reviewed the same ride" \
  "$(tx "SELECT pg_temp.try_delete('$C1') || '|' || pg_temp.try_delete('$D1');")" "deleted|deleted"
val "D5 a deleted account's cascades go with it" \
  "$(tx "SELECT pg_temp.try_delete('$B'); SELECT (SELECT count(*) FROM public.trusted_contacts) || '|' || (SELECT count(*) FROM public.driver_profiles WHERE user_id = '$B');")" "deleted;0|0"

echo "== what keeps an account from being deleted =="
val "G1 a rider in the middle of a ride; the wallet stays" \
  "$(tx "SELECT pg_temp.try_delete('$RA'); SELECT $(bal $RA) || '|' || (SELECT customer_id FROM public.rides WHERE id = '$LIVE');")" \
  "refused:deletion_active_ride;300|$RA"
val "G2 the driver of a ride in progress" \
  "$(tx "SELECT pg_temp.try_delete('$DA');")" "refused:deletion_active_ride"
val "G3 a rider with a pending scheduled ride" \
  "$(tx "SELECT pg_temp.try_delete('$RS');")" "refused:deletion_active_ride"
val "G4 an invited payer who accepted, on a ride in progress" \
  "$(tx "SELECT pg_temp.try_delete('$INV');")" "refused:deletion_active_ride"
val "G5 someone accused in an open incident" \
  "$(tx "SELECT pg_temp.try_delete('$ACC');")" "refused:deletion_open_case"
val "G6 whoever reported it can still delete" \
  "$(tx "SELECT pg_temp.try_delete('$REP');")" "deleted"
val "G7 the one who opened an open dispute" \
  "$(tx "SELECT pg_temp.try_delete('$OPN');")" "refused:deletion_open_case"
val "G8 the respondent of an open dispute" \
  "$(tx "SELECT pg_temp.try_delete('$RSP');")" "refused:deletion_open_case"
val "G9 a dispute already resolved does not block" \
  "$(tx "SELECT pg_temp.try_delete('$OLD');")" "deleted"
val "G10 a negative balance; the debt stays" \
  "$(tx "SELECT pg_temp.try_delete('$DEB'); SELECT $(bal $DEB);")" "refused:deletion_debt;-500"
err "G11 the message says how much is owed" \
  "SELECT public.prepare_account_deletion('$DEB');" "deuda de 500 CUP"
val "G12 a payment started 10 minutes ago" \
  "$(tx "SELECT pg_temp.try_delete('$PAY');")" "refused:deletion_payment_pending"
val "G13 a payment abandoned 3 hours ago does not block" \
  "$(tx "SELECT pg_temp.try_delete('$STALE');")" "deleted"
val "G14 the anonymous user cannot be deleted" \
  "$(tx "SELECT pg_temp.try_delete('$ANON');")" "refused:deletion_system_account"
val "G15 a rider whose rides are all over is deleted" \
  "$(tx "SELECT pg_temp.try_delete('$C1');")" "deleted"

echo "== permissions and live uniqueness =="
val "A1 only service_role runs prepare_account_deletion" \
  "SELECT has_function_privilege('anon', 'public.prepare_account_deletion(uuid)', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.prepare_account_deletion(uuid)', 'EXECUTE') || '|' || has_function_privilege('service_role', 'public.prepare_account_deletion(uuid)', 'EXECUTE');" \
  "false|false|true"
err "A2 a live user still cannot be referred twice" \
  "BEGIN; INSERT INTO public.referrals (referrer_id, referee_id) VALUES ('$P1', '$A'); ROLLBACK;" "referrals_referee_id_key"
err "A3 a live user still cannot review a ride twice" \
  "BEGIN; INSERT INTO public.reviews (ride_id, reviewer_id, reviewee_id, rating) VALUES ('$DONE', '$C1', '$D1', 4); ROLLBACK;" "reviews_ride_id_reviewer_id_key"
err "A4 a live user still cannot use a promotion twice" \
  "BEGIN; INSERT INTO public.promotion_uses (promotion_id, user_id) VALUES ('$PROMO', '$P1'); ROLLBACK;" "promotion_uses_promotion_id_user_id_key"
err "A5 a live employee still cannot be added twice" \
  "BEGIN; INSERT INTO public.corporate_employees (corporate_account_id, user_id) VALUES ('$CORP', '$E1'); ROLLBACK;" "corporate_employees_corporate_account_id_user_id_key"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs =="
  VERIFY=$(python3 -I - "$MIG" <<'PY'
import sys
s = open(sys.argv[1], encoding='utf-8').read()
print(s[s.index('DO $verify$'):])
PY
)
  # N1: with the old unique key back, a reference that cannot move undoes everything.
  val "N1 an anonymization that fails leaves the wallet and the account as they were" \
    "$(tx "DROP INDEX public.referrals_referee_id_key; ALTER TABLE public.referrals ADD CONSTRAINT referrals_referee_id_key UNIQUE (referee_id);
           SELECT pg_temp.try_delete('$A') || '|' || pg_temp.try_delete('$B'); SELECT $(bal $B) || '|' || (SELECT count(*) FROM public.users WHERE id = '$B') || '|' || (SELECT count(*) FROM public.referrals WHERE referee_id = '$ANON');")" \
    "deleted|refused:deletion_incomplete;11000|1|1"
  err "N2 the verification catches a unique key without the exception" \
    "BEGIN; DROP INDEX public.referrals_referee_id_key; CREATE UNIQUE INDEX referrals_referee_id_key ON public.referrals (referee_id); $VERIFY ROLLBACK;" \
    "unique keys without the anonymous-user exception: referrals_referee_id_key"
  err "N3 the verification catches the duplicate reviews index" \
    "BEGIN; CREATE UNIQUE INDEX uniq_reviews_ride_reviewer ON public.reviews (ride_id, reviewer_id); $VERIFY ROLLBACK;" \
    "uniq_reviews_ride_reviewer still exists"
  err "N4 the verification catches a client grant" \
    "BEGIN; GRANT EXECUTE ON FUNCTION public.prepare_account_deletion(uuid) TO authenticated; $VERIFY ROLLBACK;" \
    "executable by clients"
  # N5: a CRLF copy (SQL Editor pasted from Windows) applies, passes its own checks and behaves.
  CRLF=$(mktemp); sed 's/$/\r/' "$MIG" > "$CRLF"
  fresh pr657n >/dev/null || { ko "N5" "scaffold failed"; }
  if $BIN/psql $CONN -d pr657n -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$CRLF" >/dev/null 2>&1; then
    val "N5 a CRLF copy applies and still deletes the second referee" \
      "$(tx "SELECT pg_temp.try_delete('$A') || '|' || pg_temp.try_delete('$B');")" "deleted|deleted" pr657n
  else ko "N5" "CRLF copy did not apply"; fi
  rm -f "$CRLF"
fi

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
