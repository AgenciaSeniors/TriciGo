#!/usr/bin/env bash
# Rehearsal runner for migration 00688 (the "Pide ayuda" e-mail goes out with the push, not at the
# next minute's digest). Reuses 00683's rehearsal: its scaffold, prod's tables and the live bodies,
# then applies 00683 itself, which leaves request_ride_help byte for byte as prod has it on
# 2026-11-18 (checked: md5 64b18c04...). Pushes and e-mails land in test_pushes.
#   supabase/tests/00688/run.sh none
#       -> prod as it is + tests (RED: the help e-mail waits for the digest)
#   supabase/tests/00688/run.sh supabase/migrations/00688_support_help_email_now.sql
#       -> the same + 00688 applied twice (GREEN), a CRLF copy on a fresh database, a snapshot
#          showing it changed no other function, and a negative proof of its md5 guard
# Cluster: any Postgres 16 with a superuser. Default: psql on 127.0.0.1:${PGPORT:-5433} as pgtest.
#   PSQL="<bin>/psql.exe -h 127.0.0.1 -p <port> -U pgtest" supabase/tests/00688/run.sh ...
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="$DIR/../00683"
ROOT="$(cd "$DIR/../../.." && pwd)"
M683="$ROOT/supabase/migrations/00683_support_ride_owner.sql"
MIG="${1:-none}"
case "$MIG" in none|/*|[A-Za-z]:*) FILE="$MIG" ;; *) FILE="$ROOT/$MIG" ;; esac
PSQL="${PSQL:-psql -h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest}"
DB=pr688
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
  if ! cat "$BASE/scaffold.sql" "$BASE/tables.sql" "$BASE/live-bodies.sql" \
       | $PSQL -d "$1" -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null 2>&1; then
    echo "scaffold failed for $1"; exit 1
  fi
  local r; r=$(apply "$1" "$M683"); [ "$r" = applied ] || { echo "00683 failed for $1: $r"; exit 1; }
}

CUS=a6880000-0000-4000-8000-000000000004
OP1=a6880000-0000-4000-8000-000000000001
R1=b6880000-0000-4000-8000-000000000001
R2=b6880000-0000-4000-8000-000000000002
R3=b6880000-0000-4000-8000-000000000003
R4=b6880000-0000-4000-8000-000000000004
R5=b6880000-0000-4000-8000-000000000005   # pickup with HTML in it
as_user(){ echo "SET LOCAL request.jwt.claim.sub = '$1'; SET LOCAL ROLE authenticated;"; }
tx(){ echo "BEGIN; $1 ROLLBACK;"; }
call(){ echo "$(as_user $1) SELECT $2; RESET ROLE;"; }

SEED="
INSERT INTO public.users (id, role, full_name, phone) VALUES
  ('$OP1', 'operator', 'Lete', NULL), ('$CUS', 'customer', 'Pasajera', '55550000');
INSERT INTO public.service_type_configs (slug, name_es, name_en) VALUES ('triciclo_basico', 'Triciclo', 'Tricycle');
INSERT INTO public.rides (id, customer_id, service_type, status, pickup_address, dropoff_address) VALUES
  ('$R1', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R2', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R3', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R4', '$CUS', 'triciclo_basico', 'searching', 'Calle 23 entre L y M, Vedado', 'Obispo 104, Habana Vieja'),
  ('$R5', '$CUS', 'triciclo_basico', 'searching', '<b>Casa</b> & \"patio\"', 'Obispo 104, Habana Vieja');"
LIST="INSERT INTO public.platform_config (key, value)
  VALUES ('support_alert_email', '\"ops@tricigo.com, soporte@tricigo.com\"'::jsonb);"
LABELS="SELECT coalesce(string_agg(label, ',' ORDER BY id), 'none') FROM public.test_pushes;"
EMAILS="SELECT count(*) FROM public.test_pushes WHERE label = 'support-help-email';"
DIGEST_MAILS="SELECT count(*) FROM public.test_pushes WHERE label = 'support-alert-email';"
STAMP="SELECT (help_email_sent_at IS NOT NULL)::text FROM public.ride_assist WHERE ride_id = '$R1';"
FAILED="SELECT coalesce(string_agg(rpc_name || ':' || outcome, ',' ORDER BY rpc_name), 'none')
  FROM public.rpc_attempt_log WHERE rpc_name = '_support_help_email';"
HELP="$(call $CUS "(public.request_ride_help('$R1') ->> 'success')")"
NEW_LIST="'_support_help_email','request_ride_help'"
OTHERS="SELECT md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname NOT IN ($NEW_LIST)"
BODIES="SELECT string_agg(p.proname || '=' || md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ($NEW_LIST)"
# md5 of prosrc after 00688 (request_ride_help patched in place; _support_help_email created), as
# the rehearsal in prod (inside a rolled-back block, 2026-11-18) left them.
NEW_MD5="_support_help_email=b4715316e8e4eb6e16d7f47cad1fc587,request_ride_help=cfebdc0a6d37520666bdc6a4c8befa94"

mkdb $DB
run $DB "$SEED" >/dev/null
val "P0 request_ride_help is prod's body (00683, md5 64b18c04...)" \
    "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.request_ride_help(uuid)'::regprocedure;" \
    "64b18c0490670a3a0163ada4acefd79d"
OTHERS_BEFORE=$(run $DB "$OTHERS")

if [ "$FILE" != none ]; then
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M1 applied once" || ko "M1 applied once" "$r"
  r=$(apply $DB "$FILE"); [ "$r" = applied ] && ok "M2 applied again (idempotent)" || ko "M2 applied again" "$r"
  val "M3 no other function changed (body or grants)" "$OTHERS" "$OTHERS_BEFORE"
  val "M4 the two bodies are the ones rehearsed in prod (2026-11-18)" "$BODIES" "$NEW_MD5"
fi

# --- What the rider's tap sends ---------------------------------------------------------------
val "E1 a help tap sends the push and, at once, one e-mail per address" \
    "$(tx "$LIST $HELP $LABELS $STAMP")" \
    "true;support-help-alert,support-help-email,support-help-email;true"
val "E2 the e-mail names the ride and links its assist page" \
    "$(tx "$LIST $HELP
      SELECT string_agg(body ->> 'recipient_email', ',' ORDER BY id) FROM public.test_pushes WHERE label = 'support-help-email';
      SELECT DISTINCT body ->> 'subject' FROM public.test_pushes WHERE label = 'support-help-email';
      SELECT DISTINCT (position('https://admin.tricigo.com/rides/$R1/assist' IN body ->> 'template') > 0)::text
        FROM public.test_pushes WHERE label = 'support-help-email';")" \
    "true;ops@tricigo.com,soporte@tricigo.com;[TriciGo] Pasajero pide ayuda · Triciclo · B6880000;true"
val "E3 the next digest does not send it again" \
    "$(tx "$LIST $HELP SELECT public.notify_support_waiting_rides(); $DIGEST_MAILS $EMAILS")" \
    "true;0;0;2"
val "E4 a second tap sends nothing more" \
    "$(tx "$LIST $HELP $HELP $EMAILS")" \
    "true;true;2"
val "E5 what the rider typed is escaped" \
    "$(tx "$LIST $(call $CUS "(public.request_ride_help('$R5') ->> 'success')")
      SELECT DISTINCT (position('&lt;b&gt;Casa&lt;/b&gt; &amp; &quot;patio&quot;' IN body ->> 'template') > 0)::text
          || (position('<b>Casa</b>' IN body ->> 'template') > 0)::text
        FROM public.test_pushes WHERE label = 'support-help-email';")" \
    "true;truefalse"

# --- When it cannot go out, the digest still sends it ----------------------------------------
val "F1 no address list: no e-mail, no stamp, the tap still works" \
    "$(tx "$HELP $EMAILS $STAMP")" \
    "true;0;false"
val "F2 no service key: no e-mail, no stamp, logged, the tap still works" \
    "$(tx "$LIST SET LOCAL test.no_key = '1'; $HELP $EMAILS $STAMP $FAILED")" \
    "true;0;false;_support_help_email:alert_failed"
val "F3 the HTTP queue fails: nothing kept, logged, and the next digest sends it" \
    "$(tx "$LIST SET LOCAL test.http_fail = '1'; $HELP $EMAILS $STAMP $FAILED
      SET LOCAL test.http_fail = '0'; SELECT public.notify_support_waiting_rides(); $DIGEST_MAILS")" \
    "true;0;false;_support_help_email:alert_failed;1;2"
val "F4 a rider over the help cap (3 in an hour): no push, no e-mail" \
    "$(tx "$LIST INSERT INTO public.ride_assist (ride_id, help_requested_at, help_alert_sent_at)
        VALUES ('$R2', now(), now()), ('$R3', now(), now()), ('$R4', now(), now());
      $HELP $LABELS")" \
    "true;none"

# --- Who can run it ---------------------------------------------------------------------------
if [ "$FILE" != none ]; then
  val "G1 clients cannot run _support_help_email; riders keep request_ride_help" \
      "SELECT has_function_privilege('anon', 'public._support_help_email(uuid)', 'EXECUTE')::text
          || has_function_privilege('authenticated', 'public._support_help_email(uuid)', 'EXECUTE')::text
          || has_function_privilege('authenticated', 'public.request_ride_help(uuid)', 'EXECUTE')::text;" \
      "falsefalsetrue"

  # A CRLF copy (pasted from Windows) applies to a fresh database and leaves the same bodies.
  CR="$(mktemp)"; sed 's/$/\r/' "$FILE" > "$CR"
  mkdb pr688crlf
  r=$(apply pr688crlf "$CR"); [ "$r" = applied ] && ok "C1 a CRLF copy applies" || ko "C1 a CRLF copy applies" "$r"
  echo "INFO  CRLF bodies: $(run pr688crlf "$BODIES")"
  dropdb pr688crlf; rm -f "$CR"

  # Negative proof: the md5 guard refuses a request_ride_help that is not the 00683 body.
  mkdb pr688neg
  run pr688neg "$AS_OWNER DO \$x\$ DECLARE v text; BEGIN
      SELECT pg_get_functiondef('public.request_ride_help(uuid)'::regprocedure) INTO v;
      EXECUTE replace(v, 'v_recent integer;', 'v_recent integer;  -- drifted'); END \$x\$;" >/dev/null
  r=$(apply pr688neg "$FILE"); echo "$r" | grep -q "is not the 00683 body" \
    && ok "N1 refused: $r" || ko "N1 the guard refuses a drifted body" "$r"
  dropdb pr688neg
fi

dropdb $DB
echo "----"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
