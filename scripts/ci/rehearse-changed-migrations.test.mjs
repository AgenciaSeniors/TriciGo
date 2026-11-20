// Tests for scripts/ci/rehearse-changed-migrations.mjs on throwaway repositories with fake
// run.sh scripts, so the RED and GREEN rules are checked without a Postgres server.
//   node --test scripts/ci/rehearse-changed-migrations.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repo = mkdtempSync(join(tmpdir(), 'rehearse-'));
after(() => rmSync(repo, { recursive: true, force: true }));

const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
const write = (path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const commit = (message) => {
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
};
const cli = (...args) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts/ci/rehearse-changed-migrations.mjs'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
// A fake runner: `red` runs for `run.sh none`, `green` for `run.sh <migration>`.
const runner = (red, green) => `#!/usr/bin/env bash\nif [ "$1" = none ]; then ${red}; else ${green}; fi\n`;
const GOOD_RED = 'echo "FAIL  T1 the column is missing"; exit 1';
const GOOD_GREEN = 'echo PASS; exit 0';

g('init', '-q', '-b', 'master');
write('supabase/migrations/00001_first.sql', 'select 1;\n');
commit('base');

const branch = (name, number, red, green) => {
  g('checkout', '-q', '-B', name, 'master');
  write(`supabase/migrations/${number}_change.sql`, 'select 1;\n');
  write(`supabase/tests/${number}/run.sh`, runner(red, green));
  commit(name);
};

test('a runner that fails without the migration and passes with it is accepted', () => {
  branch('good', '00002', GOOD_RED, GOOD_GREEN);
  const r = cli('--base', 'master', '--head', 'HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 rehearsal\(s\) run, 0 problem\(s\)/);
});

test('a runner that passes without the migration does not test it', () => {
  branch('red-passes', '00003', 'echo PASS; exit 0', GOOD_GREEN);
  const r = cli('--base', 'master', '--head', 'HEAD');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /run\.sh none exited 0 without a FAIL line/);
});

test('exit 1 without a FAIL line (an infrastructure error) does not count as RED', () => {
  branch('red-broken', '00004', 'echo "scaffold failed"; exit 1', GOOD_GREEN);
  const r = cli('--base', 'master', '--head', 'HEAD');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /run\.sh none exited 1 without a FAIL line/);
});

test('a GREEN run that fails is reported', () => {
  branch('green-fails', '00005', GOOD_RED, 'echo "FAIL  T1"; exit 1');
  const r = cli('--base', 'master', '--head', 'HEAD');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /00005_change\.sql failed \(exit 1\)/);
});

test('--head must be the checked-out commit, because the runners run from the working tree', () => {
  branch('elsewhere', '00006', GOOD_RED, GOOD_GREEN);
  const r = cli('--base', 'master', '--head', 'master');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not the checked-out commit/);
});
