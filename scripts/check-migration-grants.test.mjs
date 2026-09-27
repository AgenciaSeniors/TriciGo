// Tests for scripts/lib/migration-grants.mjs and its CLI, scripts/check-migration-grants.mjs:
//   node --test scripts/check-migration-grants.test.mjs     (pnpm test:migration-grants)
//
// Expected sequence names and the "IDENTITY needs no sequence grant" claim were
// measured on a real PostgreSQL 16 (pg_get_serial_sequence + INSERT as a role that
// holds INSERT on the table but nothing on the sequence), not deduced.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIRST_CHECKED_MIGRATION,
  analyzeMigrationSql,
  migrationNumber,
  selectMigrationsToCheck,
  serialSequenceName,
} from './lib/migration-grants.mjs';

const names = (result) => result.relations.map((r) => r.name);
const codes = (result) => result.problems.map((p) => `${p.code}:${p.relation}`);

// A migration that does everything right: RLS + policy + explicit grants.
const GOOD_TABLE = `
CREATE TABLE IF NOT EXISTS public.foo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL
);
ALTER TABLE public.foo ENABLE ROW LEVEL SECURITY;
CREATE POLICY foo_own ON public.foo FOR SELECT TO authenticated USING (user_id = auth.uid());
GRANT SELECT ON public.foo TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.foo TO service_role;
`;

