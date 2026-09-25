#!/usr/bin/env bash
# Rehearsal runner for migration 00595 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00595/run.sh none
#       -> scaffold + tests (RED: a signup with 2+ matching invitations aborts)
#   supabase/tests/00595/run.sh supabase/migrations/00595_fix_fleet_signup_multi_invitation.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
DB=pr595
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" 2>&1 | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

U1=a0000000-0000-4000-8000-000000000001            # existing user, as in prod
NEWU=b0000000-0000-4000-8000-000000000001          # the person signing up
FA=f0000000-0000-4000-8000-00000000000a            # fleet A
FB=f0000000-0000-4000-8000-00000000000b            # fleet B
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
DELETE FROM auth.users WHERE id::text NOT LIKE 'a0000000-%';
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('c0000000-0000-4000-8000-00000000000a', 'Flota A', '+5355550010', '$U1'),
  ('c0000000-0000-4000-8000-00000000000b', 'Flota B', '+5355550011', '$U1');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES
  ('$FA', 'c0000000-0000-4000-8000-00000000000a', 'Flota A'),
  ('$FB', 'c0000000-0000-4000-8000-00000000000b', 'Flota B');"
# invite FLEET PHONE STATUS -> an invitation as a fleet owner leaves it (no JWT here, so the protect trigger keeps the status)
invite(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('%s', 'Juan', '%s', '%s');" "$1" "$2" "$3"; }
# signup PHONE -> the INSERT into public.users that fires the trigger (what handle_new_user does)
signup(){ printf "INSERT INTO auth.users (id) VALUES ('$NEWU'); INSERT INTO public.users (id, phone) VALUES ('$NEWU', %s);" "$1"; }
# LINKED -> invitations now linked to the new person | invitations in total
LINKED="SELECT count(*) FILTER (WHERE driver_id = '$NEWU' AND status = 'active' AND signed_up_at IS NOT NULL) || '|' || count(*) FROM public.fleet_members;"
ROWS="SELECT md5(coalesce((SELECT string_agg(id::text || coalesce(driver_id::text, '-') || status || coalesce(signed_up_at::text, '-'), ',' ORDER BY id) FROM public.fleet_members), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.driver_fleets), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.corporate_accounts), '')
          || coalesce((SELECT string_agg(id::text || coalesce(phone, '-'), ',' ORDER BY id) FROM public.users), ''))"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live prod body (md5 of prosrc)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.auto_link_fleet_member_on_signup()'::regprocedure" \
  "0b74fd48e33257ba39bd719376d1a732/494"
val "S1 scaffold carries the live fleet_members protect trigger (md5 of prosrc)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" \
  "8b0d07aff7ab33142bfcec29304c01ed/674"

if [ "$MIG" != "none" ]; then
  # Give the self-test real rows to leave alone: two fleets and an invitation it must not touch.
  $P -c "$RESET $(invite $FA '+5355557777' 'pending_signup')" >/dev/null || exit 1
  BEFORE=$($P -c "$ROWS")
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration's self-test leaves every row exactly as it was" "$ROWS" "$BEFORE"
fi

echo "== tests =="
# A. behaviour: the signup path, against the invitation shapes the schema allows
val "A1 invited by two fleets: the signup succeeds and links both" \
  "$RESET $(invite $FA '+5355551234' 'pending_signup') $(invite $FB '+5355551234' 'approved') $(signup "'+5355551234'") $LINKED" "2|2"
val "A2 one fleet stored the number twice (+53... and 8 digits): both linked" \
  "$RESET $(invite $FA '+5355551234' 'pending_signup') $(invite $FA '55551234' 'approved') $(signup "'+5355551234'") $LINKED" "2|2"
val "A3 one invitation (the only case the live body survived): linked" \
  "$RESET $(invite $FA '55551234' 'approved') $(signup "'+5355551234'") $LINKED" "1|1"
val "A4 no invitation: the account is created and nothing else changes" \
  "$RESET $(signup "'+5355551234'") SELECT count(*) FROM public.users WHERE id = '$NEWU'; $LINKED" "1;0|0"
val "A5 only approved and pending_signup invitations are linked" \
  "$RESET $(invite $FA '+5355551234' 'pending_review') $(invite $FA '55551234' 'rejected') $(invite $FA '5355551234' 'inactive')
          $(invite $FB '+5355551234' 'approved') $(invite $FB '55551234' 'pending_signup') $(signup "'+5355551234'")
   SELECT string_agg(status || ':' || (driver_id IS NOT NULL), ',' ORDER BY status) FROM public.fleet_members;" \
  "active:true,active:true,inactive:false,pending_review:false,rejected:false"
