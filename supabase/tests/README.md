# Migration rehearsals

Every new file `supabase/migrations/<number>_<name>.sql` comes with `supabase/tests/<number>/run.sh`.
CI (`.github/workflows/migration-rehearsal.yml`) runs it on Postgres 17 + PostGIS, as production:

- `run.sh none` must exit **1** and print at least one line starting with `FAIL`: the checks see
  what the migration fixes. The template exits 2 when the rehearsal cannot run (scaffold failed,
  no server); older runners exit 1 then, but they print no `FAIL` line, so an infrastructure error
  never counts as a good RED.
- `run.sh supabase/migrations/<file>` must exit **0**: applied twice (idempotent), every check holds.

What else CI runs:

- a migration the PR **changes** (allowed by the PR gate with a `Migration edit:` line) and a
  rehearsal folder it touches for an older migration: GREEN only;
- a **pure rename** (same content, the renumbering of a collision): nothing;
- every PR: the template itself, RED and GREEN, as a control of the server and the client.

A file under `supabase/migrations/` whose name is not `<number>_<name>.sql` fails the check: no
other check would see it.

To start one, copy `_template/` to `<number>/`, paste the live objects into `scaffold.sql`
(`scripts/sql/live-definitions.sql` prints them through the Supabase MCP), and write the checks in
`tests.sql`; a failed check inserts a row into `rehearsal._t_fail`. A runner written in the older
style (its own `val`/`ok`/`ko` helpers) is fine as long as it keeps the contract above.

A migration that really has nothing to rehearse starts with `-- rehearsal-exempt: <reason>`; the
reviewers judge the reason. When the runner exists, it runs anyway.

## Collation: CI and production sort text as en_US

Production databases use `en_US.UTF-8` (measured 2026-11-20), and so does the CI image. The local
clusters CLAUDE.md describes are created with `initdb --no-locale` (collation `C`), which sorts text
differently (en_US ignores `_` and case at the first level). A check that depends on the order of
text must either use `COLLATE "C"` explicitly or be tried on an `en_US.UTF-8` cluster
(`initdb --locale=en_US.UTF-8` on Linux), or it can pass locally and fail in CI.

## Locally

Windows: Postgres portable binaries as in CLAUDE.md, then
`PGBIN=<dir> PGPORT=<port> bash supabase/tests/<number>/run.sh none`.
`node scripts/ci/rehearse-changed-migrations.mjs --base origin/master --head HEAD` runs what CI
would run for the checked-out branch.
