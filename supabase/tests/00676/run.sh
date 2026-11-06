#!/usr/bin/env bash
# Rehearsal runner for migration 00676 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00676/run.sh none
#       -> scaffold (prod's fleet tables, policies, triggers and function bodies) + tests
#          (RED: nothing announces an invitation, and the functions do not exist)
#   supabase/tests/00676/run.sh supabase/migrations/00676_fleet_invitations.sql
#       -> the same + migration x2 (idempotency) + tests + the cases that need two sessions + a CRLF
#          copy + no default privileges + negative proofs (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner, with search_path = ''.
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00676/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
# The SQL files are UTF-8; psql on Windows reads them in the console code page otherwise. LC_MESSAGES
# keeps psql's own labels in English for the greps below.
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB=pr676
SCAFFOLD="$DIR/scaffold.sql"
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# psql on DBNAME; errors show their SQLSTATE. On Windows psql ends its lines with \r\n.
run(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME SQL EXPECTED [DBNAME] -> the printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }

ANA=a6760000-0000-4000-8000-000000000001    # owner of the pending fleet
BETO=a6760000-0000-4000-8000-000000000002   # owner of the approved fleet
OLGA=a6760000-0000-4000-8000-000000000003   # operator
CAP=c6760000-0000-4000-8000-00000000000a    # company still pending
PA1=f6760000-0000-4000-8000-0000000000a1    # in the pending company, a number nobody holds
B1=f6760000-0000-4000-8000-0000000000b1     # in the approved company, a number nobody holds
B8=f6760000-0000-4000-8000-0000000000b8     # the same number in two spellings
B9=f6760000-0000-4000-8000-0000000000b9
ACCT=e6760000-0000-4000-8000-000000000011   # an account created during a test

as(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
approve(){ echo "UPDATE public.fleet_members SET status = 'approved' WHERE id = '$1';"; }
APPROVE_COMPANY="UPDATE public.corporate_accounts SET status = 'approved' WHERE id = '$CAP';"
PANEL_COMPANY="$(as $OLGA) SELECT public.ops_review_fleet_account('$CAP', 'approved', 'pending');"
PANEL_MEMBER="$(as $OLGA) SELECT public.ops_review_fleet_member('$PA1', 'approved', (SELECT to_jsonb(m) FROM public.fleet_members m WHERE m.id = '$PA1'));"
RESEND="$(as $BETO) SELECT COALESCE(public.resend_fleet_invite('$B1') ->> 'error', 'sent');"
SMS="SELECT count(*) FROM public.cron_http_calls WHERE jobname = 'fleet-invite-sms'"
BACKDATE="UPDATE public.fleet_invite_sends SET sent_at = sent_at - interval '25 hours'"
LOGGED="SELECT string_agg(rpc_name || ':' || outcome || ':' || (metadata ->> 'sqlstate'), ',') FROM public.rpc_attempt_log"

fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -f "$SCAFFOLD" 2>&1 | tr -d '\r' | grep -m3 -E 'ERROR|FATAL'
         [ "${PIPESTATUS[0]}" -eq 0 ]; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
# suite DBNAME -> the PASS and FAIL lines of tests.sql
suite(){ $BIN/psql $CONN -d "$1" -qAt -f "$DIR/tests.sql" 2>/dev/null | tr -d '\r' | grep -E '^(PASS|FAIL)  '; }

# overlap DBNAME FIRST SECOND [HOLD] -> FIRST runs in one session, which stays open HOLD seconds
# (1.5 by default); 0.4 s in, SECOND runs in another session. SECOND's output, or its error, lands
# in SECOND_OUT.
overlap(){ local a
  $BIN/psql $CONN -d "$1" -qAt -c "BEGIN; $2 SELECT pg_sleep(${4:-1.5}); COMMIT;" >/dev/null 2>&1 & a=$!
  sleep 0.4
  SECOND_OUT=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "BEGIN; $3 COMMIT;" 2>&1 | tr -d '\r' \
               | grep -v -E '^(WARNING|LOCATION):' | sed '/^$/d' | paste -sd';' -)
  wait $a; }
# base DBNAME [FILE] -> a fresh database with FILE, the migration under test by default
base(){ fresh "$1" || return 1
        local f="${2:-$MIG}"; [ "$f" = none ] || [ "$(apply_err "$1" "$f")" = applied ]; }

