#!/usr/bin/env bash
# Rehearsal runner for migration 00599 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00599/run.sh none
#       -> scaffold + tests (RED: a user's own JWT writes any number to users.phone,
#          and the gift / recharge lookups hand that number's money to whoever wrote it)
#   supabase/tests/00599/run.sh supabase/migrations/00599_users_phone_only_verified_number.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00599/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr599
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

SEED="$(cat "$DIR/seed.sql")"
ALICE=a0000000-0000-4000-8000-000000000001   # customer, confirmed +5355550001
BOB=a0000000-0000-4000-8000-000000000002     # approved driver, confirmed +5355550002
CAROL=a0000000-0000-4000-8000-000000000003   # admin, +5355550003 in users.phone, nothing in auth
DAVE=a0000000-0000-4000-8000-000000000004    # super_admin, +5355550004 in users.phone, nothing in auth
ERIN=a0000000-0000-4000-8000-000000000005    # Google sign-in, no number anywhere
FRANK=a0000000-0000-4000-8000-000000000006   # 5355550006 in auth, never confirmed
GRACE=a0000000-0000-4000-8000-000000000007   # confirmed non-Cuban +5511999990007
# as UID SQL -> SQL run the way PostgREST runs a request (role authenticated, JWT subject UID), then back to the test role
as(){ printf "SET request.jwt.claim.sub = '%s'; SET ROLE authenticated; %s RESET ROLE; RESET request.jwt.claim.sub;" "$1" "$2"; }
# phone UID -> that account's users.phone ('-' for NULL)
phone(){ printf "SELECT coalesce(phone, '-') FROM public.users WHERE id = '%s';" "$1"; }
# gift NUMBER -> what the gift / fare-split lookup answers a signed-in caller (Grace)
gift(){ as $GRACE "SELECT coalesce(string_agg(full_name || '|' || phone, ','), 'nobody') FROM public.find_user_by_phone('$1');"; }
# recharge NUMBER -> what the diaspora recharge lookup answers the Edge Functions (service role, no subject)
recharge(){ printf "SELECT coalesce(string_agg(full_name, ','), 'nobody') FROM public.find_recipient_for_recharge('%s');" "$1"; }
# LOG -> telemetry rows, oldest first
LOG="SELECT coalesce(string_agg(rpc_name || ':' || outcome || ':' || coalesce(metadata->>'reason', '-'), ',' ORDER BY id), 'none') FROM public.rpc_attempt_log;"
# SHARE -> Carol (admin) also keeps Bob's number in users.phone, like Luis Manuel's admin account does in prod,
#          then Bob's row is written (his next ride), so a scan now meets Carol's row first
SHARE="UPDATE public.users SET phone = '+5355550002' WHERE id = '$CAROL'; UPDATE public.users SET total_rides = total_rides + 1 WHERE id = '$BOB';"
ROWS="SELECT md5(coalesce((SELECT string_agg(u::text, ',' ORDER BY u.id) FROM public.users u), '')
          || coalesce((SELECT string_agg(a::text, ',' ORDER BY a.id) FROM auth.users a), '')
          || coalesce((SELECT string_agg(d::text, ',' ORDER BY d.id) FROM public.driver_profiles d), '')
          || coalesce((SELECT string_agg(l::text, ',' ORDER BY l.id) FROM public.rpc_attempt_log l), ''))"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
$P -c "$SEED" >/dev/null 2>&1 || { echo "seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('tg_users_protect_admin_fields', 'find_user_by_phone',
         'find_recipient_for_recharge', 'tg_users_normalize_phone', '_normalize_cuban_phone', 'is_admin', 'log_rpc_attempt')" \
  "_normalize_cuban_phone:9f5227a3c108fa42f6aacdf01fb0ad86/451,find_recipient_for_recharge:b7fd2c337019b168f81094baf08bb757/169,find_user_by_phone:18b575b1a8eddaf734c3ec2644f065ca/577,is_admin:22cb75e91980d512498034cd33e1eda2/285,log_rpc_attempt:0a902c34a1148dac5686403a7c941bc0/203,tg_users_normalize_phone:c0491b42cf36767c3911fb8a3fda9f04/147,tg_users_protect_admin_fields:2907fccbd0f2ec2201b7c0ec61d434a3/1701"