describe('tables that are correctly granted', () => {
  test('a public table with explicit grants, service_role included, passes', () => {
    const r = analyzeMigrationSql(GOOD_TABLE);
    assert.deepEqual(names(r), ['public.foo']);
    assert.deepEqual(r.problems, []);
  });

  test('schema qualification may differ between CREATE and GRANT', () => {
    const a = analyzeMigrationSql('CREATE TABLE foo (id int);\nGRANT ALL ON public.foo TO service_role;');
    const b = analyzeMigrationSql('CREATE TABLE public.foo (id int);\nGRANT ALL ON TABLE foo TO service_role;');
    assert.deepEqual(names(a), ['public.foo']);
    assert.deepEqual(a.problems, []);
    assert.deepEqual(names(b), ['public.foo']);
    assert.deepEqual(b.problems, []);
  });

  test('keywords and unquoted identifiers are case-insensitive', () => {
    const r = analyzeMigrationSql('create table Public.FOO (id int);\ngrant all privileges on public.foo to SERVICE_ROLE;');
    assert.deepEqual(names(r), ['public.foo']);
    assert.deepEqual(r.problems, []);
  });

  test('quoted identifiers keep their case; a quoted lowercase name equals the bare one', () => {
    const mixed = analyzeMigrationSql('CREATE TABLE "public"."Foo" (id int);\nGRANT ALL ON public."Foo" TO "service_role";');
    assert.deepEqual(names(mixed), ['public."Foo"']);
    assert.deepEqual(mixed.problems, []);
    const lower = analyzeMigrationSql('CREATE TABLE public."foo" (id int);\nGRANT ALL ON public.foo TO service_role;');
    assert.deepEqual(names(lower), ['public.foo']);
    assert.deepEqual(lower.problems, []);
  });

  test('one GRANT may cover several tables', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.a (id int);
      CREATE TABLE public.b (id int);
      GRANT SELECT ON public.a, public.b TO anon, service_role;`);
    assert.deepEqual(names(r), ['public.a', 'public.b']);
    assert.deepEqual(r.problems, []);
  });

  test('GRANT ... ON ALL TABLES IN SCHEMA public after the CREATE covers it', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.a (id int);\nGRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;');
    assert.deepEqual(names(r), ['public.a']);
    assert.deepEqual(r.problems, []);
  });

  test('a grant to PUBLIC covers service_role', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.a (id int);\nGRANT SELECT ON public.a TO PUBLIC;');
    assert.deepEqual(names(r), ['public.a']);
    assert.deepEqual(r.problems, []);
  });

  test('column-level grants count as grants on the table', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.a (id int, secret text);
      GRANT SELECT (id) ON public.a TO authenticated;
      GRANT ALL ON public.a TO service_role;`);
    assert.deepEqual(names(r), ['public.a']);
    assert.deepEqual(r.problems, []);
  });

  test('a GRANT run through EXECUTE inside a DO block counts', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.a (id int);
      DO $$ BEGIN EXECUTE 'GRANT ALL ON public.a TO service_role'; END $$;`);
    assert.deepEqual(names(r), ['public.a']);
    assert.deepEqual(r.problems, []);
  });

  test('CREATE TABLE ... AS SELECT and UNLOGGED tables are checked like any table', () => {
    const r = analyzeMigrationSql(`
      CREATE UNLOGGED TABLE public.cache (k text PRIMARY KEY);
      CREATE TABLE public.snap AS SELECT 1 AS x;
      GRANT ALL ON public.cache, public.snap TO service_role;`);
    assert.deepEqual(names(r), ['public.cache', 'public.snap']);
    assert.deepEqual(r.problems, []);
  });
});

describe('things that are not new public relations', () => {
  test('temporary tables are ignored (they live in pg_temp)', () => {
    const r = analyzeMigrationSql(`
      CREATE TEMP TABLE t1 AS SELECT 1;
      CREATE TEMPORARY TABLE IF NOT EXISTS t2 (id int);
      CREATE LOCAL TEMP TABLE t3 (id int) ON COMMIT DROP;`);
    assert.deepEqual(names(r), []);
    assert.deepEqual(r.problems, []);
  });

  test('tables in other schemas are ignored', () => {
    const r = analyzeMigrationSql('CREATE TABLE private.x (id int);\nCREATE TABLE IF NOT EXISTS extensions.y (id int);\nCREATE TABLE "auth".z (id int);');
    assert.deepEqual(names(r), []);
  });

  test('CREATE TABLE inside comments is ignored', () => {
    const r = analyzeMigrationSql(`
      -- CREATE TABLE public.ghost (id int);
      /* CREATE TABLE ghost2 (id int);
         /* nested */ CREATE VIEW ghost3 AS SELECT 1; */
      SELECT 1;`);
    assert.deepEqual(names(r), []);
  });

  test('RETURNS TABLE, policies, indexes and triggers are not relations', () => {
    const r = analyzeMigrationSql(`
      CREATE OR REPLACE FUNCTION public.f() RETURNS TABLE (id int) LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE POLICY p ON public.rides FOR SELECT USING (true);
      CREATE INDEX IF NOT EXISTS idx ON public.rides (id);
      CREATE TRIGGER trg AFTER INSERT ON public.rides FOR EACH ROW EXECUTE FUNCTION public.g();`);
    assert.deepEqual(names(r), []);
  });
});

describe('tables missing grants fail', () => {
  test('a public table with no GRANT at all', () => {
    const r = analyzeMigrationSql('SELECT 1;\n\nCREATE TABLE public.foo (id int);\nALTER TABLE public.foo ENABLE ROW LEVEL SECURITY;');
    assert.deepEqual(codes(r), ['no-grant:public.foo']);
    assert.equal(r.problems[0].line, 3);
    assert.equal(r.problems[0].kind, 'table');
  });

  test('an unqualified CREATE TABLE is a public table', () => {
    const r = analyzeMigrationSql('CREATE TABLE IF NOT EXISTS foo (id int);');
    assert.deepEqual(codes(r), ['no-grant:public.foo']);
  });

  test('grants that leave out service_role', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.foo (id int);\nGRANT SELECT ON public.foo TO anon, authenticated;');
    assert.deepEqual(codes(r), ['no-service-role:public.foo']);
  });

  test('a GRANT on another table does not count', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.foo (id int);\nGRANT ALL ON public.foobar TO service_role;');
    assert.deepEqual(codes(r), ['no-grant:public.foo']);
  });

  test('ON ALL TABLES IN SCHEMA public before the CREATE does not cover it', () => {
    const r = analyzeMigrationSql('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;\nCREATE TABLE public.late (id int);');
    assert.deepEqual(codes(r), ['no-grant:public.late']);
  });

  test('ON ALL TABLES IN another schema does not cover a public table', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.a (id int);\nGRANT ALL ON ALL TABLES IN SCHEMA private TO service_role;');
    assert.deepEqual(codes(r), ['no-grant:public.a']);
  });

  test('ALTER DEFAULT PRIVILEGES is not a grant on the table', () => {
    const r = analyzeMigrationSql(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
      CREATE TABLE public.a (id int);`);
    assert.deepEqual(codes(r), ['no-grant:public.a']);
  });

  test('a CREATE TABLE inside a DO block runs at migration time and is checked', () => {
    const r = analyzeMigrationSql('DO $$\nBEGIN\n  CREATE TABLE IF NOT EXISTS public.inner_t (id int);\nEND\n$$;');
    assert.deepEqual(codes(r), ['no-grant:public.inner_t']);
    assert.equal(r.problems[0].line, 3);
  });

  test('only the ungranted table of a file is reported, with its own line', () => {
    const r = analyzeMigrationSql('CREATE TABLE public.ok (id int);\nGRANT ALL ON public.ok TO service_role;\nCREATE TABLE public.missing (id int);');
    assert.deepEqual(codes(r), ['no-grant:public.missing']);
    assert.equal(r.problems[0].line, 3);
  });
});

