#!/usr/bin/env bash
# Rehearsal runner for migration 00664 (accepting a team invitation with an e-mail code; local Postgres 16).
#   supabase/tests/00664/run.sh none
#       -> 00661 scaffold + seed + migration, the 00664 extras, tests without 00664 (RED)
#   supabase/tests/00664/run.sh supabase/migrations/00664_team_invitation_email_code.sql
#       -> the same + 00664 x2 (idempotency) + tests + negative proofs of the self-checks (GREEN)
# Builds on supabase/tests/00661 (scaffold, seed) and applies 00661 itself first, as prod has it.
# Every migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00664/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
BASE="$ROOT/supabase/tests/00661"
M661="$ROOT/supabase/migrations/00661_team_invitations.sql"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB="${RUN_DB:-pr664}"
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED (\r dropped for Windows)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$BASE/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$BASE/seed.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M661" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

SAM=a1000000-0000-4000-8000-000000000001
ANA=a1000000-0000-4000-8000-000000000002
MIA=a1000000-0000-4000-8000-000000000003
CARL=a1000000-0000-4000-8000-000000000004
PETE=a1000000-0000-4000-8000-000000000006
BOB=a1000000-0000-4000-8000-000000000007
EVE=a1000000-0000-4000-8000-000000000008
PHIL=a1000000-0000-4000-8000-00000000000b
BEN=a1000000-0000-4000-8000-00000000000c
NINA=a1000000-0000-4000-8000-00000000000d

# svc SQL -> SQL as the Edge Function (role service_role) in a transaction that is rolled back.
# su / sr switch to the test superuser and back to service_role inside an svc block.
svc(){ printf "BEGIN; SET LOCAL client_min_messages = error; SET LOCAL ROLE service_role; %s ROLLBACK;" "$1"; }
su(){ printf "RESET ROLE;"; }
sr(){ printf "SET LOCAL ROLE service_role;"; }
# inv EMAIL ROLE C -> a pending invitation (token: 64 times the hex character C), invited by SAM
inv(){ printf "INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('%s', '%s', repeat('%s', 64), '$SAM', now() + interval '1 day');" "$1" "$2" "$3"; }
# issue C -> prints the result of team_invitation_code_issue and keeps the code in test.code
issue(){ printf "SELECT r->>'result' FROM (SELECT public.team_invitation_code_issue(repeat('%s', 64)) r) x WHERE set_config('test.code', coalesce(r->>'code', ''), true) IS NOT NULL;" "$1"; }
# chk C CODE_SQL -> 'result|attempts_left' of team_invitation_code_check
chk(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'attempts_left', '') FROM (SELECT public.team_invitation_code_check(repeat('%s', 64), %s) r) x;" "$1" "$2"; }
# okc C USER -> 'result|case|user_id is USER' of a check with the right code
okc(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'case', '') || '|' || coalesce(((r->>'user_id') = '%s')::text, '') FROM (SELECT public.team_invitation_code_check(repeat('%s', 64), current_setting('test.code')) r) x;" "$2" "$1"; }
# acc C USER -> 'result|role' of accept_team_invitation_by_code
acc(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'role', '') FROM (SELECT public.accept_team_invitation_by_code(repeat('%s', 64), '%s') r) x;" "$1" "$2"; }
out(){ printf "SELECT t.outcome('%s');" "$1"; }
RIGHT="current_setting('test.code')"
WRONG="CASE WHEN current_setting('test.code') = '000000' THEN '111111' ELSE '000000' END"
FNS="'_team_code_hash', '_team_code_account', 'team_invitation_code_issue', 'team_invitation_code_check', 'accept_team_invitation_by_code'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"

echo "== reset database =="
fresh $DB || { echo "scaffold, seed or 00661 failed"; exit 1; }
val "S0 the scaffold carries the live check_rate_limit body" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.check_rate_limit(text, integer, integer)'::regprocedure" \
  "5a2e61635bf60849be2e5ca41cbd9889/527"
val "S1 00661 is applied, as in prod" "SELECT to_regprocedure('public.accept_team_invitation(text)') IS NOT NULL" "t"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 both tables have RLS and only service_role can read them" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('service_role', c.oid, 'SELECT'), ',' ORDER BY c.relname COLLATE \"C\") FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('team_invitation_codes', 'team_invitation_code_salt')" \
  "team_invitation_code_salt:true:falsefalsetrue,team_invitation_codes:true:falsefalsetrue"
