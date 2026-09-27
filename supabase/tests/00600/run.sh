#!/usr/bin/env bash
# Rehearsal runner for migration 00600 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00600/run.sh none
#       -> scaffold + tests (RED: the fleet owner rewrites an invitation the admin already reviewed)
#   supabase/tests/00600/run.sh supabase/migrations/00600_freeze_reviewed_fleet_invitations.sql
#       -> scaffold + migration x2 (idempotency) + tests + fidelity + a database built from git
#          + negative proofs + 00598 in both orders when it is in the checkout (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# PG_BIN, PG_PORT and PYTHON override the binaries directory, the port and the python, e.g. on Windows:
#   PG_BIN=/c/.../pgsql/bin PG_PORT=5441 PYTHON=python supabase/tests/00600/run.sh <migration>
# M598 points at a 00598 migration outside the checkout (by default: supabase/migrations/00598_*.sql).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PG_PORT:-5433} -U pgtest"
DB=pr600
PY="${PYTHON:-$(command -v python3 || command -v python)}"   # Windows has no python3
# Notices off so a DO block's chatter never lands in a compared value; untranslated messages and
# UTF-8 so that psql on Windows prints the same bytes as on Linux.
export PGOPTIONS="-c client_min_messages=warning" PGCLIENTENCODING=UTF8 LC_MESSAGES=C
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" </dev/null 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# SQL files reach psql with their CRs stripped: a Windows checkout with core.autocrlf=true may have
# them in CRLF, and every CR would end up inside the function bodies and break the md5 checks.
# fresh NAME -> a database with the scaffold and the people, nothing else
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 \
  && tr -d '\r' < "$DIR/scaffold.sql" | $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f - >/dev/null 2>&1 \
  && $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -c "$PEOPLE" >/dev/null 2>&1; }
# apply FILE [DB] [MODE] -> run a migration as role postgres (prod's owner: no superuser, BYPASSRLS)
# with an empty search_path, in one transaction unless MODE is "autocommit"; prints psql's output,
# notices included
apply(){ local one="-1"; [ "${3:-}" = autocommit ] && one=""
  tr -d '\r' < "$1" | PGOPTIONS="-c client_min_messages=notice" \
    $BIN/psql $CONN -d "${2:-$DB}" -qAt -v ON_ERROR_STOP=1 $one -c "SET ROLE postgres" -c "SET search_path = ''" -f - 2>&1 | tr -d '\r'
  return "${PIPESTATUS[1]}"; }

ADMIN=a0000000-0000-4000-8000-000000000001    # admin, the one reviewing
OWNER=a0000000-0000-4000-8000-000000000002    # fleet owner (a driver)
DRV=a0000000-0000-4000-8000-000000000003      # a driver already linked to the fleet
NEWU=b0000000-0000-4000-8000-000000000001     # someone who signs up during a test
NEWU2=b0000000-0000-4000-8000-000000000002    # someone else who signs up during a test
LATER=b0000000-0000-4000-8000-000000000003    # a Google/Apple account with no phone yet (00598 cases)
CA=c0000000-0000-4000-8000-00000000000a; CB=c0000000-0000-4000-8000-00000000000b
FA=f0000000-0000-4000-8000-00000000000a; FB=f0000000-0000-4000-8000-00000000000b
# auth.users keeps phones the way GoTrue does (E.164 digits, no '+'); public.users has them normalized.
PEOPLE="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('$ADMIN', '5355550001', now()), ('$OWNER', '5355550002', now()), ('$DRV', '5355551234', now());
INSERT INTO public.users (id, phone, role) VALUES
  ('$ADMIN', '+5355550001', 'admin'), ('$OWNER', '+5355550002', 'driver'), ('$DRV', '+5355551234', 'driver');"
