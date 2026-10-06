#!/usr/bin/env bash
# Rehearsal runner for migration 00609 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00609/run.sh none
#       -> scaffold + tests (RED: the fleet owner moves a fleet the admin reviewed to another company)
#   supabase/tests/00609/run.sh supabase/migrations/00609_driver_fleets_keep_their_company.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proofs (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# PGBIN, PGPORT and PYTHON override the binaries directory, the port and the python, e.g. on Windows:
#   PGBIN=/c/.../pgsql/bin PGPORT=5441 PYTHON=python supabase/tests/00609/run.sh <migration>
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
DB=pr609
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

ADMIN=a0000000-0000-4000-8000-000000000001     # admin
OWNER=a0000000-0000-4000-8000-000000000002     # fleet owner (a driver) with two approved companies
DRV=a0000000-0000-4000-8000-000000000003       # a driver of the owner's fleet A, active
OTHER=a0000000-0000-4000-8000-000000000004     # a driver in no fleet
STRANGER=a0000000-0000-4000-8000-000000000005  # someone else with a company of their own
CA=c0000000-0000-4000-8000-00000000000a        # Flota A: approved by the admin as a fleet, 8 % commission
CD=c0000000-0000-4000-8000-00000000000d        # Flota D: the owner's second approved fleet company
CB=c0000000-0000-4000-8000-00000000000b        # an account the owner creates during a test (comes out pending)
CT=c0000000-0000-4000-8000-0000000000ee        # another one, used as a parking spot to swap two fleets
CX=c0000000-0000-4000-8000-0000000000ff        # the stranger's company
FA=f0000000-0000-4000-8000-00000000000a; FD=f0000000-0000-4000-8000-00000000000d; FB=f0000000-0000-4000-8000-00000000000b
FN=f0000000-0000-4000-8000-0000000000aa        # a fleet id nobody has, for the owner to ask for
# auth.users keeps phones the way GoTrue does (E.164 digits, no '+'); public.users has them normalized.
PEOPLE="INSERT INTO auth.users (id, phone, phone_confirmed_at) VALUES
  ('$ADMIN', '5355550001', now()), ('$OWNER', '5355550002', now()), ('$DRV', '5355551234', now()),
  ('$OTHER', '5355550004', now()), ('$STRANGER', '5355550005', now());
INSERT INTO public.users (id, phone, role) VALUES
  ('$ADMIN', '+5355550001', 'admin'), ('$OWNER', '+5355550002', 'driver'), ('$DRV', '+5355551234', 'driver'),
  ('$OTHER', '+5355550004', 'driver'), ('$STRANGER', '+5355550005', 'customer');"
# RESET -> what the admin decided, written with no JWT so every value stays as it is: the owner's
# two approved fleet companies, each with its fleet (FA with an approved invitation and an active
# driver, FD with an approved invitation), and the stranger's company. updated_at is set in the
# past so a test can see the existing trigger refresh it.
RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by, status, is_fleet_owner, commission_percent, approved_at) VALUES
  ('$CA', 'Flota A', '+5355550002', '$OWNER', 'approved', true, 8, now()),
  ('$CD', 'Flota D', '+5355550002', '$OWNER', 'approved', true, 12, now()),
  ('$CX', 'Ajena', '+5355550005', '$STRANGER', 'approved', false, NULL, now());
INSERT INTO public.driver_fleets (id, corporate_account_id, name, city, vehicle_count_estimate, vehicle_types, operating_zones,
                                  estimated_rides_per_day_per_vehicle, operating_hours_start, operating_hours_end, notes, updated_at) VALUES
  ('$FA', '$CA', 'FA', 'La Habana', 5, '{triciclo_basico}', '{Vedado}', 10, '08:00', '20:00', 'Responsable: Ana', '2026-01-01'),
  ('$FD', '$CD', 'FD', 'Matanzas', 3, '{moto_standard}', '{Centro}', 8, '06:00', '18:00', NULL, '2026-01-01');
INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone, status) VALUES
  ('$FA', 'Juan', '+5355551111', 'approved'), ('$FD', 'Ana', '+5355552222', 'approved');
INSERT INTO public.fleet_members (fleet_id, driver_id, driver_name, driver_phone, status, signed_up_at) VALUES
  ('$FA', '$DRV', 'Pedro', '+5355551234', 'active', now());"
# as PERSON -> what follows runs the way PostgREST runs that person's call: role authenticated + JWT claims
as(){ printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\": \"%s\", \"role\": \"authenticated\"}';" "$1"; }
# NOJWT -> back to a caller with no JWT (service role, migrations, GoTrue's triggers)
NOJWT="RESET ROLE; RESET request.jwt.claims;"
# newacct ID NAME -> the owner's own INSERT of a corporate account (00434 makes it pending); run it inside as(OWNER)
newacct(){ printf "INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES ('%s', '%s', '+5355550002', '$OWNER');" "$1" "$2"; }
# move FLEET ACCOUNT -> an UPDATE of the fleet's company (PostgREST PATCH /driver_fleets?id=eq.FLEET)
move(){ printf "UPDATE public.driver_fleets SET corporate_account_id = '%s' WHERE id = '%s';" "$2" "$1"; }
# FORM_UPSERT ACCOUNT NAME -> what fleetService.submitFleetRequest sends: an upsert on corporate_account_id
# with every column of the form (PostgREST merge-duplicates sets every column it was sent)
form_upsert(){ printf "INSERT INTO public.driver_fleets (corporate_account_id, name, city, vehicle_count_estimate, vehicle_types, operating_zones,
    estimated_rides_per_day_per_vehicle, operating_hours_start, operating_hours_end, notes)
  VALUES ('%s', '%s', 'Cardenas', 7, '{moto_standard}', '{Centro}', 9, '07:00', '19:00', 'Responsable: Luis')
  ON CONFLICT (corporate_account_id) DO UPDATE SET corporate_account_id = EXCLUDED.corporate_account_id, name = EXCLUDED.name,
    city = EXCLUDED.city, vehicle_count_estimate = EXCLUDED.vehicle_count_estimate, vehicle_types = EXCLUDED.vehicle_types,
    operating_zones = EXCLUDED.operating_zones, estimated_rides_per_day_per_vehicle = EXCLUDED.estimated_rides_per_day_per_vehicle,
    operating_hours_start = EXCLUDED.operating_hours_start, operating_hours_end = EXCLUDED.operating_hours_end, notes = EXCLUDED.notes
  RETURNING (id = '$FA')::text || '|' || (corporate_account_id = '%s')::text;" "$1" "$2" "$1"; }
# FLEETS -> fleet>company for every fleet
FLEETS="SELECT string_agg(df.name || '>' || ca.name, ',' ORDER BY df.name)
  FROM public.driver_fleets df JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id;"
# MEMBERS -> driver>company for every invitation, through its fleet
MEMBERS="SELECT string_agg(fm.driver_name || '>' || ca.name, ',' ORDER BY fm.driver_name)
  FROM public.fleet_members fm JOIN public.driver_fleets df ON df.id = fm.fleet_id JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id;"
# DISPATCH -> for rides billed to Flota A: is the fleet restriction on | may DRV take them | may OTHER take them.
# The two predicates are the live ones in find_best_drivers and accept_ride_v2 (00336/00337, read 2026-10-05).
DISPATCH="WITH r AS (SELECT EXISTS (
    SELECT 1 FROM public.corporate_accounts ca WHERE ca.id = '$CA' AND ca.is_fleet_owner = true
      AND EXISTS (SELECT 1 FROM public.fleet_members fm JOIN public.driver_fleets df ON df.id = fm.fleet_id
                  WHERE df.corporate_account_id = ca.id AND fm.status = 'active' AND fm.driver_id IS NOT NULL)) AS restricted)
  SELECT r.restricted::text || '|' || string_agg((NOT r.restricted OR EXISTS (
      SELECT 1 FROM public.fleet_members fm JOIN public.driver_fleets df ON df.id = fm.fleet_id
      WHERE df.corporate_account_id = '$CA' AND fm.driver_id = d.id AND fm.status = 'active'))::text, '|' ORDER BY d.ord)
  FROM r, (VALUES ('$DRV'::uuid, 1), ('$OTHER'::uuid, 2)) d(id, ord) GROUP BY r.restricted;"
