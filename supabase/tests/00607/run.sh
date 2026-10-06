#!/usr/bin/env bash
# Rehearsal runner for migration 00607 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00607/run.sh none
#       -> scaffold + tests (RED: no client can open a dispute, a hand-made dispute
#          keeps its status/priority/refund/respondent, a ride takes wallet_ratio 5,
#          a new customer profile takes any rating)
#   supabase/tests/00607/run.sh supabase/migrations/00607_insert_guards_disputes_rides_profiles.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00607/run.sh ...
set -u
export PGCLIENTENCODING=UTF8
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr607
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

SEED="$(cat "$DIR/seed.sql")"
ALICE=a0000000-0000-4000-8000-000000000001   # rider
BOB=a0000000-0000-4000-8000-000000000002     # driver (profile d...02)
CAROL=a0000000-0000-4000-8000-000000000003   # admin
DAVE=a0000000-0000-4000-8000-000000000004    # rider unrelated to Alice's rides
ERIN=a0000000-0000-4000-8000-000000000005    # rider without a customer profile
DONE=e0000000-0000-4000-8000-000000000001    # Alice's completed ride with Bob
SEARCHING=e0000000-0000-4000-8000-000000000002   # Alice's searching ride, mixed payment, wallet_ratio 0.50
NODRIVER=e0000000-0000-4000-8000-000000000003    # Alice's completed ride without a driver
PRIORITY_REFUSED='23514:new row for relation "ride_disputes" violates check constraint "chk_dispute_priority_valid"'
RATIO_REFUSED='23514:new row for relation "rides" violates check constraint "rides_wallet_ratio_range"'
# try ROLE UID SQL -> runs SQL as that role with JWT subject UID (as PostgREST would) and prints 'ok',
#                     or 'SQLSTATE:message' of the error; everything it wrote is rolled back on error
try(){ printf "SET client_min_messages = warning; CREATE TEMP TABLE IF NOT EXISTS r (v text); GRANT ALL ON r TO anon, authenticated, service_role;
  SET request.jwt.claim.sub = '%s'; SET ROLE %s;
  DO \$t\$ BEGIN BEGIN %s INSERT INTO r VALUES ('ok'); EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES (SQLSTATE || ':' || SQLERRM); END; END \$t\$;
  RESET ROLE; RESET request.jwt.claim.sub; SELECT string_agg(v, ',') FROM r; TRUNCATE r;" "$2" "$1" "$3"; }
# as UID SQL -> SQL run as that signed-in account, then back to the test role
as(){ printf "SET request.jwt.claim.sub = '%s'; SET ROLE authenticated; %s RESET ROLE; RESET request.jwt.claim.sub;" "$1" "$2"; }

# What disputeService.createDispute sends (packages/api/src/services/dispute.service.ts)
APP_DISPUTE="INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, evidence_urls, respondent_id, sla_first_response_at, sla_resolution_deadline)
  VALUES ('$DONE', '$ALICE', 'overcharge', 'Me cobraron de mas', '{}', '$BOB', now() + interval '24 hours', now() + interval '72 hours');"
# A hand-made dispute: every column the app never sends, set to what an attacker would want
FORGED_DISPUTE="INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, status, priority, respondent_id, assigned_to,
    admin_notes, refund_amount_trc, refund_transaction_id, resolution, resolution_notes, resolved_at, created_at, updated_at,
    sla_first_response_at, sla_resolution_deadline, respondent_message, respondent_replied_at, ride_estimated_fare_trc, ride_final_fare_trc)
  VALUES ('$DONE', '$ALICE', 'overcharge', 'x', 'resolved_rider', 'high', '$DAVE', '$CAROL',
    'approved', 99999, gen_random_uuid(), 'full_refund', 'ok', now(), '2020-01-01', '2020-01-01',
    now() + interval '365 days', now() + interval '365 days', 'agreed', now(), 1, 1);"