# RESET -> no invitations, no one signed up during a test, the owner's two fleets
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
DELETE FROM auth.users WHERE id IN ('$NEWU', '$NEWU2', '$LATER');
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('$CA', 'Flota A', '+5355550002', '$OWNER'), ('$CB', 'Flota B', '+5355550002', '$OWNER');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CA', 'Flota A'), ('$FB', '$CB', 'Flota B');"
# as PERSON -> what follows runs the way PostgREST runs that person's call: role authenticated + JWT claims
as(){ printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\": \"%s\", \"role\": \"authenticated\"}';" "$1"; }
# NOJWT -> back to a caller with no JWT (service role, migrations, GoTrue's triggers)
NOJWT="RESET ROLE; RESET request.jwt.claims;"
# invite FLEET PHONE STATUS -> a fixture invitation, written with no JWT so it keeps STATUS
invite(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path, status) VALUES ('%s', 'Juan', '%s', 'juan@x.cu', 'L1', 'I1', 'd1.jpg', '%s');" "$1" "$2" "$3"; }
# linked FLEET STATUS -> a fixture invitation already linked to DRV
linked(){ printf "INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path, status, signed_up_at) VALUES ('%s', '$DRV', 'Juan', '+5355551234', 'juan@x.cu', 'L1', 'I1', 'd1.jpg', '%s', now());" "$1" "$2"; }
# approve FLEET PHONE / reject FLEET PHONE REASON -> what fleetService.approveMember() / rejectMember() write, as the admin through RLS
approve(){ printf "%s UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '$ADMIN' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$1" "$2" "$NOJWT"; }
reject(){ printf "%s UPDATE public.fleet_members SET status = 'rejected', reviewed_at = now(), reviewed_by = '$ADMIN', rejected_reason = '%s' WHERE fleet_id = '%s' AND driver_phone = '%s'; %s" "$(as "$ADMIN")" "$3" "$1" "$2" "$NOJWT"; }
# REWRITE -> the owner, through RLS, rewrites every reviewed field of their fleet A invitations and moves them to fleet B
REWRITE="$(as "$OWNER") UPDATE public.fleet_members SET driver_phone = '+5355559999', driver_name = 'Otro', driver_email = 'otro@x.cu',
  driver_license_number = 'L9', driver_id_number = 'I9', license_doc_path = 'd9.jpg', fleet_id = '$FB' WHERE fleet_id = '$FA'; $NOJWT"
# signup ID PHONE -> a new account with that confirmed number (what GoTrue + handle_new_user write, no JWT)
signup(){ printf "INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES ('%s', '%s', now()); INSERT INTO public.users (id, phone) VALUES ('%s', '%s');" "$1" "${2#+}" "$1" "$2"; }
WHO="LEFT JOIN (VALUES ('$DRV'::uuid, 'DRV'), ('$NEWU'::uuid, 'NEWU'), ('$NEWU2'::uuid, 'NEWU2'), ('$LATER'::uuid, 'LATER')) p(id, who) ON p.id = fm.driver_id"
# ROW -> fleet|status|who|phone|name|email|licence|id|doc|reason for every invitation ('-' = not linked / NULL)
ROW="SELECT string_agg(CASE fm.fleet_id WHEN '$FA' THEN 'A' WHEN '$FB' THEN 'B' END || '|' || fm.status || '|' || coalesce(p.who, '-')
  || '|' || fm.driver_phone || '|' || fm.driver_name || '|' || coalesce(fm.driver_email, '-') || '|' || coalesce(fm.driver_license_number, '-')
  || '|' || coalesce(fm.driver_id_number, '-') || '|' || coalesce(fm.license_doc_path, '-') || '|' || coalesce(fm.rejected_reason, '-'),
  ',' ORDER BY fm.added_at, fm.driver_phone) FROM public.fleet_members fm $WHO;"
# LINKS -> status:who for every invitation
LINKS="SELECT string_agg(fm.status || ':' || coalesce(p.who, '-'), ',' ORDER BY fm.added_at, fm.driver_phone) FROM public.fleet_members fm $WHO;"
# FINGERPRINT -> every row the self-test must leave alone
FINGERPRINT="SELECT md5(coalesce((SELECT string_agg(fm::text, ',' ORDER BY fm.id) FROM public.fleet_members fm), '')
  || coalesce((SELECT string_agg(df::text, ',' ORDER BY df.id) FROM public.driver_fleets df), '')
  || coalesce((SELECT string_agg(ca::text, ',' ORDER BY ca.id) FROM public.corporate_accounts ca), '')
  || coalesce((SELECT string_agg(u::text, ',' ORDER BY u.id) FROM public.users u), '')
  || coalesce((SELECT string_agg(au::text, ',' ORDER BY au.id) FROM auth.users au), ''))"