if [ "$MIG" != "none" ]; then
  BEFORE=$($P -c "$ROWS" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration's self-test leaves every row exactly as it was" "$ROWS" "$BEFORE"
  # Take the DECLARE and the block marked 00599 out of the new trigger body: what is left must be the live body.
  val "M2 the new trigger body is the live one plus the 00599 guard, byte for byte" \
    "SELECT md5(s) || '/' || length(s) FROM (
       SELECT replace(substr(prosrc, 1, position('  -- 00599:' in prosrc) - 1)
                        || substr(prosrc, position('  IF current_setting(''app.trusted_tier_update''' in prosrc)),
                      E'DECLARE\n  v_verified text;\n', '') AS s
       FROM pg_proc WHERE oid = 'public.tg_users_protect_admin_fields()'::regprocedure) x" \
    "2907fccbd0f2ec2201b7c0ec61d434a3/1701"
fi

echo "== tests =="
# A. who may write users.phone with a JWT that is not an admin's
val "A1 a customer cannot take another account's confirmed number" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = '+5355550002' WHERE id = '$ALICE';") $(phone $ALICE)" "+5355550001"
val "A2 ...nor a number nobody holds" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = '55559999' WHERE id = '$ALICE';") $(phone $ALICE)" "+5355550001"
val "A3 an account with no confirmed number cannot give itself one (Google sign-in)" \
  "$SEED $(as $ERIN "UPDATE public.users SET phone = '+5355559999' WHERE id = '$ERIN';") $(phone $ERIN)" "-"
val "A4 a number auth.users holds but never confirmed does not count" \
  "$SEED $(as $FRANK "UPDATE public.users SET phone = '55550006' WHERE id = '$FRANK';") $(phone $FRANK)" "-"
val "A5 clearing the number is put back too" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = NULL WHERE id = '$ALICE';") $(phone $ALICE)" "+5355550001"
val "A6 a multi-field save keeps its other fields and loses only the number" \
  "$SEED $(as $ALICE "UPDATE public.users SET full_name = 'Alice Perez', phone = '+5355550002' WHERE id = '$ALICE';")
   SELECT full_name || '|' || phone FROM public.users WHERE id = '$ALICE';" "Alice Perez|+5355550001"
val "A7 a driver cannot take a customer's number either" \
  "$SEED $(as $BOB "UPDATE public.users SET phone = '+5355550001' WHERE id = '$BOB';") $(phone $BOB)" "+5355550002"
val "A8 verify-phone after link-phone: writing the confirmed number again is saved, nothing logged" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = '+5355550001', full_name = 'Alice P' WHERE id = '$ALICE';")
   SELECT full_name || '|' || phone FROM public.users WHERE id = '$ALICE'; $LOG" "Alice P|+5355550001;none"
val "A9 link-phone's mirror lost: the app may copy the number its account just confirmed, in any spelling" \
  "$SEED UPDATE auth.users SET phone = '5355550005', phone_confirmed_at = now() WHERE id = '$ERIN';
   $(as $ERIN "UPDATE public.users SET phone = '55550005' WHERE id = '$ERIN';") $(phone $ERIN) $LOG" "+5355550005;none"
val "A10 a confirmed non-Cuban number is accepted in any spelling and stored as E.164" \
  "$SEED UPDATE public.users SET phone = NULL WHERE id = '$GRACE';
   $(as $GRACE "UPDATE public.users SET phone = '55 11 99999-0007' WHERE id = '$GRACE';") $(phone $GRACE)" "+5511999990007"
val "A11 ...and another non-Cuban number is put back" \
  "$SEED $(as $GRACE "UPDATE public.users SET phone = '+5511888880000' WHERE id = '$GRACE';") $(phone $GRACE)" "+5511999990007"

