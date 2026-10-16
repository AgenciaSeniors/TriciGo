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
# Created inline by one test each: GUS (C8, a phone that is set but not confirmed) and IDA (C9, an
# account whose sign-in address is another one, with a Google identity carrying the invited address).
GUS=a1000000-0000-4000-8000-00000000000e
IDA=a1000000-0000-4000-8000-00000000000f

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
# quiet EXPR -> evaluates EXPR as the current role and prints nothing
quiet(){ printf "DO \$q\$ BEGIN PERFORM %s; END \$q\$;" "$1"; }
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
val "S2 the scaffold carries the live body of the trigger that gates email_verified_at (00611)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_users_protect_email_verification()'::regprocedure" \
  "96a5ad5ef41a09f122f354c4668fdf82/465"
val "S3 and the trigger is defined as in prod" \
  "SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'public.users'::regclass AND t.tgname = 'trg_users_protect_email_verification'" \
  "CREATE TRIGGER trg_users_protect_email_verification BEFORE UPDATE OF email, email_verified_at ON public.users FOR EACH ROW EXECUTE FUNCTION tg_users_protect_email_verification()"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 both tables have RLS and only service_role can read them" \
  "SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('service_role', c.oid, 'SELECT'), ',' ORDER BY c.relname COLLATE \"C\") FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('team_invitation_codes', 'team_invitation_code_salt')" \
  "team_invitation_code_salt:true:falsefalsetrue,team_invitation_codes:true:falsefalsetrue"
val "O2 no client executes the new functions; the service role executes the three it calls, not the helpers; all SECURITY DEFINER" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE') || ':' || p.prosecdef, ',' ORDER BY p.proname COLLATE \"C\") FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS)" \
  "_team_code_account:falsefalsefalse:true,_team_code_hash:falsefalsefalse:true,accept_team_invitation_by_code:falsefalsetrue:true,team_invitation_code_check:falsefalsetrue:true,team_invitation_code_issue:falsefalsetrue:true"
val "O3 one salt, 32 random bytes in hex" \
  "SELECT count(*) || ':' || bool_and(salt ~ '^[0-9a-f]{64}\$') FROM public.team_invitation_code_salt" "1:true"
val "O4 anon cannot ask for a code; a signed-in user cannot accept with one" \
  "BEGIN; SET LOCAL ROLE anon; $(out "SELECT public.team_invitation_code_issue(repeat(''a'', 64))::text") RESET ROLE; SET LOCAL request.jwt.claim.sub = '$PETE'; SET LOCAL ROLE authenticated; $(out "SELECT public.accept_team_invitation_by_code(repeat(''a'', 64), ''$PETE'')::text") ROLLBACK;" \
  "raised 42501: permission denied for function team_invitation_code_issue;raised 42501: permission denied for function accept_team_invitation_by_code"
val "O5 service_role holds exactly what the migration grants (the default privileges give it ALL)" \
  "SELECT t.label || ':' || coalesce(string_agg(v.p, ',' ORDER BY v.n) FILTER (WHERE has_table_privilege('service_role', t.tbl, v.p)), '') FROM (VALUES (1, 'codes', 'public.team_invitation_codes'), (2, 'salt', 'public.team_invitation_code_salt')) t (o, label, tbl) CROSS JOIN (VALUES (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE'), (5, 'TRUNCATE'), (6, 'REFERENCES'), (7, 'TRIGGER')) v (n, p) GROUP BY t.o, t.label ORDER BY t.o" \
  "codes:SELECT,INSERT,UPDATE,DELETE;salt:SELECT"
val "O6 public.users.password_set_at exists, timestamptz and nullable" \
  "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password_set_at'" \
  "timestamp with time zone:YES"

