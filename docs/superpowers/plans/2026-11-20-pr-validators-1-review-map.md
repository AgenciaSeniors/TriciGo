# PR validators, part 1: review areas, checklists and PR template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every reviewer (the author's Claude agents, the local Codex cross-review and the Codex bot on GitHub) one shared, tested definition of TriciGo's sensitive areas and one checklist per area, plus a PR template that asks for the evidence.

**Architecture:** `docs/review/areas.json` maps repository paths and migration file-name words to six areas (money, access, schema, dispatch, edge-functions, native). A small Node library (`scripts/lib/review-areas.mjs`) and CLI (`scripts/review-areas.mjs`, `pnpm review:areas`) turn a diff into the list of touched areas and the checklists to read. Later parts reuse them: the PR description check in CI (part 2) and the cross-review skills (part 3). Checklists are Markdown in `docs/review/`, written from bugs already documented in `CLAUDE.md`. A root `AGENTS.md` carries the review guidelines the Codex bot reads.

**Tech Stack:** Node 20 built-ins only (`node:test`, `node:fs`, `node:child_process`), no new dependency. Same layout as `scripts/lib/migration-grants.mjs` + `scripts/check-migration-grants.mjs` + `scripts/check-migration-grants.test.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-20-pr-validators-and-promotion-design.md`, sections 1.3 (area map), 2.1 (checklists), 2.4 (`AGENTS.md`) and 4 (CLAUDE.md rules). Parts 2 to 4 of the delivery order get their own plans.

**Branch:** `docs/validadores-pr-y-promocion`, worktree `.claude/worktrees/validadores-pr`. The worktree has no `node_modules`; everything in this plan runs with plain `node`, so no install is needed.

---

## File structure

| File | Responsibility |
|---|---|
| `docs/review/areas.json` | The map: per area a title, its checklist file, path regexes and migration words. Plus global ignore regexes |
| `scripts/lib/review-areas.mjs` | Load and compile the map; `areasForPaths(paths, map)` |
| `scripts/review-areas.mjs` | CLI: diff (or stdin) in, areas and checklists out, `--json` for machines |
| `scripts/review-areas.test.mjs` | Tests of the library, the CLI and the real map against the real tree |
| `package.json` | `review:areas` and `test:review-areas` scripts |
| `docs/review/README.md` | How the areas and checklists are used |
| `docs/review/general.md` | Checklist for every PR |
| `docs/review/money.md`, `access.md`, `schema.md`, `dispatch.md`, `edge-functions.md`, `native.md` | One checklist per area |
| `.github/pull_request_template.md` | The PR template, with fixed headings part 2 will parse |
| `AGENTS.md` | Instructions for Codex, with the "Review guidelines" section the GitHub bot reads |
| `CLAUDE.md` | Fix the stale stack lines; add the method and the two new rules |

---

### Task 1: Area map library and CLI (test first)

**Files:**
- Create: `scripts/review-areas.test.mjs`
- Create: `scripts/lib/review-areas.mjs`
- Create: `scripts/review-areas.mjs`
- Create: `docs/review/areas.json`
- Modify: `package.json` (scripts block)

- [ ] **Step 1: Write the failing tests**

Create `scripts/review-areas.test.mjs`:

