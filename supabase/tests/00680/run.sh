#!/usr/bin/env bash
# Rehearsal runner for migration 00680 (the card switch), on top of the 00679 rehearsal base.
#   supabase/tests/00680/run.sh none                                   -> base + 00679 + tests (RED)
#   supabase/tests/00680/run.sh supabase/migrations/00680_moto_deportiva_card_switch.sql
#       -> the same + 00680 x2 (idempotency) + tests + CRLF copy + negative proofs (GREEN)
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PGDB=<name> supabase/tests/00680/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../../.." && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DB="${PGDB:-pr680}"; CRL="${DB}w"; NEG="${DB}n"
M650="$REPO/supabase/migrations/00650_driver_vehicle_review.sql"
M679="$REPO/supabase/migrations/00679_moto_deportiva.sql"
FRESHLOG="$(mktemp)"; TESTLOG="$(mktemp)"; trap 'rm -f "$FRESHLOG" "$TESTLOG"' EXIT
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
run(){ "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$2" 2>&1 | tr -d '\r' | sed '/^$/d' | paste -sd';' -; }
val(){ local r; r=$(run "${4:-$DB}" "$2"); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
apply_err(){ local out; if out=$("$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }
mutate(){ run "$1" "SET ROLE tricigo_owner; DO \$m\$ BEGIN EXECUTE $2; END \$m\$;" >/dev/null; }
fresh(){ : > "$FRESHLOG"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>>"$FRESHLOG" || { cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/00650/scaffold.sql" >/dev/null 2>>"$FRESHLOG" || { cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M650" >/dev/null 2>>"$FRESHLOG" || { cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/00679/scaffold-extra.sql" >/dev/null 2>>"$FRESHLOG" || { cat "$FRESHLOG"; return 1; }
  "$BIN/psql" $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$M679" >/dev/null 2>>"$FRESHLOG" || { echo "-- 00679 failed:"; cat "$FRESHLOG"; return 1; }; }

BODIES="SELECT string_agg(proname || '=' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname IN ('_moto_deportiva_card_visible', 'get_moto_deportiva_status',
          '_moto_deportiva_send_notice', 'admin_moto_deportiva_overview', 'admin_set_moto_deportiva_visible')"
LIVE="SELECT string_agg(proname || '=' || md5(prosrc), ',' ORDER BY proname COLLATE \"C\") FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_moto_deportiva_status', '_moto_deportiva_send_notice', 'admin_moto_deportiva_overview')"
LIVE_MD5="_moto_deportiva_send_notice=b2e59c4ace99a3d5973c4c57f026ff07,admin_moto_deportiva_overview=60f286c0e0f5de6ecb8051ca9dbdc253,get_moto_deportiva_status=fa52d473f889fe4b75468c0faf19d7a8"

echo "== reset database =="
fresh $DB || { echo "base failed"; exit 1; }
val "S0 the base carries prod's bodies after 00679" "$LIVE" "$LIVE_MD5"

if [ "$MIG" != "none" ]; then
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M0 the migration applies" || { ko "M0 the migration applies" "$r"; exit 1; }
  B1="$(run $DB "$BODIES")"
  r=$(apply_err $DB "$MIG"); [ "$r" = applied ] && ok "M1 the migration re-applies (idempotent)" || ko "M1 the migration re-applies" "$r"
  val "M2 ...leaving every body as the first run did" "$BODIES" "$B1"
  val "M3 one setting, visible by default" "SELECT value::text FROM public.platform_config WHERE key = 'moto_deportiva_card_visible'" "true"
fi

echo "== tests.sql =="
"$BIN/psql" $CONN -d "$DB" -qAt -f "$DIR/tests.sql" 2>"$TESTLOG" | tr -d '\r' > "$TESTLOG.out"
while IFS= read -r line; do
  case "$line" in
    "PASS  "*) echo "$line"; PASS=$((PASS+1)) ;;
    "FAIL  "*) echo "$line"; FAIL=$((FAIL+1)) ;;
  esac
done < "$TESTLOG.out"
while IFS= read -r name; do
  grep -qF "  $name" "$TESTLOG.out" || ko "$name" "not reached: $(tr -d '\r' < "$TESTLOG" | grep -m1 'ERROR' || echo 'no error')"
done < <(grep -oE "tst\.t\('[^']+'" "$DIR/tests.sql" | sed -E "s/^tst\.t\('//; s/'$//")
rm -f "$TESTLOG.out"

if [ "$MIG" != "none" ]; then
  echo "== CRLF copy =="
  fresh $CRL || { echo "base failed"; exit 1; }
  CRLF="$(mktemp)"; sed 's/$/\r/' "$MIG" > "$CRLF"
  r=$(apply_err $CRL "$CRLF"); rm -f "$CRLF"
  [ "$r" = applied ] && ok "C1 a CRLF copy applies" || ko "C1 a CRLF copy applies" "$r"
  val "C2 ...leaving the same bodies as the LF one, with no carriage return" \
    "$BODIES; SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(chr(13) IN prosrc) > 0" "$B1;0" $CRL
  r=$(apply_err $CRL "$MIG"); [ "$r" = applied ] && ok "C3 ...and the LF file re-applies on top" || ko "C3 LF on top of CRLF" "$r"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $CRL" >/dev/null 2>&1

  echo "== negative proofs =="
  for fn in "public.get_moto_deportiva_status()|v_waiting boolean := false;|get_moto_deportiva_status" \
            "public._moto_deportiva_send_notice(text)|v_cooldown_h int;|_moto_deportiva_send_notice" \
            "public.admin_moto_deportiva_overview()|'pilots', COALESCE((|admin_moto_deportiva_overview"; do
    sig="${fn%%|*}"; rest="${fn#*|}"; anchor="${rest%%|*}"; name="${rest#*|}"
    fresh $NEG || { echo "base failed"; exit 1; }
    a=$(printf '%s' "$anchor" | sed "s/'/''/g")
    mutate $NEG "replace(pg_get_functiondef('$sig'::regprocedure), '$a', '$a ')"
    r=$(apply_err $NEG "$MIG"); echo "$r" | grep -q "$name has an unknown body" \
      && ok "N $name: an unknown body stops the migration" || ko "N $name unknown body" "got [$r]"
  done
  fresh $NEG || { echo "base failed"; exit 1; }
  r=$(apply_err $NEG "$MIG"); [ "$r" = applied ] || ko "N setup" "$r"
  CHECK="$(mktemp)"; awk '/^DO \$check\$/,/^\$check\$;/' "$MIG" > "$CHECK"
  r=$(apply_err $NEG "$CHECK"); [ "$r" = applied ] && ok "N the final check passes" || ko "N final check" "$r"
  run $NEG "GRANT EXECUTE ON FUNCTION public._moto_deportiva_card_visible() TO authenticated" >/dev/null
  r=$(apply_err $NEG "$CHECK"); echo "$r" | grep -q "grants are wrong" && ok "N ...stops on the helper executable by clients" || ko "N helper grant" "got [$r]"
  rm -f "$CHECK"
  "$BIN/psql" $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $NEG" >/dev/null 2>&1

  echo "== bodies after 00680 (md5/length of prosrc) =="
  run $DB "$BODIES" | tr ',' '\n'
fi
echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