# DISPUTE RIDE -> status|priority|respondent|<every admin/respondent/fare column, NULLs skipped>|created now?|SLA hours
DISPUTE(){ echo "SELECT status || '|' || priority || '|' || coalesce(respondent_id::text, '-') || '|'
  || concat_ws(',', assigned_to, admin_notes, refund_amount_trc, refund_transaction_id, resolution, resolution_notes, resolved_at, updated_at,
               respondent_message, respondent_replied_at, ride_estimated_fare_trc, ride_final_fare_trc)
  || '|' || (created_at = now()) || '|' || round(extract(epoch FROM sla_first_response_at - now()) / 3600)
  || '/' || round(extract(epoch FROM sla_resolution_deadline - now()) / 3600)
  FROM public.ride_disputes WHERE ride_id = '$1';"; }

# fresh DBNAME [SETUP] -> a new database with the scaffold and the seed, plus optional setup SQL
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$SEED ${2:-}" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('current_user_role', 'is_admin', 'tg_customer_profiles_protect_rating',
         'tg_ride_disputes_protect_columns', 'update_updated_at_column')" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,is_admin:22cb75e91980d512498034cd33e1eda2/285,tg_customer_profiles_protect_rating:37b86bfe9c0c317f27cff372a4a1bd2e/240,tg_ride_disputes_protect_columns:e7c521901228c1119a51219ea934544c/1461,update_updated_at_column:e7a0919a4073eaabf72630cc53a76237/48"
val "S1 like prod, a non-superuser owns the three tables and RLS is on but not forced" \
  "SELECT string_agg(c.relname || ':' || pg_get_userbyid(c.relowner) || '/' || r.rolsuper || '/' || c.relrowsecurity || '/' || c.relforcerowsecurity, ',' ORDER BY c.relname)
   FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.oid IN ('public.rides'::regclass, 'public.ride_disputes'::regclass, 'public.customer_profiles'::regclass)" \
  "customer_profiles:tricigo_owner/false/true/false,ride_disputes:tricigo_owner/false/true/false,rides:tricigo_owner/false/true/false"

if [ "$MIG" != "none" ]; then
  TMP="$(mktemp -d)"
  # An empty database must take the migration too, whichever 00434 rating guard it carries: the live
  # one (prod, comments stripped) or the one git has, which a database rebuilt from history would carry.
  "$PY" - "$DIR/../../migrations/00434_round7_insert_protect_class.sql" "$TMP/git434.sql" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"CREATE OR REPLACE FUNCTION public\.tg_customer_profiles_protect_rating\(\).*?AS (\$[a-z_]*\$).*?\1;", src, re.S)