```js
// Tests for scripts/lib/review-areas.mjs, its CLI scripts/review-areas.mjs, and the real map
// in docs/review/areas.json checked against the real tree:
//   node --test scripts/review-areas.test.mjs     (pnpm test:review-areas)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  areasForPaths,
  compileAreas,
  loadAreas,
  migrationWords,
  normalizePath,
} from './lib/review-areas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = loadAreas();
const ids = (paths, map = real) => areasForPaths(paths, map).map((a) => a.id);

describe('helpers', () => {
  test('migrationWords splits the name of a migration file', () => {
    assert.deepEqual(migrationWords('supabase/migrations/00637_wallet_shortfall_pays_cash.sql'), [
      'wallet',
      'shortfall',
      'pays',
      'cash',
    ]);
  });

  test('migrationWords ignores anything that is not a migration file', () => {
    assert.deepEqual(migrationWords('supabase/functions/send-push/index.ts'), []);
    assert.deepEqual(migrationWords('supabase/tests/00637/tests.sql'), []);
  });

  test('normalizePath turns Windows separators and ./ into repo paths', () => {
    assert.equal(normalizePath('.\\packages\\api\\x.ts '), 'packages/api/x.ts');
  });

  test('a toy map: paths, words, ignore, sorting and unique files', () => {
    const toy = compileAreas({
      ignore: ['\\.md$'],
      areas: {
        zeta: { title: 'Z', checklist: 'z.md', paths: ['^src/z/'] },
        alpha: { title: 'A', checklist: 'a.md', paths: [], migrationWords: ['wallet'] },
      },
    });
    const result = areasForPaths(
      ['src/z/b.ts', 'src/z/a.ts', 'src/z/a.ts', 'src/z/notes.md', 'supabase/migrations/00001_wallet_x.sql'],
      toy,
    );
    assert.deepEqual(result, [
      { id: 'alpha', title: 'A', checklist: 'a.md', files: ['supabase/migrations/00001_wallet_x.sql'] },
      { id: 'zeta', title: 'Z', checklist: 'z.md', files: ['src/z/a.ts', 'src/z/b.ts'] },
    ]);
  });
});

describe('the real map', () => {
  test('wallet code is money', () => {
    assert.deepEqual(ids(['packages/api/src/services/wallet.service.ts']), ['money']);
  });

  test('a money migration is money and schema', () => {
    assert.deepEqual(ids(['supabase/migrations/00637_wallet_shortfall_pays_cash.sql']), ['money', 'schema']);
  });

  test('a dispatch migration is dispatch and schema', () => {
    assert.deepEqual(ids(['supabase/migrations/00686_reclaim_released_ride.sql']), ['dispatch', 'schema']);
  });

  test('an access migration is access and schema', () => {
    assert.deepEqual(ids(['supabase/migrations/00668_operator_role_base.sql']), ['access', 'schema']);
  });

  test('migration words are whole words: "override" is not "ride"', () => {
    assert.deepEqual(ids(['supabase/migrations/09999_price_override.sql']), ['money', 'schema']);
  });

  test('payment webhook function is edge-functions and money', () => {
    assert.deepEqual(ids(['supabase/functions/process-netopia-webhook/index.ts']), ['edge-functions', 'money']);
  });

  test('login function is access and edge-functions', () => {
    assert.deepEqual(ids(['supabase/functions/verify-otp/index.ts']), ['access', 'edge-functions']);
  });

  test('push function is dispatch and edge-functions', () => {
    assert.deepEqual(ids(['supabase/functions/send-push/index.ts']), ['dispatch', 'edge-functions']);
  });

  test('app config, config plugins and native modules are native', () => {
    assert.deepEqual(ids(['apps/driver/app.json']), ['native']);
    assert.deepEqual(ids(['apps/client/plugins/with-large-heap.js']), ['native']);
    assert.deepEqual(ids(['apps/driver/modules/driver-overlay/index.ts']), ['native']);
  });

  test('workflows and ops scripts are access (they hold secrets and reach production)', () => {
    assert.deepEqual(ids(['.github/workflows/deploy-web.yml']), ['access']);
    assert.deepEqual(ids(['ops/actions-runner/job-gate.sh']), ['access']);
  });

  test('ride screens and hooks are dispatch', () => {
    assert.deepEqual(ids(['apps/driver/src/hooks/useDriverRide.ts']), ['dispatch']);
    assert.deepEqual(ids(['apps/client/app/ride/[id].tsx']), ['dispatch']);
  });

  test('plain UI touches no area', () => {
    assert.deepEqual(ids(['apps/client/src/components/DriverInfoMiniCard.tsx']), []);
  });

  test('docs and tests inside sensitive folders touch no area', () => {
    assert.deepEqual(
      ids([
        'supabase/functions/send-push/README.md',
        'packages/api/src/services/__tests__/wallet.service.test.ts',
        'packages/utils/src/ledger.test.ts',
      ]),
      [],
    );
  });

  test('Windows paths work', () => {
    assert.deepEqual(ids(['packages\\api\\src\\services\\wallet.service.ts']), ['money']);
  });
});

describe('the map stays true to the repository', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  test('every area has a checklist file that exists', () => {
    for (const area of real.areas) {
      assert.ok(existsSync(join(ROOT, area.checklist)), `${area.id}: missing ${area.checklist}`);
    }
  });

  test('every path regex matches at least one tracked file (no stale or mistyped path)', () => {
    for (const area of real.areas) {
      for (const re of area.paths) {
        assert.ok(tracked.some((f) => re.test(f)), `${area.id}: ${re} matches no tracked file`);
      }
    }
  });
});

describe('CLI', () => {
  const run = (input, ...args) =>
    spawnSync(process.execPath, ['scripts/review-areas.mjs', '--stdin', ...args], {
      cwd: ROOT,
      input,
      encoding: 'utf8',
    });

  test('--json lists the areas of the paths read from stdin', () => {
    const r = run('packages/api/src/services/wallet.service.ts\nsupabase/functions/verify-otp/index.ts\n', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      JSON.parse(r.stdout).areas.map((a) => a.id),
      ['access', 'edge-functions', 'money'],
    );
  });

  test('plain output names the checklist of each area', () => {
    const r = run('packages/api/src/services/wallet.service.ts\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^money: /m);
    assert.match(r.stdout, /checklist: docs\/review\/money\.md/);
  });

  test('a change with no sensitive area says so', () => {
    const r = run('docs/qa/bugs-rondas.md\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No sensitive area touched\./);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node --test scripts/review-areas.test.mjs`
Expected: FAIL, `Cannot find module '.../scripts/lib/review-areas.mjs'`.

- [ ] **Step 3: Write the library**

Create `scripts/lib/review-areas.mjs`:

```js
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
```

- [ ] **Step 4: Write the CLI**

Create `scripts/review-areas.mjs`:

```js
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
```

- [ ] **Step 5: Write the map**

Create `docs/review/areas.json`:

```json
{
  "ignore": [
    "\\.md$",
    "(^|/)__tests__/",
    "\\.test\\.(ts|tsx|js|mjs)$"
  ],
  "areas": {
    "money": {
      "title": "Money: wallet, payments, fares, promotions, gifts, bonuses and referrals",
      "checklist": "docs/review/money.md",
      "paths": [
        "^packages/api/src/services/(wallet|payment|promotion|referral|invoice|exchange-rate|corporate|quest|acquisition-code|fraud)\\.service\\.ts$",
        "^packages/api/src/services/_corporate-balance\\.ts$",
        "^packages/utils/src/(ledger|fareCalculator|farePresentation|fareSplit|currency|signupPromo|receipt-template|netopia-errors)\\.ts$",
        "^supabase/functions/(create-netopia-payment-intent|create-netopia-recharge-intent|create-ride-payment-link|create-stripe-payment-intent|create-stripe-recharge-intent|process-netopia-webhook|process-stripe-webhook|generate-recharge-receipt|resolve-recharge-recipient|mint-netopia-proxy-credential|sync-exchange-rate)/",
        "^apps/(client|driver)/app/(wallet|gift|promo|refer)/",
        "^apps/web/src/app/(wallet|recargar|gift|promo|refer|refunds)/",
        "^apps/admin/src/app/(wallet|earnings|promotions|referrals|quests|fraud)/"
      ],
      "migrationWords": [
        "wallet", "wallets", "payment", "payments", "pay", "pays", "paid", "recharge", "recharges",
        "refund", "refunds", "promo", "promos", "promotion", "promotions", "gift", "gifts", "bonus",
        "bonuses", "coupon", "coupons", "fare", "fares", "price", "prices", "pricing", "payout",
        "payouts", "cash", "cashout", "ledger", "money", "netopia", "stripe", "tropipay", "commission",
        "commissions", "referral", "referrals", "reward", "rewards", "discount", "discounts", "invoice",
        "invoices", "tip", "tips", "surge", "split", "splits", "balance", "earnings", "credit",
        "credits", "charge", "charges", "billing", "exchange"
      ]
    },
    "access": {
      "title": "Access: auth, sessions, RLS, GRANTs, RPC exposure, roles, secrets and the paths to production",
      "checklist": "docs/review/access.md",
      "paths": [
        "^packages/api/src/(authCallback|clockSafeAuth|client)\\.ts$",
        "^packages/api/src/services/(auth|admin|team|block|device)\\.service\\.ts$",
        "^packages/utils/src/(adminPanelAccess|authCallback|teamInvitation|htmlSafety)\\.ts$",
        "^apps/admin/src/middleware\\.ts$",
        "^apps/admin/src/app/(auth|login|equipo|invitacion|sin-acceso|settings|users|forgot-password|reset-password)/",
        "^apps/(client|driver)/app/\\(auth\\)/",
        "^apps/web/src/app/(auth|login|verify-phone|account)/",
        "^supabase/functions/(auto-admin|confirm-email|delete-account|admin-delete-pending-account|link-phone|register-login-device|request-password-reset|send-login-email-link|send-sms-otp|set-password-after-otp|verify-otp|verify-whatsapp-otp|verify-selfie|add-email-with-verification|team-invitation-code|storage-upload|expo-proxy)/",
        "^supabase/functions/_shared/",
        "^supabase/config\\.toml$",
        "^\\.github/workflows/",
        "^ops/"
      ],
      "migrationWords": [
        "rls", "grant", "grants", "revoke", "policy", "policies", "role", "roles", "auth", "permission",
        "permissions", "lockdown", "ungated", "gated", "gate", "public", "rpc", "rpcs", "security",
        "secure", "operator", "admin", "team", "anon", "privacy", "private", "guard", "guards",
        "protect", "protected", "access", "block", "blocked", "otp", "login", "session", "sessions",
        "password", "phone", "verification", "verify", "invitation", "invitations", "marketing",
        "visibility", "deletion", "delete"
      ]
    },
    "schema": {
      "title": "Schema: every migration",
      "checklist": "docs/review/schema.md",
      "paths": [
        "^supabase/migrations/"
      ]
    },
    "dispatch": {
      "title": "Dispatch: ride state, offers, matching, presence and the live trip",
      "checklist": "docs/review/dispatch.md",
      "paths": [
        "^packages/api/src/services/(ride|matching|presence|location|nearby|recurring-ride|ride-assist|missed-ride|moto-deportiva|delivery)\\.service\\.ts$",
        "^packages/api/src/services/_(realtime-status|ride-coordinates)\\.ts$",
        "^packages/utils/src/(activeRidePoller|ride-config|sharedRequest|offlineQueue|motoDeportiva|missedRideOutreach|test-vehicles)\\.ts$",
        "^apps/driver/src/tasks/",
        "^apps/driver/src/hooks/useDriverRide",
        "^apps/client/src/hooks/useRide",
        "^apps/driver/app/trip/",
        "^apps/client/app/ride/",
        "^apps/web/src/app/(ride|rides|track|book)/",
        "^apps/admin/src/app/(rides|live-map|missed-rides|cancellations|moto-deportiva)/",
        "^supabase/functions/(cancel-stale-rides|send-push|demand-heatmap)/"
      ],
      "migrationWords": [
        "ride", "rides", "dispatch", "offer", "offers", "driver", "drivers", "matching", "match", "trip",
        "trips", "reclaim", "presence", "assign", "assigned", "cancel", "canceled", "cancellation",
        "cancellations", "stuck", "scheduled", "recurring", "realtime", "release", "released",
        "online", "offline", "queue", "heartbeat", "location", "pickup", "arrival", "arrived"
      ]
    },
    "edge-functions": {
      "title": "Edge Functions",
      "checklist": "docs/review/edge-functions.md",
      "paths": [
        "^supabase/functions/",
        "^supabase/config\\.toml$"
      ]
    },
    "native": {
      "title": "Native: app config, config plugins, native modules and app dependencies (store build vs OTA)",
      "checklist": "docs/review/native.md",
      "paths": [
        "^apps/(client|driver)/(app\\.json|app\\.config\\.(js|ts)|eas\\.json|package\\.json|PrivacyInfo\\.xcprivacy|metro\\.config\\.js|babel\\.config\\.js)$",
        "^apps/(client|driver)/(plugins|modules|build-config|android|ios)/"
      ]
    }
  }
}
```

- [ ] **Step 6: Add the package scripts**

In `package.json`, after the line `"test:migration-grants": "node --test scripts/check-migration-grants.test.mjs",` add:

```json
    "review:areas": "node scripts/review-areas.mjs",
    "test:review-areas": "node --test scripts/review-areas.test.mjs",
```

- [ ] **Step 7: Run the tests and see the map tests fail only on missing checklists**

