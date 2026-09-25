#!/usr/bin/env bash
# Rehearsal runner for migration 00598 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00598/run.sh none
#       -> scaffold + tests (RED: an approved invitation is never linked to an existing account)
#   supabase/tests/00598/run.sh supabase/migrations/00598_link_fleet_invitations_to_existing_accounts.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Elsewhere, PGBIN, PGPORT and PYTHON override the defaults, e.g. on Windows:
#   PGBIN=<portable pgsql>/bin PGPORT=5437 PYTHON=python bash supabase/tests/00598/run.sh none
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PY="${PYTHON:-python3}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr598
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" </dev/null 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# tcase NAME SQL EXPECTED -> val on fresh fixtures. The reset commits on its own: the signup trigger leaves
# app.trusted_fleet_update = '1' for the rest of its transaction, and in prod that transaction is GoTrue's,
# never the one of a later request. Sharing it here would let the owner's writes skip the protect trigger.
tcase(){ if $P -c "$RESET" </dev/null >/dev/null 2>&1; then val "$1" "$2" "$3"; else ko "$1" "reset failed"; fi; }

# People. auth.users holds phones the way GoTrue does (E.164 digits, no '+');
# public.users gets them normalized by tg_users_normalize_phone.
ADMIN=a0000000-0000-4000-8000-000000000001    # admin, the one approving
OWNER=a0000000-0000-4000-8000-000000000002    # fleet owner (a driver)
DRV=a0000000-0000-4000-8000-000000000003      # driver with a confirmed number: the reported case
PAX=a0000000-0000-4000-8000-000000000004      # passenger only, confirmed number
SEED=a0000000-0000-4000-8000-000000000005     # admin whose number is only in users.phone (prod: 2 seeded admins)
DUP=a0000000-0000-4000-8000-000000000006      # driver who confirmed the number SEED also holds (prod's one shared number)
LONE=a0000000-0000-4000-8000-000000000007     # passenger whose number is only in users.phone
INACT=a0000000-0000-4000-8000-000000000008    # deactivated account, confirmed number
UNCONF=a0000000-0000-4000-8000-000000000009   # number in auth.users, OTP never confirmed
LATER=a0000000-0000-4000-8000-00000000000a    # Google/Apple account, no phone yet
NEWU=b0000000-0000-4000-8000-000000000001     # someone who signs up during a test
CA=c0000000-0000-4000-8000-00000000000a; CB=c0000000-0000-4000-8000-00000000000b
FA=f0000000-0000-4000-8000-00000000000a; FB=f0000000-0000-4000-8000-00000000000b
PEOPLE="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('$ADMIN', '5355550001', now()), ('$OWNER', '5355550002', now()), ('$DRV', '5355551234', now()),
  ('$PAX', '5355552222', now()), ('$SEED', NULL, NULL), ('$DUP', '5355553333', now()),
  ('$LONE', NULL, NULL), ('$INACT', '5355554444', now()), ('$UNCONF', '5355557777', NULL), ('$LATER', NULL, NULL);
