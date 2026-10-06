#!/usr/bin/env bash
# Rehearsal for the fleet invitation review race (no migration; local Postgres 16, no Supabase stack).
#   supabase/tests/fleet-review/run.sh
# Against the live fleet_members RLS policies and protect trigger (00600) it shows that:
#  A. the owner may still edit an invitation while it is pending_review, so an
#     approve that filters on the id alone (fleetService.approveMember before
#     this change) approves a phone the admin never saw, also when the owner's
#     edit commits while the approve waits on the row lock;
#  B. the approve and reject the service sends now (the status the buttons were
#     shown for plus every reviewed column in the WHERE, a NULL one with IS NULL)
#     update 0 rows in those cases and 1 row when nothing the admin saw changed;
#  C. that holds under concurrency: READ COMMITTED (prod's default) re-checks
#     the WHERE on the row version the owner committed. And when the approve
#     commits first, 00600 keeps the owner's waiting edit off the reviewed
#     columns, so the invitation stays as approved on both sides of the review.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# PG_BIN and PG_PORT override the binaries directory and the port, e.g. on Windows:
#   PG_BIN=/c/.../pgsql/bin PG_PORT=5435 supabase/tests/fleet-review/run.sh
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PG_PORT:-5433} -U pgtest"
DB=fleetreview
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends lines with \r\n, hence the tr)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# wait_for SQL -> poll for up to 10 s until SQL prints t
wait_for(){ local _; for _ in $(seq 1 100); do [ "$($P -c "$1" 2>/dev/null | tr -d '\r')" = "t" ] && return 0; sleep 0.1; done; return 1; }

OWNER=a0000000-0000-4000-8000-000000000001          # the fleet owner (a driver)
ADMIN=a0000000-0000-4000-8000-000000000002          # the admin reviewing the fleet
CA=c0000000-0000-4000-8000-00000000000a
CB=c0000000-0000-4000-8000-00000000000b
FA=f0000000-0000-4000-8000-00000000000a             # the fleet under review
FB=f0000000-0000-4000-8000-00000000000b             # another fleet of the same owner
M=d0000000-0000-4000-8000-000000000001              # the invitation
X='+5355551234'                                     # the phone the admin sees
Y='+5359999999'                                     # the phone the owner types afterwards
DOC="fleet-docs/$CA/$M/licencia.jpg"
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

RESET="TRUNCATE public.fleet_members, public.driver_fleets, public.corporate_accounts;
INSERT INTO public.corporate_accounts (id, name, contact_phone, created_by) VALUES
  ('$CA', 'Flota A', '+5355550010', '$OWNER'),
  ('$CB', 'Flota B', '+5355550011', '$OWNER');
INSERT INTO public.driver_fleets (id, corporate_account_id, name) VALUES ('$FA', '$CA', 'Flota A'), ('$FB', '$CB', 'Flota B');"
# as UID SQL -> SQL run the way PostgREST runs a request: role authenticated with the user's JWT subject
as(){ printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s RESET ROLE; RESET request.jwt.claim.sub;" "$1" "$2"; }
# The invitation as the owner sends it (the protect trigger forces pending_review).
INVITE="INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone) VALUES ('$M', '$FA', 'Juan Pérez', '$X');"
INVITE_FULL="INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, driver_email, driver_license_number, driver_id_number, license_doc_path)
  VALUES ('$M', '$FA', 'Juan Pérez', '$X', 'juan@correo.cu', 'B1234567', '85010112345', '$DOC');"
OWNER_EDIT="UPDATE public.fleet_members SET driver_phone = '$Y' WHERE id = '$M';"
STATE="SELECT status || '|' || driver_phone || '|' || coalesce(reviewed_by::text, '-') FROM public.fleet_members WHERE id = '$M';"

# The approve fleetService.approveMember sent before this change: the id alone.
APPROVE_BY_ID="WITH u AS (UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '$ADMIN'
  WHERE id = '$M' RETURNING id) SELECT count(*) FROM u;"
