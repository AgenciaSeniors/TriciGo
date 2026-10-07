#!/usr/bin/env bash
# Rehearsal runner for migration 00635 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00635/run.sh none
#       -> scaffold + seed + tests against the live prod bodies (RED: gifts, receipts, bonuses
#          and status e-mails go to addresses nobody proved, a trusted contact's inbox has no
#          cap, and send_gift has no cap and no note limit)
#   supabase/tests/00635/run.sh supabase/migrations/00635_mail_only_proven_addresses.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as postgres, the scaffold's non-superuser owner (as in prod).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00635/run.sh ...
set -u
unset MSYS_NO_PATHCONV
export PGOPTIONS='-c lc_messages=C'
export PGCLIENTENCODING=UTF8
# psql's own labels (DETAIL, CONTEXT) in English too: the R tests match DETAIL.
export LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr635
AS_OWNER="SET SESSION AUTHORIZATION postgres; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run $DB "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
has(){ local r; r=$(run $DB "$2"); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $r"; fi; }

ANA=a0000000-0000-4000-8000-000000000001     # gift sender, 1 000 000 CUP
BETO=a0000000-0000-4000-8000-000000000002    # another sender
ADA=a0000000-0000-4000-8000-000000000003     # admin
VICTIM=c0000000-0000-4000-8000-000000000001  # victim@x.test, typed, never confirmed
FLAG=c0000000-0000-4000-8000-000000000002    # flag@x.test, confirmed (email_verified_at)
GMAIL=c0000000-0000-4000-8000-000000000003   # gmail@x.test, same address on a verified Google identity
CASE=c0000000-0000-4000-8000-000000000004    # ' Case@X.test ', Google identity case@x.test
GX=c0000000-0000-4000-8000-000000000005      # victim2@x.test, Google identity own@x.test
GF=c0000000-0000-4000-8000-000000000006      # gf@x.test, Google identity NOT verified by Google
APPLE=c0000000-0000-4000-8000-000000000007   # relay@privaterelay.test, Apple identity ("true" as a string)
PW=c0000000-0000-4000-8000-000000000008      # pw@x.test, password identity only
NONE=c0000000-0000-4000-8000-000000000009    # no address
DUNV=d0000000-0000-4000-8000-0000000000a1    # driver, dunv@x.test, never confirmed
DVER=d0000000-0000-4000-8000-0000000000a2    # driver, dver@x.test, confirmed
DP_UNV=d1000000-0000-4000-8000-0000000000a1
DP_VER=d1000000-0000-4000-8000-0000000000a2
RITA=e0000000-0000-4000-8000-000000000001    # full_name with a link; contacts friend@ (twice), second@, a phone
RAUL=e0000000-0000-4000-8000-000000000002    # trusted contact ' Friend@X.test'
THIEF=c0000000-0000-4000-8000-00000000000a   # typed gmail@x.test, the address of GMAIL's Google identity

# mails ADDRESS TEMPLATE -> requests queued for send-email to ADDRESS with TEMPLATE
mails(){ printf "SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/send-email' AND body->>'recipient_email' = '%s' AND body->>'template' = '%s';" "$1" "$2"; }
# sends URLPART -> requests queued for that function
sends(){ printf "SELECT count(*) FROM net.http_request_queue WHERE url LIKE '%%/%s';" "$1"; }
# as UID ROLE -> the role and JWT subject PostgREST would set for that caller, until RESET ROLE
as(){ printf "SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s;" "$1" "$2"; }
# gift FROM TO AMOUNT -> FROM gifts TO through the RPC, as the app does
gift(){ printf "%s SELECT public.send_gift('%s', '%s', %s, 'Visita la web de spam') IS NOT NULL; RESET ROLE;" "$(as $1 authenticated)" "$1" "$2" "$3"; }
# complete CUSTOMER MODE -> a ride of CUSTOMER goes in_progress -> completed (as the server does)
complete(){ printf "INSERT INTO public.rides (id, customer_id, driver_id, status, ride_mode) VALUES ('f0000000-0000-4000-8000-00000000000f', '%s', '%s', 'in_progress', '%s');
  UPDATE public.rides SET status = 'completed', completed_at = now(), final_fare_cup = 1500 WHERE id = 'f0000000-0000-4000-8000-00000000000f';" "$1" "$DP_VER" "$2"; }

fresh(){ "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-}" = seed ]; then "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || return 1; fi; }
apply(){ local out rc; out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose ${3:-} -c "$AS_OWNER" -f "$2" 2>&1); rc=$?
         echo "$out" | tr -d '\r'; [ $rc -eq 0 ] && echo applied || echo failed; }
apply_err(){ local r; r=$(apply "$1" "$2" -1); if [ "$(echo "$r" | tail -1)" = applied ]; then echo applied; else echo "$r" | grep -m1 ERROR; fi; }
PATCHED="'send_driver_payout_email','apply_cargo_bonus','send_first_ride_email','send_payment_failed_email',
  'send_delivery_receipt_email','send_driver_status_email','send_ride_receipt_email',
  'notify_trusted_contacts_on_accept','notify_trusted_contacts_on_complete','send_gift'"
# bodies DBNAME DIR -> every patched function's prosrc, as stored, into DIR/<name>.txt
bodies(){ mkdir -p "$2"; for f in send_driver_payout_email apply_cargo_bonus send_first_ride_email send_payment_failed_email \
    send_delivery_receipt_email send_driver_status_email send_ride_receipt_email notify_trusted_contacts_on_accept \
    notify_trusted_contacts_on_complete send_gift; do
    "$BIN/psql" $CONN -d "$1" -qAt -c "SELECT prosrc FROM pg_proc WHERE proname = '$f' AND pronamespace = 'public'::regnamespace" \
      | tr -d '\r' > "$2/$f.txt"; done; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== reset database =="
fresh $DB seed || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ($PATCHED, 'check_rate_limit', '_gift_wallet_type')" \
  "_gift_wallet_type:fc1d4ab1b1ad238af448e32c4064c22d/175,apply_cargo_bonus:16eb71a7cf8b8cee5abb2a436da66f09/3794,check_rate_limit:5a2e61635bf60849be2e5ca41cbd9889/527,notify_trusted_contacts_on_accept:3fabc87061fe037a7952a29fae78a331/2350,notify_trusted_contacts_on_complete:3472262ffc63c1e05c331db799bb6265/2162,send_delivery_receipt_email:75d9bf9c0fbd04454293092505f261ac/2036,send_driver_payout_email:f46950c7b3e58771ba2c8c0887089354/2260,send_driver_status_email:b3a3a5d0f4dc4d6e7ea7a20eea68afde/1620,send_first_ride_email:9a799251a03b9edf87f71122f3a90291/1121,send_gift:608f0a6a4152411685ca7e0f0871052f/6142,send_payment_failed_email:7eecddd45d72e4f890a67073b5326753/1235,send_ride_receipt_email:2e3cfa08695bc5313a231be2a7679d00/2816"
val "S1 like prod, every one of them is SECURITY DEFINER, owned by a non-superuser postgres, search_path public, pg_catalog" \
  "SELECT count(*) FILTER (WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres' AND NOT r.rolsuper
     AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_catalog') || '/' || count(*)
   FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED)" "10/10"

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="
  bodies $DB "$T/before"
  r=$(apply $DB "$MIG" -1); [ "$(echo "$r" | tail -1)" = applied ] || { echo "$r"; echo "migration failed"; exit 1; }
  bodies $DB "$T/after1"
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="
  r2=$(apply $DB "$MIG"); [ "$(echo "$r2" | tail -1)" = applied ] || { echo "$r2"; echo "migration NOT idempotent"; exit 1; }
  bodies $DB "$T/after2"
  d=$("$PY" - "$T/before" "$T/after1" <<'PYEOF'
import difflib, os, sys
out = []
for f in sorted(os.listdir(sys.argv[1])):
    a = open(os.path.join(sys.argv[1], f), encoding='utf-8').read().split('\n')
    b = open(os.path.join(sys.argv[2], f), encoding='utf-8').read().split('\n')
    diff = list(difflib.ndiff(a, b))
    out.append('%s:-%d+%d' % (f[:-4], sum(l.startswith('- ') for l in diff), sum(l.startswith('+ ') for l in diff)))
print(','.join(out))
PYEOF
)
  [ "$d" = "apply_cargo_bonus:-1+1,notify_trusted_contacts_on_accept:-2+5,notify_trusted_contacts_on_complete:-2+5,send_delivery_receipt_email:-1+1,send_driver_payout_email:-1+1,send_driver_status_email:-1+1,send_first_ride_email:-1+1,send_gift:-0+12,send_payment_failed_email:-1+1,send_ride_receipt_email:-1+1" ] \
    && ok "M1 each body changed only where intended (lines removed/added per function)" \
    || ko "M1 each body changed only where intended (lines removed/added per function)" "got [$d]"
  diff -r "$T/after1" "$T/after2" >/dev/null && [ "$(echo "$r2" | grep -c 'already patched')" = 14 ] \
    && ok "M2 the 2nd run finds all fourteen patches applied, says so and leaves every body alone" \
    || ko "M2 the 2nd run finds all fourteen patches applied, says so and leaves every body alone" "$(echo "$r2" | grep -c 'already patched') notices / $(diff -rq "$T/after1" "$T/after2")"
  val "M3 owner, SECURITY DEFINER and search_path unchanged after the patches" \
    "SELECT count(*) FILTER (WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_catalog') || '/' || count(*)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($PATCHED)" "10/10"
  val "M4 the new helpers: SECURITY DEFINER, no client may execute them, service_role only the batch one" \
    "SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || '/' ||
       has_function_privilege('authenticated', p.oid, 'EXECUTE') || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE'), ',' ORDER BY p.proname)
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('mailable_user_emails', '_user_mailable_email', '_trusted_contact_email_allowed', '_third_party_person_name')" \
    "_third_party_person_name:false:false/false/false,_trusted_contact_email_allowed:true:false/false/false,_user_mailable_email:true:false/false/false,mailable_user_emails:true:false/false/true"
  val "M5 send_gift keeps its ACL (authenticated and service_role)" \
    "SELECT has_function_privilege('anon', 'public.send_gift(uuid,uuid,integer,text,wallet_account_type,text)', 'EXECUTE') || '/' ||
            has_function_privilege('authenticated', 'public.send_gift(uuid,uuid,integer,text,wallet_account_type,text)', 'EXECUTE') || '/' ||
            has_function_privilege('service_role', 'public.send_gift(uuid,uuid,integer,text,wallet_account_type,text)', 'EXECUTE')" "false/true/true"
  echo "== the rule: who counts as owning their address =="
  val "H1 confirmed (flag), Google- or Apple-proven (case and spaces ignored, the stored address trimmed) and nothing else" \
    "SELECT string_agg(user_id::text || '=' || email, ',' ORDER BY user_id)
     FROM public.mailable_user_emails(ARRAY(SELECT id FROM public.users))" \
    "$FLAG=flag@x.test,$GMAIL=gmail@x.test,$CASE=Case@X.test,$APPLE=relay@privaterelay.test,$DVER=dver@x.test"
  val "H2 the scalar helper agrees, NULL for everyone else" \
    "SELECT count(*) FILTER (WHERE public._user_mailable_email(id) IS NOT NULL) || '/' || count(*) FROM public.users" "5/17"
  has "H3 a signed-in user cannot ask whether an account's address is proven" \
    "BEGIN; $(as $ANA authenticated) SELECT * FROM public.mailable_user_emails(ARRAY['$FLAG'::uuid]); ROLLBACK;" \
    "42501: permission denied for function mailable_user_emails"
  val "H5 a third party sees a person as first name and initial, letters only (as broadcast-emergency does)" \
    "SELECT string_agg(coalesce(public._third_party_person_name(v), '<null>'), '|' ORDER BY o) -- U&: ASCII-only -c on Windows
     FROM (VALUES (1, U&'Ana Mar\00EDa P\00E9rez'), (2, 'Visita https://spam.example/x ya'), (3, '  '), (4, NULL), (5, '123 !!!'),
                  (6, U&'\00D1o\00F1o'), (7, 'Abcdefghijklmnopqrstuvwxyz Bo')) t(o, v)" \
    "Ana M.|Visita H.|<null>|<null>|<null>|Ñoño|Abcdefghijklmnopqrst B."
  val "H4 service_role (the Edge Functions) can" \
    "BEGIN; SET LOCAL ROLE service_role; SELECT email FROM public.mailable_user_emails(ARRAY['$FLAG'::uuid, '$VICTIM'::uuid]); ROLLBACK;" "flag@x.test"
fi

echo "== gifts =="
val "G1 a gift to an address nobody confirmed queues no e-mail; the gift and its push still go through" \
  "BEGIN; $(gift $ANA $VICTIM 1) $(mails victim@x.test gift_received) $(sends send-push) ROLLBACK;" "t;0;1"
val "G2 a gift to a confirmed address queues one gift_received e-mail" \
  "BEGIN; $(gift $ANA $FLAG 1) $(mails flag@x.test gift_received) ROLLBACK;" "t;1"
val "G3 a gift to a Google-proven address queues one" \
  "BEGIN; $(gift $ANA $GMAIL 1) $(mails gmail@x.test gift_received) ROLLBACK;" "t;1"
val "G4 the same with other case and spaces: one, to the trimmed stored address" \
  "BEGIN; $(gift $ANA $CASE 1) $(mails Case@X.test gift_received) $(sends send-email) ROLLBACK;" "t;1;1"
val "G5 an Apple-proven address (email_verified sent as a string) queues one" \
  "BEGIN; $(gift $ANA $APPLE 1) $(mails relay@privaterelay.test gift_received) ROLLBACK;" "t;1"
val "G6 a Google identity on ANOTHER address proves nothing about this one: none" \
  "BEGIN; $(gift $ANA $GX 1) $(sends send-email) ROLLBACK;" "t;0"
val "G7 a Google identity Google did not verify: none" \
  "BEGIN; $(gift $ANA $GF 1) $(sends send-email) ROLLBACK;" "t;0"
val "G8 a password identity (open signup, autoconfirmed) proves nothing: none" \
  "BEGIN; $(gift $ANA $PW 1) $(sends send-email) ROLLBACK;" "t;0"
val "G10 an address that is another account's verified Google address proves nothing for this one" \
  "BEGIN; $(gift $ANA $THIEF 1) $(sends send-email) ROLLBACK;" "t;0"
val "G9 a reversal to an unconfirmed driver (driver_payout branch): none; to a confirmed one: one" \
  "BEGIN; INSERT INTO public.wallet_transfers (from_user_id, to_user_id, amount, kind, reversal_of)
     VALUES ('$ANA', '$DUNV', 5000, 'gift', gen_random_uuid()), ('$ANA', '$DVER', 5000, 'gift', gen_random_uuid());
   $(mails dunv@x.test driver_payout) $(mails dver@x.test driver_payout) ROLLBACK;" "0;1"

echo "== send_gift: a cap per sender and the note limit the apps already apply =="
has "R1 twenty gifts in a day go through (twenty e-mails); the 21st is refused with gift_rate_limited" \
  "BEGIN; $(as $ANA authenticated) SELECT count(*) FROM generate_series(1, 20) g, LATERAL (SELECT public.send_gift('$ANA', '$FLAG', g)) s;
   RESET ROLE; $(mails flag@x.test gift_received)
   $(as $ANA authenticated) SELECT public.send_gift('$ANA', '$FLAG', 21); ROLLBACK;" \
  "^20;20;ERROR: +P0001: Enviaste demasiados regalos.*DETAIL: +gift_rate_limited"
val "R2 failed gifts do not use up the quota: 25 refused for balance, then 20 go through" \
  "BEGIN; $(as $ANA authenticated)
   DO \$d\$ BEGIN FOR i IN 1..25 LOOP BEGIN PERFORM public.send_gift('$ANA'::uuid, '$FLAG'::uuid, 99999999);
     EXCEPTION WHEN OTHERS THEN NULL; END; END LOOP; END \$d\$;
   SELECT count(*) FROM generate_series(1, 20) g, LATERAL (SELECT public.send_gift('$ANA', '$FLAG', g)) s; ROLLBACK;" "20"
has "R3 the cap is per sender: with Ana at the cap, Beto still gifts" \
  "BEGIN; $(as $ANA authenticated) SELECT count(*) FROM generate_series(1, 20) g, LATERAL (SELECT public.send_gift('$ANA', '$FLAG', g)) s;
   RESET ROLE; $(as $BETO authenticated) SELECT public.send_gift('$BETO', '$FLAG', 1) IS NOT NULL; RESET ROLE;
   $(as $ANA authenticated) SELECT public.send_gift('$ANA', '$FLAG', 21); ROLLBACK;" \
  "^20;t;ERROR: +P0001: .*gift_rate_limited"
has "R4 idempotent replays return the same gift and do not count: 1 gift + 29 replays + 19 new = the cap, the next is refused" \
  "BEGIN; $(as $ANA authenticated)
   SELECT count(DISTINCT public.send_gift('$ANA', '$FLAG', 7, NULL, NULL, 'k-1')) FROM generate_series(1, 30);
   SELECT count(*) FROM generate_series(101, 119) g, LATERAL (SELECT public.send_gift('$ANA', '$FLAG', g)) s;
   SELECT public.send_gift('$ANA', '$FLAG', 200); ROLLBACK;" \
  "^1;19;ERROR: +P0001: .*gift_rate_limited"
has "R5 a note over 500 characters is refused (gift_note_too_long)" \
  "BEGIN; $(as $ANA authenticated) SELECT public.send_gift('$ANA', '$FLAG', 1, repeat('x', 501)); ROLLBACK;" \
  "ERROR: +P0001: .*DETAIL: +gift_note_too_long"
val "R6 a note of exactly 500 characters goes through" \
  "BEGIN; $(as $ANA authenticated) SELECT public.send_gift('$ANA', '$FLAG', 1, repeat('x', 500)) IS NOT NULL; ROLLBACK;" "t"

echo "== the other e-mails to the account's own address =="
val "T1 first ride and ride receipt: none for an unconfirmed address" \
  "BEGIN; $(complete $VICTIM passenger) $(mails victim@x.test first_ride_celebration) $(mails victim@x.test ride_receipt) ROLLBACK;" "0;0"
val "T2 first ride and ride receipt: one each for a confirmed address" \
  "BEGIN; $(complete $FLAG passenger) $(mails flag@x.test first_ride_celebration) $(mails flag@x.test ride_receipt) ROLLBACK;" "1;1"
val "T3 delivery receipt: none unconfirmed, one Google-proven" \
  "BEGIN; $(complete $VICTIM cargo) $(mails victim@x.test delivery_receipt_customer) ROLLBACK;
   BEGIN; $(complete $GMAIL cargo) $(mails gmail@x.test delivery_receipt_customer) ROLLBACK;" "0;1"
val "T4 payment failed: none unconfirmed, one Apple-proven" \
  "BEGIN; INSERT INTO public.payment_intents (user_id, amount_cup) VALUES ('$VICTIM', 100), ('$APPLE', 100);
   UPDATE public.payment_intents SET status = 'failed';
   $(mails victim@x.test payment_failed) $(mails relay@privaterelay.test payment_failed) ROLLBACK;" "0;1"
val "T5 driver approved: none unconfirmed, one confirmed" \
  "BEGIN; UPDATE public.driver_profiles SET status = 'approved';
   $(mails dunv@x.test driver_approved) $(mails dver@x.test driver_approved) ROLLBACK;" "0;1"
val "T6 cargo bonus: the money moves either way; the e-mail only to the confirmed driver" \
  "BEGIN; SELECT (public.apply_cargo_bonus(gen_random_uuid(), '$DUNV', 100)->>'success')::boolean;
   SELECT (public.apply_cargo_bonus(gen_random_uuid(), '$DVER', 100)->>'success')::boolean;
   SELECT string_agg(balance::text, ',' ORDER BY user_id) FROM public.wallet_accounts WHERE account_type = 'tricicoin';
   $(mails dunv@x.test driver_payout) $(mails dver@x.test driver_payout) ROLLBACK;" "t;t;100,100;0;1"
val "T7 no address at all: nothing queued, nothing broken" \
  "BEGIN; $(complete $NONE passenger) $(gift $ANA $NONE 1) $(sends send-email) ROLLBACK;" "t;0"

echo "== trusted contacts: a third party's address, capped per address =="
TC_RIDES="INSERT INTO public.rides (customer_id, status, share_token) SELECT '$RITA', 'searching', 'tok' || g FROM generate_series(1, 25) g;
   UPDATE public.rides SET status = 'accepted' WHERE customer_id = '$RITA';"
val "C1 25 rides accepted: friend@ (named twice by Rita, one inbox) gets 20 e-mails, second@ 20, the phone contact all 25 SMS" \
  "BEGIN; $TC_RIDES SELECT count(*) FROM net.http_request_queue WHERE lower(btrim(body->>'recipient_email')) = 'friend@x.test';
   $(mails second@x.test trusted_contact_ride_started) $(sends send-sms) ROLLBACK;" "20;20;25"
val "C2 the cap is per rider: Rita using up friend@'s bucket does not silence Raul's notice to the same inbox" \
  "BEGIN; $TC_RIDES INSERT INTO public.rides (customer_id, status, share_token) VALUES ('$RAUL', 'searching', 'tok-r');
   UPDATE public.rides SET status = 'accepted' WHERE customer_id = '$RAUL';
   SELECT count(*) FROM net.http_request_queue WHERE body->>'recipient_email' = ' Friend@X.test'; ROLLBACK;" "1"
val "C3 the completion e-mail shares the cap; under it, both go out" \
  "BEGIN; INSERT INTO public.rides (id, customer_id, status, share_token) VALUES ('f0000000-0000-4000-8000-0000000000c1', '$RITA', 'searching', 'tok-c');
   UPDATE public.rides SET status = 'accepted' WHERE customer_id = '$RITA'; UPDATE public.rides SET status = 'completed' WHERE customer_id = '$RITA';
   $(mails friend@x.test trusted_contact_ride_started) $(mails friend@x.test trusted_contact_ride_completed) ROLLBACK;" "1;1"

val "C4 the contact sees the rider and themselves as first name and initial: no link, no markup, e-mail and SMS alike" \
  "BEGIN; INSERT INTO public.rides (customer_id, status, share_token) VALUES ('$RITA', 'searching', 'tok-n');
   UPDATE public.rides SET status = 'accepted' WHERE customer_id = '$RITA';
   SELECT body->'data'->>'rider_name' || '|' || (body->'data'->>'contact_name') FROM net.http_request_queue
    WHERE body->>'recipient_email' = 'friend@x.test';
   SELECT left(body->>'body', 32) FROM net.http_request_queue WHERE url LIKE '%/send-sms'; ROLLBACK;" \
  "Rita W.|Amiga B.;Rita W. ha iniciado un viaje con"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8', newline='\n').write(s2)
PYEOF
  }
  # N1: a body that drifted (the targeted line reformatted) makes the migration refuse, not skip.
  fresh ${DB}n
  run ${DB}n "SET ROLE postgres; DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef('public.send_first_ride_email()'::regprocedure),
    'SELECT u.email, u.full_name INTO', 'SELECT u.email,  u.full_name INTO'); END \$d\$;" >/dev/null
  r=$(apply_err ${DB}n "$MIG")
  echo "$r" | grep -q "00635: public.send_first_ride_email() carries the expected text 0 times" \
    && ok "N1 a drifted body aborts the migration instead of leaving that sender open" || ko "N1 a drifted body aborts the migration instead of leaving that sender open" "$r"
  # N2: a sender left out of the patch list is caught by the final check.
  sabotage n2 "('public.send_payment_failed_email()', 'public._user_mailable_email('," "('public.send_payment_failed_email_gone()', 'public._user_mailable_email(',"
  fresh ${DB}n; r=$(apply_err ${DB}n "$T/n2.sql")
  echo "$r" | grep -qF "00635: public.send_payment_failed_email() carries public._user_mailable_email( 0 times" \
    && ok "N2 a sender the patch missed aborts the migration" || ko "N2 a sender the patch missed aborts the migration" "$r"
  # N3: a client left with EXECUTE on the oracle aborts the migration.
  sabotage n3 "REVOKE ALL ON FUNCTION public.mailable_user_emails(uuid[]) FROM PUBLIC, anon, authenticated;" \
    "REVOKE ALL ON FUNCTION public.mailable_user_emails(uuid[]) FROM PUBLIC, anon;"
  fresh ${DB}n; r=$(apply_err ${DB}n "$T/n3.sql")
  echo "$r" | grep -q "00635: authenticated can execute public.mailable_user_emails" \
    && ok "N3 a client left with EXECUTE on the helper aborts the migration" || ko "N3 a client left with EXECUTE on the helper aborts the migration" "$r"
  # N4: the gift cap missing from send_gift aborts the migration.
  sabotage n4 "'send-gift:' || p_from_user_id::text" "'send-gift-x:' || p_from_user_id::text"
  fresh ${DB}n; r=$(apply_err ${DB}n "$T/n4.sql")
  echo "$r" | grep -qF "00635: public.send_gift(uuid,uuid,integer,text,public.wallet_account_type,text) carries send-gift: 0 times" \
    && ok "N4 send_gift without the cap aborts the migration" || ko "N4 send_gift without the cap aborts the migration" "$r"
  # N5: applied once with CRLF (an SQL Editor paste from Windows), then again as LF (a later
  # db push): every patch is found applied, each marker stays single, the gift cap stays 20.
  "$PY" - "$MIG" "$T/crlf.sql" <<'PYEOF'