val "O2 no client executes the new functions; the service role does; all SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') || ':' || p.prosecdef, ',' ORDER BY p.proname COLLATE \"C\") FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)" \
  "_team_code_account:falsefalsetrue:true,_team_code_hash:falsefalsetrue:true,accept_team_invitation_by_code:falsefalsetrue:true,team_invitation_code_check:falsefalsetrue:true,team_invitation_code_issue:falsefalsetrue:true"
val "O3 one salt, 32 random bytes in hex" \
  "SELECT count(*) || ':' || bool_and(salt ~ '^[0-9a-f]{64}\$') FROM public.team_invitation_code_salt" "1:true"
val "O4 anon cannot ask for a code; a signed-in user cannot accept with one" \
  "BEGIN; SET LOCAL ROLE anon; $(out "SELECT public.team_invitation_code_issue(repeat(''a'', 64))::text") RESET ROLE; SET LOCAL request.jwt.claim.sub = '$PETE'; SET LOCAL ROLE authenticated; $(out "SELECT public.accept_team_invitation_by_code(repeat(''a'', 64), ''$PETE'')::text") ROLLBACK;" \
  "raised 42501: permission denied for function team_invitation_code_issue;raised 42501: permission denied for function accept_team_invitation_by_code"

echo "== issuing a code =="
val "I1 a pending invitation gets a 6-digit code for its address; only the hash is stored, for 10 minutes" \
  "$(svc "$(inv nina@bacoagency.com marketing a) SELECT (r->>'result') || '|' || (r->>'code' ~ '^[0-9]{6}\$') || '|' || (r->>'email') || '|' || (r->>'account_exists') || '|' || (r->>'expires_in_s') || '|' || (r->>'full_name') FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT (code_hash ~ '^[0-9a-f]{64}\$') || '|' || attempts || '|' || (expires_at = now() + interval '10 minutes') FROM public.team_invitation_codes;")" \
  "issued|true|nina@bacoagency.com|false|600|;true|0|true"
val "I2 the stored hash is the salted HMAC of the code, not a plain hash" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (c.code_hash = public._team_code_hash(c.invitation_id, current_setting('test.code'))) || '|' || (c.code_hash <> encode(sha256(convert_to(current_setting('test.code'), 'UTF8')), 'hex')) FROM public.team_invitation_codes c;")" \
  "issued;true|true"
val "I3 the answer says whether the address already has an account" \
  "$(svc "$(inv pete@example.com admin b) SELECT public.team_invitation_code_issue(repeat('b', 64))->>'account_exists';")" "true"
val "I4 a second code within 60 s is refused, with the seconds left" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 59 AND 60) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x;")" \
  "issued;cooldown|true"
val "I5 after 60 s a new code replaces the old one and resets the attempts" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(su) UPDATE public.team_invitation_codes SET sent_at = now() - interval '61 seconds', attempts = 3; $(sr) $(issue a) SELECT attempts || '|' || (sent_at = now()) FROM public.team_invitation_codes;")" \
  "issued;issued;0|true"
val "I6 the sixth code in an hour is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-hour:' || id, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 5 FROM public.team_invitations; $(sr) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 1 AND 3600) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT count(*) FROM public.team_invitation_codes;")" \
  "too_many_hour|true;0"
val "I7 the eleventh code in a day is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-day:' || id, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 10 FROM public.team_invitations; $(sr) SELECT (r->>'result') || '|' || ((r->>'retry_after_s')::int BETWEEN 1 AND 86400) FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT count(*) FROM public.team_invitation_codes;")" \
  "too_many_day|true;0"