# What it sends now for the row as the admin saw it (the columns of FLEET_MEMBER_REVIEWED_FIELDS).
SHOWN="id = '$M' AND status = 'pending_review' AND fleet_id = '$FA' AND driver_name = 'Juan Pérez' AND driver_phone = '$X'
  AND driver_email IS NULL AND driver_license_number IS NULL AND driver_id_number IS NULL AND license_doc_path IS NULL"
SHOWN_FULL="id = '$M' AND status = 'pending_review' AND fleet_id = '$FA' AND driver_name = 'Juan Pérez' AND driver_phone = '$X'
  AND driver_email = 'juan@correo.cu' AND driver_license_number = 'B1234567' AND driver_id_number = '85010112345' AND license_doc_path = '$DOC'"
approve(){ printf "WITH u AS (UPDATE public.fleet_members SET status = 'approved', reviewed_at = now(), reviewed_by = '%s' WHERE %s RETURNING id) SELECT count(*) FROM u;" "$ADMIN" "$1"; }
reject(){ printf "WITH u AS (UPDATE public.fleet_members SET status = 'rejected', reviewed_at = now(), reviewed_by = '%s', rejected_reason = 'Licencia vencida' WHERE %s RETURNING id) SELECT count(*) FROM u;" "$ADMIN" "$1"; }

# race FIRST SECOND_SQL -> FIRST ('owner' edits the phone, or 'admin' approves the shown row) runs in a
# transaction that holds the row lock while SECOND_SQL starts as the other party. Prints
# waited|<SECOND_SQL output>|<row state>, where waited says SECOND_SQL was seen blocked on that lock
# while FIRST was still inside its transaction.
race(){
  local first="$1" second_sql="$2" first_uid first_sql second second_uid
  if [ "$first" = owner ]; then
    first_uid=$OWNER; first_sql="$OWNER_EDIT"; second=admin; second_uid=$ADMIN
  else
    first_uid=$ADMIN; first_sql="$(approve "$SHOWN")"; second=owner; second_uid=$OWNER
  fi
  $P -c "$RESET $(as $OWNER "$INVITE")" >/dev/null || return 1
  PGAPPNAME=$first $P -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$first_uid';
    $first_sql SELECT pg_sleep(4); COMMIT;" > "$TMPD/first.out" 2>&1 &
  local first_pid=$!
  wait_for "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$first' AND wait_event = 'PgSleep')"
  PGAPPNAME=$second $P -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '$second_uid';
    $second_sql COMMIT;" > "$TMPD/second.out" 2>&1 &
  local second_pid=$! waited=no
  if wait_for "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$second' AND wait_event_type = 'Lock')
               AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$first' AND wait_event = 'PgSleep')"; then
    waited=yes
  fi
  wait "$first_pid" "$second_pid"
  echo "$waited|$(tr -d '\r' < "$TMPD/second.out" | paste -sd' ' -)|$($P -c "$STATE" | tr -d '\r')"
}
# vrace NAME FIRST SECOND_SQL EXPECTED
vrace(){ local r; r=$(race "$2" "$3"); if [ "$r" = "$4" ]; then ok "$1"; else ko "$1" "expected [$4], got [$r]"; fi; }

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 \
  || { echo "cannot reset $DB: is the pgtest cluster up on port ${PG_PORT:-5433}?"; exit 1; }
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
md5of(){ printf "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = '%s'::regprocedure" "$1"; }
val "S0 the scaffold carries the live fleet_members protect trigger, 00600 (md5 of prosrc)" \
  "$(md5of 'public.tg_fleet_members_protect()')" "2b65b4b84e3a2ce323197501e5742c1a/1405"
val "S1 the scaffold carries the live is_admin() (md5 of prosrc)" \
  "$(md5of 'public.is_admin()')" "22cb75e91980d512498034cd33e1eda2/285"
val "S2 the scaffold carries the live current_user_role() (md5 of prosrc)" \
  "$(md5of 'public.current_user_role()')" "cb4a7c12d4e21fe2997135833f141e25/103"