import sys
s = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
open(sys.argv[2], 'w', encoding='utf-8', newline='\r\n').write(s)
PYEOF
  fresh ${DB}n seed; r1=$(apply_err ${DB}n "$T/crlf.sql"); r2=$(apply_err ${DB}n "$MIG")
  m=$(run ${DB}n "SELECT string_agg(proname || '=' || ((length(prosrc) - length(replace(prosrc, mk, ''))) / length(mk)), ',' ORDER BY proname)
    FROM pg_proc, LATERAL (SELECT CASE WHEN proname = 'send_gift' THEN 'send-gift:' ELSE '_trusted_contact_email_allowed(' END AS mk) k
    WHERE pronamespace = 'public'::regnamespace AND proname IN ('send_gift', 'notify_trusted_contacts_on_accept', 'notify_trusted_contacts_on_complete')")
  g=$(run ${DB}n "BEGIN; $(as $ANA authenticated) SELECT count(*) FROM generate_series(1, 20) g, LATERAL (SELECT public.send_gift('$ANA', '$FLAG', g)) s; ROLLBACK;")
  [ "$r1" = applied ] && [ "$r2" = applied ] && [ "$m" = "notify_trusted_contacts_on_accept=1,notify_trusted_contacts_on_complete=1,send_gift=1" ] && [ "$g" = 20 ] \
    && ok "N5 a CRLF apply followed by an LF apply patches nothing twice (one marker each, 20 gifts still go through)" \
    || ko "N5 a CRLF apply followed by an LF apply patches nothing twice (one marker each, 20 gifts still go through)" "$r1 / $r2 / $m / $g"
  # N6: a NEW sender that reads users.email and calls send-email without the rule aborts the migration.
  fresh ${DB}n
  run ${DB}n "SET ROLE postgres; CREATE FUNCTION public.send_promo_email() RETURNS trigger LANGUAGE plpgsql AS \$f\$
    DECLARE v text; BEGIN SELECT email INTO v FROM users WHERE id = NEW.id;
    PERFORM net.http_post(url := 'https://x.supabase.co/functions/v1/send-email', body := jsonb_build_object('recipient_email', v));
    RETURN NEW; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}n "$MIG")
  echo "$r" | grep -q "00635: public.send_promo_email() mails users.email without the proof check" \
    && ok "N6 an unknown sender that mails users.email aborts the migration" || ko "N6 an unknown sender that mails users.email aborts the migration" "$r"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
