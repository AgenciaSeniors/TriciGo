#!/usr/bin/env bash
# Rehearsal runner for migration 00672 (operator role, delivery 2: driver onboarding and fleets).
# Builds the onboarding triggers 00672 patches as they are in prod (live-bodies.sql, byte for byte)
# on the tables of tables.sql, the role checks of base.sql and the 00671 helpers (scaffold.sql).
#   supabase/tests/00672/run.sh none
#       -> prod as captured + tests (RED: the six ops functions do not exist)
#   supabase/tests/00672/run.sh supabase/migrations/00672_operator_driver_onboarding.sql
#       -> the same + 00672 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed no other function, a CRLF copy applied to a fresh database, and negative proofs
#          of the file's own checks
# The fleet invitation linking trigger (00598), the audit, e-mail and contract triggers and the RLS
# are not here: the prod rehearsal runs with all of them.
# Cluster: any Postgres 16 with a superuser. Default: psql on 127.0.0.1:${PGPORT:-5433} as pgtest.
#   PSQL="docker exec -i <container> psql -U pgtest" supabase/tests/00672/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
PSQL="${PSQL:-psql -h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest}"
DB=pr672
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ echo "$2" | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3] in [$r]"; fi; }
apply(){ local out; if out=$({ echo "$AS_OWNER"; cat "$2"; } | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f - 2>&1); then echo applied;
         else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
mkdb(){
  echo "DROP DATABASE IF EXISTS $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1
  echo "CREATE DATABASE $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1 || { echo "cannot create $1"; exit 1; }
  if ! cat "$DIR/scaffold.sql" "$DIR/tables.sql" "$DIR/base.sql" "$DIR/live-bodies.sql" "$DIR/wiring.sql" \
       | $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
}

OP=a6720000-0000-4000-8000-000000000001      # operator, with a driver profile of their own (DPOP)
ADM=a6720000-0000-4000-8000-000000000002     # admin, with a driver profile (DPADM)
MKT=a6720000-0000-4000-8000-000000000003     # marketing
CUS=a6720000-0000-4000-8000-000000000004     # applicant in review, with a vehicle (DP1)
CUS2=a6720000-0000-4000-8000-000000000005    # applicant in review, no vehicle (DP2)
DRV=a6720000-0000-4000-8000-000000000006     # approved driver, approval pushes off (DP3)
OWN=a6720000-0000-4000-8000-000000000007     # fleet owner (CA1)
DP1=d6720000-0000-4000-8000-000000000001
DP2=d6720000-0000-4000-8000-000000000002
DP3=d6720000-0000-4000-8000-000000000003
DPOP=d6720000-0000-4000-8000-000000000004
DPADM=d6720000-0000-4000-8000-000000000005
DOC1=e6720000-0000-4000-8000-000000000001    # DP1's carnet
DOCOP=e6720000-0000-4000-8000-000000000002   # the operator's own carnet
CA1=c6720000-0000-4000-8000-000000000001     # fleet request, pending
CA2=c6720000-0000-4000-8000-000000000002     # corporate client, pending, no fleet
CAOP=c6720000-0000-4000-8000-000000000003    # fleet request of the operator
DF1=b6720000-0000-4000-8000-000000000001
DF2=b6720000-0000-4000-8000-000000000002
FM1=f6720000-0000-4000-8000-000000000001     # invitation in CA1's fleet, pending review
FMOP=f6720000-0000-4000-8000-000000000002    # invitation in the operator's fleet
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
as_anon(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon;"; }
tx(){ echo "BEGIN; $1 ROLLBACK;"; }
call(){ echo "$(as_user $1) SELECT $2; RESET ROLE;"; }

SEED="
INSERT INTO public.users (id, role, is_active) VALUES
  ('$OP', 'operator', true), ('$ADM', 'admin', true), ('$MKT', 'marketing', true), ('$CUS', 'customer', true),
  ('$CUS2', 'customer', true), ('$DRV', 'driver', true), ('$OWN', 'customer', true);
INSERT INTO public.driver_profiles (id, user_id, status, is_online) VALUES
  ('$DP1', '$CUS', 'under_review', false), ('$DP2', '$CUS2', 'under_review', false),
  ('$DP3', '$DRV', 'approved', true), ('$DPOP', '$OP', 'under_review', false), ('$DPADM', '$ADM', 'under_review', false);
INSERT INTO public.vehicles (driver_id, is_active) VALUES ('$DP1', true), ('$DP3', true), ('$DPOP', true), ('$DPADM', true);
INSERT INTO public.notification_preferences (user_id, driver_approval) VALUES ('$DRV', false);
INSERT INTO public.driver_documents (id, driver_id, document_type, storage_path, file_name, mime_type) VALUES
  ('$DOC1', '$DP1', 'national_id', 'driver-docs/$DP1/national_id/a.jpg', 'a.jpg', 'image/jpeg'),
  ('$DOCOP', '$DPOP', 'national_id', 'driver-docs/$DPOP/national_id/b.jpg', 'b.jpg', 'image/jpeg');
INSERT INTO public.corporate_accounts (id, status, created_by, is_fleet_owner) VALUES
  ('$CA1', 'pending', '$OWN', false), ('$CA2', 'pending', '$OWN', false), ('$CAOP', 'pending', '$OP', false);
INSERT INTO public.driver_fleets (id, corporate_account_id) VALUES ('$DF1', '$CA1'), ('$DF2', '$CAOP');
INSERT INTO public.fleet_members (id, fleet_id, driver_name, driver_phone, driver_license_number, status) VALUES
  ('$FM1', '$DF1', 'Ana', '+5355512345', 'L-1', 'pending_review'),
  ('$FMOP', '$DF2', 'Beto', '+5355512346', 'L-2', 'pending_review');"
SHOWN_FM1="'{\"fleet_id\": \"$DF1\", \"driver_name\": \"Ana\", \"driver_phone\": \"+5355512345\", \"driver_email\": null, \"driver_license_number\": \"L-1\", \"driver_id_number\": null, \"license_doc_path\": null}'::jsonb"

PATCHED_LIST="'tg_driver_profiles_protect_admin_fields','tg_users_protect_admin_fields','tg_driver_documents_protect_review',
  'tg_corporate_accounts_protect_admin_fields','tg_fleet_members_protect'"
CREATED_LIST="'_ops_user_push','_ops_target_refusal','ops_set_driver_status','ops_review_driver_document',
  'ops_add_driver_document','ops_log_driver_outreach','ops_review_fleet_account','ops_review_fleet_member'"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED_LIST, $CREATED_LIST)"
# md5 of prosrc in prod on 2026-11-02, and after 00672.
OLD_BODIES="tg_corporate_accounts_protect_admin_fields=f84d5d8db97c7d07dbc46061ce5e5055,tg_driver_documents_protect_review=1fa394a57d0c9f63ae4f80c77e443f82,tg_driver_profiles_protect_admin_fields=ccded3e1847c164327dd049c9391ffde,tg_fleet_members_protect=2b65b4b84e3a2ce323197501e5742c1a,tg_users_protect_admin_fields=3bba8e032479c93da3a2720cd7263049"
NEW_BODIES="_ops_target_refusal=55a2f2930bbe799fe9617521330e5979,_ops_user_push=73fd48ad4447f90a308e463ee03617ad,ops_add_driver_document=ce59a4701154f09420e3b876b7af45b1,ops_log_driver_outreach=354fd82dddd10912a36098fe46bad08e,ops_review_driver_document=acda0cbfa7b5350f4e765adb5ed2f86a,ops_review_fleet_account=57913ebd47abeea8baef0cc252a29a58,ops_review_fleet_member=49898a2b2a042f4dc37de28d89119b13,ops_set_driver_status=a27519ab241af329cf374c9921e6479c,tg_corporate_accounts_protect_admin_fields=a8263f1d55d0af6ade45d972b21e6800,tg_driver_documents_protect_review=3015acfbce7f98ede86d918fe0aa4a7e,tg_driver_profiles_protect_admin_fields=eb950c28105cc3066e433bebcca03322,tg_fleet_members_protect=9604aabd771340db647705c0cba33d58,tg_users_protect_admin_fields=1934b73fc021a66a25ac89502a8a2a06"
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ($PATCHED_LIST, $CREATED_LIST)"

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's bodies" "$BODIES" "$OLD_BODIES"
OTHERS_BEFORE=$(run $DB "$OTHERS")

if [ "$MIG" != none ]; then
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M1 00672 applies (1st)" || ko "M1 00672 applies (1st)" "$r"
  r=$(apply $DB "$ROOT/$MIG"); [ "$r" = applied ] && ok "M2 00672 applies again" || ko "M2 00672 applies again" "$r"
  val "M3 the bodies are 00672's" "$BODIES" "$NEW_BODIES"
  val "M4 no other function changed" "$OTHERS" "$OTHERS_BEFORE"
fi

# ── Before: the operator's direct writes are undone or refused, as since 00668 ──
val "W1 an operator's direct approval is undone by the profile trigger" \
    "$(tx "$(as_user $OP) UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$DP1'; RESET ROLE; SELECT status FROM public.driver_profiles WHERE id = '$DP1';")" \
    "under_review"
val "W2 an operator's direct document review is undone" \
    "$(tx "$(as_user $OP) UPDATE public.driver_documents SET is_verified = true WHERE id = '$DOC1'; RESET ROLE; SELECT is_verified FROM public.driver_documents WHERE id = '$DOC1';")" \
    "f"

# ── ops_set_driver_status ─────────────────────────────────────
APPROVE1="public.ops_set_driver_status('$DP1', 'approved', 'under_review')"
val "D1 operator approves: approved, passenger made driver, wallet, logged, push queued" \
    "$(tx "$(call $OP "$APPROVE1 ->> 'success'")
      SELECT status || ',' || (approved_at IS NOT NULL) FROM public.driver_profiles WHERE id = '$DP1';
      SELECT role FROM public.users WHERE id = '$CUS';
      SELECT count(*) FROM public.wallet_accounts WHERE user_id = '$CUS' AND account_type = 'tricicoin';
      SELECT action || ',' || admin_id FROM public.admin_actions WHERE target_id = '$DP1';
      SELECT jobname || ',' || (body -> 'user_ids' ->> 0) || ',' || (body ->> 'title') || ',' || (body -> 'data' ->> 'status') FROM public.test_http_calls;")" \
    "true;approved,true;driver;1;approve_driver,$OP;ops-driver-review,$CUS,Cuenta aprobada,approved"
val "D2 no active vehicle: refused, nothing changes" \
    "$(tx "$(call $OP "public.ops_set_driver_status('$DP2', 'approved', 'under_review') ->> 'error'") SELECT status FROM public.driver_profiles WHERE id = '$DP2';")" \
    "driver_has_no_active_vehicle;under_review"
val "D3 the status changed since it was shown" "$(tx "$(call $OP "public.ops_set_driver_status('$DP1', 'approved', 'pending_verification') ->> 'error'")")" "driver_changed"
val "D4 reject needs a reason" "$(tx "$(call $OP "public.ops_set_driver_status('$DP1', 'rejected', 'under_review', ' ') ->> 'error'")")" "reason_required"
val "D5 operator rejects, with the reason logged" \
    "$(tx "$(call $OP "public.ops_set_driver_status('$DP1', 'rejected', 'under_review', 'Documentos ilegibles') ->> 'status'")
      SELECT status FROM public.driver_profiles WHERE id = '$DP1'; SELECT role FROM public.users WHERE id = '$CUS';
      SELECT reason FROM public.admin_actions WHERE target_id = '$DP1';")" \
    "rejected;rejected;customer;Documentos ilegibles"
val "D6 operator suspends: offline, reason kept; the driver turned pushes off, so none" \
    "$(tx "$(call $OP "public.ops_set_driver_status('$DP3', 'suspended', 'approved', 'Quejas repetidas') ->> 'status'")
      SELECT status || ',' || is_online || ',' || suspended_reason || ',' || (suspended_at IS NOT NULL) FROM public.driver_profiles WHERE id = '$DP3';
      SELECT count(*) FROM public.test_http_calls;")" \
    "suspended;suspended,false,Quejas repetidas,true;0"
val "D7 a transition the panel never offers" "$(tx "$(call $OP "public.ops_set_driver_status('$DP3', 'rejected', 'approved', 'motivo') ->> 'error'")")" "invalid_transition"
val "D8 never on their own driver profile" "$(tx "$(call $OP "public.ops_set_driver_status('$DPOP', 'approved', 'under_review') ->> 'error'") SELECT status FROM public.driver_profiles WHERE id = '$DPOP';")" "self_action;under_review"
val "D9 an operator never acts on a team member; an admin does" \
    "$(tx "$(call $OP "public.ops_set_driver_status('$DPADM', 'approved', 'under_review') ->> 'error'") $(call $OP "public.ops_set_driver_status('$DP1', 'approved', 'under_review') ->> 'success'")")" \
    "target_is_staff;true"
val "D10 an admin approves a team member's profile; the role stays admin" \
    "$(tx "$(call $ADM "public.ops_set_driver_status('$DPOP', 'approved', 'under_review') ->> 'success'") SELECT role FROM public.users WHERE id = '$OP';")" \
    "true;operator"
val "D11 marketing and a passenger are refused" \
    "$(tx "$(call $MKT "$APPROVE1 ->> 'error'") $(call $CUS2 "$APPROVE1 ->> 'error'") SELECT status FROM public.driver_profiles WHERE id = '$DP1';")" \
    "forbidden;forbidden;under_review"
val "D12 outside the function the role step is still undone" \
    "$(tx "$(as_user $OP) UPDATE public.users SET role = 'driver' WHERE id = '$CUS2'; RESET ROLE; SELECT role FROM public.users WHERE id = '$CUS2';")" \
    "customer"

# ── Documents ─────────────────────────────────────────────────
val "K1 operator verifies a document: verified by them, push, no e-mail" \
    "$(tx "$(call $OP "public.ops_review_driver_document('$DOC1', true) ->> 'success'")
      SELECT is_verified || ',' || verified_by || ',' || (rejection_reason IS NULL) FROM public.driver_documents WHERE id = '$DOC1';
      SELECT string_agg(jobname || ':' || (body ->> 'title'), ',') FROM public.test_http_calls;")" \
    "true;true,$OP,true;ops-driver-review:✅ Cédula verificado"
val "K2 rejecting needs a message" "$(tx "$(call $OP "public.ops_review_driver_document('$DOC1', false, '  ') ->> 'error'")")" "reason_required"
val "K3 operator rejects: reason stored, push and rejection e-mail queued" \
    "$(tx "$(call $OP "public.ops_review_driver_document('$DOC1', false, 'Foto borrosa', ARRAY['blurry'], 'Se ve movida') ->> 'success'")
      SELECT is_verified || ',' || rejection_reason FROM public.driver_documents WHERE id = '$DOC1';
      SELECT string_agg(jobname, ',' ORDER BY id) FROM public.test_http_calls;
      SELECT (body ->> 'documentId') || ',' || (body -> 'reasonCodes' ->> 0) || ',' || (body ->> 'note') FROM public.test_http_calls WHERE jobname = 'ops-document-rejection-email';")" \
    "true;false,Foto borrosa;ops-driver-review,ops-document-rejection-email;$DOC1,blurry,Se ve movida"
val "K4 never their own document" "$(tx "$(call $OP "public.ops_review_driver_document('$DOCOP', true) ->> 'error'")")" "self_action"
val "K5 operator adds a document: born unverified, logged" \
    "$(tx "$(call $OP "public.ops_add_driver_document('$DP1', 'drivers_license', 'driver-docs/$DP1/drivers_license/c.jpg', 'c.jpg', 'image/jpeg') -> 'document' ->> 'is_verified'")
      SELECT count(*) FROM public.driver_documents WHERE driver_id = '$DP1' AND document_type = 'drivers_license';
      SELECT action FROM public.admin_actions WHERE admin_id = '$OP';")" \
    "false;1;upload_driver_document"
val "K6 a path outside the driver's folder or the type" \
    "$(tx "$(call $OP "public.ops_add_driver_document('$DP1', 'drivers_license', 'driver-docs/$DP2/drivers_license/c.jpg', 'c.jpg', 'image/jpeg') ->> 'error'")
      $(call $OP "public.ops_add_driver_document('$DP1', 'drivers_license', 'driver-docs/$DP1/national_id/c.jpg', 'c.jpg', 'image/jpeg') ->> 'error'")
      $(call $OP "public.ops_add_driver_document('$DP1', 'drivers_license', 'driver-docs/$DP1/drivers_license/../x.jpg', 'c.jpg', 'image/jpeg') ->> 'error'")
      $(call $OP "public.ops_add_driver_document('$DP1', 'tarjeta', 'driver-docs/$DP1/tarjeta/c.jpg', 'c.jpg', 'image/jpeg') ->> 'error'")")" \
    "invalid_path;invalid_path;invalid_path;invalid_document_type"
has "K7 a file type outside the whitelist" \
    "$(tx "$(call $OP "public.ops_add_driver_document('$DP1', 'drivers_license', 'driver-docs/$DP1/drivers_license/c.exe', 'c.exe', 'application/x-msdownload')")")" \
    "is not in the allowed whitelist"

# ── Outreach ──────────────────────────────────────────────────
val "O1 operator logs a contact, stamped with them" \
    "$(tx "$(call $OP "public.ops_log_driver_outreach('$DP2', 'whatsapp', '  Le escribí  ') ->> 'success'")
      SELECT admin_id || ',' || channel || ',' || note FROM public.driver_outreach_log;")" \
    "true;$OP,whatsapp,Le escribí"
val "O2 an unknown channel; marketing refused" \
    "$(tx "$(call $OP "public.ops_log_driver_outreach('$DP2', 'paloma') ->> 'error'") $(call $MKT "public.ops_log_driver_outreach('$DP2', 'sms') ->> 'error'")")" \
    "invalid_channel;forbidden"

# ── Fleets ────────────────────────────────────────────────────
val "Q1 operator approves a fleet request: approved and fleet owner" \
    "$(tx "$(call $OP "public.ops_review_fleet_account('$CA1', 'approved', 'pending') ->> 'success'")
      SELECT status || ',' || is_fleet_owner || ',' || (approved_at IS NOT NULL) FROM public.corporate_accounts WHERE id = '$CA1';")" \
    "true;approved,true,true"
val "Q2 a corporate client is not theirs; their own fleet neither; a stale status" \
    "$(tx "$(call $OP "public.ops_review_fleet_account('$CA2', 'approved', 'pending') ->> 'error'")
      $(call $OP "public.ops_review_fleet_account('$CAOP', 'approved', 'pending') ->> 'error'")
      $(call $OP "public.ops_review_fleet_account('$CA1', 'approved', 'approved') ->> 'error'")")" \
    "not_a_fleet;self_action;account_changed"
val "Q3 operator rejects a fleet request with a reason" \
    "$(tx "$(call $OP "public.ops_review_fleet_account('$CA1', 'rejected', 'pending', 'Sin documentos') ->> 'status'")
      SELECT status || ',' || suspended_reason || ',' || is_fleet_owner FROM public.corporate_accounts WHERE id = '$CA1';")" \
    "rejected;rejected,Sin documentos,false"
val "Q4 operator approves an invitation as shown" \
    "$(tx "$(call $OP "public.ops_review_fleet_member('$FM1', 'approved', $SHOWN_FM1) ->> 'status'")
      SELECT status || ',' || reviewed_by FROM public.fleet_members WHERE id = '$FM1';")" \
    "approved;approved,$OP"
val "Q5 the invitation changed since it was shown: nothing happens" \
    "$(tx "UPDATE public.fleet_members SET driver_phone = '+5355599999' WHERE id = '$FM1';
      $(call $OP "public.ops_review_fleet_member('$FM1', 'approved', $SHOWN_FM1) ->> 'error'")
      SELECT status FROM public.fleet_members WHERE id = '$FM1';")" \
    "member_changed;pending_review"
val "Q6 reject needs a reason; never in their own fleet" \
    "$(tx "$(call $OP "public.ops_review_fleet_member('$FM1', 'rejected', $SHOWN_FM1) ->> 'error'")
      $(call $OP "public.ops_review_fleet_member('$FMOP', 'approved', '{}'::jsonb) ->> 'error'")")" \
    "reason_required;self_action"
val "Q7 outside the function the review is still undone" \
    "$(tx "$(as_user $OP) UPDATE public.fleet_members SET status = 'approved' WHERE id = '$FM1'; RESET ROLE; SELECT status FROM public.fleet_members WHERE id = '$FM1';")" \
    "pending_review"

# ── Grants ────────────────────────────────────────────────────
val "G1 the six ops functions: authenticated yes, anon no; helpers closed" \
    "SELECT bool_and(CASE WHEN p.proname LIKE 'ops\\_%'
                          THEN NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                          ELSE NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') END),
            count(*)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED_LIST)" "t|8"

if [ "$MIG" != none ]; then
  CRLF=$(mktemp); sed 's/$/\r/' "$ROOT/$MIG" > "$CRLF"
  mkdb ${DB}crlf
  r=$(apply ${DB}crlf "$CRLF"); [ "$r" = applied ] && ok "R1 a CRLF copy applies" || ko "R1 a CRLF copy applies" "$r"
  val "R2 the CRLF copy leaves the same bodies, without carriage returns" \
      "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
      "$NEW_BODIES;0" ${DB}crlf
  rm -f "$CRLF"

  neg(){ # neg NAME SETUP_SQL EXPECTED_ERROR [FILE]
    mkdb ${DB}neg
    run ${DB}neg "SET ROLE postgres; $2" >/dev/null
    local r; r=$(apply ${DB}neg "${4:-$ROOT/$MIG}")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi
  }
  neg "N1 a body it does not know stops it" \
      "CREATE OR REPLACE FUNCTION public.tg_fleet_members_protect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_catalog' AS \$f\$ BEGIN RETURN NEW; END \$f\$;" \
      "tg_fleet_members_protect() has an unknown body"
  neg "N2 another function calling the ops checks stops it" \
      "CREATE FUNCTION public.zz_probe() RETURNS boolean LANGUAGE sql AS \$f\$ SELECT public.is_ops_staff() \$f\$;" \
      "other functions call the ops checks: zz_probe()"
  neg "N3 a role function naming the operator stops it" \
      "CREATE FUNCTION public.promote_user_role() RETURNS text LANGUAGE sql AS \$f\$ SELECT 'operator'::text \$f\$;" \
      "a money or role function names the operator"
  neg "N4 an ops function that logs nothing stops it" \
      "CREATE FUNCTION public.ops_zz_probe() RETURNS void LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT \$f\$;" \
      "ops_zz_probe() is not a proper ops function"
  NOREVOKE=$(mktemp); grep -v 'public._ops_target_refusal(uuid)$' "$ROOT/$MIG" | sed 's/^REVOKE ALL ON FUNCTION public._ops_user_push(text, uuid, uuid, text, text, jsonb),$/REVOKE ALL ON FUNCTION public._ops_user_push(text, uuid, uuid, text, text, jsonb)/' > "$NOREVOKE"
  neg "N5 a helper open to clients stops it" "SELECT 1;" "the helpers are open to clients" "$NOREVOKE"
  rm -f "$NOREVOKE"
  for d in ${DB}crlf ${DB}neg; do echo "DROP DATABASE IF EXISTS $d;" | $PSQL -d postgres -q -f - >/dev/null 2>&1; done
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