# T. callers the guard does not limit, and trusted contexts that must not open it
val "T1 no JWT (link-phone's service-role mirror, triggers, cron) writes any number" \
  "$SEED UPDATE public.users SET phone = '+5355557777' WHERE id = '$ALICE'; $(phone $ALICE)" "+5355557777"
val "T2 so does the service key through PostgREST (role service_role, no subject)" \
  "$SEED SET request.jwt.claims = '{\"role\":\"service_role\"}'; SET ROLE service_role;
   UPDATE public.users SET phone = '+5355557777' WHERE id = '$ALICE'; RESET ROLE; RESET request.jwt.claims; $(phone $ALICE)" "+5355557777"
val "T3 an admin still edits her own number freely, nothing logged" \
  "$SEED $(as $CAROL "UPDATE public.users SET phone = '+5355556666' WHERE id = '$CAROL';") $(phone $CAROL) $LOG" "+5355556666;none"
val "T4 so does a super admin" \
  "$SEED $(as $DAVE "UPDATE public.users SET phone = '+5355556667' WHERE id = '$DAVE';") $(phone $DAVE)" "+5355556667"
val "T5 a trusted tier update under the user's JWT still guards the number (and still moves the level)" \
  "$SEED $(as $ALICE "SET app.trusted_tier_update = '1'; UPDATE public.users SET level = 'plata', phone = '+5355550002' WHERE id = '$ALICE'; RESET app.trusted_tier_update;")
   SELECT level || '|' || phone FROM public.users WHERE id = '$ALICE';" "plata|+5355550001"
val "T6 so does a trusted cancel update (and it still counts the cancellation)" \
  "$SEED $(as $ALICE "SET app.trusted_cancel_update = '1'; UPDATE public.users SET cancellation_count = 5, phone = '+5355550002' WHERE id = '$ALICE'; RESET app.trusted_cancel_update;")
   SELECT cancellation_count || '|' || phone FROM public.users WHERE id = '$ALICE';" "5|+5355550001"

# R. the rest of the protect trigger behaves exactly as before
val "R1 a customer still cannot change her role or level" \
  "$SEED $(as $ALICE "UPDATE public.users SET role = 'admin', level = 'diamante' WHERE id = '$ALICE';")
   SELECT role || '|' || level FROM public.users WHERE id = '$ALICE';" "customer|bronce"
val "R2 ...still changes her name, and nothing is logged" \
  "$SEED $(as $ALICE "UPDATE public.users SET full_name = 'Ali' WHERE id = '$ALICE';")
   SELECT full_name FROM public.users WHERE id = '$ALICE'; $LOG" "Ali;none"
val "R3 an admin still cannot change her own level" \
  "$SEED $(as $CAROL "UPDATE public.users SET level = 'oro' WHERE id = '$CAROL';")
   SELECT level FROM public.users WHERE id = '$CAROL';" "bronce"
val "R4 RLS: a customer cannot touch someone else's row at all" \
  "$SEED $(as $ALICE "WITH u AS (UPDATE public.users SET full_name = 'x' WHERE id = '$BOB' RETURNING 1) SELECT count(*) FROM u;")" "0"

# L. every put-back write leaves a trace, without the number
val "L1 one rpc_attempt_log row per put-back write: who, whose row, why" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = '+5355550002' WHERE id = '$ALICE';")
   SELECT rpc_name || '|' || (caller_uid = '$ALICE') || '|' || (target_id = '$ALICE') || '|' || outcome || '|' || (metadata->>'reason') FROM public.rpc_attempt_log;" \
  "users_phone_guard|true|true|reverted|not_the_verified_phone"