# FINGERPRINT -> every row the self-test must leave alone
FINGERPRINT="SELECT md5(coalesce((SELECT string_agg(fm::text, ',' ORDER BY fm.id) FROM public.fleet_members fm), '')
  || coalesce((SELECT string_agg(df::text, ',' ORDER BY df.id) FROM public.driver_fleets df), '')
  || coalesce((SELECT string_agg(ca::text, ',' ORDER BY ca.id) FROM public.corporate_accounts ca), '')
  || coalesce((SELECT string_agg(u::text, ',' ORDER BY u.id) FROM public.users u), '')
  || coalesce((SELECT string_agg(au::text, ',' ORDER BY au.id) FROM auth.users au), ''))"
# POLICIES -> driver_fleets' RLS policies, which the migration must not touch
POLICIES="SELECT md5(string_agg(policyname || ':' || cmd || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ',' ORDER BY policyname))
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'driver_fleets'"
# Bodies read from prod on 2026-10-05: signature|md5(prosrc)|length. The scaffold must carry them.
LIVE="public.tg_fleet_members_protect()|2b65b4b84e3a2ce323197501e5742c1a|1405
public.trg_driver_fleets_updated_at()|301a884953d37769916294bb60562e05|52
public.tg_corporate_accounts_protect_insert()|16d3e41267fd99172c562f62e4e968fd|455
public.is_admin()|22cb75e91980d512498034cd33e1eda2|285
public.current_user_role()|cb4a7c12d4e21fe2997135833f141e25|103
auth.uid()|cdef18c69c4f4cbbced2eaf81e628b49|176"
# bodies PREFIX -> every LIVE body is still the prod one
bodies(){ while IFS='|' read -r sig md5 len; do
  val "$1 $sig is the prod body" "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = '$sig'::regprocedure" "$md5/$len"
done <<< "$LIVE"; }

echo "== reset database =="
fresh $DB || { echo "scaffold or seed failed (is the cluster up on port ${PGPORT:-5433}?)"; exit 1; }
bodies S
POL_BEFORE=$($P -c "$POLICIES" | tr -d '\r')

if [ "$MIG" != "none" ]; then
  # State before the migration: fleets and invitations the self-test must leave exactly as they are.
  $P -c "$RESET" >/dev/null || exit 1
  BEFORE=$($P -c "$FINGERPRINT" | tr -d '\r')
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as postgres, search_path = '') =="
  if ! OUT=$(apply "$MIG"); then echo "migration failed:"; echo "$OUT" | grep -m3 ERROR; exit 1; fi
  echo "== apply migration (2nd, idempotency, autocommit, as postgres, search_path = '') =="
  if ! OUT2=$(apply "$MIG" "$DB" autocommit); then echo "migration NOT idempotent:"; echo "$OUT2" | grep -m3 ERROR; exit 1; fi
  val "M1 the self-test leaves every row exactly as it was" "$FINGERPRINT" "$BEFORE"
  if echo "$OUT" | grep -q "00609: verified, the owner cannot move a fleet to another company"; then
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
# A. the reported case: a fleet stays with the company it was created for, whatever the owner sends
val "A1 the owner moves a reviewed fleet to a new account of theirs: the fleet and its drivers stay with Flota A" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa') $(move $FA $CB) $NOJWT $FLEETS $MEMBERS
   SELECT name || ':' || status FROM public.corporate_accounts WHERE id = '$CB';" \
  "FA>Flota A,FD>Flota D;Ana>Flota D,Juan>Flota A,Pedro>Flota A;Otra empresa:pending"