INSERT INTO public.users (id, phone, role, is_active) VALUES
  ('$ADMIN', '5355550001', 'admin', true), ('$OWNER', '5355550002', 'driver', true),
  ('$DRV', '5355551234', 'driver', true), ('$PAX', '5355552222', 'customer', true),
  ('$SEED', '+5355553333', 'admin', true), ('$DUP', '5355553333', 'driver', true),
  ('$LONE', '+5355556666', 'customer', true), ('$INACT', '5355554444', 'driver', false),
  ('$UNCONF', '5355557777', 'customer', true), ('$LATER', NULL, 'customer', true);"
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
DELETE FROM auth.users;
$PEOPLE
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('$CA', 'Flota A', '+5355550002', '$OWNER'), ('$CB', 'Flota B', '+5355550002', '$OWNER');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CA', 'Flota A'), ('$FB', '$CB', 'Flota B');"
# as PERSON -> what follows runs the way PostgREST runs that person's call: role authenticated + JWT subject
as(){ printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s';" "$1"; }
# NOJWT -> back to a caller with no JWT (service role, migrations, GoTrue's triggers)
NOJWT="RESET ROLE; RESET request.jwt.claim.sub;"
# invite FLEET PHONE STATUS -> an invitation written with no JWT (a fixture; the owner's own writes are in B)
invite(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('%s', 'Juan', '%s', '%s');" "$1" "$2" "$3"; }
# approve FLEET PHONE -> what fleetService.approveMember() writes, as the admin through RLS
approve(){ printf "%s UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$ADMIN" "$1" "$2" "$NOJWT"; }
# repoint FLEET FROM TO -> fixture: change the number of an invitation without touching its status
repoint(){ printf "UPDATE public.fleet_members SET driver_phone = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s';" "$3" "$1" "$2"; }
# signup PHONE -> a new account with that confirmed number (what GoTrue + handle_new_user write)
signup(){ printf "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('$NEWU', '%s', now()); INSERT INTO public.users (id, phone) VALUES ('$NEWU', '%s');" "$1" "$1"; }
# STATE -> every invitation as status:who, by fleet and phone ('-' = not linked)
STATE="SELECT string_agg(fm.status || ':' || coalesce(p.who, '-'), ',' ORDER BY fm.fleet_id, fm.driver_phone)
FROM public.fleet_members fm LEFT JOIN (VALUES ('$ADMIN'::uuid, 'ADMIN'), ('$OWNER'::uuid, 'OWNER'), ('$DRV'::uuid, 'DRV'),
  ('$PAX'::uuid, 'PAX'), ('$SEED'::uuid, 'SEED'), ('$DUP'::uuid, 'DUP'), ('$LONE'::uuid, 'LONE'), ('$INACT'::uuid, 'INACT'),
  ('$UNCONF'::uuid, 'UNCONF'), ('$LATER'::uuid, 'LATER'), ('$NEWU'::uuid, 'NEWU')) p(id, who) ON p.id = fm.driver_id;"
# Bodies read from prod on 2026-09-25: signature|md5(prosrc)|length. The scaffold must carry them, and the migration must not change them.
LIVE="auto_link_fleet_member_on_signup()|c4b25ab786f201ced8661633ff113e57|434
tg_fleet_members_protect()|8b0d07aff7ab33142bfcec29304c01ed|674
relink_fleet_member_for_existing_driver(uuid,text)|87327e7eb782781d445804ae8b4a5a21|565
_normalize_cuban_phone(text)|9f5227a3c108fa42f6aacdf01fb0ad86|451
is_admin()|22cb75e91980d512498034cd33e1eda2|285
current_user_role()|cb4a7c12d4e21fe2997135833f141e25|103
is_super_admin()|5655a4615e92e8b1e323d06c7566b058|105
tg_users_normalize_phone()|c0491b42cf36767c3911fb8a3fda9f04|147
tg_users_protect_admin_fields()|2907fccbd0f2ec2201b7c0ec61d434a3|1701
tg_corporate_accounts_protect_insert()|16d3e41267fd99172c562f62e4e968fd|455"
bodies(){ while IFS='|' read -r sig md5 len; do
  val "$1 $sig is the prod body" "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.$sig'::regprocedure" "$md5/$len"
done <<< "$LIVE"; }
# ROWS -> fingerprint of everything the self-test must leave alone (all but the backfilled invitation)
ROWS="SELECT md5(coalesce((SELECT string_agg(id::text || coalesce(driver_id::text, '-') || status || driver_phone || coalesce(signed_up_at::text, '-'), ',' ORDER BY id)
                           FROM public.fleet_members WHERE driver_phone <> '+5355551234'), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.driver_fleets), '')
          || coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM public.corporate_accounts), '')
          || coalesce((SELECT string_agg(id::text || coalesce(phone, '-') || is_active, ',' ORDER BY id) FROM public.users), '')
          || coalesce((SELECT string_agg(id::text || coalesce(phone, '-') || coalesce(phone_confirmed_at::text, '-'), ',' ORDER BY id) FROM auth.users), ''))"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
