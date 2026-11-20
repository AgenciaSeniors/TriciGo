#!/usr/bin/env node
// Lists the review areas (docs/review/areas.json) a change touches and the checklist to read
// for each one.
//
//   node scripts/review-areas.mjs                          # origin/master...HEAD
//   node scripts/review-areas.mjs --base <ref> --head <ref>   (recommended: asks git itself)
//   git -c core.quotePath=false diff --name-only --no-renames -z A...B | node scripts/review-areas.mjs --stdin
//   add --json for machine-readable output
//
// Git mode uses --no-renames: a renamed file counts under its old and its new path. A file that
// calls an API service (walletService.x) also counts in the areas of that service. In git mode the
// file content is read from <head>; with --stdin, from the working tree.
// Any error (bad argument, git failure, unreadable map) prints one line to stderr and exits 2,
// so a check built on this script never passes by accident.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { areasForChange, loadAreas } from './lib/review-areas.mjs';

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
  let readText;
  if (values.stdin) {
    paths = readFileSync(0, 'utf8').split(/\r?\n|\0/);
    readText = (path) => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    };
  } else {
    const base = refOption(values.base ?? 'origin/master', 'base');
    const head = refOption(values.head ?? 'HEAD', 'head');
    paths = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    ).split('\0');
    readText = (path) => {
      try {
        return execFileSync('git', ['-c', 'core.quotePath=false', 'show', `${head}:${path}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        return null;
      }
    };
  }

  const areas = areasForChange(paths, loadAreas(), readText);

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ areas }, null, 2)}\n`);
  } else if (areas.length === 0) {
    console.log('No sensitive area touched.');
  } else {
    for (const area of areas) {
      console.log(`${area.id}: ${area.title}`);
      console.log(`  checklist: ${area.checklist}`);
      for (const file of area.files) {
        const calls = area.via?.[file];
        console.log(calls ? `  ${file} (calls ${calls.join(', ')})` : `  ${file}`);
      }
    }
  }
} catch (error) {
  const stderr = error?.stderr ? String(error.stderr).trim() : '';
  fail((stderr || error?.message || String(error)).split('\n')[0]);
}
