#!/usr/bin/env bash
# Rehearsal runner for migration 00608 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00608/run.sh none
#       -> scaffold + seed + tests (RED: anon and any signed-in user read platform_config
#          secrets through get_platform_config_text/_numeric, anon may rebuild the landmask
#          and read anyone's cancellation count)
#   supabase/tests/00608/run.sh supabase/migrations/00608_lock_config_readers_and_landmask_rebuild.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00608/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr608
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
AS_OWNER="SET SESSION AUTHORIZATION tricigo_owner; SET search_path = ''"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
# (psql on Windows ends its lines with \r\n: the \r is dropped so the suite reads the same on both)
val(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r' | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# has NAME SQL PATTERN -> the output of SQL must contain PATTERN (grep -E)
has(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\r'); if echo "$r" | grep -Eq "$3"; then ok "$1"; else ko "$1" "no /$3/ in: $(echo "$r" | paste -sd' ' -)"; fi; }

ALICE=a0000000-0000-4000-8000-000000000001   # customer
CAROL=a0000000-0000-4000-8000-000000000003   # admin
# as UID ROLE SQL -> SQL as that role with JWT subject UID (as PostgREST would), rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s; %s ROLLBACK;" "$1" "$2" "$3"; }
DENIED="permission denied for function"
# who may execute the four functions: anon/authenticated/service_role, t or f each
PRIVS="SELECT string_agg(p.proname || ':' ||
         has_function_privilege('anon', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('service_role', p.oid, 'EXECUTE')::text, ',' ORDER BY p.proname)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('get_platform_config_text', 'get_platform_config_numeric', 'refresh_cuba_landmask', 'preview_cancellation_penalty')"
# fresh DBNAME [seed] -> a new database with the scaffold, and the seed when asked
fresh(){ $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1
         $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/scaffold.sql" >/dev/null 2>&1 || return 1
         if [ "${2:-}" = seed ]; then $BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -f "$DIR/seed.sql" >/dev/null 2>&1 || return 1; fi; }
# apply_err DBNAME FILE -> applies FILE as the owner in one transaction; prints the first ERROR line, or 'applied'
apply_err(){ local out; if out=$($BIN/psql $CONN -d "$1" -qAt -v ON_ERROR_STOP=1 -1 -c "$AS_OWNER" -f "$2" 2>&1); then echo applied;
             else echo "$out" | tr -d '\r' | grep -m1 ERROR; fi; }

echo "== reset database =="
fresh $DB seed || { echo "scaffold or seed failed"; exit 1; }
val "S0 scaffold carries the live prod bodies (md5/length of prosrc)" \
  "SELECT string_agg(proname || ':' || md5(prosrc) || '/' || length(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE proname IN ('uid', 'current_user_role', 'is_admin', 'platform_config_is_secret', 'platform_config_can_read_secrets',
                     'get_platform_config_text', 'get_platform_config_numeric', 'get_weather_surge',
                     'preview_cancellation_penalty', 'refresh_cuba_landmask')" \
  "current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,get_platform_config_numeric:13d2587037eca74854cf2394ba42a90c/479,get_platform_config_text:407a7b835c527164a4aa8b3aa8525ba5/205,get_weather_surge:3234b5f63ed59dc6b6771f0c39b52cbd/377,is_admin:22cb75e91980d512498034cd33e1eda2/285,platform_config_can_read_secrets:c38ca8f2ee39238d8c37a3f0b47ac879/150,platform_config_is_secret:7302ae9b8e160f90a253d5f5ace0f0b5/371,preview_cancellation_penalty:8bf30c7e8ebebeeaf1914989fdccaf91/556,refresh_cuba_landmask:a2d67b17196e26c7817628fefbdedb0f/335,uid:cdef18c69c4f4cbbced2eaf81e628b49/176"
val "S1 like prod, a non-superuser owns platform_config; RLS on, not forced; pc_select is the 00517 policy" \
  "SELECT pg_get_userbyid(c.relowner) || '|' || r.rolsuper || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' ||
          (SELECT qual FROM pg_policies WHERE tablename = 'platform_config' AND policyname = 'pc_select')
   FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'public.platform_config'::regclass" \
  "tricigo_owner|false|true|false|((NOT platform_config_is_secret(key)) OR platform_config_can_read_secrets())"

if [ "$MIG" = "none" ]; then
  val "S2 who may execute them is what prod shows on 2026-10-06" "$PRIVS" \
    "get_platform_config_numeric:true/true/true,get_platform_config_text:true/true/true,preview_cancellation_penalty:true/true/true,refresh_cuba_landmask:true/true/true"
else
  # A database with none of the config rows: the migration applies there too, probe included.
  fresh ${DB}e || { echo "scaffold failed"; exit 1; }
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 on a database with no config rows the migration applies, probe included" || ko "M0 on a database with no config rows the migration applies, probe included" "$r"
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 after the migration only service_role runs them, and a signed-in user keeps the old penalty preview" "$PRIVS" \
    "get_platform_config_numeric:false/false/true,get_platform_config_text:false/false/true,preview_cancellation_penalty:false/true/true,refresh_cuba_landmask:false/false/true"
fi

echo "== the leak =="
has "L1 anon cannot read a secret through get_platform_config_text" \
  "$(as '' anon "SELECT length(public.get_platform_config_text('openweather_api_key', NULL));")" "$DENIED get_platform_config_text"
has "L2 a signed-in customer cannot either" \
  "$(as $ALICE authenticated "SELECT length(public.get_platform_config_text('eltoque_api_token', NULL));")" "$DENIED get_platform_config_text"
has "L3 anon cannot call get_platform_config_numeric" \
  "$(as '' anon "SELECT public.get_platform_config_numeric('commission_rate', NULL);")" "$DENIED get_platform_config_numeric"
has "L4 a signed-in customer cannot either" \
  "$(as $ALICE authenticated "SELECT public.get_platform_config_numeric('commission_rate', NULL);")" "$DENIED get_platform_config_numeric"
has "L5 anon cannot rebuild the landmask" \
  "$(as '' anon "SELECT public.refresh_cuba_landmask();")" "$DENIED refresh_cuba_landmask"
has "L6 a signed-in customer cannot either" \
  "$(as $ALICE authenticated "SELECT public.refresh_cuba_landmask();")" "$DENIED refresh_cuba_landmask"
has "L7 anon cannot read a user's cancellation count" \
  "$(as '' anon "SELECT * FROM public.preview_cancellation_penalty('$ALICE');")" "$DENIED preview_cancellation_penalty"

echo "== what must keep working =="
val "K1 a signed-in user still gets the old penalty preview (client builds before 2026-06-03)" \
  "$(as $ALICE authenticated "SELECT penalty_amount || '|' || is_blocked || '|' || cancel_count_24h FROM public.preview_cancellation_penalty('$ALICE');")" "100|false|1"
val "K2 anon still gets the weather surge: a SECURITY DEFINER caller reads config as its owner" \
  "$(as '' anon "SELECT public.get_weather_surge();")" "1.4"
val "K3 so does a signed-in customer" "$(as $ALICE authenticated "SELECT public.get_weather_surge();")" "1.4"
val "K4 the table is unchanged for anon: public keys yes, secrets no" \
  "$(as '' anon "SELECT count(*) FILTER (WHERE key = 'commission_rate') || ',' || count(*) FILTER (WHERE key = 'openweather_api_key') FROM public.platform_config;")" "1,0"
val "K5 an admin still reads a secret from the table (pc_select)" \
  "$(as $CAROL authenticated "SELECT length(value #>> '{}') FROM public.platform_config WHERE key = 'openweather_api_key';")" "32"
val "K6 service_role still reads through the helpers (Edge Functions, scripts)" \
  "$(printf "BEGIN; SET LOCAL ROLE service_role; SELECT length(public.get_platform_config_text('openweather_api_key', NULL)) || ',' || public.get_platform_config_numeric('commission_rate', NULL); ROLLBACK;")" "32,0.15"

if [ "$MIG" != "none" ]; then
  echo "== negative proofs: the migration's own checks catch a broken result =="
  T=$(mktemp -d)
  # sabotage NAME OLD NEW -> a copy of the migration with OLD replaced by NEW (OLD must appear exactly once)
  sabotage(){ "$PY" - "$MIG" "$T/$1.sql" "$2" "$3" <<'PYEOF'
import sys
src, dst, old, new = sys.argv[1:5]
s = open(src, encoding='utf-8').read().replace('\r\n', '\n')
assert s.count(old) == 1, f'{old!r} appears {s.count(old)} times'
s2 = s.replace(old, new); assert s2 != s
open(dst, 'w', encoding='utf-8').write(s2)
PYEOF
  }
  sabotage g1 "get_platform_config_text(text, text) FROM PUBLIC, anon, authenticated;" "get_platform_config_text(text, text) FROM anon, authenticated;"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "anon can still execute public.get_platform_config_text" && ok "G1 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" || ko "G1 EXECUTE left to PUBLIC (anon inherits it) aborts the migration" "$r"
  sabotage g2 "get_platform_config_numeric(text, numeric) FROM PUBLIC, anon, authenticated;" "get_platform_config_numeric(text, numeric) FROM PUBLIC, anon;"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "authenticated can still execute public.get_platform_config_numeric" && ok "G2 EXECUTE left to authenticated aborts the migration" || ko "G2 EXECUTE left to authenticated aborts the migration" "$r"
  fresh ${DB}g seed
  $BIN/psql $CONN -d ${DB}g -qAt -c "SET ROLE tricigo_owner; CREATE FUNCTION public.get_platform_config_text(p_key text) RETURNS text LANGUAGE sql SECURITY DEFINER AS \$f\$ SELECT value #>> '{}' FROM public.platform_config WHERE key = p_key \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "anon can still execute public.get_platform_config_text(text)" && ok "G3 another overload left open aborts the migration" || ko "G3 another overload left open aborts the migration" "$r"
  fresh ${DB}g seed
  $BIN/psql $CONN -d ${DB}g -qAt -c "REVOKE EXECUTE ON FUNCTION public.get_weather_surge() FROM anon;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "$DENIED get_weather_surge" && ok "G4 the probe really runs as anon (a surge anon may not call aborts the migration)" || ko "G4 the probe really runs as anon (a surge anon may not call aborts the migration)" "$r"
  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