# The cases that need two sessions. Each one starts from a fresh database.
two_sessions(){ local D=${DB}r
  base $D
  overlap $D "$APPROVE_COMPANY" "$(approve $PA1)"
  val "R1 the company approval is in flight when the driver is approved: one SMS, sent by the driver's side" "$SMS" "1" $D
  base $D
  overlap $D "$(approve $PA1)" "$APPROVE_COMPANY"
  val "R2 the driver's approval is in flight when the company is approved: one SMS, sent by the company's side" "$SMS" "1" $D
  base $D
  overlap $D "$PANEL_COMPANY" "$PANEL_MEMBER"
  val "R3 R1 through the panel" "$SMS" "1" $D
  base $D
  overlap $D "$PANEL_MEMBER" "$PANEL_COMPANY"
  val "R4 R2 through the panel" "$SMS" "1" $D
  base $D
  overlap $D "$(approve $B8)" "$(approve $B9)"
  val "R5 one number in two spellings, approved at once: one SMS" "$SMS" "1" $D
  base $D
  run $D "$(approve $B1) $BACKDATE" >/dev/null
  overlap $D "$RESEND" "$RESEND"
  [ "$SECOND_OUT" = too_soon ] && ok "R6 a double tap on resend: the second answers too_soon" || ko "R6 a double tap on resend: the second answers too_soon" "got [$SECOND_OUT]"
  val "R7 ...and only one more SMS goes out" "$SMS" "2" $D
  base $D
  run $D "$(approve $B1) INSERT INTO auth.users (id, phone) VALUES ('$ACCT', '5355530001')" >/dev/null
  overlap $D "LOCK TABLE public.notification_preferences IN ACCESS EXCLUSIVE MODE;" \
    "UPDATE auth.users SET phone_confirmed_at = now() WHERE id = '$ACCT'; SELECT extract(epoch FROM clock_timestamp() - now()) < 3;" 4
  [ "$SECOND_OUT" = t ] && ok "R8 a lock wait in the notice does not hold a login past lock_timeout" || ko "R8 a lock wait in the notice does not hold a login past lock_timeout" "got [$SECOND_OUT]"
  val "R9 ...the login and the link stand, and the wait is logged" \
    "SELECT phone_confirmed_at IS NOT NULL FROM auth.users WHERE id = '$ACCT';
     SELECT status FROM public.fleet_members WHERE id = '$B1'; $LOGGED" \
    "t;active;_fleet_push:push_failed:55P03" $D
  base $D
  overlap $D "$APPROVE_COMPANY" "$(approve $PA1) SELECT extract(epoch FROM clock_timestamp() - now()) < 3;" 4
  [ "$SECOND_OUT" = t ] && ok "R10 a company review stuck past lock_timeout does not hold the driver's approval" || ko "R10 a company review stuck past lock_timeout does not hold the driver's approval" "got [$SECOND_OUT]"
  val "R11 ...the approval stands, nothing went out, and it is logged" \
    "SELECT status FROM public.fleet_members WHERE id = '$PA1'; $SMS; $LOGGED" \
    "approved;0;_fleet_announce_member:announce_failed:55P03" $D
  val "R12 ...and the owner's resend recovers it" \
    "BEGIN; $(as $ANA) SELECT public.resend_fleet_invite('$PA1') ->> 'success'; COMMIT; $SMS" "true;1" $D
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $D" >/dev/null 2>&1; }

echo "== reset database =="
fresh $DB || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != none ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M1 the migration applies" || { ko "M1 the migration applies" "$r"; echo "== $PASS passed, $FAIL failed =="; exit 1; }
  echo "== apply migration (2nd, idempotency) =="
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M2 the migration applies again" || ko "M2 the migration applies again" "$r"
  val "M3 its self-test leaves no call, no queue row, no log row and no fixture" \
    "SELECT count(*) FROM public.cron_http_calls; SELECT count(*) FROM net.http_request_queue;
     SELECT count(*) FROM public.rpc_attempt_log; SELECT count(*) FROM public.fleet_invite_sends;
     SELECT count(*) FROM public.corporate_accounts WHERE name LIKE '00676%'" "0;0;0;0;0"
  fresh ${DB}m
  r=$($BIN/psql $CONN -d ${DB}m -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$MIG" -c "SHOW lock_timeout" -c "SHOW search_path" -c "SELECT current_user" \
        -c "SELECT coalesce(current_setting('request.jwt.claim.sub', true), '') || coalesce(current_setting('request.jwt.claims', true), '')" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -)
  [ "$r" = '0;"";postgres' ] && ok "M4 the migration leaves no lock_timeout, role or JWT behind" \
    || ko "M4 the migration leaves no lock_timeout, role or JWT behind" "got [$r]"
  fresh ${DB}m
  run ${DB}m "TRUNCATE auth.users, public.users CASCADE" >/dev/null
  r=$(apply_err ${DB}m "$MIG"); [ "$r" = applied ] && ok "M5 a database with no accounts skips the self-test" || ko "M5 a database with no accounts skips the self-test" "$r"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}m" >/dev/null 2>&1
fi

echo "== one session =="
DECLARED=$(grep -c '^SELECT t.case(' "$DIR/tests.sql")
RESULTS=$(suite $DB)
while IFS= read -r line; do
  echo "$line"
  case "$line" in PASS*) PASS=$((PASS+1));; FAIL*) FAIL=$((FAIL+1));; esac