assert m, "00434 rating guard not found"
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(m.group(0) + "\n")
PYEOF
  for v in live git; do
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}e" -c "CREATE DATABASE ${DB}e" >/dev/null 2>&1
    $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
    if [ "$v" = git ]; then $BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -c "$AS_OWNER" -f "$TMP/git434.sql" >/dev/null 2>&1; fi
    body=$($BIN/psql $CONN -d ${DB}e -qAt -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_customer_profiles_protect_rating()'::regprocedure" | tr -d '\r')
    if out=$($BIN/psql $CONN -d ${DB}e -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" 2>&1); then ok "M0 on an empty database with the $v rating guard ($body) the migration applies"
    else ko "M0 on an empty database with the $v rating guard ($body) the migration applies" "$(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; fi
  done
  # Disputes written with the 00104 priorities are mapped, which needs the old CHECK gone first.
  fresh ${DB}m "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, priority)
                VALUES ('$DONE', '$ALICE', 'other', 'x', 'critical'), ('$NODRIVER', '$ALICE', 'other', 'x', 'medium');"
  if out=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" 2>&1); then
    r=$($BIN/psql $CONN -d ${DB}m -qAt -c "SELECT string_agg(priority, ',' ORDER BY priority) FROM public.ride_disputes" | tr -d '\r')
    if [ "$r" = "normal,urgent" ]; then ok "M2 disputes with the old priorities are mapped (medium -> normal, critical -> urgent)"
    else ko "M2 disputes with the old priorities are mapped (medium -> normal, critical -> urgent)" "got [$r]"; fi
  else ko "M2 disputes with the old priorities are mapped (medium -> normal, critical -> urgent)" "$(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; fi
  rm -rf "$TMP"
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  # Same session before and after the file, as in `supabase db push` or MCP's pooled connection.
  r=$($P -c "SET lock_timeout = '0'" -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" 2>/dev/null | tr -d '\r' | tail -1)
  if [ "$r" = "0" ]; then ok "M1 the lock timeout the migration sets does not outlive it"
  else ko "M1 the lock timeout the migration sets does not outlive it" "expected [0], got [$r]"; fi
fi

echo "== tests =="
# D. ride_disputes
val "D1 the app's own dispute goes in: open, normal priority, Bob answers, the ride's fares, SLA 24 h / 72 h" \
  "$SEED $(try authenticated $ALICE "$APP_DISPUTE") $(DISPUTE $DONE)" "ok;open|normal|$BOB|3000,3000|true|24/72"
val "D2 a hand-made dispute loses everything the app never sends; its fare snapshot comes from the ride" \
  "$SEED $(try authenticated $ALICE "$FORGED_DISPUTE") $(DISPUTE $DONE)" "ok;open|normal|$BOB|3000,3000|true|24/72"
val "D3 the stranger a hand-made dispute names as respondent cannot read it" \
  "$SEED $(try authenticated $ALICE "$FORGED_DISPUTE") $(as $DAVE "SELECT count(*) FROM public.ride_disputes;")" "ok;0"
val "D4 a driver who opens a dispute gets the rider as respondent, whatever it sends" \
  "$SEED $(try authenticated $BOB "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, respondent_id)
     VALUES ('$DONE', '$BOB', 'payment', 'No me pago', '$DAVE');") $(DISPUTE $DONE)" "ok;open|normal|$ALICE|3000,3000|true|24/72"
val "D5 a ride that never had a driver has no respondent" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, respondent_id)
     VALUES ('$NODRIVER', '$ALICE', 'other', 'x', '$DAVE');") $(DISPUTE $NODRIVER)" "ok;open|normal|-|2000,2000|true|24/72"
val "D6 the service role (no JWT) still writes every column, urgent priority included" \
  "$SEED $(try service_role '' "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, status, priority, respondent_id, assigned_to)
     VALUES ('$DONE', '$ALICE', 'other', 'x', 'escalated', 'urgent', '$DAVE', '$CAROL');")
   SELECT status || '|' || priority || '|' || respondent_id || '|' || assigned_to FROM public.ride_disputes;" "ok;escalated|urgent|$DAVE|$CAROL"
val "D7 the priorities the apps never use (medium, critical) are refused" \
  "$SEED $(try service_role '' "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, priority) VALUES ('$DONE', '$ALICE', 'other', 'x', 'medium');")
   $(try service_role '' "INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, priority) VALUES ('$DONE', '$ALICE', 'other', 'x', 'critical');")
   SELECT count(*) FROM public.ride_disputes;" "$PRIORITY_REFUSED;$PRIORITY_REFUSED;0"
val "D8 unchanged: the respondent can still move a dispute to under_review and answer, and still cannot touch the rest" \
  "$SEED INSERT INTO public.ride_disputes (ride_id, opened_by, reason, description, priority, respondent_id) VALUES ('$DONE', '$ALICE', 'other', 'x', 'high', '$BOB');
   $(as $BOB "UPDATE public.ride_disputes SET status = 'under_review', respondent_message = 'Cobre lo justo', refund_amount_trc = 5, priority = 'low';")
   SELECT status || '|' || respondent_message || '|' || coalesce(refund_amount_trc::text, '-') || '|' || priority FROM public.ride_disputes;" \
  "under_review|Cobre lo justo|-|high"

# W. rides.wallet_ratio
val "W1 a ride cannot be created paying 500 % of the fare from the wallet" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.rides (customer_id, payment_method, wallet_ratio) VALUES ('$ALICE', 'mixed', 5);")
   SELECT count(*) FROM public.rides WHERE customer_id = '$ALICE';" "$RATIO_REFUSED;3"
val "W2 ...nor a negative share" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.rides (customer_id, payment_method, wallet_ratio) VALUES ('$ALICE', 'mixed', -0.5);")
   SELECT count(*) FROM public.rides WHERE customer_id = '$ALICE';" "$RATIO_REFUSED;3"
