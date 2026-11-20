# Schema checklist: every migration

- [ ] **The number is free.** No other open PR or branch uses it. (CLAUDE.md: "Pre-flight para
  elegir número de migración")
- [ ] **An applied migration is never edited.** A fix is a new migration.
- [ ] **`CREATE OR REPLACE FUNCTION` starts from the live body.** The last version in production,
  not an older file, so no feature is lost. Prove: compare with `pg_get_functiondef` read from
  production. (CLAUDE.md: "Cadenas de `CREATE OR REPLACE FUNCTION`")
- [ ] **Idempotent.** Running it twice gives the same result (`IF NOT EXISTS`, `CREATE OR REPLACE`,
  guarded `INSERT`). The rehearsal applies it twice.
- [ ] **Rehearsed.** `supabase/tests/<number>/` has a scaffold and assertions that fail without
  the migration.
- [ ] **plpgsql traps avoided:** `RAISE EXCEPTION 'text' USING MESSAGE`, `make_interval` with a
  NUMERIC, a RECORD variable shadowing an alias, `COALESCE(<enum>, 'text')`, `RETURNING ... INTO`
  with two or more rows. (CLAUDE.md: the five "Trampa plpgsql" sections)
- [ ] **Cron functions:** no `EXCEPTION WHEN OTHERS` around the whole body; calls to Edge Functions
  go through `public.cron_http_post`, never `net.http_post` directly. (CLAUDE.md: "Una función de
  cron no atrapa sus propios errores"; "`pg_cron` + `net.http_post` es CIEGO")
- [ ] **Heavy changes are split.** Big backfills, `ADD COLUMN` with a default on a large table and
  new indexes on large tables are planned for the MCP limits and do not lock the apps. (CLAUDE.md:
  "Aplicar migraciones pesadas por MCP")
- [ ] **History tables have retention.** A table that grows on every event has a cleanup job.
  (CLAUDE.md: "La base colapsó por dos tablas de historial sin retención")
- [ ] **The code tolerates the migration not being applied yet.** The app keeps working until it is
  applied by hand. (CLAUDE.md: "MCP migration guard")
- [ ] **Applied with the file name.** `apply_migration` uses the file name without `.sql` as its
  name, so the registry matches the files.
- [ ] **SQL text seen by users** follows the copy rules (no voseo); the CI guard passes.
  (CLAUDE.md: "Tuteo en el texto que sale de SQL")