val "L2 the reason tells no confirmed number, a never-confirmed one and clearing apart" \
  "$SEED $(as $ERIN "UPDATE public.users SET phone = '+5355559999' WHERE id = '$ERIN';")
   $(as $FRANK "UPDATE public.users SET phone = '+5355550006' WHERE id = '$FRANK';")
   $(as $ALICE "UPDATE public.users SET phone = NULL WHERE id = '$ALICE';") $LOG" \
  "users_phone_guard:reverted:no_verified_phone,users_phone_guard:reverted:no_verified_phone,users_phone_guard:reverted:cleared"
val "L3 no phone number ever reaches the log" \
  "$SEED $(as $ALICE "UPDATE public.users SET phone = '+5355550002' WHERE id = '$ALICE';")
   SELECT count(*) FROM public.rpc_attempt_log WHERE metadata::text ~ '[0-9]{7}';" "0"

# B. the money lookups resolve a number through the one account that confirmed it
val "B1 gift: a number another account also keeps in users.phone goes to its confirmed owner" "$SEED $SHARE $(gift 55550002)" "Bob|+5355550002"
val "B2 recharge: same" "$SEED $SHARE $(recharge +5355550002)" "Bob"
val "B3 gift: a number kept only in users.phone (never confirmed) goes to nobody" "$SEED $(gift +5355550004)" "nobody"
val "B4 recharge: same" "$SEED $(recharge 55550004)" "nobody"
val "B5 a number auth.users never confirmed goes to nobody, even when users.phone repeats it" \
  "$SEED UPDATE public.users SET phone = '+5355550006' WHERE id = '$FRANK'; $(gift 55550006) $(recharge 55550006)" "nobody;nobody"
val "B6 every spelling of a confirmed number finds its owner" \
  "$SEED $(recharge 55550002) $(recharge 5355550002) $(recharge '+53 5555-0002')" "Bob;Bob;Bob"
val "B7 a confirmed non-Cuban number is found in any spelling" \
  "$SEED $(gift +5511999990007) $(recharge 5511999990007)" "Grace|+5511999990007;Grace"
val "B8 a deactivated account is nobody's recipient" \
  "$SEED UPDATE public.users SET is_active = false WHERE id = '$BOB'; $(gift 55550002) $(recharge 55550002)" "nobody;nobody"
val "B9 two confirmed accounts behind one number (both spellings in auth): no guess" \
  "$SEED INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('a0000000-0000-4000-8000-000000000008', '+5355550002', now());
   INSERT INTO public.users (id, full_name) VALUES ('a0000000-0000-4000-8000-000000000008', 'Henry');
   $(gift 55550002) $(recharge 55550002)" "nobody;nobody"
val "B10 a number nobody holds goes to nobody" "$SEED $(gift 55551111) $(recharge 55551111)" "nobody;nobody"
val "B11 the gift lookup still refuses a caller without a session" \
  "$SEED CREATE TEMP TABLE r (v text);
   DO \$d\$ BEGIN
     BEGIN PERFORM public.find_user_by_phone('55550002'); INSERT INTO r VALUES ('answered');
     EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES (SQLERRM); END;
   END \$d\$;
   SELECT v FROM r;" "Forbidden: authentication required"
val "B12 the gift lookup still spends the caller's rate limit, 30 an hour (anti-enumeration)" \
  "$SEED $(gift 55550002) SELECT key || '|' || max_requests || '|' || window_seconds FROM public.rate_limit_calls;" \
  "Bob|+5355550002;find_user_by_phone:$GRACE|30|3600"
val "B13 ...and a caller over it gets an error, not an answer" \
  "$SEED CREATE TEMP TABLE r (v text); SET request.jwt.claim.sub = '$FRANK';
   DO \$d\$ BEGIN
     BEGIN PERFORM public.find_user_by_phone('55550002'); INSERT INTO r VALUES ('answered');
     EXCEPTION WHEN OTHERS THEN INSERT INTO r VALUES (SQLERRM); END;
   END \$d\$;
   SELECT v FROM r;" "Rate limit exceeded: max 30 phone lookups per hour"

