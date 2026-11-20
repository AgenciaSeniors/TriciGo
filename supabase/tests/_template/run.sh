#!/usr/bin/env bash
# Rehearsal of one migration. Copy this folder to supabase/tests/<number>/ and fill scaffold.sql
# (the live objects the migration touches, copied from production) and tests.sql (checks that
# record what does not hold in rehearsal._t_fail, a schema of its own so the table never counts as
# one of the migration's objects in public).
#   supabase/tests/<number>/run.sh none                         -> scaffold + tests: must FAIL (exit 1)
#   supabase/tests/<number>/run.sh supabase/migrations/<file>   -> scaffold + migration twice + tests: must PASS
# Exit 0 pass, 1 a check failed or the migration failed, 2 the rehearsal could not run.
# Connection: PGHOST (127.0.0.1), PGPORT (5433), PGUSER (pgtest, a superuser), PGBIN (folder of psql).
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:?usage: run.sh none|<migration file>}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN=(-h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5433}" -U "${PGUSER:-pgtest}")
DB="rehearsal_$(basename "$DIR")"
db() { "$BIN/psql" "${CONN[@]}" -d "$DB" -qAt -v ON_ERROR_STOP=1 "$@"; }

"$BIN/psql" "${CONN[@]}" -d postgres -qAt -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\"" >/dev/null || { echo "could not create $DB"; exit 2; }
db -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 2; }
db -c "CREATE SCHEMA rehearsal; CREATE TABLE rehearsal._t_fail (name text NOT NULL, detail text);
       GRANT USAGE ON SCHEMA rehearsal TO PUBLIC; GRANT INSERT, SELECT ON rehearsal._t_fail TO PUBLIC;" >/dev/null || { echo "could not create rehearsal._t_fail"; exit 2; }

if [ "$MIG" != none ]; then
  # 1st pass in one transaction (as a migration runs), 2nd to prove it is idempotent. As postgres,
  # the scaffold's owner, which is not a superuser (as in production).
  for pass in 1 2; do
    db -1 -c "SET SESSION AUTHORIZATION postgres" -f "$MIG" >/dev/null || { echo "FAIL migration (pass $pass)"; exit 1; }
  done
fi

db -f "$DIR/tests.sql" >/dev/null || { echo "FAIL tests.sql raised an error"; exit 1; }
# No pipe here: a failed read must stop the script, never look like "no failures".
fails=$(db -c "SELECT name || coalesce(': ' || detail, '') FROM rehearsal._t_fail ORDER BY 1") || { echo "could not read rehearsal._t_fail"; exit 2; }
fails=${fails//$'\r'/}
"$BIN/psql" "${CONN[@]}" -d postgres -qAt -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1
if [ -n "$fails" ]; then
  while IFS= read -r line; do echo "FAIL $line"; done <<< "$fails"
  exit 1
fi
echo "PASS"
