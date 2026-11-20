# Migration rehearsals

Every new file `supabase/migrations/<number>_<name>.sql` comes with `supabase/tests/<number>/run.sh`.
CI (`.github/workflows/migration-rehearsal.yml`) runs it on Postgres 17 + PostGIS, as production:

- `run.sh none` must exit **1** and print at least one line starting with `FAIL`: the checks see
  what the migration fixes. An infrastructure error (scaffold failed, no server) must exit 2.
- `run.sh supabase/migrations/<file>` must exit **0**: applied twice (idempotent), every check holds.

To start one, copy `_template/` to `<number>/`, paste the live objects into `scaffold.sql`
(`scripts/sql/live-definitions.sql` prints them through the Supabase MCP), and write the checks in
`tests.sql`. A runner written in the older style (its own `val`/`ok`/`ko` helpers) is fine as long
as it keeps that contract.

A migration that really has nothing to rehearse starts with `-- rehearsal-exempt: <reason>`; the
reviewers judge the reason.

Locally (Windows): Postgres portable binaries as in CLAUDE.md, then
`PGBIN=<dir> PGPORT=<port> bash supabase/tests/<number>/run.sh none`.