val "A2 swapping two reviewed fleets through a third account leaves each where it was" \
  "$RESET $(as $OWNER) $(newacct $CT 'Temporal') $(move $FA $CT) $(move $FD $CA) $(move $FA $CD) $NOJWT $FLEETS" \
  "FA>Flota A,FD>Flota D"
val "A3 an upsert on the fleet id cannot change its company either; its other values go through" \
  "$RESET $(as $OWNER) $(newacct $CT 'Temporal')
   INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CT', 'FA renombrada')
     ON CONFLICT (id) DO UPDATE SET corporate_account_id = EXCLUDED.corporate_account_id, name = EXCLUDED.name; $NOJWT $FLEETS" \
  "FA renombrada>Flota A,FD>Flota D"
val "A4 a fleet nobody reviewed yet stays too: a fleet belongs to the account it was created for" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa')
   INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FB', '$CB', 'FB');
   INSERT INTO public.fleet_members (fleet_id, driver_name, driver_phone) VALUES ('$FB', 'Luis', '+5355553333');
   $(newacct $CT 'Temporal') $(move $FB $CT) $NOJWT $FLEETS
   SELECT fm.status || '>' || ca.name FROM public.fleet_members fm JOIN public.driver_fleets df ON df.id = fm.fleet_id
     JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id WHERE fm.driver_name = 'Luis';" \
  "FA>Flota A,FB>Otra empresa,FD>Flota D;pending_review>Otra empresa"
val "A5 the company sent along with new details: the details change, the company stays" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa')
   UPDATE public.driver_fleets SET corporate_account_id = '$CB', name = 'FA nueva', city = 'Cardenas' WHERE id = '$FA'; $NOJWT
   SELECT df.name || '|' || df.city || '|' || ca.name FROM public.driver_fleets df
     JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id WHERE df.id = '$FA';" \
  "FA nueva|Cardenas|Flota A"
val "A6 after the attempt, rides billed to Flota A still go only to its active drivers (find_best_drivers / accept_ride_v2)" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa') $(move $FA $CB) $NOJWT $DISPATCH" \
  "true|true|false"
val "A7 to someone else's company: RLS refused it before; now the update succeeds and the fleet stays" \
  "$RESET $(as $OWNER) $(move $FD $CX) $NOJWT $FLEETS" \
  "FA>Flota A,FD>Flota D"
# The drivers point at a fleet id, so a fleet whose company is frozen can still lose them: one
# statement gives FA a new id and lets an empty fleet of another company take FA's old one. The
# foreign key is ON UPDATE NO ACTION, which accepts a changed key when another row holds it again
# by the end of the statement.
val "A8 one UPDATE that rotates fleet ids cannot hand Flota A's drivers to another company" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa')
   INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FB', '$CB', 'vacia');
   UPDATE public.driver_fleets SET id = CASE id WHEN '$FA' THEN '$FN'::uuid WHEN '$FB' THEN '$FA'::uuid END
    WHERE id IN ('$FA', '$FB'); $NOJWT $MEMBERS $FLEETS" \
  "Ana>Flota D,Juan>Flota A,Pedro>Flota A;FA>Flota A,FD>Flota D,vacia>Otra empresa"
