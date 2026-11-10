#!/usr/bin/env bash
# Rehearsal runner for migration 00679 (one owner per assisted ride, and the support number from the
# operator on shift). Builds prod's tables (tables.sql) and the bodies 00679 calls or patches, byte
# for byte (live-bodies.sql), on the roles and stubs of scaffold.sql (pushes land in test_pushes).
# A cases: part 1 (staff, shifts, the contact). B cases: part 2 (owners, the help number, handover,
# the tick and the automatic off-shift). C cases: part 3 (the ownership guard in the seven assist
# actions, opening and taking a ride, the owner in the panel's reads, the self-check).
#   supabase/tests/00679/run.sh none
#       -> prod as captured + tests (RED: support_staff and the shift functions do not exist)
#   supabase/tests/00679/run.sh supabase/migrations/00679_support_ride_owner.sql
#       -> the same + 00679 applied twice, each in one transaction (GREEN), a snapshot showing it
#          changed no other function, a CRLF copy applied to a fresh database, and negative proofs
#          of the file's own checks
# The migration path is relative to the repository root, or absolute.
# Cluster: any Postgres 16 with a superuser. Default: psql on 127.0.0.1:${PGPORT:-5433} as pgtest.
#   PSQL="<bin>/psql.exe -h 127.0.0.1 -p <port> -U pgtest" supabase/tests/00679/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
case "$MIG" in none|/*|[A-Za-z]:*) FILE="$MIG" ;; *) FILE="$ROOT/$MIG" ;; esac
PSQL="${PSQL:-psql -h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest}"
DB=pr679
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = '';"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ echo "$2" | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run "${4:-$DB}" "$2"); if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3] in [$r]"; fi; }
apply(){ local out; if out=$({ echo "$AS_OWNER"; cat "$2"; } | $PSQL -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f - 2>&1); then echo applied;
         else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
dropdb(){ echo "DROP DATABASE IF EXISTS $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1; }
mkdb(){
  dropdb "$1"
  echo "CREATE DATABASE $1;" | $PSQL -d postgres -q -f - >/dev/null 2>&1 || { echo "cannot create $1"; exit 1; }
  if ! cat "$DIR/scaffold.sql" "$DIR/tables.sql" "$DIR/live-bodies.sql" \
       | $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
}

OP1=a6790000-0000-4000-8000-000000000001    # operator Lete, no phone on her account
OP2=a6790000-0000-4000-8000-000000000002    # operator Melanye, with a phone on her account
ADM=a6790000-0000-4000-8000-000000000003    # admin
CUS=a6790000-0000-4000-8000-000000000004    # passenger of R1..R4
DRV=a6790000-0000-4000-8000-000000000005    # driver (DP)
DP=d6790000-0000-4000-8000-000000000001
DPOP=d6790000-0000-4000-8000-000000000002   # a driver profile of OP2's (A11 only)
R1=b6790000-0000-4000-8000-000000000001     # searching
R2=b6790000-0000-4000-8000-000000000002     # searching
R3=b6790000-0000-4000-8000-000000000003     # searching
R4=b6790000-0000-4000-8000-000000000004     # searching
DRV2=a6790000-0000-4000-8000-000000000006   # a second driver (C cases only)
DP2=d6790000-0000-4000-8000-000000000003
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
tx(){ echo "BEGIN; $1 ROLLBACK;"; }
call(){ echo "$(as_user $1) SELECT $2; RESET ROLE;"; }
as(){ echo "$(as_user $1) $2; RESET ROLE;"; }
anon_call(){ echo "SET LOCAL request.jwt.claim.sub = ''; SET LOCAL ROLE anon; SELECT $1; RESET ROLE;"; }
# The name of who _support_pick_owner picks for ride $1 excluding $2, or none.
pick(){ echo "SELECT coalesce(u.full_name, 'none') FROM (SELECT public._support_pick_owner('$1', $2) AS id) p LEFT JOIN public.users u ON u.id = p.id;"; }

SEED="
INSERT INTO public.users (id, role, full_name, phone) VALUES
  ('$OP1', 'operator', 'Lete', NULL), ('$OP2', 'operator', 'Melanye', '+53 5512 3457'),
  ('$ADM', 'admin', 'Ana Admin', NULL), ('$CUS', 'customer', 'Pasajera', '55550000'),
  ('$DRV', 'driver', 'Chofer', NULL);
INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$DP', '$DRV', 'approved');
INSERT INTO public.service_type_configs (slug, name_es, name_en) VALUES ('triciclo_basico', 'Triciclo', 'Tricycle');
INSERT INTO public.rides (id, customer_id, service_type, status, pickup_address, dropoff_address) VALUES
  ('$R1', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R2', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R3', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R4', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja');"
# Both operators on shift with a number, written directly (the cases of the pick rule).
ON_BOTH="INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
  ('$OP1', '+5355123456', true, now()), ('$OP2', '+5355123457', true, now());"

CREATED_LIST="'_support_staff_on_shift','_support_pick_owner','get_support_contact','ops_set_support_shift',
  'ops_support_shift_status'"
# Part 2: the functions it creates, and the live bodies it patches.
CREATED2_LIST="'_support_alert_text','_support_send','_support_phone_for_ride','_support_handoff_rides_of',
  '_support_pickup_for','support_handoff_tick','_support_ride_open'"
PATCHED_LIST="'_support_alert','request_ride_help','notify_support_waiting_rides'"
# Part 3: the functions it creates, and the live bodies it patches (the seven assist actions and the
# two contexts). The banner's v1 (admin_support_waiting_rides) is in neither: M4 shows it unchanged.
CREATED3_LIST="'_assist_claim_or_refuse','_support_ride_owner','ops_open_ride_assist','ops_take_ride_assist',
  'admin_support_waiting_rides_v2'"
PATCHED3_LIST="'admin_offer_ride_to_driver','admin_assign_ride_to_driver','admin_change_ride_service',
  'admin_release_active_ride','admin_advance_active_ride','admin_complete_active_ride','admin_cancel_ride',
  'admin_ride_assist_context','admin_active_ride_context'"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname IN ($CREATED_LIST, $CREATED2_LIST, $PATCHED_LIST, $CREATED3_LIST, $PATCHED3_LIST)"
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname NOT IN ($CREATED_LIST, $CREATED2_LIST, $PATCHED_LIST, $CREATED3_LIST, $PATCHED3_LIST)"
HELPERS="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('current_user_role', 'is_admin', 'is_operator',
  'is_ops_staff', '_ride_short_code', '_ride_type_label', 'get_platform_config_numeric', 'log_rpc_attempt',
  '_html_escape', 'get_platform_config_text', '_support_alert', 'request_ride_help', 'notify_support_waiting_rides',
  '_ops_allow', $PATCHED3_LIST, 'admin_support_waiting_rides')"
# md5 of prosrc in prod on 2026-11-07 (part 3's re-captured on 2026-11-09: unchanged).
PROD_HELPERS="_html_escape=11824274e20a4bc4e469ca12e4dc7c10,_ops_allow=4762cf93cce4a747dc420cf3cdd7c7e9,_ride_short_code=7dae14319bfae57a2ac8b4317e928513,_ride_type_label=6334b65ed6bc08e91f9d4cfdee97976e,_support_alert=992c2ce11b664d72e437a683170abb97,admin_active_ride_context=62031d5be71f09241122be3e64bb3957,admin_advance_active_ride=bc7187cb8d4dbde6c64886e2ee9e3ff8,admin_assign_ride_to_driver=96a14f1ef39f9d397884457278efd699,admin_cancel_ride=21b4dfa6427e7c8976ef1324ddfa732b,admin_change_ride_service=06b0af6654384570c38a76389681d43a,admin_complete_active_ride=149e13089c12d43458a75ee58dd2a9d3,admin_offer_ride_to_driver=0085408045cc5fbf2dbc3e2eb0da92f5,admin_release_active_ride=8f18bf4984f52e41c93cdb16b062eeff,admin_ride_assist_context=2b7a2a9cb6ca0566c3fde8614220e91a,admin_support_waiting_rides=6220ecbb3b398b62c22dc2534ce55570,current_user_role=cb4a7c12d4e21fe2997135833f141e25,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,get_platform_config_text=407a7b835c527164a4aa8b3aa8525ba5,is_admin=22cb75e91980d512498034cd33e1eda2,is_operator=16438eb527af61eaa2d0b3d9a53f08f9,is_ops_staff=d6774e4677be1072e66b247492e9cb9a,log_rpc_attempt=0a902c34a1148dac5686403a7c941bc0,notify_support_waiting_rides=c69e1ca717436dad23eada26af46e0ce,request_ride_help=0568a44a41e6b9ef925ae1b2b2799cb1"
# md5 of prosrc of the twelve bodies 00679 patches, after the patch (part 3's nine: see the file's
# Checks block).
PATCHED_MD5="_support_alert=66476de2158a616eb7897904af78c92b,admin_active_ride_context=5ec61f7f9f02e2537da12c49f53a521f,admin_advance_active_ride=271197d1cc0c41ea18dbd6a4975e85bb,admin_assign_ride_to_driver=668b0ae079d5e00c12013537bdaa3384,admin_cancel_ride=460ebfbaeb70f9734bff2d6d9cd5c51d,admin_change_ride_service=9aea004c5bc6f7a83c3098c18bf97812,admin_complete_active_ride=6df9d20cee20b03c8f7f28c3b1022a5f,admin_offer_ride_to_driver=87530b01f336c315a804d940333b7c04,admin_release_active_ride=961b6169aa4152b935f122dce4a46b5e,admin_ride_assist_context=d5e63768daed1321fd8fbddb09ff2ba6,notify_support_waiting_rides=da6c10207da346fdc6f27114f6f125d6,request_ride_help=2b9faf1390909d63ae02696105d78090"
# The cron with nobody on shift: R1, R2 and R4 wait (R3 already asked for help), and the digest goes
# to two addresses. Its return value, every push and e-mail (label and md5 of the body) and the
# stamps it leaves. B19 compares the result after 00679 with the result before it.
CRON_CASE="$(tx "INSERT INTO public.platform_config (key, value)
    VALUES ('support_alert_email', '\"ops@tricigo.com, soporte@tricigo.com\"'::jsonb);
  UPDATE public.rides SET created_at = now() - CASE id WHEN '$R1' THEN interval '4 minutes'
    WHEN '$R2' THEN interval '3 minutes' ELSE interval '2 minutes' END;
  INSERT INTO public.ride_assist (ride_id, help_requested_at, help_alert_sent_at) VALUES ('$R3', now(), now());
  SELECT public.notify_support_waiting_rides();
  SELECT string_agg(label || ':' || md5(body::text), ',' ORDER BY label, md5(body::text)) FROM public.test_pushes;
  SELECT string_agg(right(ride_id::text, 1) || ':' || (wait_alert_sent_at IS NOT DISTINCT FROM now())
                    || (help_email_sent_at IS NOT DISTINCT FROM now()) || (wait_email_sent_at IS NOT DISTINCT FROM now()),
                    ',' ORDER BY ride_id)
    FROM public.ride_assist;")"

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's bodies (the helpers, the two 00679 patches, the wait-alert cron)" "$HELPERS" "$PROD_HELPERS"
OTHERS_BEFORE=$(run $DB "$OTHERS")
CRON_BEFORE=$(run $DB "$CRON_CASE")

if [ "$MIG" != none ]; then
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M1 00679 applies (1st)" || ko "M1 00679 applies (1st)" "$r"
  run $DB "UPDATE public.platform_config SET value = '90'::jsonb WHERE key = 'support_handoff_after_s';" >/dev/null
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M2 00679 applies again" || ko "M2 00679 applies again" "$r"
  val "M3 a setting changed in between survives the second apply" \
      "SELECT value FROM public.platform_config WHERE key = 'support_handoff_after_s';
       UPDATE public.platform_config SET value = '60'::jsonb WHERE key = 'support_handoff_after_s';" "90"
  val "M4 no other function changed" "$OTHERS" "$OTHERS_BEFORE"
  val "M5 the twelve patched bodies carry their 00679 md5" \
      "SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED_LIST, $PATCHED3_LIST)" "$PATCHED_MD5"
fi

# ── The switch ────────────────────────────────────────────────
val "A1 on with no number stored: whatsapp_required, also with a phone on the account; nothing written" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, NULL) ->> 'error'")
      $(call $OP2 "public.ops_set_support_shift(true) ->> 'error'")
      SELECT count(*) FROM public.support_staff; SELECT count(*) FROM public.admin_actions;")" \
    "whatsapp_required;whatsapp_required;0;0"
val "A2 a number not in E.164: invalid_whatsapp (the panel normalizes)" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, '5 512 3456') ->> 'error'")
      $(call $OP1 "public.ops_set_support_shift(true, '55123456') ->> 'error'")
      $(call $OP1 "public.ops_set_support_shift(true, '+53 5512 3456') ->> 'error'")
      SELECT count(*) FROM public.support_staff;")" \
    "invalid_whatsapp;invalid_whatsapp;invalid_whatsapp;0"
val "A3 on with a number: stored, on shift, one support_shift_on; on again with NULL reuses it and resets the misses" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, '+5355123456')
                        = '{\"success\": true, \"on_shift\": true, \"whatsapp_phone\": \"+5355123456\", \"handed_over\": 0, \"kept\": 0, \"picked_up\": 0}'::jsonb")
      SELECT on_shift || ',' || whatsapp_phone || ',' || (shift_started_at IS NOT NULL) || ',' || missed_in_a_row
        FROM public.support_staff WHERE user_id = '$OP1';
      SELECT action || ',' || admin_id || ',' || target_type || ',' || target_id || ',' || (new_values ->> 'whatsapp_phone')
        FROM public.admin_actions;
      $(call $OP1 "public.ops_set_support_shift(false) ->> 'on_shift'")
      UPDATE public.support_staff SET missed_in_a_row = 2 WHERE user_id = '$OP1';
      $(call $OP1 "public.ops_set_support_shift(true, NULL) ->> 'whatsapp_phone'")
      $(call $OP1 "public.ops_set_support_shift(true) ->> 'on_shift'")
      SELECT missed_in_a_row FROM public.support_staff WHERE user_id = '$OP1';
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions;")" \
    "t;true,+5355123456,true,0;support_shift_on,$OP1,support_staff,$OP1,+5355123456;false;+5355123456;true;0;support_shift_off,support_shift_on,support_shift_on"
val "A4 a passenger is refused; anon cannot execute it" \
    "$(tx "$(call $CUS "public.ops_set_support_shift(true, '+5355123456') ->> 'error'")
      SELECT has_function_privilege('anon', 'public.ops_set_support_shift(boolean,text)', 'EXECUTE');
      SELECT count(*) FROM public.support_staff;")" \
    "forbidden;f;0"
has "A4b anon calling it gets permission denied" \
    "$(tx "SET LOCAL ROLE anon; SELECT public.ops_set_support_shift(true, '+5355123456');")" \
    "permission denied for function ops_set_support_shift"
val "A10 an admin can go on shift (admins may cover) and be picked" \
    "$(tx "$(call $ADM "public.ops_set_support_shift(true, '+5355000003') ->> 'on_shift'")
      SELECT action FROM public.admin_actions WHERE admin_id = '$ADM';
      $(pick $R2 "'{}'")")" \
    "true;support_shift_on;Ana Admin"

# ── The support contact ───────────────────────────────────────
val "A5 anon gets the number of the operator on shift" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, '+5355123456') ->> 'success'")
      $(anon_call "public.get_support_contact()::text")")" \
    "true;{\"phone\": \"+5355123456\"}"
# One transaction has one now(): OP1's shift end moves a minute back so OP2's ends later.
val "A6 nobody on shift: the last one who went off; a later one replaces her" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, '+5355123456') ->> 'success'")
      $(call $OP1 "public.ops_set_support_shift(false) ->> 'on_shift'")
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions WHERE admin_id = '$OP1';
      $(anon_call "coalesce(public.get_support_contact() ->> 'phone', 'null')")
      UPDATE public.support_staff SET shift_ended_at = shift_ended_at - interval '1 minute' WHERE user_id = '$OP1';
      $(call $OP2 "public.ops_set_support_shift(true, '+5355123457') ->> 'success'")
      $(call $OP2 "public.ops_set_support_shift(false) ->> 'on_shift'")
      $(anon_call "coalesce(public.get_support_contact() ->> 'phone', 'null')")")" \
    "true;false;support_shift_off,support_shift_on;+5355123456;true;false;+5355123457"
val "A7 nobody ever on shift: {phone: null}, also with a number stored but no shift" \
    "$(tx "$(anon_call "public.get_support_contact()::text")
      INSERT INTO public.support_staff (user_id, whatsapp_phone) VALUES ('$OP1', '+5355123456');
      $(anon_call "public.get_support_contact()::text")")" \
    "{\"phone\": null};{\"phone\": null}"

# ── Who gets a ride ───────────────────────────────────────────
# 1: OP1 owns a searching ride, OP2 a completed one -> OP2. 2: equal load, OP1 assigned longer ago
# -> OP1. 3: OP2 never assigned -> OP2. 4-5: each pick takes a turn. 6-7: p_exclude.
val "A8 fewest open owned rides first, then the oldest last_assigned_at (never first); each pick takes a turn" \
    "$(tx "$ON_BOTH
      INSERT INTO public.ride_assist (ride_id, owner_id) VALUES ('$R1', '$OP1'), ('$R4', '$OP2');
      UPDATE public.rides SET status = 'completed' WHERE id = '$R4';
      $(pick $R2 "'{}'")
      UPDATE public.ride_assist SET owner_id = NULL;
      UPDATE public.support_staff SET last_assigned_at = now() - CASE user_id WHEN '$OP1' THEN interval '5 minutes' ELSE interval '1 minute' END;
      $(pick $R2 "'{}'")
      UPDATE public.support_staff SET last_assigned_at = CASE user_id WHEN '$OP1' THEN now() - interval '5 minutes' END;
      $(pick $R2 "'{}'")
      $(pick $R3 "'{}'")
      $(pick $R4 "'{}'")
      $(pick $R2 "ARRAY['$OP1']::uuid[]")
      $(pick $R2 "ARRAY['$OP1', '$OP2']::uuid[]")")" \
    "Melanye;Lete;Melanye;Lete;Melanye;Melanye;none"
val "A9 an operator deactivated with her switch on is never picked nor given out, even if her shift ended last" \
    "$(tx "$ON_BOTH
      INSERT INTO public.ride_assist (ride_id, owner_id) VALUES ('$R1', '$OP1');
      $(pick $R2 "'{}'")
      UPDATE public.users SET is_active = false WHERE id = '$OP2';
      $(pick $R2 "'{}'")
      $(anon_call "coalesce(public.get_support_contact() ->> 'phone', 'null')")
      UPDATE public.support_staff SET on_shift = false, shift_ended_at = now() - interval '1 minute' WHERE user_id = '$OP1';
      UPDATE public.support_staff SET shift_ended_at = now() WHERE user_id = '$OP2';
      $(pick $R2 "'{}'")
      $(anon_call "coalesce(public.get_support_contact() ->> 'phone', 'null')")")" \
    "Melanye;Lete;+5355123456;none;+5355123456"
val "A11 never on oneself: the ride's rider or driver is skipped; with nobody else, no owner" \
    "$(tx "$ON_BOTH
      INSERT INTO public.ride_assist (ride_id, owner_id) VALUES ('$R1', '$OP1');
      UPDATE public.rides SET customer_id = '$OP2' WHERE id = '$R3';
      $(pick $R3 "'{}'")
      INSERT INTO public.driver_profiles (id, user_id, status) VALUES ('$DPOP', '$OP2', 'approved');
      UPDATE public.rides SET driver_id = '$DPOP', status = 'accepted' WHERE id = '$R4';
      $(pick $R4 "'{}'")
      UPDATE public.support_staff SET on_shift = false WHERE user_id = '$OP1';
      $(pick $R3 "'{}'")
      $(pick $R2 "'{}'")")" \
    "Lete;Lete;none;Melanye"

# ── What the switch shows ─────────────────────────────────────
STATUS="WITH s AS (SELECT public.ops_support_shift_status() AS j)
  SELECT coalesce(j ->> 'me', 'null'), (j -> 'on_shift')::text, coalesce(j ->> 'suggested_whatsapp', 'null') FROM s"
ME="WITH s AS (SELECT public.ops_support_shift_status() -> 'me' AS m)
  SELECT m ->> 'on_shift', m ->> 'whatsapp_phone', m ->> 'missed_in_a_row', (m ->> 'shift_started_at') IS NOT NULL FROM s"
LIST="WITH s AS (SELECT public.ops_support_shift_status() AS j)
  SELECT (j -> 'on_shift')::text, coalesce(j ->> 'suggested_whatsapp', 'null') FROM s"
val "A12 the switch's status: her row, the others who count as on shift, her account phone as a suggestion" \
    "$(tx "$(as $OP2 "$STATUS")
      $(call $OP1 "public.ops_set_support_shift(true, '+5355123456') ->> 'on_shift'")
      $(as $OP2 "$STATUS")
      $(as $OP1 "$ME")
      $(as $OP1 "$LIST")
      $(call $CUS "public.ops_support_shift_status() ->> 'error'")
      $(call $OP2 "public.ops_set_support_shift(true, '+5355123457') ->> 'on_shift'")
      $(as $OP1 "$LIST")
      UPDATE public.users SET is_active = false WHERE id = '$OP2';
      $(as $OP1 "$LIST")")" \
    "null|[]|+53 5512 3457;true;null|[{\"name\": \"Lete\", \"user_id\": \"$OP1\"}]|+53 5512 3457;true|+5355123456|0|t;[]|null;forbidden;true;[{\"name\": \"Melanye\", \"user_id\": \"$OP2\"}]|null;[]|null"

# ── Grants, RLS and shapes ────────────────────────────────────
val "A13 the functions: SECURITY DEFINER with search_path; anon only the contact; helpers closed" \
    "SELECT p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::int
              || has_function_privilege('authenticated', p.oid, 'EXECUTE')::int
              || has_function_privilege('service_role', p.oid, 'EXECUTE')::int
              || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ' ')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED_LIST) ORDER BY p.proname" \
    "_support_pick_owner:000:true:search_path=public, pg_catalog;_support_staff_on_shift:000:true:search_path=public, pg_catalog;get_support_contact:111:true:search_path=public, pg_catalog;ops_set_support_shift:011:true:search_path=public, pg_catalog;ops_support_shift_status:011:true:search_path=public, pg_catalog"
val "A14 support_staff: RLS on, one policy, read by authenticated, written by service_role only" \
    "SELECT relrowsecurity, (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'support_staff'),
            has_table_privilege('anon', 'public.support_staff', 'SELECT'),
            has_table_privilege('authenticated', 'public.support_staff', 'SELECT'),
            has_table_privilege('authenticated', 'public.support_staff', 'INSERT'),
            has_table_privilege('authenticated', 'public.support_staff', 'UPDATE'),
            has_table_privilege('authenticated', 'public.support_staff', 'DELETE'),
            has_table_privilege('service_role', 'public.support_staff', 'UPDATE')
       FROM pg_class WHERE oid = 'public.support_staff'::regclass" \
    "t|1|f|t|f|f|f|t"
val "A14b ops staff read every row, a passenger none" \
    "$(tx "$ON_BOTH $(call $OP1 "count(*) FROM public.support_staff") $(call $CUS "count(*) FROM public.support_staff")")" \
    "2;0"
has "A14c nobody writes it directly" \
    "$(tx "$(as_user $OP1) UPDATE public.support_staff SET on_shift = true;")" \
    "permission denied for table support_staff"
val "A15 ride_assist gains the owner columns, a key that lets a deleted user go, and an index" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY ordinal_position)
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ride_assist' AND ordinal_position > 7;
     SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.ride_assist'::regclass AND conname = 'ride_assist_owner_id_fkey';
     SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ride_assist_owner_id_idx'" \
    "owner_id:uuid:YES:-,owner_assigned_at:timestamp with time zone:YES:-,owner_opened_at:timestamp with time zone:YES:-,owners_tried:ARRAY:NO:'{}'::uuid[],all_missed_alert_at:timestamp with time zone:YES:-;FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;CREATE INDEX ride_assist_owner_id_idx ON public.ride_assist USING btree (owner_id) WHERE (owner_id IS NOT NULL)"
val "A16 support_staff's shape, and the two settings" \
    "SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '-'), ',' ORDER BY ordinal_position)
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'support_staff';
     SELECT string_agg(pg_get_constraintdef(oid), ' / ' ORDER BY contype, conname) FROM pg_constraint WHERE conrelid = 'public.support_staff'::regclass;
     SELECT string_agg(key || '=' || value::text, ',' ORDER BY key) FROM public.platform_config
      WHERE key IN ('support_handoff_after_s', 'support_auto_offshift_misses')" \
    "user_id:uuid:NO:-,whatsapp_phone:text:YES:-,on_shift:boolean:NO:false,shift_started_at:timestamp with time zone:YES:-,shift_ended_at:timestamp with time zone:YES:-,missed_in_a_row:integer:NO:0,last_assigned_at:timestamp with time zone:YES:-,updated_at:timestamp with time zone:NO:now();CHECK ((whatsapp_phone ~ '^\\+[1-9][0-9]{7,14}\$'::text)) / FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE / PRIMARY KEY (user_id);support_auto_offshift_misses=2,support_handoff_after_s=60"

# ══ Part 2: one owner per ride, the help number, handover and off-shift ══
# OP1 alone on shift with a number, written directly.
ON1="INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
  ('$OP1', '+5355123456', true, now());"
# alerted RIDE help|wait: the ride_assist row of a ride whose help (or wait) alert just went out.
alerted(){ echo "INSERT INTO public.ride_assist (ride_id, ${2}_alert_sent_at) VALUES ('$1', now());"; }
# owned RIDE OWNER SECONDS: a ride whose wait alert went out SECONDS ago and made OWNER its owner.
owned(){ echo "INSERT INTO public.ride_assist (ride_id, wait_alert_sent_at, owner_id, owner_assigned_at, owners_tried)
  VALUES ('$1', now() - interval '$3 seconds', '$2', now() - interval '$3 seconds', ARRAY['$2']::uuid[]);"; }
# The name of the ride's owner, or none.
owner(){ echo "SELECT coalesce((SELECT u.full_name FROM public.ride_assist ra JOIN public.users u ON u.id = ra.owner_id
  WHERE ra.ride_id = '$1'), 'none');"; }
# The pushes sent, in order: label:recipients (names, sorted); their titles; their data.event.
PUSHES="SELECT coalesce(string_agg(p.label || ':' || coalesce((SELECT string_agg(u.full_name, '+' ORDER BY u.full_name)
    FROM jsonb_array_elements_text(p.body -> 'user_ids') AS t(v) JOIN public.users u ON u.id = t.v::uuid), '-'),
    ',' ORDER BY p.id), 'none')
  FROM public.test_pushes p;"
TITLES="SELECT coalesce(string_agg(p.body ->> 'title', ',' ORDER BY p.id), 'none') FROM public.test_pushes p;"
EVENTS="SELECT coalesce(string_agg(p.body -> 'data' ->> 'event', ',' ORDER BY p.id), 'none') FROM public.test_pushes p;"
MISSED="SELECT string_agg(u.full_name || '=' || s.missed_in_a_row, ',' ORDER BY u.full_name)
  FROM public.support_staff s JOIN public.users u ON u.id = s.user_id;"
# The result of the switch: handed_over,kept,picked_up.
toggle(){ echo "$(call $1 "j ->> 'handed_over' || ',' || (j ->> 'kept') || ',' || (j ->> 'picked_up')
  FROM (SELECT public.ops_set_support_shift($2) AS j) x")"; }
ALL3="Ana Admin+Lete+Melanye"
TITLE_HELP="Pasajero pide ayuda · Triciclo · B6790000"
TITLE_WAIT="Viaje sin conductor · Triciclo · B6790000"

val "B0 part 2's functions: SECURITY DEFINER with search_path; helpers and tick closed; the patched keep prod's grants" \
    "SELECT p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::int
              || has_function_privilege('authenticated', p.oid, 'EXECUTE')::int
              || has_function_privilege('service_role', p.oid, 'EXECUTE')::int
              || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ' ')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED2_LIST, $PATCHED_LIST)
      ORDER BY p.proname" \
    "_support_alert:001:true:search_path=public, pg_catalog;_support_alert_text:000:true:search_path=public, pg_catalog;_support_handoff_rides_of:000:true:search_path=public, pg_catalog;_support_phone_for_ride:000:true:search_path=public, pg_catalog;_support_pickup_for:000:true:search_path=public, pg_catalog;_support_ride_open:000:true:search_path=public, pg_catalog;_support_send:000:true:search_path=public, pg_catalog;notify_support_waiting_rides:001:true:search_path=public, pg_catalog;request_ride_help:011:true:search_path=public, pg_catalog;support_handoff_tick:000:true:search_path=public, pg_catalog"
case "$CRON_BEFORE" in
  "3;support-alert-email:"*) val "B19 the cron's pushes, digest e-mails and stamps are the same as before 00679 (nobody on shift)" \
                                 "$CRON_CASE" "$CRON_BEFORE" ;;
  *) ko "B19 the cron's pushes, digest e-mails and stamps are the same as before 00679 (nobody on shift)" \
        "the run before 00679 gave [$CRON_BEFORE]" ;;
esac

# ── Who an alert goes to ──────────────────────────────────────
val "B1 one operator on shift: the alert makes her the owner and pushes only her (Te toca)" \
    "$(tx "$ON1 $(alerted $R1 help)
      SELECT public._support_alert('$R1', 'help');
      $(owner $R1)
      SELECT (owner_assigned_at = now()) || ',' || (owner_opened_at IS NULL) || ',' || (all_missed_alert_at IS NULL)
             || ',' || array_to_string(owners_tried, ' ')
        FROM public.ride_assist WHERE ride_id = '$R1';
      $PUSHES $TITLES
      SELECT (body -> 'data' ->> 'event') || ',' || (body -> 'data' ->> 'ride_id') || ',' || (body -> 'data' ->> 'url')
             || ',' || (body ->> 'category')
        FROM public.test_pushes;")" \
    "Lete;true,true,true,$OP1;support-owner-alert:Lete;Te toca · $TITLE_HELP;support_owner,$R1,https://admin.tricigo.com/rides/$R1/assist,system"
val "B2 nobody on shift: no owner, and every active ops staff account gets the push, as today" \
    "$(tx "$(alerted $R1 help) $(alerted $R2 wait)
      SELECT public._support_alert('$R1', 'help'); SELECT public._support_alert('$R2', 'wait');
      $(owner $R1) $(owner $R2) $PUSHES $TITLES $EVENTS")" \
    "none;none;support-help-alert:$ALL3,support-wait-alert:$ALL3;$TITLE_HELP,$TITLE_WAIT;support_help,support_wait"
val "B3 two on shift, two alerts in the same transaction: one each" \
    "$(tx "$ON_BOTH $(alerted $R1 wait) $(alerted $R2 wait)
      SELECT public._support_alert('$R1', 'wait'); SELECT public._support_alert('$R2', 'wait');
      $(owner $R1) $(owner $R2) $PUSHES")" \
    "Lete;Melanye;support-owner-alert:Lete,support-owner-alert:Melanye"
val "B3b the cron's wait alerts (notify_support_waiting_rides) take turns between the two" \
    "$(tx "$ON_BOTH
      UPDATE public.rides SET created_at = now() - CASE id WHEN '$R1' THEN interval '4 minutes'
        WHEN '$R2' THEN interval '3 minutes' WHEN '$R3' THEN interval '2 minutes' ELSE interval '100 seconds' END;
      SELECT public.notify_support_waiting_rides();
      $(owner $R1) $(owner $R2) $(owner $R3) $(owner $R4) $PUSHES")" \
    "4;Lete;Melanye;Lete;Melanye;support-owner-alert:Lete,support-owner-alert:Melanye,support-owner-alert:Lete,support-owner-alert:Melanye"
val "B9 never on oneself: the only one on shift is the rider, so no owner and everyone gets the push" \
    "$(tx "$ON1 UPDATE public.rides SET customer_id = '$OP1' WHERE id = '$R3';
      $(alerted $R3 wait) SELECT public._support_alert('$R3', 'wait'); $(owner $R3) $PUSHES")" \
    "none;support-wait-alert:$ALL3"

# ── The rider's number ────────────────────────────────────────
val "B4 request_ride_help gives the owner's number; nobody on shift: the last one off; capped: a number, no owner" \
    "$(tx "$ON1 $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'") $(owner $R1) $PUSHES")
     $(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_ended_at) VALUES
         ('$OP1', '+5355123456', false, now() - interval '10 minutes'), ('$OP2', '+5355123457', false, now() - interval '1 minute');
       $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'") $(owner $R1) $PUSHES")
     $(tx "$ON1
       INSERT INTO public.ride_assist (ride_id, help_alert_sent_at) VALUES
         ('$R2', now() - interval '10 minutes'), ('$R3', now() - interval '20 minutes'), ('$R4', now() - interval '30 minutes');
       $(call $CUS "public.request_ride_help('$R1')::text") $(owner $R1) $PUSHES
       SELECT outcome FROM public.rpc_attempt_log;")" \
    "+5355123456;Lete;support-owner-alert:Lete;+5355123457;none;support-help-alert:$ALL3;{\"code\": \"B6790000\", \"success\": true, \"support_phone\": \"+5355123456\"};none;none;help_alert_capped"
# OP1 goes off a minute before OP2's shift ends, so the support contact is OP2's, not the owner's.
val "B5 an owner who went off shift alone keeps the ride; a help request then pushes everyone and gives the support contact" \
    "$(tx "$(call $OP1 "public.ops_set_support_shift(true, '+5355123456') ->> 'on_shift'")
      $(alerted $R1 wait) SELECT public._support_alert('$R1', 'wait');
      $(toggle $OP1 false)
      UPDATE public.support_staff SET shift_ended_at = shift_ended_at - interval '1 minute' WHERE user_id = '$OP1';
      INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_ended_at) VALUES ('$OP2', '+5355123457', false, now());
      $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'")
      $(anon_call "public.get_support_contact() ->> 'phone'")
      $(owner $R1) $PUSHES")" \
    "true;0,1,0;+5355123457;+5355123457;Lete;support-owner-alert:Lete,support-help-alert:$ALL3"
val "B5b an owner off shift and someone else on: the next alert passes the ride to her" \
    "$(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_ended_at) VALUES
        ('$OP1', '+5355123456', false, now()), ('$OP2', '+5355123457', true, NULL);
      $(owned $R1 $OP1 10)
      $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'")
      $(owner $R1) SELECT array_to_string(owners_tried, ' ') FROM public.ride_assist WHERE ride_id = '$R1';
      $PUSHES")" \
    "+5355123457;Melanye;$OP1 $OP2;support-owner-alert:Melanye"
val "B6 the help button twice: the same number both times, one push" \
    "$(tx "$ON1 $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'")
      $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'") $PUSHES")" \
    "+5355123456;+5355123456;support-owner-alert:Lete"

# ── The handover tick ─────────────────────────────────────────
val "B7 not opened in 60 s: the tick passes it to the other one on shift (push) and counts her miss; at 59 s nothing" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 61)
      SELECT public.support_handoff_tick();
      $(owner $R1)
      SELECT (owner_assigned_at = now()) || ',' || (owner_opened_at IS NULL) || ',' || array_to_string(owners_tried, ' ')
        FROM public.ride_assist WHERE ride_id = '$R1';
      $PUSHES $TITLES $EVENTS $MISSED")
     $(tx "$ON_BOTH $(owned $R1 $OP1 59) SELECT public.support_handoff_tick(); $(owner $R1) $PUSHES $MISSED")" \
    "1;Melanye;true,true,$OP1 $OP2;support-handoff:Melanye;Te pasamos un viaje · $TITLE_WAIT;support_handoff;Lete=1,Melanye=0;0;Lete;none;Lete=0,Melanye=0"
val "B8 alone on shift: the ride stays hers, everyone gets one push, her miss counts; a second miss takes her off shift" \
    "$(tx "$ON1 $(owned $R1 $OP1 61)
      SELECT public.support_handoff_tick();
      $(owner $R1) SELECT (all_missed_alert_at = now())::text FROM public.ride_assist WHERE ride_id = '$R1';
      $PUSHES $MISSED
      SELECT public.support_handoff_tick(); SELECT count(*) FROM public.test_pushes; $MISSED
      $(owned $R2 $OP1 61)
      SELECT public.support_handoff_tick();
      SELECT on_shift || ',' || (shift_ended_at = now()) FROM public.support_staff WHERE user_id = '$OP1';
      $(owner $R1) $(owner $R2) $PUSHES $TITLES $EVENTS
      SELECT body ->> 'body' FROM public.test_pushes WHERE label = 'support-auto-offshift';
      SELECT action || ',' || admin_id || ',' || target_type || ',' || target_id || ',' || (new_values ->> 'on_shift')
             || ',' || (new_values ->> 'kept')
        FROM public.admin_actions;")" \
    "1;Lete;true;support-all-missed:$ALL3;Lete=1;0;1;Lete=1;1;false,true;Lete;Lete;support-all-missed:$ALL3,support-all-missed:$ALL3,support-auto-offshift:Lete;Nadie abrió el viaje · $TITLE_WAIT,Nadie abrió el viaje · $TITLE_WAIT,Te sacamos de turno;support_all_missed,support_all_missed,support_offshift;No abriste 2 viajes seguidos. Actívalo de nuevo cuando puedas.;support_shift_auto_off,$OP1,support_staff,$OP1,false,2"
val "B10 the tick leaves a ride that is no longer searching, and one its owner opened" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 61) $(owned $R2 $OP1 61)
      UPDATE public.rides SET status = 'accepted' WHERE id = '$R1';
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id = '$R2';
      SELECT public.support_handoff_tick(); $(owner $R1) $(owner $R2) $PUSHES $MISSED")" \
    "0;Lete;Lete;none;Lete=0,Melanye=0"
val "B16 the settings have floors: 30 s to open the ride, 1 miss" \
    "$(tx "UPDATE public.platform_config SET value = '10'::jsonb WHERE key = 'support_handoff_after_s';
      UPDATE public.platform_config SET value = '0'::jsonb WHERE key = 'support_auto_offshift_misses';
      $ON_BOTH $(owned $R1 $OP1 29) SELECT public.support_handoff_tick();
      UPDATE public.ride_assist SET owner_assigned_at = now() - interval '31 seconds' WHERE ride_id = '$R1';
      SELECT public.support_handoff_tick(); $(owner $R1)
      SELECT on_shift::text FROM public.support_staff WHERE user_id = '$OP1'; $PUSHES")" \
    "0;1;Melanye;false;support-handoff:Melanye,support-auto-offshift:Lete"
val "B15 the tick runs every 20 seconds (pg_cron)" \
    "SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'support-handoff-tick'" \
    "20 seconds|SELECT public.support_handoff_tick()"

# ── Going off and coming on ───────────────────────────────────
val "B11 going off with open rides: they pass to the other one on shift (a push each); alone, they stay hers" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 10) $(owned $R2 $OP1 10)
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id = '$R2';
      $(toggle $OP1 false)
      $(owner $R1) $(owner $R2) SELECT (owner_opened_at IS NULL)::text FROM public.ride_assist WHERE ride_id = '$R2';
      $PUSHES
      SELECT (new_values ->> 'handed_over') || ',' || (new_values ->> 'kept') FROM public.admin_actions
       WHERE action = 'support_shift_off';")
     $(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
        ('$OP2', '+5355123457', true, now());
      $(owned $R1 $OP2 10) $(toggle $OP2 false) $(owner $R1) $PUSHES")" \
    "2,0,0;Melanye;Melanye;true;support-handoff:Melanye,support-handoff:Melanye;2,0;0,1,0;Melanye;none"
# Ruling 11. R1 in progress and opened by OP1; R2 accepted, never opened; R3 completed and R4
# canceled (both opened). Only R1 is open: it passes on with the push of a ride in progress, R2 stays
# hers without counting, R3 and R4 never count.
val "B11b going off: an active ride she opened passes on (en curso push); one never opened stays, uncounted; closed never count" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 10) $(owned $R2 $OP1 10) $(owned $R3 $OP1 10) $(owned $R4 $OP1 10)
      UPDATE public.rides SET status = (CASE id WHEN '$R1' THEN 'in_progress' WHEN '$R2' THEN 'accepted'
        WHEN '$R3' THEN 'completed' ELSE 'canceled' END)::public.ride_status;
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id IN ('$R1', '$R3', '$R4');
      $(toggle $OP1 false)
      $(owner $R1) $(owner $R2) $(owner $R3) $(owner $R4) $PUSHES $TITLES
      SELECT body ->> 'body' FROM public.test_pushes;")
     $(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
        ('$OP2', '+5355123457', true, now());
      $(owned $R1 $OP2 10) $(owned $R2 $OP2 10) $(owned $R3 $OP2 10)
      UPDATE public.rides SET status = (CASE id WHEN '$R1' THEN 'in_progress' WHEN '$R2' THEN 'accepted'
        ELSE 'completed' END)::public.ride_status WHERE id IN ('$R1', '$R2', '$R3');
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id IN ('$R1', '$R3');
      $(toggle $OP2 false) $PUSHES")" \
    "1,0,0;Melanye;Lete;Lete;Lete;support-handoff:Melanye;Te pasamos un viaje en curso · #B6790000;Calle 23 entre L y M, Vedado → Obispo 104, Habana Vieja;0,1,0;none"
# OP1 owns R1 accepted and never opened, R3 completed and R4 canceled (both opened): none is open, so
# OP1 and OP2 tie and OP1 (first id) is picked and given out. Once she opens R1 it weighs: OP2.
val "B18 open rides weigh in the pick and the contact: searching, or active and opened; never closed ones" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 10) $(owned $R3 $OP1 10) $(owned $R4 $OP1 10)
      UPDATE public.rides SET status = (CASE id WHEN '$R1' THEN 'accepted' WHEN '$R3' THEN 'completed'
        ELSE 'canceled' END)::public.ride_status WHERE id IN ('$R1', '$R3', '$R4');
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id IN ('$R3', '$R4');
      $(anon_call "public.get_support_contact() ->> 'phone'")
      $(pick $R2 "'{}'")
      UPDATE public.support_staff SET last_assigned_at = NULL;
      UPDATE public.ride_assist SET owner_opened_at = now() WHERE ride_id = '$R1';
      $(anon_call "public.get_support_contact() ->> 'phone'")
      $(pick $R2 "'{}'")")" \
    "+5355123456;Lete;+5355123457;Melanye"
# R4 alerted with no owner; R1 owned by OP1 (off) never opened; R2 owned by OP1 (off) and opened;
# R3 asked for help but its alert was capped (not alerted).
val "B12 coming on shift picks up the alerted rides with no owner, or an off-shift owner who never opened them" \
    "$(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_ended_at) VALUES
        ('$OP1', '+5355123456', false, now()), ('$OP2', '+5355123457', false, now());
      $(alerted $R4 wait) $(owned $R1 $OP1 300) $(owned $R2 $OP1 300)
      UPDATE public.ride_assist SET owner_opened_at = now() - interval '4 minutes' WHERE ride_id = '$R2';
      INSERT INTO public.ride_assist (ride_id, help_requested_at) VALUES ('$R3', now());
      $(toggle $OP2 true)
      $(owner $R1) $(owner $R2) $(owner $R3) $(owner $R4) $PUSHES $TITLES")" \
    "0,0,2;Melanye;Lete;none;Melanye;support-owner-alert:Melanye,support-owner-alert:Melanye;Te toca · $TITLE_WAIT,Te toca · $TITLE_WAIT"
# Ruling 8. OP1, alone, goes off keeping R1 and R2 (assigned 6 min ago in her earlier shift, never
# opened) and comes back on: the pickup gives them to her again with a fresh minute, so a tick right
# away counts no miss. Only a ride then left unopened a fresh 61 s counts one (R1; R2 at 59 s not).
val "B17 coming back on: the rides she kept unopened restart their minute; no miss until a fresh 60 s" \
    "$(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
        ('$OP1', '+5355123456', true, now() - interval '10 minutes');
      $(owned $R1 $OP1 360) $(owned $R2 $OP1 360)
      $(toggle $OP1 false)
      $(toggle $OP1 true)
      SELECT string_agg((owner_assigned_at = now())::text, ',' ORDER BY ride_id) FROM public.ride_assist;
      SELECT public.support_handoff_tick();
      SELECT on_shift || ',' || missed_in_a_row FROM public.support_staff WHERE user_id = '$OP1';
      UPDATE public.ride_assist
         SET owner_assigned_at = now() - CASE ride_id WHEN '$R1' THEN interval '61 seconds' ELSE interval '59 seconds' END;
      SELECT public.support_handoff_tick();
      SELECT on_shift || ',' || missed_in_a_row FROM public.support_staff WHERE user_id = '$OP1';
      $(owner $R1) $(owner $R2) $PUSHES")" \
    "0,2,0;0,0,2;true,true;0;true,0;1;true,1;Lete;Lete;support-owner-alert:Lete,support-owner-alert:Lete,support-all-missed:$ALL3"
val "B17b a repeated on (already on shift) does not restart the minute of a ride of this shift" \
    "$(tx "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_started_at) VALUES
        ('$OP1', '+5355123456', true, now() - interval '10 minutes');
      $(owned $R1 $OP1 61)
      $(toggle $OP1 true)
      SELECT public.support_handoff_tick();
      SELECT missed_in_a_row FROM public.support_staff WHERE user_id = '$OP1'; $PUSHES")" \
    "0,0,0;1;1;support-all-missed:$ALL3"

# ── A push that fails ─────────────────────────────────────────
val "B13 a push that fails keeps the assignment and the handover, and logs alert_failed" \
    "$(tx "SET LOCAL client_min_messages = error; SET LOCAL test.http_fail = '1';
      $ON1 $(alerted $R1 help) SELECT public._support_alert('$R1', 'help');
      $(owner $R1) $PUSHES
      SELECT outcome || ',' || target_id || ',' || (metadata ->> 'label') FROM public.rpc_attempt_log;")
     $(tx "SET LOCAL client_min_messages = error; SET LOCAL test.http_fail = '1';
      $ON_BOTH $(owned $R1 $OP1 61) SELECT public.support_handoff_tick();
      $(owner $R1) $PUSHES
      SELECT outcome || ',' || target_id || ',' || (metadata ->> 'label') FROM public.rpc_attempt_log;")" \
    "Lete;none;alert_failed,$R1,support-owner-alert;1;Melanye;none;alert_failed,$R1,support-handoff"

# ══ Part 3: the ownership guard, open and take, the owner in the panel's reads ══
# A second driver, approved and online (R3's in C1).
DRIVER2="INSERT INTO public.users (id, role, full_name) VALUES ('$DRV2', 'driver', 'Chofer Dos');
  INSERT INTO public.driver_profiles (id, user_id, status, is_online) VALUES ('$DP2', '$DRV2', 'approved', true);"
WHY="'Sin conductor'"
OWNED_BY_OTHER='{"error": "ride_owned_by_other"}'

val "C0 part 3's functions: SECURITY DEFINER with search_path; the guard and the owner helper closed; open, take and v2 for signed-in staff; the patched keep prod's grants and search_path" \
    "SELECT p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')::int
              || has_function_privilege('authenticated', p.oid, 'EXECUTE')::int
              || has_function_privilege('service_role', p.oid, 'EXECUTE')::int
              || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ' ')
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED3_LIST, $PATCHED3_LIST)
      ORDER BY p.proname" \
    "_assist_claim_or_refuse:000:true:search_path=public, pg_catalog;_support_ride_owner:000:true:search_path=public, pg_catalog;admin_active_ride_context:011:true:search_path=public, extensions, pg_catalog;admin_advance_active_ride:011:true:search_path=public, extensions, pg_catalog;admin_assign_ride_to_driver:011:true:search_path=public, pg_catalog;admin_cancel_ride:011:true:search_path=public, pg_catalog;admin_change_ride_service:011:true:search_path=public, extensions, pg_catalog;admin_complete_active_ride:011:true:search_path=public, extensions, pg_catalog;admin_offer_ride_to_driver:011:true:search_path=public, pg_catalog;admin_release_active_ride:011:true:search_path=public, pg_catalog;admin_ride_assist_context:011:true:search_path=public, pg_catalog;admin_support_waiting_rides_v2:011:true:search_path=public, pg_catalog;ops_open_ride_assist:011:true:search_path=public, pg_catalog;ops_take_ride_assist:011:true:search_path=public, pg_catalog"
has "C0b anon calling the take gets permission denied" \
    "$(tx "SET LOCAL ROLE anon; SELECT public.ops_take_ride_assist('$R1', NULL);")" \
    "permission denied for function ops_take_ride_assist"

# ── The guard ─────────────────────────────────────────────────
# R1 (searching), R2 (accepted by DP) and R3 (in progress with DP2), all OP1's. OP2 tries every
# action, ADM cancels, and OP2 offers again once OP1 is off shift (an owner off shift still owns
# it). Nothing may change: the rides, the drivers, offers, proposals, the log, the pushes, the owners.
val "C1 a ride someone else owns: each of the seven actions refuses with ride_owned_by_other, admins and off-shift owners too, and nothing changes" \
    "$(tx "$ON_BOTH $DRIVER2 $(owned $R1 $OP1 10) $(owned $R2 $OP1 10) $(owned $R3 $OP1 10)
      UPDATE public.driver_profiles SET is_online = true WHERE id = '$DP';
      UPDATE public.rides SET status = 'accepted', driver_id = '$DP', accepted_at = now() WHERE id = '$R2';
      UPDATE public.rides SET status = 'in_progress', driver_id = '$DP2', accepted_at = now(), pickup_at = now() WHERE id = '$R3';
      CREATE TEMP TABLE c1_rides AS SELECT * FROM public.rides;
      CREATE TEMP TABLE c1_drivers AS SELECT * FROM public.driver_profiles;
      $(call $OP2 "public.admin_offer_ride_to_driver('$R1', '$DP')::text")
      $(call $OP2 "public.admin_assign_ride_to_driver('$R1', '$DP', $WHY)::text")
      $(call $OP2 "public.admin_change_ride_service('$R1', 'triciclo_basico', 900, 'apply', $WHY)::text")
      $(call $OP2 "public.admin_cancel_ride('$R1', $WHY)::text")
      $(call $OP2 "public.admin_release_active_ride('$R2', 'accepted', '$DP', $WHY)::text")
      $(call $OP2 "public.admin_advance_active_ride('$R2', 'accepted', '$DP', $WHY)::text")
      $(call $OP2 "public.admin_complete_active_ride('$R3', 'in_progress', '$DP2', 0, $WHY)::text")
      $(call $ADM "public.admin_cancel_ride('$R1', $WHY)::text")
      UPDATE public.support_staff SET on_shift = false, shift_ended_at = now() WHERE user_id = '$OP1';
      $(call $OP2 "public.admin_offer_ride_to_driver('$R1', '$DP')::text")
      SELECT (SELECT count(*) FROM (SELECT * FROM public.rides EXCEPT SELECT * FROM c1_rides) x)
          || ',' || (SELECT count(*) FROM (SELECT * FROM public.driver_profiles EXCEPT SELECT * FROM c1_drivers) x)
          || ',' || (SELECT count(*) FROM public.ride_offers) || ',' || (SELECT count(*) FROM public.ride_service_proposals)
          || ',' || (SELECT count(*) FROM public.admin_actions) || ',' || (SELECT count(*) FROM public.test_pushes);
      SELECT string_agg(u.full_name || ':' || (ra.owner_opened_at IS NULL) || ':' || array_to_string(ra.owners_tried, ' '),
                        ',' ORDER BY ra.ride_id)
        FROM public.ride_assist ra JOIN public.users u ON u.id = ra.owner_id;")" \
    "$(for i in 1 2 3 4 5 6 7 8 9; do printf '%s;' "$OWNED_BY_OTHER"; done)0,0,0,0,0,0;Lete:true:$OP1,Lete:true:$OP1,Lete:true:$OP1"
# The control for C1: the same stubs let the owner take R1 through every action to the end.
val "C1b the owner goes through every action (offer, propose, assign, release, change, assign, advance x2, complete; cancel)" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 10) $(owned $R2 $OP1 10)
      UPDATE public.driver_profiles SET is_online = true WHERE id = '$DP';
      $(call $OP1 "public.admin_offer_ride_to_driver('$R1', '$DP') ->> 'mode'")
      $(call $OP1 "public.admin_change_ride_service('$R1', 'triciclo_basico', 900, 'propose') ->> 'mode'")
      $(call $OP1 "public.admin_assign_ride_to_driver('$R1', '$DP', $WHY) ->> 'success'")
      $(call $OP1 "public.admin_release_active_ride('$R1', 'accepted', '$DP', $WHY) ->> 'status'")
      UPDATE public.driver_profiles SET is_online = true WHERE id = '$DP';
      $(call $OP1 "public.admin_change_ride_service('$R1', 'triciclo_basico', 900, 'apply', $WHY) ->> 'mode'")
      $(call $OP1 "public.admin_assign_ride_to_driver('$R1', '$DP', $WHY) ->> 'success'")
      $(call $OP1 "public.admin_advance_active_ride('$R1', 'accepted', '$DP', $WHY) ->> 'status'")
      $(call $OP1 "public.admin_advance_active_ride('$R1', 'arrived_at_pickup', '$DP', $WHY) ->> 'status'")
      $(call $OP1 "public.admin_complete_active_ride('$R1', 'in_progress', '$DP', 900, $WHY) ->> 'status'")
      $(call $OP1 "public.admin_cancel_ride('$R2', $WHY) ->> 'success'")
      SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions;
      $(owner $R1) $(owner $R2)")" \
    "created;propose;true;searching;apply;true;arrived_at_pickup;in_progress;completed;true;cancel_ride,support_advance_ride,support_advance_ride,support_assign_ride,support_assign_ride,support_change_service,support_complete_ride,support_offer_ride,support_propose_service,support_release_ride;Lete;Lete"
# R4 has no ride_assist row and R1 one with no owner (alerted while nobody was on shift). A refusal
# before the guard (no reason) claims nothing. ADM's offer to a suspended driver makes her R4's
# owner, opened, though the offer is refused; OP1 is then refused; ADM goes on to the offer's own
# checks. OP2's assign to an offline driver (not_online) makes her R3's owner. ADM's cancel of R1
# makes her its owner. A ride its owner acted on is opened: the tick leaves it.
val "C2 a ride with no owner: the first action makes its caller the owner (opened), even when the action then refuses" \
    "$(tx "$ON_BOTH $(alerted $R1 wait)
      UPDATE public.driver_profiles SET status = 'suspended' WHERE id = '$DP';
      $(call $OP1 "public.admin_assign_ride_to_driver('$R4', '$DP', ' ') ->> 'error'")
      SELECT count(*) FROM public.ride_assist WHERE ride_id = '$R4';
      $(call $ADM "public.admin_offer_ride_to_driver('$R4', '$DP') ->> 'error'")
      $(owner $R4)
      SELECT (owner_assigned_at = now()) || ',' || (owner_opened_at = now()) || ',' || array_to_string(owners_tried, ' ')
        FROM public.ride_assist WHERE ride_id = '$R4';
      $(call $OP1 "public.admin_offer_ride_to_driver('$R4', '$DP') ->> 'error'")
      $(call $ADM "public.admin_offer_ride_to_driver('$R4', '$DP') ->> 'error'")
      UPDATE public.driver_profiles SET status = 'approved' WHERE id = '$DP';
      $(call $OP2 "public.admin_assign_ride_to_driver('$R3', '$DP', $WHY) ->> 'error'")
      $(owner $R3)
      $(call $ADM "public.admin_cancel_ride('$R1', $WHY) ->> 'success'")
      $(owner $R1)
      SELECT (wait_alert_sent_at IS NOT NULL) || ',' || (owner_opened_at = now()) FROM public.ride_assist WHERE ride_id = '$R1';
      UPDATE public.ride_assist SET owner_assigned_at = now() - interval '61 seconds' WHERE ride_id = '$R3';
      SELECT public.support_handoff_tick();
      $(owner $R3)
      SELECT string_agg(action, ',') FROM public.admin_actions; $PUSHES")" \
    "reason_required;0;driver_not_approved;Ana Admin;true,true,$ADM;ride_owned_by_other;driver_not_approved;not_online;Melanye;true;Ana Admin;true,true;0;Melanye;cancel_ride;none"

# Review fix 1: the owner acting on her ride counts as opening it. R1 is OP1's, assigned 61 s ago and
# never opened (the cron gave it to her after her page loaded); she offers it to a driver, and the
# tick then leaves it with her (OP2, on shift, would get it otherwise) with no miss. R2 is OP1's,
# opened 30 s ago: her cancel keeps that first opening.
val "C10 the owner acting on her ride counts as opening it: the handover leaves it, no miss; an earlier opening is kept" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 61) $(owned $R2 $OP1 30)
      UPDATE public.ride_assist SET owner_opened_at = now() - interval '30 seconds' WHERE ride_id = '$R2';
      $(call $OP1 "public.admin_offer_ride_to_driver('$R1', '$DP') ->> 'mode'")
      SELECT (owner_opened_at = now())::text FROM public.ride_assist WHERE ride_id = '$R1';
      SELECT public.support_handoff_tick();
      $(owner $R1) $MISSED $PUSHES
      $(call $OP1 "public.admin_cancel_ride('$R2', $WHY) ->> 'success'")
      SELECT (owner_opened_at = now() - interval '30 seconds')::text FROM public.ride_assist WHERE ride_id = '$R2';")" \
    "created;true;0;Lete;Lete=0,Melanye=0;none;true;true"

# ── Taking a ride ─────────────────────────────────────────────
val "C3 taking a ride: the caller becomes its owner (opened, misses zeroed), the owner she saw gets a push, it is logged; a stale take gets ride_changed" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 30)
      UPDATE public.support_staff SET missed_in_a_row = 1;
      $(call $OP2 "public.ops_take_ride_assist('$R1', '$OP1')::text")
      $(owner $R1)
      SELECT (owner_assigned_at = now()) || ',' || (owner_opened_at = now()) || ',' || array_to_string(owners_tried, ' ')
        FROM public.ride_assist WHERE ride_id = '$R1';
      $MISSED $PUSHES $TITLES $EVENTS
      SELECT (body ->> 'body') || '|' || (body -> 'data' ->> 'ride_id') FROM public.test_pushes;
      SELECT action || ',' || admin_id || ',' || target_type || ',' || target_id || ',' || (old_values ->> 'owner_id')
             || ',' || (new_values ->> 'owner_id') FROM public.admin_actions;
      $(call $ADM "public.ops_take_ride_assist('$R1', '$OP1')::text")
      $(owner $R1) SELECT count(*) FROM public.test_pushes; SELECT count(*) FROM public.admin_actions;")" \
    "{\"success\": true};Melanye;true,true,$OP1 $OP2;Lete=1,Melanye=0;support-take:Lete;Melanye tomó el viaje #B6790000;support_take;Calle 23 entre L y M, Vedado → Obispo 104, Habana Vieja|$R1;support_take_ride,$OP2,ride,$R1,$OP1,$OP2;{\"error\": \"ride_changed\"};Melanye;1;1"
val "C3b take: an unowned ride (no push); no row but an owner expected; her own ride (self_ride); a passenger; a missing ride; a failing push keeps the take" \
    "$(tx "$ON_BOTH $(owned $R3 $OP1 30)
      $(call $OP1 "public.ops_take_ride_assist('$R4', NULL)::text")
      $(owner $R4)
      $(call $OP2 "public.ops_take_ride_assist('$R2', '$OP1') ->> 'error'")
      SELECT count(*) FROM public.ride_assist WHERE ride_id = '$R2';
      UPDATE public.rides SET customer_id = '$OP2' WHERE id = '$R3';
      $(call $OP2 "public.ops_take_ride_assist('$R3', '$OP1') ->> 'error'")
      $(call $CUS "public.ops_take_ride_assist('$R3', '$OP1') ->> 'error'")
      $(call $OP2 "public.ops_take_ride_assist('b6790000-0000-4000-8000-0000000000ff', NULL) ->> 'error'")
      $(owner $R3) $PUSHES
      SELECT string_agg(action || ':' || coalesce(old_values ->> 'owner_id', 'null'), ',') FROM public.admin_actions;")
     $(tx "SET LOCAL client_min_messages = error; SET LOCAL test.http_fail = '1';
      $ON_BOTH $(owned $R1 $OP1 30)
      $(call $OP2 "public.ops_take_ride_assist('$R1', '$OP1') ->> 'success'")
      $(owner $R1) $PUSHES
      SELECT outcome || ',' || target_id || ',' || (metadata ->> 'label') FROM public.rpc_attempt_log;")" \
    "{\"success\": true};Lete;ride_changed;0;self_ride;forbidden;ride_not_found;Lete;none;support_take_ride:null;true;Melanye;none;alert_failed,$R1,support-take"

# Ruling 12: ADM, off shift, takes R1 (so it is opened); OP1 is on shift; the rider taps help. The
# alert keeps ADM as the owner and pushes every active ops staff account; the rider gets OP1's
# number (the support contact: an owner off shift is not given out).
val "C9 an off-shift owner who opened the ride keeps it at the next alert; everyone is pushed; the rider gets the one on shift" \
    "$(tx "$ON1
      $(call $ADM "public.ops_take_ride_assist('$R1', NULL) ->> 'success'")
      $(call $CUS "public.request_ride_help('$R1') ->> 'support_phone'")
      $(owner $R1)
      SELECT (owner_opened_at = now()) || ',' || array_to_string(owners_tried, ' ') FROM public.ride_assist WHERE ride_id = '$R1';
      $PUSHES $TITLES")" \
    "true;+5355123456;Ana Admin;true,$ADM;support-help-alert:$ALL3;$TITLE_HELP"

# ── Opening the assist page ───────────────────────────────────
val "C4 opening the assist page: its owner stamps owner_opened_at and zeroes her misses (the handover then leaves it); anyone else changes nothing" \
    "$(tx "$ON_BOTH $(owned $R1 $OP1 61)
      UPDATE public.support_staff SET missed_in_a_row = 1;
      $(call $OP2 "public.ops_open_ride_assist('$R1')::text")
      SELECT (owner_opened_at IS NULL)::text FROM public.ride_assist WHERE ride_id = '$R1';
      $MISSED
      $(call $OP1 "public.ops_open_ride_assist('$R1')::text")
      SELECT (owner_opened_at = now())::text FROM public.ride_assist WHERE ride_id = '$R1';
      $MISSED
      SELECT public.support_handoff_tick(); $(owner $R1)
      $(call $OP1 "public.ops_open_ride_assist('$R2')::text")
      SELECT count(*) FROM public.ride_assist WHERE ride_id = '$R2';
      $(call $CUS "public.ops_open_ride_assist('$R1') ->> 'error'")
      $PUSHES SELECT count(*) FROM public.admin_actions;")" \
    "{\"success\": true, \"is_owner\": false};true;Lete=1,Melanye=1;{\"success\": true, \"is_owner\": true};true;Lete=0,Melanye=1;0;Lete;{\"success\": true, \"is_owner\": false};0;forbidden;none;0"

# ── The owner in the panel's reads ────────────────────────────
# R1 asked for help (OP1's, on shift, opened); R2 waits 4 min (OP2's, off shift, not opened, one
# pending offer); R3 waits 3 min (no owner); R4 waits 10 s (not listed). Help first, then the oldest.
V2ROWS="SELECT string_agg(right(t.ride_id::text, 1) || ':' || coalesce(t.owner_name, '-') || ':' || coalesce(t.owner_on_shift::text, '-')
    || ':' || (t.owner_assigned_at IS NOT NULL) || ':' || (t.owner_opened_at IS NOT NULL) || ':' || t.pending_offers,
    ',' ORDER BY t.ordinality)
  FROM public.admin_support_waiting_rides_v2() WITH ORDINALITY AS t"
V1COLS="ride_id uuid, code text, waiting_since timestamp with time zone, wait_s integer, help_requested_at timestamp with time zone, service_type text, estimated_fare_cup integer, pickup_address text, dropoff_address text, pending_offers integer, is_test boolean"
val "C5 the banner's v2 lists each ride with its owner (name, on shift, since, opened), the same rows and order as v1; v1 answers as before" \
    "$(tx "$ON1
      INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift, shift_ended_at) VALUES ('$OP2', '+5355123457', false, now());
      UPDATE public.rides SET created_at = now() - CASE id WHEN '$R2' THEN interval '4 minutes'
        WHEN '$R3' THEN interval '3 minutes' ELSE interval '10 seconds' END;
      INSERT INTO public.ride_assist (ride_id, help_requested_at, help_alert_sent_at, owner_id, owner_assigned_at, owner_opened_at, owners_tried)
        VALUES ('$R1', now(), now(), '$OP1', now(), now(), ARRAY['$OP1']::uuid[]);
      $(owned $R2 $OP2 30)
      INSERT INTO public.ride_offers (ride_id, driver_profile_id, expires_at) VALUES ('$R2', '$DP', now() + interval '1 minute');
      $(as $OP1 "$V2ROWS")
      $(as $OP1 "SELECT string_agg(right(t.ride_id::text, 1), ',' ORDER BY t.ordinality) FROM public.admin_support_waiting_rides() WITH ORDINALITY AS t")
      $(as $OP1 "SELECT count(*) FROM (SELECT ride_id, code, waiting_since, wait_s, help_requested_at, service_type, estimated_fare_cup,
                   pickup_address, dropoff_address, pending_offers, is_test FROM public.admin_support_waiting_rides_v2()
                 EXCEPT SELECT * FROM public.admin_support_waiting_rides()) x")
      SELECT pg_get_function_result('public.admin_support_waiting_rides()'::regprocedure);
      SELECT pg_get_function_result('public.admin_support_waiting_rides_v2()'::regprocedure);")" \
    "1:Lete:true:true:true:0,2:Melanye:false:true:false:1,3:-:-:false:false:0;1,2,3;0;TABLE($V1COLS);TABLE($V1COLS, owner_id uuid, owner_name text, owner_on_shift boolean, owner_assigned_at timestamp with time zone, owner_opened_at timestamp with time zone)"
has "C5b a passenger cannot read v2" \
    "$(tx "$(call $CUS "count(*) FROM public.admin_support_waiting_rides_v2()")")" "forbidden"
# owner: its keys, then id, name, on_shift, and whether assigned_at / opened_at are the times set
# (30 s and 10 s ago; null when not opened). KEYS: every key of the context, and the owner's JSON type.
CTX(){ echo "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(j -> 'owner') k)
    || '|' || (j -> 'owner' ->> 'id') || '|' || (j -> 'owner' ->> 'name') || '|' || (j -> 'owner' ->> 'on_shift')
    || '|' || ((j -> 'owner' ->> 'assigned_at')::timestamptz = now() - interval '30 seconds')
    || '|' || coalesce(((j -> 'owner' ->> 'opened_at')::timestamptz = now() - interval '10 seconds')::text, 'null')
  FROM (SELECT public.$1('$2') AS j) x"; }
KEYS(){ echo "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(j) k) || '|' || jsonb_typeof(j -> 'owner')
  FROM (SELECT public.$1('$2') AS j) x"; }
val "C6 both assist contexts carry owner: {id, name, on_shift, assigned_at, opened_at}, or null with no owner" \
    "$(tx "$ON1 $(owned $R1 $OP1 30)
      UPDATE public.ride_assist SET owner_opened_at = now() - interval '10 seconds' WHERE ride_id = '$R1';
      UPDATE public.rides SET status = 'accepted', driver_id = '$DP', accepted_at = now() WHERE id IN ('$R2', '$R4');
      $(owned $R2 $OP2 30)
      $(as $ADM "$(CTX admin_ride_assist_context $R1)")
      $(as $ADM "$(CTX admin_active_ride_context $R2)")
      $(as $ADM "$(KEYS admin_ride_assist_context $R3)")
      $(as $ADM "$(KEYS admin_active_ride_context $R4)")")" \
    "assigned_at,id,name,on_shift,opened_at|$OP1|Lete|true|true|true;assigned_at,id,name,on_shift,opened_at|$OP2|Melanye|false|true|null;help_requested_at,offers,owner,proposal,ride|null;alert,allowed_actions,delivery_proof_missing,driver,driver_profile_id,last_point,owner,preview,ride,start_pickup_at,start_pickup_source|null"

# ── At the same time (committed state, several sessions) ──────
# The sessions are ordered by state, not by timing. Each one starts only once the one before has
# picked (it says so with setval, which other sessions see at once), is waiting on a lock, or is
# done (pg_stat_activity). The first pick keeps its transaction open until released (setval again).
CDB=${DB}conc
conc_db(){ # conc_db SQL: a fresh database with the migration and SQL committed
  mkdb $CDB
  run $CDB "$SEED" >/dev/null
  [ "$MIG" != none ] && apply $CDB "$FILE" >/dev/null
  run $CDB "CREATE TABLE public.test_picks (who text PRIMARY KEY, picked uuid);
    CREATE SEQUENCE public.test_picked; CREATE SEQUENCE public.test_started; CREATE SEQUENCE public.test_go; $1" >/dev/null
}
await(){ # await SQL: poll until it returns t (gives up after 100 tries)
  local i=0
  until [ "$(run $CDB "$1")" = t ]; do i=$((i+1)); [ $i -ge 100 ] && return 1; sleep 0.1; done
}
waiting(){ echo "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '$1' AND wait_event_type = 'Lock')"; }
signal(){ echo "DO \$\$ BEGIN PERFORM setval('public.$1', 1); END \$\$;"; }
FIRST="SET application_name = 'p1'; BEGIN;
  INSERT INTO public.test_picks VALUES ('1', public._support_pick_owner('$R1', '{}'));
  $(signal test_picked)
  DO \$\$ BEGIN FOR i IN 1..600 LOOP EXIT WHEN (SELECT is_called FROM public.test_go); PERFORM pg_sleep(0.05); END LOOP; END \$\$;
  COMMIT;"
later_pick(){ echo "SET application_name = '$1'; INSERT INTO public.test_picks VALUES ('$2', public._support_pick_owner('$3', '{}'));"; }
PICKS="SELECT string_agg(t.who || ':' || coalesce(u.full_name, 'none'), ',' ORDER BY t.who) FROM public.test_picks t LEFT JOIN public.users u ON u.id = t.picked"
O1=$(mktemp); O2=$(mktemp); O3=$(mktemp); O4=$(mktemp)
outs(){ cat "$O1" "$O2" "$O3" "$O4" | paste -sd' ' -; }
conc_db "$ON_BOTH"
if [ "$(run $CDB "SELECT to_regprocedure('public._support_pick_owner(uuid,uuid[])') IS NOT NULL")" != t ]; then
  ko "A17 two picks at once go to two operators" "no _support_pick_owner"
  ko "A18 an operator turning on while picks wait: no deadlock" "no _support_pick_owner"
else
  # A17: both on shift, nobody assigned yet. The second pick starts while the first holds its
  # transaction, waits for it, and must get the other operator.
  : > "$O1"; : > "$O2"; : > "$O3"; : > "$O4"
  run $CDB "$FIRST" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  run $CDB "$(later_pick p2 2 $R2)" > "$O2" &
  await "$(waiting p2)"; w2=$?
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  r="$(run $CDB "$PICKS")|p2 waited:$([ $w2 -eq 0 ] && echo yes || echo no)|errors:$(outs | grep -o ERROR | wc -l | tr -d ' ')"
  [ "$r" = "1:Lete,2:Melanye|p2 waited:yes|errors:0" ] && ok "A17 two picks at once go to two operators (the second waited for the first)" \
    || ko "A17 two picks at once go to two operators (the second waited for the first)" "expected [1:Lete,2:Melanye|p2 waited:yes|errors:0], got [$r] $(outs)"

  # A18 (the reviewer's case): Melanye alone on shift with an open ride; Lete, whose id sorts first,
  # has a number but is off. Pick 1 holds; pick 2 waits; Lete turns on; pick 3 starts; then pick 1
  # commits. Every call must finish, none with a deadlock, and the pick after Lete's turn gets her.
  conc_db "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift) VALUES
      ('$OP1', '+5355123456', false), ('$OP2', '+5355123457', true);
    INSERT INTO public.ride_assist (ride_id, owner_id) VALUES ('$R4', '$OP2');"
  : > "$O1"; : > "$O2"; : > "$O3"; : > "$O4"
  run $CDB "$FIRST" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  run $CDB "$(later_pick p2 2 $R2)" > "$O2" &
  await "$(waiting p2)"; w2=$?
  run $CDB "SET application_name = 'on'; $(signal test_started)
    BEGIN; $(as_user $OP1) SELECT public.ops_set_support_shift(true) ->> 'on_shift'; COMMIT;" > "$O3" &
  await "SELECT (SELECT is_called FROM public.test_started) AND NOT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE application_name = 'on' AND wait_event_type IS DISTINCT FROM 'Lock')"; w3=$?
  run $CDB "$(later_pick p3 3 $R3)" > "$O4" &
  await "$(waiting p3)"; w4=$?
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  r="$(run $CDB "$PICKS")|on:$(cat "$O3")|ordered:$w2$w3$w4|errors:$(outs | grep -o ERROR | wc -l | tr -d ' ')"
  [ "$r" = "1:Melanye,2:Melanye,3:Lete|on:true|ordered:000|errors:0" ] \
    && ok "A18 an operator turning on while picks wait: every call finishes, no deadlock; the next pick gets her" \
    || ko "A18 an operator turning on while picks wait: every call finishes, no deadlock; the next pick gets her" \
          "expected [1:Melanye,2:Melanye,3:Lete|on:true|ordered:000|errors:0], got [$r] $(outs)"
fi

# B14 (lock order): a session holds the ride_assist rows of R1 (OP1's) and R3 (OP2's, unopened for
# 61 s), as an alert or an assist action would. OP1 going off and the tick skip those rows instead of
# waiting for them (lock_timeout would turn a wait into an ERROR): R2 passes to OP2, R1 stays OP1's,
# R3 stays OP2's. Once the rows are free, the next tick takes R3 (nobody else on: all missed).
B14="B14 a ride whose ride_assist row another session holds is skipped by the handover and the tick, not waited for"
conc_db "$ON_BOTH $(owned $R1 $OP1 10) $(owned $R2 $OP1 10) $(owned $R3 $OP2 61)"
if [ "$(run $CDB "SELECT to_regprocedure('public.support_handoff_tick()') IS NOT NULL")" != t ]; then
  ko "$B14" "no support_handoff_tick"
  ko "B14b a help request and an operator coming on at once: no deadlock" "no support_handoff_tick"
  ko "B14c the cron's wait alerts and a help request on one of those rides at once: no deadlock" "no support_handoff_tick"
else
  : > "$O1"
  run $CDB "SET application_name = 'holder'; BEGIN;
    SELECT 1 FROM public.ride_assist WHERE ride_id IN ('$R1', '$R3') FOR UPDATE;
    $(signal test_picked)
    DO \$\$ BEGIN FOR i IN 1..600 LOOP EXIT WHEN (SELECT is_called FROM public.test_go); PERFORM pg_sleep(0.05); END LOOP; END \$\$;
    COMMIT;" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  off=$(run $CDB "SET lock_timeout = '3s'; BEGIN; $(as_user $OP1)
    SELECT j ->> 'handed_over' || ',' || (j ->> 'kept') FROM (SELECT public.ops_set_support_shift(false) AS j) x; COMMIT;")
  tick=$(run $CDB "SET lock_timeout = '3s'; SELECT public.support_handoff_tick();")
  held=$(run $CDB "$(owner $R1) $(owner $R2) $(owner $R3)")
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  after=$(run $CDB "SET lock_timeout = '3s'; SELECT public.support_handoff_tick();
    SELECT string_agg(label, ',' ORDER BY id) FROM public.test_pushes;")
  r="off:$off|tick:$tick|owners:$held|then:$after|errors:$(grep -o ERROR "$O1" | wc -l | tr -d ' ')"
  want="off:1,1|tick:0|owners:Lete;Melanye;Melanye|then:1;support-handoff,support-all-missed|errors:0"
  [ "$r" = "$want" ] && ok "$B14" || ko "$B14" "expected [$want], got [$r] $(cat "$O1")"

  # B14b (the deadlock the lock order prevents): R1 was wait-alerted while nobody was on shift (no
  # owner). Melanye's switch has taken the support lock ('on' holds it, as ops_set_support_shift
  # does before its pickup). The rider taps help: request_ride_help holds R1's ride_assist row and
  # waits for the lock in _support_pick_owner. Then the pickup runs: it must skip R1, not wait for
  # it. Once she commits, the help alert gets the lock and gives R1 to her.
  B14b="B14b a help request and an operator coming on at once: no deadlock; the help alert gives her the ride"
  conc_db "INSERT INTO public.support_staff (user_id, whatsapp_phone, on_shift) VALUES
      ('$OP1', '+5355123456', false), ('$OP2', '+5355123457', false);
    $(alerted $R1 wait)"
  : > "$O1"; : > "$O2"
  run $CDB "SET application_name = 'on'; BEGIN;
    SELECT pg_advisory_xact_lock(6790000000001);
    $(signal test_picked)
    DO \$\$ BEGIN FOR i IN 1..600 LOOP EXIT WHEN (SELECT is_called FROM public.test_go); PERFORM pg_sleep(0.05); END LOOP; END \$\$;
    $(as_user $OP2) SELECT public.ops_set_support_shift(true) ->> 'picked_up'; COMMIT;" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  run $CDB "SET application_name = 'help'; BEGIN; $(as_user $CUS)
    SELECT public.request_ride_help('$R1') ->> 'support_phone'; COMMIT;" > "$O2" &
  await "$(waiting help)"; wh=$?
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  r="on:$(grep -v ERROR "$O1" | paste -sd' ' -)|help:$(grep -v ERROR "$O2" | paste -sd' ' -)|help waited:$([ $wh -eq 0 ] && echo yes || echo no)"
  r="$r|owner:$(run $CDB "$(owner $R1)")|pushes:$(run $CDB "$PUSHES")|errors:$(cat "$O1" "$O2" | grep -o ERROR | wc -l | tr -d ' ')"
  want="on:0|help:+5355123457|help waited:yes|owner:Melanye|pushes:support-owner-alert:Melanye|errors:0"
  [ "$r" = "$want" ] && ok "$B14b" || ko "$B14b" "expected [$want], got [$r] $(cat "$O1" "$O2" | paste -sd' ' -)"

  # B14c (Ruling 10): the cron alerts R1 and R2 (both waiting, OP1 on shift) while R2's rider taps
  # help. A session holds the support lock so the steps line up: the cron starts and waits for the
  # lock, then the help request starts and waits too; then the lock is let go. Before the fix the
  # cron took the lock alerting R1 and then waited for R2's row, which the help request held while it
  # waited for the lock: 40P01, and a lost alert. Now the cron writes every row before its first
  # alert, so the help request waits for the cron's commit and then sends its push.
  B14c="B14c the cron's wait alerts and a help request on one of those rides at once: no deadlock; the help push is sent"
  conc_db "$ON1
    UPDATE public.rides SET created_at = now() - CASE id WHEN '$R1' THEN interval '3 minutes' ELSE interval '2 minutes' END;
    UPDATE public.rides SET status = 'completed' WHERE id IN ('$R3', '$R4');"
  : > "$O1"; : > "$O2"; : > "$O3"
  run $CDB "SET application_name = 'lock'; BEGIN; SELECT pg_advisory_xact_lock(6790000000001);
    $(signal test_picked)
    DO \$\$ BEGIN FOR i IN 1..600 LOOP EXIT WHEN (SELECT is_called FROM public.test_go); PERFORM pg_sleep(0.05); END LOOP; END \$\$;
    COMMIT;" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  run $CDB "SET application_name = 'cron'; SELECT public.notify_support_waiting_rides();" > "$O2" &
  await "$(waiting cron)"; wcron=$?
  run $CDB "SET application_name = 'help'; BEGIN; $(as_user $CUS)
    SELECT public.request_ride_help('$R2') ->> 'support_phone'; COMMIT;" > "$O3" &
  await "$(waiting help)"; whelp=$?
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  r="cron:$(grep -v -e ERROR -e WARNING "$O2" | paste -sd' ' -)|help:$(grep -v -e ERROR -e WARNING "$O3" | paste -sd' ' -)"
  r="$r|waited:$wcron$whelp|titles:$(run $CDB "$TITLES")|errors:$(cat "$O1" "$O2" "$O3" | grep -c -e ERROR -e 40P01)"
  want="cron:2|help:+5355123456|waited:00|titles:Te toca · $TITLE_WAIT,Te toca · $TITLE_WAIT,Te toca · $TITLE_HELP|errors:0"
  [ "$r" = "$want" ] && ok "$B14c" || ko "$B14c" "expected [$want], got [$r] $(cat "$O1" "$O2" "$O3" | paste -sd' ' -)"
fi

# C8 (Ruling 5): opening and taking a ride write support_staff (her missed rides) only under the
# support lock. A session holds it; OP1 opening R1 (hers) and OP2 taking R2 (OP1's) are each seen
# waiting for it, and both finish once it is let go.
C8="C8 opening and taking write support_staff only under the support lock: each waits for it, then finishes"
conc_db "$ON_BOTH $(owned $R1 $OP1 30) $(owned $R2 $OP1 30) UPDATE public.support_staff SET missed_in_a_row = 1;"
if [ "$(run $CDB "SELECT to_regprocedure('public.ops_take_ride_assist(uuid,uuid)') IS NOT NULL")" != t ]; then
  ko "$C8" "no ops_take_ride_assist"
else
  : > "$O1"; : > "$O2"; : > "$O3"
  run $CDB "SET application_name = 'lock'; BEGIN; SELECT pg_advisory_xact_lock(6790000000001);
    $(signal test_picked)
    DO \$\$ BEGIN FOR i IN 1..600 LOOP EXIT WHEN (SELECT is_called FROM public.test_go); PERFORM pg_sleep(0.05); END LOOP; END \$\$;
    COMMIT;" > "$O1" &
  await "SELECT is_called FROM public.test_picked"
  run $CDB "SET application_name = 'open'; BEGIN; $(as_user $OP1)
    SELECT public.ops_open_ride_assist('$R1') ->> 'is_owner'; COMMIT;" > "$O2" &
  await "$(waiting open)"; wopen=$?
  run $CDB "SET application_name = 'take'; BEGIN; $(as_user $OP2)
    SELECT public.ops_take_ride_assist('$R2', '$OP1') ->> 'success'; COMMIT;" > "$O3" &
  await "$(waiting take)"; wtake=$?
  run $CDB "SELECT setval('public.test_go', 1)" >/dev/null
  wait
  r="open:$(cat "$O2")|take:$(cat "$O3")|waited:$wopen$wtake|owners:$(run $CDB "$(owner $R1) $(owner $R2)")"
  r="$r|missed:$(run $CDB "$MISSED")|errors:$(cat "$O1" "$O2" "$O3" | grep -c ERROR)"
  want="open:true|take:true|waited:00|owners:Lete;Melanye|missed:Lete=0,Melanye=0|errors:0"
  [ "$r" = "$want" ] && ok "$C8" || ko "$C8" "expected [$want], got [$r] $(cat "$O1" "$O2" "$O3" | paste -sd' ' -)"
fi
rm -f "$O1" "$O2" "$O3" "$O4"
dropdb $CDB

if [ "$MIG" != none ]; then
  CRLF=$(mktemp); sed 's/$/\r/' "$FILE" > "$CRLF"
  mkdb ${DB}crlf
  r=$(apply ${DB}crlf "$CRLF"); [ "$r" = applied ] && ok "R1 a CRLF copy applies" || ko "R1 a CRLF copy applies" "$r"
  val "R2 the CRLF copy leaves the same bodies, without carriage returns" \
      "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
      "$(run $DB "$BODIES");0" ${DB}crlf
  rm -f "$CRLF"

  neg(){ # neg NAME EXPECTED_ERROR FILE
    mkdb ${DB}neg
    local r; r=$(apply ${DB}neg "$3")
    if echo "$r" | grep -q -- "$2"; then ok "$1"; else ko "$1" "expected [$2], got [$r]"; fi
  }
  BAD=$(mktemp)
  sed 's/^GRANT SELECT ON public.support_staff TO authenticated;$/GRANT SELECT, UPDATE ON public.support_staff TO authenticated;/' "$FILE" > "$BAD"
  neg "N1 a support_staff clients can write stops it" "support_staff is not locked down" "$BAD"
  sed 's/^  FROM PUBLIC, anon, authenticated, service_role;$/  FROM PUBLIC, anon, service_role;/' "$FILE" > "$BAD"
  neg "N2 a helper open to clients stops it" "the helpers are open to clients" "$BAD"
  sed 's/^  FROM PUBLIC, anon;$/  FROM PUBLIC;/' "$FILE" > "$BAD"
  neg "N3 a panel RPC open to anon stops it" "the RPCs have the wrong grants" "$BAD"
  # C7: part 3's self-check, each on a broken copy.
  sed 's/^DO \$check\$$/DROP FUNCTION public.ops_take_ride_assist(uuid, uuid);\n&/' "$FILE" > "$BAD"
  neg "C7a a function missing at the check stops it" "ops_take_ride_assist(uuid,uuid) is missing" "$BAD"
  sed 's/ops_take_ride_assist(uuid, uuid) TO authenticated/ops_take_ride_assist(uuid, uuid) TO anon, authenticated/' "$FILE" > "$BAD"
  neg "C7b anon able to execute an ops_ function stops it" "anon can execute .*ops_open_ride_assist(uuid)" "$BAD"
  sed 's/^ALTER TABLE public.support_staff ENABLE ROW LEVEL SECURITY;$/ALTER TABLE public.support_staff DISABLE ROW LEVEL SECURITY;/' "$FILE" > "$BAD"
  neg "C7c RLS off on support_staff stops it" "RLS is off on support_staff" "$BAD"
  sed "s/^SELECT cron.schedule('support-handoff-tick'/-- &/" "$FILE" > "$BAD"
  neg "C7d the cron job missing stops it" "the support-handoff-tick job is missing" "$BAD"
  rm -f "$BAD"
  for d in ${DB}crlf ${DB}neg; do dropdb $d; done
else
  for c in "C7a a function missing at the check stops it" "C7b anon able to execute an ops_ function stops it" \
           "C7c RLS off on support_staff stops it" "C7d the cron job missing stops it"; do
    ko "$c" "no migration applied"
  done
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