Run: `node --test scripts/review-areas.test.mjs`
Expected: every test passes except `every area has a checklist file that exists`, which fails with `money: missing docs/review/money.md` (the checklists come in Task 2). If `every path regex matches at least one tracked file` fails, a path in `areas.json` is wrong: fix the regex against `git ls-files`, do not delete the test.

- [ ] **Step 8: Commit**

```bash
git add scripts/review-areas.test.mjs scripts/lib/review-areas.mjs scripts/review-areas.mjs docs/review/areas.json package.json
git commit -m "feat(review): map changed files to sensitive review areas"
```

---

### Task 2: The checklists

**Files:**
- Create: `docs/review/README.md`, `docs/review/general.md`, `docs/review/money.md`, `docs/review/access.md`, `docs/review/schema.md`, `docs/review/dispatch.md`, `docs/review/edge-functions.md`, `docs/review/native.md`

Each item says what to check and how to prove it. The source of every item is a section of `CLAUDE.md`, named in parentheses, so a reviewer can read the full story.

- [ ] **Step 1: Write `docs/review/README.md`**

```markdown
# Review areas and checklists

One definition of what is sensitive in TriciGo, read by every reviewer:

- the Claude reviewer agents the author runs before asking for a review,
- the local cross-review by Codex before the PR,
- the Codex review bot on GitHub (through the summary in the root `AGENTS.md`).

## Which checklists apply to a change

    pnpm review:areas                       # this branch against origin/master
    node scripts/review-areas.mjs --json    # machine output

The map is `areas.json`: path regexes plus words of migration file names
(`00637_wallet_shortfall_pays_cash.sql` is money because of `wallet` and `cash`). Docs and test files
never count. `general.md` applies to every PR.

## Changing the map

Edit `areas.json` and run `pnpm test:review-areas`. The tests fail when a path regex matches no
tracked file (a typo or a renamed folder) or a checklist file is missing. A new area needs its
checklist file in the same PR.

## Writing a checklist item

Each item is a check and a way to prove it: a command, a query or a test. "Looks fine" is not a
proof. When a bug teaches something new, add the item in the PR that fixes it, with the CLAUDE.md
section or PR that tells the story.

## Severity

- **P0**: breaks use, operations or data broadly (money lost or created, rides stuck for
  everyone, data of one user readable by others).
- **P1**: must be fixed before merging (security hole, data loss, regression, acceptance not met,
  a change without tests that needed them).
- **P2**: should be fixed, does not block.
- **P3**: minor improvement.
```

- [ ] **Step 2: Write `docs/review/general.md`**

```markdown
# General checklist (every PR)

- [ ] **Tests prove the change.** A test fails without the change and passes with it. A test that
  only renders or only calls the function without asserting the behaviour does not count.
  Prove: revert the change locally, run the test, see it fail.
- [ ] **Cases outside the author's list.** Empty, null, the first and the last item, a second tap,
  no network, an expired session. Prove: run at least one yourself.
- [ ] **"The previous PR changed X and forgot Y".** After renaming or swapping anything (a column,
  an account type, an i18n key, an RPC), every old use is gone. Prove: `git grep -n "<old name>"`
  returns nothing outside history and comments. (CLAUDE.md: "Patrón PR previo cambió X pero olvidó Y")
- [ ] **Read the maintained field, not the legacy one.** When two fields hold the same fact, the
  code reads the one something keeps updated. (CLAUDE.md: "Patrón stale precomputed field")
- [ ] **Turning something on that was off.** When a fix makes a dead path run, every place that
  stops, clears or disables it is checked. Prove: `git grep` of the matching `stop*`, `disable*`,
  `clear*`. (CLAUDE.md: "Un no-op se vuelve regresión cuando el fix lo hace real")
- [ ] **Data is fresh.** A screen that loads once on mount also refreshes when it matters (focus,
  reconnect, app back to foreground). (CLAUDE.md: "Auditoría de frescura de datos")
- [ ] **Errors are honest.** A known server answer is not shown as a generic failure (for example
  `ride_already_closed` is a success). Nothing is swallowed silently where the user needs to act.
  (CLAUDE.md: "`ride_already_closed` NO es un fallo")
- [ ] **The right surface.** The change is in the app, panel or function the bug was seen in, and
  it is verified there. (CLAUDE.md: "Verificar la superficie correcta")
- [ ] **i18n.** New user text goes through i18n in every locale; `pnpm check:i18n` passes. Spanish
  copy is neutral Cuban Spanish.
- [ ] **No secret and no real personal data** in the diff, tests, fixtures or PR text. The
  repository is public. (CLAUDE.md: "Credenciales en el repo: es PÚBLICO")
- [ ] **Scope.** The PR does what it says and nothing else; unrelated refactors go to their own PR.
```

- [ ] **Step 3: Write `docs/review/money.md`**

