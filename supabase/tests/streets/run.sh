#!/usr/bin/env bash
# Local rehearsal for 00582 (street corner search) on the sandbox's Postgres 16 +
# PostGIS: scaffold (live bodies + 83 real intersections) → 00582 twice → tests.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL=(sudo -u pgtest psql -p 5433 -h /home/pgtest -v ON_ERROR_STOP=1 -q)
DB=streets_rehearsal
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
"${PSQL[@]}" -d "$DB" -f supabase/tests/streets/scaffold.sql
f=$(ls supabase/migrations/00582_*.sql | head -1)
for pass in 1 2; do echo "== pass $pass applying $f"; "${PSQL[@]}" -d "$DB" -f "$f"; done
echo "== tests"
"${PSQL[@]}" -d "$DB" -f supabase/tests/streets/tests.sql -c "SELECT count(*) AS failures FROM _t_fail;" 2>&1 \
  | grep -E "PASS|FAIL|ERROR|failures|^ +[0-9]+$" || true