val "I8 expired, canceled, used, internal, unknown and malformed invitations get no code" \
  "$(svc "$(su) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at, status) VALUES ('x1@example.com', 'admin', repeat('1', 64), '$SAM', now() - interval '1 minute', 'pending'), ('x2@example.com', 'admin', repeat('2', 64), '$SAM', now() + interval '1 day', 'canceled'), ('x3@example.com', 'admin', repeat('3', 64), '$SAM', now() + interval '1 day', 'accepted'), ('ops@tricigo.app', 'admin', repeat('4', 64), '$SAM', now() + interval '1 day', 'pending'); $(sr) SELECT string_agg(public.team_invitation_code_issue(v.t)->>'result', ',' ORDER BY v.n) FROM (VALUES (1, repeat('1', 64)), (2, repeat('2', 64)), (3, repeat('3', 64)), (4, repeat('4', 64)), (5, repeat('9', 64)), (6, 'nope')) v (n, t); SELECT count(*) FROM public.team_invitation_codes;")" \
  "expired,canceled,used,internal_address,not_found,not_found;0"

echo "== checking a code =="
val "C1 a wrong code costs an attempt and says how many are left" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "$WRONG") SELECT attempts FROM public.team_invitation_codes;")" \
  "issued;wrong_code|4;1"
val "C2 after five wrong codes even the right one is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$WRONG") $(chk a "$RIGHT")")" \
  "issued;wrong_code|4;wrong_code|3;wrong_code|2;wrong_code|1;locked|;locked|"
val "C3 a malformed or missing code also costs an attempt" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(chk a "'12 34'") $(chk a "NULL")")" \
  "issued;wrong_code|4;wrong_code|3"
val "C4 a code older than 10 minutes is refused" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(su) UPDATE public.team_invitation_codes SET expires_at = now() - interval '1 second'; $(sr) $(chk a "$RIGHT")")" \
  "issued;code_expired|"
val "C5 the right code answers the address, role and case once, and is gone after" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) SELECT (r->>'result') || '|' || (r->>'email') || '|' || (r->>'role') || '|' || (r->>'case') || '|' || coalesce(r->>'user_id', '-') FROM (SELECT public.team_invitation_code_check(repeat('a', 64), current_setting('test.code')) r) x; SELECT count(*) FROM public.team_invitation_codes; $(chk a "$RIGHT")")" \
  "issued;ok|nina@bacoagency.com|marketing|new|-;0;no_code|"
val "C6 checking before asking for a code says so" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(chk a "'123456'")")" "no_code|"
val "C7 the account cases: proven (with a phone), password only, phone, unverified Google, blocked, banned" \
  "$(svc "$(inv carl@gmail.com marketing c) $(issue c) $(okc c $CARL) $(inv pete@example.com marketing b) $(issue b) $(okc b $PETE) $(inv phil@example.com marketing d) $(issue d) $(okc d $PHIL) SELECT count(*) FROM public.team_invitation_codes c JOIN public.team_invitations i ON i.id = c.invitation_id WHERE i.email = 'phil@example.com'; $(inv eve@gmail.com marketing e) $(issue e) $(okc e $EVE) $(inv bob@gmail.com marketing 1) $(issue 1) $(okc 1 $BOB) $(inv ben@gmail.com marketing 2) $(issue 2) $(okc 2 $BEN)")" \
  "issued;ok|proven|true;issued;ok|password_only|true;issued;needs_google||;1;issued;needs_google||;issued;blocked||;issued;blocked||"

echo "== accepting with a code =="
val "A1 a new account gets the role; the invitation is accepted and audited as e-mail code" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(okc a '') $(su) INSERT INTO public.users (id, email, full_name) VALUES ('$NINA', 'nina@bacoagency.com', 'Nina Baco'); INSERT INTO auth.users (id, email) VALUES ('$NINA', 'nina@bacoagency.com'); INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ('$NINA', 'email', '{\"email\": \"nina@bacoagency.com\", \"email_verified\": true}'); $(sr) $(acc a $NINA) SELECT role FROM public.users WHERE id = '$NINA'; SELECT status || '|' || (accepted_user_id = '$NINA') FROM public.team_invitations; SELECT action || '|' || (new_values->>'method') || '|' || (new_values->>'account') || '|' || (new_values->>'sessions_closed') FROM public.admin_actions;")" \
  "issued;ok|new|;accepted|marketing;marketing;accepted|true;team_invite_accepted|email_code|password_only|0"
