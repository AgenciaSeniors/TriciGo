#!/usr/bin/env bash
# Rehearsal runner for migration 00592 (local Postgres 16, no Supabase stack needed).
#   supabase/tests/00592/run.sh none                                  -> scaffold + tests (RED: anon trips over current_user_role)
#   supabase/tests/00592/run.sh supabase/migrations/00592_is_admin_anon_safe.sql
#                                                                     -> scaffold + migration x2 (idempotency) + tests (GREEN)
# Cluster setup: see CLAUDE.md § "Cómo probar migraciones SQL de verdad sin tocar prod" (user pgtest, port 5433).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:-none}"
BIN=/usr/lib/postgresql/16/bin
CONN="-h 127.0.0.1 -p 5433 -U pgtest"
DB=pr592
P="$BIN/psql $CONN -d $DB -qAt -v ON_ERROR_STOP=1"
PASS=0; FAIL=0
ok(){ echo "PASS  $1"; PASS=$((PASS+1)); }
ko(){ echo "FAIL  $1  -- $2"; FAIL=$((FAIL+1)); }
# q NAME SQL EXPECTED -> the statement must succeed and print exactly EXPECTED
q(){ local r; r=$($P -c "$2" 2>&1 | tr -d '\n'); if [ "$r" = "$3" ]; then ok "$1"; else ko "$1" "expected [$3], got [$r]"; fi; }
# DO instead of a bare SELECT set_config(...) so the claim assignment prints nothing and the test reads only the query result.
as_user(){ printf "SET ROLE authenticated; DO \$\$ BEGIN PERFORM set_config('request.jwt.claim.sub', '%s', true); END \$\$; %s" "$1" "$2"; }
as_anon(){ printf "SET ROLE anon; %s" "$1"; }

ALICE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; BOB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; CAROL='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
DP_BOB='dddddddd-dddd-4ddd-8ddd-dddddddddddd'

echo "== reset database =="
$BIN/psql $CONN -d postgres -qAt -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null || exit 1
$P -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 1; }

if [ "$MIG" != "none" ]; then
  echo "== apply migration (1st, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration failed"; exit 1; }
  echo "== apply migration (2nd, idempotency, search_path = '') =="; $P -c "SET search_path = ''" -f "$MIG" >/dev/null || { echo "migration NOT idempotent"; exit 1; }
fi

echo "== tests =="
# A. is_admin() itself, per caller
q "A1 anon: is_admin() is simply false (no error)"            "$(as_anon "SELECT is_admin()")" "f"
q "A2 no JWT at all (cron / service context): false"           "SELECT is_admin()" "f"
q "A3 customer: false"                                         "$(as_user $ALICE "SELECT is_admin()")" "f"
q "A4 driver: false"                                           "$(as_user $BOB "SELECT is_admin()")" "f"
q "A5 admin: true"                                             "$(as_user $CAROL "SELECT is_admin()")" "t"
q "A6 anon still cannot execute current_user_role() directly"  "SELECT NOT has_function_privilege('anon', 'public.current_user_role()', 'EXECUTE')" "t"

# B. the two production victims
# Guards, not a reproduction: even with the pk index disabled this small scaffold never lets the
# planner evaluate the users policy for a NULL auth.uid(), while production's plan did (7 of 8
# anon SSR reads of blog_posts failed with the same 42501). They pin the intended outcome.
q "B1 public blog SSR (anon) lists the published post"          "$(as_anon "SET enable_indexscan = off; SET enable_bitmapscan = off; SELECT count(*) FROM blog_posts WHERE is_published")" "1"
q "B2 anon never sees drafts"                                   "$(as_anon "SET enable_indexscan = off; SET enable_bitmapscan = off; SELECT count(*) FROM blog_posts")" "1"
q "B3 'Conectarme' from a session-less app: 0 rows, no error"   "$(as_anon "WITH u AS (UPDATE driver_profiles SET is_online = true WHERE id = '$DP_BOB' RETURNING 1) SELECT count(*) FROM u")" "0"
q "B4 ...and the driver stays offline in the DB"                "SELECT is_online FROM driver_profiles WHERE id = '$DP_BOB'" "f"

# C. authenticated behaviour unchanged
q "C1 the driver updates his own row"                           "$(as_user $BOB "WITH u AS (UPDATE driver_profiles SET is_online = true WHERE id = '$DP_BOB' RETURNING 1) SELECT count(*) FROM u")" "1"
q "C2 a customer cannot update someone else's driver row"       "$(as_user $ALICE "WITH u AS (UPDATE driver_profiles SET is_online = false WHERE id = '$DP_BOB' RETURNING 1) SELECT count(*) FROM u")" "0"
q "C3 admin sees every user"                                    "$(as_user $CAROL "SELECT count(*) FROM users")" "3"
q "C4 customer sees only herself"                               "$(as_user $ALICE "SELECT count(*) FROM users")" "1"
q "C5 admin can read the draft too"                             "$(as_user $CAROL "SELECT count(*) FROM blog_posts")" "2"

echo "== summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
