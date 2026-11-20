#!/usr/bin/env node
// Runs the migration rehearsals a PR needs (scripts/ci/lib/rehearsal-plan.mjs) against the
// Postgres of PGHOST/PGPORT (the runners default to 127.0.0.1:5433, user pgtest):
//   node scripts/ci/rehearse-changed-migrations.mjs --base origin/master --head HEAD
// --head must be the checked-out commit: the plan reads git, the runners run from the working tree.
// RED: `run.sh none` must exit 1 and print a line starting with FAIL (the tests see the bug).
// GREEN: `run.sh <migration>` must exit 0. Each run may take up to 10 minutes; its output is
// shown while it runs.
// Exit 0: every rehearsal behaved. Exit 1: one failed, is missing or timed out. Exit 2: could not run.
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { changedFiles, git, listTree, mergeBase, readBlobs } from '../lib/git-read.mjs';
import { planRehearsals } from './lib/rehearsal-plan.mjs';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function fail(message) {
  console.error(`rehearse: ${message}`);
  process.exit(2);
}

// Runs one runner with bash, streaming its output: { status, stdout, timedOut, error }.
function run(runner, arg) {
  return new Promise((resolve) => {
    console.log(`::group::bash ${runner} ${arg}`);
    const child = spawn('bash', [runner, arg], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let timedOut = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      console.log('::endgroup::');
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stdout.write(chunk));
    child.on('error', (error) => finish({ status: null, stdout, timedOut, error }));
    child.on('close', (status) => finish({ status, stdout, timedOut }));
  });
}

try {
  const { values } = parseArgs({ strict: true, options: { base: { type: 'string' }, head: { type: 'string' } } });
  if (!values.base || !values.head) fail('--base and --head are required');
  if (git(['rev-parse', `${values.head}^{commit}`]).trim() !== git(['rev-parse', 'HEAD']).trim()) {
    fail(`--head ${values.head} is not the checked-out commit, and the runners run from the working tree`);
  }
  const fork = mergeBase(values.base, values.head);
  const changes = changedFiles(fork, values.head, { renames: true });
  const headFiles = new Set([
    ...listTree(values.head, 'supabase/migrations'),
    ...listTree(values.head, 'supabase/tests'),
  ]);
  const migrations = changes
    .filter((change) => change.status !== 'D' && change.path.startsWith('supabase/migrations/'))
    .map((change) => change.path);
  const texts = readBlobs(values.head, migrations);
  const plan = planRehearsals(changes, headFiles, (path) => (texts.get(path) ?? '').split(/\r?\n/)[0] ?? null);

  for (const notice of plan.notices) console.log(`::notice::${notice}`);
  const problems = [...plan.errors];
  const describe = (r) => (r.timedOut ? 'ran out of time' : r.error ? `could not start (${r.error.message})` : `exited ${r.status}`);
  for (const item of plan.runs) {
    if (item.red) {
      const red = await run(item.runner, 'none');
      if (red.status !== 1 || !/^FAIL\b/m.test(red.stdout)) {
        problems.push(
          `${item.runner} none ${describe(red)} without a FAIL line. It must fail without the migration (exit 1, a line starting with FAIL), or it does not test it.`,
        );
      }
    }
    const green = await run(item.runner, item.migration);
    if (green.status !== 0) problems.push(`${item.runner} ${item.migration} failed (${describe(green).replace(/^exited /, 'exit ')}).`);
  }
  for (const problem of problems) console.log(`::error::${problem}`);
  console.log(`${plan.runs.length} rehearsal(s) run, ${problems.length} problem(s).`);
  process.exit(problems.length ? 1 : 0);
} catch (error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  fail((stderr || error?.message || String(error)).split('\n')[0]);
}