```markdown
# Money checklist: wallet, payments, fares, promotions, gifts, bonuses, referrals

- [ ] **Money moves only through server RPCs that write the ledger.** No client write decides an
  amount, a share or a payment state. Prove: as an authenticated test user, try the direct
  PostgREST write in a rolled-back block and see it refused. (CLAUDE.md: "Escrituras directas de
  clientes que decidían dinero o una revisión")
- [ ] **Never `UPDATE wallet_accounts.balance`.** Balances change through `ledger_entries` (the USD
  anchor trigger lives there) or `admin_adjust_wallet`. Prove: `git grep -n "wallet_accounts"` in
  the diff shows no direct balance update. (CLAUDE.md: "Ajustar saldo de wallet")
- [ ] **Idempotent and race-safe.** A double tap, a retried request or a webhook delivered twice
  pays once. The row is claimed atomically (`UPDATE ... WHERE status IN (...) RETURNING`), and the
  claim allows the legitimate transitions (`failed → paid`). Prove: call it twice in a test or in
  a rolled-back block. (CLAUDE.md: "NETOPIA webhook: el atomic claim")
- [ ] **Only the server writes payment intents.** Clients never insert or update
  `payment_intents`; a refund without balance is recorded, not lost. (CLAUDE.md: "Recargas NETOPIA")
- [ ] **Fares are computed by the server.** The fare a client declares, promos, referrals and gifts
  are checked or recomputed on the server; stops are quoted as a direct fare plus the server's
  surcharge. (CLAUDE.md: "Tarifa declarada por el cliente, promos, referidos y regalos";
  "Paradas")
- [ ] **One bonus per person.** Signup, referral, apology and approval bonuses are tied to the
  confirmed phone and cannot be claimed twice by recreating an account. (CLAUDE.md: "Bonos de una vez
  por persona")
- [ ] **Shortfall and corporate paths.** A ride whose wallet does not cover the fare is charged in
  cash; corporate rides skip the personal wallet check and charge the company the server's fare.
  (CLAUDE.md: "Un viaje con billetera que no alcanza se cobra en efectivo")
- [ ] **Commission is always booked.** Completing a ride, cash included, leaves its ledger rows.
  Prove: complete a test ride in a rolled-back block and count the ledger rows.
- [ ] **Currency and rounding.** Amounts are CUP integers where the schema says so; display uses
  `formatCUP`; conversions read the current exchange rate, never a constant.
- [ ] **Every validation of a promo code is logged** and failures do not reveal whether a code
  exists for another account. (CLAUDE.md: "Cada validación de un código de promoción queda registrada")
- [ ] **Abuse case written down.** The PR says how someone would try to get money they should not
  (self-referral, collusion, test accounts, replay) and why it fails.
```

- [ ] **Step 4: Write `docs/review/access.md`**

```markdown
# Access checklist: auth, RLS, GRANTs, RPC exposure, roles, secrets, paths to production

- [ ] **Every new table in `public` has RLS and explicit GRANTs** (Data API change of 2026-10-30).
  `pnpm check:migration-grants` passes. (CLAUDE.md: "Tablas nuevas en public: GRANT explícito")
- [ ] **SECURITY DEFINER functions skip RLS.** Each one checks the caller inside (`auth.uid()`,
  role), sets `search_path`, and `anon` cannot execute it unless that is the point. When a policy
  hides rows, look for SECURITY DEFINER functions that read the same table. Prove: the
  `has_function_privilege('anon', ...)` query of CLAUDE.md. (CLAUDE.md: "Una función SECURITY
  DEFINER se salta la RLS de la tabla que lee")
- [ ] **REVOKEs are verified in production, not assumed** from the migration file. (CLAUDE.md:
  "Los REVOKE de una migración de lockdown se verifican en prod")
- [ ] **What one person can read of another** stays limited: phone, plate, location, ratings.
  Prove: as a second authenticated test user, the read returns 200 with an empty list (an HTTP
  error does not prove the policy). (CLAUDE.md: "Lo que una persona puede leer de otra"; "Patentes
  de los vehículos")
- [ ] **Object ownership is checked on the server** for every RPC or function that takes an id
  (ride, wallet, document, ticket). The panel hiding a button is not a check.
- [ ] **Roles of the admin panel.** A new page or action is gated in `apps/admin/src/middleware.ts`
  and in the RPC, for every role (`admin`, `marketing`, `operator`). (CLAUDE.md: "Panel admin:
  middleware, dinero y notificaciones"; "Rol `operator`")
- [ ] **Login never changes another account's session**, does not rotate passwords on each login,
  and respects the daily and per-number code limits. (CLAUDE.md: "Login en una app deslogueaba la
  otra"; "Enlaces de login"; "Códigos de login: topes")
- [ ] **Text from users inside HTML, `<script>` or a redirect is escaped** (`htmlSafety`).
  (CLAUDE.md: "Texto ajeno dentro de HTML")
- [ ] **Workflows and ops.** A workflow change keeps pinned actions, read-only token by default,
  free text through `env:` (never `${{ }}` inside `run:`), and a new job on the self-hosted runner
  is added to `GATE_WORKFLOWS`. (CLAUDE.md: "Deploy web/admin: self-hosted runner"; "Cadena de
  suministro de CI")
- [ ] **No secret in the diff.** Names of variables only, never values; a real value found in code
  is moved out and the key rotated. The repository is public.
```

- [ ] **Step 5: Write `docs/review/schema.md`**

