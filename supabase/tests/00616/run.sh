#!/usr/bin/env bash
# Rehearsal runner for migration 00616 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00616/run.sh none
#       -> users as in prod, without the consent columns (RED: every case fails)
#   supabase/tests/00616/run.sh supabase/migrations/00616_users_marketing_opt_in.sql
#       -> the same + migration x2 (idempotency) + tests (GREEN)
# Writes run as authenticated with a JWT subject, as PostgREST would.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00616/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8
DB=pr616
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=terse -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE tricigo_owner" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

ANA=a0000000-0000-4000-8000-000000000001   # registered before 00616
BETO=b0000000-0000-4000-8000-000000000002  # another user
NEW=c0000000-0000-4000-8000-000000000003   # signs up after 00616

# as UID SQL -> SQL as authenticated with JWT subject UID, committed
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE authenticated; %s COMMIT;" "$1" "$2"; }
# state UID -> opt_in:source:has_time:time_is_recent
state(){ echo "SELECT coalesce(marketing_opt_in::text,'null') || ':' || coalesce(marketing_opt_in_source,'null') || ':'
  || (marketing_opt_in_at IS NOT NULL) || ':' || coalesce((marketing_opt_in_at > now() - interval '1 minute')::text, 'null')
  FROM public.users WHERE id = '$1';"; }

$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1
$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
run $DB "INSERT INTO public.users (id, full_name) VALUES ('$ANA','Ana'), ('$BETO','Beto');" >/dev/null

if [ "$MIG" != none ]; then
  r1=$(apply_err $DB "$MIG"); r2=$(apply_err $DB "$MIG")
  [ "$r1" = applied ] && [ "$r2" = applied ] && ok "migration applies twice" || ko "migration applies twice" "[$r1] [$r2]"
fi

val "C1 a user registered before 00616 was never asked"  "$(state $ANA)" "null:null:false:null"

run $DB "INSERT INTO public.users (id, full_name, marketing_opt_in) VALUES ('$NEW','Nora', true);" >/dev/null
val "C2 a signup that ticks the box: accepted, source signup, stamped now" "$(state $NEW)" "true:signup:true:true"

run $DB "$(as $ANA "UPDATE public.users SET marketing_opt_in = true, marketing_opt_in_source = 'prompt' WHERE id = '$ANA';")" >/dev/null
val "C3 the one-time question, answered yes"              "$(state $ANA)" "true:prompt:true:true"

run $DB "$(as $ANA "UPDATE public.users SET marketing_opt_in_at = '2020-01-01', marketing_opt_in_source = 'signup' WHERE id = '$ANA';")" >/dev/null
val "C4 the time and source cannot be rewritten without changing the choice" \
  "$(state $ANA)" "true:prompt:true:true"

run $DB "$(as $ANA "UPDATE public.users SET marketing_opt_in = false, marketing_opt_in_at = '2020-01-01' WHERE id = '$ANA';")" >/dev/null
val "C5 withdrawing from Settings: declined, source settings, server time" "$(state $ANA)" "false:settings:true:true"

out=$(run $DB "$(as $ANA "UPDATE public.users SET marketing_opt_in = true, marketing_opt_in_source = 'whatsapp' WHERE id = '$ANA';")")
case "$out" in *users_marketing_opt_in_source_chk*) ok "C6 an unknown source is rejected";; *) ko "C6 an unknown source is rejected" "got [$out]";; esac

run $DB "$(as $BETO "UPDATE public.users SET marketing_opt_in = true WHERE id = '$ANA';")" >/dev/null
val "C7 nobody can answer for another user"                 "$(state $ANA)" "false:settings:true:true"

run $DB "$(as $ANA "UPDATE public.users SET full_name = 'Ana Maria' WHERE id = '$ANA';")" >/dev/null
val "C8 editing the profile does not touch the consent"     "$(state $ANA)" "false:settings:true:true"

run $DB "INSERT INTO public.users (id, full_name, marketing_opt_in, marketing_opt_in_at) VALUES ('d0000000-0000-4000-8000-000000000004','Dani', false, '2020-01-01');" >/dev/null
val "C9 a signup that leaves the box empty is recorded as declined, stamped now" \
  "$(state d0000000-0000-4000-8000-000000000004)" "false:signup:true:true"

echo "---- $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