# Bodies read from prod on 2026-09-25: signature|md5(prosrc)|length. The scaffold must carry them.
LIVE="public.tg_fleet_members_protect()|8b0d07aff7ab33142bfcec29304c01ed|674
public.auto_link_fleet_member_on_signup()|c4b25ab786f201ced8661633ff113e57|434
public.relink_fleet_member_for_existing_driver(uuid,text)|87327e7eb782781d445804ae8b4a5a21|565
public.is_admin()|22cb75e91980d512498034cd33e1eda2|285
public.current_user_role()|cb4a7c12d4e21fe2997135833f141e25|103
public._normalize_cuban_phone(text)|9f5227a3c108fa42f6aacdf01fb0ad86|451
public.tg_corporate_accounts_protect_insert()|16d3e41267fd99172c562f62e4e968fd|455
auth.uid()|cdef18c69c4f4cbbced2eaf81e628b49|176"
# bodies PREFIX [SKIP] -> every LIVE body but SKIP is still the prod one
bodies(){ while IFS='|' read -r sig md5 len; do
  [ "$sig" = "${2:-}" ] && continue
  val "$1 $sig is the prod body" "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = '$sig'::regprocedure" "$md5/$len"
done <<< "$LIVE"; }
PROD_ACL="{=X/postgres,postgres=X/postgres,service_role=X/postgres}"   # tg_fleet_members_protect() in prod
ACL="SELECT proacl::text FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure"

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed (is the cluster up on port ${PG_PORT:-5433}?)"; exit 1; }
bodies S
val "S the protect function has prod's ACL" "$ACL" "$PROD_ACL"