```markdown
# Schema checklist: every migration

- [ ] **The number is free.** No other open PR or branch uses it. (CLAUDE.md: "Pre-flight para
  elegir número de migración")
- [ ] **An applied migration is never edited.** A fix is a new migration.
- [ ] **`CREATE OR REPLACE FUNCTION` starts from the live body.** The last version in production,
  not an older file, so no feature is lost. Prove: compare with `pg_get_functiondef` read from
  production. (CLAUDE.md: "Cadenas de `CREATE OR REPLACE FUNCTION`")
- [ ] **Idempotent.** Running it twice gives the same result (`IF NOT EXISTS`, `CREATE OR REPLACE`,
  guarded `INSERT`). The rehearsal applies it twice.
- [ ] **Rehearsed.** `supabase/tests/<number>/` has a scaffold and assertions that fail without
  the migration.
- [ ] **plpgsql traps avoided:** `RAISE EXCEPTION 'text' USING MESSAGE`, `make_interval` with a
  NUMERIC, a RECORD variable shadowing an alias, `COALESCE(<enum>, 'text')`, `RETURNING ... INTO`
  with two or more rows. (CLAUDE.md: the five "Trampa plpgsql" sections)
- [ ] **Cron functions:** no `EXCEPTION WHEN OTHERS` around the whole body; calls to Edge Functions
  go through `public.cron_http_post`, never `net.http_post` directly. (CLAUDE.md: "Una función de
  cron no atrapa sus propios errores"; "`pg_cron` + `net.http_post` es CIEGO")
- [ ] **Heavy changes are split.** Big backfills, `ADD COLUMN` with a default on a large table and
  new indexes on large tables are planned for the MCP limits and do not lock the apps. (CLAUDE.md:
  "Aplicar migraciones pesadas por MCP")
- [ ] **History tables have retention.** A table that grows on every event has a cleanup job.
  (CLAUDE.md: "La base colapsó por dos tablas de historial sin retención")
- [ ] **The code tolerates the migration not being applied yet.** The app keeps working until it is
  applied by hand. (CLAUDE.md: "MCP migration guard")
- [ ] **Applied with the file name.** `apply_migration` uses the file name without `.sql` as its
  name, so the registry matches the files.
- [ ] **SQL text seen by users** follows the copy rules (no voseo); the CI guard passes.
  (CLAUDE.md: "Tuteo en el texto que sale de SQL")
```

- [ ] **Step 6: Write `docs/review/dispatch.md`**

```markdown
# Dispatch checklist: ride state, offers, matching, presence, the live trip

- [ ] **A ride changes state, fare and times only through its RPCs.** No raw UPDATE of `rides` by
  the rider or the driver; the transition rules hold for every path. Prove: try the raw PostgREST
  update in a rolled-back block. (CLAUDE.md: "Un viaje cambia de estado, tarifa y horas solo por sus RPC")
- [ ] **Races.** Two drivers accepting, a driver accepting while the rider cancels, a retry after a
  timeout: one wins, the other gets a clear answer. Rows are locked (`FOR UPDATE`) where two paths
  meet. Prove: a test or a two-session rehearsal.
- [ ] **Terminal states are final** and `ride_already_closed` is treated as success by every
  caller. (CLAUDE.md: "`ride_already_closed` NO es un fallo")
- [ ] **Connection loss.** A driver or rider who loses signal comes back to the same ride; a ride
  released by silence goes back to its driver when he reappears; the app recovers the active ride
  at startup even if the first lookup fails. (CLAUDE.md: "Un viaje liberado por silencio vuelve a
  su conductor"; "Viaje que desaparece al reabrir la app del pasajero")
- [ ] **Offers reach the driver by both channels** (Realtime and push), and a missing permission
  degrades instead of breaking. (CLAUDE.md: "Auto-launch de oferta en el conductor: 2 canales")
- [ ] **Test accounts stay out of real dispatch.** (CLAUDE.md: "Cuentas de prueba aisladas del despacho")
- [ ] **Timers and deadlines live on the server** when they decide something (search deadline,
  stale ride cancellation), not only in the app. (CLAUDE.md: "La búsqueda NO tiene deadline en el servidor")
- [ ] **Realtime channels:** a new channel that carries private data is private. (CLAUDE.md:
  "Canales de Realtime: cuáles son privados")
- [ ] **Location and GPS gates** (arrival fence, waiting charge, trail) cannot be skipped by a
  client write. (CLAUDE.md: "Rastro GPS del viaje y cargo por espera")
- [ ] **The other apps stay in step.** Client, driver, web tracking and admin show the same state;
  a change in one is checked in the others. (CLAUDE.md: "Checklist de paridad cross-app")
```

- [ ] **Step 7: Write `docs/review/edge-functions.md`**

```markdown
# Edge Functions checklist

- [ ] **The function decides who is calling.** `verify_jwt=true` only proves there is some
  session; anyone gets one with an OTP. The function checks the caller and the object inside.
  (CLAUDE.md: "Edge Functions: quién puede llamarlas")
- [ ] **`verify_jwt` in `supabase/config.toml`** matches the intent of the function.
- [ ] **Rate limits are counted after auth**, not per IP before it (triggers and crons share one IP).
- [ ] **Imports are pinned**; `pnpm check:ef-imports` and `pnpm check:ef-types` pass.
- [ ] **Mirrored helpers stay in sync.** When a dataset or helper is duplicated from
  `@tricigo/utils`, both copies change together. (CLAUDE.md: "Mirror EF helpers")
- [ ] **CORS:** `admin.tricigo.com` and the other real origins are in `ALLOWED_ORIGINS` when the
  panel calls the function. (CLAUDE.md: "`admin.tricigo.com` debe estar en `ALLOWED_ORIGINS`")
- [ ] **Service role use is narrow.** The service-role client is used only for what the caller is
  allowed to do, after the check.
- [ ] **Webhooks verify the provider's signature** and are idempotent.
- [ ] **Failures are visible.** Errors are logged without personal data, and a cron caller can see
  the HTTP result (`cron_http_post`).
- [ ] **Deployed on purpose.** The PR says which functions must be deployed and in what order with
  the migrations they need.
```

- [ ] **Step 8: Write `docs/review/native.md`**

