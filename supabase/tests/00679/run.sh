#!/usr/bin/env bash
# Rehearsal runner for migration 00679 (one owner per assisted ride, and the support number from the
# operator on shift). Builds prod's tables (tables.sql) and the helpers 00679 calls, byte for byte
# (live-bodies.sql), on the roles and stubs of scaffold.sql.
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
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($CREATED_LIST)"
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ($CREATED_LIST)"
HELPERS="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('current_user_role', 'is_admin', 'is_operator',
  'is_ops_staff', '_ride_short_code', '_ride_type_label', 'get_platform_config_numeric', 'log_rpc_attempt')"
# md5 of prosrc in prod on 2026-11-07.
PROD_HELPERS="_ride_short_code=7dae14319bfae57a2ac8b4317e928513,_ride_type_label=6334b65ed6bc08e91f9d4cfdee97976e,current_user_role=cb4a7c12d4e21fe2997135833f141e25,get_platform_config_numeric=13d2587037eca74854cf2394ba42a90c,is_admin=22cb75e91980d512498034cd33e1eda2,is_operator=16438eb527af61eaa2d0b3d9a53f08f9,is_ops_staff=d6774e4677be1072e66b247492e9cb9a,log_rpc_attempt=0a902c34a1148dac5686403a7c941bc0"

mkdb $DB
run $DB "$SEED" >/dev/null
val "F0 the scaffold has prod's helper bodies" "$HELPERS" "$PROD_HELPERS"
OTHERS_BEFORE=$(run $DB "$OTHERS")

if [ "$MIG" != none ]; then
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M1 00679 applies (1st)" || ko "M1 00679 applies (1st)" "$r"
  run $DB "UPDATE public.platform_config SET value = '90'::jsonb WHERE key = 'support_handoff_after_s';" >/dev/null
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M2 00679 applies again" || ko "M2 00679 applies again" "$r"
  val "M3 a setting changed in between survives the second apply" \
      "SELECT value FROM public.platform_config WHERE key = 'support_handoff_after_s';
       UPDATE public.platform_config SET value = '60'::jsonb WHERE key = 'support_handoff_after_s';" "90"
  val "M4 no other function changed" "$OTHERS" "$OTHERS_BEFORE"
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
                        = '{\"success\": true, \"on_shift\": true, \"whatsapp_phone\": \"+5355123456\", \"handed_over\": 0, \"kept\": 0}'::jsonb")
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

# ── Two alerts at once (committed state, two sessions) ────────
# The first pick holds its transaction open 3 s; the second starts 1 s in, waits for it, and must
# get the other operator.
mkdb ${DB}conc
run ${DB}conc "$SEED" >/dev/null
[ "$MIG" != none ] && apply ${DB}conc "$FILE" >/dev/null
run ${DB}conc "CREATE TABLE public.test_picks (who text PRIMARY KEY, picked uuid, done_at timestamptz); $ON_BOTH" >/dev/null
run ${DB}conc "BEGIN; INSERT INTO public.test_picks VALUES ('first', public._support_pick_owner('$R1', '{}'), clock_timestamp());
  SELECT pg_sleep(3); COMMIT;" >/dev/null &
run ${DB}conc "SELECT pg_sleep(1); BEGIN; INSERT INTO public.test_picks VALUES ('second', public._support_pick_owner('$R2', '{}'), NULL);
  UPDATE public.test_picks SET done_at = clock_timestamp() WHERE who = 'second'; COMMIT;" >/dev/null &
wait
val "A17 two picks at once go to two operators (the second waited for the first)" \
    "SELECT string_agg(coalesce(u.full_name, 'none'), ',' ORDER BY t.who) FROM public.test_picks t LEFT JOIN public.users u ON u.id = t.picked;
     SELECT (SELECT done_at FROM public.test_picks WHERE who = 'second') - (SELECT done_at FROM public.test_picks WHERE who = 'first') > interval '2 seconds'" \
    "Lete,Melanye;t" ${DB}conc
dropdb ${DB}conc

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
  rm -f "$BAD"
  for d in ${DB}crlf ${DB}neg; do dropdb $d; done
fi

echo "----"
echo "PASS $PASS  FAIL $FAIL"
[ "$FAIL" -eq 0 ]