done <<< "$RESULTS"
RAN=$(echo "$RESULTS" | grep -c -E '^(PASS|FAIL)  ')
[ "$RAN" = "$DECLARED" ] && ok "T0 every case of tests.sql ran ($RAN)" || ko "T0 every case of tests.sql ran" "declared $DECLARED, ran $RAN"

echo "== two sessions =="
two_sessions

if [ "$MIG" != none ]; then
  T=$(mktemp -d)
  "$PY" - "$MIG" "$T" <<'PYEOF'
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8', newline='').read().replace('\r\n', '\n')
GATE = 'IF v_row.got <> v_row.want THEN'
LOCK_CHECK = "NOT 'lock_timeout=2s' = ANY (COALESCE(p.proconfig, '{}'))"
def write(name, text):
    open(f'{out}/{name}.sql', 'w', encoding='utf-8', newline='').write(text)
def variant(name, *pairs, loose=False):
    v = s
    for old, new in pairs:
        assert v.count(old) == 1, (name, old, v.count(old))
        v2 = v.replace(old, new); assert v2 != v, name; v = v2
    if loose:
        assert v.count(GATE) == 1, name
        v = v.replace(GATE, 'IF false THEN')
    write(name, v)
write('crlf', s.replace('\n', '\r\n'))

NOTIFY_LOCK = (" SET lock_timeout TO '2s'\nAS $function$\nDECLARE\n  v_owner  uuid;\n  v_person text;",
               "AS $function$\nDECLARE\n  v_owner  uuid;\n  v_person text;")
ANNOUNCE_LOCK = (" SET lock_timeout TO '2s'\nAS $function$\nDECLARE\n  c_daily_sms",
                 "AS $function$\nDECLARE\n  c_daily_sms")
PUSH_HANDLER = ("EXCEPTION WHEN OTHERS THEN\n"
                "  RAISE WARNING '_fleet_push(%, %): % %', p_user_id, p_event, SQLSTATE, SQLERRM;\n"
                "  PERFORM public.log_rpc_attempt('_fleet_push', NULL, p_target, 'push_failed',\n"
                "    jsonb_build_object('user_id', p_user_id, 'event', p_event, 'sqlstate', SQLSTATE, 'error', SQLERRM));\n"
                "END\n", "END\n")
FIRST_SMS_CHECK = "       WHERE s.fleet_id = v_fleet AND s.phone = v_phone AND s.channel = 'sms') THEN\n    RETURN 'already_contacted';"
MEMBER_CHECK = ("  IF p_source = 'review' AND EXISTS (\n"
                "       SELECT 1 FROM public.fleet_invite_sends s WHERE s.member_id = p_member_id) THEN\n"
                "    RETURN 'already_contacted';\n"
                "  END IF;\n")
LEAVE_UPDATE = ("  UPDATE public.fleet_members SET status = 'inactive'\n"
                "  WHERE fleet_id = v_fleet AND driver_id = v_me AND status IN ('active', 'approved', 'pending_signup');\n")

# What the self-checks have to refuse.
variant('no_client_revoke', ("REVOKE ALL ON FUNCTION public.resend_fleet_invite(uuid),\n"
                             "                       public.leave_fleet(uuid),\n"
                             "                       public.get_my_fleet_memberships()\n"
                             "  FROM PUBLIC, anon;\n", ''))
