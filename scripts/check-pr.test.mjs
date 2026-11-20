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