echo "== issuing a code =="
val "I1 a pending invitation gets a 6-digit code for its address; only the hash is stored, for 10 minutes" \
  "$(svc "$(inv nina@bacoagency.com marketing a) SELECT (r->>'result') || '|' || (r->>'code' ~ '^[0-9]{6}\$') || '|' || (r->>'email') || '|' || (r->>'account_exists') || '|' || (r->>'expires_in_s') || '|' || (r->>'full_name') FROM (SELECT public.team_invitation_code_issue(repeat('a', 64)) r) x; SELECT (code_hash ~ '^[0-9a-f]{64}\$') || '|' || attempts || '|' || (expires_at = now() + interval '10 minutes') FROM public.team_invitation_codes;")" \
  "issued|true|nina@bacoagency.com|false|600|;true|0|true"
val "I2 the stored hash is the salted HMAC of the code, not a plain hash" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(su) SELECT (c.code_hash = public._team_code_hash(c.invitation_id, current_setting('test.code'))) || '|' || (c.code_hash <> encode(sha256(convert_to(current_setting('test.code'), 'UTF8')), 'hex')) FROM public.team_invitation_codes c;")" \
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
val "I9 the fifth code in an hour is still issued" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-hour:' || id, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 4 FROM public.team_invitations; $(sr) $(issue a)")" \
  "issued"
val "I10 the tenth code in a day is still issued" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.rate_limits (key, window_start, count) SELECT 'team-code-day:' || id, to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 9 FROM public.team_invitations; $(sr) $(issue a)")" \
  "issued"
val "I11 a cooldown answer adds nothing to either counter" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(issue a) $(issue a) $(su) SELECT h.count || '|' || d.count FROM public.team_invitations i JOIN public.rate_limits h ON h.key = 'team-code-hour:' || i.id JOIN public.rate_limits d ON d.key = 'team-code-day:' || i.id;")" \
  "issued;cooldown;1|1"

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
val "C8 a phone that is set but not confirmed is needs_google; the right code is not spent" \
  "$(svc "$(su) INSERT INTO public.users (id, email, full_name) VALUES ('$GUS', 'gus@example.com', 'Gus Phone'); INSERT INTO auth.users (id, email, phone, phone_confirmed_at, created_at) VALUES ('$GUS', 'gus@example.com', '5355500077', NULL, '2026-01-01'); INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ('$GUS', 'email', '{\"email\": \"gus@example.com\", \"email_verified\": true}'); $(sr) $(inv gus@example.com marketing 7) $(quiet "set_config('test.code', coalesce(public.team_invitation_code_issue(repeat('7', 64))->>'code', ''), true)") SELECT public.team_invitation_code_check(repeat('7', 64), current_setting('test.code'))->>'result'; SELECT count(*) || '|' || coalesce(max(attempts)::text, '-') FROM public.team_invitation_codes;")" \
  "needs_google;1|0"
val "C9 an address only an identity carries: the answer says an account exists, a right code is needs_google and not spent" \
  "$(svc "$(su) INSERT INTO public.users (id, email, full_name) VALUES ('$IDA', NULL, 'Ida Identity'); INSERT INTO auth.users (id, email, created_at) VALUES ('$IDA', 'phone_5355500088@tricigo.app', '2026-01-01'); INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ('$IDA', 'google', '{\"email\": \"ida@gmail.com\", \"email_verified\": true}'); $(sr) $(inv ida@gmail.com marketing 8) SELECT (r->>'result') || '|' || (r->>'account_exists') FROM (SELECT public.team_invitation_code_issue(repeat('8', 64)) r) x WHERE set_config('test.code', coalesce(r->>'code', ''), true) IS NOT NULL; SELECT public.team_invitation_code_check(repeat('8', 64), current_setting('test.code'))->>'result'; SELECT count(*) || '|' || coalesce(max(attempts)::text, '-') FROM public.team_invitation_codes;")" \
  "issued|true;needs_google;1|0"