if [ "$MIG" != "none" ]; then
  # State before the migration: invitations the self-test must leave exactly as they are.
  $P -c "$RESET $(invite $FA '+5355551111' 'approved') $(invite $FA '+5355552222' 'pending_review') $(linked $FB 'active')" >/dev/null || exit 1
  BEFORE=$($P -c "$FINGERPRINT" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="
  if ! OUT=$(apply "$MIG"); then echo "migration failed:"; echo "$OUT" | grep -m3 ERROR; exit 1; fi
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="
  if ! OUT2=$(apply "$MIG" "$DB" autocommit); then echo "migration NOT idempotent:"; echo "$OUT2" | grep -m3 ERROR; exit 1; fi
  val "M1 the self-test leaves every row exactly as it was" "$FINGERPRINT" "$BEFORE"
  if echo "$OUT" | grep -q "00600: verified, the owner cannot change a reviewed invitation"; then
    ok "M2 the self-test ran (it did not skip) and passed"
  else
    ko "M2 the self-test ran (it did not skip) and passed" "$(echo "$OUT" | grep -m1 NOTICE)"
  fi
  CLAIMS=$(tr -d '\r' < "$MIG" | $BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1 -1 -c "SET ROLE postgres" -c "SET search_path = ''" -f - \
    -c "SELECT '[' || coalesce(current_setting('request.jwt.claim.sub', true), '') || '|' || coalesce(current_setting('request.jwt.claims', true), '') || ']'" 2>/dev/null | tr -d '\r')
  if [ "$CLAIMS" = "[|]" ]; then ok "M3 the self-test's JWT claims do not outlive the migration"
  else ko "M3 the self-test's JWT claims do not outlive the migration" "got [$CLAIMS]"; fi
fi

echo "== tests =="
# A. the reported case: once the admin reviewed the invitation, the owner's changes are discarded
val "A1 approved: the owner's rewrite of every reviewed field, fleet included, is discarded" \
  "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $ROW" \
  "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A2 after the attempt, the new number's signup links nothing and the reviewed number's signup links it" \
  "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $(signup $NEWU '+5355559999') $LINKS $(signup $NEWU2 '+5355551111') $LINKS" \
  "approved:-;active:NEWU2"
val "A3 pending_signup: the rewrite is discarded" \
  "$RESET $(invite $FA '+5355551111' 'pending_signup') $REWRITE $ROW" \
  "A|pending_signup|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A4 rejected: the rewrite is discarded" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(reject $FA '+5355551111' 'Licencia vencida') $REWRITE $ROW" \
  "A|rejected|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|Licencia vencida"
val "A5 active: the rewrite is discarded and the driver stays linked" \
  "$RESET $(linked $FA 'active') $REWRITE $ROW" \
  "A|active|DRV|+5355551234|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A6 inactive: the rewrite is discarded" \
  "$RESET $(linked $FA 'inactive') $REWRITE $ROW" \
  "A|inactive|DRV|+5355551234|Juan|juan@x.cu|L1|I1|d1.jpg|-"
val "A7 the rejection reason is the admin's: the owner cannot rewrite it" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(reject $FA '+5355551111' 'Licencia vencida')
   $(as $OWNER) UPDATE public.fleet_members SET rejected_reason = 'Aprobado por el supervisor'; $NOJWT
   SELECT rejected_reason FROM public.fleet_members;" "Licencia vencida"
val "A8 nor plant one on an invitation in review" \
  "$RESET $(invite $FA '+5355551111' 'pending_review')
   $(as $OWNER) UPDATE public.fleet_members SET rejected_reason = 'Aprobado por el supervisor'; $NOJWT
   SELECT coalesce(rejected_reason, '-') FROM public.fleet_members;" "-"
val "A9 status sent along with the number (to reopen the review): both discarded" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111')
   $(as $OWNER) UPDATE public.fleet_members SET status = 'pending_review', driver_phone = '+5355559999'; $NOJWT
   SELECT status || '|' || driver_phone FROM public.fleet_members;" "approved|+5355551111"
val "A10 an upsert that updates on conflict (PostgREST merge-duplicates) is discarded too" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111')
   $(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, driver_license_number)
     VALUES ('$FA', 'Otro', '+5355551111', 'L9')
     ON CONFLICT (fleet_id, driver_phone) DO UPDATE SET driver_name = EXCLUDED.driver_name, driver_license_number = EXCLUDED.driver_license_number; $NOJWT
   SELECT status || '|' || driver_name || '|' || driver_license_number FROM public.fleet_members;" "approved|Juan|L1"

# B. what must keep working
val "B1 in review: the owner's edits go through, fleet included (the admin has not reviewed it yet)" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $REWRITE $ROW" \
  "B|pending_review|-|+5355559999|Otro|otro@x.cu|L9|I9|d9.jpg|-"
val "B2 the admin corrects a reviewed invitation" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $ADMIN) UPDATE public.fleet_members SET driver_phone = '+5355559999', driver_name = 'Otro'; $NOJWT
   SELECT status || '|' || driver_phone || '|' || driver_name FROM public.fleet_members;" "approved|+5355559999|Otro"
val "B3 a write with no JWT (service role, a migration) goes through" \
  "$RESET $(invite $FA '+5355551111' 'approved') UPDATE public.fleet_members SET driver_phone = '+5355559999';
   SELECT driver_phone FROM public.fleet_members;" "+5355559999"
val "B4 the signup of the reviewed number links it (00595, trusted flag)" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111') $(signup $NEWU '+5355551111') $LINKS" "active:NEWU"
val "B5 the admin relink RPC links it" \
  "$RESET $(invite $FA '+5355551234' 'pending_review') $(approve $FA '+5355551234')
   $(as $ADMIN) SELECT public.relink_fleet_member_for_existing_driver('$DRV', '+5355551234'); $NOJWT $LINKS" "1;active:DRV"