val "W3 every share the app's slider can produce (0 to 1) still goes in" \
  "$SEED $(try authenticated $ALICE "INSERT INTO public.rides (customer_id, payment_method, wallet_ratio) VALUES ('$ALICE', 'mixed', 0), ('$ALICE', 'mixed', 0.5), ('$ALICE', 'mixed', 1);")
   SELECT count(*) FROM public.rides WHERE customer_id = '$ALICE';" "ok;6"
# (in prod enforce_ride_update_columns already refuses a rider's change; the CHECK binds every writer)
val "W4 no writer, not even the service role, can move an existing ride above 100 %" \
  "$SEED $(try service_role '' "UPDATE public.rides SET wallet_ratio = 2 WHERE id = '$SEARCHING';")
   SELECT wallet_ratio FROM public.rides WHERE id = '$SEARCHING';" "$RATIO_REFUSED;0.50"

# C. customer_profiles.rating_avg
val "C1 a new customer profile starts at 5.00 whatever rating it sends" \
  "$SEED $(try authenticated $ERIN "INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES ('$ERIN', 1.23);")
   SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$ERIN';" "ok;5.00"
val "C2 the app's own insert (no rating, its own preferences) is unchanged" \
  "$SEED $(try authenticated $ERIN "INSERT INTO public.customer_profiles (user_id, default_payment_method, saved_locations, emergency_contact)
     VALUES ('$ERIN', 'tricicoin', '[{\"label\": \"Casa\"}]', NULL);")
   SELECT rating_avg || '|' || default_payment_method || '|' || jsonb_array_length(saved_locations) FROM public.customer_profiles WHERE user_id = '$ERIN';" "ok;5.00|tricicoin|1"
val "C3 the service role can still create a profile with any rating" \
  "$SEED $(try service_role '' "INSERT INTO public.customer_profiles (user_id, rating_avg) VALUES ('$ERIN', 3.40);")
   SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$ERIN';" "ok;3.40"
val "C4 unchanged: a rider still cannot rewrite their rating" \
  "$SEED $(try authenticated $ALICE "UPDATE public.customer_profiles SET rating_avg = 5.00 WHERE user_id = '$ALICE';")
   SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$ALICE';" "ok;4.20"
val "C5 unchanged: apply_user_rating's trusted path still writes it" \
  "$SEED $(try authenticated $ALICE "PERFORM set_config('app.trusted_driver_update', '1', true); UPDATE public.customer_profiles SET rating_avg = 3.10 WHERE user_id = '$ALICE';")
   SELECT rating_avg FROM public.customer_profiles WHERE user_id = '$ALICE';" "ok;3.10"

# K. contract
val "K1 the dispute guard runs BEFORE INSERT; the rating guard now covers INSERT and UPDATE" \
  "SELECT string_agg(pg_get_triggerdef(t.oid), ';' ORDER BY t.tgname) FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgname IN ('trg_ride_disputes_protect_insert', 'trg_customer_profiles_protect_rating')" \
  "CREATE TRIGGER trg_customer_profiles_protect_rating BEFORE INSERT OR UPDATE ON public.customer_profiles FOR EACH ROW EXECUTE FUNCTION tg_customer_profiles_protect_rating();CREATE TRIGGER trg_ride_disputes_protect_insert BEFORE INSERT ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION tg_ride_disputes_protect_insert()"
val "K2 the constraints say what the apps say" \
  "SELECT string_agg(conname || ': ' || pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint
   WHERE conname IN ('chk_dispute_priority_valid', 'rides_wallet_ratio_range')" \
  "chk_dispute_priority_valid: CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));rides_wallet_ratio_range: CHECK (((wallet_ratio IS NULL) OR ((wallet_ratio >= (0)::numeric) AND (wallet_ratio <= (1)::numeric))))"
val "K3 the dispute UPDATE guard is untouched, and no client role can call the new guard" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_ride_disputes_protect_columns()'::regprocedure;
   SELECT string_agg(r || ':' || has_function_privilege(r, 'public.tg_ride_disputes_protect_insert()', 'EXECUTE'), ',' ORDER BY r) FROM unnest(ARRAY['anon', 'authenticated']) r" \
  "e7c521901228c1119a51219ea934544c/1461;anon:false,authenticated:false"