val "A2 an existing account loses every session and refresh token" \
  "$(svc "$(su) INSERT INTO auth.sessions (id, user_id) VALUES ('5e550000-0000-4000-8000-000000000001', '$PETE'), ('5e550000-0000-4000-8000-000000000002', '$PETE'); INSERT INTO auth.refresh_tokens (user_id, session_id) VALUES ('$PETE', '5e550000-0000-4000-8000-000000000001'), ('$PETE', NULL); $(sr) $(inv pete@example.com admin b) $(issue b) $(okc b $PETE) $(acc b $PETE) $(su) SELECT (SELECT count(*) FROM auth.sessions) || '|' || (SELECT count(*) FROM auth.refresh_tokens); SELECT u.role || '|' || (a.new_values->>'sessions_closed') FROM public.users u, public.admin_actions a WHERE u.id = '$PETE';")" \
  "issued;ok|password_only|true;accepted|admin;0|0;admin|2"
val "A3 a proven account keeps its confirmed phone" \
  "$(svc "$(inv carl@gmail.com marketing c) $(issue c) $(okc c $CARL) $(acc c $CARL) $(su) SELECT phone || '|' || (phone_confirmed_at IS NOT NULL) FROM auth.users WHERE id = '$CARL';")" \
  "issued;ok|proven|true;accepted|marketing;5355550104|true"
val "A4 another account's id is refused and nothing changes" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(acc a $PETE) SELECT status FROM public.team_invitations; SELECT role FROM public.users WHERE id = '$PETE';")" \
  "wrong_account|;pending;customer"
val "A5 the phone case is refused at accept too, also when the phone was confirmed after the check" \
  "$(svc "$(inv phil@example.com marketing d) $(acc d $PHIL) $(inv pete@example.com marketing b) $(issue b) $(okc b $PETE) $(su) UPDATE auth.users SET phone = '5355550106', phone_confirmed_at = now() WHERE id = '$PETE'; $(sr) $(acc b $PETE) SELECT role FROM public.users WHERE id = '$PETE';")" \
  "needs_google|;issued;ok|password_only|true;needs_google|;customer"
val "A6 blocked and banned accounts are refused" \
  "$(svc "$(inv bob@gmail.com marketing 1) $(acc 1 $BOB) $(inv ben@gmail.com marketing 2) $(acc 2 $BEN)")" \
  "blocked|;blocked|"
val "A7 accepting never lowers a role" \
  "$(svc "$(inv ana@example.com marketing f) $(acc f $ANA) SELECT role FROM public.users WHERE id = '$ANA'; SELECT (old_values->>'role') || '|' || (new_values->>'role') FROM public.admin_actions;")" \
  "accepted|admin;admin;admin|admin"
val "A8 accepting twice answers accepted; another account finds it used" \
  "$(svc "$(inv carl@gmail.com marketing c) $(acc c $CARL) $(acc c $CARL) $(acc c $PETE)")" \
  "accepted|marketing;accepted|marketing;used|"
val "A9 expired and canceled invitations cannot be accepted" \
  "$(svc "$(su) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at, status) VALUES ('pete@example.com', 'admin', repeat('1', 64), '$SAM', now() - interval '1 minute', 'pending'), ('x2@example.com', 'admin', repeat('2', 64), '$SAM', now() + interval '1 day', 'canceled'); $(sr) $(acc 1 $PETE) $(acc 2 $PETE)")" \
  "expired|;canceled|"
val "A10 the Google path of 00661 still accepts" \
  "BEGIN; SET LOCAL client_min_messages = error; SET LOCAL ROLE service_role; $(inv carl@gmail.com marketing c) RESET ROLE; SET LOCAL request.jwt.claim.sub = '$CARL'; SET LOCAL ROLE authenticated; SELECT public.accept_team_invitation(repeat('c', 64))->>'result'; ROLLBACK;" \
  "accepted"