val "B6 the owner deletes a reviewed invitation and invites again: the new one goes to review, unlinked" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $OWNER) DELETE FROM public.fleet_members WHERE fleet_id = '$FA';
   INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES ('$FA', 'Otro', '+5355559999', 'approved'); $NOJWT $ROW" \
  "A|pending_review|-|+5355559999|Otro|-|-|-|-|-"
val "B7 the owner's insert is forced to review, unlinked, with no reason or reviewer" \
  "$RESET $(as $OWNER) INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status, rejected_reason, reviewed_by)
     VALUES ('$FA', '$DRV', 'Juan', '+5355551234', 'active', 'Aprobado', '$ADMIN'); $NOJWT
   SELECT status || '|' || coalesce(driver_id::text, '-') || '|' || coalesce(rejected_reason, '-') || '|' || coalesce(reviewed_by::text, '-') FROM public.fleet_members;" \
  "pending_review|-|-|-"
val "B8 the admin approves and rejects the way FleetReview does" \
  "$RESET $(invite $FA '+5355551111' 'pending_review') $(invite $FA '+5355552222' 'pending_review')
   $(approve $FA '+5355551111') $(reject $FA '+5355552222' 'Licencia vencida')
   SELECT string_agg(status || '|' || coalesce(rejected_reason, '-') || '|' || (reviewed_by = '$ADMIN'), ',' ORDER BY driver_phone) FROM public.fleet_members;" \
  "approved|-|true,rejected|Licencia vencida|true"
val "B9 an owner update that changes nothing raises nothing" \
  "$RESET $(invite $FA '+5355551111' 'approved')
   $(as $OWNER) UPDATE public.fleet_members SET driver_phone = driver_phone, driver_name = driver_name; $NOJWT $ROW" \
  "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"

# D. contract: same trigger, same function shape and privileges, no other body touched
val "D1 the trigger is the same: BEFORE INSERT OR UPDATE, every column, per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.fleet_members'::regclass AND tgname = 'trg_fleet_members_protect'" \
  "CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect()"
val "D2 same signature, SECURITY DEFINER, same pinned search_path, still owned by postgres" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || array_to_string(proconfig, ',') || '|' || pg_get_userbyid(proowner)
   FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" "|trigger|true|search_path=public, pg_catalog|postgres"
val "D3 the ACL is prod's" "$ACL" "$PROD_ACL"
bodies "D4 unchanged:" "public.tg_fleet_members_protect()"

if [ "$MIG" != "none" ]; then
  # D5. fidelity: the new body is the live one plus the 00600 block, and nothing else
  FIDQ="$("$PY" - "$MIG" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding='utf-8', newline='').read().replace('\r', '')
fn = src.index('CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()')
start = src.index('    -- 00600:', fn)
end = src.index('    END IF;\n', start) + len('    END IF;\n')
blk = src[start:end]
assert '$blk$' not in blk
q = ("SELECT ((length(prosrc) - length(replace(prosrc, $blk${0}$blk$, ''))) / length($blk${0}$blk$))::text"
     " || '|' || md5(replace(prosrc, $blk${0}$blk$, '')) || '/' || length(replace(prosrc, $blk${0}$blk$, ''))"
     " FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure").format(blk)
sys.stdout.buffer.write(q.encode('utf-8'))  # bytes: a text-mode stdout on Windows would turn \n into \r\n
PYEOF
)"
  if [ -n "$FIDQ" ]; then
    val "D5 without its 00600 block (present once), the new body is byte for byte the live one" "$FIDQ" "1|8b0d07aff7ab33142bfcec29304c01ed/674"
  else
    ko "D5 without its 00600 block (present once), the new body is byte for byte the live one" "could not find the block in the migration"
  fi

  # G. a database built from the migrations in git has 00435's text (with comments), not the live one
  GIT="$(mktemp --suffix=.sql)"
  "$PY" - "$ROOT/supabase/migrations/00435_round7_fleet_sched_hardening.sql" "$GIT" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding='utf-8', newline='').read().replace('\r', '')
