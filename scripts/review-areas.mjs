#!/usr/bin/env node
// Lists the review areas (docs/review/areas.json) a change touches and the checklist to read
// for each one.
//
//   node scripts/review-areas.mjs                          # origin/master...HEAD
//   node scripts/review-areas.mjs --base <ref> --head <ref>
//   git diff --name-only A...B | node scripts/review-areas.mjs --stdin
//   add --json for machine-readable output
//
// --no-renames: a renamed file counts under its old and its new path.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { areasForPaths, loadAreas } from './lib/review-areas.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

let paths;
if (argv.includes('--stdin')) {
  paths = readFileSync(0, 'utf8').split(/\r?\n/);
} else {
  const range = `${option('--base', 'origin/master')}...${option('--head', 'HEAD')}`;
  paths = execFileSync('git', ['diff', '--name-only', '--no-renames', range], { encoding: 'utf8' }).split(/\r?\n/);
}

const areas = areasForPaths(paths, loadAreas());

if (argv.includes('--json')) {
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
