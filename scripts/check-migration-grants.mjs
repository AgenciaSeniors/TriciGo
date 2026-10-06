#!/usr/bin/env node
// ============================================================
// Guardrail: every migration numbered >= FIRST_CHECKED_MIGRATION that creates a
// table, view or materialized view in `public` must GRANT it explicitly in the
// same file, service_role included. From 2026-10-30 Supabase no longer grants new
// public objects to anon / authenticated / service_role, and a table without
// GRANTs is unreachable through the Data API (apps and Edge Functions get 42501).
// The rules and the parser live in scripts/lib/migration-grants.mjs.
//
// Usage: node scripts/check-migration-grants.mjs [migrationsDir]
//        (pnpm check:migration-grants; tests: pnpm test:migration-grants)
// ============================================================

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_CHECKED_MIGRATION, analyzeMigrationSql, selectMigrationsToCheck } from './lib/migration-grants.mjs';

function main() {
  const dir = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('../supabase/migrations', import.meta.url));
  const files = selectMigrationsToCheck(readdirSync(dir));
  const shown = (file) => relative(process.cwd(), join(dir, file)).replace(/\\/g, '/');

  const problems = [];
  const exempt = [];
  let relationCount = 0;
  for (const file of files) {
    const { relations, problems: found } = analyzeMigrationSql(readFileSync(join(dir, file), 'utf8'));
    relationCount += relations.length;
    for (const r of relations.filter((x) => x.exempt)) exempt.push(`${shown(file)}:${r.line}  ${r.kind} ${r.name} — ${r.exempt}`);
    for (const p of found) problems.push(`${shown(file)}:${p.line}  ${p.message}`);
  }
  const from = String(FIRST_CHECKED_MIGRATION).padStart(5, '0');

  if (problems.length > 0) {
    console.error(`\n✖ ${problems.length} migration grant problem(s) in migrations >= ${from}:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(`
From 2026-10-30 Supabase no longer grants new public tables, views or sequences to the
Data API roles. Declare the grants in the same migration that creates the relation
(RLS still applies on top of them):
  GRANT SELECT ON public.<t> TO anon;                                   -- only if logged-out users read it
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<t> TO authenticated;  -- only what the apps need
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<t> TO service_role;   -- always (Edge Functions, scripts)
A serial column also needs  GRANT USAGE, SELECT ON SEQUENCE public.<seq> TO <every role that INSERTs>;
(or use GENERATED ALWAYS AS IDENTITY, which needs no sequence grant).
No API access at all on purpose, or a false positive of this check (for example
CREATE OR REPLACE VIEW of a view that already exists, which keeps its grants):
add  -- grants-exempt: public.<t> <reason>  to the migration.
Rule and background: CLAUDE.md, section "Tablas nuevas en public: GRANT explícito".
`);
    process.exit(1);
  }
  console.log(`✓ Migrations >= ${from} grant every new public table/view explicitly (${relationCount} relation(s) in ${files.length} file(s)).`);
  for (const e of exempt) console.log(`  exempt: ${e}`);
}

main();
