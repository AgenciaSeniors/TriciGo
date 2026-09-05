#!/usr/bin/env bash
# Local rehearsal for the POI migrations (00579/00580/00581) on the sandbox's
# Postgres 16 + PostGIS. Resets the database every time so the run is
# deterministic (tests mutate fixtures). Usage:
#   supabase/tests/poi/run.sh            # scaffold + every 0058x migration that exists, twice (idempotency) + tests
#   MAX=00579 supabase/tests/poi/run.sh  # stop after that migration
#   ONCE=1 supabase/tests/poi/run.sh     # apply migrations only once
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL=(sudo -u pgtest psql -p 5433 -h /home/pgtest -v ON_ERROR_STOP=1 -q)
DB=poi_rehearsal
MAX="${MAX:-00581}"

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
"${PSQL[@]}" -d "$DB" -f supabase/tests/poi/scaffold.sql

apply_all() {
  for m in 00579 00580 00581; do
    [[ "$m" > "$MAX" ]] && break
    f=$(ls supabase/migrations/${m}_*.sql 2>/dev/null | head -1) || true
    [[ -n "${f:-}" ]] || continue
    echo "== applying $f"
    "${PSQL[@]}" -d "$DB" -f "$f"
  done
}
apply_all
[[ -n "${ONCE:-}" ]] || { echo "== second pass (idempotency)"; apply_all; }

if [[ -f supabase/tests/poi/tests.sql ]]; then
  echo "== tests"
  "${PSQL[@]}" -d "$DB" -f supabase/tests/poi/tests.sql 2>&1 | grep -E "PASS|FAIL|ERROR|NOTICE:  0058" || true
  "${PSQL[@]}" -d "$DB" -c "SELECT count(*) AS failures FROM _t_fail;" 2>/dev/null || true
fi