echo "== an accept with a code racing a removal waits for it instead of deadlocking =="
# Same races as 00661 R1/R2, with accept_team_invitation_by_code. MIA is marketing with a proven
# Google address and has an invitation to admin.
race_setup="SET ROLE postgres; INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('mia@example.com', 'admin', repeat('f', 64), '$SAM', now() + interval '1 day');"
R="$BIN/psql $CONN -d ${DB}r -qAt"
TR=$(mktemp -d)
fresh ${DB}r
[ "$MIG" != "none" ] && $BIN/psql $CONN -d ${DB}r -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
$R -c "$race_setup CREATE OR REPLACE FUNCTION public._team_role_rank(p_role text) RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog AS \$f\$ BEGIN IF current_setting('test.slow_rank', true) = '1' THEN PERFORM set_config('test.slow_rank', '', true); PERFORM pg_sleep(2); END IF; RETURN CASE p_role WHEN 'super_admin' THEN 3 WHEN 'admin' THEN 2 WHEN 'marketing' THEN 1 ELSE 0 END; END \$f\$;" >/dev/null 2>&1
( $R -c "BEGIN; SET LOCAL ROLE service_role; SET LOCAL test.slow_rank = '1'; SELECT public.accept_team_invitation_by_code(repeat('f', 64), '$MIA')->>'result'; COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$' > "$TR/accept" ) &
sleep 0.5
rm_out=$($R -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$SAM'; SET LOCAL ROLE authenticated; SELECT public.remove_team_member('$MIA', 'Ya no trabaja aqui'); COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$')
wait
final=$($R -c "SELECT u.role || ':' || i.status FROM public.users u, public.team_invitations i WHERE u.id = '$MIA'" 2>&1 | tr -d '\r')
got="$(cat "$TR/accept")|$rm_out|$final"
[ "$got" = "accepted|customer|customer:accepted" ] && ok "R1 the accept finishes first, the removal then takes the role away; no deadlock" || ko "R1 the accept finishes first, the removal then takes the role away; no deadlock" "expected [accepted|customer|customer:accepted], got [$got]"

fresh ${DB}r
[ "$MIG" != "none" ] && $BIN/psql $CONN -d ${DB}r -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" >/dev/null 2>&1
$R -c "$race_setup CREATE OR REPLACE FUNCTION public._team_previous_role(p_user uuid) RETURNS public.user_role LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS \$f\$ BEGIN IF current_setting('test.slow_prev', true) = '1' THEN PERFORM set_config('test.slow_prev', '', true); PERFORM pg_sleep(2); END IF; RETURN CASE WHEN EXISTS (SELECT 1 FROM public.driver_profiles dp WHERE dp.user_id = p_user AND dp.status IN ('approved', 'suspended')) THEN 'driver'::public.user_role ELSE 'customer'::public.user_role END; END \$f\$;" >/dev/null 2>&1
( $R -c "BEGIN; SET LOCAL request.jwt.claim.sub = '$SAM'; SET LOCAL ROLE authenticated; SET LOCAL test.slow_prev = '1'; SELECT public.remove_team_member('$MIA', 'Ya no trabaja aqui'); COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$' > "$TR/remove" ) &
sleep 0.5
acc_out=$($R -c "BEGIN; SET LOCAL ROLE service_role; SELECT public.accept_team_invitation_by_code(repeat('f', 64), '$MIA')->>'result'; COMMIT;" 2>&1 | tr -d '\r' | grep -m1 -o 'deadlock detected\|^[a-z_]*$')
wait
final=$($R -c "SELECT u.role || ':' || i.status FROM public.users u, public.team_invitations i WHERE u.id = '$MIA'" 2>&1 | tr -d '\r')
got="$(cat "$TR/remove")|$acc_out|$final"
[ "$got" = "customer|canceled|customer:canceled" ] && ok "R2 the removal finishes first, the accept then finds its invitation canceled; no deadlock" || ko "R2 the removal finishes first, the accept then finds its invitation canceled; no deadlock" "expected [customer|canceled|customer:canceled], got [$got]"
rm -rf "$TR"
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}r" >/dev/null 2>&1

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  T=$(mktemp -d)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  want=$($P -c "$BODIES" 2>&1 | tr -d '\r')
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$want" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  sabotage g1 "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated;" "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC;"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "can execute public\." && ok "G1 a function a client can execute aborts the migration" || ko "G1 a function a client can execute aborts the migration" "$r"

  sabotage g2 "ALTER TABLE public.team_invitation_codes ENABLE ROW LEVEL SECURITY;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "team_invitation_codes has row level security disabled" && ok "G2 a table without RLS aborts the migration" || ko "G2 a table without RLS aborts the migration" "$r"

  sabotage g3 "INSERT INTO public.team_invitation_code_salt (id, salt)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "the code salt is missing" && ok "G3 a missing salt aborts the migration" || ko "G3 a missing salt aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
