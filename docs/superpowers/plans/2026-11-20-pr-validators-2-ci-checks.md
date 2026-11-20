# PR Validators Part 2: Required CI Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every PR to `master` runs checks that read its description, its diff, its builds, its native
fingerprint, its migration rehearsals, its secrets and its new dependency advisories, so the branch
protection of the last task can make them required.

**Architecture:** Five small PRs, one per family of checks, each in its own workflow file so they can
be reviewed and merged in any order without conflicts in `ci.yml`. The rules live in plain Node
scripts with `node --test` tests (no install needed for the gate, the rehearsal planner and the audit
diff). Each check carries a built-in or a documented negative control: it is shown failing on a
broken case before it is trusted.

**Tech Stack:** Node 20/22 (`node:test`, `node:util.parseArgs`), git plumbing (`diff --name-status
-z`, `cat-file --batch`, `merge-base`), GitHub Actions, Next 15 standalone, Expo 55 (`expo export`,
`@expo/fingerprint` 0.16.6), Postgres 17 + PostGIS (`postgis/postgis:17-3.5`), gitleaks 8.30.1,
pnpm 9.15.4 (`pnpm audit`).

Spec: `docs/superpowers/specs/2026-11-20-pr-validators-and-promotion-design.md` §1. Part 1 (the area
map, the checklists, the PR template) is PR #1222.

---

## What the measurements changed (2026-11-20)

The spec was written before these were measured. The plan follows the measurements; the spec is
updated in the same commit as this plan.

| Spec said | Measured | Plan does |
|---|---|---|
| Rehearsals on the `supabase/postgres` image | 89 of the 90 `supabase/tests/*/run.sh` connect as a superuser `pgtest` on `127.0.0.1:${PGPORT:-5433}` and create `postgres`, `anon`, `authenticated`, `service_role` themselves; several assert that `postgres` is **not** a superuser. The Supabase image ships its own `postgres` and would break those checks. Production is Postgres **17.6** with PostGIS 3.3.7. | A plain `postgis/postgis:17-3.5` container pinned by digest, user `pgtest`, `max_connections=60`, `superuser_reserved_connections=3` (what 00690 needs). The contract is the one the rehearsals already follow: `run.sh none` fails, `run.sh <migration>` passes. A copyable template adds the simple `scaffold.sql` + `tests.sql` + `_t_fail` form. |
| `pnpm audit --prod --audit-level high` must pass | It reports **78** high or critical advisories on `master` today (`pnpm audit --prod --json`, 2026-11-20). One is critical and runs in production: Next 15.5.27, GHSA-2464-fhr4-w9xw, "Unauthenticated Remote Code Execution in Image Optimization API when SVG files are used", fixed in 15.5.28. 15.5.29 also fixes three moderate ones published on 2026-11-19, so both apps went to **15.5.29** in #1229 (merged and deployed 2026-11-20). | The check fails only on high or critical advisories **this PR adds** compared with `master`, plus a reviewed accept list. The Next upgrade went in its own PR, #1229 (see "Out of scope"). |
| The area map is read from the base commit | A new service added by the PR is unknown to the base map, so the PR would escape every area. | Areas are the **union** of the base map and the head map: the PR can add areas, never remove them. The gate scripts themselves come from `master` (`git archive`). |
| Label `needs-store-build` | Adding a label needs a write token. | The fingerprint job prints a warning and a job summary instead. |
| — | Migration number collisions happened five times (CLAUDE.md "Pre-flight para elegir número de migración"). | The gate fails a new migration whose number is on `master` or in an older open PR. |
| CI may pass 15 minutes | `ci.yml` takes 1-2 minutes today. | New checks run as parallel jobs; durations are recorded in each PR. |

## Checked while writing this plan

The code blocks of this plan were extracted and assembled on a scratch worktree on top of the part 1
branch (`2edf226d`), without installing anything, and run on 2026-11-20:

- `node --test scripts/review-areas.test.mjs`: 53 tests, 0 failures (after `git add`, see Task 6).
- `node --test scripts/check-pr.test.mjs`: 30 tests, 0 failures.
- `fingerprint-rules`, `rehearsal-plan`, `audit-diff` tests: all pass.
- `check-pr.mjs --base 2edf226d --head HEAD` with the blank template: exit 1 naming the seven empty
  sections and the two box rules; with a filled description: exit 0 and one cross-review warning.
  With `--base origin/master` (no map yet): exit 2.
- `rehearse-changed-migrations.mjs` on a diff without migrations: `0 rehearsal(s) run`, exit 0.
- `audit-new-advisories.mjs --base 2edf226d`: `No new high or critical advisory.`, 37 s, and its
  temporary worktree removed.
- `bash -n` on the three shell scripts, `node --check` on every new `.mjs`.

Not run here (they need Postgres, an install or GitHub): the rehearsal template, `smoke-next.sh`,
the fingerprint generator, gitleaks and every workflow. Each one's first CI run in its PR is its
check, with the negative controls of Tasks 12, 16, 22 and 26.

## Order and dependencies

| PR | Branch | Depends on | Needs `pnpm install` in the worktree |
|---|---|---|---|
| 2a PR gate | `ci/pr-gate` | #1222 merged (the area map) | no |
| 2b Builds and web lint | `ci/builds` | — | yes |
| 2c Native fingerprint | `ci/native-fingerprint` | — | yes |
| 2d Migration rehearsal | `ci/migration-rehearsal` | — | no |
| 2e Secrets and audit | `ci/secrets-audit` | — | no |
| Branch protection | — | 2a-2e merged, each check green once | — |

Each PR: own worktree from `origin/master` (`git worktree add -b <branch> C:/Users/Eduardo/TriciGo/.claude/worktrees/<branch-dir> origin/master`),
PR template filled, Eduardo's OK before every push, PR and merge. 2b-2e each add the `^scripts/ci/`
path to the access area of `docs/review/areas.json` if it is not there yet (the map tests require
every path regex to match a tracked file, so it cannot be added before a file exists).

Running commands: all commands below are for Git Bash from the worktree root, with
`export MSYS_NO_PATHCONV=1` set once (it stops Git Bash from rewriting `origin/master:path`).

---

# PR 2a — PR gate

> **As built (2026-11-20), after the code review of the branch:** the code below is what the plan
> started from; `master` has the reviewed version. Six findings changed it:
> 1. `pr-gate.yml` runs on **`pull_request_target`** with `persist-credentials: false` and no
>    fallback to the PR's copy: with `pull_request` GitHub runs the PR's own workflow file, so a PR
>    could turn the gate into `exit 0`. Consequence: the gate does not run on the PR that adds it;
>    Task 8's red/green proof is done on a throwaway PR after the merge.
> 2. `readBlobs` throws on a path with a line break (it would shift every answer of
>    `cat-file --batch`).
> 3. `changedFiles` uses `--raw --no-abbrev` and returns `oldBlob`/`newBlob`; a pure rename needs
>    equal blobs (git scores a file whose lines were only reordered as R100).
> 4. A rename out of `supabase/migrations/` counts as a delete.
> 5. Migration numbers are checked against `master` as it is now (`masterMigrations`), not the merge
>    base; two new migrations of one PR may not share a number.
> 6. The reviewed sha must be an ancestor of the head and not of `master` (the merge base is not
>    used), and only files the PR itself changes count as "changed after the review", so merging
>    `master` into the PR keeps a verdict valid. Also: a deleted test does not count as a test, and
>    the open-PR list reads every file of every open PR (`gh api --paginate …/files`).

The gate reads the PR description and the diff. Files:

- Create `scripts/lib/git-read.mjs`: git plumbing shared by the two CLIs.
- Modify `scripts/lib/review-areas.mjs`: helper-import inheritance, several texts per file, `unionAreas`.
- Modify `scripts/review-areas.mjs`: read the merge base too, read helpers, resolve stdin paths from the repo root.
- Modify `scripts/review-areas.test.mjs`.
- Modify `docs/review/areas.json`: web hooks, gate files, `crossReview.required`.
- Create `scripts/lib/pr-gate.mjs`: the rules, pure functions.
- Create `scripts/check-pr.mjs`: the gate CLI.
- Create `scripts/check-pr.test.mjs`.
- Create `.github/workflows/pr-gate.yml`.
- Modify `.github/workflows/ci.yml`, `package.json`, `.github/pull_request_template.md`, `docs/review/README.md`, `CLAUDE.md`.

### Task 1: git plumbing module

**Files:**
- Create: `scripts/lib/git-read.mjs`
- Test: `scripts/check-pr.test.mjs` (created here, grows in later tasks)

- [ ] **Step 1: Write the failing test**

Create `scripts/check-pr.test.mjs`:

```js
// Tests for the PR gate: the git reader (scripts/lib/git-read.mjs), the rules
// (scripts/lib/pr-gate.mjs) and the CLI (scripts/check-pr.mjs) on throwaway repositories.
//   node --test scripts/check-pr.test.mjs     (pnpm test:pr-gate)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, commitExists, isAncestor, readBlobs } from './lib/git-read.mjs';

describe('git-read', () => {
  const repo = mkdtempSync(join(tmpdir(), 'git-read-'));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  const commit = (m) => g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m);

  test('changedFiles reports a pure rename as R100, readBlobs reads accented paths and skips the rest', () => {
    g('init', '-q');
    mkdirSync(join(repo, 'a'));
    writeFileSync(join(repo, 'a/uno.sql'), 'select 1;\n'.repeat(5));
    writeFileSync(join(repo, 'a/ñandú.txt'), 'hola\n');
    g('add', '-A');
    commit('base');
    g('mv', 'a/uno.sql', 'a/dos.sql');
    commit('rename');
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      assert.deepEqual(changedFiles('HEAD~1', 'HEAD'), [
        { status: 'R', score: 100, oldPath: 'a/uno.sql', path: 'a/dos.sql' },
      ]);
      assert.deepEqual(
        changedFiles('HEAD~1', 'HEAD', { renames: false }).map((c) => `${c.status} ${c.path}`).sort(),
        ['A a/dos.sql', 'D a/uno.sql'],
      );
      assert.deepEqual([...readBlobs('HEAD', ['a/ñandú.txt', 'a/missing.txt', 'a'])], [['a/ñandú.txt', 'hola\n']]);
      assert.equal(isAncestor('HEAD~1', 'HEAD'), true);
      assert.equal(isAncestor('HEAD', 'HEAD~1'), false);
      assert.equal(commitExists('HEAD'), true);
      assert.equal(commitExists('f'.repeat(40)), false);
    } finally {
      process.chdir(cwd);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/check-pr.test.mjs`
Expected: FAIL with `Cannot find module` … `scripts/lib/git-read.mjs`.

- [ ] **Step 3: Write the module**

Create `scripts/lib/git-read.mjs`:

```js
// Reading a repository through git, without touching the working tree. Used by
// scripts/review-areas.mjs and scripts/check-pr.mjs. Every function throws on a git failure;
// the CLIs turn that into exit 2, so a check built on them never passes by accident.
import { execFileSync } from 'node:child_process';

const BIG = 256 * 1024 * 1024;

export function git(args) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: BIG,
  });
}

export function mergeBase(a, b) {
  return git(['merge-base', a, b]).trim();
}

export function commitExists(ref) {
  try {
    git(['cat-file', '-e', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function isAncestor(a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// Changed files between two commits: [{ status, path, oldPath?, score? }]. `status` is the letter
// git prints (A, M, D, T, R, C). With renames on, a rename carries its similarity in `score`
// (100 = the same content under a new name).
export function changedFiles(from, to, { renames = true } = {}) {
  const parts = git(['diff', '--name-status', '-z', renames ? '--find-renames' : '--no-renames', from, to])
    .split('\0')
    .filter((part) => part !== '');
  const changes = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0];
    if (status === 'R' || status === 'C') {
      changes.push({ status, score: Number(code.slice(1)), oldPath: parts[i++], path: parts[i++] });
    } else {
      changes.push({ status, path: parts[i++] });
    }
  }
  return changes;
}

export function listTree(ref, dir) {
  return git(['ls-tree', '-r', '--name-only', '-z', ref, '--', dir]).split('\0').filter(Boolean);
}

// Text of many files at one commit, in a single git process: Map(path -> text). Paths that are
// missing or are not files are left out.
export function readBlobs(ref, paths) {
  const result = new Map();
  if (paths.length === 0) return result;
  const out = execFileSync('git', ['cat-file', '--batch'], {
    input: paths.map((path) => `${ref}:${path}`).join('\n') + '\n',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: BIG,
  });
  let offset = 0;
  for (const path of paths) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.toString('utf8', offset, newline);
    offset = newline + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) continue;
    const [, type, size] = header.split(' ');
    const length = Number(size);
    if (type === 'blob') result.set(path, out.toString('utf8', offset, offset + length));
    offset += length + 1;
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/check-pr.test.mjs`
Expected: PASS, `tests 1`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/git-read.mjs scripts/check-pr.test.mjs
git commit -m "feat(ci): git plumbing for the PR gate"
```

### Task 2: helpers, merge-base texts and map unions in the area library

**Files:**
- Modify: `scripts/lib/review-areas.mjs` (the "Service-call inheritance" section, lines 70-137)
- Test: `scripts/review-areas.test.mjs`

- [ ] **Step 1: Write the failing tests**

In `scripts/review-areas.test.mjs`, add `apiImportsIn`, `helperExportsIn`, `helperIndex` and
`unionAreas` to the import list from `./lib/review-areas.mjs`, then add this block after
`describe('helpers', …)`:

```js
describe('helper inheritance', () => {
  const storage = ['packages/api/src/services/_storage-upload.ts', 'export async function uploadFileFromUri() {}\n'];

  test('apiImportsIn reads names imported from the API package, across lines, with type and as', () => {
    const text = [
      "import { walletService, uploadFileFromUri as upload } from '@tricigo/api';",
      'import {',
      '  type FleetRequest,',
      '  createFleetRequestSubmission,',
      "} from '@tricigo/api/services/fleetRequestSubmission';",
      "import { useState } from 'react';",
      "import Default, { readCorporateBalance } from '../services/_corporate-balance';",
    ].join('\n');
    assert.deepEqual(apiImportsIn(text), [
      'FleetRequest',
      'createFleetRequestSubmission',
      'readCorporateBalance',
      'uploadFileFromUri',
      'walletService',
    ]);
  });

  test('helperExportsIn lists exported functions and constants that are not *Service', () => {
    const text = 'export async function uploadFileFromUri() {}\nexport const MAX = 1;\nexport const walletService = {};\nfunction hidden() {}\n';
    assert.deepEqual(helperExportsIn(text), ['MAX', 'uploadFileFromUri']);
  });

  test('helperIndex keeps only files directly under services/', () => {
    const index = helperIndex([
      storage,
      ['packages/api/src/services/__tests__/x.test.ts', 'export function fake() {}'],
      ['packages/api/src/index.ts', 'export function other() {}'],
    ]);
    assert.deepEqual([...index], [['uploadFileFromUri', ['packages/api/src/services/_storage-upload.ts']]]);
  });

  test('a file that imports a helper inherits the areas of the file that exports it (real map)', () => {
    const text = "import { uploadFileFromUri } from '@tricigo/api';\nawait uploadFileFromUri(uri);\n";
    const areas = areasForChange(['apps/client/src/zz-test/Upload.tsx'], real, () => text, helperIndex([storage]));
    const access = areas.find((a) => a.id === 'access');
    assert.ok(access, JSON.stringify(areas));
    assert.deepEqual(access.via, { 'apps/client/src/zz-test/Upload.tsx': ['uploadFileFromUri'] });
  });

  test('a bare mention of a helper name, without the import, does not count', () => {
    assert.deepEqual(
      areasForChange(['apps/client/src/zz-test/Upload.tsx'], real, () => '// uploadFileFromUri\n', helperIndex([storage])),
      [],
    );
  });

  test('readText may return the head and the merge-base text: a removed call still counts', () => {
    const areas = areasForChange(['apps/client/src/zz-test/Pay.tsx'], real, () => ['export {};\n', 'walletService.pay();\n']);
    assert.ok(areas.some((a) => a.id === 'money'), JSON.stringify(areas));
  });

  test('unionAreas keeps every area of every list and merges their files', () => {
    const a = [{ id: 'money', title: 'M', checklist: 'm.md', files: ['x.ts'] }];
    const b = [
      { id: 'money', title: 'M', checklist: 'm.md', files: ['y.ts'], via: { 'y.ts': ['walletService'] } },
      { id: 'access', title: 'A', checklist: 'a.md', files: ['z.ts'] },
    ];
    assert.deepEqual(unionAreas(a, b), [
      { id: 'access', title: 'A', checklist: 'a.md', files: ['z.ts'] },
      { id: 'money', title: 'M', checklist: 'm.md', files: ['x.ts', 'y.ts'], via: { 'y.ts': ['walletService'] } },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/review-areas.test.mjs`
Expected: FAIL with `does not provide an export named 'apiImportsIn'`.

- [ ] **Step 3: Implement**

In `scripts/lib/review-areas.mjs`, replace everything from the line
`// ---- Service-call inheritance ----…` to the end of the file with:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/review-areas.test.mjs`
Expected: PASS, `tests 50`, `fail 0` (43 old tests + 7 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/review-areas.mjs scripts/review-areas.test.mjs
git commit -m "feat(review): inherit areas from imported service helpers and from the merge base"
```

### Task 3: the review-areas CLI reads both commits and works from a subfolder

**Files:**
- Modify: `scripts/review-areas.mjs`
- Test: `scripts/review-areas.test.mjs` (inside `describe('CLI', …)`)

- [ ] **Step 1: Write the failing tests**

Inside `describe('CLI', () => { … })`, after the existing tests, add:

```js
  test('--stdin resolves paths from the repository root when run in a subfolder', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/review-areas.mjs'), '--stdin', '--json'], {
      cwd: join(ROOT, 'apps'),
      input: 'apps/web/src/app/profile/corporate/page.tsx\n',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).areas.some((a) => a.id === 'money'), r.stdout);
  });

  describe('git mode reads the merge base and the helpers', () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-areas-base-'));
    after(() => rmSync(repo, { recursive: true, force: true }));
    const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    const commit = (m) => {
      g('add', '-A');
      g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', m);
    };
    const write = (path, text) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    };

    test('a screen that stops calling a service still counts in its areas', () => {
      g('init', '-q');
      write('apps/client/src/zz-test/Pay.tsx', 'walletService.pay();\n');
      commit('base');
      write('apps/client/src/zz-test/Pay.tsx', 'export {};\n');
      commit('remove the call');
      const r = cli(repo, '--base', 'HEAD~1', '--head', 'HEAD', '--json');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(JSON.parse(r.stdout).areas.some((a) => a.id === 'money'), r.stdout);
    });

    test('a file that imports a helper of the services folder inherits its areas', () => {
      write('packages/api/src/services/_storage-upload.ts', 'export async function uploadFileFromUri() {}\n');
      commit('helper');
      write('apps/client/src/zz-test/Upload.tsx', "import { uploadFileFromUri } from '@tricigo/api';\n");
      commit('use it');
      const r = cli(repo, '--base', 'HEAD~1', '--head', 'HEAD', '--json');
      assert.equal(r.status, 0, r.stderr);
      const access = JSON.parse(r.stdout).areas.find((a) => a.id === 'access');
      assert.deepEqual(access?.via, { 'apps/client/src/zz-test/Upload.tsx': ['uploadFileFromUri'] });
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/review-areas.test.mjs`
Expected: the three new tests FAIL (no `money` from the subfolder; no `money` after the removed
call; `access?.via` undefined).

- [ ] **Step 3: Implement**

Replace `scripts/review-areas.mjs` with:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/review-areas.test.mjs`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/review-areas.mjs scripts/review-areas.test.mjs
git commit -m "fix(review): read the merge base and the helpers, resolve stdin from the repo root"
```

### Task 4: classify the web hooks and the gate files

**Files:**
- Modify: `docs/review/areas.json`

- [ ] **Step 1: Write the failing change (the map test turns red)**

In `docs/review/areas.json`, append to `mustClassify`:

```json
"^apps/web/src/hooks/[^/]+\\.ts$"
```

Run: `node --test scripts/review-areas.test.mjs`
Expected: FAIL in "every file under mustClassify is in an area or in notSensitive", listing the ten
files of `apps/web/src/hooks/`.

- [ ] **Step 2: Classify them like their app twins**

The client hooks of the same name are already classified (`useChat` and `useRiderLocationSharing`
in access; `useDriverPosition`, `useSearchingDrivers`, `useTripProgress`, `useMotoDeportivaStatus`
in dispatch; `useDestinationPredictions`, `useUnreadChatCount` not sensitive). In `areas.json`:

- `areas.access.paths`: add `"^apps/web/src/hooks/(useChat|useRiderLocationSharing)\\.ts$"`.
- `areas.dispatch.paths`: add `"^apps/web/src/hooks/(useDriverPosition|useSearchingDrivers|useSearchingRide|useTripProgress|useMotoDeportivaStatus)\\.ts$"`.
- `notSensitive`: add `"apps/web/src/hooks/useDestinationPredictions.ts"`, `"apps/web/src/hooks/useGeolocation.ts"`, `"apps/web/src/hooks/useUnreadChatCount.ts"`.

- [ ] **Step 3: Put the gate files in the access area and add the cross-review switch**

In `areas.access.paths`, replace `"^scripts/(lib/)?review-areas\\.mjs$"` with:

```json
"^scripts/(review-areas|check-pr)\\.mjs$",
"^scripts/lib/(review-areas|git-read|pr-gate)\\.mjs$"
```

(`check-pr.mjs` and `pr-gate.mjs` are created in Tasks 5-6; the map test that checks every
alternative matches a tracked file is run again at the end of Task 6.)

Add a top-level key after `notSensitive`:

```json
"crossReview": {
  "required": false,
  "note": "Part 3 (cross-review skills) sets this to true. The PR gate reads it from master, never from the PR."
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/review-areas.test.mjs`
Expected: everything passes except the per-alternative test, which names `check-pr` and
`pr-gate` (files not created yet). That one turns green in Task 6 Step 6.

- [ ] **Step 5: Commit**

```bash
git add docs/review/areas.json
git commit -m "feat(review): classify the web hooks, put the PR gate in the access area"
```

### Task 5: the gate rules

**Files:**
- Create: `scripts/lib/pr-gate.mjs`
- Test: `scripts/check-pr.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `scripts/check-pr.test.mjs`:

```js
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SECTIONS,
  checkCrossReview,
  checkDescription,
  checkMigrations,
  checkTests,
  isEmptySection,
  latestVerdict,
  migrationEdits,
  parseSections,
  reasonFor,
  stripComments,
} from './lib/pr-gate.mjs';
```

(merge `readFileSync` into the existing `node:fs` import and `dirname` into the `node:path` one).
Then add after the `git-read` block:

```js
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
const SHA = 'a'.repeat(40);

// A description that passes every rule; `overrides` replaces the content of named sections.
function filledBody(overrides = {}) {
  const content = {
    'What changes': 'Drivers see their approval bonus in the wallet.',
    Why: 'The bonus was paid by hand.',
    'How it was validated': '```\n$ pnpm test\nok\n```',
    Tests: 'packages/api/src/__tests__/bonus.test.ts proves the call.',
    'Review areas': '```\nNo sensitive area touched.\n```',
    'Cross-review': 'Not required, no review area touched.',
    'Native and OTA': '- [ ] JavaScript only: can ship by OTA\n- [ ] Needs a store build\n- [x] Does not touch the mobile apps',
    Migrations: 'None.',
    'Final check': '- [x] No secret\n- [x] Docs updated',
    ...overrides,
  };
  return SECTIONS.map((name) => `## ${name}\n\n${content[name] ?? ''}\n`).join('\n');
}

describe('description', () => {
  test('the template has exactly the sections the gate checks, in order', () => {
    assert.deepEqual([...parseSections(TEMPLATE).keys()], SECTIONS);
  });

  test('the blank template fails on every section a person has to write', () => {
    const { errors } = checkDescription(TEMPLATE);
    for (const name of ['What changes', 'Why', 'How it was validated', 'Tests', 'Review areas', 'Cross-review', 'Migrations']) {
      assert.ok(errors.some((e) => e.includes(`"## ${name}" section is empty`)), name);
    }
    assert.ok(errors.some((e) => e.includes('ticked: 0')));
    assert.ok(errors.some((e) => e.includes('"## Final check"')));
  });

  test('a filled description passes, also with CRLF line ends', () => {
    assert.deepEqual(checkDescription(filledBody()).errors, []);
    assert.deepEqual(checkDescription(filledBody().replace(/\n/g, '\r\n')).errors, []);
  });

  test('a section holding only a comment or an empty fence is empty', () => {
    assert.ok(isEmptySection(stripComments('<!-- x -->')));
    assert.ok(isEmptySection('\n```\n```\n'));
    assert.ok(isEmptySection('\n~~~bash\n\n~~~\n'));
    assert.equal(isEmptySection('```\nok\n```'), false);
  });

  test('comments are stripped before reading, also one that is never closed', () => {
    assert.equal(stripComments('a<!-- b -->c'), 'ac');
    assert.equal(stripComments('a<!-- b\nc'), 'a');
    assert.ok(checkDescription(filledBody({ Why: '<!-- only a comment -->' })).errors.some((e) => e.includes('"## Why" section is empty')));
  });

  test('Native and OTA needs exactly one ticked box', () => {
    assert.ok(checkDescription(filledBody({ 'Native and OTA': '- [ ] a\n- [ ] b\n- [ ] c' })).errors.some((e) => e.includes('ticked: 0')));
    assert.ok(checkDescription(filledBody({ 'Native and OTA': '- [x] a\n- [X] b\n- [ ] c' })).errors.some((e) => e.includes('ticked: 2')));
  });

  test('Final check needs every box ticked', () => {
    assert.ok(checkDescription(filledBody({ 'Final check': '- [x] a\n- [ ] b' })).errors.some((e) => e.includes('"## Final check"')));
  });
});

describe('reason lines', () => {
  test('No tests because needs a real reason, outside comments', () => {
    assert.equal(reasonFor('No tests because: <reason>', 'No tests because'), null);
    assert.equal(reasonFor('No tests because: docs', 'No tests because'), null);
    assert.equal(reasonFor('<!-- No tests because: it is only a comment -->', 'No tests because'), null);
    assert.equal(reasonFor('x\nNo tests because: only the README changes.\n', 'No tests because'), 'only the README changes.');
  });

  test('Migration edit lines map a path to its reason', () => {
    const edits = migrationEdits(
      'Migration edit: supabase/migrations/00650_x.sql fixes a typo in a comment\nMigration edit: supabase/migrations/00651_y.sql short',
    );
    assert.deepEqual([...edits.keys()], ['supabase/migrations/00650_x.sql']);
  });

  test('latestVerdict takes the last valid line', () => {
    const body = [
      `Cross-review: APPROVED w1 ${'b'.repeat(40)}`,
      `Cross-review: FIX_CONFIRMED w1 ${SHA}`,
      `Cross-review: MAYBE w2 ${SHA}`,
      'Cross-review: APPROVED w3 abc',
    ].join('\n');
    assert.deepEqual(latestVerdict(body), { verdict: 'FIX_CONFIRMED', workId: 'w1', sha: SHA });
    assert.equal(latestVerdict(`<!-- Cross-review: APPROVED w1 ${SHA} -->`), null);
  });
});

describe('tests come with the change', () => {
  test('source without tests fails; with a test or a reason it passes', () => {
    const src = ['packages/api/src/services/wallet.service.ts'];
    assert.equal(checkTests(src, filledBody()).errors.length, 1);
    assert.deepEqual(checkTests([...src, 'packages/api/src/services/__tests__/wallet.test.ts'], filledBody()).errors, []);
    assert.deepEqual(checkTests(src, filledBody({ Tests: 'No tests because: the change only renames a log line.' })).errors, []);
  });

  test('what counts as source and what counts as a test', () => {
    for (const path of ['apps/driver/app/(tabs)/index.tsx', 'apps/web/src/app/page.tsx', 'supabase/functions/send-push/index.ts', 'supabase/migrations/00700_x.sql']) {
      assert.equal(checkTests([path], filledBody()).errors.length, 1, path);
    }
    for (const path of ['supabase/functions/send-push/index.test.ts', 'supabase/tests/00700/run.sh', '.maestro/flows/login.yaml', 'apps/client/src/hooks/__tests__/x.test.ts']) {
      assert.deepEqual(checkTests(['apps/web/src/app/page.tsx', path], filledBody()).errors, [], path);
    }
    assert.deepEqual(checkTests(['docs/review/money.md', '.github/workflows/ci.yml'], filledBody()).errors, []);
  });
});

describe('migrations', () => {
  const base = ['supabase/migrations/00650_a.sql', 'supabase/migrations/00651_b.sql'];
  const run = (changes, { body = filledBody(), openPrs = [], prNumber = 50 } = {}) =>
    checkMigrations({ changes, baseMigrations: base, body, prNumber, openPrs }).errors;

  test('changing or deleting a migration already on master fails', () => {
    assert.match(run([{ status: 'M', path: base[0] }])[0], /already on master and this PR changes it/);
    assert.match(run([{ status: 'D', path: base[1] }])[0], /deletes it/);
  });

  test('a Migration edit line with a reason allows the change', () => {
    const body = filledBody({ Migrations: `Migration edit: ${base[0]} the header comment had the wrong number` });
    assert.deepEqual(run([{ status: 'M', path: base[0] }], { body }), []);
  });

  test('a pure rename passes, a rename that also edits fails', () => {
    assert.deepEqual(run([{ status: 'R', score: 100, oldPath: base[1], path: 'supabase/migrations/00652_b.sql' }]), []);
    assert.equal(run([{ status: 'R', score: 92, oldPath: base[1], path: 'supabase/migrations/00652_b.sql' }]).length, 1);
  });

  test('a new migration may not reuse a number of master', () => {
    assert.match(run([{ status: 'A', path: 'supabase/migrations/00650_c.sql' }])[0], /already used on master by supabase\/migrations\/00650_a\.sql/);
    assert.deepEqual(run([{ status: 'A', path: 'supabase/migrations/00652_c.sql' }]), []);
  });

  test('a renumbering in the same PR frees the old number', () => {
    assert.deepEqual(
      run([
        { status: 'R', score: 100, oldPath: base[1], path: 'supabase/migrations/00653_b.sql' },
        { status: 'A', path: 'supabase/migrations/00651_c.sql' },
      ]),
      [],
    );
  });

  test('the older open PR keeps a number', () => {
    const openPrs = [
      { number: 40, files: ['supabase/migrations/00652_other.sql', base[0]] },
      { number: 60, files: ['supabase/migrations/00653_other.sql'] },
    ];
    assert.match(run([{ status: 'A', path: 'supabase/migrations/00652_c.sql' }], { openPrs })[0], /older open PR #40/);
    assert.deepEqual(run([{ status: 'A', path: 'supabase/migrations/00653_c.sql' }], { openPrs }), []);
  });
});

describe('cross-review', () => {
  const areas = [{ id: 'money', files: ['packages/api/src/services/wallet.service.ts'] }];
  const verdict = { verdict: 'APPROVED', workId: 'w1', sha: SHA };

  test('no area touched, nothing to check', () => {
    assert.deepEqual(checkCrossReview({ areas: [], verdict: null, required: true }), { errors: [], warnings: [] });
  });

  test('an area without a verdict line fails when required and only warns otherwise', () => {
    assert.match(checkCrossReview({ areas, verdict: null, required: true }).errors[0], /touches money/);
    const optional = checkCrossReview({ areas, verdict: null, required: false });
    assert.deepEqual(optional.errors, []);
    assert.match(optional.warnings[0], /not enforced yet/);
  });

  test('the reviewed commit must belong to the PR', () => {
    assert.match(checkCrossReview({ areas, verdict, required: true, reviewedIsAncestor: false }).errors[0], /not in this PR/);
  });

  test('a sensitive file changed after the review needs round 2', () => {
    const after = ['packages/api/src/services/wallet.service.ts'];
    assert.match(checkCrossReview({ areas, verdict, required: true, reviewedIsAncestor: true, sensitiveAfterReview: after }).errors[0], /round 2/);
    assert.deepEqual(checkCrossReview({ areas, verdict, required: true, reviewedIsAncestor: true, sensitiveAfterReview: [] }).errors, []);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/check-pr.test.mjs`
Expected: FAIL with `Cannot find module` … `scripts/lib/pr-gate.mjs`.

- [ ] **Step 3: Write the rules**

Create `scripts/lib/pr-gate.mjs`:

```js
// Rules of the PR gate (scripts/check-pr.mjs), as pure functions over the PR description, the
// changed files and the review areas, so every rule is unit tested without git. Each check
// returns { errors: [], warnings: [] }.

// The sections of .github/pull_request_template.md, in order (a test keeps them equal).
export const SECTIONS = [
  'What changes',
  'Why',
  'How it was validated',
  'Tests',
  'Review areas',
  'Cross-review',
  'Native and OTA',
  'Migrations',
  'Final check',
];

const MIGRATION = /^supabase\/migrations\/(\d+[a-z]?)_[^/]+\.sql$/;
const SOURCE = [/^packages\/[^/]+\/src\//, /^apps\/[^/]+\/(src|app)\//, /^supabase\/functions\//, /^supabase\/migrations\//];
const TEST = [/(^|\/)__tests__\//, /\.test\.(ts|tsx|js|mjs)$/, /^supabase\/tests\//, /(^|\/)\.maestro\//];
const VERDICT = /^[ \t]*Cross-review:[ \t]+(APPROVED|APPROVED_WITH_RESERVATIONS|FIX_CONFIRMED)[ \t]+(\S+)[ \t]+([0-9a-f]{40})[ \t]*$/gm;
const EMPTY_FENCE = /^[ \t]*(```|~~~)[^\n]*\n(?:[ \t]*\n)*[ \t]*\1[ \t]*$/gm;
const BOX = /^[ \t]*[-*][ \t]+\[([ xX])\]/gm;
const MIN_REASON = 10;

const result = (errors = [], warnings = []) => ({ errors, warnings });
const realReason = (text) => text.length >= MIN_REASON && !/^<.*>$/.test(text);

// The description without HTML comments (the template keeps its placeholders inside them). An
// unclosed comment hides everything after it, so text after a broken comment never counts.
export function stripComments(body) {
  return String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

// Map(heading -> content) of the `## ` sections, in order.
export function parseSections(body) {
  const sections = new Map();
  let current = null;
  for (const line of stripComments(body).split('\n')) {
    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current !== null) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n')]));
}

export function isEmptySection(text) {
  return text.replace(EMPTY_FENCE, '').trim() === '';
}

function boxes(text) {
  return [...text.matchAll(BOX)].map((m) => m[1] !== ' ');
}

export function checkDescription(body) {
  const errors = [];
  const sections = parseSections(body);
  for (const name of SECTIONS) {
    if (!sections.has(name)) errors.push(`The description has no "## ${name}" section.`);
    else if (isEmptySection(sections.get(name))) errors.push(`The "## ${name}" section is empty.`);
  }
  if (sections.has('Native and OTA')) {
    const ticked = boxes(sections.get('Native and OTA')).filter(Boolean).length;
    if (ticked !== 1) errors.push(`Tick exactly one box in "## Native and OTA" (ticked: ${ticked}).`);
  }
  if (sections.has('Final check')) {
    const all = boxes(sections.get('Final check'));
    if (all.length === 0 || all.some((ticked) => !ticked)) errors.push('Tick every box in "## Final check".');
  }
  return result(errors);
}

// The reason after `label:` on a line of its own, outside comments. Null when the line is
// missing, the reason is shorter than 10 characters, or it is still the template placeholder.
export function reasonFor(body, label) {
  const match = new RegExp(`^[ \\t]*${label}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(stripComments(body));
  return match && realReason(match[1]) ? match[1] : null;
}

// `Migration edit: <path> <reason>` lines: Map(path -> reason), real reasons only.
export function migrationEdits(body) {
  const edits = new Map();
  for (const m of stripComments(body).matchAll(/^[ \t]*Migration edit:[ \t]+(\S+)[ \t]+(.+?)[ \t]*$/gm)) {
    if (realReason(m[2])) edits.set(m[1], m[2]);
  }
  return edits;
}

// The last valid `Cross-review: <verdict> <work-id> <sha>` line (round 2 comes after round 1).
export function latestVerdict(body) {
  const all = [...stripComments(body).matchAll(VERDICT)];
  if (all.length === 0) return null;
  const [, verdict, workId, sha] = all[all.length - 1];
  return { verdict, workId, sha };
}

const isTest = (path) => TEST.some((re) => re.test(path));
const isSource = (path) => !isTest(path) && SOURCE.some((re) => re.test(path));

export function checkTests(paths, body) {
  const sources = paths.filter(isSource);
  if (sources.length === 0 || paths.some(isTest) || reasonFor(body, 'No tests because')) return result();
  const listed = sources.slice(0, 3).join(', ') + (sources.length > 3 ? ', …' : '');
  return result([
    `This PR changes source (${listed}) and no test. Add a test that fails without the change, or a line "No tests because: <reason>".`,
  ]);
}

// changes: changedFiles(fork, head) with renames. baseMigrations: migration paths at the merge
// base. openPrs: [{ number, files: [path] }] of the open PRs (this one included or not).
export function checkMigrations({ changes, baseMigrations, body, prNumber = Infinity, openPrs = [] }) {
  const errors = [];
  const edits = migrationEdits(body);
  const onBase = new Set(baseMigrations);
  const leaving = new Set();
  const added = [];
  for (const change of changes) {
    const old = change.oldPath ?? change.path;
    if (onBase.has(old) && MIGRATION.test(old)) {
      if (change.status === 'R' || change.status === 'D') leaving.add(old);
      const pureRename = change.status === 'R' && change.score === 100;
      const keepsOld = change.status === 'A' || change.status === 'C';
      if (!pureRename && !keepsOld && !edits.has(old)) {
        const verb = change.status === 'D' ? 'deletes' : 'changes';
        errors.push(
          `${old} is already on master and this PR ${verb} it. Write a new migration instead, or add a line "Migration edit: ${old} <reason>".`,
        );
      }
    }
    if (['A', 'R', 'C'].includes(change.status) && MIGRATION.test(change.path) && !onBase.has(change.path)) {
      added.push(change.path);
    }
  }
  const numberOf = (path) => MIGRATION.exec(path)[1];
  const baseNumbers = new Map();
  for (const path of baseMigrations) {
    if (MIGRATION.test(path) && !leaving.has(path)) baseNumbers.set(numberOf(path), path);
  }
  for (const path of added) {
    const number = numberOf(path);
    if (baseNumbers.has(number)) {
      errors.push(`${path}: number ${number} is already used on master by ${baseNumbers.get(number)}. Take the next free number.`);
    }
    for (const pr of openPrs) {
      if (!(pr.number < prNumber)) continue;
      const taken = (pr.files ?? []).find((file) => MIGRATION.test(file) && !onBase.has(file) && numberOf(file) === number);
      if (taken) errors.push(`${path}: number ${number} is taken by the older open PR #${pr.number} (${taken}). The older PR keeps it.`);
    }
  }
  return result(errors);
}

// areas: what the PR touches (union of both maps). verdict: latestVerdict(body). required: the
// base map's crossReview.required. reviewedIsAncestor: the reviewed sha is a commit of this PR.
// sensitiveAfterReview: files of a review area changed between the reviewed sha and the head.
export function checkCrossReview({ areas, verdict, required, reviewedIsAncestor = false, sensitiveAfterReview = [] }) {
  if (areas.length === 0) return result();
  const problems = [];
  if (!verdict) {
    problems.push(`This PR touches ${areas.map((a) => a.id).join(', ')} and the description has no "Cross-review: <verdict> <work-id> <sha>" line.`);
  } else if (!reviewedIsAncestor) {
    problems.push(`The reviewed commit ${verdict.sha.slice(0, 12)} is not in this PR.`);
  } else if (sensitiveAfterReview.length > 0) {
    problems.push(
      `These files of a review area changed after the review at ${verdict.sha.slice(0, 12)}: ${sensitiveAfterReview.join(', ')}. Run round 2 and paste its line.`,
    );
  }
  if (required) return result(problems);
  return result([], problems.map((p) => `${p} (not enforced yet: the cross-review becomes required in part 3)`));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/check-pr.test.mjs`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/pr-gate.mjs scripts/check-pr.test.mjs
git commit -m "feat(ci): PR gate rules for description, tests, migrations and cross-review"
```

### Task 6: the gate CLI

**Files:**
- Create: `scripts/check-pr.mjs`
- Test: `scripts/check-pr.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add `spawnSync` to the `node:child_process` import, then add at the end of `scripts/check-pr.test.mjs`:

```js
describe('CLI', () => {
  const repo = mkdtempSync(join(tmpdir(), 'check-pr-'));
  const outside = mkdtempSync(join(tmpdir(), 'check-pr-body-'));
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message) => {
    g('add', '-A');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  const MAP = {
    ignore: ['\\.md$'],
    areas: {
      money: { title: 'Money', checklist: 'docs/review/money.md', paths: ['^packages/api/src/services/wallet\\.service\\.ts$'], migrationWords: ['wallet'] },
    },
    crossReview: { required: true },
  };
  const env = { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' };
  const gate = (body, base = 'master', ...extra) => {
    const file = join(outside, 'body.md');
    writeFileSync(file, body);
    return spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/check-pr.mjs'), '--base', base, '--head', 'HEAD', '--body-file', file, ...extra],
      { cwd: repo, encoding: 'utf8', env },
    );
  };

  g('init', '-q', '-b', 'master');
  write('docs/review/areas.json', JSON.stringify(MAP));
  write('supabase/migrations/00001_first.sql', 'select 1;\n');
  write('packages/api/src/services/wallet.service.ts', 'export const walletService = {};\n');
  write('apps/client/src/zz/Plain.tsx', 'export const plain = 1;\n');
  commit('base');

  test('a change with its test and a filled description passes', () => {
    g('checkout', '-q', '-B', 'clean', 'master');
    write('apps/client/src/zz/Plain.tsx', 'export const plain = 2;\n');
    write('apps/client/src/zz/__tests__/Plain.test.tsx', 'test\n');
    commit('clean');
    const r = gate(filledBody());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Review areas: none/);
  });

  test('editing a migration of master fails', () => {
    g('checkout', '-q', '-B', 'edit', 'master');
    write('supabase/migrations/00001_first.sql', 'select 2;\n');
    commit('edit');
    const r = gate(filledBody());
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /00001_first\.sql is already on master/);
  });

  test('a change in a review area needs the verdict of its last sensitive commit', () => {
    g('checkout', '-q', '-B', 'money', 'master');
    write('apps/client/src/zz/Pay.tsx', 'walletService.pay();\n');
    write('apps/client/src/zz/__tests__/Pay.test.tsx', 'test\n');
    const reviewed = commit('pay');
    assert.match(gate(filledBody()).stdout, /touches money/);
    const body = filledBody({ 'Cross-review': `Cross-review: APPROVED w1 ${reviewed}` });
    let r = gate(body);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    write('docs/notes.md', 'not sensitive\n');
    commit('docs after review');
    r = gate(body);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    write('apps/client/src/zz/Pay.tsx', 'walletService.pay(2);\n');
    commit('code after review');
    r = gate(body);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /changed after the review/);
  });

  test('the PR map can add an area but not remove one', () => {
    g('checkout', '-q', '-B', 'weaken', 'master');
    write('docs/review/areas.json', JSON.stringify({ ...MAP, areas: { money: { ...MAP.areas.money, paths: [] } } }));
    write('packages/api/src/services/wallet.service.ts', 'export const walletService = { pay() {} };\n');
    write('packages/api/src/services/__tests__/wallet.test.ts', 'test\n');
    commit('weaken');
    assert.match(gate(filledBody()).stdout, /touches money/);

    g('checkout', '-q', '-B', 'widen', 'master');
    const plain = { title: 'Plain', checklist: 'x.md', paths: ['^apps/client/src/zz/Plain\\.tsx$'] };
    write('docs/review/areas.json', JSON.stringify({ ...MAP, areas: { ...MAP.areas, plain } }));
    write('apps/client/src/zz/Plain.tsx', 'export const plain = 3;\n');
    write('apps/client/src/zz/__tests__/Plain.test.tsx', 'test\n');
    commit('widen');
    assert.match(gate(filledBody()).stdout, /touches plain/);
  });

  test('when master does not require the cross-review yet, a missing verdict only warns', () => {
    g('checkout', '-q', '-B', 'base-optional', 'master');
    write('docs/review/areas.json', JSON.stringify({ ...MAP, crossReview: { required: false } }));
    commit('optional');
    g('checkout', '-q', '-B', 'optional', 'base-optional');
    write('apps/client/src/zz/Pay2.tsx', 'walletService.pay();\n');
    write('apps/client/src/zz/__tests__/Pay2.test.tsx', 'test\n');
    commit('pay2');
    const r = gate(filledBody(), 'base-optional');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /not enforced yet/);
  });

  test('a new migration number of master or of an older open PR fails', () => {
    g('checkout', '-q', '-B', 'numbers', 'master');
    write('supabase/migrations/00001_again.sql', 'select 1;\n');
    write('supabase/migrations/00002_new.sql', 'select 1;\n');
    write('supabase/tests/00002/run.sh', 'x\n');
    commit('numbers');
    const open = join(outside, 'open.json');
    writeFileSync(open, JSON.stringify([{ number: 3, files: [{ path: 'supabase/migrations/00002_theirs.sql' }] }]));
    const r = gate(filledBody(), 'master', '--pr', '9', '--open-prs', open);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /number 00001 is already used on master/);
    assert.match(r.stdout, /older open PR #3/);
  });

  test('bad or missing arguments fail closed with exit 2', () => {
    for (const args of [[], ['--base', 'master', '--head', 'HEAD'], ['--base', '-x', '--head', 'HEAD', '--body-file', 'x'], ['--bogus']]) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-pr.mjs'), ...args], { cwd: repo, encoding: 'utf8', env });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /^check-pr: /);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/check-pr.test.mjs`
Expected: the `CLI` tests FAIL (`Cannot find module` … `scripts/check-pr.mjs`, exit 1 instead of 0/1/2).

- [ ] **Step 3: Write the CLI**

Create `scripts/check-pr.mjs`:

```js
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
  const paths = changedFiles(from, to, { renames: false }).map((change) => change.path);
  const code = paths.filter((path) => CODE_FILE.test(path));
  const atTo = readBlobs(to, code);
  const atFrom = readBlobs(from, code);
  const read = (path) => [atTo.get(path), atFrom.get(path)];
  return { paths, areas: unionAreas(...maps.map((map) => areasForChange(paths, map, read, helpers))) };
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
  const { paths, areas } = areasBetween(fork, head, maps, helpers);

  const verdict = latestVerdict(body);
  let reviewedIsAncestor = false;
  let sensitiveAfterReview = [];
  if (verdict && commitExists(verdict.sha)) {
    reviewedIsAncestor = isAncestor(verdict.sha, head) && isAncestor(fork, verdict.sha);
    if (reviewedIsAncestor) {
      const after = areasBetween(verdict.sha, head, maps, helpers);
      sensitiveAfterReview = [...new Set(after.areas.flatMap((area) => area.files))].sort();
    }
  }

  const outcomes = [
    ['Description', checkDescription(body)],
    ['Tests', checkTests(paths, body)],
    [
      'Migrations',
      checkMigrations({
        changes: changedFiles(fork, head, { renames: true }),
        baseMigrations: listTree(fork, 'supabase/migrations'),
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
```

- [ ] **Step 4: Run the gate tests**

Run: `node --test scripts/check-pr.test.mjs`
Expected: PASS, `fail 0`.

- [ ] **Step 5: Add the npm script**

In `package.json` `scripts`, after `"test:review-areas"`:

```json
"test:pr-gate": "node --test scripts/check-pr.test.mjs",
```

- [ ] **Step 6: Run both suites**

The per-alternative map test lists files with `git ls-files`, so stage the new script first.
Run: `git add scripts/check-pr.mjs && pnpm test:review-areas && pnpm test:pr-gate`
Expected: both PASS (53 and 30 tests; the map test now finds `check-pr.mjs` and `pr-gate.mjs`).
On this PC every git or node spawn costs about 1.5 s, so `test:pr-gate` takes about two minutes
locally; in CI it takes seconds.

- [ ] **Step 7: Run the gate on this branch, as CI will**

`master` must already have `docs/review/areas.json` (#1222): without it the gate exits 2 with
`docs/review/areas.json is missing on origin/master`, which is the intended fail-closed behaviour.
Write the PR description to `$TEMP/pr-2a-body.md` (the template, filled; areas: access).
Run: `node scripts/check-pr.mjs --base origin/master --head HEAD --body-file "$TEMP/pr-2a-body.md"; echo "exit=$?"`
Expected: `Review areas: access`, Description/Tests/Migrations `ok`, Cross-review `ok` with one
`⚠ … not enforced yet` line, `exit=0`. Then with the blank template:
`node scripts/check-pr.mjs --base origin/master --head HEAD --body-file .github/pull_request_template.md; echo "exit=$?"`
Expected: Description `FAIL`, `exit=1`.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-pr.mjs scripts/check-pr.test.mjs package.json
git commit -m "feat(ci): PR gate CLI"
```

### Task 7: workflows, template and docs

**Files:**
- Create: `.github/workflows/pr-gate.yml`
- Modify: `.github/workflows/ci.yml` (after the "Check migration grants" step)
- Modify: `.github/pull_request_template.md` (the Migrations comment)
- Modify: `docs/review/README.md`, `CLAUDE.md`

- [ ] **Step 1: Create the gate workflow**

Create `.github/workflows/pr-gate.yml`:

```yaml
name: PR gate

# Reads the PR description and the diff (scripts/check-pr.mjs). Runs again when the description is
# edited. The gate scripts and the area map come from master: a PR cannot weaken the gate that
# judges it. The rules are documented in CLAUDE.md, "PR gate".

on:
  pull_request:
    branches: [master]
    types: [opened, edited, synchronize, reopened, ready_for_review]

concurrency:
  group: pr-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: read

jobs:
  gate:
    name: PR gate
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout the PR head with full history
        uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Take the gate from master
        run: |
          mkdir -p "$RUNNER_TEMP/gate"
          if git cat-file -e origin/master:scripts/check-pr.mjs 2>/dev/null; then
            src=origin/master
          else
            src=HEAD
            echo "::warning::scripts/check-pr.mjs is not on master yet: this PR is judged by its own copy of the gate."
          fi
          git archive "$src" scripts/check-pr.mjs scripts/lib docs/review/areas.json | tar -x -C "$RUNNER_TEMP/gate"

      - name: List the open PRs (migration numbers)
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh pr list --state open --limit 200 --json number,files > "$RUNNER_TEMP/open-prs.json"

      - name: Check the PR
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          printf '%s' "$PR_BODY" > "$RUNNER_TEMP/body.md"
          node "$RUNNER_TEMP/gate/scripts/check-pr.mjs" --base origin/master --head "$HEAD_SHA" \
            --body-file "$RUNNER_TEMP/body.md" --pr "$PR_NUMBER" --open-prs "$RUNNER_TEMP/open-prs.json"
```

- [ ] **Step 2: Run the map and gate tests in `ci.yml`**

In `.github/workflows/ci.yml`, after the "Check migration grants (Data API, 2026-10-30)" step, add:

```yaml
      # The review map must classify every sensitive file of this tree (a renamed folder or an
      # unclassified service fails here), and the PR gate's rules have their own tests. The gate
      # itself runs in pr-gate.yml.
      - name: Review map and PR gate tests
        run: |
          pnpm test:review-areas
          pnpm test:pr-gate
```

- [ ] **Step 3: Mention the migration-edit line in the template**

In `.github/pull_request_template.md`, replace the Migrations comment with:

```markdown
<!-- For each migration: applied in production or not yet, and how the code behaves until it is.
Otherwise: None. Editing a migration already on master needs a line
Migration edit: <path> <reason> -->
```

Run: `node --test scripts/check-pr.test.mjs` — Expected: PASS (the section list did not change).

- [ ] **Step 4: Document the gate**

In `docs/review/README.md`, add a section at the end:

```markdown
## The PR gate

`.github/workflows/pr-gate.yml` runs `scripts/check-pr.mjs` on every PR, and again when its
description is edited. The script and the map come from `master`; the areas are the union of
`master`'s map and the PR's map, so a PR can add areas but never remove them. It fails when:

- a template section is empty (HTML comments and empty code fences do not count), "Native and OTA"
  has not exactly one box ticked, or "Final check" has a box unticked;
- the PR changes source and no test, without a line `No tests because: <reason>`;
- it edits or deletes a migration already on `master` without `Migration edit: <path> <reason>`
  (a rename with the same content is fine), or a new migration takes a number of `master` or of an
  older open PR;
- it touches an area and the description has no `Cross-review: <verdict> <work-id> <sha>` line, the
  sha is not a commit of the PR, or a file of an area changed after it. While
  `crossReview.required` is `false` in `areas.json` this rule only warns.

Locally: `node scripts/check-pr.mjs --base origin/master --head HEAD --body-file <description.md>`.
```

In `CLAUDE.md`, section "## Método de trabajo y revisión de PRs", after the numbered list (before
the `apply_migration` paragraph, so the list keeps its numbering), add:

```markdown
**El PR gate** (`.github/workflows/pr-gate.yml`) revisa la descripción y el diff de cada PR, y vuelve a correr cuando se edita la descripción. Falla si una sección de la plantilla quedó vacía, si el PR toca código sin ninguna prueba y sin `No tests because: <motivo>`, si edita o borra una migración que ya está en `master` sin `Migration edit: <archivo> <motivo>`, o si una migración nueva usa un número de `master` o el de un PR abierto más viejo. Si el PR toca un área de revisión, pide la línea `Cross-review: <veredicto> <id> <sha>`; hasta la parte 3 eso solo avisa. Las reglas y el mapa salen de `master`, así que un PR no puede aflojar el chequeo que lo juzga. Detalle: `docs/review/README.md` § "The PR gate".
```

- [ ] **Step 5: Run every suite touched**

Run: `pnpm test:review-areas && pnpm test:pr-gate && node scripts/check-i18n-parity.mjs`
Expected: all PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/pr-gate.yml .github/workflows/ci.yml .github/pull_request_template.md docs/review/README.md CLAUDE.md
git commit -m "ci: run the PR gate on every PR and its tests in CI"
```

### Task 8: open PR 2a and prove the gate fails before it passes

(As built: with `pull_request_target` the gate does not run on this PR. Open PR 2a with its filled
description, merge it with Eduardo's OK, then run Steps 2-4 on a throwaway docs-only PR, and close
it. On that PR also confirm the check is reported on the PR head commit, which branch protection
needs: `gh api repos/AgenciaSeniors/TriciGo/commits/<head sha>/check-runs --jq '.check_runs[] | [.name, .app.slug, .head_sha]'`
must list `PR gate` with that sha.)

- [ ] **Step 1: Ask Eduardo for the OK to push `ci/pr-gate` and open the PR as a draft with the blank template.**
- [ ] **Step 2: Push and open the draft**

```bash
git push -u origin ci/pr-gate
gh pr create --draft --base master --head ci/pr-gate --title "ci: PR gate (validators part 2a)" --body-file .github/pull_request_template.md
```

- [ ] **Step 3: Record the red run**

Run: `gh pr checks <n> --watch` — Expected: "PR gate" fails; its summary lists the empty sections.
Save the run link.

- [ ] **Step 4: Edit the description (filled, with the Review areas output and the two run links) and record the green run**

```bash
gh pr edit <n> --body-file "$TEMP/pr-2a-body.md"
gh pr checks <n> --watch
```

Expected: "PR gate" passes with one cross-review warning; "Lint, Type Check & Test" passes.

- [ ] **Step 5: Mark ready and ask Eduardo for the merge OK.**

---

# PR 2b — Builds and web lint

Files:
- Modify `apps/web/package.json` (lint script) and fix what the lint reports.
- Create `scripts/ci/smoke-next.sh`.
- Create `.github/workflows/build.yml`.
- Modify `docs/review/areas.json` (`^scripts/ci/` in access, if not there).
- Modify `CLAUDE.md`.

### Task 9: web lint

**Files:**
- Modify: `apps/web/package.json`
- Modify: whatever files the lint reports

- [ ] **Step 1: Install in the worktree**

Run: `pnpm install --frozen-lockfile` (2-3 min). Then `git status --short` — Expected: empty
(if `pnpm-lock.yaml` changed: `git checkout HEAD -- pnpm-lock.yaml`).

- [ ] **Step 2: Add the script**

In `apps/web/package.json` `scripts`, after `"start"`:

```json
"lint": "eslint . --config ../../tools/lint-rules.config.mjs",
```

- [ ] **Step 3: Measure what it reports**

Run: `pnpm --filter @tricigo/web lint > "$TEMP/web-lint.txt" 2>&1; echo "exit=$?"; tail -5 "$TEMP/web-lint.txt"`
Expected: a count line `✖ N problems (E errors, W warnings)`. Write E and W into the PR description.

- [ ] **Step 4: Fix every error**

The shared config only raises real correctness problems (see its header). For each error, fix the
code. For a false positive, disable that one line with the rule name and the reason:
`// eslint-disable-next-line <rule> -- <reason>`. Warnings (the dark-mode guard) stay.

- [ ] **Step 5: Verify**

Run: `pnpm --filter @tricigo/web lint; echo "exit=$?"` — Expected: `0 errors`, `exit=0`.
Run: `pnpm lint; echo "exit=$?"` — Expected: `exit=0` (turbo now lints web too).
Run: `pnpm --filter @tricigo/web check-types; echo "exit=$?"` — Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "chore(web): lint the web app with the shared config and fix what it found"
```

### Task 10: smoke script for a Next standalone build

**Files:**
- Create: `scripts/ci/smoke-next.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Starts the standalone server that `next build` left for one app and requests a few routes.
#   scripts/ci/smoke-next.sh <web|admin> <port> <path=status>...
# Used by .github/workflows/build.yml after `next build`. Prints the server log when a route fails.
set -euo pipefail
app="$1"; port="$2"; shift 2
src="apps/$app"
dir="$src/.next/standalone/apps/$app"
if [ ! -f "$dir/server.js" ]; then
  echo "::error::$dir/server.js is missing: the $app build did not produce a standalone server."
  exit 1
fi
mkdir -p "$dir/.next"
cp -r "$src/.next/static" "$dir/.next/static"
if [ -d "$src/public" ]; then cp -r "$src/public" "$dir/public"; fi
log="${RUNNER_TEMP:-/tmp}/$app-server.log"
PORT="$port" HOSTNAME=127.0.0.1 NODE_ENV=production node "$dir/server.js" > "$log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then break; fi
  sleep 1
done
failed=0
for spec in "$@"; do
  path="${spec%=*}"; want="${spec##*=}"
  got=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path")
  if [ "$got" = "$want" ]; then
    echo "ok    $app $path $got"
  else
    echo "::error::$app $path answered $got, expected $want"
    failed=1
  fi
done
if [ "$failed" != 0 ]; then echo "--- $app server log ---"; tail -60 "$log"; fi
exit "$failed"
```

- [ ] **Step 2: Try it locally on the web build**

Run:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://lqaufszburqvlslpcuac.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_hSzDS_2ivar8CGqUm-yd3w_-65h1Zsc \
pnpm turbo run build --filter=@tricigo/web
RUNNER_TEMP="$TEMP" bash scripts/ci/smoke-next.sh web 3101 /=200 /privacy=200 /terms=200 /book=200 /recargar=200 /.well-known/assetlinks.json=200 /no-existe-esta-ruta=404; echo "exit=$?"
```

Expected: seven `ok` lines, `exit=0`. If a route answers another status, read why (the page code,
the middleware) before changing the expectation, and write the reason in the PR. Then run it with a
wrong expectation (`/=500`) — Expected: an `::error::` line, the server log, `exit=1`.

- [ ] **Step 3: Same for admin**

Run: `pnpm turbo run build --filter=@tricigo/admin` (same env), then
`RUNNER_TEMP="$TEMP" bash scripts/ci/smoke-next.sh admin 3102 /login=200 /=307; echo "exit=$?"`.
Expected: two `ok` lines (the middleware sends a visitor without a session to `/login` with 307),
`exit=0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/smoke-next.sh
git commit -m "ci: smoke script for the Next standalone builds"
```

### Task 11: the build workflow

**Files:**
- Create: `.github/workflows/build.yml`
- Modify: `docs/review/areas.json`, `CLAUDE.md`

- [ ] **Step 1: Create the workflow**

```yaml
name: Build

# Builds what the deploy builds and bundles what an OTA bundles, so a build error shows up in the
# PR and not at deploy time. Public values only (the same ones eas-update.yml inlines into the
# apps); no Sentry token, so a PR build uploads nothing.

on:
  pull_request:
    branches: [master]
  push:
    branches: [master]

concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  web-admin:
    name: Build web and admin
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: next build (web and admin)
        run: pnpm turbo run build --filter=@tricigo/web --filter=@tricigo/admin
        env:
          NEXT_PUBLIC_SUPABASE_URL: https://lqaufszburqvlslpcuac.supabase.co
          NEXT_PUBLIC_SUPABASE_ANON_KEY: sb_publishable_hSzDS_2ivar8CGqUm-yd3w_-65h1Zsc
      - name: Serve web and request its routes
        run: bash scripts/ci/smoke-next.sh web 3101 /=200 /privacy=200 /terms=200 /book=200 /recargar=200 /.well-known/assetlinks.json=200 /no-existe-esta-ruta=404
      - name: Serve admin and request its routes
        run: bash scripts/ci/smoke-next.sh admin 3102 /login=200 /=307

  bundle:
    name: Bundle ${{ matrix.app }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        app: [client, driver]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      # The same command eas-update.yml runs before publishing an OTA.
      - name: expo export
        working-directory: apps/${{ matrix.app }}
        run: npx expo export --platform android --platform ios --output-dir "$RUNNER_TEMP/export" --clear
```

(Use the statuses confirmed in Task 10 if they differ, with the reason in a comment.)

- [ ] **Step 2: Add `scripts/ci/` to the access area**

In `docs/review/areas.json`, `areas.access.paths`, add `"^scripts/ci/"` if it is not there.
Run: `pnpm test:review-areas` — Expected: PASS.

- [ ] **Step 3: Document**

In `CLAUDE.md`, section "## Método de trabajo y revisión de PRs", after the PR gate paragraph, add:

```markdown
**Build** (`.github/workflows/build.yml`) compila la web y el panel como el deploy (`next build`, con los valores públicos y sin el token de Sentry), levanta el servidor standalone y pide unas rutas (una que no existe tiene que dar 404), y empaqueta las dos apps con el mismo `expo export` que corre antes de un OTA. La web tiene `lint` desde esta entrega, así que `pnpm lint` también la revisa.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml docs/review/areas.json CLAUDE.md
git commit -m "ci: build web and admin and bundle both apps on every PR"
```

### Task 12: PR 2b with its negative controls

- [ ] **Step 1: Ask Eduardo for the OK to push `ci/builds` with two temporary commits (a broken import, then its revert) and to open the PR.**
- [ ] **Step 2: Push the branch and open the draft PR with the filled description.** The lint fixes change web source without a test, so the Tests section carries `No tests because: lint fixes only; the new lint script and the build job are the check.` (the PR gate asks for it once 2a is merged). Record the green runs of "Build web and admin", "Bundle client", "Bundle driver" and their durations.
- [ ] **Step 3: Negative control**

```bash
printf "\nimport { nope } from './does-not-exist';\n" >> apps/web/src/app/privacy/page.tsx
printf "\nimport { nope } from './does-not-exist';\n" >> apps/client/app/(tabs)/index.tsx
git commit -am "test(ci): broken imports (negative control, reverted next)"
git push
```

Expected: "Build web and admin" and "Bundle client" fail on the missing module; "Bundle driver"
passes. Record the links.

- [ ] **Step 4: Revert and push**

```bash
git revert --no-edit HEAD
git push
```

Expected: all three green again. Put the four links and the durations in the PR description; mark
ready; ask Eduardo for the merge OK.

---

# PR 2c — Native change vs version

Files:
- Create `scripts/ci/lib/fingerprint-rules.mjs` and `scripts/ci/fingerprint-rules.test.mjs`.
- Create `scripts/ci/native-fingerprint.mjs` and `scripts/ci/compare-fingerprints.mjs`.
- Create `.github/workflows/native-fingerprint.yml`.
- Modify `CLAUDE.md`, `docs/review/native.md`, `.github/workflows/eas-update.yml` (stale header line).

### Task 13: fingerprint rules

**Files:**
- Create: `scripts/ci/lib/fingerprint-rules.mjs`
- Test: `scripts/ci/fingerprint-rules.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// node --test scripts/ci/fingerprint-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSources, compareVersions, judgeFingerprint } from './lib/fingerprint-rules.mjs';

const fp = (version, hash, sources = []) => ({ app: 'client', version, hash, sources });

test('compareVersions orders x.y.z numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.8.0', '1.8.0'), 0);
  assert.equal(compareVersions('1.8', '1.8.1'), -1);
});

test('same fingerprint: no native change', () => {
  assert.deepEqual(judgeFingerprint(fp('1.8.0', 'h1'), fp('1.8.0', 'h1')).ok, true);
});

test('native change without a version bump fails', () => {
  const r = judgeFingerprint(fp('1.8.0', 'h1'), fp('1.8.0', 'h2'));
  assert.equal(r.ok, false);
  assert.match(r.message, /expo\.version is still 1\.8\.0/);
});

test('native change with a version bump passes with a warning', () => {
  const r = judgeFingerprint(fp('1.8.0', 'h1'), fp('1.9.0', 'h2'));
  assert.equal(r.ok, true);
  assert.equal(r.level, 'warning');
  assert.match(r.message, /store build/);
});

test('a version that goes down fails', () => {
  assert.equal(judgeFingerprint(fp('1.8.0', 'h1'), fp('1.7.9', 'h2')).ok, false);
});

test('changedSources names what differs', () => {
  const base = [
    { type: 'file', filePath: 'app.json', hash: 'a' },
    { type: 'dir', filePath: 'plugins', hash: 'b' },
    { type: 'contents', id: 'expoAutolinkingConfig:android', hash: 'c' },
  ];
  const head = [
    { type: 'file', filePath: 'app.json', hash: 'a2' },
    { type: 'dir', filePath: 'plugins', hash: 'b' },
    { type: 'contents', id: 'packageJson:scripts', hash: 'd' },
  ];
  assert.deepEqual(changedSources(base, head), [
    'contents:expoAutolinkingConfig:android',
    'contents:packageJson:scripts',
    'file:app.json',
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/ci/fingerprint-rules.test.mjs`
Expected: FAIL, `Cannot find module` … `fingerprint-rules.mjs`.

- [ ] **Step 3: Write the rules**

```js
// What a change of the Expo native fingerprint means for one app. Both apps use
// runtimeVersion { policy: "appVersion" }: an OTA reaches every binary with the same expo.version,
// so native code that changes without a version bump would reach installed apps that lack it.

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// base, head: { app, version, hash }. Returns { ok, level, message }.
export function judgeFingerprint(base, head) {
  const app = head.app;
  if (base.hash === head.hash) return { ok: true, level: 'notice', message: `${app}: no native change.` };
  const order = compareVersions(head.version, base.version);
  if (order > 0) {
    return {
      ok: true,
      level: 'warning',
      message: `${app}: native change with expo.version ${base.version} -> ${head.version}. Needs a store build before any OTA for ${head.version}.`,
    };
  }
  if (order === 0) {
    return {
      ok: false,
      level: 'error',
      message: `${app}: the native fingerprint changed and expo.version is still ${head.version}. Bump expo.version in apps/${app}/app.json (an OTA would reach installed ${head.version} binaries that lack this native code), or undo the native change.`,
    };
  }
  return { ok: false, level: 'error', message: `${app}: expo.version went down (${base.version} -> ${head.version}).` };
}

const sourceKey = (s) => `${s.type}:${s.filePath ?? s.id ?? s.contentsId ?? '?'}`;

// Keys of the fingerprint sources that were added, removed or changed, sorted.
export function changedSources(baseSources = [], headSources = []) {
  const base = new Map(baseSources.map((s) => [sourceKey(s), s.hash]));
  const head = new Map(headSources.map((s) => [sourceKey(s), s.hash]));
  const keys = new Set([...base.keys(), ...head.keys()]);
  return [...keys].filter((key) => base.get(key) !== head.get(key)).sort();
}
```

- [ ] **Step 4: Run the test**

Run: `node --test scripts/ci/fingerprint-rules.test.mjs` — Expected: PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/lib/fingerprint-rules.mjs scripts/ci/fingerprint-rules.test.mjs
git commit -m "feat(ci): rules for a native fingerprint change"
```

### Task 14: generate and compare fingerprints

**Files:**
- Create: `scripts/ci/native-fingerprint.mjs`, `scripts/ci/compare-fingerprints.mjs`

- [ ] **Step 1: Read what the installed @expo/fingerprint exports**

Run: `pnpm install --frozen-lockfile` (if not done), then
`grep -n "export declare\|SourceSkips\|DEFAULT" node_modules/@expo/fingerprint/build/index.d.ts node_modules/@expo/fingerprint/build/sourcer/SourceSkips.d.ts`
Expected: `createFingerprintAsync`, `SourceSkips` with a member `ExpoConfigVersions`, and
`DEFAULT_SOURCE_SKIPS`. If a name differs, use the declared one in Step 2 and say so in the PR.

- [ ] **Step 2: Write the generator**

```js
#!/usr/bin/env node
// Prints the Expo native fingerprint of one app of a checkout, as JSON:
//   node scripts/ci/native-fingerprint.mjs <checkout-dir> <client|driver>
//   -> {"app","version","hash","sources":[...]}
// @expo/fingerprint is resolved from that checkout's own node_modules, so the base and the head of
// a PR are each measured with their own dependencies. The version fields of the Expo config are
// skipped: a version bump alone is not a native change.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [dir, app] = process.argv.slice(2);
if (!dir || !['client', 'driver'].includes(app)) {
  console.error('usage: native-fingerprint.mjs <checkout-dir> <client|driver>');
  process.exit(2);
}
const appDir = resolve(dir, 'apps', app);
const require = createRequire(join(appDir, 'package.json'));
const { createFingerprintAsync, DEFAULT_SOURCE_SKIPS, SourceSkips } = require('@expo/fingerprint');
const fingerprint = await createFingerprintAsync(appDir, {
  sourceSkips: DEFAULT_SOURCE_SKIPS | SourceSkips.ExpoConfigVersions,
});
const version = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')).expo.version;
process.stdout.write(`${JSON.stringify({ app, version, hash: fingerprint.hash, sources: fingerprint.sources })}\n`);
```

- [ ] **Step 3: Write the comparison**

```js
#!/usr/bin/env node
// Compares the fingerprints written by native-fingerprint.mjs:
//   node scripts/ci/compare-fingerprints.mjs <dir> client driver
// reads <dir>/base-<app>.json and <dir>/head-<app>.json. Exit 1 when an app changed native code
// without bumping expo.version.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedSources, judgeFingerprint } from './lib/fingerprint-rules.mjs';

const [dir, ...apps] = process.argv.slice(2);
let failed = false;
const summary = ['## Native change vs version', ''];
for (const app of apps) {
  const base = JSON.parse(readFileSync(join(dir, `base-${app}.json`), 'utf8'));
  const head = JSON.parse(readFileSync(join(dir, `head-${app}.json`), 'utf8'));
  const verdict = judgeFingerprint(base, head);
  console.log(`::${verdict.level}::${verdict.message}`);
  summary.push(`- ${verdict.message}`);
  if (base.hash !== head.hash) {
    const changed = changedSources(base.sources, head.sources);
    console.log(`${app}: changed sources:\n  ${changed.join('\n  ')}`);
    summary.push(`  - changed: ${changed.join(', ')}`);
  }
  if (!verdict.ok) failed = true;
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Try both locally**

Run:

```bash
for app in client driver; do node scripts/ci/native-fingerprint.mjs . $app > "$TEMP/head-$app.json"; cp "$TEMP/head-$app.json" "$TEMP/base-$app.json"; done
node scripts/ci/compare-fingerprints.mjs "$TEMP" client driver; echo "exit=$?"
```

Expected: `::notice::client: no native change.`, same for driver, `exit=0`. Run the generator twice
for `client` and compare the two `hash` values — Expected: equal (deterministic).

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/native-fingerprint.mjs scripts/ci/compare-fingerprints.mjs
git commit -m "feat(ci): generate and compare the native fingerprints of the apps"
```

### Task 15: the workflow and the docs

**Files:**
- Create: `.github/workflows/native-fingerprint.yml`
- Modify: `.github/workflows/eas-update.yml` (header comment only), `docs/review/native.md`, `CLAUDE.md`, `docs/review/areas.json`

- [ ] **Step 1: Create the workflow**

```yaml
name: Native fingerprint

# Both apps use runtimeVersion { policy: "appVersion" }. A native change (a native dependency, a
# config plugin, app.json) with the same expo.version would let an OTA reach installed binaries
# that lack that native code. This compares the Expo native fingerprint of the PR with master's.

on:
  pull_request:
    branches: [master]

concurrency:
  group: native-fingerprint-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  fingerprint:
    name: Native change vs version
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Install the PR
        run: pnpm install --frozen-lockfile
      - name: Install master next to it
        run: |
          git worktree add --detach "$RUNNER_TEMP/base" "$(git merge-base origin/master HEAD)"
          cd "$RUNNER_TEMP/base" && pnpm install --frozen-lockfile --prefer-offline
      - name: Fingerprints
        run: |
          for app in client driver; do
            node scripts/ci/native-fingerprint.mjs . "$app" > "$RUNNER_TEMP/head-$app.json"
            node scripts/ci/native-fingerprint.mjs "$RUNNER_TEMP/base" "$app" > "$RUNNER_TEMP/base-$app.json"
          done
      - name: Rules tests
        run: node --test scripts/ci/fingerprint-rules.test.mjs
      - name: Compare with master
        run: node scripts/ci/compare-fingerprints.mjs "$RUNNER_TEMP" client driver
```

- [ ] **Step 2: Fix the stale header of `eas-update.yml`**

In `.github/workflows/eas-update.yml`, the header comment says the driver uses the `fingerprint`
runtime policy. Replace that sentence with: `Both apps use runtimeVersion { policy: "appVersion" }:
a native change needs an expo.version bump (checked on every PR by native-fingerprint.yml).`

- [ ] **Step 3: Docs**

In `docs/review/native.md`, add a line to the checklist: `CI compares the native fingerprint with
master's (native-fingerprint.yml); a red "Native change vs version" means: bump expo.version or
undo the native change.` In `CLAUDE.md`, after the Build paragraph of "## Método de trabajo y
revisión de PRs":

```markdown
**Native change vs version** (`.github/workflows/native-fingerprint.yml`) calcula la huella nativa de Expo (`@expo/fingerprint`) de las dos apps en el PR y en `master`, cada una con sus dependencias. Si la huella cambió y `expo.version` no subió, falla: con `runtimeVersion: appVersion`, un OTA llegaría a binarios instalados sin ese código nativo. Si la versión subió, pasa y avisa que hace falta un build de tienda. Los campos de versión de la config no cuentan como cambio nativo.
```

Add `"^scripts/ci/"` to `areas.access.paths` if it is not there; run `pnpm test:review-areas`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/native-fingerprint.yml .github/workflows/eas-update.yml docs/review/native.md docs/review/areas.json CLAUDE.md
git commit -m "ci: fail a native change that does not bump expo.version"
```

### Task 16: PR 2c with its negative controls

- [ ] **Step 1: Ask Eduardo for the OK to push `ci/native-fingerprint` with temporary commits and open the PR.**
- [ ] **Step 2: Push and open the draft.** Expected: "Native change vs version" passes with "no native change" for both apps (the positive control: the same tree measured twice from two checkouts gives the same hash). Record the duration.
- [ ] **Step 3: Native change without a bump**

Add a harmless Android permission to `apps/client/app.json` (`"android": { "permissions": [..., "android.permission.VIBRATE"] }`
if it is not there; pick any permission the app does not list), commit, push.
Expected: the check fails with `client: the native fingerprint changed and expo.version is still …`
and lists the changed source. Record the link.

- [ ] **Step 4: The same change with a bump**

Bump `expo.version` in `apps/client/app.json` (e.g. 1.8.0 → 1.8.1), commit, push.
Expected: passes with a warning "Needs a store build". Record the link.

- [ ] **Step 5: Revert both commits** (`git revert --no-edit HEAD HEAD~1`), push, confirm green, put the links and durations in the description, mark ready, ask for the merge OK.

---

# PR 2d — Migration rehearsal in CI

Files:
- Create `supabase/tests/_template/{run.sh,scaffold.sql,tests.sql,example-migration.sql}` and `supabase/tests/README.md`.
- Create `scripts/ci/lib/rehearsal-plan.mjs`, `scripts/ci/rehearsal-plan.test.mjs`, `scripts/ci/rehearse-changed-migrations.mjs`.
- Create `scripts/sql/live-definitions.sql`.
- Create `.github/workflows/migration-rehearsal.yml`.
- Modify `CLAUDE.md`, `docs/review/schema.md`, `docs/review/areas.json`.

### Task 17: the rehearsal planner

**Files:**
- Create: `scripts/ci/lib/rehearsal-plan.mjs`
- Test: `scripts/ci/rehearsal-plan.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// node --test scripts/ci/rehearsal-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRehearsals } from './lib/rehearsal-plan.mjs';

const files = new Set([
  'supabase/migrations/00700_new_thing.sql',
  'supabase/tests/00700/run.sh',
  'supabase/migrations/00701_exempt.sql',
  'supabase/migrations/00702_missing.sql',
  'supabase/migrations/00650_old.sql',
  'supabase/tests/00650/run.sh',
]);
const lines = {
  'supabase/migrations/00700_new_thing.sql': '-- Adds a thing.',
  'supabase/migrations/00701_exempt.sql': '-- rehearsal-exempt: only a COMMENT ON, nothing runs',
  'supabase/migrations/00702_missing.sql': 'CREATE TABLE x ();',
};
const firstLine = (p) => lines[p] ?? null;

test('a new migration with a rehearsal runs RED and GREEN', () => {
  const plan = planRehearsals([{ status: 'A', path: 'supabase/migrations/00700_new_thing.sql' }], files, firstLine);
  assert.deepEqual(plan.runs, [
    { number: '00700', migration: 'supabase/migrations/00700_new_thing.sql', runner: 'supabase/tests/00700/run.sh', red: true },
  ]);
  assert.deepEqual(plan.errors, []);
});

test('a new migration without a rehearsal fails unless its first line exempts it', () => {
  const plan = planRehearsals(
    [
      { status: 'A', path: 'supabase/migrations/00701_exempt.sql' },
      { status: 'A', path: 'supabase/migrations/00702_missing.sql' },
    ],
    files,
    firstLine,
  );
  assert.deepEqual(plan.runs, []);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /00702_missing\.sql has no rehearsal/);
  assert.match(plan.notices[0], /only a COMMENT ON/);
});

test('a short exemption reason does not count', () => {
  const plan = planRehearsals([{ status: 'A', path: 'supabase/migrations/00702_missing.sql' }], files, () => '-- rehearsal-exempt: no');
  assert.equal(plan.errors.length, 1);
});

test('a touched rehearsal of an existing migration runs GREEN only', () => {
  const plan = planRehearsals([{ status: 'M', path: 'supabase/tests/00650/scaffold.sql' }], files, firstLine);
  assert.deepEqual(plan.runs, [
    { number: '00650', migration: 'supabase/migrations/00650_old.sql', runner: 'supabase/tests/00650/run.sh', red: false },
  ]);
});

test('the template and folders without a runner are not rehearsals', () => {
  const plan = planRehearsals(
    [
      { status: 'M', path: 'supabase/tests/_template/run.sh' },
      { status: 'M', path: 'supabase/tests/poi/tests.sql' },
      { status: 'D', path: 'supabase/tests/00599/run.sh' },
    ],
    files,
    firstLine,
  );
  assert.deepEqual(plan, { runs: [], errors: [], notices: [] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/ci/rehearsal-plan.test.mjs` — Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Write the planner**

```js
// Which migration rehearsals a PR must run, from its changed files:
//   - every migration the PR adds: RED (`run.sh none` must fail) and GREEN (`run.sh <migration>`
//     must pass);
//   - every rehearsal folder the PR changes, for a migration it does not add: GREEN only.
// A new migration without supabase/tests/<number>/run.sh is an error, unless its first line is
// `-- rehearsal-exempt: <reason>` with a reason of 10+ characters.

const MIGRATION = /^supabase\/migrations\/(\d+[a-z]?)_[^/]+\.sql$/;
const REHEARSAL = /^supabase\/tests\/(\d+[a-z]?)\//;
const EXEMPT = /^--[ \t]*rehearsal-exempt:[ \t]*(.+?)[ \t]*$/;

// changes: [{ status, path }] without renames. headFiles: Set of paths at the head (migrations and
// rehearsals at least). firstLine(path): the first line of a file at the head, or null.
export function planRehearsals(changes, headFiles, firstLine) {
  const runs = [];
  const errors = [];
  const notices = [];
  const byNumber = new Map();
  for (const path of headFiles) {
    const m = MIGRATION.exec(path);
    if (m) byNumber.set(m[1], [...(byNumber.get(m[1]) ?? []), path]);
  }

  const added = new Set();
  for (const change of changes) {
    if (change.status !== 'A' || !MIGRATION.test(change.path)) continue;
    const number = MIGRATION.exec(change.path)[1];
    added.add(number);
    const runner = `supabase/tests/${number}/run.sh`;
    const exempt = EXEMPT.exec(firstLine(change.path) ?? '');
    if (headFiles.has(runner)) {
      runs.push({ number, migration: change.path, runner, red: true });
    } else if (exempt && exempt[1].length >= 10) {
      notices.push(`${change.path}: no rehearsal (${exempt[1]}).`);
    } else {
      errors.push(
        `${change.path} has no rehearsal. Add ${runner} (copy supabase/tests/_template/), or make its first line "-- rehearsal-exempt: <reason>".`,
      );
    }
  }

  const touched = new Set();
  for (const change of changes) {
    const m = REHEARSAL.exec(change.path);
    if (m && !added.has(m[1])) touched.add(m[1]);
  }
  for (const number of [...touched].sort()) {
    const runner = `supabase/tests/${number}/run.sh`;
    if (!headFiles.has(runner)) continue;
    const migrations = byNumber.get(number) ?? [];
    if (migrations.length !== 1) {
      notices.push(`${runner}: ${migrations.length} migrations carry number ${number}, not rehearsed.`);
      continue;
    }
    runs.push({ number, migration: migrations[0], runner, red: false });
  }

  runs.sort((a, b) => a.number.localeCompare(b.number));
  return { runs, errors, notices };
}
```

- [ ] **Step 4: Run the test** — `node --test scripts/ci/rehearsal-plan.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/lib/rehearsal-plan.mjs scripts/ci/rehearsal-plan.test.mjs
git commit -m "feat(ci): plan which migration rehearsals a PR runs"
```

### Task 18: the runner of the planned rehearsals

**Files:**
- Create: `scripts/ci/rehearse-changed-migrations.mjs`

The RED rule: `run.sh none` must exit **1** and print at least one line that starts with `FAIL`. An
infrastructure failure (`scaffold failed`, a dead server) prints no such line, so it never counts
as a good RED. The 89 existing runners print `FAIL  <name>` per failed check; the template prints
`FAIL <name>`.

- [ ] **Step 1: Write the script**

```js
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
```

(It imports `../lib/git-read.mjs` from PR 2a. If 2d merges before 2a, add `scripts/lib/git-read.mjs`
from Task 1 to this PR as its own commit; the later PR then has no diff for that file.)

- [ ] **Step 2: Commit**

```bash
git add scripts/ci/rehearse-changed-migrations.mjs
git commit -m "feat(ci): run the planned migration rehearsals"
```

### Task 19: the rehearsal template

**Files:**
- Create: `supabase/tests/_template/run.sh`, `scaffold.sql`, `tests.sql`, `example-migration.sql`, `supabase/tests/README.md`

- [ ] **Step 1: `supabase/tests/_template/run.sh`**

```bash
#!/usr/bin/env bash
# Rehearsal of one migration. Copy this folder to supabase/tests/<number>/ and fill scaffold.sql
# (the live objects the migration touches, copied from production) and tests.sql (checks that
# record what does not hold in public._t_fail).
#   supabase/tests/<number>/run.sh none                         -> scaffold + tests: must FAIL (exit 1)
#   supabase/tests/<number>/run.sh supabase/migrations/<file>   -> scaffold + migration twice + tests: must PASS
# Exit 0 pass, 1 a check failed or the migration failed, 2 the rehearsal could not run.
# Connection: PGHOST (127.0.0.1), PGPORT (5433), PGUSER (pgtest, a superuser), PGBIN (folder of psql).
set -u
export PGCLIENTENCODING=UTF8 LC_MESSAGES=C
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:?usage: run.sh none|<migration file>}"
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
CONN=(-h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5433}" -U "${PGUSER:-pgtest}")
DB="rehearsal_$(basename "$DIR")"
db() { "$BIN/psql" "${CONN[@]}" -d "$DB" -qAt -v ON_ERROR_STOP=1 "$@"; }

"$BIN/psql" "${CONN[@]}" -d postgres -qAt -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\"" >/dev/null || { echo "could not create $DB"; exit 2; }
db -f "$DIR/scaffold.sql" >/dev/null || { echo "scaffold failed"; exit 2; }
db -c "CREATE TABLE public._t_fail (name text NOT NULL, detail text); GRANT INSERT, SELECT ON public._t_fail TO PUBLIC;" >/dev/null || exit 2

if [ "$MIG" != none ]; then
  # 1st pass in one transaction (as a migration runs), 2nd to prove it is idempotent. As postgres,
  # the scaffold's owner, which is not a superuser (as in production).
  for pass in 1 2; do
    db -1 -c "SET SESSION AUTHORIZATION postgres" -f "$MIG" >/dev/null || { echo "FAIL migration (pass $pass)"; exit 1; }
  done
fi

db -f "$DIR/tests.sql" >/dev/null || { echo "FAIL tests.sql raised an error"; exit 1; }
fails=$(db -c "SELECT name || coalesce(': ' || detail, '') FROM public._t_fail ORDER BY 1" | tr -d '\r')
"$BIN/psql" "${CONN[@]}" -d postgres -qAt -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1
if [ -n "$fails" ]; then
  while IFS= read -r line; do echo "FAIL $line"; done <<< "$fails"
  exit 1
fi
echo "PASS"
```

- [ ] **Step 2: `supabase/tests/_template/scaffold.sql`**

```sql
-- Scaffold of the rehearsal of migration <number>: the objects the migration touches, copied from
-- production (scripts/sql/live-definitions.sql prints their current definitions and md5). Keep it
-- minimal: only what the migration and tests.sql read or write.
SET client_min_messages = warning;

-- Supabase roles. postgres owns the objects and applies the migration, without superuser (as in
-- production). Roles are shared by every database of the server, so create them only once.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
GRANT CREATE, USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- The live objects of this migration go below, created by their owner:
SET ROLE postgres;
-- CREATE TABLE public.something (...);   -- copied from production
RESET ROLE;
```

- [ ] **Step 3: `supabase/tests/_template/tests.sql`**

```sql
-- Checks of the rehearsal. Each check that does not hold inserts a row into public._t_fail (created
-- by run.sh); run.sh prints them as FAIL lines and exits 1. At least one check must fail without the
-- migration: `run.sh none` has to fail, or the rehearsal does not test the migration.
-- These three checks belong to the example migration of the template; replace them.
DO $t$
BEGIN
  IF to_regclass('public.rehearsal_example') IS NULL THEN
    INSERT INTO public._t_fail VALUES ('T1 the migration creates public.rehearsal_example', NULL);
  ELSE
    IF NOT has_table_privilege('service_role', 'public.rehearsal_example', 'SELECT') THEN
      INSERT INTO public._t_fail VALUES ('T2 service_role can read public.rehearsal_example', NULL);
    END IF;
    IF has_table_privilege('anon', 'public.rehearsal_example', 'SELECT') THEN
      INSERT INTO public._t_fail VALUES ('T3 anon cannot read public.rehearsal_example', NULL);
    END IF;
  END IF;
END
$t$;
```

- [ ] **Step 4: `supabase/tests/_template/example-migration.sql`**

```sql
-- Example migration of the rehearsal template. CI runs the template with it on every PR to prove
-- the server, the client and the template work. Not a real migration: it lives outside
-- supabase/migrations/.
CREATE TABLE IF NOT EXISTS public.rehearsal_example (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
ALTER TABLE public.rehearsal_example ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.rehearsal_example TO service_role;
```

- [ ] **Step 5: `supabase/tests/README.md`**

```markdown
# Migration rehearsals

Every new file `supabase/migrations/<number>_<name>.sql` comes with `supabase/tests/<number>/run.sh`.
CI (`.github/workflows/migration-rehearsal.yml`) runs it on Postgres 17 + PostGIS, as production:

- `run.sh none` must exit **1** and print at least one line starting with `FAIL`: the checks see
  what the migration fixes. An infrastructure error (scaffold failed, no server) must exit 2.
- `run.sh supabase/migrations/<file>` must exit **0**: applied twice (idempotent), every check holds.

To start one, copy `_template/` to `<number>/`, paste the live objects into `scaffold.sql`
(`scripts/sql/live-definitions.sql` prints them through the Supabase MCP), and write the checks in
`tests.sql`. A runner written in the older style (its own `val`/`ok`/`ko` helpers) is fine as long
as it keeps that contract.

A migration that really has nothing to rehearse starts with `-- rehearsal-exempt: <reason>`; the
reviewers judge the reason.

Locally (Windows): Postgres portable binaries as in CLAUDE.md, then
`PGBIN=<dir> PGPORT=<port> bash supabase/tests/<number>/run.sh none`.
```

- [ ] **Step 6: Commit**

```bash
git add supabase/tests/_template supabase/tests/README.md
git commit -m "feat(tests): rehearsal template with the CI contract"
```

### Task 20: the live-definitions helper

**Files:**
- Create: `scripts/sql/live-definitions.sql`

- [ ] **Step 1: Write it**

```sql
-- Prints the live definition of the objects a migration touches, to paste into a rehearsal
-- scaffold. Read-only. Run it through the Supabase MCP (execute_sql) after replacing the names in
-- the first CTE (schema-qualified: public.rides, public.complete_ride_and_pay).
WITH names(name) AS (VALUES ('public.rides'), ('public.complete_ride_and_pay')),
fns AS (
  SELECT 'function' AS kind, p.oid::regprocedure::text AS object, md5(p.prosrc) || '/' || length(p.prosrc) AS md5,
         pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p JOIN names n ON n.name = p.pronamespace::regnamespace::text || '.' || p.proname
),
rels AS (
  SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
         c.oid::regclass::text AS object, NULL::text AS md5,
         CASE WHEN c.relkind IN ('v', 'm')
              THEN format('CREATE OR REPLACE VIEW %s AS %s', c.oid::regclass, pg_get_viewdef(c.oid, true))
              ELSE format('CREATE TABLE %s (%s);', c.oid::regclass, (
                SELECT string_agg(format('%I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                         CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                         coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')), ', ' ORDER BY a.attnum)
                FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
         END || E'\n-- grants: ' || coalesce(c.relacl::text, 'default') || E'\n-- rls: ' || c.relrowsecurity
  FROM pg_class c JOIN names n ON n.name = c.relnamespace::regnamespace::text || '.' || c.relname
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
),
pols AS (
  SELECT 'policy' AS kind, format('%s on %s.%s', p.policyname, p.schemaname, p.tablename) AS object, NULL::text,
         format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;', p.policyname, p.schemaname, p.tablename,
                p.permissive, p.cmd, array_to_string(p.roles, ', '),
                coalesce(' USING (' || p.qual || ')', ''), coalesce(' WITH CHECK (' || p.with_check || ')', ''))
  FROM pg_policies p JOIN names n ON n.name = p.schemaname || '.' || p.tablename
)
SELECT * FROM fns UNION ALL SELECT * FROM rels UNION ALL SELECT * FROM pols ORDER BY 1, 2;
```

- [ ] **Step 2: Run it once, read-only, through the MCP**

Run it with `execute_sql` (project `lqaufszburqvlslpcuac`) for `public.rides` and
`public.complete_ride_and_pay`. Expected: one `function` row whose md5 matches
`SELECT md5(prosrc) FROM pg_proc WHERE proname = 'complete_ride_and_pay'`, one `table` row for
`public.rides` with its grants and `rls: true`, and the policies of `rides`. Paste nothing from the
output into the repository (it is only a check that the query runs).

- [ ] **Step 3: Commit**

```bash
git add scripts/sql/live-definitions.sql
git commit -m "feat(tests): helper that prints live definitions for a rehearsal scaffold"
```

### Task 21: the rehearsal workflow and docs

**Files:**
- Create: `.github/workflows/migration-rehearsal.yml`
- Modify: `docs/review/schema.md`, `docs/review/areas.json`, `CLAUDE.md`

- [ ] **Step 1: Create the workflow**

```yaml
name: Migration rehearsal

# Runs the rehearsal of every migration a PR adds, on Postgres 17 + PostGIS as in production
# (supabase/tests/README.md). A plain image, not supabase/postgres: the rehearsals create the
# Supabase roles themselves and several check that postgres is not a superuser.

on:
  pull_request:
    branches: [master]

concurrency:
  group: migration-rehearsal-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  rehearsal:
    name: Migration rehearsal
    runs-on: ubuntu-latest
    timeout-minutes: 30
    env:
      PGPORT: '5433'
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Planner tests
        run: node --test scripts/ci/rehearsal-plan.test.mjs
      - name: Postgres client
        run: |
          bin=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
          if [ -z "$bin" ] || [ ! -x "$bin/psql" ]; then
            sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client
            bin=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
          fi
          "$bin/psql" --version
          echo "PGBIN=$bin" >> "$GITHUB_ENV"
      - name: Postgres 17 with PostGIS (production is 17.6)
        run: |
          docker run -d --name pg -p 5433:5432 -e POSTGRES_USER=pgtest -e POSTGRES_HOST_AUTH_METHOD=trust \
            postgis/postgis:17-3.5@sha256:01a6a70e41e6c4467c8f55f6063555ed72db2d6662cd0d571040d42eadaeb6f6 \
            -c max_connections=60 -c superuser_reserved_connections=3
          for _ in $(seq 1 90); do "$PGBIN/pg_isready" -q -h 127.0.0.1 -p 5433 -U pgtest && break; sleep 1; done
          "$PGBIN/psql" -h 127.0.0.1 -p 5433 -U pgtest -d postgres -Atc "select version()"
      - name: The template fails without its migration and passes with it
        run: |
          set +e
          out=$(bash supabase/tests/_template/run.sh none); code=$?
          echo "$out"
          if [ "$code" != 1 ] || ! echo "$out" | grep -q '^FAIL'; then echo "::error::the template's RED run did not fail as it must (exit $code)"; exit 1; fi
          bash supabase/tests/_template/run.sh supabase/tests/_template/example-migration.sql || { echo "::error::the template's GREEN run failed"; exit 1; }
      - name: Rehearse the migrations of this PR
        run: node scripts/ci/rehearse-changed-migrations.mjs --base origin/master --head HEAD
```

- [ ] **Step 2: Docs**

`docs/review/schema.md`: add to the checklist `The PR adds supabase/tests/<number>/run.sh and CI's
"Migration rehearsal" ran its RED (fails without the migration) and GREEN (passes with it twice).`
`docs/review/areas.json`: `"^scripts/ci/"` and `"^scripts/sql/"` in `areas.access.paths` if not there,
and `"^supabase/tests/_template/"` in `areas.schema.paths`; run `pnpm test:review-areas`.
`CLAUDE.md`, after the native paragraph of "## Método de trabajo y revisión de PRs":

```markdown
**Migration rehearsal** (`.github/workflows/migration-rehearsal.yml`) corre el ensayo de cada migración nueva del PR en Postgres 17 con PostGIS, como prod: `supabase/tests/<número>/run.sh none` tiene que fallar (salir con 1 e imprimir una línea `FAIL`) y `run.sh <migración>` tiene que pasar. Una migración nueva sin ensayo falla, salvo que su primera línea sea `-- rehearsal-exempt: <motivo>`. Para empezar uno, copiar `supabase/tests/_template/`; `scripts/sql/live-definitions.sql` (por MCP, solo lectura) da las definiciones vivas para el scaffold. Contrato completo: `supabase/tests/README.md`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/migration-rehearsal.yml docs/review/schema.md docs/review/areas.json CLAUDE.md
git commit -m "ci: rehearse every new migration on Postgres 17 + PostGIS"
```

### Task 22: PR 2d with its negative controls

- [ ] **Step 1: Ask Eduardo for the OK to push `ci/migration-rehearsal` with temporary commits and open the PR.**
- [ ] **Step 2: Push and open the draft.** Expected: "Migration rehearsal" passes; the template step shows `FAIL T1 …` then `PASS`; the last step says `0 rehearsal(s) run`. Record duration.
- [ ] **Step 3: A migration without a rehearsal**

```bash
printf -- '-- CI probe, reverted in the next commit.\nSELECT 1;\n' > supabase/migrations/99990_ci_probe.sql
git add supabase/migrations/99990_ci_probe.sql && git commit -m "test(ci): migration without rehearsal (negative control)" && git push
```

Expected: fails with `99990_ci_probe.sql has no rehearsal`. Record the link.

- [ ] **Step 4: A rehearsal that does not test anything**

```bash
cp -r supabase/tests/_template supabase/tests/99990
printf -- 'SELECT 1;\n' > supabase/tests/99990/tests.sql
git add supabase/tests/99990 && git commit -m "test(ci): rehearsal that never fails (negative control)" && git push
```

Expected: fails with `run.sh none exited 0 without a FAIL line`. Record the link.

- [ ] **Step 5: Revert both commits** (`git revert --no-edit HEAD HEAD~1`), push, confirm green, links and duration in the description, ready, ask for the merge OK.

---

# PR 2e — Secrets and new dependency advisories

Files:
- Create `.gitleaks.toml`, `scripts/ci/gitleaks-selftest.sh`.
- Create `scripts/ci/lib/audit-diff.mjs`, `scripts/ci/audit-diff.test.mjs`, `scripts/ci/audit-new-advisories.mjs`.
- Create `security/audit-accepted.json`.
- Create `.github/workflows/security.yml`.
- Modify `docs/review/areas.json`, `docs/review/access.md`, `CLAUDE.md`.

### Task 23: gitleaks config and its self-test

**Files:**
- Create: `.gitleaks.toml`, `scripts/ci/gitleaks-selftest.sh`

- [ ] **Step 1: `.gitleaks.toml`**

```toml
# gitleaks configuration of the PR check (.github/workflows/security.yml): the default rules, plus
# the client values that are public by design and already ship inside the apps (eas.json,
# eas-update.yml). The repository is public: anything else that looks like a secret fails the PR.
title = "TriciGo"

[extend]
useDefault = true

[[allowlists]]
description = "Public client values: Supabase publishable key, Mapbox public token of the tricigo account, PostHog project key"
regexTarget = "match"
regexes = [
  '''sb_publishable_[A-Za-z0-9_-]+''',
  '''pk\.eyJ1IjoidHJpY2lnbyIs[A-Za-z0-9._-]+''',
  '''phc_[A-Za-z0-9]{20,}''',
]
```

- [ ] **Step 2: `scripts/ci/gitleaks-selftest.sh`**

```bash
#!/usr/bin/env bash
# Proves the gitleaks binary and .gitleaks.toml work before the real scan: a planted token must be
# found, and the public values of the allowlist must not be.
#   scripts/ci/gitleaks-selftest.sh <path-to-gitleaks>
set -eu
gl="$1"
cfg="$(pwd)/.gitleaks.toml"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# probe NAME CONTENT -> prints the exit code of gitleaks on a one-commit repository holding CONTENT
probe() {
  local dir="$work/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  printf '%s\n' "$2" > "$dir/value.txt"
  git -C "$dir" add value.txt
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m probe
  set +e
  "$gl" git "$dir" --config "$cfg" --no-banner --redact --exit-code 1 > "$work/$1.log" 2>&1
  local code=$?
  set -e
  echo "$code"
}

# Built at run time, so this file holds no token.
planted="ghp_$(openssl rand -hex 18)"
found=$(probe planted "GITHUB_TOKEN=$planted")
public=$(probe public "EXPO_PUBLIC_SUPABASE_ANON_KEY: sb_publishable_hSzDS_2ivar8CGqUm-yd3w_-65h1Zsc
EXPO_PUBLIC_MAPBOX_TOKEN: pk.eyJ1IjoidHJpY2lnbyIsImEiOiJjbW1wbmlnemIwczI4MnNvcmdremJwaTRzIn0._lAOaQ1Eg9LfszmlcZ5GQg")

status=0
if [ "$found" != 1 ]; then echo "::error::gitleaks did not find a planted GitHub token (exit $found)"; cat "$work/planted.log"; status=1; fi
if [ "$public" != 0 ]; then echo "::error::gitleaks flagged an allowlisted public value (exit $public)"; cat "$work/public.log"; status=1; fi
[ "$status" = 0 ] && echo "gitleaks self-test: the planted token is found, the public values pass."
exit "$status"
```

- [ ] **Step 3: Commit**

```bash
git add .gitleaks.toml scripts/ci/gitleaks-selftest.sh
git commit -m "ci: gitleaks config with the public client values and a self-test"
```

### Task 24: the audit diff

**Files:**
- Create: `scripts/ci/lib/audit-diff.mjs`, `scripts/ci/audit-diff.test.mjs`, `scripts/ci/audit-new-advisories.mjs`, `security/audit-accepted.json`

- [ ] **Step 1: Write the failing test**

```js
// node --test scripts/ci/audit-diff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findings, newAdvisories, validateAccepted } from './lib/audit-diff.mjs';

const report = (...items) => ({
  advisories: Object.fromEntries(
    items.map(([id, module, severity, version], i) => [
      String(i),
      { github_advisory_id: id, module_name: module, severity, title: `${module} bug`, findings: [{ version, paths: [] }] },
    ]),
  ),
});

test('findings keeps high and critical, per module version', () => {
  const f = findings(report(['GHSA-1', 'next', 'critical', '15.5.27'], ['GHSA-2', 'ws', 'moderate', '8.19.0']));
  assert.deepEqual([...f.keys()], ['GHSA-1|next@15.5.27']);
});

test('an advisory already on master is not new', () => {
  const base = report(['GHSA-1', 'next', 'critical', '15.5.27']);
  assert.deepEqual(newAdvisories(base, base, [], '2026-11-20').errors, []);
});

test('a new high advisory fails, an accepted one only notices, an expired acceptance fails', () => {
  const base = report();
  const head = report(['GHSA-9', 'lodash', 'high', '4.17.20']);
  assert.match(newAdvisories(base, head, [], '2026-11-20').errors[0], /GHSA-9 in lodash@4\.17\.20/);
  const accepted = [{ id: 'GHSA-9', reason: 'build tool, never runs in production', until: '2026-12-31' }];
  const ok = newAdvisories(base, head, accepted, '2026-11-20');
  assert.deepEqual(ok.errors, []);
  assert.match(ok.notices[0], /accepted until 2026-12-31/);
  assert.match(newAdvisories(base, head, accepted, '2027-01-01').errors[0], /expired/);
});

test('the same advisory on a new version of the module is new', () => {
  const base = report(['GHSA-1', 'next', 'high', '15.5.26']);
  const head = report(['GHSA-1', 'next', 'high', '15.5.27']);
  assert.equal(newAdvisories(base, head, [], '2026-11-20').errors.length, 1);
});

test('validateAccepted wants an id, a real reason and a date', () => {
  assert.deepEqual(validateAccepted([{ id: 'GHSA-9', reason: 'build tool only, reviewed', until: '2026-12-31' }]), []);
  assert.equal(validateAccepted([{ id: 'GHSA-9', reason: 'ok', until: '2026-12-31' }]).length, 1);
  assert.equal(validateAccepted([{ id: 'GHSA-9', reason: 'build tool only, reviewed', until: 'soon' }]).length, 1);
  assert.equal(validateAccepted({}).length, 1);
});
```

- [ ] **Step 2: Run it** — `node --test scripts/ci/audit-diff.test.mjs` — Expected: FAIL, `Cannot find module`.

- [ ] **Step 3: Write the library**

```js
// Compares two `pnpm audit --prod --json` reports. An advisory is new when the head report has it
// for a module version the base report does not. Only high and critical count: master carried 78
// of them on 2026-11-20, so the check stops new ones without blocking on the old ones.

const SERIOUS = new Set(['high', 'critical']);

// Map("<GHSA>|<module>@<version>" -> { id, module, version, severity, title })
export function findings(report) {
  const out = new Map();
  for (const advisory of Object.values(report?.advisories ?? {})) {
    if (!SERIOUS.has(advisory.severity)) continue;
    const versions = (advisory.findings ?? []).map((f) => f.version);
    for (const version of versions.length ? versions : ['?']) {
      out.set(`${advisory.github_advisory_id}|${advisory.module_name}@${version}`, {
        id: advisory.github_advisory_id,
        module: advisory.module_name,
        version,
        severity: advisory.severity,
        title: advisory.title,
      });
    }
  }
  return out;
}

// accepted: [{ id, reason, until: 'YYYY-MM-DD' }]. today: 'YYYY-MM-DD'.
export function newAdvisories(baseReport, headReport, accepted, today) {
  const base = findings(baseReport);
  const byId = new Map(accepted.map((entry) => [entry.id, entry]));
  const errors = [];
  const notices = [];
  for (const [key, f] of findings(headReport)) {
    if (base.has(key)) continue;
    const entry = byId.get(f.id);
    if (entry && entry.until >= today) {
      notices.push(`${f.id} ${f.module}@${f.version} accepted until ${entry.until}: ${entry.reason}`);
      continue;
    }
    errors.push(`${f.severity} ${f.id} in ${f.module}@${f.version}: ${f.title}${entry ? ` (accepted until ${entry.until}, expired)` : ''}`);
  }
  return { errors, notices };
}

export function validateAccepted(list) {
  if (!Array.isArray(list)) return ['security/audit-accepted.json must be a JSON array.'];
  const problems = [];
  for (const [i, entry] of list.entries()) {
    if (!/^GHSA-[\w-]+$/.test(entry?.id ?? '')) problems.push(`entry ${i}: "id" must be a GHSA id.`);
    if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 10) problems.push(`entry ${i}: "reason" needs 10+ characters.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry?.until ?? '')) problems.push(`entry ${i}: "until" must be YYYY-MM-DD.`);
  }
  return problems;
}
```

- [ ] **Step 4: Run the test** — Expected: PASS, `fail 0`.

- [ ] **Step 5: Write the CLI**

```js
#!/usr/bin/env node
// Fails when this PR's lockfile brings a high or critical advisory that master's lockfile does not
// have (scripts/ci/lib/audit-diff.mjs):
//   node scripts/ci/audit-new-advisories.mjs --base origin/master
// Accepted ones live in security/audit-accepted.json: [{ "id", "reason", "until" }], reviewed in a PR.
// Exit 0 nothing new, 1 something new, 2 the audit could not run (registry down, bad file).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { git, mergeBase } from '../lib/git-read.mjs';
import { newAdvisories, validateAccepted } from './lib/audit-diff.mjs';

function fail(message) {
  console.error(`audit: ${message}`);
  process.exit(2);
}

function audit(dir) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync('pnpm', ['audit', '--prod', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    try {
      const report = JSON.parse(r.stdout);
      if (report && report.advisories) return report;
    } catch {
      // retried below
    }
  }
  fail(`pnpm audit gave no report in ${dir}`);
}

const { values } = parseArgs({ strict: true, options: { base: { type: 'string' } } });
if (!values.base) fail('--base is required');
const accepted = JSON.parse(readFileSync('security/audit-accepted.json', 'utf8'));
const invalid = validateAccepted(accepted);
if (invalid.length) fail(invalid.join(' '));

const baseDir = mkdtempSync(join(tmpdir(), 'audit-base-'));
rmSync(baseDir, { recursive: true, force: true });
git(['worktree', 'add', '--detach', baseDir, mergeBase(values.base, 'HEAD')]);
let result;
try {
  result = newAdvisories(audit(baseDir), audit(process.cwd()), accepted, new Date().toISOString().slice(0, 10));
} finally {
  git(['worktree', 'remove', '--force', baseDir]);
}
for (const notice of result.notices) console.log(`::notice::${notice}`);
for (const error of result.errors) console.log(`::error::New advisory: ${error}`);
console.log(result.errors.length ? `${result.errors.length} new high or critical advisory(ies).` : 'No new high or critical advisory.');
process.exit(result.errors.length ? 1 : 0);
```

Create `security/audit-accepted.json` with `[]`.

- [ ] **Step 6: Run it locally**

Run: `node scripts/ci/audit-new-advisories.mjs --base origin/master; echo "exit=$?"`
Expected: `No new high or critical advisory.`, `exit=0` (the branch did not change the lockfile).

- [ ] **Step 7: Commit**

```bash
git add scripts/ci/lib/audit-diff.mjs scripts/ci/audit-diff.test.mjs scripts/ci/audit-new-advisories.mjs security/audit-accepted.json
git commit -m "ci: fail on high or critical advisories a PR adds"
```

(It imports `../lib/git-read.mjs` from PR 2a; same note as Task 18.)

### Task 25: the security workflow and docs

**Files:**
- Create: `.github/workflows/security.yml`
- Modify: `docs/review/areas.json`, `docs/review/access.md`, `CLAUDE.md`

- [ ] **Step 1: Create the workflow**

```yaml
name: Security

# Secrets in the commits of the PR (gitleaks, pinned by checksum) and high or critical dependency
# advisories the PR adds compared with master (pnpm audit).

on:
  pull_request:
    branches: [master]

concurrency:
  group: security-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  security:
    name: Secrets and dependency audit
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Install gitleaks 8.30.1 (checksum pinned)
        run: |
          curl -sSfL -o "$RUNNER_TEMP/gitleaks.tgz" \
            https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
          echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  $RUNNER_TEMP/gitleaks.tgz" | sha256sum -c -
          tar -xzf "$RUNNER_TEMP/gitleaks.tgz" -C "$RUNNER_TEMP" gitleaks
      - name: gitleaks self-test
        run: bash scripts/ci/gitleaks-selftest.sh "$RUNNER_TEMP/gitleaks"
      - name: Secrets in the commits of this PR
        run: |
          base=$(git merge-base origin/master HEAD)
          "$RUNNER_TEMP/gitleaks" git . --config .gitleaks.toml --log-opts="$base..HEAD" --no-banner --redact --exit-code 1
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Audit diff tests
        run: node --test scripts/ci/audit-diff.test.mjs
      - name: High or critical advisories this PR adds
        run: node scripts/ci/audit-new-advisories.mjs --base origin/master
```

- [ ] **Step 2: Docs and map**

`docs/review/areas.json`, `areas.access.paths`: add `"^\\.gitleaks\\.toml$"`, `"^security/"` and
`"^scripts/ci/"` if not there; run `pnpm test:review-areas`.
`docs/review/access.md`: add `A change to .gitleaks.toml or security/audit-accepted.json widens what
the security check lets through: every allowlist entry and every accepted advisory has a reason a
reviewer agrees with, and accepted advisories carry an end date.`
`CLAUDE.md`, after the rehearsal paragraph:

```markdown
**Secrets and dependency audit** (`.github/workflows/security.yml`) corre gitleaks sobre los commits del PR (binario fijado por checksum, con una autoprueba que planta un token y exige que lo encuentre) y compara `pnpm audit --prod` del PR con el de `master`: falla solo si el PR trae un aviso alto o crítico nuevo. `master` tenía 78 el 2026-11-20, así que bloquear todos no era posible; los aceptados van en `security/audit-accepted.json` con motivo y fecha de vencimiento. La lista de valores públicos que gitleaks deja pasar está en `.gitleaks.toml`.
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/security.yml docs/review/areas.json docs/review/access.md CLAUDE.md
git commit -m "ci: secrets and new dependency advisories on every PR"
```

### Task 26: PR 2e with its negative controls

- [ ] **Step 1: Ask Eduardo for the OK to push `ci/secrets-audit` with temporary commits and open the PR.**
- [ ] **Step 2: Push and open the draft.** Expected: the self-test prints `the planted token is found, the public values pass`; the scan of the PR commits passes (`.gitleaks.toml` and the self-test hold only allowlisted public values); `No new high or critical advisory.` Record duration.
- [ ] **Step 3: A dependency with a known critical advisory**

```bash
cd apps/admin && node -e 'const f="package.json";const p=require("./"+f);p.dependencies.minimist="1.2.5";require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' && cd ../..
pnpm install --lockfile-only
git commit -am "test(ci): add minimist 1.2.5 (negative control, reverted next)" && git push
```

Expected: fails with `New advisory: critical GHSA-xvch-5gv4-984h in minimist@1.2.5` (the prototype
pollution fixed in 1.2.6). Record the link.

- [ ] **Step 4: Revert** (`git revert --no-edit HEAD`), push, confirm green, links and duration in the description, ready, ask for the merge OK.

---

# Branch protection (owner action)

### Task 27: make the checks required

- [ ] **Step 1: Confirm each check ran green on `master` or on a merged PR**

Run: `gh run list --branch master --limit 30 --json name,conclusion --jq '.[] | "\(.name) \(.conclusion)"' | sort -u`
and `gh pr checks <last merged PR>`. Expected check names: `Lint, Type Check & Test`, `PR gate`,
`Build web and admin`, `Bundle client`, `Bundle driver`, `Native change vs version`,
`Migration rehearsal`, `Secrets and dependency audit`.

- [ ] **Step 2: Show Eduardo this payload and ask for the OK (it changes repository settings)**

Write `$TEMP/protection.json`:

```json
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "Lint, Type Check & Test" },
      { "context": "PR gate" },
      { "context": "Build web and admin" },
      { "context": "Bundle client" },
      { "context": "Bundle driver" },
      { "context": "Native change vs version" },
      { "context": "Migration rehearsal" },
      { "context": "Secrets and dependency audit" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "required_conversation_resolution": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

`enforce_admins: true` because the agents work under the owner account. Zero approvals because there
is one human account; the PR itself is still required.

A required status check is matched by name. A PR could add its own workflow on `pull_request` with
a job also called "PR gate" (found in the review of PR 2a; how branch protection weighs two runs
with the same name was not verified). Before applying the payload, check whether the repository can
use a ruleset with "Require workflows to pass before merging" pinned to `.github/workflows/pr-gate.yml`
on `master` (`gh api repos/AgenciaSeniors/TriciGo/rulesets` and the repository settings). If it
can, require the gate that way and keep the other checks in branch protection; if it cannot, say so
to Eduardo and record it as an accepted risk (workflow files are in the access area, so such a PR
still needs the cross-review, the Codex bot and his OK).

- [ ] **Step 3: Apply it after the OK**

Run: `gh api -X PUT repos/AgenciaSeniors/TriciGo/branches/master/protection --input "$TEMP/protection.json"`
Then: `gh api repos/AgenciaSeniors/TriciGo/branches/master/protection --jq '{checks: [.required_status_checks.checks[].context], admins: .enforce_admins.enabled, conversations: .required_conversation_resolution.enabled}'`
Expected: the eight checks, `admins: true`, `conversations: true`.

- [ ] **Step 4: Prove it refuses a red PR**

On a throwaway draft PR whose description is the blank template (so "PR gate" is red):
`gh pr ready <n> && gh pr merge <n> --squash` — Expected: refused, naming the failing required check.
Close the PR and delete its branch.

- [ ] **Step 5: Write the emergency path into CLAUDE.md**

In "### Merges a `master` requieren autorización explícita por PR", add:

```markdown
**Protección de `master` (desde la parte 2 de los validadores).** Ningún PR entra con un chequeo requerido en rojo o un hilo de revisión sin resolver, tampoco con la cuenta dueña (`enforce_admins`). En una emergencia, con el OK de Eduardo para ese caso: `gh api -X DELETE repos/AgenciaSeniors/TriciGo/branches/master/protection/enforce_admins`, mergear, y volver a activarlo enseguida con `gh api -X POST repos/AgenciaSeniors/TriciGo/branches/master/protection/enforce_admins`. Los chequeos requeridos y el JSON completo están en `docs/superpowers/plans/2026-11-20-pr-validators-2-ci-checks.md`, Task 27.
```

Commit it in its own small docs PR (docs-only: no cross-review needed).

---

## Out of scope (follow-ups)

- **Done: Next 15.5.29 in `apps/web` and `apps/admin`** (#1229, merged and deployed 2026-11-20).
  15.5.28 fixes GHSA-2464-fhr4-w9xw (critical) and GHSA-p3m5-59mp-jv5r. 15.5.29 also fixes
  GHSA-7qx7-33qx-rqx2 (the image optimizer can be made to process an SVG with
  `dangerouslyAllowSVG: false`), GHSA-f3mh-rxg3-f5g2 and GHSA-pc58-hwjq-p385, all published on
  2026-11-19. The check of what the public buckets accept is in the PR description. Production
  already ran sharp 0.35.5 (#1149), which is the workaround GHSA-2464 gives.
- Running the 89 older rehearsals in CI: they run when a PR touches their folder (GREEN only).
- Part 3 sets `crossReview.required` to `true` in `docs/review/areas.json`.

## Self-review

- Spec §1 table: build web/admin (Tasks 10-11), bundle apps (11), native vs version (13-15),
  migration rehearsal (17-21), immutable migrations (5-6), tests required (5-6), secrets (23, 25),
  production dependencies (24-25, as new-advisories, see measurements), web lint (9),
  PR description (5-7). §1.1 scaffold helper (20). §1.3 base map, union, `test:review-areas` in CI
  (6-7), part-1 gaps: merge base and stdin root (3), helpers (2-3), web hooks (4). Negative controls:
  Tasks 8, 12, 16, 22, 26, plus the built-in self-tests (template RED/GREEN, gitleaks planted token,
  smoke 404 route). Branch protection: Task 27.
- Names used across tasks: `changedFiles`, `readBlobs`, `listTree`, `mergeBase`, `isAncestor`,
  `commitExists` (Task 1); `apiImportsIn`, `helperExportsIn`, `helperIndex`, `unionAreas`,
  `SERVICES_DIR`, `areasForChange(paths, map, readText, helpers)` (Task 2); `checkDescription`,
  `checkTests`, `checkMigrations`, `checkCrossReview`, `latestVerdict`, `reasonFor`,
  `migrationEdits` (Task 5); `planRehearsals` (17); `judgeFingerprint`, `changedSources` (13);
  `findings`, `newAdvisories`, `validateAccepted` (24).