$P -c "$PEOPLE" >/dev/null || { echo "seed failed"; exit 1; }
bodies S

if [ "$MIG" != "none" ]; then
  # State before the migration: one invitation approved for DRV's confirmed number (the backfill's case),
  # one for a number only in users.phone and one whose OTP was never confirmed (both must stay as they are).
  $P -c "$RESET" >/dev/null || exit 1
  $P -c "$(invite $FA '+5355551234' 'approved') $(invite $FA '+5355556666' 'approved') $(invite $FB '+5355557777' 'pending_signup')" >/dev/null || exit 1
  BEFORE=$($P -c "$ROWS" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the self-test leaves every other row exactly as it was" "$ROWS" "$BEFORE"
  val "M2 the backfill linked the invitation approved before the migration, and only that one" "$STATE" "active:DRV,approved:-,pending_signup:-"
fi

echo "== tests =="
# A. the reported case: the admin approves, through RLS, like FleetReview does
tcase "A1 existing driver with a confirmed number: the approval itself links them" \
  "$(invite $FA '+5355551234' 'pending_review') $(approve $FA '+5355551234') $STATE
   SELECT signed_up_at IS NOT NULL FROM public.fleet_members;" "active:DRV;t"
tcase "A2 the owner typed the number as 8 digits: still linked" \
  "$(invite $FA '55551234' 'pending_review') $(approve $FA '55551234') $STATE" "active:DRV"
tcase "A3 invited by two fleets: each approval links its own invitation" \
  "$(invite $FA '+5355551234' 'pending_review') $(invite $FB '5355551234' 'pending_review')
   $(approve $FA '+5355551234') $(approve $FB '5355551234') $STATE" "active:DRV,active:DRV"
tcase "A4 a passenger-only account is linked too, as a signup would be" \
  "$(invite $FA '+5355552222' 'pending_review') $(approve $FA '+5355552222') $STATE" "active:PAX"
tcase "A5 an invitation inserted already approved (service role) is linked on insert" \
  "$(invite $FA '+5355551234' 'approved') $STATE" "active:DRV"
tcase "A6 rejected, then approved: linked when it becomes approved" \
  "$(invite $FA '+5355551234' 'rejected') $(approve $FA '+5355551234') $STATE" "active:DRV"
tcase "A7 the number two accounts share (prod: a seeded admin and a driver): linked to the one who confirmed it" \
  "$(invite $FA '+5355553333' 'pending_review') $(approve $FA '+5355553333') $STATE" "active:DUP"
tcase "A8 nothing is linked before the approval" \
  "$(invite $FA '+5355551234' 'pending_review') $STATE" "pending_review:-"
tcase "A9 a number that is only in users.phone, never confirmed by OTP: not linked" \
  "$(invite $FA '+5355556666' 'pending_review') $(approve $FA '+5355556666') $STATE" "approved:-"
tcase "A10 a deactivated account: not linked" \
  "$(invite $FA '+5355554444' 'pending_review') $(approve $FA '+5355554444') $STATE" "approved:-"
tcase "A11 a number in auth.users whose OTP was never confirmed: not linked" \
  "$(invite $FA '+5355557777' 'pending_review') $(approve $FA '+5355557777') $STATE" "approved:-"
tcase "A12 nobody has the number yet: stays approved, and the signup links it later (00595)" \
  "$(invite $FA '+5355559999' 'pending_review') $(approve $FA '+5355559999') $STATE $(signup 5355559999) $STATE" "approved:-;active:NEWU"
tcase "A13 an invitation inserted as pending_signup (service role) is linked on insert" \
  "$(invite $FA '+5355551234' 'pending_signup') $STATE" "active:DRV"

# B. the fleet owner cannot use it
tcase "B1 the owner inserts an invitation as approved: forced to pending_review, not linked" \
  "$(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status)
          VALUES ('$FA', 'Carlos', '+5355551234', 'approved'); $NOJWT $STATE" "pending_review:-"
tcase "B2 the owner approves their own invitation: reverted, not linked" \
  "$(invite $FA '+5355551234' 'pending_review') $(as $OWNER) UPDATE public.fleet_members SET status = 'approved' WHERE fleet_id = '$FA';
   $NOJWT $STATE" "pending_review:-"
tcase "B3 the owner re-points an approved invitation at a driver's confirmed number, sending status along: not linked" \
  "$(invite $FA '+5355559999' 'pending_review') $(approve $FA '+5355559999')
   $(as $OWNER) UPDATE public.fleet_members SET driver_phone = '+5355551234', status = 'approved' WHERE fleet_id = '$FA'; $NOJWT
   SELECT status || ':' || coalesce(driver_id::text, '-') || '|' || driver_phone FROM public.fleet_members;" "approved:-|+5355551234"

# C. the account verifies its phone after the approval (Google/Apple sign-in, then link-phone)
tcase "C1 link-phone confirms the number in auth.users, the service role copies it to users.phone: linked" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888')
   UPDATE auth.users SET phone = '5355558888', phone_confirmed_at = now() WHERE id = '$LATER';
   UPDATE public.users SET phone = '+5355558888' WHERE id = '$LATER'; $STATE" "active:LATER"
tcase "C2 same, but the app writes users.phone under the account's own JWT: linked" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888')
   UPDATE auth.users SET phone = '5355558888', phone_confirmed_at = now() WHERE id = '$LATER';
   $(as $LATER) UPDATE public.users SET phone = '5355558888' WHERE id = '$LATER'; $NOJWT $STATE" "active:LATER"
tcase "C3 a number written into users.phone without an OTP links nothing" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888')
   $(as $LATER) UPDATE public.users SET phone = '+5355558888' WHERE id = '$LATER'; $NOJWT $STATE" "approved:-"
tcase "C4 writing someone else's confirmed number into your own users.phone does not take their invitation" \
  "$(invite $FA '+5355559999' 'pending_review') $(approve $FA '+5355559999') $(repoint $FA '+5355559999' '+5355551234')
   $(as $LATER) UPDATE public.users SET phone = '+5355551234' WHERE id = '$LATER'; $NOJWT $STATE" "approved:-"
tcase "C5 the trusted flag does not outlive the write that set it" \
  "$(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888')
   UPDATE auth.users SET phone = '5355558888', phone_confirmed_at = now() WHERE id = '$LATER';
   $(as $LATER) UPDATE public.users SET phone = '+5355558888' WHERE id = '$LATER';
   SELECT '[' || coalesce(current_setting('app.trusted_fleet_update', true), '') || ']'; $NOJWT $STATE" "[];active:LATER"
tcase "C6 saving the same number again links nothing" \
  "$(invite $FA '+5355559999' 'pending_review') $(approve $FA '+5355559999') $(repoint $FA '+5355559999' '+5355551234')
   $(as $DRV) UPDATE public.users SET phone = '5355551234' WHERE id = '$DRV'; $NOJWT $STATE" "approved:-"

# X. the signup path (00595) is unchanged
tcase "X1 invited by two fleets, then signs up: both linked" \
  "$(invite $FA '+5355559999' 'approved') $(invite $FB '55559999' 'approved') $(signup 5355559999) $STATE" "active:NEWU,active:NEWU"

# D. contract
for f in "_user_id_by_verified_phone(text)" "tg_fleet_members_set_driver_on_approval()" "auto_link_fleet_member_on_phone_verified()"; do
  val "D1 $f: execute anon no, authenticated no, service_role yes" \
    "SELECT has_function_privilege('anon', 'public.$f', 'EXECUTE') || '|' || has_function_privilege('authenticated', 'public.$f', 'EXECUTE')
            || '|' || has_function_privilege('service_role', 'public.$f', 'EXECUTE')" "false|false|true"
done
val "D2 the three new functions are SECURITY DEFINER with a pinned search_path" \
  "SELECT string_agg(proname || ':' || prosecdef || ':' || array_to_string(proconfig, ','), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('_user_id_by_verified_phone', 'tg_fleet_members_set_driver_on_approval', 'auto_link_fleet_member_on_phone_verified')" \
  "_user_id_by_verified_phone:true:search_path=public, pg_temp,auto_link_fleet_member_on_phone_verified:true:search_path=public, pg_temp,tg_fleet_members_set_driver_on_approval:true:search_path=public, pg_temp"
val "D3 on fleet_members the link trigger fires after the protect trigger (name order)" \
  "SELECT string_agg(tgname, ',' ORDER BY tgname COLLATE \"C\") FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND NOT tgisinternal" \
  "trg_fleet_members_protect,trg_fleet_members_set_driver_on_approval"
val "D4 the approval trigger: BEFORE INSERT OR UPDATE OF status, per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND tgname = 'trg_fleet_members_set_driver_on_approval'" \
  "CREATE TRIGGER trg_fleet_members_set_driver_on_approval BEFORE INSERT OR UPDATE OF status ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_set_driver_on_approval()"
val "D5 the phone trigger: AFTER UPDATE OF phone, only when the number changes to a non-null one" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'auto_link_fleet_member_on_phone_verified'" \
  "CREATE TRIGGER auto_link_fleet_member_on_phone_verified AFTER UPDATE OF phone ON public.users FOR EACH ROW WHEN (((new.phone IS NOT NULL) AND (new.phone IS DISTINCT FROM old.phone))) EXECUTE FUNCTION auto_link_fleet_member_on_phone_verified()"
val "D6 the signup trigger is still there, AFTER INSERT per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'auto_link_fleet_member_on_signup'" \
  "CREATE TRIGGER auto_link_fleet_member_on_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION auto_link_fleet_member_on_signup()"
bodies "D7 unchanged:"

# N. negative proofs: a copy of the migration with one defect must be aborted by its own assertions
# mutate OLD NEW -> path of a copy of the migration with OLD (present exactly once) replaced by NEW
mutate(){ local out; out="$(mktemp --suffix=.sql)"
  OLD="$1" NEW="$2" "$PY" - "$MIG" "$out" <<'PYEOF' || { rm -f "$out"; return 1; }
import os, sys
src = open(sys.argv[1], newline='').read()
old, new = os.environ['OLD'], os.environ['NEW']
assert src.count(old) == 1, f"expected the anchor once, found {src.count(old)}"
out = src.replace(old, new)
assert out != src
open(sys.argv[2], 'w', newline='').write(out)
PYEOF
  echo "$out"; }
# negative NAME OLD NEW ERROR -> the defective copy, applied to a fresh scaffold, must fail with ERROR
negative(){ local buggy out
  if ! buggy="$(mutate "$2" "$3")"; then ko "$1" "the anchor was not found; proof skipped"; return; fi
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n" -c "CREATE DATABASE ${DB}n" >/dev/null 2>&1
  local N="$BIN/psql $CONN -d ${DB}n -qAt -v ON_ERROR_STOP=1"
  $N -f "$DIR/scaffold.sql" >/dev/null 2>&1 && $N -c "$PEOPLE" >/dev/null 2>&1
  if out=$($N -1 -c "SET search_path = ''" -f "$buggy" 2>&1); then
    ko "$1" "the migration applied with the defect in place"
  elif echo "$out" | grep -q "$4"; then
    ok "$1"
  else
    ko "$1" "wrong error: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"
  fi
  rm -f "$buggy"; }
if [ "$MIG" != "none" ]; then
  negative "N1 the approval stops linking: the self-test aborts the migration" \
    "  v_driver := public._user_id_by_verified_phone(NEW.driver_phone);" "  v_driver := NULL;" \
    "approving an invitation for a verified account left it"
  negative "N2 a verified phone stops linking: the self-test aborts the migration" \
    "  SET driver_id = NEW.id," "  SET driver_id = NULL," \
    "verifying the phone left its approved invitation"
  negative "N3 the helper stays executable by clients: the ACL check aborts the migration" \
    "REVOKE EXECUTE ON FUNCTION public._user_id_by_verified_phone(text) FROM PUBLIC, anon, authenticated;" "" \
    "is executable by anon or authenticated"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