# NOCASE: _team_code_account replaced, inside the rolled-back test, by one that names the account
# and gives no case, to prove that check and accept refuse any case they do not know.
NOCASE="CREATE OR REPLACE FUNCTION public._team_code_account(p_email text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS \$s\$ SELECT jsonb_build_object('user_id', (SELECT au.id FROM auth.users au WHERE lower(btrim(au.email)) = lower(btrim(p_email)))) \$s\$;"
val "C10 an account case check does not know is refused as needs_google, and the right code is not spent" \
  "$(svc "$(inv pete@example.com marketing b) $(issue b) $(su) $NOCASE $(sr) SELECT public.team_invitation_code_check(repeat('b', 64), current_setting('test.code'))->>'result'; SELECT count(*) || '|' || coalesce(max(attempts)::text, '-') FROM public.team_invitation_codes;")" \
  "issued;needs_google;1|0"

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
val "A11 an internal address is refused at accept too" \
  "$(svc "$(inv ops@tricigo.app admin 4) $(acc 4 $PETE)")" \
  "internal_address|"
val "A12 an account without a public.users row is no_account" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(acc a $NINA)")" \
  "no_account|"
val "A13 accepting sets password_set_at and, with users.email the invited address, email_verified_at" \
  "$(svc "$(inv nina@bacoagency.com marketing a) $(su) INSERT INTO public.users (id, email, full_name) VALUES ('$NINA', 'nina@bacoagency.com', 'Nina Baco'); INSERT INTO auth.users (id, email) VALUES ('$NINA', 'nina@bacoagency.com'); INSERT INTO auth.identities (user_id, provider, identity_data) VALUES ('$NINA', 'email', '{\"email\": \"nina@bacoagency.com\", \"email_verified\": true}'); $(sr) $(quiet "public.accept_team_invitation_by_code(repeat('a', 64), '$NINA')") $(su) SELECT password_set_at = now(), email_verified_at = now() FROM public.users WHERE id = '$NINA';")" \
  "t|t"
# A14: the address changes first, because 00611 clears email_verified_at on every change of
# users.email; then the mark is set, for the second accept, after the first one left it NULL.
val "A14 with users.email another address, email_verified_at is left alone (not set, not cleared) and password_set_at is set" \
  "$(svc "$(su) UPDATE public.users SET email = 'pete.other@example.com' WHERE id = '$PETE'; $(sr) $(inv pete@example.com marketing b) $(quiet "public.accept_team_invitation_by_code(repeat('b', 64), '$PETE')") $(su) SELECT password_set_at = now(), email_verified_at IS NULL FROM public.users WHERE id = '$PETE'; UPDATE public.users SET email_verified_at = '2026-03-01 00:00:00+00', password_set_at = NULL WHERE id = '$PETE'; $(sr) $(inv pete@example.com admin 9) $(quiet "public.accept_team_invitation_by_code(repeat('9', 64), '$PETE')") $(su) SELECT password_set_at = now(), email_verified_at = '2026-03-01 00:00:00+00' FROM public.users WHERE id = '$PETE';")" \
  "t|t;t|t"
val "A15 an email_verified_at already set is kept, not moved to now() (and the accept did run)" \
  "$(svc "$(su) UPDATE public.users SET email_verified_at = '2026-03-01 00:00:00+00' WHERE id = '$PETE'; $(sr) $(inv pete@example.com marketing b) $(quiet "public.accept_team_invitation_by_code(repeat('b', 64), '$PETE')") $(su) SELECT email_verified_at = '2026-03-01 00:00:00+00' AND password_set_at = now() FROM public.users WHERE id = '$PETE';")" \
  "t"
# A16: the accept's UPDATE, run as its owner, with and without a user's JWT. With one, 00611 puts
# the mark back, which is why the Edge Function must call accept_team_invitation_by_code with the
# service key and no user JWT.
A16_UPD="SET LOCAL ROLE postgres; UPDATE public.users SET password_set_at = now(), email_verified_at = CASE WHEN email_verified_at IS NULL AND lower(btrim(coalesce(email, ''))) = 'pete@example.com' THEN now() ELSE email_verified_at END WHERE id = '$PETE'; RESET ROLE;"
val "A16 with a user's JWT the prod trigger reverts the accept's email_verified_at write; without one it stays" \
  "$(svc "$(su) SET LOCAL request.jwt.claim.sub = '$PETE'; $A16_UPD SELECT password_set_at = now(), email_verified_at IS NULL FROM public.users WHERE id = '$PETE'; SET LOCAL request.jwt.claim.sub = ''; $A16_UPD SELECT password_set_at = now(), email_verified_at = now() FROM public.users WHERE id = '$PETE';")" \
  "t|t;t|t"
