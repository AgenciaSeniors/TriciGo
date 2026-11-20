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
    ],
    files,
    firstLine,
  );
  assert.deepEqual(plan, { runs: [], errors: [], notices: [] });
});

test('a deleted runner of an existing migration runs nothing', () => {
  const withOld = new Set([...files, 'supabase/migrations/00599_old.sql']);
  const plan = planRehearsals([{ status: 'D', path: 'supabase/tests/00599/run.sh' }], withOld, firstLine);
  assert.deepEqual(plan.runs, []);
});

test('a file under supabase/migrations/ with a bad name is an error, so no check skips it', () => {
  for (const path of [
    'supabase/migrations/00698-hyphen.sql',
    'supabase/migrations/00700_fix.SQL',
    'supabase/migrations/2026/00700_x.sql',
    'supabase/migrations/fix_rides.sql',
  ]) {
    const plan = planRehearsals([{ status: 'A', path }], files, firstLine);
    assert.equal(plan.errors.length, 1, path);
    assert.match(plan.errors[0], /does not follow the name/, path);
  }
});

test('a pure rename of a migration is not new; a rename that edits it is', () => {
  const pure = {
    status: 'R',
    score: 100,
    oldPath: 'supabase/migrations/00650_old.sql',
    path: 'supabase/migrations/00700_new_thing.sql',
    oldBlob: 'b1',
    newBlob: 'b1',
  };
  assert.deepEqual(planRehearsals([pure], files, firstLine), { runs: [], errors: [], notices: [] });
  const edited = planRehearsals([{ ...pure, newBlob: 'b2' }], files, firstLine);
  assert.deepEqual(edited.runs.map((r) => [r.number, r.red]), [['00700', true]]);
});

test('a changed migration runs GREEN when it has a runner, and only notices when it has none', () => {
  const withRunner = planRehearsals([{ status: 'M', path: 'supabase/migrations/00650_old.sql' }], files, firstLine);
  assert.deepEqual(withRunner.runs, [
    { number: '00650', migration: 'supabase/migrations/00650_old.sql', runner: 'supabase/tests/00650/run.sh', red: false },
  ]);
  const without = planRehearsals([{ status: 'M', path: 'supabase/migrations/00702_missing.sql' }], files, firstLine);
  assert.deepEqual(without.runs, []);
  assert.match(without.notices[0], /00702_missing\.sql changed and has no runner/);
});

test('a byte-order mark does not hide the exemption line, and a runner wins over it', () => {
  const bom = planRehearsals([{ status: 'A', path: 'supabase/migrations/00702_missing.sql' }], files, () => '﻿-- rehearsal-exempt: only a comment, nothing runs');
  assert.deepEqual(bom.errors, []);
  const both = planRehearsals([{ status: 'A', path: 'supabase/migrations/00700_new_thing.sql' }], files, () => '-- rehearsal-exempt: only a comment, nothing runs');
  assert.equal(both.runs.length, 1);
});
