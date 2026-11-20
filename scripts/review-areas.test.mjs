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