# N. negative proofs: a copy of the migration with a step taken out, or a database it must refuse; it must abort
if [ "$MIG" != "none" ]; then
  WORK="$(mktemp -d)"
  # buggy NAME START END [START END ...] -> copy of the migration without each START..END span
  #                                         (an empty END removes exactly the line START)
  buggy(){
    local name="$1"; shift
    "$PY" - "$MIG" "$WORK/$name.sql" "$@" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
out, args = src, sys.argv[3:]
assert len(args) % 2 == 0
for start, end in zip(args[0::2], args[1::2]):
    if end == "":
        line = start + "\n"
        assert out.count(line) == 1, f"expected {line!r} once, found {out.count(line)}"
        out = out.replace(line, "")
    else:
        assert out.count(start) == 1 and out.count(end) == 1, (start, end)
        i, j = out.index(start), out.index(end)
        assert i < j
        out = out[:i] + out[j:]
assert out != src
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(out)
PYEOF
  }
  # expect_abort FILE TEST MESSAGE [SETUP] -> FILE must fail on a fresh database (plus SETUP) with MESSAGE
  #   (an exact message: psql prefixes every error with the file name, which contains "00607")
  expect_abort(){
    local db="${DB}n" out
    if ! fresh $db "${4:-}"; then ko "$2" "could not build the database"; return; fi
    if out=$($BIN/psql $CONN -d $db -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$1" 2>&1); then
      ko "$2" "the migration succeeded"
    elif echo "$out" | grep -qF "$3"; then
      ok "$2"
    else
      ko "$2" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
    fi
  }
  SELFTEST="ERROR:  00607 self-test:"
  if buggy n1 "CREATE OR REPLACE TRIGGER trg_ride_disputes_protect_insert BEFORE INSERT ON public.ride_disputes FOR EACH ROW EXECUTE FUNCTION public.tg_ride_disputes_protect_insert();" ""; then
    expect_abort "$WORK/n1.sql" "N1 the self-test aborts a migration that does not install the dispute guard" "$SELFTEST the BEFORE INSERT guard on ride_disputes is missing"
  else ko "N1 the self-test aborts a migration that does not install the dispute guard" "could not build the buggy copy"; fi
  if buggy n2 "ALTER TABLE public.rides VALIDATE CONSTRAINT rides_wallet_ratio_range;" ""; then
    expect_abort "$WORK/n2.sql" "N2 the self-test aborts a migration that leaves the wallet_ratio check unvalidated" "$SELFTEST rides_wallet_ratio_range is missing or not validated"
  else ko "N2 the self-test aborts a migration that leaves the wallet_ratio check unvalidated" "could not build the buggy copy"; fi
  if buggy n3 "CREATE OR REPLACE TRIGGER trg_customer_profiles_protect_rating BEFORE INSERT OR UPDATE ON public.customer_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_customer_profiles_protect_rating();" ""; then
    expect_abort "$WORK/n3.sql" "N3 the self-test aborts a migration that leaves the rating guard on UPDATE only" "$SELFTEST the rating guard on customer_profiles does not cover INSERT and UPDATE"
  else ko "N3 the self-test aborts a migration that leaves the rating guard on UPDATE only" "could not build the buggy copy"; fi
  expect_abort "$MIG" "N4 the migration refuses to replace a rating guard whose live body it does not know"     "ERROR:  00607: tg_customer_profiles_protect_rating has a body this migration does not know"     "CREATE OR REPLACE FUNCTION public.tg_customer_profiles_protect_rating() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
       SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN NEW; END; \$f\$;"
  expect_abort "$MIG" "N5 the self-test aborts if another BEFORE INSERT trigger could undo a guard"     "$SELFTEST other BEFORE INSERT triggers could undo the guards"     "CREATE FUNCTION public.zz_put_rating_back() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN NEW.rating_avg := 1.00; RETURN NEW; END; \$f\$;
     CREATE TRIGGER zz_put_rating_back BEFORE INSERT ON public.customer_profiles FOR EACH ROW EXECUTE FUNCTION public.zz_put_rating_back();"
  rm -rf "$WORK"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