variant('no_helper_revoke', ("REVOKE ALL ON FUNCTION public._fleet_invite_sms_text(text),\n"
                             "                       public._fleet_push(uuid, uuid, text, text, text),\n"
                             "                       public._fleet_announce_member(uuid, text),\n"
                             "                       public.tg_fleet_members_notify(),\n"
                             "                       public.tg_corporate_accounts_fleet_notify()\n"
                             "  FROM PUBLIC, anon, authenticated, service_role;\n", ''))
variant('no_client_grant', ("GRANT EXECUTE ON FUNCTION public.resend_fleet_invite(uuid),\n"
                            "                          public.leave_fleet(uuid),\n"
                            "                          public.get_my_fleet_memberships()\n"
                            "  TO authenticated, service_role;\n",
                            "REVOKE ALL ON FUNCTION public.leave_fleet(uuid) FROM authenticated;\n"))
variant('no_rls', ('ALTER TABLE public.fleet_invite_sends ENABLE ROW LEVEL SECURITY;\n', ''))
variant('no_policy', ("                   AND policyname = 'fleet_invite_sends_owner_select') THEN\n"
                      "    CREATE POLICY fleet_invite_sends_owner_select ON public.fleet_invite_sends",
                      "                   AND policyname = 'zz_other') THEN\n"
                      "    CREATE POLICY zz_other ON public.fleet_invite_sends"))
variant('second_policy', ('-- pg_default_acl still opens', 'CREATE POLICY zz_open ON public.fleet_invite_sends FOR SELECT USING (true);\n-- pg_default_acl still opens'))
variant('no_table_revoke', ('REVOKE ALL ON public.fleet_invite_sends FROM PUBLIC, anon, authenticated;\n', ''))
variant('no_read_grant', ('REVOKE ALL ON public.fleet_invite_sends FROM PUBLIC, anon, authenticated;\nGRANT SELECT ON public.fleet_invite_sends TO authenticated;\n',
                          'REVOKE ALL ON public.fleet_invite_sends FROM PUBLIC, anon, authenticated;\n'))
variant('no_service_grant', ('GRANT ALL ON public.fleet_invite_sends TO service_role;\n', 'REVOKE ALL ON public.fleet_invite_sends FROM service_role;\n'))
variant('no_sms_key', ("CREATE UNIQUE INDEX IF NOT EXISTS fleet_invite_sends_first_sms_key\n"
                       "  ON public.fleet_invite_sends (fleet_id, phone) WHERE channel = 'sms' AND source = 'review';\n", ''))
variant('no_push_key', ("CREATE UNIQUE INDEX IF NOT EXISTS fleet_invite_sends_first_push_key\n"
                        "  ON public.fleet_invite_sends (member_id) WHERE channel = 'push';\n", ''))
variant('changed_body', ('  WHERE ca.id = v_account\n  FOR SHARE;', '  WHERE ca.id = v_account;'))
variant('by_column', ('  AFTER UPDATE ON public.fleet_members\n', '  AFTER UPDATE OF driver_id, status ON public.fleet_members\n'))
variant('no_when', ("  WHEN (OLD.status = 'active')\n", ''))
variant('no_delete_trigger', ("CREATE OR REPLACE TRIGGER trg_fleet_members_notify_delete\n"
                              "  AFTER DELETE ON public.fleet_members\n"
                              "  FOR EACH ROW\n"
                              "  WHEN (OLD.status = 'active')\n"
                              "  EXECUTE FUNCTION public.tg_fleet_members_notify();\n", ''))
variant('no_company_trigger', ("CREATE OR REPLACE TRIGGER trg_corporate_accounts_fleet_notify\n"
                               "  AFTER UPDATE ON public.corporate_accounts\n"
                               "  FOR EACH ROW\n"
                               "  WHEN (OLD.status IS DISTINCT FROM NEW.status)\n"
                               "  EXECUTE FUNCTION public.tg_corporate_accounts_fleet_notify();\n", ''))