```markdown
# Native checklist: store build vs OTA

Both apps use `runtimeVersion: { policy: "appVersion" }`: an OTA reaches every installed binary of
the same `expo.version`.

- [ ] **Store build or OTA.** A change to native code, config plugins, `app.json` native fields,
  permissions or a dependency with native code needs a version bump and a store build. A JS-only
  change can go by OTA. The PR states which, and why.
- [ ] **A native change without a version bump is a P0**: an OTA would send JS that calls native
  code the installed apps do not have.
- [ ] **Built from Linux.** Store builds and OTAs come from the GitHub workflows, not from a
  Windows checkout. (header of `.github/workflows/eas-update.yml`)
- [ ] **Startup order.** Nothing renders `useTranslation` or reads stores before their init; a crash
  at startup cannot be fixed by OTA for users who cannot open the app. (CLAUDE.md: "Un
  `useTranslation` que se renderiza antes de `initI18n` tira la app")
- [ ] **Android permissions** (overlay, background location, notifications) degrade gracefully when
  denied, and Xiaomi/Redmi/POCO extra permissions are considered.
- [ ] **Low-end phones and bad networks:** heavy lists, maps and images are measured on a modest
  Android; requests have timeouts; offline paths work.
- [ ] **Layout on device.** `Pressable` style functions and NativeWind class order behave as
  expected on a real phone, not only in a test. (CLAUDE.md: "Una función-estilo de `Pressable`";
  "Un `Card` no se tiñe por `className`")
- [ ] **Deep links** keep working: the intent filter `pathPrefix` matches an internal route.
  (CLAUDE.md: "Universal links + Expo Router")
```

- [ ] **Step 9: Run the tests and see them all pass**

Run: `node --test scripts/review-areas.test.mjs`
Expected: PASS, every test (the checklist files now exist).

- [ ] **Step 10: Commit**

```bash
git add docs/review
git commit -m "docs(review): one checklist per sensitive area"
```

---

### Task 3: PR template

**Files:**
- Create: `.github/pull_request_template.md`

Part 2 adds a CI check that reads these headings. Keep them exactly as written.

- [ ] **Step 1: Write the template**

````markdown
<!--
The repository is public: no secret, token, signed URL or real personal data in this PR.
List the review areas with `pnpm review:areas` and read their checklists in docs/review/.
-->

## What changes

<!-- The effect for riders, drivers or the team, in one or two sentences. Not the file list. -->

## Why

<!-- The bug seen, the request, or the decision this closes. Link the issue, spec or plan. -->

## How it was validated

<!-- Commands you ran and what came out. Paste the relevant output, not the whole suite. -->

```
```

## Tests

<!-- The tests added or changed and what each one proves. If there are none, one line:
No tests because: <reason> -->

## Review areas

<!-- Paste the output of `pnpm review:areas`. -->

```
```

## Cross-review

<!-- When any review area is touched: the verdict line printed by the cross-review,
Cross-review: <APPROVED|APPROVED_WITH_RESERVATIONS|FIX_CONFIRMED> <work-id> <sha>
plus the reservations accepted. Otherwise: Not required, no review area touched. -->

## Native and OTA

- [ ] JavaScript only: can ship by OTA
- [ ] Needs a store build: `expo.version` bumped in the app's `app.json`
- [ ] Does not touch the mobile apps

## Migrations

<!-- For each migration: applied in production or not yet, and how the code behaves until it is.
Otherwise: None. -->

## Final check

- [ ] No secret, `.env`, token or real personal data in the diff or in this text
- [ ] Docs updated where the behaviour changed (CLAUDE.md section, spec or runbook)
````

- [ ] **Step 2: Commit**

```bash
git add .github/pull_request_template.md
git commit -m "docs(github): PR template that asks for validation, tests and review areas"
```

---

### Task 4: Root `AGENTS.md` with the review guidelines

**Files:**
- Create: `AGENTS.md`

The main checkout (`C:\Users\Eduardo\TriciGo`) has an **untracked** 1510-line `AGENTS.md` from July, an old copy of CLAUDE.md. It is not this file and must not be committed. Once this PR is merged, updating that checkout will refuse to overwrite it: Eduardo renames it first (for example to `AGENTS.old.md`).

- [ ] **Step 1: Write `AGENTS.md`**

```markdown
# TriciGo: instructions for Codex

TriciGo is a ride-hailing platform for Cuba: rider app (`apps/client`) and driver app
(`apps/driver`) in Expo, web (`apps/web`) and admin panel (`apps/admin`) in Next.js, shared code in
`packages/`, and Supabase (Postgres, RLS, RPCs, Edge Functions in `supabase/functions`,
migrations in `supabase/migrations`).

The working rules, verified incidents and patterns live in `CLAUDE.md` (in Spanish). Read the
sections it names before changing an area. Code, comments, commits and technical docs are in
English; text for users is neutral Cuban Spanish through i18n.

Validation commands: `pnpm lint`, `pnpm check-types`, `pnpm test`, `pnpm check:i18n`,
`pnpm check:ef-imports`, `pnpm check:ef-types`, `pnpm check:migration-grants`.
Never run `supabase db push`: it would re-run old migrations against production.

## Review guidelines

These guide the automatic Codex review of every pull request.

- Find which areas a PR touches with `node scripts/review-areas.mjs --base origin/master` (or from
  the paths: see `docs/review/areas.json`) and review against `docs/review/general.md` plus the
  checklist of each touched area in `docs/review/`.
- **Tests come with the change.** Code without a test that fails without it is a finding, unless
  the PR has a line `No tests because:` with a real reason.
- **Money** moves only through server RPCs that write `ledger_entries`; never a direct update of
  `wallet_accounts.balance`; payments, webhooks and bonuses are idempotent and claim rows
  atomically; fares, promos, referrals and gifts are decided by the server.
- **Access:** every new table has RLS and explicit GRANTs; SECURITY DEFINER functions check the
  caller, set `search_path` and are not executable by `anon` unless intended; RPCs and Edge
  Functions check ownership of the object they receive; `verify_jwt=true` alone is not an
  authorization check.
- **Rides** change state, fare and times only through their RPCs; concurrent paths lock the row;
  `ride_already_closed` is a success for the caller.
- **Migrations** are never edited once on `master`; a `CREATE OR REPLACE FUNCTION` starts from the
  live body; they run twice without harm; cron functions do not wrap their whole body in
  `EXCEPTION WHEN OTHERS` and call Edge Functions through `public.cron_http_post`; the app
  tolerates a migration that is not applied yet.
- **Mobile:** both apps use `runtimeVersion` policy `appVersion`; a native change (config plugins,
  native modules, native dependencies, permissions) without an `expo.version` bump is a P0,
  because an OTA would reach binaries without that native code.
- **Public repository:** any secret or real personal data in the diff is a P0.
- Report problems introduced or exposed by the PR, each with the file and line and the scenario
  that breaks. Do not report style or what lint and CI already enforce.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md with the review guidelines for Codex"
```

