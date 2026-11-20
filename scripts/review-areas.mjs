#!/usr/bin/env node
// Lists the review areas (docs/review/areas.json) a change touches and the checklist to read
// for each one.
//
//   node scripts/review-areas.mjs                          # origin/master...HEAD
//   node scripts/review-areas.mjs --base <ref> --head <ref>
//   git diff --name-only --no-renames A...B | node scripts/review-areas.mjs --stdin
//   add --json for machine-readable output
//
// Git mode uses --no-renames: a renamed file counts under its old and its new path.
// Any error (bad argument, git failure, unreadable map) prints one line to stderr and exits 2,
// so a check built on this script never passes by accident.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { areasForPaths, loadAreas } from './lib/review-areas.mjs';

function fail(message) {
  console.error(`review-areas: ${message}`);
  process.exit(2);
}

function refOption(value, name) {
  if (value === '' || value.startsWith('-')) fail(`--${name} must be a git ref, got "${value}"`);
  return value;
}

try {
  const { values } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      stdin: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  let paths;
  if (values.stdin) {
    paths = readFileSync(0, 'utf8').split(/\r?\n/);
  } else {
    const base = refOption(values.base ?? 'origin/master', 'base');
    const head = refOption(values.head ?? 'HEAD', 'head');
    paths = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    ).split('\0');
  }

  const areas = areasForPaths(paths, loadAreas());

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ areas }, null, 2)}\n`);
  } else if (areas.length === 0) {
    console.log('No sensitive area touched.');
  } else {
    for (const area of areas) {
      console.log(`${area.id}: ${area.title}`);
      console.log(`  checklist: ${area.checklist}`);
      for (const file of area.files) console.log(`  ${file}`);
    }
  }
} catch (error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  fail((stderr || error?.message || String(error)).split('\n')[0]);
}
