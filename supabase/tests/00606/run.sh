#!/usr/bin/env bash
# Rehearsal runner for migration 00606 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00606/run.sh none
#       -> scaffold + seed + tests (RED: heartbeats are audited, history is full of them,
#          the admin reads seq-scan the table and evaluate is_admin() per row)
#   supabase/tests/00606/run.sh supabase/migrations/00606_admin_actions_skip_watchdog_heartbeats.sql
#       -> scaffold + seed + migration x2 (idempotency) + tests + negative proofs of the self-test (GREEN)
# The migration is applied as tricigo_owner, the scaffold's non-superuser owner (prod: postgres).
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
# Other clusters: PGBIN=<dir with psql> PGPORT=<port> PYTHON=<python> supabase/tests/00606/run.sh ...
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN="-h 127.0.0.1 -p ${PGPORT:-5433} -U pgtest"
PY="${PYTHON:-python3}"
DB=pr606
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

PLATFORM=00000000-0000-0000-0000-000000000001
ALICE=a0000000-0000-4000-8000-000000000001   # customer
CAROL=a0000000-0000-4000-8000-000000000003   # admin
# txn SQL -> SQL inside a transaction that is always rolled back
txn(){ printf "BEGIN; %s ROLLBACK;" "$1"; }
# as UID ROLE SQL -> SQL as that role with JWT subject UID (as PostgREST would), rolled back
as(){ printf "BEGIN; SET LOCAL request.jwt.claim.sub = '%s'; SET LOCAL ROLE %s; %s ROLLBACK;" "$1" "$2" "$3"; }
# audit rows written by the statement under test (the trigger stamps created_at = now() of its transaction)
NEW="SELECT count(*) FROM public.admin_actions WHERE created_at = now();"
COUNTS="SELECT
  (SELECT count(*) FROM public.admin_actions WHERE admin_id = '$PLATFORM' AND action = 'update_platform_config'
     AND target_id IN ('netopia_proxy_health_at', 'db_health_detail', 'weather_last_check')) || ',' ||
  (SELECT count(*) FROM public.admin_actions WHERE admin_id = '$PLATFORM' AND action = 'update_platform_config' AND target_id = 'weather_surge_multiplier') || ',' ||
  (SELECT count(*) FROM public.admin_actions WHERE admin_id = '$PLATFORM' AND action IN ('insert_platform_config', 'delete_platform_config')) || ',' ||
  (SELECT count(*) FROM public.admin_actions WHERE admin_id = '$CAROL' AND target_type = 'platform_config') || ',' ||
  (SELECT count(*) FROM public.admin_actions WHERE admin_id = '$CAROL' AND action = 'approve_driver');"
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
   WHERE proname IN ('uid', 'current_user_role', 'is_admin', 'platform_config_is_secret', '_platform_config_audit_value', 'tg_platform_config_audit')" \
  "_platform_config_audit_value:e221259c6ce8fa9322380013075413dd/260,current_user_role:cb4a7c12d4e21fe2997135833f141e25/103,is_admin:22cb75e91980d512498034cd33e1eda2/285,platform_config_is_secret:7302ae9b8e160f90a253d5f5ace0f0b5/371,tg_platform_config_audit:4428771395a0087328397de94dab15e8/1433,uid:cdef18c69c4f4cbbced2eaf81e628b49/176"
val "S1 like prod, a non-superuser owns admin_actions; RLS on, not forced; aa_select is is_admin() per row" \
  "SELECT pg_get_userbyid(c.relowner) || '|' || r.rolsuper || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' ||
          (SELECT qual FROM pg_policies WHERE tablename = 'admin_actions' AND policyname = 'aa_select')
   FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = 'public.admin_actions'::regclass" \
  "tricigo_owner|false|true|false|is_admin()"
val "S2 seeded history: 3000 heartbeats, 400 setting changes, 8 automated insert/delete, 5 + 5000 by a person" "$COUNTS" "3000,400,8,5,5000"

if [ "$MIG" != "none" ]; then
  # A database built from the history has no admin_actions rows: the migration must apply there too, probe included.
  fresh ${DB}e || { echo "scaffold failed"; exit 1; }
  r=$(apply_err ${DB}e "$MIG"); [ "$r" = applied ] && ok "M0 on a database with no history the migration applies, probe included" || ko "M0 on a database with no history the migration applies, probe included" "$r"
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, as the owner, search_path = '') =="; $P -1 -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, as the owner, search_path = '') =="; $P -c "$AS_OWNER" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  $P -c "ANALYZE public.admin_actions;"   # prod: autovacuum analyzes after the delete
  val "M1 the self-test probe leaves no rows behind (probe keys, their audit rows)" \
    "SELECT (SELECT count(*) FROM public.platform_config WHERE key LIKE 'zz_00606%') || ',' ||
            (SELECT count(*) FROM public.admin_actions WHERE target_id LIKE 'zz_00606%')" "0,0"
fi

echo "== the trigger =="
val "T1 an automated update of a heartbeat key writes no audit row" \
  "$(txn "UPDATE public.platform_config SET value = to_jsonb('2026-10-06T03:00:00Z'::text) WHERE key = 'netopia_proxy_health_at'; $NEW")" "0"
