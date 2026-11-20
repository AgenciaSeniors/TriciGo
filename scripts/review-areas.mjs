#!/usr/bin/env node
// Lists the review areas (docs/review/areas.json) a change touches and the checklist to read
// for each one.
//
//   node scripts/review-areas.mjs                          # origin/master...HEAD
//   node scripts/review-areas.mjs --base <ref> --head <ref>   (recommended: asks git itself)
//   git -c core.quotePath=false diff --name-only --no-renames -z A...B | node scripts/review-areas.mjs --stdin
//   add --json for machine-readable output
//
// Git mode uses --no-renames: a renamed file counts under its old and its new path. A file also
// counts in the areas of every API service it calls (walletService.x) or helper it imports
// (uploadFileFromUri). In git mode each file is read at <head> and at the merge base, so a call
// the change removes counts too. With --stdin, paths are relative to the repository root and the
// files are read from the working tree.
// Any error (bad argument, git failure, unreadable map) prints one line to stderr and exits 2,
// so a check built on this script never passes by accident.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { changedFiles, git, listTree, mergeBase, readBlobs } from './lib/git-read.mjs';
import { SERVICES_DIR, areasForChange, helperIndex, loadAreas } from './lib/review-areas.mjs';

const CODE_FILE = /\.(ts|tsx|js|mjs)$/;

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
  let helpers;
  if (values.stdin) {
    let root = process.cwd();
    try {
      root = git(['rev-parse', '--show-toplevel']).trim();
    } catch {
      // Not inside a repository: the paths are relative to the current folder.
    }
    const read = (path) => {
      const full = join(root, path);
      try {
        return existsSync(full) ? readFileSync(full, 'utf8') : null;
      } catch {
        return null;
      }
    };
    paths = readFileSync(0, 'utf8').split(/\r?\n|\0/);
    readText = read;
    const dir = join(root, SERVICES_DIR);
    const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.ts')) : [];
    helpers = helperIndex(names.map((name) => [`${SERVICES_DIR}/${name}`, read(`${SERVICES_DIR}/${name}`)]));
  } else {
    const base = refOption(values.base ?? 'origin/master', 'base');
    const head = refOption(values.head ?? 'HEAD', 'head');
    const fork = mergeBase(base, head);
    paths = changedFiles(fork, head, { renames: false }).map((change) => change.path);
    const code = paths.filter((path) => CODE_FILE.test(path));
    const atHead = readBlobs(head, code);
    const atFork = readBlobs(fork, code);
    readText = (path) => [atHead.get(path), atFork.get(path)];
    helpers = helperIndex([
      ...readBlobs(head, listTree(head, SERVICES_DIR)),
      ...readBlobs(fork, listTree(fork, SERVICES_DIR)),
    ]);
  }

  const areas = areasForChange(paths, loadAreas(), readText, helpers);

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
