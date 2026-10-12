#!/usr/bin/env bash
# Rehearsal runner for migration 00660 (team invitations; local Postgres 16).
#   supabase/tests/00660/run.sh none
#       -> scaffold + seed + tests without the migration (RED: none of the objects exist)
#   supabase/tests/00660/run.sh supabase/migrations/00660_team_invitations.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-checks (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00660/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB="${RUN_DB:-pr660}"
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the printed rows, joined with ';', must equal EXPECTED (\r dropped for Windows)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 && \
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

SAM=a1000000-0000-4000-8000-000000000001
ANA=a1000000-0000-4000-8000-000000000002
MIA=a1000000-0000-4000-8000-000000000003
CARL=a1000000-0000-4000-8000-000000000004
DIEGO=a1000000-0000-4000-8000-000000000005
PETE=a1000000-0000-4000-8000-000000000006
BOB=a1000000-0000-4000-8000-000000000007
EVE=a1000000-0000-4000-8000-000000000008
DORA=a1000000-0000-4000-8000-000000000009
PLAT=00000000-0000-0000-0000-000000000001
GONE=00000000-0000-4000-8000-00000000dead
M=$(printf '\xe2\x80\xa6')   # the ellipsis of a masked address

# as SUB SQL -> SQL as that account (role authenticated) in a transaction that is rolled back
as(){ printf "BEGIN; SET LOCAL client_min_messages = error; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s ROLLBACK;" "$1" "$2"; }
# who SUB -> switch the caller inside an 'as' block; sup -> the test superuser with no JWT
who(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated;" "$1"; }
sup(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = '';"; }
anon(){ printf "RESET ROLE; SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }
# invite EMAIL ROLE [NAME] -> creates an invitation as the current caller; keeps its token and id
invite(){ printf "SELECT 1 FROM (SELECT public.create_team_invitation('%s', '%s', %s) r) x WHERE set_config('test.tok', split_part(r->>'link', '/invitacion/', 2), true) IS NULL OR set_config('test.id', r->>'id', true) IS NULL;" "$1" "$2" "${3:-NULL}"; }
TOK="current_setting('test.tok')"
ID="current_setting('test.id')::uuid"
# accept [TOKEN_SQL] -> 'result|role|email_masked' of accept_team_invitation
accept(){ printf "SELECT (r->>'result') || '|' || coalesce(r->>'role', '') || '|' || coalesce(r->>'email_masked', '') FROM (SELECT public.accept_team_invitation(%s) r) x;" "${1:-}"; }
out(){ printf "SELECT t.outcome('%s');" "$1"; }
NOT_SA="raised 42501: Solo un superadministrador puede gestionar el equipo. [team_not_super_admin]"
FNS="'_team_mask_email', '_team_invitation_link', '_team_role_rank', '_team_require_super_admin', '_team_previous_role', '_team_lock_target', '_team_check_last_super_admin', '_team_write_role', '_team_queue_invitation_email', 'list_team', 'create_team_invitation', 'resend_team_invitation', 'cancel_team_invitation', 'get_team_invitation', 'accept_team_invitation', 'set_team_member_role', 'remove_team_member', 'tg_users_protect_admin_fields'"
BODIES="SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ($FNS)"

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('tg_users_protect_admin_fields', 'is_admin', 'is_super_admin', 'current_user_role', 'mailable_user_emails')" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,is_admin:22cb75e91980d512498034cd33e1eda2/285,is_super_admin:5655a4615e92e8b1e323d06c7566b058/105,mailable_user_emails:58def9245ceb43b710a57ef01c450572/479,tg_users_protect_admin_fields:377912e83023297eda4761622a113364/2995"
val "S1 like prod, postgres owns the public functions and is not a superuser" \
  "SELECT string_agg(DISTINCT pg_get_userbyid(proowner), ',') || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') FROM pg_proc WHERE pronamespace = 'public'::regnamespace" \
  "postgres|false"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== objects =="
val "O1 the table has RLS and only service_role can use it" \
  "SELECT c.relrowsecurity || ':' || has_table_privilege('anon', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'SELECT') || has_table_privilege('authenticated', c.oid, 'INSERT') || has_table_privilege('service_role', c.oid, 'SELECT') FROM pg_class c WHERE c.oid = to_regclass('public.team_invitations')" \
  "true:falsefalsefalsetrue"
val "O2 who executes what: helpers nobody, get_team_invitation anon too, the rest signed-in" \
  "SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE'), ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($FNS) AND p.proname <> 'tg_users_protect_admin_fields'" \
  "_team_check_last_super_admin:falsefalse,_team_invitation_link:falsefalse,_team_lock_target:falsefalse,_team_mask_email:falsefalse,_team_previous_role:falsefalse,_team_queue_invitation_email:falsefalse,_team_require_super_admin:falsefalse,_team_role_rank:falsefalse,_team_write_role:falsefalse,accept_team_invitation:falsetrue,cancel_team_invitation:falsetrue,create_team_invitation:falsetrue,get_team_invitation:truetrue,list_team:falsetrue,remove_team_member:falsetrue,resend_team_invitation:falsetrue,set_team_member_role:falsetrue"
val "O3 the protect trigger reads the team role flag once" \
  "SELECT (length(prosrc) - length(replace(prosrc, 'current_setting(''app.team_role_change''', ''))) / length('current_setting(''app.team_role_change''') FROM pg_proc WHERE oid = 'public.tg_users_protect_admin_fields()'::regprocedure" \
  "1"

echo "== who may manage the team =="
val "A1 anon cannot list the team" \
  "BEGIN; SET LOCAL ROLE anon; $(out 'SELECT public.list_team()::text') ROLLBACK;" \
  "raised 42501: permission denied for function list_team"
val "A2 an admin cannot list the team" "$(as $ANA "$(out 'SELECT public.list_team()::text')")" "$NOT_SA"
val "A3 marketing cannot invite" "$(as $MIA "$(out "SELECT public.create_team_invitation(''x@y.com'', ''admin'')::text")")" "$NOT_SA"
val "A4 a passenger cannot change a role" "$(as $CARL "$(out "SELECT public.set_team_member_role(''$ANA'', ''marketing'', ''motivo largo'')")")" "$NOT_SA"
val "A5 a blocked super_admin is refused" \
  "$(as $SAM "$(sup) UPDATE public.users SET is_active = false WHERE id = '$SAM'; $(who $SAM) $(out 'SELECT public.list_team()::text')")" "$NOT_SA"
val "A6 anon can read an invitation page (nothing for a bad token)" \
  "BEGIN; SET LOCAL ROLE anon; SELECT public.get_team_invitation('abc')->>'status'; ROLLBACK;" "not_found"

echo "== invitations =="
val "I1 an invitation is stored normalized, pending, for 7 days, with a 64-hex token" \
  "$(as $SAM "$(invite ' Carl@Gmail.com ' admin "'Carlos'") $(sup) SELECT email || '|' || role || '|' || coalesce(full_name, '') || '|' || status || '|' || (sent_at IS NOT NULL) || '|' || (expires_at > now() + interval '6 days 23 hours') || '|' || (token ~ '^[0-9a-f]{64}\$') FROM public.team_invitations;")" \
  "carl@gmail.com|admin|Carlos|pending|true|true|true"
val "I2 its e-mail is queued to send-email with the template and the link" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin "'Carlos'") $(sup) SELECT c.jobname || '|' || c.url || '|' || (c.headers->>'Authorization') || '|' || (c.body->>'recipient_email') || '|' || (c.body->>'template') || '|' || (c.body->'data'->>'role') || '|' || (c.body->'data'->>'inviter_name') || '|' || (c.body->'data'->>'invitee_name') || '|' || ((c.body->'data'->>'link') = 'https://admin.tricigo.com/invitacion/' || i.token) || '|' || (c.body->'data'->>'expires_at' ~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\$') FROM public.cron_http_post_calls c, public.team_invitations i;")" \
  "team-invitation-email|https://lqaufszburqvlslpcuac.supabase.co/functions/v1/send-email|Bearer test-service-key|carl@gmail.com|team_invitation|admin|Sam Super|Carlos|true|true"
val "I3 the answer carries the link and whether the e-mail was queued; the action is audited" \
  "$(as $SAM "SELECT (r->>'email') || '|' || (r->>'role') || '|' || (r->>'email_queued') || '|' || ((r->>'link') ~ '^https://admin\\.tricigo\\.com/invitacion/[0-9a-f]{64}\$') FROM (SELECT public.create_team_invitation('dora@gmail.com', 'marketing') r) x; $(sup) SELECT admin_id || '|' || action || '|' || target_type || '|' || (new_values->>'email') FROM public.admin_actions;")" \
  "dora@gmail.com|marketing|true|true;$SAM|team_invite_created|team_invitation|dora@gmail.com"
val "I4 a second invitation for a pending address is refused, also when the first expired" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(out "SELECT public.create_team_invitation(''CARL@gmail.com'', ''marketing'')::text") $(sup) UPDATE public.team_invitations SET expires_at = now() - interval '1 minute'; $(who $SAM) $(out "SELECT public.create_team_invitation(''carl@gmail.com'', ''admin'')::text")")" \
  "raised P0001: Ya hay una invitación pendiente para esa dirección. Reenvíala en vez de crear otra. [team_already_invited];raised P0001: Ya hay una invitación pendiente para esa dirección. Reenvíala en vez de crear otra. [team_already_invited]"
val "I5 a team member's address is refused (users.email or a Google address)" \
  "$(as $SAM "$(out "SELECT public.create_team_invitation(''ANA@example.com'', ''admin'')::text") $(out "SELECT public.create_team_invitation(''mia@example.com'', ''admin'')::text") $(out "SELECT public.create_team_invitation(''mia.work@example.com'', ''admin'')::text")")" \
  "raised P0001: Esa dirección ya es de alguien del equipo. [team_already_member];raised P0001: Esa dirección ya es de alguien del equipo. [team_already_member];raised P0001: Esa dirección ya es de alguien del equipo. [team_already_member]"
val "I6 bad address, role and name are refused" \
  "$(as $SAM "$(out "SELECT public.create_team_invitation(''nope'', ''admin'')::text") $(out "SELECT public.create_team_invitation(''a@b.co'', ''customer'')::text") $(out "SELECT public.create_team_invitation(''a@b.co'', ''admin'', repeat(''x'', 81))::text")")" \
  "raised 22023: El correo no es válido. [team_bad_email];raised 22023: El rol tiene que ser superadministrador, administrador o marketing. [team_bad_role];raised 22023: El nombre puede tener hasta 80 caracteres. [team_bad_name]"
val "I7 without a service key the invitation is still created, e-mail not queued" \
  "$(as $SAM "SET LOCAL test.no_key = '1'; SELECT public.create_team_invitation('carl@gmail.com', 'admin')->>'email_queued'; $(sup) SELECT count(*) FROM public.cron_http_post_calls; SELECT count(*) || '|' || bool_and(sent_at IS NULL) FROM public.team_invitations;")" \
  "false;0;1|true"
val "I8 resend restarts the 7 days and queues the e-mail again" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(sup) UPDATE public.team_invitations SET expires_at = now() - interval '1 day', sent_at = NULL; $(who $SAM) SELECT public.resend_team_invitation($ID)->>'email_queued'; $(sup) SELECT (expires_at > now() + interval '6 days 23 hours') || '|' || (sent_at IS NOT NULL) FROM public.team_invitations; SELECT count(*) FROM public.cron_http_post_calls; SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions;")" \
  "true;true|true;2;team_invite_created,team_invite_resent"
val "I9 cancel; then cancel, resend and an unknown id are refused; the address can be invited again" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) SELECT public.cancel_team_invitation($ID); $(out "SELECT public.cancel_team_invitation(current_setting(''test.id'')::uuid)") $(out "SELECT public.resend_team_invitation(current_setting(''test.id'')::uuid)::text") $(out "SELECT public.cancel_team_invitation(''$GONE'')") $(invite 'carl@gmail.com' admin) $(sup) SELECT count(*) FILTER (WHERE status = 'pending') || '/' || count(*) FILTER (WHERE status = 'canceled' AND canceled_by = '$SAM') FROM public.team_invitations;")" \
  "canceled;raised P0001: Esa invitación ya no está pendiente. [team_invitation_not_pending];raised P0001: Esa invitación ya no está pendiente. [team_invitation_not_pending];raised P0001: No encontramos esa invitación. [team_invitation_not_found];1/1"

echo "== the public invitation page =="
val "V1 anon sees role, inviter and the masked address only" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(anon) SELECT (r->>'status') || '|' || (r->>'role') || '|' || (r->>'inviter_name') || '|' || (r->>'email_masked') || '|' || position('carl@' IN r::text) FROM (SELECT public.get_team_invitation($TOK) r) x;")" \
  "pending|admin|Sam Super|c${M}@gmail.com|0"
val "V2 a malformed or unknown token is not_found" \
  "BEGIN; SET LOCAL ROLE anon; SELECT public.get_team_invitation('abc')->>'status'; SELECT public.get_team_invitation(repeat('a', 64))->>'status'; ROLLBACK;" "not_found;not_found"
val "V3 expired and canceled invitations say so" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(sup) UPDATE public.team_invitations SET expires_at = now() - interval '1 minute'; $(anon) SELECT public.get_team_invitation($TOK)->>'status'; $(sup) UPDATE public.team_invitations SET status = 'canceled'; $(anon) SELECT public.get_team_invitation($TOK)->>'status';")" \
  "expired;canceled"

echo "== accepting =="
val "C1 the right Google account gets the role; the invitation and the audit say so" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(who $CARL) $(accept "$TOK") $(sup) SELECT role FROM public.users WHERE id = '$CARL'; SELECT status || '|' || (accepted_user_id = '$CARL') FROM public.team_invitations; SELECT admin_id || '|' || action || '|' || target_id || '|' || (old_values->>'role') || '>' || (new_values->>'role') FROM public.admin_actions WHERE action = 'team_invite_accepted';")" \
  "accepted|admin|;admin;accepted|true;$SAM|team_invite_accepted|$CARL|customer>admin"
val "C2 accepting again is harmless" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(who $CARL) $(accept "$TOK") $(accept "$TOK") $(sup) SELECT count(*) FROM public.admin_actions WHERE action = 'team_invite_accepted';")" \
  "accepted|admin|;accepted|admin|;1"
val "C3 another Google account gets wrong_account and keeps its role" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(who $DIEGO) $(accept "$TOK") $(sup) SELECT role FROM public.users WHERE id = '$DIEGO';")" \
  "wrong_account||c${M}@gmail.com;driver"
val "C4 a password-only account and an unverified Google address get needs_google" \
  "$(as $SAM "$(invite 'pete@example.com' marketing) $(who $PETE) $(accept "$TOK") $(who $SAM) $(invite 'eve@gmail.com' marketing) $(who $EVE) $(accept "$TOK") $(sup) SELECT string_agg(role::text, ',' ORDER BY full_name) FROM public.users WHERE id IN ('$PETE', '$EVE');")" \
  "needs_google||p${M}@example.com;needs_google||e${M}@gmail.com;customer,customer"
val "C5 expired, canceled, unknown and used invitations" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(sup) UPDATE public.team_invitations SET expires_at = now() - interval '1 minute'; $(who $CARL) $(accept "$TOK") $(sup) UPDATE public.team_invitations SET status = 'canceled'; $(who $CARL) $(accept "$TOK") $(accept "'zzz'") $(who $SAM) $(invite 'carl@gmail.com' admin) $(who $CARL) $(accept "$TOK") $(who $DIEGO) $(accept "$TOK")")" \
  "expired||;canceled||;not_found||;accepted|admin|;used||"
val "C6 without a token, a pending invitation for the caller's Google address is accepted" \
  "$(as $SAM "$(invite 'diego@gmail.com' marketing) $(who $DIEGO) $(accept) $(sup) SELECT role FROM public.users WHERE id = '$DIEGO';")" \
  "accepted|marketing|;marketing"
val "C7 without a token and nothing for the caller: none, and nothing changes" \
  "$(as $SAM "$(invite 'diego@gmail.com' marketing) $(who $CARL) $(accept) $(sup) SELECT role FROM public.users WHERE id = '$CARL'; SELECT status FROM public.team_invitations;")" \
  "none||;customer;pending"
val "C8 a blocked account is not accepted" \
  "$(as $SAM "$(invite 'bob@gmail.com' admin) $(who $BOB) $(accept "$TOK") $(sup) SELECT role || '|' || (SELECT status FROM public.team_invitations) FROM public.users WHERE id = '$BOB';")" \
  "blocked||;customer|pending"
val "C9 accepting never lowers a role, and raises it when the invitation is higher" \
  "$(as $SAM "$(sup) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('ana@example.com', 'marketing', repeat('b', 64), '$SAM', now() + interval '1 day'); $(who $ANA) $(accept "repeat('b', 64)") $(sup) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('ana@example.com', 'super_admin', repeat('c', 64), '$SAM', now() + interval '1 day'); $(who $ANA) $(accept "repeat('c', 64)") $(sup) SELECT role FROM public.users WHERE id = '$ANA';")" \
  "accepted|admin|;accepted|super_admin|;super_admin"
val "C10 anon cannot accept" \
  "BEGIN; SET LOCAL ROLE anon; $(out 'SELECT public.accept_team_invitation()::text') ROLLBACK;" \
  "raised 42501: permission denied for function accept_team_invitation"
val "C11 a signed-in role without a session subject is refused" \
  "BEGIN; SET LOCAL ROLE authenticated; $(out 'SELECT public.accept_team_invitation()::text') ROLLBACK;" \
  "raised 42501: Inicia sesión para aceptar la invitación. [team_no_session]"
val "C12 the flag does not outlive the accept: a later role UPDATE by the same person is put back" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(who $CARL) $(accept "$TOK") UPDATE public.users SET role = 'super_admin' WHERE id = '$CARL'; SELECT '[' || coalesce(current_setting('app.team_role_change', true), '<unset>') || ']'; $(sup) SELECT role FROM public.users WHERE id = '$CARL';")" \
  "accepted|admin|;[];admin"
val "C13 control: a client's own role UPDATE without an invitation is put back" \
  "$(as $CARL "UPDATE public.users SET role = 'admin' WHERE id = '$CARL'; $(sup) SELECT role FROM public.users WHERE id = '$CARL';")" \
  "customer"

echo "== managing members =="
val "M1 a super_admin changes a role; the reason is audited" \
  "$(as $SAM "SELECT public.set_team_member_role('$ANA', 'marketing', 'Cambia de area'); $(sup) SELECT role FROM public.users WHERE id = '$ANA'; SELECT admin_id || '|' || action || '|' || target_id || '|' || (old_values->>'role') || '>' || (new_values->>'role') || '|' || reason FROM public.admin_actions;")" \
  "marketing;marketing;$SAM|team_role_changed|$ANA|admin>marketing|Cambia de area"
val "M2 a reason is required, the role must be a panel role" \
  "$(as $SAM "$(out "SELECT public.set_team_member_role(''$ANA'', ''marketing'', ''no'')") $(out "SELECT public.remove_team_member(''$ANA'', NULL)") $(out "SELECT public.set_team_member_role(''$ANA'', ''driver'', ''motivo largo'')")")" \
  "raised 22023: Escribe el motivo (al menos 5 caracteres). [team_reason_required];raised 22023: Escribe el motivo (al menos 5 caracteres). [team_reason_required];raised 22023: El rol tiene que ser superadministrador, administrador o marketing. [team_bad_role]"
val "M3 not on oneself, not outside the team, not on a system account" \
  "$(as $SAM "$(out "SELECT public.set_team_member_role(''$SAM'', ''admin'', ''motivo largo'')") $(out "SELECT public.remove_team_member(''$SAM'', ''motivo largo'')") $(out "SELECT public.set_team_member_role(''$CARL'', ''admin'', ''motivo largo'')") $(out "SELECT public.remove_team_member(''$GONE'', ''motivo largo'')") $(out "SELECT public.set_team_member_role(''$PLAT'', ''admin'', ''motivo largo'')")")" \
  "raised P0001: No puedes cambiar tu propio acceso. [team_self];raised P0001: No puedes cambiar tu propio acceso. [team_self];raised P0001: Esa cuenta no es parte del equipo. [team_not_member];raised P0001: Esa cuenta no es parte del equipo. [team_not_member];raised P0001: Esa es una cuenta del sistema. [team_system_account]"
val "M4 removing access goes back to driver with an approved profile, customer otherwise" \
  "$(as $SAM "$(sup) UPDATE public.users SET role = 'marketing' WHERE id IN ('$DIEGO', '$DORA'); $(who $SAM) SELECT public.remove_team_member('$ANA', 'Ya no trabaja aqui'); SELECT public.remove_team_member('$DIEGO', 'Ya no trabaja aqui'); SELECT public.remove_team_member('$DORA', 'Ya no trabaja aqui'); $(sup) SELECT string_agg(action || ':' || reason, ',') FROM public.admin_actions;")" \
  "customer;driver;customer;team_member_removed:Ya no trabaja aqui,team_member_removed:Ya no trabaja aqui,team_member_removed:Ya no trabaja aqui"
val "M5 removing access cancels a pending invitation for the person's addresses" \
  "$(as $SAM "$(sup) INSERT INTO public.team_invitations (email, role, token, invited_by, expires_at) VALUES ('ana@example.com', 'admin', repeat('d', 64), '$SAM', now() + interval '1 day'); $(who $SAM) SELECT public.remove_team_member('$ANA', 'Ya no trabaja aqui'); $(sup) SELECT status || '|' || (canceled_by = '$SAM') FROM public.team_invitations;")" \
  "customer;canceled|true"
val "M6 the last human super_admin cannot be demoted or removed (the platform account does not count)" \
  "$(as $PLAT "$(out "SELECT public.set_team_member_role(''$SAM'', ''admin'', ''motivo largo'')") $(out "SELECT public.remove_team_member(''$SAM'', ''motivo largo'')")")" \
  "raised P0001: Tiene que quedar al menos un superadministrador. [team_last_super_admin];raised P0001: Tiene que quedar al menos un superadministrador. [team_last_super_admin]"
val "M7 with two super_admins, one can demote the other" \
  "$(as $SAM "SELECT public.set_team_member_role('$ANA', 'super_admin', 'Ahora dirige'); $(who $ANA) SELECT public.set_team_member_role('$SAM', 'admin', 'Cambio de cargo'); $(sup) SELECT string_agg(role::text, ',' ORDER BY full_name) FROM public.users WHERE id IN ('$ANA', '$SAM');")" \
  "super_admin;admin;super_admin,admin"
val "M8 setting the same role changes nothing and audits nothing" \
  "$(as $SAM "SELECT public.set_team_member_role('$ANA', 'admin', 'Sin cambios'); $(sup) SELECT count(*) FROM public.admin_actions;")" \
  "admin;0"

echo "== the team listing =="
val "L1 members: active panel accounts, system accounts out, ordered by role; digest and me flags" \
  "$(as $SAM "SELECT string_agg((m->>'role') || ':' || (m->>'full_name') || ':' || coalesce(m->>'email', '') || ':' || (m->>'gets_digest') || ':' || (m->>'is_me') || ':' || (m->>'last_sign_in_at' IS NOT NULL), ',') FROM jsonb_array_elements(public.list_team()->'members') m;")" \
  "super_admin:Sam Super:sam@example.com:true:true:true,admin:Ana Admin:ana@example.com:true:false:false,marketing:Mia Marketing:mia.work@example.com:false:false:false"
val "L2 an opted-out member does not get the digest" \
  "$(as $SAM "$(sup) INSERT INTO public.team_digest_optouts (user_id, opted_out) VALUES ('$ANA', true); $(who $SAM) SELECT m->>'gets_digest' FROM jsonb_array_elements(public.list_team()->'members') m WHERE m->>'user_id' = '$ANA';")" \
  "false"
val "L3 pending invitations only, with expiry and link" \
  "$(as $SAM "$(invite 'carl@gmail.com' admin) $(invite 'dora@gmail.com' marketing) SELECT public.cancel_team_invitation($ID); $(sup) UPDATE public.team_invitations SET expires_at = now() - interval '1 minute' WHERE email = 'carl@gmail.com'; $(who $SAM) SELECT string_agg((i->>'email') || ':' || (i->>'role') || ':' || (i->>'invited_by_name') || ':' || (i->>'expired') || ':' || ((i->>'link') ~ '^https://admin\\.tricigo\\.com/invitacion/[0-9a-f]{64}\$'), ',') FROM jsonb_array_elements(public.list_team()->'invitations') i;")" \
  "canceled;carl@gmail.com:admin:Sam Super:true:true"

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

  sabotage g1 "  public._team_queue_invitation_email(uuid)
FROM PUBLIC, anon, authenticated;" "  public._team_queue_invitation_email(uuid)
FROM PUBLIC;"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "can execute public._team_" && ok "G1 a helper a client can execute aborts the migration" || ko "G1 a helper a client can execute aborts the migration" "$r"

  sabotage g2 "GRANT EXECUTE ON FUNCTION public.get_team_invitation(text) TO anon, authenticated, service_role;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "anon cannot execute public.get_team_invitation(text)" && ok "G2 an invitation page anon cannot read aborts the migration" || ko "G2 an invitation page anon cannot read aborts the migration" "$r"

  sabotage g3 "ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "team_invitations has row level security disabled" && ok "G3 a table without RLS aborts the migration" || ko "G3 a table without RLS aborts the migration" "$r"

  sabotage g4 "REVOKE ALL ON public.team_invitations FROM PUBLIC, anon, authenticated;" "-- sabotaged"
  fresh ${DB}g; r=$(apply_err ${DB}g "$T/g4.sql")
  echo "$r" | grep -q "has privileges on public.team_invitations" && ok "G4 a table a client role can read aborts the migration" || ko "G4 a table a client role can read aborts the migration" "$r"

  fresh ${DB}g
  $BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1 -c "SET ROLE postgres; DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_users_protect_admin_fields()'::regprocedure), 'RETURN NEW;
END;', 'RETURN NEW; -- changed elsewhere
END;'); END \$d\$;" >/dev/null 2>&1
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "tg_users_protect_admin_fields has an unknown body" && ok "G5 an unknown protect-trigger body aborts the migration" || ko "G5 an unknown protect-trigger body aborts the migration" "$r"

  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