val "A17 an account case accept does not know is refused as needs_google and nothing changes" \
  "$(svc "$(inv pete@example.com marketing b) $(su) $NOCASE $(sr) $(acc b $PETE) SELECT role FROM public.users WHERE id = '$PETE'; SELECT status FROM public.team_invitations;")" \
  "needs_google|;customer;pending"

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
  # sabotage NAME OLD NEW -> $T/NAME.sql: the migration with OLD, found exactly once, replaced by NEW
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # proof NAME LABEL OLD NEW PATTERN -> applies the sabotaged copy to a fresh database; passes when
  # its first ERROR line matches PATTERN. A sabotage whose OLD text is not found fails the test.
  proof(){ if ! sabotage "$1" "$3" "$4"; then ko "$2" "sabotage failed: the text to replace is not in the migration exactly once"; return; fi
           fresh ${DB}g; local r; r=$(apply_err ${DB}g "$T/$1.sql")
           if echo "$r" | grep -q "$5"; then ok "$2"; else ko "$2" "$r"; fi; }
  # G0: the same file with CRLF line endings (pasted from Windows) produces the same bodies.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  want=$($P -c "$BODIES" 2>&1 | tr -d '\r')
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/crlf.sql"); b=$($BIN/psql $CONN -d ${DB}g -qAt -c "$BODIES" 2>&1 | tr -d '\r')
  [ "$r" = applied ] && [ "$b" = "$want" ] && ok "G0 with CRLF line endings the migration produces the same bodies" || ko "G0 with CRLF line endings the migration produces the same bodies" "$r / $b"

  proof g1 "G1 a function a client can execute aborts the migration" \
    "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated, service_role;" "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC;" "anon can execute public\."

  proof g2 "G2 a table without RLS aborts the migration" \
    "ALTER TABLE public.team_invitation_codes ENABLE ROW LEVEL SECURITY;" "-- sabotaged" \
    "team_invitation_codes has row level security disabled"

  proof g3 "G3 a missing salt aborts the migration" \
    "INSERT INTO public.team_invitation_code_salt (id, salt)
VALUES (1, encode(extensions.gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;" "-- sabotaged" "the code salt is missing"

  # G4/G4b: a table REVOKE leaves out service_role, so it keeps the ALL the default privileges gave it.
  proof g4 "G4 a service_role that kept the default ALL on the codes table aborts the migration" \
    "REVOKE ALL ON public.team_invitation_codes FROM PUBLIC, anon, authenticated, service_role;" \
    "REVOKE ALL ON public.team_invitation_codes FROM PUBLIC, anon, authenticated;" \
    "service_role has TRUNCATE on public\.team_invitation_codes"
  proof g4b "G4b a service_role that kept the default ALL on the salt table aborts the migration" \
    "REVOKE ALL ON public.team_invitation_code_salt FROM PUBLIC, anon, authenticated, service_role;" \
    "REVOKE ALL ON public.team_invitation_code_salt FROM PUBLIC, anon, authenticated;" \
    "service_role has TRUNCATE on public\.team_invitation_code_salt"

  # G5/G6: the scaffold's users has no password_set_at, as git had it before 00664.
  proof g5 "G5 a users.password_set_at the migration does not add aborts it" \
    "    ALTER TABLE public.users ADD COLUMN password_set_at timestamptz;" "    NULL;" \
    "public.users.password_set_at is missing"
  proof g6 "G6 a users.password_set_at that is not timestamptz aborts the migration" \
    "ADD COLUMN password_set_at timestamptz;" "ADD COLUMN password_set_at text;" \
    "public.users.password_set_at must be timestamptz"

  # G7: the function REVOKE leaves out service_role, so it keeps the default EXECUTE on the helpers.
  proof g7 "G7 a helper the service role can execute aborts the migration" \
    "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated, service_role;" "  public.accept_team_invitation_by_code(text, uuid)
FROM PUBLIC, anon, authenticated;" "service_role can execute public\._team_code_"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
