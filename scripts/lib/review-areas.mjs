// Which review areas a set of changed files touches.
//
// Source of truth: docs/review/areas.json. Read by `pnpm review:areas` (scripts/review-areas.mjs),
// by the PR description check in CI and by the cross-review skills, so the three reviewers agree
// on what is sensitive.
//
// An area matches a file when one of its `paths` regexes matches the repo-relative path, or, for
// a migration file `supabase/migrations/NNNNN_some_words.sql`, when one of the words of its name
// is in the area's `migrationWords`. Words are compared whole, so "override" never counts as
// "ride". Files matching a global `ignore` regex (docs, tests) touch no area.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const AREAS_FILE = fileURLToPath(new URL('../../docs/review/areas.json', import.meta.url));

const MIGRATION = /^supabase\/migrations\/\d+_([^/]+)\.sql$/;

export function compileAreas(config) {
  return {
    ignore: (config.ignore ?? []).map((p) => new RegExp(p)),
    areas: Object.entries(config.areas).map(([id, area]) => ({
      id,
      title: area.title,
      checklist: area.checklist,
      paths: (area.paths ?? []).map((p) => new RegExp(p)),
      migrationWords: new Set(area.migrationWords ?? []),
    })),
  };
}

export function loadAreas(file = AREAS_FILE) {
  return compileAreas(JSON.parse(readFileSync(file, 'utf8')));
}

export function normalizePath(path) {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

export function migrationWords(path) {
  const match = MIGRATION.exec(path);
  return match ? match[1].toLowerCase().split('_').filter(Boolean) : [];
}

function areaMatches(area, path) {
  if (area.paths.some((re) => re.test(path))) return true;
  return migrationWords(path).some((word) => area.migrationWords.has(word));
}

export function areasForPaths(paths, map) {
  const found = new Map();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (!path || map.ignore.some((re) => re.test(path))) continue;
    for (const area of map.areas) {
      if (!areaMatches(area, path)) continue;
      if (!found.has(area.id)) {
        found.set(area.id, { id: area.id, title: area.title, checklist: area.checklist, files: new Set() });
      }
      found.get(area.id).files.add(path);
    }
  }
  return [...found.values()]
    .map((area) => ({ ...area, files: [...area.files].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