variant('trigger_off', ('-- Pasted from Windows, the SQL Editor', 'ALTER TABLE public.fleet_members DISABLE TRIGGER trg_fleet_members_notify;\n-- Pasted from Windows, the SQL Editor'))
variant('no_notice_lock', NOTIFY_LOCK)
variant('notice_invoker', ("                                              p_title text, p_body text)\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER\n",
                           "                                              p_title text, p_body text)\n RETURNS void\n LANGUAGE plpgsql\n"))
variant('client_invoker', ("CREATE OR REPLACE FUNCTION public.leave_fleet(p_member_id uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n",
                           "CREATE OR REPLACE FUNCTION public.leave_fleet(p_member_id uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n"))
variant('long_text', ("RETURN 'TriciGo: una flota te espera como conductor. Baja", "RETURN 'TriciGo: una flota de conductores te espera en la ciudad de La Habana, con mucho trabajo por delante. Baja"), loose=True)
variant('accented_text', ("RETURN 'TriciGo: una flota te espera como conductor. Baja", "RETURN 'TriciGo: una flota te espera, ¿vienes? Baja"), loose=True)

# What the behaviour self-test has to refuse.
variant('never_announces', ("        PERFORM public._fleet_announce_member(v_member, 'review');\n", '        NULL;\n'), loose=True)
variant('announces_while_pending', ("  IF v_company IS DISTINCT FROM 'approved' THEN\n    RETURN 'company_not_approved';\n  END IF;\n", ''), loose=True)
variant('forgets_the_first_contact',
        ("  IF v_send IS NULL THEN\n    RETURN 'already_contacted';\n  END IF;\n  PERFORM public.cron_http_post('fleet-invite-sms',",
         "  IF v_send IS NULL THEN\n    RETURN 'sent_sms';\n  END IF;\n  PERFORM public.cron_http_post('fleet-invite-sms',"),
        (FIRST_SMS_CHECK, FIRST_SMS_CHECK.replace("'already_contacted'", "'sent_sms'")),
        (MEMBER_CHECK, MEMBER_CHECK.replace("'already_contacted'", "'sent_sms'")), loose=True)
variant('no_gap', ("  IF v_last > now() - c_gap THEN\n    RETURN jsonb_build_object('error', 'too_soon', 'retry_at', v_last + c_gap);\n  END IF;\n", ''), loose=True)
variant('not_trusted', ("  PERFORM set_config('app.trusted_fleet_update', '1', true);\n", ''), loose=True)

# What the tests have to catch. The md5 gate is off, so each of these applies.
variant('no_share', ('  WHERE ca.id = v_account\n  FOR SHARE;', '  WHERE ca.id = v_account;'), loose=True)
variant('no_fleet_lock', ('  WHERE fm.id = p_member_id\n  FOR NO KEY UPDATE OF df;', '  WHERE fm.id = p_member_id;'), loose=True)
variant('no_wait_limit', NOTIFY_LOCK, ANNOUNCE_LOCK, (LOCK_CHECK, 'false'), loose=True)
variant('push_raises', PUSH_HANDLER, loose=True)
variant('notice_raises', PUSH_HANDLER,
        ("  EXCEPTION WHEN OTHERS THEN\n"
         "    RAISE WARNING 'tg_fleet_members_notify(%): % %', OLD.id, SQLSTATE, SQLERRM;\n"
         "    PERFORM public.log_rpc_attempt('tg_fleet_members_notify', NULL, OLD.id, 'notify_failed',\n"
         "      jsonb_build_object('op', TG_OP, 'sqlstate', SQLSTATE, 'error', SQLERRM));\n"
         "  END;\n", '  END;\n'), loose=True)
variant('sms_per_row', (FIRST_SMS_CHECK, "       WHERE s.member_id = p_member_id AND s.channel = 'sms') THEN\n    RETURN 'already_contacted';"),
        ("ON public.fleet_invite_sends (fleet_id, phone) WHERE channel = 'sms' AND source = 'review';",
         "ON public.fleet_invite_sends (member_id) WHERE channel = 'sms' AND source = 'review';"), loose=True)
variant('push_per_number', ("ON public.fleet_invite_sends (member_id) WHERE channel = 'push';", "ON public.fleet_invite_sends (fleet_id, phone) WHERE channel = 'push';"), loose=True)
variant('keeps_accents', ("  v_name text := public._third_party_person_name(\n"
                          "    translate(COALESCE(p_owner_name, ''),\n"
                          "              'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÝýÿÇç',\n"
                          "              'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuYyyCc'));\n",
                          '  v_name text := public._third_party_person_name(p_owner_name);\n'),
        ("  IF v_name IS NULL OR v_name !~ '^[A-Za-zÑñ''. -]+$' THEN\n", '  IF v_name IS NULL THEN\n'), loose=True)
