#!/usr/bin/env bash
# Rehearsal runner for migration 00619 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00619/run.sh none
#       -> the scaffold without the migration (RED: every case fails)
#   supabase/tests/00619/run.sh supabase/migrations/00619_signup_acquisition_codes.sql
#       -> the same + migration x2 (idempotency) + tests (GREEN)
# Writes run as anon/authenticated with a JWT subject, as PostgREST would.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00619/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr619
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=terse -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run $DB "$2"); case "$r" in *"$3"*) ok "$1";; *) ko "$1" "expected to contain [$3], got [$r]";; esac; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE tricigo_owner" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# as UID SQL -> SQL as authenticated with JWT subject UID (committed)
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s COMMIT;" "$1" "$2"; }

ADMIN=a0000000-0000-4000-8000-000000000001
RIDER=b0000000-0000-4000-8000-000000000002   # signs up with MOTORENKO, takes a ride
DRIVER=c0000000-0000-4000-8000-000000000003  # signs up with MOTORENKO, approved, drives once
OTHER=d0000000-0000-4000-8000-000000000004   # signs up with no code
FRIEND=e0000000-0000-4000-8000-000000000005  # owns the referral code CAFE1234
DP=1c000000-0000-4000-8000-000000000003

$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
run $DB "INSERT INTO public.users (id, role, full_name) VALUES
  ('$ADMIN','admin','Ada'), ('$RIDER','customer','Rita'), ('$DRIVER','customer','Dario'),
  ('$OTHER','customer','Otto'), ('$FRIEND','customer','Fede');
  INSERT INTO public.referral_codes VALUES ('$FRIEND', 'CAFE1234');" >/dev/null

if [ "$MIG" != none ]; then
  r1=$(apply_err $DB "$MIG"); r2=$(apply_err $DB "$MIG")
  [ "$r1" = applied ] && [ "$r2" = applied ] && ok "migration applies twice" || ko "migration applies twice" "[$r1] [$r2]"
fi

# --- the admin manages codes ----------------------------------------------------------
run $DB "$(as $ADMIN "INSERT INTO public.acquisition_codes (code, label, channel, audience) VALUES ('motorenko', 'Motorenko', 'influencer', 'choferes'), ('BOLSAS-VEDADO', 'Bolsas Vedado', 'bolsas', 'pasajeros'), ('VIEJO', 'Código viejo', 'otro', 'ambos');")" >/dev/null
val "A1 the admin creates codes; they are stored upper-case with the creator" \
  "SELECT string_agg(code || ':' || (created_by = '$ADMIN'), ',' ORDER BY code) FROM public.acquisition_codes" \
  "BOLSAS-VEDADO:true,MOTORENKO:true,VIEJO:true"
has "A2 a code equal to someone's referral code is rejected" \
  "$(as $ADMIN "INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('CAFE1234', 'x', 'otro');")" "ya es un código de referido"
val "A3 a non-admin sees no codes" "$(as $RIDER "SELECT count(*) FROM public.acquisition_codes;")" "0"
has "A4 a non-admin cannot create a code" \
  "$(as $RIDER "INSERT INTO public.acquisition_codes (code, label, channel) VALUES ('HACK', 'x', 'otro');")" "row-level security"
has "A5 anon cannot read the codes" "BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.acquisition_codes; COMMIT;" "permission denied"
run $DB "$(as $ADMIN "UPDATE public.acquisition_codes SET is_active = false WHERE code = 'VIEJO';")" >/dev/null

# --- users give a code at signup -------------------------------------------------------
val "U1 a rider gives an influencer code (any case, spaces)" "$(as $RIDER "SELECT public.apply_signup_code('  motorenko ');")" "applied"
val "U1 it is stored on the user" "SELECT signup_code || ':' || (signup_code_at IS NOT NULL) FROM public.users WHERE id = '$RIDER'" "MOTORENKO:true"
val "U2 a second code does not replace the first" "$(as $RIDER "SELECT public.apply_signup_code('BOLSAS-VEDADO');")" "already_set"
val "U2 the first one stays" "SELECT signup_code FROM public.users WHERE id = '$RIDER'" "MOTORENKO"
val "U3 a friend's referral code is not an acquisition code" "$(as $OTHER "SELECT public.apply_signup_code('CAFE1234');")" "not_found"
val "U4 an inactive code is not accepted" "$(as $OTHER "SELECT public.apply_signup_code('VIEJO');")" "not_found"
val "U5 an unknown or empty code" "$(as $OTHER "SELECT public.apply_signup_code('NOPE') || ',' || public.apply_signup_code(NULL);")" "not_found,not_found"
val "U5 and nothing is stored" "SELECT coalesce(signup_code, 'null') FROM public.users WHERE id = '$OTHER'" "null"
run $DB "$(as $OTHER "UPDATE public.users SET signup_code = 'MOTORENKO', signup_code_at = now() WHERE id = '$OTHER';")" >/dev/null
val "U6 a client cannot write the column directly" "SELECT coalesce(signup_code, 'null') FROM public.users WHERE id = '$OTHER'" "null"
run $DB "$(as $RIDER "UPDATE public.users SET signup_code = 'BOLSAS-VEDADO', full_name = 'Rita P' WHERE id = '$RIDER';")" >/dev/null
val "U7 nor rewrite it while editing the profile" "SELECT signup_code || ':' || full_name FROM public.users WHERE id = '$RIDER'" "MOTORENKO:Rita P"
has "U8 anon cannot call apply_signup_code" "BEGIN; SET LOCAL ROLE anon; SELECT public.apply_signup_code('MOTORENKO'); COMMIT;" "permission denied"

# --- per-code results --------------------------------------------------------------------
run $DB "$(as $DRIVER "SELECT public.apply_signup_code('MOTORENKO');")" >/dev/null
run $DB "INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$DP', '$DRIVER', 'approved');
  INSERT INTO public.rides (customer_id, driver_id, status) VALUES ('$RIDER', '$DP', 'completed'), ('$OTHER', '$DP', 'canceled');" >/dev/null
val "R1 the admin sees signups, drivers, approvals and first rides per code" \
  "$(as $ADMIN "SELECT string_agg(code || ':' || signups || '/' || rider_signups || '/' || driver_signups || '/' || drivers_approved || '/' || riders_with_ride || '/' || drivers_with_ride, ',' ORDER BY code) FROM public.admin_signup_code_stats();")" \
  "BOLSAS-VEDADO:0/0/0/0/0/0,MOTORENKO:2/1/1/1/1/1,VIEJO:0/0/0/0/0/0"
has "R2 a non-admin cannot read the results" "$(as $RIDER "SELECT count(*) FROM public.admin_signup_code_stats();")" "Admin only"
has "R3 anon cannot call the results" "BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.admin_signup_code_stats(); COMMIT;" "permission denied"

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