---

### Task 5: CLAUDE.md — stack lines, method and the two new rules

**Files:**
- Modify: `CLAUDE.md` (section "Stack", lines 10 to 19; section "Reglas de calidad", after line 99)

CLAUDE.md is in Spanish; keep it that way.

- [ ] **Step 1: Fix the stale stack lines**

Replace:

```markdown
- **Framework:** Next.js 14 (App Router)
```

with:

```markdown
- **Framework:** Next.js (App Router) en `apps/web` y `apps/admin`; Expo / React Native en `apps/client` y `apps/driver`
```

and replace:

```markdown
- **Deploy:** Vercel
```

with:

```markdown
- **Deploy:** web y admin en el VPS (PM2, por el runner self-hosted, ver "Operación: deploys, migraciones y merges"); apps por EAS (tiendas y OTA)
```

- [ ] **Step 2: Add the method section after "Reglas de calidad"**

Insert after the line `- NUNCA digas "listo" sin haber verificado con evidencia (tests pasando, build exitoso, screenshot)`:

```markdown

## Método de trabajo y revisión de PRs

Diseño completo y entregas pendientes: `docs/superpowers/specs/2026-11-20-pr-validators-and-promotion-design.md`.

1. **Rama y worktree propios** desde `origin/master`, nunca sobre el checkout principal.
2. **Plan antes de código** en `docs/superpowers/plans/` cuando la tarea no es trivial.
3. **Pruebas con cada cambio:** una prueba que falla sin el cambio y pasa con él. Una migración trae su ensayo en `supabase/tests/<número>/`. Sin pruebas solo con una línea `No tests because: <motivo>` en el PR, y el motivo lo juzgan los revisores.
4. **Zonas sensibles:** `pnpm review:areas` dice qué zonas toca la rama; leer `docs/review/general.md` y la lista de cada zona antes de abrir el PR, y comprobar cada punto con su prueba.
5. **PR con la plantilla completa** (`.github/pull_request_template.md`): cómo se validó con la salida, pruebas, zonas, impacto nativo/OTA y estado de las migraciones.
6. **Bot de Codex en GitHub:** revisa cada PR. Un hilo suyo **no se resuelve sin arreglo** o sin el OK explícito de Eduardo para ese hilo.
7. **Merge con OK por PR** (ver "Merges a `master` requieren autorización explícita por PR").

**`apply_migration` usa como nombre el nombre del archivo sin `.sql`** (por ejemplo `00691_driver_approval_bonus`). Así el registro de producción coincide con los archivos y se puede saber qué falta aplicar. Al 2026-11-20, 11 archivos desde la `00600` no tienen entrada con su número en el registro (`00617`, `00618`, `00620`, `00623`, `00626`, `00637`, `00648`, `00653`, `00654`, `00664`, `00666`): se aplicaron por otra vía o no se aplicaron, y se concilian antes de la promoción manual.
```

- [ ] **Step 3: Check the edit landed once**

Run: `git grep -n "Método de trabajo y revisión de PRs" CLAUDE.md` and `git grep -n "Deploy:\*\* Vercel" CLAUDE.md`
Expected: one line for the first, nothing for the second.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): work method, review areas and migration naming rule"
```

---

### Task 6: Validate, then ask before push and PR

- [ ] **Step 1: Full test run of this part**

Run: `node --test scripts/review-areas.test.mjs > "$TEMP/review-areas.txt" 2>&1; echo "exit=$?"; tail -n 12 "$TEMP/review-areas.txt"`
Expected: `exit=0`, `# fail 0`. Do not pipe the test command itself: a pipe hides its exit code.

- [ ] **Step 2: Run the existing guards that read these files**

Run: `node scripts/check-i18n-parity.mjs; echo "exit=$?"` and `node --test scripts/check-migration-grants.test.mjs > "$TEMP/grants.txt" 2>&1; echo "exit=$?"`
Expected: `exit=0` for both (nothing in this PR should change them).

- [ ] **Step 3: Run the CLI on this branch**

Run: `node scripts/review-areas.mjs --base origin/master`
Expected: `No sensitive area touched.` (this PR changes scripts, docs, the PR template, `AGENTS.md`, `CLAUDE.md` and `package.json`, none of them in an area).

- [ ] **Step 4: Ask Eduardo before pushing and opening the PR**

Push and PR need his explicit OK for this action. The PR body uses the new template, with the
outputs of steps 1 to 3 pasted under "How it was validated".

- [ ] **Step 5: Owner action after the merge: turn on the Codex bot**

Eduardo, in Codex (chatgpt.com/codex) with the ChatGPT account connected to GitHub: set up the
repository `AgenciaSeniors/TriciGo` as a Codex environment, open the code review settings, turn
on code review for the repository and then automatic reviews. Check: the next PR gets a Codex
review without anyone asking. If the plan does not offer automatic reviews, a comment
`@codex review` on each PR does the same by hand.