val "S3 the scaffold carries the live corporate_accounts insert protect trigger (md5 of prosrc)" \
  "$(md5of 'public.tg_corporate_accounts_protect_insert()')" "16d3e41267fd99172c562f62e4e968fd/455"
val "S4 the owner's invitation lands pending_review whatever status it asks for (live protect trigger)" \
  "$RESET $(as $OWNER "INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, status) VALUES ('$M', '$FA', 'Juan Pérez', '$X', 'approved');") $STATE" \
  "pending_review|$X|-"
# Every policy of the three fleet tables, as prod deparses it (pg_policies on 2026-09-27, after 00600).
POLICIES="SELECT tablename || '.' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
  || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies
  WHERE schemaname = 'public' AND tablename IN ('fleet_members', 'driver_fleets', 'corporate_accounts') ORDER BY 1"
val "S5 the scaffold carries the live policies of the three fleet tables (md5 of USING|WITH CHECK)" "$POLICIES" \
  "corporate_accounts.corporate_accounts_admin_read SELECT authenticated b573f6a5aec4a0bb12543a8cd6395f09;corporate_accounts.corporate_accounts_admin_update UPDATE authenticated b573f6a5aec4a0bb12543a8cd6395f09;corporate_accounts.corporate_accounts_corp_admin_update UPDATE authenticated 258a22e7dd47680387b3fa87d0c68460;corporate_accounts.corporate_accounts_creator_read SELECT authenticated 4bf77061fb2835233a959d8ac01d2b83;corporate_accounts.corporate_accounts_employee_read SELECT authenticated 4289d24b97bd0f806a79fe8c497b3dff;corporate_accounts.corporate_accounts_insert INSERT authenticated bca855a3b2b850161dccad59f6144fd5;driver_fleets.driver_fleets_admin_delete DELETE public 4ca46077787eba5fc57ee1de8f83e663;driver_fleets.driver_fleets_owner_insert INSERT public 1671d6707f4d115bcf405418cbb2b6c5;driver_fleets.driver_fleets_owner_select SELECT public f1b99fb8643ae61c5dab9eb65a347a32;driver_fleets.driver_fleets_owner_update UPDATE public f1b99fb8643ae61c5dab9eb65a347a32;fleet_members.fleet_members_owner_delete DELETE public c74dcb3d63747d4e156cc4a57cb40fe7;fleet_members.fleet_members_owner_insert INSERT public 119d8d82e373001f7ed084fa9cd4d4b1;fleet_members.fleet_members_owner_or_admin_update UPDATE public c74dcb3d63747d4e156cc4a57cb40fe7;fleet_members.fleet_members_owner_or_self_select SELECT public ee6edfc3dddcb4b77b20ce2b29b9fcf5"

echo "== A. the race =="
val "A1 the owner may edit an invitation that is still pending_review" \
  "$RESET $(as $OWNER "$INVITE $OWNER_EDIT") $STATE" "pending_review|$Y|-"
val "A2 the owner may move it to another of their fleets (fleet_id is reviewed identity too)" \
  "$RESET $(as $OWNER "$INVITE UPDATE public.fleet_members SET fleet_id = '$FB' WHERE id = '$M';")
   SELECT (fleet_id = '$FB')::text FROM public.fleet_members WHERE id = '$M';" "true"
val "A3 BUG: the id-only approve, sent after the admin saw $X, approves the $Y the owner typed" \
  "$RESET $(as $OWNER "$INVITE") $(as $OWNER "$OWNER_EDIT") $(as $ADMIN "$APPROVE_BY_ID") $STATE" "1;approved|$Y|$ADMIN"

echo "== B. the approve bound to the row the admin saw =="
val "B1 nothing the admin saw changed: approved" \
  "$RESET $(as $OWNER "$INVITE") $(as $ADMIN "$(approve "$SHOWN")") $STATE" "1;approved|$X|$ADMIN"
