#!/usr/bin/env node
// The PR gate. Checks a pull request against the rules of scripts/lib/pr-gate.mjs:
//   node scripts/check-pr.mjs --base origin/master --head <sha> --body-file body.md
//        [--pr <number>] [--open-prs open-prs.json]
// In CI (.github/workflows/pr-gate.yml) this script and its libraries come from master, so a PR
// cannot weaken the gate that judges it. The review areas are the union of master's map and the
// PR's map: the PR can add areas, never remove them. Whether the cross-review is required comes
// from master's map only.
// Exit 0: every rule passes (warnings allowed). Exit 1: a rule failed. Exit 2: the gate could not run.
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { changedFiles, commitExists, isAncestor, listTree, mergeBase, readBlobs } from './lib/git-read.mjs';
import { SERVICES_DIR, areasForChange, compileAreas, helperIndex, unionAreas } from './lib/review-areas.mjs';
import { checkCrossReview, checkDescription, checkMigrations, checkTests, latestVerdict } from './lib/pr-gate.mjs';

const MAP = 'docs/review/areas.json';
const CODE_FILE = /\.(ts|tsx|js|mjs)$/;

function fail(message) {
  console.error(`check-pr: ${message}`);
  process.exit(2);
}

function refOption(value, name) {
  if (value === undefined) fail(`--${name} is required`);
  if (value === '' || value.startsWith('-')) fail(`--${name} must be a git ref, got "${value}"`);
  return value;
}

// Areas of the paths changed between two commits, with every map; files are read at both ends.
function areasBetween(from, to, maps, helpers) {
  const changes = changedFiles(from, to, { renames: false });
  const paths = changes.map((change) => change.path);
  const code = paths.filter((path) => CODE_FILE.test(path));
  const atTo = readBlobs(to, code);
  const atFrom = readBlobs(from, code);
  const read = (path) => [atTo.get(path), atFrom.get(path)];
  return { changes, paths, areas: unionAreas(...maps.map((map) => areasForChange(paths, map, read, helpers))) };
}

const annotate = (level, title, message) => {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  console.log(`::${level} title=${title}::${message.replace(/%/g, '%25').replace(/\r?\n/g, ' ')}`);
};

try {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'body-file': { type: 'string' },
      pr: { type: 'string' },
      'open-prs': { type: 'string' },
    },
  });
  const base = refOption(values.base, 'base');
  const head = refOption(values.head, 'head');
  if (!values['body-file']) fail('--body-file is required');
  const body = readFileSync(values['body-file'], 'utf8');
  const prNumber = values.pr === undefined ? Infinity : Number(values.pr);
  if (Number.isNaN(prNumber)) fail(`--pr must be a number, got "${values.pr}"`);
  const openPrs = values['open-prs']
    ? JSON.parse(readFileSync(values['open-prs'], 'utf8')).map((pr) => ({
        number: pr.number,
        files: (pr.files ?? []).map((file) => (typeof file === 'string' ? file : file.path)),
      }))
    : [];

  const baseMapText = readBlobs(base, [MAP]).get(MAP);
  if (baseMapText === undefined) fail(`${MAP} is missing on ${base}`);
  const baseConfig = JSON.parse(baseMapText);
  const maps = [compileAreas(baseConfig)];
  const headMapText = readBlobs(head, [MAP]).get(MAP);
  if (headMapText !== undefined) maps.push(compileAreas(JSON.parse(headMapText)));

  const fork = mergeBase(base, head);
  const helpers = helperIndex([
    ...readBlobs(head, listTree(head, SERVICES_DIR)),
    ...readBlobs(fork, listTree(fork, SERVICES_DIR)),
  ]);
  const { changes, paths, areas } = areasBetween(fork, head, maps, helpers);

  // The reviewed commit must be a commit of the PR (an ancestor of the head that master does not
  // have). Merging master into the PR after the review moves the merge base past it, so the merge
  // base is not used here; the files changed after the review only count when the PR itself
  // changes them, so what a merge of master brings in is left out.
  const verdict = latestVerdict(body);
  let reviewedIsAncestor = false;
  let sensitiveAfterReview = [];
  if (verdict && commitExists(verdict.sha)) {
    reviewedIsAncestor = isAncestor(verdict.sha, head) && !isAncestor(verdict.sha, base);
    if (reviewedIsAncestor) {
      const inThisPr = new Set(paths);
      const after = areasBetween(verdict.sha, head, maps, helpers);
      sensitiveAfterReview = [...new Set(after.areas.flatMap((area) => area.files))].filter((file) => inThisPr.has(file)).sort();
    }
  }

  const outcomes = [
    ['Description', checkDescription(body)],
    ['Tests', checkTests(changes, body)],
    [
      'Migrations',
      checkMigrations({
        changes: changedFiles(fork, head, { renames: true }),
        baseMigrations: listTree(fork, 'supabase/migrations'),
        masterMigrations: listTree(base, 'supabase/migrations'),
        body,
        prNumber,
        openPrs,
      }),
    ],
    [
      'Cross-review',
      checkCrossReview({
        areas,
        verdict,
        required: baseConfig.crossReview?.required === true,
        reviewedIsAncestor,
        sensitiveAfterReview,
      }),
    ],
  ];

  const lines = ['## PR gate', '', `Review areas: ${areas.length ? areas.map((a) => a.id).join(', ') : 'none'}`];
  let failed = 0;
  for (const [name, { errors, warnings }] of outcomes) {
    failed += errors.length;
    lines.push('', `### ${name}: ${errors.length ? 'FAIL' : 'ok'}`);
    for (const message of errors) {
      lines.push(`- ✗ ${message}`);
      annotate('error', `PR gate (${name})`, message);
    }
    for (const message of warnings) {
      lines.push(`- ⚠ ${message}`);
      annotate('warning', `PR gate (${name})`, message);
    }
  }
  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  process.exit(failed ? 1 : 0);
} catch (error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  fail((stderr || error?.message || String(error)).split('\n')[0]);
}