start = src.index('CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect()')
end = src.index('$function$;', start) + len('$function$;')
open(sys.argv[2], 'w', encoding='utf-8', newline='').write(src[start:end] + '\n')
PYEOF
  fresh ${DB}g
  G="$BIN/psql $CONN -d ${DB}g -qAt -v ON_ERROR_STOP=1"
  $G -f "$GIT" >/dev/null 2>&1
  if [ "$($G -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.tg_fleet_members_protect()'::regprocedure" | tr -d '\r')" != "9d34552cc0598d60952239a2680129fd" ]; then
    ko "G1 a database built from git accepts the migration and freezes the reviewed invitation" "could not load 00435's text"
  elif ! OUT=$(apply "$MIG" ${DB}g); then
    ko "G1 a database built from git accepts the migration and freezes the reviewed invitation" "$(echo "$OUT" | grep -m1 ERROR)"
  else
    P_MAIN="$P"; P="$G"
    val "G1 a database built from git accepts the migration and freezes the reviewed invitation" \
      "$RESET $(invite $FA '+5355551111' 'approved') $REWRITE $ROW" "A|approved|-|+5355551111|Juan|juan@x.cu|L1|I1|d1.jpg|-"
    P="$P_MAIN"
  fi
  rm -f "$GIT"

  # N. negative proofs: a copy of the migration with one defect, or a database that is not what the
  # migration expects, must be refused by the migration's own assertions
  # mutate OLD NEW -> path of a copy of the migration with OLD (present exactly once) replaced by NEW
  mutate(){ local out; out="$(mktemp --suffix=.sql)"
    OLD="$1" NEW="$2" "$PY" - "$MIG" "$out" <<'PYEOF' || { rm -f "$out"; return 1; }
import os, sys
src = open(sys.argv[1], encoding='utf-8', newline='').read().replace('\r', '')
old, new = os.environ['OLD'], os.environ['NEW']
assert src.count(old) == 1, f"expected the anchor once, found {src.count(old)}"
out = src.replace(old, new)
assert out != src
open(sys.argv[2], 'w', encoding='utf-8', newline='').write(out)
PYEOF
    echo "$out"; }
  # expect_abort NAME ERROR FILE [PREP_SQL] -> FILE, applied to a fresh scaffold (after PREP_SQL), must fail with ERROR
  expect_abort(){ local out
    fresh ${DB}n
    if [ -n "${4:-}" ] && ! out=$($BIN/psql $CONN -d ${DB}n -qAt -v ON_ERROR_STOP=1 -c "$4" 2>&1); then
      ko "$1" "setup failed: $(echo "$out" | tr -d '\r' | grep -m1 ERROR)"; return; fi
    if out=$(apply "$3" ${DB}n); then
      ko "$1" "the migration applied with the defect in place"
    elif echo "$out" | grep -q "$2"; then
      ok "$1"
    else
      ko "$1" "wrong error: $(echo "$out" | grep -m1 ERROR)"
    fi; }
  # negative NAME OLD NEW ERROR -> the copy with OLD replaced by NEW must be aborted with ERROR
  negative(){ local buggy
    if ! buggy="$(mutate "$2" "$3")"; then ko "$1" "the anchor was not found; proof skipped"; return; fi
    expect_abort "$1" "$4" "$buggy"
    rm -f "$buggy"; }
  negative "N1 the number is no longer frozen: the self-test aborts the migration" \
    "      NEW.driver_phone          := OLD.driver_phone;
" "" "the owner changed an invitation the admin had reviewed"
  negative "N2 the fleet is no longer frozen: the self-test aborts the migration" \
    "      NEW.fleet_id              := OLD.fleet_id;
" "" "the owner changed an invitation the admin had reviewed"
  negative "N3 an invitation in review is frozen too: the self-test aborts the migration" \
    "    IF OLD.status IS DISTINCT FROM 'pending_review' THEN" "    IF true THEN" \
    "the owner could not edit an invitation still in review"
  negative "N4 the rejection reason is left writable: the self-test aborts the migration" \
    "    NEW.rejected_reason := OLD.rejected_reason;