# C. contract: same signatures, execution context and privileges as before
val "C1 the protect trigger function keeps its context and stays out of clients' reach" \
  "SELECT prosecdef || '|' || array_to_string(proconfig, ',') || '|' || has_function_privilege('anon', oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', oid, 'EXECUTE')
   FROM pg_proc WHERE oid = 'public.tg_users_protect_admin_fields()'::regprocedure" "true|search_path=public, pg_catalog|false|false"
val "C2 the two BEFORE triggers on public.users are unchanged" \
  "SELECT string_agg(pg_get_triggerdef(oid), ' ; ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal" \
  "CREATE TRIGGER tg_users_normalize_phone BEFORE INSERT OR UPDATE OF phone ON public.users FOR EACH ROW EXECUTE FUNCTION tg_users_normalize_phone() ; CREATE TRIGGER trg_users_protect_admin_fields BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION tg_users_protect_admin_fields()"
val "C3 find_user_by_phone: same signature and context, signed-in users only" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || array_to_string(proconfig, ',') || '|'
          || has_function_privilege('anon', oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', oid, 'EXECUTE') || '|' || has_function_privilege('service_role', oid, 'EXECUTE')
   FROM pg_proc WHERE oid = 'public.find_user_by_phone(text)'::regprocedure" \
  "p_phone text|TABLE(id uuid, full_name text, phone text)|true|search_path=public, pg_catalog|false|true|true"
val "C4 find_recipient_for_recharge: same signature and context, service role only" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || provolatile::text || '|' || array_to_string(proconfig, ',') || '|'
          || has_function_privilege('anon', oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', oid, 'EXECUTE') || '|' || has_function_privilege('service_role', oid, 'EXECUTE')
   FROM pg_proc WHERE oid = 'public.find_recipient_for_recharge(text)'::regprocedure" \
  "p_phone text|TABLE(id uuid, full_name text)|true|s|search_path=public, pg_catalog|false|false|true"

# N. negative proofs: put each bug back into a copy of the migration; its self-test must abort it
if [ "$MIG" != "none" ]; then
  WORK="$(mktemp -d)"
  # buggy NAME START END -> copy of the migration without the text from START up to (not including) END
  buggy(){
    "$PY" - "$MIG" "$WORK/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding="utf-8").read()
start, end = sys.argv[3], sys.argv[4]
assert src.count(start) == 1, f"expected {start!r} once, found {src.count(start)}"
assert src.count(end) == 1, f"expected {end!r} once, found {src.count(end)}"
i, j = src.index(start), src.index(end)
assert i < j
out = src[:i] + src[j:]
assert out != src
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(out)
PYEOF
  }
  # expect_abort NAME -> the buggy copy must fail on a fresh database, with the self-test's message
  expect_abort(){
    local db="${DB}$1" out
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db" >/dev/null 2>&1
    local Q="$BIN/psql $CONN -d $db -qAt -v ON_ERROR_STOP=1"
    $Q -f "$DIR/scaffold.sql" >/dev/null 2>&1; $Q -c "$SEED" >/dev/null 2>&1
    if out=$($Q -1 -c "SET search_path = ''" -f "$WORK/$1.sql" 2>&1); then
      ko "$2" "the migration succeeded with the bug in place"
    elif echo "$out" | grep -q "00599 self-test"; then
      ok "$2"
    else
      ko "$2" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
    fi
  }
  if buggy n1 "  IF NEW.phone IS DISTINCT FROM OLD.phone" "  IF current_setting('app.trusted_tier_update', true) = '1' THEN"; then
    expect_abort n1 "N1 the self-test aborts a migration whose trigger lets the number through"
  else
    ko "N1 the self-test aborts a migration whose trigger lets the number through" "could not build the buggy copy"
  fi
  if buggy n2 "-- 2. Gift and fare-split lookup" "-- 4. Self-test"; then
    expect_abort n2 "N2 the self-test aborts a migration whose lookups still trust users.phone"
  else
    ko "N2 the self-test aborts a migration whose lookups still trust users.phone" "could not build the buggy copy"
  fi
  rm -rf "$WORK"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