val "T2 an automated update of a real setting is still audited" \
  "$(txn "UPDATE public.platform_config SET value = to_jsonb('1.3'::text) WHERE key = 'weather_surge_multiplier'; $NEW")" "1"
val "T3 a person updating a heartbeat key is audited under their own id" \
  "$(txn "SET LOCAL request.jwt.claim.sub = '$CAROL'; UPDATE public.platform_config SET value = to_jsonb('x'::text) WHERE key = 'db_health_detail';
          SELECT count(*) || ':' || min(admin_id::text) FROM public.admin_actions WHERE created_at = now();")" "1:$CAROL"
val "T4 automated INSERT and DELETE of a heartbeat key are still audited" \
  "$(txn "INSERT INTO public.platform_config (key, value) VALUES ('new_probe_at', to_jsonb('a'::text)); DELETE FROM public.platform_config WHERE key = 'new_probe_at';
          SELECT string_agg(action, ',' ORDER BY action) FROM public.admin_actions WHERE created_at = now();")" "delete_platform_config,insert_platform_config"
val "T5 an update that leaves the value alone writes nothing, as before" \
  "$(txn "UPDATE public.platform_config SET value = value WHERE key = 'commission_rate'; $NEW")" "0"
val "T6 a secret is still stored as a fingerprint, never the value" \
  "$(txn "SET LOCAL request.jwt.claim.sub = '$CAROL'; UPDATE public.platform_config SET value = to_jsonb('tok-new'::text) WHERE key = 'eltoque_api_token';
          SELECT (new_values ? 'value') || ',' || (new_values ->> 'redacted') || ',' || (old_values ? 'value') FROM public.admin_actions WHERE created_at = now();")" "false,true,false"

echo "== the stored history =="
val "H1 heartbeats are gone; setting changes, automated insert/delete and everything people did are intact" "$COUNTS" "0,400,8,5,5000"

echo "== who can read it =="
TOTAL=$($P -c "SELECT count(*) FROM public.admin_actions;" | tr -d '\r')
val "R1 an admin reads every row ($TOTAL)" "$(as $CAROL authenticated "SELECT count(*) FROM public.admin_actions;")" "$TOTAL"
val "R2 a customer reads nothing, without an error" "$(as $ALICE authenticated "SELECT count(*) FROM public.admin_actions;")" "0"
val "R3 anon reads nothing, without an error" "$(printf "BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.admin_actions; ROLLBACK;")" "0"

echo "== the admin reads =="
HOME_Q="SELECT * FROM public.admin_actions WHERE admin_id = '$PLATFORM' ORDER BY created_at DESC LIMIT 6"
AUDIT_Q="SELECT * FROM public.admin_actions ORDER BY created_at DESC LIMIT 50"
has "P1 aa_select runs is_admin() once per statement (InitPlan)" "$(as $CAROL authenticated "EXPLAIN (COSTS OFF) $HOME_Q;")" "InitPlan"
has "P2 the home widget reads the (admin_id, created_at) index" "$(as $CAROL authenticated "EXPLAIN (COSTS OFF) $HOME_Q;")" "admin_actions_admin_id_created_at_idx"
has "P3 the audit page reads the created_at index" "$(as $CAROL authenticated "EXPLAIN (COSTS OFF) $AUDIT_Q;")" "admin_actions_created_at_idx"
val "P4 the home widget still returns the 6 newest automated actions" \
  "$(as $CAROL authenticated "SELECT count(*) FROM ($HOME_Q) x;")" "6"

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
  sabotage g1 "IF auth.uid() IS NULL AND public._platform_config_is_telemetry(NEW.key) THEN" "IF false THEN"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g1.sql")
  echo "$r" | grep -q "audit trigger probe failed" && ok "G1 a trigger that still audits heartbeats aborts the migration" || ko "G1 a trigger that still audits heartbeats aborts the migration" "$r"
  sabotage g2 "ALTER POLICY aa_select ON public.admin_actions USING ((SELECT public.is_admin()));" "-- policy left alone"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g2.sql")
  echo "$r" | grep -q "aa_select is not" && ok "G2 a per-row aa_select aborts the migration" || ko "G2 a per-row aa_select aborts the migration" "$r"
  sabotage g3 "  AND public._platform_config_is_telemetry(target_id);

-- D. Indexes" "  AND false;

-- D. Indexes"
  fresh ${DB}g seed; r=$(apply_err ${DB}g "$T/g3.sql")
  echo "$r" | grep -q "heartbeat rows still in admin_actions" && ok "G3 heartbeats left behind abort the migration" || ko "G3 heartbeats left behind abort the migration" "$r"
  fresh ${DB}g seed
  $BIN/psql $CONN -d ${DB}g -qAt -c "CREATE OR REPLACE FUNCTION public.tg_platform_config_audit() RETURNS trigger LANGUAGE plpgsql AS \$f\$ BEGIN RETURN NEW; END \$f\$;" >/dev/null
  r=$(apply_err ${DB}g "$MIG")
  echo "$r" | grep -q "unknown body" && ok "G4 a trigger body the migration does not know aborts it" || ko "G4 a trigger body the migration does not know aborts it" "$r"
  rm -rf "$T"
  $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}g" -c "DROP DATABASE IF EXISTS ${DB}e" >/dev/null 2>&1
fi

echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
