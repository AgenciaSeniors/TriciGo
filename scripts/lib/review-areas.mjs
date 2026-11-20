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

// ---- Helper inheritance ------------------------------------------------------------------
// Some service-layer files export plain functions instead of a `*Service` object
// (`uploadFileFromUri` in _storage-upload.ts, `createFleetRequestSubmission`). A file that
// IMPORTS one of those names from the API package inherits the areas of the file that exports
// it. A bare mention does not count: names such as `unavailable` are too common.

export const SERVICES_DIR = 'packages/api/src/services';
const SERVICES_FILE = /^packages\/api\/src\/services\/[^/]+\.ts$/;
const IMPORT_BLOCK = /import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const API_SOURCE = /^@tricigo\/api(?:\/|$)|(?:^|\/)services\//;
const HELPER_EXPORT = /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm;

export function apiImportsIn(text) {
  const names = new Set();
  for (const [, list, source] of text.matchAll(IMPORT_BLOCK)) {
    if (!API_SOURCE.test(source)) continue;
    for (const part of list.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

export function helperExportsIn(text) {
  const names = [...text.matchAll(HELPER_EXPORT)].map((m) => m[1]);
  return [...new Set(names.filter((name) => !/Service$/.test(name)))].sort();
}

// files: iterable of [path, text]. Returns Map(name -> sorted paths of the services files that
// export it), for names that are not `*Service`.
export function helperIndex(files) {
  const index = new Map();
  for (const [path, text] of files) {
    if (!SERVICES_FILE.test(path) || typeof text !== 'string') continue;
    for (const name of helperExportsIn(text)) {
      const paths = index.get(name) ?? [];
      if (!paths.includes(path)) paths.push(path);
      index.set(name, paths.sort());
    }
  }
  return index;
}

// Like areasForPaths, plus the areas inherited from the services each file calls or imports.
// `readText(path)` returns the file content, an array of contents (the file at the head and at
// the merge base, so a call the PR removes counts too), or null when it cannot be read.
// `helpers` is helperIndex(...) of the services files; without it only `*Service` names count.
// Areas that gained files by inheritance carry `via: { file: [identifier, ...] }`.
export function areasForChange(paths, map, readText, helpers = new Map()) {
  const byPath = areasForPaths(paths, map);
  const found = new Map(
    byPath.map((area) => [area.id, { ...area, files: new Set(area.files), via: {} }]),
  );

  const seen = new Set();
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (!path || seen.has(path) || !CODE_FILE.test(path) || map.ignore.some((re) => re.test(path))) continue;
    seen.add(path);
    const texts = [].concat(readText(path) ?? []).filter((text) => typeof text === 'string');
    if (texts.length === 0) continue;
    const sources = new Map();
    for (const text of texts) {
      for (const identifier of serviceCallsIn(text)) sources.set(identifier, [servicePathFor(identifier)]);
      for (const name of apiImportsIn(text)) if (helpers.has(name)) sources.set(name, helpers.get(name));
    }
    for (const identifier of [...sources.keys()].sort()) {
      for (const servicePath of sources.get(identifier)) {
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
  }

  return finish(found);
}

// Merges area lists computed with different maps (the base map and the head map): an area is
// touched when either list says so, with the union of its files and of its `via`.
export function unionAreas(...lists) {
  const found = new Map();
  for (const list of lists) {
    for (const area of list) {
      const entry = found.get(area.id) ?? {
        id: area.id,
        title: area.title,
        checklist: area.checklist,
        files: new Set(),
        via: {},
      };
      for (const file of area.files) entry.files.add(file);
      for (const [file, identifiers] of Object.entries(area.via ?? {})) {
        entry.via[file] = [...new Set([...(entry.via[file] ?? []), ...identifiers])].sort();
      }
      found.set(area.id, entry);
    }
  }
  return finish(found);
}

function finish(found) {
  return [...found.values()]
    .map(({ via, files, ...area }) => ({
      ...area,
      files: [...files].sort(),
      ...(Object.keys(via).length > 0 ? { via } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