describe('views and materialized views follow the same rule', () => {
  test('granted view and materialized view pass', () => {
    const r = analyzeMigrationSql(`
      CREATE VIEW public.v WITH (security_invoker = true) AS SELECT 1 AS x;
      CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv AS SELECT 1 AS x;
      GRANT SELECT ON public.v, public.mv TO authenticated, service_role;`);
    assert.deepEqual(r.relations.map((x) => `${x.kind}:${x.name}`), ['view:public.v', 'materialized view:public.mv']);
    assert.deepEqual(r.problems, []);
  });

  test('ungranted view, OR REPLACE view and materialized view fail', () => {
    const r = analyzeMigrationSql(`
      CREATE VIEW public.v1 AS SELECT 1;
      CREATE OR REPLACE VIEW public.v2 AS SELECT 1;
      CREATE MATERIALIZED VIEW public.mv AS SELECT 1;`);
    assert.deepEqual(codes(r), ['no-grant:public.v1', 'no-grant:public.v2', 'no-grant:public.mv']);
    assert.deepEqual(r.problems.map((p) => p.kind), ['view', 'view', 'materialized view']);
  });

  test('temporary views are ignored', () => {
    const r = analyzeMigrationSql('CREATE TEMP VIEW tv AS SELECT 1;\nCREATE OR REPLACE TEMPORARY VIEW tv2 AS SELECT 1;');
    assert.deepEqual(names(r), []);
  });
});

describe('sequences behind serial and nextval() columns', () => {
  test('serialSequenceName mirrors PostgreSQL naming, including truncation to 63 chars', () => {
    assert.equal(serialSequenceName('short_t', 'id'), 'short_t_id_seq');
    // Measured on PostgreSQL 16 with pg_get_serial_sequence().
    assert.equal(
      serialSequenceName('tbl_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuv', 'col_abcdefghijklmnopqrstuvwxyz_ab'),
      'tbl_abcdefghijklmnopqrstuvwxy_col_abcdefghijklmnopqrstuvwxy_seq',
    );
    assert.equal(
      serialSequenceName('tbl_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuv', 'other'),
      'tbl_abcdefghijklmnopqrstuvwxyz_abcdefghijklmnopqrstuv_other_seq',
    );
  });

  test('bigserial + INSERT granted without USAGE on the sequence fails, naming who lacks it', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.logx (id bigserial PRIMARY KEY, msg text);
      GRANT INSERT, SELECT ON public.logx TO authenticated;
      GRANT ALL ON public.logx TO service_role;`);
    assert.deepEqual(codes(r), ['sequence-usage:public.logx']);
    assert.equal(r.problems[0].sequence, 'public.logx_id_seq');
    assert.deepEqual(r.problems[0].roles, ['authenticated', 'service_role']);
  });

  test('only the roles that can INSERT but lack USAGE are reported', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.logx (id serial PRIMARY KEY);
      GRANT INSERT ON public.logx TO authenticated;
      GRANT ALL ON public.logx TO service_role;
      GRANT USAGE, SELECT ON SEQUENCE public.logx_id_seq TO service_role;`);
    assert.deepEqual(codes(r), ['sequence-usage:public.logx']);
    assert.deepEqual(r.problems[0].roles, ['authenticated']);
  });

  test('serial with USAGE granted to every inserting role passes', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.logx (id bigserial PRIMARY KEY);
      GRANT SELECT, INSERT ON public.logx TO authenticated, service_role;
      GRANT USAGE, SELECT ON SEQUENCE logx_id_seq TO authenticated, service_role;`);
    assert.deepEqual(names(r), ['public.logx']);
    assert.deepEqual(r.problems, []);
  });

  test('GRANT ... ON ALL SEQUENCES IN SCHEMA public after the CREATE covers the sequence', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.logx (id smallserial PRIMARY KEY);
      GRANT ALL ON public.logx TO service_role;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
    assert.deepEqual(names(r), ['public.logx']);
    assert.deepEqual(r.problems, []);
  });

  test('serial on a table nobody can INSERT into through the API needs no sequence grant', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.readonly_log (id bigserial PRIMARY KEY);
      GRANT SELECT ON public.readonly_log TO authenticated, service_role;`);
    assert.deepEqual(names(r), ['public.readonly_log']);
    assert.deepEqual(r.problems, []);
  });

  test('IDENTITY columns need no sequence grant', () => {
    const r = analyzeMigrationSql(`
      CREATE TABLE public.logx (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, msg text);
      GRANT ALL ON public.logx TO authenticated, service_role;`);
    assert.deepEqual(names(r), ['public.logx']);
    assert.deepEqual(r.problems, []);
  });

  test('a DEFAULT nextval() column needs USAGE on that sequence for inserting roles', () => {
    const r = analyzeMigrationSql(`
      CREATE SEQUENCE IF NOT EXISTS public.receipt_no_seq;
      CREATE TABLE public.receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        receipt_no bigint NOT NULL DEFAULT nextval('public.receipt_no_seq'::regclass),
        note text DEFAULT 'a, b (c)'
      );
      GRANT ALL ON public.receipts TO service_role;`);
    assert.deepEqual(codes(r), ['sequence-usage:public.receipts']);
    assert.equal(r.problems[0].sequence, 'public.receipt_no_seq');
    assert.deepEqual(r.problems[0].roles, ['service_role']);
  });

  test('a standalone CREATE SEQUENCE is not required to carry grants by itself', () => {
    const r = analyzeMigrationSql('CREATE SEQUENCE IF NOT EXISTS public.contract_no_seq START 1;');
    assert.deepEqual(names(r), []);
    assert.deepEqual(r.problems, []);
  });
});

