#!/usr/bin/env bash
# Rehearsal runner for migration 00594 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00594/run.sh none
#       -> scaffold + tests (RED: the live function aborts as soon as 2+ rows are stale)
#   supabase/tests/00594/run.sh supabase/migrations/00594_fix_cleanup_auth_revocations.sql
#       -> scaffold + migration x2 (idempotency) + tests + negative proof of the self-test (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
DB=pr594
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# val NAME SQL EXPECTED -> the statements must succeed; their printed rows, joined with ';', must equal EXPECTED
val(){ local r; r=$($P -c "$2" 2>&1 | paste -sd';' -); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# expect_err NAME SQL PATTERN -> the statement must fail with an error matching PATTERN
expect_err(){ local r; if r=$($P -c "$2" 2>&1); then ko "$1" "expected an error, got [$r]"; elif echo "$r" | grep -q "$3"; then ok "$1"; else ko "$1" "wrong error: $(echo "$r" | head -1)"; fi; }

# seed STALE FRESH -> SQL that empties the table and inserts STALE rows older than 24 h and FRESH rows newer
seed(){ printf "TRUNCATE public.auth_revocations;
INSERT INTO public.auth_revocations (user_id, revoked_at, reason)
  SELECT gen_random_uuid(), now() - interval '2 days' - g * interval '1 minute', 'stale' FROM generate_series(1, %s) g;
INSERT INTO public.auth_revocations (user_id, revoked_at, reason)
  SELECT gen_random_uuid(), now() - interval '1 hour', 'fresh' FROM generate_series(1, %s) g;" "$1" "$2"; }
CRON='SELECT public.cleanup_auth_revocations();'   # verbatim command of cron job 28 in prod
LEFT="SELECT count(*) || '|' || count(*) FILTER (WHERE revoked_at < now() - interval '24 hours') FROM public.auth_revocations;"
ROWS="SELECT md5(string_agg(user_id::text || revoked_at::text || coalesce(reason, ''), ',' ORDER BY user_id)) FROM public.auth_revocations"

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null 2>&1 || { echo "scaffold failed"; exit 1; }
val "S0 scaffold carries the live prod body (md5 of prosrc)" \
  "SELECT md5(prosrc) || '/' || length(prosrc) FROM pg_proc WHERE oid = 'public.cleanup_auth_revocations()'::regprocedure" \
  "8fa2316a52152feef7d71eb2b51447db/213"

if [ "$MIG" != "none" ]; then
  BEFORE=$($P -c "$ROWS")
  # 1st pass in one transaction, the way `supabase db push` runs a file; 2nd in autocommit mode.
  echo "== apply migration (1st, one transaction, search_path = '') =="; $P -1 -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, autocommit, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
  val "M1 the migration's self-test leaves every row exactly as it was" "$ROWS" "$BEFORE"
fi

echo "== tests =="
# A. behaviour: the cron's own command, against the backlog shapes that break the live body
val "A1 3 stale + 2 fresh: the cron call removes the 3 stale rows"  "$(seed 3 2) $CRON $LEFT" "3;2|0"
val "A2 prod backlog (62 stale): all removed, table empty"          "$(seed 62 0) $CRON $LEFT" "62;0|0"
val "A3 1 stale row (the only case the live body survived)"         "$(seed 1 1) $CRON $LEFT" "1;1|0"
val "A4 nothing stale: returns 0 and keeps the fresh rows"          "$(seed 0 3) $CRON $LEFT" "0;3|0"
val "A5 a second run right after is a no-op"                        "$(seed 5 0) $CRON $CRON $LEFT" "5;0;0|0"
val "A6 the 24 h cutoff is unchanged (23 h kept, 25 h removed)" \
  "TRUNCATE public.auth_revocations;
   INSERT INTO public.auth_revocations VALUES (gen_random_uuid(), now() - interval '23 hours', 'keep'), (gen_random_uuid(), now() - interval '25 hours', 'drop');
   $CRON SELECT string_agg(reason, ',') FROM public.auth_revocations;" "1;keep"

# B. contract: same signature, privileges and execution context as before
val "B1 same signature and return type" \
  "SELECT pg_get_function_identity_arguments(oid) || '|' || pg_get_function_result(oid) FROM pg_proc WHERE oid = 'public.cleanup_auth_revocations()'::regprocedure" "|integer"
val "B2 still SECURITY DEFINER with the same pinned search_path" \
  "SELECT prosecdef || '|' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.cleanup_auth_revocations()'::regprocedure" "true|search_path=public, pg_catalog"
val "B3 anon cannot execute it"          "SELECT has_function_privilege('anon', 'public.cleanup_auth_revocations()', 'EXECUTE')" "f"
val "B4 authenticated cannot execute it" "SELECT has_function_privilege('authenticated', 'public.cleanup_auth_revocations()', 'EXECUTE')" "f"
val "B5 service_role can execute it, and it works with 2+ stale rows" "$(seed 4 1) SET ROLE service_role; $CRON RESET ROLE; $LEFT" "4;1|0"
expect_err "B6 anon calling it is denied" "SET ROLE anon; $CRON" "permission denied"

# N. negative proof: put the bug back into a copy of the migration; its self-test must abort it
if [ "$MIG" != "none" ]; then
  BUGGY="$(mktemp --suffix=.sql)"
  if python3 - "$MIG" "$BUGGY" <<'PYEOF'
import sys
src = open(sys.argv[1]).read()
old = "  WHERE revoked_at < now() - interval '24 hours';\n"
new = "  WHERE revoked_at < now() - interval '24 hours'\n  RETURNING 1 INTO v_deleted;\n"
marker = "RETURNING 1 INTO v_deleted;"
assert src.count(old) == 1, f"expected the DELETE's WHERE line once, found {src.count(old)}"
out = src.replace(old, new)
# The header comment quotes the bug too, so count relative to the source.
assert out != src and out.count(marker) == src.count(marker) + 1
open(sys.argv[2], "w").write(out)
PYEOF
  then
    ok "N0 built a copy of the migration with the bug put back"
    $BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS ${DB}n1" -c "CREATE DATABASE ${DB}n1" >/dev/null 2>&1
    N1="$BIN/psql $CONN -d ${DB}n1 -qAt -v ON_ERROR_STOP=1"
    $N1 -f "$DIR/scaffold.sql" >/dev/null 2>&1
    if out=$($N1 -1 -c "SET search_path = ''" -f "$BUGGY" 2>&1); then
      ko "N1 the self-test aborts a migration that still carries the bug" "migration succeeded with the bug in place"
    elif echo "$out" | grep -q "more than one row"; then
      ok "N1 the self-test aborts a migration that still carries the bug"
    else
      ko "N1 the self-test aborts a migration that still carries the bug" "wrong error: $(echo "$out" | head -1)"
    fi
  else
    ko "N0 built a copy of the migration with the bug put back" "the replacement did not apply; N1 skipped"
  fi
  rm -f "$BUGGY"
fi

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