variant('keeps_diaeresis', ("ÉÈÊËéèêëÍ", "ÉÈÊËéèêÍ"), ("EEEEeeeeIIII", "EEEEeeeIIII"), loose=True)
variant('review_ignores_resends', ("  IF p_source = 'review' AND EXISTS (\n"
                                   "       SELECT 1 FROM public.fleet_invite_sends s\n" + FIRST_SMS_CHECK + "\n  END IF;\n", ''), loose=True)
variant('flag_stays', ("  PERFORM set_config('app.trusted_fleet_update', COALESCE(v_trusted, ''), true);\n", ''), loose=True)
variant('tells_any_delete', ("  WHEN (OLD.status = 'active')\n", '  WHEN (OLD.status IS NOT NULL)\n'), loose=True)
variant('twins_in_memberships', ('    SELECT DISTINCT ON (fm.fleet_id)\n', '    SELECT\n'), loose=True)
variant('no_pending_signup', ("  IF v_status NOT IN ('approved', 'pending_signup', 'active') THEN\n    RETURN 'not_invitable';",
                              "  IF v_status NOT IN ('approved', 'active') THEN\n    RETURN 'not_invitable';"), loose=True)
variant('no_daily_cap', ('>= c_daily_sms THEN', '>= 1000000 THEN'), loose=True)
variant('resends_while_pending', ("  IF v_company IS DISTINCT FROM 'approved' OR v_driver IS NOT NULL\n", '  IF v_driver IS NOT NULL\n'), loose=True)
variant('anyone_leaves', ("  IF v_driver IS DISTINCT FROM v_me THEN\n    RETURN jsonb_build_object('error', 'forbidden');\n  END IF;\n", ''), loose=True)
variant('anyone_resends', ("  IF v_owner IS DISTINCT FROM v_me THEN\n    RETURN jsonb_build_object('error', 'forbidden');\n  END IF;\n", ''), loose=True)
variant('no_gsm7_flag', ("'event_type', 'fleet_invite', 'gsm7', true));", "'event_type', 'fleet_invite'));"), loose=True)
variant('gsm7_as_text', ("'event_type', 'fleet_invite', 'gsm7', true));", "'event_type', 'fleet_invite', 'gsm7', 'true'));"), loose=True)
variant('no_member_check', (MEMBER_CHECK, ''), loose=True)
variant('member_check_on_resends', (MEMBER_CHECK, MEMBER_CHECK.replace("p_source = 'review' AND ", '')), loose=True)
variant('leaves_one_row', (LEAVE_UPDATE, "  UPDATE public.fleet_members SET status = 'inactive' WHERE id = p_member_id;\n"), loose=True)
variant('leaves_every_status', (LEAVE_UPDATE, "  UPDATE public.fleet_members SET status = 'inactive' WHERE fleet_id = v_fleet AND driver_id = v_me;\n"), loose=True)
variant('stale_tap_stops', ("  IF v_status NOT IN ('active', 'approved', 'pending_signup', 'inactive') THEN\n",
                            "  IF v_status = 'inactive' THEN\n    RETURN jsonb_build_object('success', true);\n  END IF;\n"
                            "  IF v_status NOT IN ('active', 'approved', 'pending_signup') THEN\n"), loose=True)