describe('explicit exemptions', () => {
  test('a grants-exempt marker with a reason skips that relation and records the reason', () => {
    const r = analyzeMigrationSql(`
      -- grants-exempt: public.internal_lock only touched by SECURITY DEFINER functions run by pg_cron
      CREATE TABLE public.internal_lock (k text PRIMARY KEY);`);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(names(r), ['public.internal_lock']);
    assert.match(r.relations[0].exempt, /SECURITY DEFINER/);
  });

  test('a marker without a reason does not exempt', () => {
    const r = analyzeMigrationSql('-- grants-exempt: public.internal_lock\nCREATE TABLE public.internal_lock (k text);');
    assert.deepEqual(codes(r), ['no-grant:public.internal_lock']);
  });

  test('a marker for another relation does not exempt this one', () => {
    const r = analyzeMigrationSql('-- grants-exempt: public.other some reason here\nCREATE TABLE public.internal_lock (k text);');
    assert.deepEqual(codes(r), ['no-grant:public.internal_lock']);
  });
});

describe('which migrations are checked', () => {
  test('the threshold is the first number after the last table-creating migration on master', () => {
    assert.equal(FIRST_CHECKED_MIGRATION, 587);
  });

  test('migrationNumber reads the leading digits', () => {
    assert.equal(migrationNumber('00598_new_table.sql'), 598);
    assert.equal(migrationNumber('00059b_wait_charge_in_complete_ride.sql'), 59);
    assert.equal(migrationNumber('README.md'), null);
  });

  test('only .sql files at or above the threshold are selected', () => {
    assert.deepEqual(
      selectMigrationsToCheck(['00586_old.sql', '00587_reserved_hole.sql', '00600_new.sql', 'notes.md', '00601_x.txt']),
      ['00587_reserved_hole.sql', '00600_new.sql'],
    );
  });
});

describe('command line', () => {
  const SCRIPT = fileURLToPath(new URL('./check-migration-grants.mjs', import.meta.url));
  const run = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-grants-'));
    try {
      for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
      return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('exits 1 and names file, line and table when a new migration lacks a GRANT', () => {
    const res = run({ '00599_probe.sql': '-- probe\nCREATE TABLE public.probe (id int);\n' });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /00599_probe\.sql:2/);
    assert.match(res.stderr, /public\.probe/);
    assert.match(res.stderr, /GRANT/);
  });

  test('exits 0 when every new relation is granted, ignoring migrations below the threshold', () => {
    const res = run({
      '00586_legacy.sql': 'CREATE TABLE public.legacy (id int);\n',
      '00599_good.sql': GOOD_TABLE,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /✓/);
  });
});
