#!/usr/bin/env bash
# Rehearsal runner for migration 00638 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00638/run.sh none
#       -> scaffold (prod's two trigger functions, verbatim) + tests (RED: the pushes still use voseo)
#   supabase/tests/00638/run.sh supabase/migrations/00638_tuteo_server_push_texts.sql
#       -> the same + migration x2 (idempotency) + tests + negative proofs (GREEN)
# The migration runs in one transaction (-1), as Supabase's apply does, as
# tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod".
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> supabase/tests/00638/run.sh ...
# All SQL goes to psql through stdin, never through -c: on Windows a -c
# argument is re-encoded to the ANSI code page and "í" stops being UTF-8.
set -u -o pipefail   # migrate's exit code is psql's, not tr's
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
# Results go to a file: most checks run at the end of a pipeline, i.e. in a
# subshell, where incrementing a counter would be lost.
RESULTS=$(mktemp); TMP=$(mktemp -d); trap 'rm -rf "$RESULTS" "$TMP"' EXIT
ok(){ echo "PASS  $1"; echo P >> "$RESULTS"; }
ko(){ echo "FAIL  $1  -- $2"; echo F >> "$RESULTS"; }
# q DB  (SQL on stdin) -> rows, ';'-joined, errors included
q(){ $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
# val NAME DB EXPECTED  (SQL on stdin)
val(){ local r; r=$(q "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# migrate DB FILE -> output of applying FILE as the owner, in one transaction
migrate(){ { echo "SET SESSION AUTHORIZATION tricigo_owner;"; cat "$2"; } \
  | $BIN/psql $CONN -d "$1" -qAt -1 -v ON_ERROR_STOP=1 -f - 2>&1 | tr -d '\r'; }

PAY_BEFORE=9d1708844cefd005f66fd750b722ff46; PAY_AFTER=b8b2e9be09e55766cbdd1406fa9d6121
GPS_BEFORE=e702e178b3abc97548db19a219280ab1; GPS_AFTER=919ef4587bcf09fcc9690b63d5a375ea
PAY_TEXT='Tu recarga de 950 CUP no pudo procesarse. Inténtalo nuevamente.'
GPS_TEXT='Tu conductor dice que está cerca. Abre la app y confirma si lo ves.'
USER_ID=a0000000-0000-4000-8000-000000000001
MD5S="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc
      WHERE proname IN ('notify_payment_intent_failure', 'notify_rider_gps_override_request');"
# The pushes each trigger sends (rolled back): body of the payment push, body of the GPS push.
PUSHES="BEGIN;
  INSERT INTO public.payment_intents (id, user_id, status, amount_cup) VALUES ('b0000000-0000-4000-8000-000000000001', '$USER_ID', 'pending', 950);
  UPDATE public.payment_intents SET status = 'failed' WHERE id = 'b0000000-0000-4000-8000-000000000001';
  INSERT INTO public.rides (id, customer_id, status) VALUES ('c0000000-0000-4000-8000-000000000001', '$USER_ID', 'driver_en_route');
  UPDATE public.rides SET gps_override_requested_at = now() WHERE id = 'c0000000-0000-4000-8000-000000000001';
  SELECT body->>'body' FROM net.sent ORDER BY id;
ROLLBACK;"
# Everything about the two functions that must survive the patch, except the body.
META="SELECT string_agg(p.proname || '|' || pg_get_userbyid(p.proowner) || '|' || p.proacl::text || '|' || p.prosecdef
        || '|' || p.proconfig::text || '|' || md5(obj_description(p.oid, 'pg_proc'))
        || '|' || (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = p.oid AND t.tgenabled = 'O'), ';' ORDER BY p.proname)
      FROM pg_proc p WHERE p.proname IN ('notify_payment_intent_failure', 'notify_rider_gps_override_request');"

fresh(){ printf 'DROP DATABASE IF EXISTS %s;\nCREATE DATABASE %s;\n' "$1" "$1" | $BIN/psql $CONN -d postgres -qAt -f - >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1; }

# ── Scaffold fidelity: the bodies are prod's, byte for byte ──
fresh pr638base || { echo "scaffold failed"; exit 1; }
echo "$MD5S" | val "F1 scaffold bodies are prod's (md5 of 2026-10-07)" pr638base \
  "notify_payment_intent_failure=$PAY_BEFORE,notify_rider_gps_override_request=$GPS_BEFORE"
echo "SELECT count(*) FROM pg_proc WHERE proname LIKE 'notify_%' AND position(chr(13) IN prosrc) > 0;" \
  | val "F2 scaffold bodies carry no carriage return" pr638base 0
META_BASE=$(echo "$META" | q pr638base)

# ── The database under test ──
DB=pr638
fresh $DB || { echo "scaffold failed"; exit 1; }
if [ "$MIG" != none ]; then
  OUT1=$(migrate $DB "$MIG"); RC1=$?
  [ $RC1 -eq 0 ] && ok "M1 migration applies" || ko "M1 migration applies" "$OUT1"
  echo "$OUT1" | grep -q "patched public.notify_payment_intent_failure()" \
    && echo "$OUT1" | grep -q "patched public.notify_rider_gps_override_request()" \
    && ok "M2 first run patches both functions" || ko "M2 first run patches both functions" "$OUT1"
  OUT2=$(migrate $DB "$MIG"); RC2=$?
  [ $RC2 -eq 0 ] && [ "$(echo "$OUT2" | grep -c 'already patched; skipping')" = 2 ] \
    && ok "M3 second run skips both (idempotent)" || ko "M3 second run skips both (idempotent)" "rc=$RC2 $OUT2"
fi

echo "$PUSHES" | val "T1 the pushes the triggers send are in tuteo" $DB "$PAY_TEXT;$GPS_TEXT"
echo "$MD5S" | val "T2 both bodies are the patched ones" $DB \
  "notify_payment_intent_failure=$PAY_AFTER,notify_rider_gps_override_request=$GPS_AFTER"
echo "$META" | val "T3 owner, grants, SECURITY DEFINER, search_path, comment and triggers unchanged" $DB "$META_BASE"
cat <<'EOF' | val "T4 the replaced line is the only change in each body" $DB "9d1708844cefd005f66fd750b722ff46;e702e178b3abc97548db19a219280ab1"
SELECT md5(replace(prosrc, t.n, t.o))
FROM (VALUES ('notify_payment_intent_failure', 'no pudo procesarse. Intentalo nuevamente.', 'no pudo procesarse. Inténtalo nuevamente.'),
             ('notify_rider_gps_override_request', 'Abrí la app y confirmá si lo ves.', 'Abre la app y confirma si lo ves.')) t(proname, o, n)
JOIN pg_proc p ON p.proname = t.proname ORDER BY t.proname;
EOF
echo "SELECT count(*) FROM pg_proc WHERE proname LIKE 'notify_%' AND prosrc ~* '(intentalo|abrí la app|confirmá)';" \
  | val "T5 no voseo form left in either body" $DB 0

if [ "$MIG" != none ]; then
  # N1: a body that is not prod's (one extra comment line, the text still once)
  # is refused, and the whole run rolls back: the function patched before it
  # in the same run keeps its original body.
  fresh pr638n1
  cat <<'EOF' | q pr638n1 >/dev/null
SET SESSION AUTHORIZATION tricigo_owner;
DO $t$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.notify_rider_gps_override_request()'::regprocedure),
                  'DECLARE', '-- changed after 2026-10-07' || chr(10) || 'DECLARE');
END $t$;
EOF
  OUT=$(migrate pr638n1 "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "refusing to patch a body this file was not written against" \
    && ok "N1 a body that is not prod's is refused" || ko "N1 a body that is not prod's is refused" "rc=$RC $OUT"
  # N1b: the run did patch the payment function before failing (its NOTICE), and the rollback undid it
  R=$(echo "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'notify_payment_intent_failure';" | q pr638n1)
  echo "$OUT" | grep -q "patched public.notify_payment_intent_failure()" && [ "$R" = "$PAY_BEFORE" ] \
    && ok "N1b the refusal rolls back the function patched before it" \
    || ko "N1b the refusal rolls back the function patched before it" "md5=$R out=$OUT"

  # N2: the text to replace twice
  fresh pr638n2
  cat <<'EOF' | q pr638n2 >/dev/null
SET SESSION AUTHORIZATION tricigo_owner;
DO $t$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.notify_payment_intent_failure()'::regprocedure),
                  'v_title := ''Pago no completado'';',
                  'v_title := ''Pago no completado. no pudo procesarse. Intentalo nuevamente.'';');
END $t$;
EOF
  OUT=$(migrate pr638n2 "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "found it 2 times" \
    && ok "N2 the text present twice is refused" || ko "N2 the text present twice is refused" "rc=$RC $OUT"

  # N3: the text to replace missing (someone reworded it)
  fresh pr638n3
  cat <<'EOF' | q pr638n3 >/dev/null
SET SESSION AUTHORIZATION tricigo_owner;
DO $t$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.notify_rider_gps_override_request()'::regprocedure),
                  ' la app y confirm', ' la aplicacion y confirm');
END $t$;
EOF
  OUT=$(migrate pr638n3 "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "found it 0 times" \
    && ok "N3 the text missing is refused" || ko "N3 the text missing is refused" "rc=$RC $OUT"

  # N4: a missing function
  fresh pr638n4
  echo "DROP FUNCTION public.notify_rider_gps_override_request() CASCADE;" | q pr638n4 >/dev/null
  OUT=$(migrate pr638n4 "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "notify_rider_gps_override_request() does not exist" \
    && ok "N4 a missing function aborts" || ko "N4 a missing function aborts" "rc=$RC $OUT"

  # N5: the closing assertion, run alone on prod's unpatched bodies, aborts
  fresh pr638n5
  sed -n '/^DO \$assert\$/,/^\$assert\$;/p' "$MIG" > "$TMP/assert.sql"
  OUT=$(migrate pr638n5 "$TMP/assert.sql"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "voseo still there: public.notify_payment_intent_failure(), public.notify_rider_gps_override_request()" \
    && ok "N5 the closing assertion catches unpatched bodies" || ko "N5 the closing assertion catches unpatched bodies" "rc=$RC $OUT"

  # N5b/N5c: the assertion's other arms on their own, with its md5 arm switched off
  sed 's/OR md5(p.prosrc) <> t.md5_after/OR false/' "$TMP/assert.sql" > "$TMP/assert-nomd5.sql"
  if [ "$(grep -c 'OR false' "$TMP/assert-nomd5.sql")" != 1 ]; then
    ko "N5b/N5c setup" "could not switch off the md5 arm"
  else
    # N5b: without the md5 arm, unpatched bodies still fail (the new text is missing)
    OUT=$(migrate pr638n5 "$TMP/assert-nomd5.sql"); RC=$?
    [ $RC -ne 0 ] && echo "$OUT" | grep -q "voseo still there: public.notify_payment_intent_failure(), public.notify_rider_gps_override_request()" \
      && ok "N5b the assertion catches a body without the new text" || ko "N5b the assertion catches a body without the new text" "rc=$RC $OUT"
    # N5c: a patched body with a voseo form added back (in a comment) fails on the regex arm alone
    fresh pr638n5c; migrate pr638n5c "$MIG" >/dev/null
    cat <<'EOF' | q pr638n5c >/dev/null
SET SESSION AUTHORIZATION tricigo_owner;
DO $t$ BEGIN
  EXECUTE replace(pg_get_functiondef('public.notify_payment_intent_failure()'::regprocedure),
                  'v_title := ', '-- Intentalo' || chr(10) || '  v_title := ');
END $t$;
EOF
    OUT=$(migrate pr638n5c "$TMP/assert-nomd5.sql"); RC=$?
    [ $RC -ne 0 ] && echo "$OUT" | grep -q 'voseo still there: public.notify_payment_intent_failure()$' \
      && ok "N5c the assertion catches voseo in a body that has the new text" || ko "N5c the assertion catches voseo in a body that has the new text" "rc=$RC $OUT"
  fi

  # N7: the post-patch body check fires when the body is not the expected one
  sed "0,/'$PAY_AFTER',/s//'ffffffffffffffffffffffffffffffff',/" "$MIG" > "$TMP/wrong-after.sql"
  if [ "$(diff "$MIG" "$TMP/wrong-after.sql" | grep -c '^>')" != 1 ]; then
    ko "N7 setup" "expected exactly one changed line"
  else
    fresh pr638n7
    OUT=$(migrate pr638n7 "$TMP/wrong-after.sql"); RC=$?
    [ $RC -ne 0 ] && echo "$OUT" | grep -q "notify_payment_intent_failure() does not have the expected body after the patch" \
      && ok "N7 the post-patch body check fires" || ko "N7 the post-patch body check fires" "rc=$RC $OUT"
  fi

  # N8: the owner/grants check fires when a grant moves during the patch
  # (an event trigger widens EXECUTE right after CREATE FUNCTION)
  fresh pr638n8
  cat <<'EOF' | q pr638n8 >/dev/null
CREATE FUNCTION public.tg_widen_grant() RETURNS event_trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF tg_tag = 'CREATE FUNCTION' THEN
    GRANT EXECUTE ON FUNCTION public.notify_payment_intent_failure() TO authenticated;
  END IF;
END $f$;
CREATE EVENT TRIGGER widen_grant ON ddl_command_end EXECUTE FUNCTION public.tg_widen_grant();
EOF
  OUT=$(migrate pr638n8 "$MIG"); RC=$?
  [ $RC -ne 0 ] && echo "$OUT" | grep -q "the owner or the grants of public.notify_payment_intent_failure() changed during the patch" \
    && ok "N8 the owner/grants check fires" || ko "N8 the owner/grants check fires" "rc=$RC $OUT"

  # N6: the file pasted from Windows (CRLF) patches to the same bodies, with no \r in them
  fresh pr638n6
  sed 's/$/\r/' "$MIG" > "$TMP/crlf.sql"
  OUT=$(migrate pr638n6 "$TMP/crlf.sql"); RC=$?
  [ $RC -eq 0 ] && ok "N6 the CRLF copy applies" || ko "N6 the CRLF copy applies" "$OUT"
  echo "$MD5S" | val "N6b the CRLF copy leaves the same patched bodies" pr638n6 \
    "notify_payment_intent_failure=$PAY_AFTER,notify_rider_gps_override_request=$GPS_AFTER"
fi

PASS=$(grep -c P "$RESULTS"); FAIL=$(grep -c F "$RESULTS")
echo "---- $PASS passed, $FAIL failed ----"
[ "$FAIL" -eq 0 ]