val "B2 the owner changed the phone: 0 rows, the invitation stays pending_review" \
  "$RESET $(as $OWNER "$INVITE") $(as $OWNER "$OWNER_EDIT") $(as $ADMIN "$(approve "$SHOWN")") $STATE" "0;pending_review|$Y|-"
for edit in "driver_name = 'Juan Pérez Díaz'" "driver_email = 'juan@correo.cu'" "driver_license_number = 'B1234567'" \
            "driver_id_number = '85010112345'" "license_doc_path = '$DOC'" "fleet_id = '$FB'"; do
  val "B3 the owner set ${edit%% *} after the admin saw it empty or different: 0 rows" \
    "$RESET $(as $OWNER "$INVITE UPDATE public.fleet_members SET $edit WHERE id = '$M';") $(as $ADMIN "$(approve "$SHOWN")") $STATE" \
    "0;pending_review|$X|-"
done
val "B4 every column filled and unchanged: approved" \
  "$RESET $(as $OWNER "$INVITE_FULL") $(as $ADMIN "$(approve "$SHOWN_FULL")") $STATE" "1;approved|$X|$ADMIN"
for col in driver_email driver_license_number driver_id_number license_doc_path; do
  val "B5 the owner cleared $col after the admin saw it filled: 0 rows" \
    "$RESET $(as $OWNER "$INVITE_FULL UPDATE public.fleet_members SET $col = NULL WHERE id = '$M';") $(as $ADMIN "$(approve "$SHOWN_FULL")") $STATE" \
    "0;pending_review|$X|-"
done
val "B6 another admin rejected it meanwhile: 0 rows, the rejection stands" \
  "$RESET $(as $OWNER "$INVITE") $(as $ADMIN "$(reject "$SHOWN")") $(as $ADMIN "$(approve "$SHOWN")") $STATE" "1;0;rejected|$X|$ADMIN"
val "B7 the owner deleted it: 0 rows" \
  "$RESET $(as $OWNER "$INVITE") $(as $OWNER "DELETE FROM public.fleet_members WHERE id = '$M';") $(as $ADMIN "$(approve "$SHOWN")")" "0"
val "B8 reject binds the same way: 0 rows on a changed phone, 1 row on the row as shown" \
  "$RESET $(as $OWNER "$INVITE") $(as $OWNER "$OWNER_EDIT") $(as $ADMIN "$(reject "$SHOWN")")
   $(as $OWNER "UPDATE public.fleet_members SET driver_phone = '$X' WHERE id = '$M';") $(as $ADMIN "$(reject "$SHOWN")")
   SELECT status || '|' || rejected_reason FROM public.fleet_members WHERE id = '$M';" "0;1;rejected|Licencia vencida"
val "B9 why NULLs go through is(): an unchanged NULL compared with = 'null' (what eq(col, null) sends) never matches" \
  "$RESET $(as $OWNER "$INVITE") $(as $ADMIN "$(approve "${SHOWN/driver_email IS NULL/driver_email = 'null'}")") $STATE" "0;pending_review|$X|-"

echo "== C. concurrency: the owner's edit commits while the approve waits on the row lock =="
vrace "C1 BUG: the id-only approve waits, then approves the owner's $Y" owner "$APPROVE_BY_ID" "yes|1|approved|$Y|$ADMIN"
vrace "C2 the bound approve waits, re-checks its WHERE on the owner's committed row and updates 0 rows" owner \
  "$(approve "$SHOWN")" "yes|0|pending_review|$Y|-"
vrace "C3 the bound reject does the same" owner "$(reject "$SHOWN")" "yes|0|pending_review|$Y|-"
# The other order is 00600's job, not this change's: its trigger reverts the reviewed columns for the owner.
vrace "C4 approve first: the owner's edit waits, hits the approved row, and 00600 keeps the approved $X" admin \
  "WITH u AS (UPDATE public.fleet_members SET driver_phone = '$Y' WHERE id = '$M' RETURNING id) SELECT count(*) FROM u;" \
  "yes|1|approved|$X|$ADMIN"

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
