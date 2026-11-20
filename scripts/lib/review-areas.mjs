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

const MIGRATION = /^supabase\/migrations\/\d+[a-z]?_([^/]+)\.sql$/;

export function compileAreas(config) {
  return {
    ignore: (config.ignore ?? []).map((p) => new RegExp(p)),
    // Used by the map-integrity tests, not by areasForPaths.
    mustClassify: (config.mustClassify ?? []).map((p) => new RegExp(p)),
    notSensitive: new Set(config.notSensitive ?? []),
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

// ---- Service-call inheritance ------------------------------------------------------------
// A file that calls `walletService.x()` is sensitive for whatever area wallet.service.ts is in,
// whatever folder it lives in. This is how screens in the apps, the web and the panel are
// covered without listing every route folder.
//
// Any whole-word `<camel>Service` counts, not only `walletService.`: prettier splits long chains
// as `driverService\n  .getVehicle()`, and the import line names the service too. A comment that
// mentions a service also counts; over-including is the safe side.

const CODE_FILE = /\.(ts|tsx|js|mjs)$/;
const SERVICE_CALL = /\b([a-z][A-Za-z0-9]*Service)\b/g;

export function serviceCallsIn(text) {
  return [...new Set([...text.matchAll(SERVICE_CALL)].map((m) => m[1]))].sort();
}

export function servicePathFor(identifier) {
  const kebab = identifier
    .replace(/Service$/, '')
    .replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `packages/api/src/services/${kebab}.service.ts`;
}

// Like areasForPaths, plus the areas inherited from the services each file calls.
// `readText(path)` returns the file content, or null when it cannot be read (deleted file).
// Areas that gained files by inheritance carry `via: { file: [service, ...] }`.
export function areasForChange(paths, map, readText) {
  const byPath = areasForPaths(paths, map);
  const found = new Map(
    byPath.map((area) => [area.id, { ...area, files: new Set(area.files), via: {} }]),
  );

  const seen = new Set();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (!path || seen.has(path) || !CODE_FILE.test(path) || map.ignore.some((re) => re.test(path))) continue;
    seen.add(path);
    const text = readText(path);
    if (typeof text !== 'string') continue;
    for (const identifier of serviceCallsIn(text)) {
      const servicePath = servicePathFor(identifier);
      if (servicePath === path) continue;
      for (const inherited of areasForPaths([servicePath], map)) {
        if (!found.has(inherited.id)) {
          found.set(inherited.id, {
            id: inherited.id,
            title: inherited.title,
            checklist: inherited.checklist,
            files: new Set(),
            via: {},
          });
        }
        const area = found.get(inherited.id);
        if (area.files.has(path)) continue;
        area.files.add(path);
        (area.via[path] ??= []).push(identifier);
      }
    }
  }

  return [...found.values()]
    .map(({ via, files, ...area }) => ({
      ...area,
      files: [...files].sort(),
      ...(Object.keys(via).length > 0 ? { via } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
