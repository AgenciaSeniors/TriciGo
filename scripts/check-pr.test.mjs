// Tests for the PR gate: the git reader (scripts/lib/git-read.mjs), the rules
// (scripts/lib/pr-gate.mjs) and the CLI (scripts/check-pr.mjs) on throwaway repositories.
//   node --test scripts/check-pr.test.mjs     (pnpm test:pr-gate)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedFiles, commitExists, isAncestor, readBlobs } from './lib/git-read.mjs';
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
      const [rename, ...rest] = changedFiles('HEAD~1', 'HEAD');
      assert.deepEqual(rest, []);
      assert.deepEqual(
        { status: rename.status, score: rename.score, oldPath: rename.oldPath, path: rename.path },
        { status: 'R', score: 100, oldPath: 'a/uno.sql', path: 'a/dos.sql' },
      );
      assert.match(rename.oldBlob, /^[0-9a-f]{40}$/);
      assert.equal(rename.newBlob, rename.oldBlob);
      assert.deepEqual(
        changedFiles('HEAD~1', 'HEAD', { renames: false }).map((c) => `${c.status} ${c.path}`).sort(),
        ['A a/dos.sql', 'D a/uno.sql'],
      );
      // A tree before a file: its content is skipped by size, the file after it is still read right.
      assert.deepEqual([...readBlobs('HEAD', ['a', 'a/missing.txt', 'a/ñandú.txt'])], [['a/ñandú.txt', 'hola\n']]);
      assert.throws(() => readBlobs('HEAD', ['a/x\ny.txt']), /line break/);
      assert.equal(isAncestor('HEAD~1', 'HEAD'), true);
      assert.equal(isAncestor('HEAD', 'HEAD~1'), false);
      assert.equal(commitExists('HEAD'), true);
      assert.equal(commitExists('f'.repeat(40)), false);
    } finally {
      process.chdir(cwd);
    }
  });
});

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

  test('deleting a test does not count as adding one', () => {
    const changes = [
      { status: 'M', path: 'apps/web/src/app/page.tsx' },
      { status: 'D', path: 'apps/web/src/__tests__/page.test.tsx' },
    ];
    assert.equal(checkTests(changes, filledBody()).errors.length, 1);
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

  const rename = (extra = {}) => ({
    status: 'R',
    score: 100,
    oldPath: base[1],
    path: 'supabase/migrations/00652_b.sql',
    oldBlob: 'b1',
    newBlob: 'b1',
    ...extra,
  });

  test('a rename passes only with the same blob and inside supabase/migrations/', () => {
    assert.deepEqual(run([rename()]), []);
    // git can score a file whose lines were only reordered as R100: the blob decides.
    assert.equal(run([rename({ newBlob: 'b2' })]).length, 1);
    assert.equal(run([rename({ score: 92, newBlob: 'b2' })]).length, 1);
    assert.match(run([rename({ path: 'supabase/old/00651_b.sql' })])[0], /moves it out of supabase\/migrations/);
  });

  test('two new migrations of the PR may not share a number', () => {
    const errors = run([
      { status: 'A', path: 'supabase/migrations/00700_a.sql' },
      { status: 'A', path: 'supabase/migrations/00700_b.sql' },
    ]);
    assert.match(errors[0], /00700 is used twice in this PR/);
  });

  test('the numbers are checked against master as it is now, not where the branch started', () => {
    const errors = checkMigrations({
      changes: [{ status: 'A', path: 'supabase/migrations/00700_mine.sql' }],
      baseMigrations: base,
      masterMigrations: [...base, 'supabase/migrations/00700_merged.sql'],
      body: filledBody(),
      prNumber: 50,
    }).errors;
    assert.match(errors[0], /already used on master by supabase\/migrations\/00700_merged\.sql/);
  });

  test('a new migration may not reuse a number of master', () => {
    assert.match(run([{ status: 'A', path: 'supabase/migrations/00650_c.sql' }])[0], /already used on master by supabase\/migrations\/00650_a\.sql/);
    assert.deepEqual(run([{ status: 'A', path: 'supabase/migrations/00652_c.sql' }]), []);
  });

  test('a renumbering in the same PR frees the old number', () => {
    assert.deepEqual(
      run([rename({ path: 'supabase/migrations/00653_b.sql' }), { status: 'A', path: 'supabase/migrations/00651_c.sql' }]),
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

  test('a number master took after the branch started fails', () => {
    g('checkout', '-q', '-B', 'stale', 'master');
    write('supabase/migrations/00003_mine.sql', 'select 1;\n');
    write('supabase/tests/00003/run.sh', 'x\n');
    commit('mine');
    g('checkout', '-q', '-B', 'master-with-3', 'master');
    write('supabase/migrations/00003_merged.sql', 'select 1;\n');
    commit('master takes 00003');
    g('checkout', '-q', 'stale');
    const r = gate(filledBody(), 'master-with-3');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /number 00003 is already used on master by supabase\/migrations\/00003_merged\.sql/);
  });

  test('merging master into the PR after the review keeps the verdict valid', () => {
    g('checkout', '-q', '-B', 'reviewed', 'master');
    write('apps/client/src/zz/Pay3.tsx', 'walletService.pay();\n');
    write('apps/client/src/zz/__tests__/Pay3.test.tsx', 'test\n');
    const reviewed = commit('pay3');
    g('checkout', '-q', '-B', 'master-later', 'master');
    write('docs/other.md', 'unrelated\n');
    commit('master moves on');
    g('checkout', '-q', 'reviewed');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-edit', 'master-later');
    const r = gate(filledBody({ 'Cross-review': `Cross-review: APPROVED w1 ${reviewed}` }), 'master-later');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('a file name with a line break stops the gate instead of hiding other files', () => {
    g('checkout', '-q', '-B', 'odd-name', 'master');
    write('apps/client/src/zz/Pay4.tsx', 'walletService.pay();\n');
    commit('pay4');
    // Windows cannot create such a file, so the tree is built with git plumbing.
    const run = (args, input) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8' }).trim();
    const blob = run(['hash-object', '-w', '--stdin'], 'x\n');
    const entries = execFileSync('git', ['ls-tree', '-z', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    const tree = run(['mktree', '-z'], `${entries}100644 blob ${blob}\tA\nB.tsx\0`);
    const odd = run(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit-tree', tree, '-p', 'HEAD', '-m', 'odd name']);
    const file = join(outside, 'body.md');
    writeFileSync(file, filledBody());
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/check-pr.mjs'), '--base', 'master', '--head', odd, '--body-file', file],
      { cwd: repo, encoding: 'utf8', env },
    );
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /line break/);
  });

  test('bad or missing arguments fail closed with exit 2', () => {
    for (const args of [[], ['--base', 'master', '--head', 'HEAD'], ['--base', '-x', '--head', 'HEAD', '--body-file', 'x'], ['--bogus']]) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-pr.mjs'), ...args], { cwd: repo, encoding: 'utf8', env });
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /^check-pr: /);
    }
  });
});