" "" "the owner rewrote the admin"
  expect_abort "N5 someone changed the function after 2026-09-25: the migration refuses to replace it" \
    "is not the body this migration was written against" "$MIG" \
    "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.tg_fleet_members_protect()'::regprocedure),
       E'    RETURN NEW;\n  END IF;\nEND;', E'    NEW.added_at := OLD.added_at;\n    RETURN NEW;\n  END IF;\nEND;'); END \$d\$;"
  expect_abort "N6 the trigger lost its INSERT event: the migration refuses" \
    "is not attached to fleet_members as an enabled BEFORE INSERT OR UPDATE" "$MIG" \
    "DROP TRIGGER trg_fleet_members_protect ON public.fleet_members;
     CREATE TRIGGER trg_fleet_members_protect BEFORE UPDATE ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();"
  expect_abort "N7 the trigger only fires on some columns (UPDATE OF): the migration refuses" \
    "is not attached to fleet_members as an enabled BEFORE INSERT OR UPDATE" "$MIG" \
    "DROP TRIGGER trg_fleet_members_protect ON public.fleet_members;
     CREATE TRIGGER trg_fleet_members_protect BEFORE INSERT OR UPDATE OF fleet_id, driver_name, driver_phone, driver_email,
       driver_license_number, driver_id_number, license_doc_path, rejected_reason
       ON public.fleet_members FOR EACH ROW EXECUTE FUNCTION tg_fleet_members_protect();"
  expect_abort "N8 the trigger is disabled: the migration refuses" \
    "is not attached to fleet_members as an enabled BEFORE INSERT OR UPDATE" "$MIG" \
    "ALTER TABLE public.fleet_members DISABLE TRIGGER trg_fleet_members_protect;"

  # C. together with 00598 (links on approval and on a confirmed number), in both orders, when it is in the checkout
  M598="${M598:-$(ls "$ROOT"/supabase/migrations/00598_*.sql 2>/dev/null | head -1)}"
  if [ -z "$M598" ] || [ ! -f "$M598" ]; then
    echo "SKIP  C (00598 is not in this checkout; set M598 to run it)"
  else
    for order in "598 600" "600 598"; do
      fresh ${DB}c
      first="$MIG"; second="$M598"; [ "$order" = "598 600" ] && { first="$M598"; second="$MIG"; }
      if ! OUT=$(apply "$first" ${DB}c) || ! OUT=$(apply "$second" ${DB}c); then
        ko "C0 [$order] both migrations apply" "$(echo "$OUT" | grep -m1 ERROR)"; continue
      fi
      ok "C0 [$order] both migrations apply"
      P_MAIN="$P"; P="$BIN/psql $CONN -d ${DB}c -qAt -v ON_ERROR_STOP=1"
      LATER_ACCT="INSERT INTO auth.users (id) VALUES ('$LATER'); INSERT INTO public.users (id, role) VALUES ('$LATER', 'customer');"
      CONFIRM="UPDATE auth.users SET phone = '5355558888', phone_confirmed_at = now() WHERE id = '$LATER';"
      val "C1 [$order] the owner re-points an approved invitation at a number confirmed later: nobody is linked" \
        "$RESET $LATER_ACCT $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111')
         $(as $OWNER) UPDATE public.fleet_members SET driver_phone = '+5355558888'; $NOJWT $CONFIRM
         SELECT status || '|' || coalesce(driver_id::text, '-') || '|' || driver_phone FROM public.fleet_members;" "approved|-|+5355551111"
      val "C2 [$order] control: an approved invitation for that number is linked when it is confirmed" \
        "$RESET $LATER_ACCT $(invite $FA '+5355558888' 'pending_review') $(approve $FA '+5355558888') $CONFIRM $LINKS" "active:LATER"
      val "C3 [$order] the reviewed number's signup still links it" \
        "$RESET $(invite $FA '+5355551111' 'pending_review') $(approve $FA '+5355551111') $REWRITE $(signup $NEWU '+5355551111') $LINKS" "active:NEWU"
      P="$P_MAIN"
    done
  fi
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
