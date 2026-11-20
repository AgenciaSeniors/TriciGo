// node --test scripts/ci/rehearsal-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRehearsals } from './lib/rehearsal-plan.mjs';

const files = new Set([
  'supabase/migrations/00700_new_thing.sql',
  'supabase/tests/00700/run.sh',
  'supabase/migrations/00701_exempt.sql',
  'supabase/migrations/00702_missing.sql',
  'supabase/migrations/00650_old.sql',
  'supabase/tests/00650/run.sh',
]);
const lines = {
  'supabase/migrations/00700_new_thing.sql': '-- Adds a thing.',
  'supabase/migrations/00701_exempt.sql': '-- rehearsal-exempt: only a COMMENT ON, nothing runs',
  'supabase/migrations/00702_missing.sql': 'CREATE TABLE x ();',
};
const firstLine = (p) => lines[p] ?? null;

test('a new migration with a rehearsal runs RED and GREEN', () => {
  const plan = planRehearsals([{ status: 'A', path: 'supabase/migrations/00700_new_thing.sql' }], files, firstLine);
  assert.deepEqual(plan.runs, [
    { number: '00700', migration: 'supabase/migrations/00700_new_thing.sql', runner: 'supabase/tests/00700/run.sh', red: true },
  ]);
  assert.deepEqual(plan.errors, []);
});

test('a new migration without a rehearsal fails unless its first line exempts it', () => {
  const plan = planRehearsals(
    [
      { status: 'A', path: 'supabase/migrations/00701_exempt.sql' },
      { status: 'A', path: 'supabase/migrations/00702_missing.sql' },
    ],
    files,
    firstLine,
  );
  assert.deepEqual(plan.runs, []);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /00702_missing\.sql has no rehearsal/);
  assert.match(plan.notices[0], /only a COMMENT ON/);
});

test('a short exemption reason does not count', () => {
  const plan = planRehearsals([{ status: 'A', path: 'supabase/migrations/00702_missing.sql' }], files, () => '-- rehearsal-exempt: no');
  assert.equal(plan.errors.length, 1);
});

test('a touched rehearsal of an existing migration runs GREEN only', () => {
  const plan = planRehearsals([{ status: 'M', path: 'supabase/tests/00650/scaffold.sql' }], files, firstLine);
  assert.deepEqual(plan.runs, [
    { number: '00650', migration: 'supabase/migrations/00650_old.sql', runner: 'supabase/tests/00650/run.sh', red: false },
  ]);
});

test('the template and folders without a runner are not rehearsals', () => {
  const plan = planRehearsals(
    [
      { status: 'M', path: 'supabase/tests/_template/run.sh' },
      { status: 'M', path: 'supabase/tests/poi/tests.sql' },
      { status: 'D', path: 'supabase/tests/00599/run.sh' },
    ],
    files,
    firstLine,
  );
  assert.deepEqual(plan, { runs: [], errors: [], notices: [] });
});