val "A9 nor can the same rotation sent as PostgREST's bulk upsert (on_conflict=corporate_account_id)" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa')
   INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FB', '$CB', 'vacia');
   INSERT INTO public.driver_fleets (corporate_account_id, id, name)
   SELECT r.corporate_account_id, r.id, r.name FROM json_to_recordset('[
       {\"corporate_account_id\": \"$CA\", \"id\": \"$FN\", \"name\": \"FA\"},
       {\"corporate_account_id\": \"$CB\", \"id\": \"$FA\", \"name\": \"vacia\"}]') AS r(corporate_account_id uuid, id uuid, name text)
   ON CONFLICT (corporate_account_id) DO UPDATE SET corporate_account_id = EXCLUDED.corporate_account_id, id = EXCLUDED.id, name = EXCLUDED.name;
   $NOJWT $MEMBERS $FLEETS" \
  "Ana>Flota D,Juan>Flota A,Pedro>Flota A;FA>Flota A,FD>Flota D,vacia>Otra empresa"
val "A10 the owner cannot change a fleet's id at all, not even an empty one's" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa')
   INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FB', '$CB', 'vacia');
   UPDATE public.driver_fleets SET id = '$FN' WHERE id = '$FB'; $NOJWT
   SELECT id FROM public.driver_fleets WHERE name = 'vacia';" \
  "$FB"

# B. what must keep working
val "B1 the owner edits every descriptive field of an approved fleet" \
  "$RESET $(as $OWNER) UPDATE public.driver_fleets SET name = 'FA 2', city = 'Cardenas', vehicle_count_estimate = 9,
     vehicle_types = '{auto_standard,moto_standard}', operating_zones = '{Playa,Miramar}', estimated_rides_per_day_per_vehicle = 12,
     operating_hours_start = '07:30', operating_hours_end = '22:00', notes = 'Responsable: Luis' WHERE id = '$FA'; $NOJWT
   SELECT concat_ws('|', name, city, vehicle_count_estimate, array_to_string(vehicle_types, ','), array_to_string(operating_zones, ','),
     estimated_rides_per_day_per_vehicle, operating_hours_start, operating_hours_end, notes) FROM public.driver_fleets WHERE id = '$FA';" \
  "FA 2|Cardenas|9|auto_standard,moto_standard|Playa,Miramar|12|07:30:00|22:00:00|Responsable: Luis"
val "B2 the form's retry (submitFleetRequest's upsert on corporate_account_id) updates the same fleet in place" \
  "$RESET $(as $OWNER) $(form_upsert $CA 'FA v2') $NOJWT
   SELECT concat_ws('|', df.name, df.city, df.vehicle_count_estimate, ca.name) FROM public.driver_fleets df
     JOIN public.corporate_accounts ca ON ca.id = df.corporate_account_id WHERE df.id = '$FA';
   SELECT count(*) FROM public.driver_fleets;" \
  "true|true;FA v2|Cardenas|7|Flota A;2"
val "B3 the form's first attempt (the same upsert on a new account) creates its fleet" \
  "$RESET $(as $OWNER) $(newacct $CB 'Otra empresa') $(form_upsert $CB 'FB') $NOJWT $FLEETS" \
  "false|true;FA>Flota A,FB>Otra empresa,FD>Flota D"
val "B4 the admin moves a fleet to another company" \
  "$RESET $(as $ADMIN) $(move $FA $CX) $NOJWT $FLEETS" "FA>Ajena,FD>Flota D"
val "B5 a write with no JWT (service role, a migration) moves it" \
  "$RESET $(move $FA $CX) $FLEETS" "FA>Ajena,FD>Flota D"
val "B6 a trusted writer (app.trusted_fleet_update) moves it" \
  "$RESET $(as $OWNER) $(newacct $CT 'Temporal') SET app.trusted_fleet_update = '1'; $(move $FA $CT) RESET app.trusted_fleet_update; $NOJWT $FLEETS" \
  "FA>Temporal,FD>Flota D"
val "B7 an owner update that sends the same company raises nothing and changes nothing" \
  "$RESET $(as $OWNER) UPDATE public.driver_fleets SET corporate_account_id = corporate_account_id WHERE id = '$FA'; $NOJWT $FLEETS" \
  "FA>Flota A,FD>Flota D"
val "B8 updated_at is still refreshed on the owner's edits" \
  "$RESET $(as $OWNER) UPDATE public.driver_fleets SET name = 'FA 2' WHERE id = '$FA'; $NOJWT
   SELECT (updated_at > '2026-01-02')::text FROM public.driver_fleets WHERE id = '$FA';" "true"
val "B9 a stranger still cannot touch the owner's fleet" \
  "$RESET $(as $STRANGER) UPDATE public.driver_fleets SET corporate_account_id = '$CX', name = 'robada' WHERE id = '$FA'; $NOJWT $FLEETS" \
  "FA>Flota A,FD>Flota D"

# D. contract: the trigger and its function, nothing else on driver_fleets touched
val "D1 the trigger: BEFORE UPDATE, every column, per row" \
  "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.driver_fleets'::regclass AND tgname = 'trg_driver_fleets_protect'" \
  "CREATE TRIGGER trg_driver_fleets_protect BEFORE UPDATE ON public.driver_fleets FOR EACH ROW EXECUTE FUNCTION tg_driver_fleets_protect()"
val "D2 the function: no arguments, SECURITY DEFINER, pinned search_path, owned by postgres" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) || '|' || prosecdef || '|' || array_to_string(proconfig, ',') || '|' || pg_get_userbyid(proowner)
   FROM pg_proc WHERE oid = to_regprocedure('public.tg_driver_fleets_protect()')" "|trigger|true|search_path=public, pg_catalog|postgres"
val "D3 only postgres and the service role may execute it (like the newest trigger functions)" \
  "SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.tg_driver_fleets_protect()')" \
  "{postgres=X/postgres,service_role=X/postgres}"
val "D4 driver_fleets has the updated_at trigger and the new one, enabled" \
  "SELECT string_agg(tgname || ':' || tgenabled::text, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.driver_fleets'::regclass AND NOT tgisinternal" \
  "driver_fleets_updated_at:O,trg_driver_fleets_protect:O"
val "D5 driver_fleets' RLS policies are untouched" "$POLICIES" "$POL_BEFORE"
bodies "D6 unchanged:"

if [ "$MIG" != "none" ]; then
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
  negative "N1 the company is no longer kept: the self-test aborts the migration" \
    "  NEW.corporate_account_id := OLD.corporate_account_id;
" "" "the owner moved a fleet to another company"
  negative "N7 the id is no longer kept: the self-test aborts the migration" \
    "  NEW.id := OLD.id;
" "" "the owner changed a fleet's id"
  negative "N2 the descriptive fields are frozen too: the self-test aborts the migration" \
    "  NEW.corporate_account_id := OLD.corporate_account_id;
" "  NEW.corporate_account_id := OLD.corporate_account_id;
  NEW.name := OLD.name;
" "the owner could not edit the fleet's details"
  negative "N3 the trigger only fires when the company is sent (UPDATE OF): the migration refuses" \
    "BEFORE UPDATE ON public.driver_fleets" "BEFORE UPDATE OF corporate_account_id ON public.driver_fleets" \
    "is not attached to driver_fleets as an enabled BEFORE UPDATE"
  negative "N4 the trigger is left disabled: the migration refuses" \
    "  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_fleets_protect();
" "  FOR EACH ROW EXECUTE FUNCTION public.tg_driver_fleets_protect();
ALTER TABLE public.driver_fleets DISABLE TRIGGER trg_driver_fleets_protect;
" "is not attached to driver_fleets as an enabled BEFORE UPDATE"
  expect_abort "N5 someone already wrote a tg_driver_fleets_protect() with another body: the migration refuses to replace it" \
    "already exists with a body this migration does not know" "$MIG" \
    "CREATE FUNCTION public.tg_driver_fleets_protect() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END; \$f\$;"
  expect_abort "N6 a trigger trg_driver_fleets_protect already runs another function: the migration refuses to replace it" \
    "already runs another function" "$MIG" \
    "CREATE FUNCTION public.someone_elses_check() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END; \$f\$;
     CREATE TRIGGER trg_driver_fleets_protect BEFORE UPDATE ON public.driver_fleets FOR EACH ROW EXECUTE FUNCTION public.someone_elses_check();"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