variant('pending_signup_listed', ("      AND fm.status IN ('active', 'approved')\n", "      AND fm.status IN ('active', 'approved', 'pending_signup')\n"), loose=True)
variant('any_number', ("  IF v_phone !~ '^[+]53[56][0-9]{7}$' THEN\n    RETURN 'not_cuban_mobile';\n  END IF;\n", ''), loose=True)
PYEOF
  [ -f "$T/any_number.sql" ] || { ko "the broken copies were written" "see the python error above"; echo "== $PASS passed, $FAIL failed =="; exit 1; }
  D=${DB}g
  # refuses NAME FILE PATTERN -> this broken copy does not apply, and says why
  refuses(){ local r; fresh $D; r=$(apply_err $D "$T/$2.sql")
    if echo "$r" | grep -q -- "$3"; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
  # flips NAME FILE CASE -> this broken copy applies, and CASE of tests.sql fails
  flips(){ local r; fresh $D; r=$(apply_err $D "$T/$2.sql")
    if [ "$r" != applied ]; then ko "$1" "$r"; return; fi
    if suite $D | grep -q "^FAIL  $3 "; then ok "$1"; else ko "$1" "case $3 still passes"; fi; }

  echo "== other ways it can be applied =="
  fresh $D; r=$(apply_err $D "$T/crlf.sql"); [ "$r" = applied ] && ok "W1 a copy with CRLF line endings applies" || ko "W1 a copy with CRLF line endings applies" "$r"
  BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('_fleet_invite_sms_text', '_fleet_push', '_fleet_announce_member', 'resend_fleet_invite', 'leave_fleet', 'get_my_fleet_memberships', 'tg_fleet_members_notify', 'tg_corporate_accounts_fleet_notify')"
  val "W2 ...and leaves the same bodies, with no carriage return" \
    "$BODIES; SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND position(chr(13) IN p.prosrc) > 0" \
    "$(run $DB "$BODIES");0" $D
  r=$(suite $D); n=$(echo "$r" | grep -c '^PASS  '); [ "$n" = "$DECLARED" ] && ok "W3 ...and every case of tests.sql passes on it ($n)" || ko "W3 ...and every case of tests.sql passes on it" "$n of $DECLARED: $(echo "$r" | grep '^FAIL' | head -3)"

  SCAFFOLD="$T/no_default_privileges.sql"
  grep -v '^ALTER DEFAULT PRIVILEGES' "$DIR/scaffold.sql" > "$SCAFFOLD"
  fresh $D; r=$(apply_err $D "$MIG"); [ "$r" = applied ] && ok "W4 it applies with no default privileges, as Supabase announced" || ko "W4 it applies with no default privileges, as Supabase announced" "$r"
  r=$(suite $D); n=$(echo "$r" | grep -c '^PASS  '); [ "$n" = "$DECLARED" ] && ok "W5 ...and every case of tests.sql passes there too ($n)" || ko "W5 ...and every case of tests.sql passes there too" "$n of $DECLARED: $(echo "$r" | grep '^FAIL' | head -3)"
  SCAFFOLD="$DIR/scaffold.sql"

  echo "== negative proofs: the self-checks refuse =="
  refuses "N1 a client function left open to anon" no_client_revoke "has the wrong callers"
  refuses "N2 a helper left open to clients" no_helper_revoke "has the wrong callers"
  refuses "N3 a client function closed to clients" no_client_grant "has the wrong callers"
  refuses "N4 no RLS" no_rls "has RLS off"
  refuses "N5 no owner policy" no_policy "exactly the owner"
  refuses "N6 a second policy" second_policy "exactly the owner"
  refuses "N7 the table left open to anon" no_table_revoke "has the wrong grants"
  refuses "N8 the table closed to the owner" no_read_grant "has the wrong grants"
  refuses "N9 the table closed to the service role" no_service_grant "has the wrong grants"
  refuses "N10 no key for the first SMS" no_sms_key "a first-contact key is missing"
  refuses "N11 no key for the first push" no_push_key "a first-contact key is missing"
  refuses "N12 a body that is not the rehearsed one" changed_body "_fleet_announce_member(uuid,text) md5 is"
  refuses "N13 a trigger by column" by_column "trg_fleet_members_notify is not attached as written"
  refuses "N14 a delete trigger with no WHEN" no_when "trg_fleet_members_notify_delete is not attached as written"
  refuses "N15 no delete trigger" no_delete_trigger "trg_fleet_members_notify_delete is not attached as written"
  refuses "N16 no company trigger" no_company_trigger "trg_corporate_accounts_fleet_notify is not attached as written"
  refuses "N17 a trigger left disabled" trigger_off "trg_fleet_members_notify is not attached as written"
  refuses "N18 a notice with no lock_timeout" no_notice_lock "is not SECURITY DEFINER with a lock_timeout"
  refuses "N19 a notice that is not SECURITY DEFINER" notice_invoker "is not SECURITY DEFINER with a lock_timeout"
  refuses "N20 a client function that is not SECURITY DEFINER" client_invoker "a client function is not SECURITY DEFINER"
  refuses "N21 a text over one part" long_text "the SMS is not one GSM-7 part"
  refuses "N22 a text outside GSM-7" accented_text "the SMS is not one GSM-7 part"
  echo "== negative proofs: the behaviour self-test refuses =="
  refuses "N23 a name that keeps its accents" keeps_accents "the SMS is not one GSM-7 part"
  refuses "N24 a company approval that announces nobody" never_announces "approving the company sent 0 SMS"
  refuses "N25 an announcement before the company is approved" announces_while_pending "announced while its company was pending"
  refuses "N26 a first contact that does not see the last one" forgets_the_first_contact "asking again answered sent_sms"
  refuses "N27 a resend with no gap" no_gap "resending at once answered"
  refuses "N28 a leave without the trusted flag" not_trusted "leaving left the row active"

  echo "== negative proofs: the tests catch =="
  base $D "$T/no_share.sql"; overlap $D "$APPROVE_COMPANY" "$(approve $PA1)"
  val "X1 without FOR SHARE the first contact is lost when the company goes first" "$SMS" "0" $D
  base $D "$T/no_share.sql"; overlap $D "$(approve $PA1)" "$APPROVE_COMPANY"
  val "X2 and when the driver goes first" "$SMS" "0" $D
  base $D "$T/no_fleet_lock.sql"
  run $D "$(approve $B1) $BACKDATE" >/dev/null
  overlap $D "$RESEND" "$RESEND"
  val "X3 without the fleet lock a double tap sends twice" "$SMS" "3" $D
  base $D "$T/no_wait_limit.sql"
  overlap $D "$APPROVE_COMPANY" "$(approve $PA1) SELECT extract(epoch FROM clock_timestamp() - now()) < 3;" 4
  [ "$SECOND_OUT" = f ] && ok "X4 without lock_timeout a stuck company review holds the approval" || ko "X4 without lock_timeout a stuck company review holds the approval" "got [$SECOND_OUT]"
  flips "X5 a push that raises takes the first contact down (C5)" push_raises "C5"
  flips "X6 a notice that raises loses the link at login (C6)" notice_raises "C6"
  flips "X7 limits kept per row reset on delete (D1)" sms_per_row "D1"
  flips "X8 a push kept per number does not tell a driver invited again (D6)" push_per_number "D6"
  flips "X9 a letter left out of the accent table drops the name (E3)" keeps_diaeresis "E3"
  flips "X10 a flag left set (H4)" flag_stays "H4"
  flips "X11 ...lets the owner undo the leave (H6)" flag_stays "H6"
  flips "X12 a delete trigger for any status (I12)" tells_any_delete "I12"
  flips "X13 memberships with no DISTINCT ON (J4)" twins_in_memberships "J4"
  flips "X14 pending_signup left out (A7)" no_pending_signup "A7"
  flips "X15 no daily cap (F12)" no_daily_cap "F12"
  flips "X16 a resend for a company not approved (F7)" resends_while_pending "F7"
  flips "X17 anyone leaves anyone's row (H2)" anyone_leaves "H2"
  flips "X18 anyone resends (F4)" anyone_resends "F4"
  flips "X19 any number gets the SMS (G1)" any_number "G1"
  flips "X20 a new invitation of a number that ignores a resend (D10)" review_ignores_resends "D10"
  flips "X21 an SMS that does not ask for GSM-7 (E11)" no_gsm7_flag "E11"
  flips "X22 a flag sent as a string, which send-sms would not read as true (E12)" gsm7_as_text "E12"
  flips "X23 no check per invitation: a passenger turned driver hears again (A15)" no_member_check "A15"
  flips "X24 ...a suspended driver gets the SMS (A16)" no_member_check "A16"
  flips "X25 ...and so does someone who deleted the account (A17)" no_member_check "A17"
  flips "X26 the check stopping a resend too (F1)" member_check_on_resends "F1"
  flips "X27 leaving one row of two (H11)" leaves_one_row "H11"
  flips "X28 leaving rewrites a rejected row (H12)" leaves_every_status "H12"
  flips "X29 a tap on a row that left stops there (H13)" stale_tap_stops "H13"
  flips "X30 pending_signup in the list of fleets (J3)" pending_signup_listed "J3"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $D" >/dev/null 2>&1
  rm -rf "$T"
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