val "A6 an invitation already linked to someone else is left alone" \
  "$RESET INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status, signed_up_at)
            VALUES ('$FA', '$U1', 'Juan', '+5355551234', 'active', '2026-09-01 12:00:00+00');
   $(invite $FB '+5355551234' 'pending_signup') $(signup "'+5355551234'")
   SELECT string_agg(left(driver_id::text, 8) || ':' || CASE WHEN signed_up_at = '2026-09-01 12:00:00+00' THEN 'kept'
                                                           WHEN signed_up_at > now() - interval '1 minute' THEN 'now' END,
                     ',' ORDER BY fleet_id) FROM public.fleet_members;" \
  "a0000000:kept,b0000000:now"
val "A7 a new account without a phone links nothing" \
  "$RESET $(invite $FA '+5355551234' 'pending_signup') $(signup NULL) $LINKED" "0|1"
val "A8 a signup under the person's own JWT (not an admin) still links both" \
  "$RESET $(invite $FA '+5355551234' 'pending_signup') $(invite $FB '55551234' 'approved')
   SELECT set_config('request.jwt.claim.sub', '$NEWU', true) IS NOT NULL; $(signup "'+5355551234'") $LINKED" "t;2|2"
val "A9 someone else's signup leaves the invitations alone" \
  "$RESET $(invite $FA '+5355551234' 'pending_signup') $(invite $FB '55551234' 'approved') $(signup "'+5355559999'")
   SELECT string_agg(status || ':' || (driver_id IS NULL), ',' ORDER BY status) FROM public.fleet_members;" "approved:true,pending_signup:true"

# B. contract: same trigger, signature, privileges and execution context as before
val "B1 same signature and return type" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) FROM pg_proc WHERE oid = 'public.auto_link_fleet_member_on_signup()'::regprocedure" "|trigger"
val "B2 still SECURITY DEFINER with the same pinned search_path" \
  "SELECT prosecdef || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.auto_link_fleet_member_on_signup()'::regprocedure" "true|search_path=public, pg_temp"
val "B3 execute: anon no, authenticated no, service_role yes" \
  "SELECT has_function_privilege('anon', 'public.auto_link_fleet_member_on_signup()', 'EXECUTE') || '|' ||
          has_function_privilege('authenticated', 'public.auto_link_fleet_member_on_signup()', 'EXECUTE') || '|' ||
          has_function_privilege('service_role', 'public.auto_link_fleet_member_on_signup()', 'EXECUTE')" "false|false|true"
val "B4 the trigger on public.users is still there, AFTER INSERT FOR EACH ROW" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'auto_link_fleet_member_on_signup'" \
  "CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup()"

# N. negative proof: put the bug back into a copy of the migration; its self-test must abort it
if [ "$MIG" != "none" ]; then
  BUGGY="$(mktemp --suffix=.sql)"
  if python3 - "$MIG" "$BUGGY" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
edits = [
    ("AS $function$\nBEGIN\n  IF NEW.phone IS NULL",
     "AS $function$\nDECLARE\n  v_member_id uuid;\nBEGIN\n  IF NEW.phone IS NULL"),
    ("    AND driver_id IS NULL;\n",
     "    AND driver_id IS NULL\n  RETURNING id INTO v_member_id;\n"),
]
out = src
for old, new in edits:
    assert out.count(old) == 1, f"expected {old!r} once, found {out.count(old)}"
    out = out.replace(old, new)
marker = "RETURNING id INTO v_member_id;"
# The header comment quotes the bug too, so count relative to the source.
assert out != src and out.count(marker) == src.count(marker) + 1
open(sys.argv[2], "w").write(out)
PYEOF
  then
    ok "N0 built a copy of the migration with the bug put back"
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n1" -c "CREATE DATABASE ${DB}n1" >/dev/null 2>&1
    N1="$BIN/psql $CONN -d ${DB}n1 -qAt -v ON_ERROR_STOP=1"
    $N1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
    if out=$($N1 -1 -c "SET search_path = ''" -f "$BUGGY" 2>&1); then
      ko "N1 the self-test aborts a migration that still carries the bug" "migration succeeded with the bug in place"
    elif echo "$out" | grep -q "more than one row"; then
      ok "N1 the self-test aborts a migration that still carries the bug"
    else
      ko "N1 the self-test aborts a migration that still carries the bug" "wrong error: $(echo "$out" | head -1)"
    fi
  else
    ko "N0 built a copy of the migration with the bug put back" "the replacement did not apply; N1 skipped"
  fi
  rm -f "$BUGGY"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
