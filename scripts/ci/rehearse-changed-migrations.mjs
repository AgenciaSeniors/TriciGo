#!/usr/bin/env node
// Runs the migration rehearsals a PR needs (scripts/ci/lib/rehearsal-plan.mjs) against the
// Postgres of PGHOST/PGPORT (the runners default to 127.0.0.1:5433, user pgtest):
//   node scripts/ci/rehearse-changed-migrations.mjs --base origin/master --head HEAD
// RED: `run.sh none` must exit 1 and print a line starting with FAIL (the tests see the bug).
// GREEN: `run.sh <migration>` must exit 0.
// Exit 0: every rehearsal behaved. Exit 1: one failed or is missing. Exit 2: could not run.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { changedFiles, listTree, mergeBase, readBlobs } from '../lib/git-read.mjs';
import { planRehearsals } from './lib/rehearsal-plan.mjs';

function fail(message) {
  console.error(`rehearse: ${message}`);
  process.exit(2);
}

function run(runner, arg) {
  console.log(`::group::bash ${runner} ${arg}`);
  const r = spawnSync('bash', [runner, arg], { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? '');
  process.stdout.write(r.stderr ?? '');
  console.log('::endgroup::');
  if (r.error) fail(`${runner} ${arg}: ${r.error.message}`);
  return r;
}

try {
  const { values } = parseArgs({ strict: true, options: { base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base || !values.head) fail('--base and --head are required');
  const fork = mergeBase(values.base, values.head);
  const changes = changedFiles(fork, values.head, { renames: false });
  const headFiles = new Set([
    ...listTree(values.head, 'supabase/migrations'),
    ...listTree(values.head, 'supabase/tests'),
  ]);
  const migrations = changes.map((c) => c.path).filter((p) => p.startsWith('supabase/migrations/'));
  const texts = readBlobs(values.head, migrations);
  const plan = planRehearsals(changes, headFiles, (path) => (texts.get(path) ?? '').split(/\r?\n/)[0] ?? null);

  for (const notice of plan.notices) console.log(`::notice::${notice}`);
  const problems = [...plan.errors];
  for (const item of plan.runs) {
    if (item.red) {
      const red = run(item.runner, 'none');
      if (red.status !== 1 || !/^FAIL\b/m.test(red.stdout ?? '')) {
        problems.push(
          `${item.runner} none exited ${red.status} without a FAIL line. It must fail without the migration (exit 1, a line starting with FAIL), or it does not test it.`,
        );
      }
    }
    const green = run(item.runner, item.migration);
    if (green.status !== 0) problems.push(`${item.runner} ${item.migration} failed (exit ${green.status}).`);
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  console.log(`${plan.runs.length} rehearsal(s) run, ${problems.length} problem(s).`);
  process.exit(problems.length ? 1 : 0);
} catch (error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  fail((stderr || error?.message || String(error)).split('\n')[0]);
}
