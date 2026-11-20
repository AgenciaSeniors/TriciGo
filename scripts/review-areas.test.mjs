// Tests for scripts/lib/review-areas.mjs, its CLI scripts/review-areas.mjs, and the real map
// in docs/review/areas.json checked against the real tree:
//   node --test scripts/review-areas.test.mjs     (pnpm test:review-areas)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  areasForChange,
  areasForPaths,
  compileAreas,
  loadAreas,
  migrationWords,
  normalizePath,
  serviceCallsIn,
  servicePathFor,
} from './lib/review-areas.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = loadAreas();
const ids = (paths, map = real) => areasForPaths(paths, map).map((a) => a.id);

// Splits a regex source into one variant per alternative of each flat capturing group
// `( a | b )`: the group is replaced by one alternative, the rest stays as it is.
// Escaped parentheses are literals; character classes are skipped; groups are not nested.
function expandGroups(source) {
  const groups = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
    } else if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '(' && source[i + 1] !== '?') {
      const end = source.indexOf(')', i);
      groups.push({ start: i, end, alts: source.slice(i + 1, end).split('|') });
      i = end;
    }
  }
  const variants = [];
  for (const g of groups) {
    for (const alt of g.alts) {
      variants.push({ alt, source: source.slice(0, g.start) + alt + source.slice(g.end + 1) });
    }
  }
  return variants;
}

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

  test('expandGroups makes one variant per alternative and ignores escaped parentheses', () => {
    assert.deepEqual(
      expandGroups('^a/(x|y)/(p|q)$').map((v) => v.source),
      ['^a/x/(p|q)$', '^a/y/(p|q)$', '^a/(x|y)/p$', '^a/(x|y)/q$'],
    );
    assert.deepEqual(expandGroups('^\\(auth\\)/'), []);
    assert.deepEqual(expandGroups('^(?:a|b)/[(]x$'), []);
  });

  test('migrationWords accepts a letter after the number (00059b_...)', () => {
    assert.deepEqual(migrationWords('supabase/migrations/00059b_wait_charge_in_complete_ride.sql').slice(0, 2), [
      'wait',
      'charge',
    ]);
  });

  test('serviceCallsIn lists every *Service identifier, sorted and unique', () => {
    assert.deepEqual(
      serviceCallsIn('a walletService.getBalance() b caseOpsService.x walletService.y; adminService'),
      ['adminService', 'caseOpsService', 'walletService'],
    );
  });

  test('serviceCallsIn finds a call split across lines (prettier style) and an import', () => {
    assert.deepEqual(serviceCallsIn('await driverService\n      .getVehicle(id)'), ['driverService']);
    assert.deepEqual(serviceCallsIn("import { walletService } from '@tricigo/api';"), ['walletService']);
  });

  test('servicePathFor turns camelCase into the kebab file name', () => {
    assert.equal(servicePathFor('walletService'), 'packages/api/src/services/wallet.service.ts');
    assert.equal(servicePathFor('exchangeRateService'), 'packages/api/src/services/exchange-rate.service.ts');
    assert.equal(servicePathFor('caseOpsService'), 'packages/api/src/services/case-ops.service.ts');
    assert.equal(servicePathFor('adminService'), 'packages/api/src/services/admin.service.ts');
  });

  test('areasForChange: callers inherit the areas of the services they call', () => {
    const toy = compileAreas({
      areas: {
        money: { title: 'M', checklist: 'm.md', paths: ['^packages/api/src/services/wallet\.service\.ts$'] },
        ui: { title: 'U', checklist: 'u.md', paths: ['^src/ui/'] },
      },
    });
    const texts = {
      'src/screen.tsx': 'await walletService.getBalance(); walletService.x(); // mentions otherService',
      'src/ui/panel.tsx': 'walletService.pay()',
      'packages/api/src/services/wallet.service.ts': 'walletService.helper()',
      'src/gone.tsx': null,
    };
    const readText = (path) => (path in texts ? texts[path] : null);
    const result = areasForChange(Object.keys(texts), toy, readText);
    assert.deepEqual(result, [
      {
        id: 'money',
        title: 'M',
        checklist: 'm.md',
        files: ['packages/api/src/services/wallet.service.ts', 'src/screen.tsx', 'src/ui/panel.tsx'],
        via: { 'src/screen.tsx': ['walletService'], 'src/ui/panel.tsx': ['walletService'] },
      },
      { id: 'ui', title: 'U', checklist: 'u.md', files: ['src/ui/panel.tsx'] },
    ]);
  });

  test('every service file exports the identifier its name maps to', () => {
    const files = execFileSync('git', ['ls-files', 'packages/api/src/services'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /^packages\/api\/src\/services\/[^/]+\.service\.ts$/.test(f));
    assert.ok(files.length > 10);
    const config = JSON.parse(readFileSync(join(ROOT, 'docs/review/areas.json'), 'utf8'));
    // validation.service.ts exports plain functions, nothing calls a validationService, and it is
    // in notSensitive. An exemption may never hide a sensitive service (checked below).
    const exempt = ['packages/api/src/services/validation.service.ts'];
    for (const f of exempt) {
      assert.ok(config.notSensitive.includes(f), `${f} is exempt from the naming guard but not in notSensitive`);
    }
    const bad = [];
    for (const f of files.filter((x) => !exempt.includes(x))) {
      const kebab = f.split('/').pop().replace(/\.service\.ts$/, '');
      const id = kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) + 'Service';
      if (servicePathFor(id) !== f) bad.push(f + ': naming rule does not round-trip');
      else if (!readFileSync(join(ROOT, f), 'utf8').includes('export const ' + id)) bad.push(f + ': no "export const ' + id + '"');
    }
    assert.deepEqual(bad, []);
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

  test('tab screens, services, the map itself, dependencies and late migrations', () => {
    const cases = {
      'apps/client/app/(tabs)/wallet.tsx': ['money'],
      'apps/driver/app/(tabs)/earnings.tsx': ['money'],
      'apps/client/app/(tabs)/index.tsx': ['dispatch', 'money'],
      'packages/api/src/services/dispute.service.ts': ['access', 'money'],
      'packages/api/src/services/driver.service.ts': ['access', 'dispatch', 'money'],
      'docs/review/areas.json': ['access'],
      'scripts/lib/review-areas.mjs': ['access'],
      'scripts/review-areas.mjs': ['access'],
      'patches/@expo__dom-webview@55.0.3.patch': ['native'],
      'package.json': ['native'],
      'pnpm-lock.yaml': ['native'],
      'apps/client/react-native.config.js': ['native'],
      'supabase/migrations/00059b_wait_charge_in_complete_ride.sql': ['dispatch', 'money', 'schema'],
      'supabase/migrations/00122_secdef_search_path_hardening.sql': ['access', 'schema'],
      'supabase/migrations/00679_moto_deportiva.sql': ['dispatch', 'schema'],
      'apps/client/app/(tabs)/profile.tsx': [],
    };
    for (const [file, expected] of Object.entries(cases)) {
      assert.deepEqual(ids([file]), expected, file);
    }
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

  test('no regex in areas.json has a literal dot written as a bare "."', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'docs/review/areas.json'), 'utf8'));
    const sources = [
      ...config.ignore,
      ...config.mustClassify,
      ...Object.values(config.areas).flatMap((a) => a.paths),
    ];
    const bare = (source) => {
      let inClass = false;
      for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '\\') i++;
        else if (inClass) inClass = c !== ']';
        else if (c === '[') inClass = true;
        else if (c === '.' && source[i + 1] !== '*' && source[i + 1] !== '+') return true;
      }
      return false;
    };
    assert.equal(bare('^a/b\\.ts$'), false);
    assert.equal(bare('^a/b.ts$'), true);
    assert.equal(bare('^(?!x).*\\.md$'), false);
    assert.deepEqual(sources.filter(bare), []);
  });

  test('every name inside a ( | ) group matches a tracked file', () => {
    const dead = [];
    for (const area of real.areas) {
      for (const re of area.paths) {
        for (const { alt, source } of expandGroups(re.source)) {
          const variant = new RegExp(source);
          if (!tracked.some((f) => variant.test(f))) {
            dead.push(`${area.id}: ${re} alternative "${alt}" matches no tracked file`);
          }
        }
      }
    }
    assert.deepEqual(dead, []);
  });

  test('every tracked file in a mustClassify folder is in an area or in notSensitive', () => {
    const unclassified = tracked.filter(
      (f) =>
        real.mustClassify.some((re) => re.test(f)) &&
        !real.ignore.some((re) => re.test(f)) &&
        !real.notSensitive.has(f) &&
        areasForPaths([f], real).length === 0,
    );
    assert.deepEqual(unclassified, []);
  });

  test('notSensitive lists tracked files, once, that no area matches', () => {
    const config = JSON.parse(readFileSync(join(ROOT, 'docs/review/areas.json'), 'utf8'));
    const list = config.notSensitive ?? [];
    assert.ok(list.length > 0, 'notSensitive is empty');
    assert.equal(new Set(list).size, list.length, 'duplicates in notSensitive');
    const problems = [];
    for (const f of list) {
      if (!tracked.includes(f)) problems.push(`${f}: not a tracked file`);
      const hit = areasForPaths([f], real).map((a) => a.id);
      if (hit.length > 0) problems.push(`${f}: listed as notSensitive but matches ${hit.join(', ')}`);
    }
    assert.deepEqual(problems, []);
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

  const areasOf = (input) => {
    const r = run(input, '--json');
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).areas.map((a) => a.id);
  };

  test('screens inherit the areas of the services they call (real files)', () => {
    const admin = areasOf('apps/admin/src/app/drivers/[id]/page.tsx\n');
    assert.ok(admin.includes('access') && admin.includes('money'), admin.join());
    assert.ok(areasOf('apps/web/src/app/profile/corporate/page.tsx\n').includes('money'));
    assert.ok(areasOf('apps/driver/app/profile/pricing.tsx\n').includes('money'));
  });

  test('review checklists and AGENTS.md are access', () => {
    assert.deepEqual(areasOf('docs/review/money.md\n'), ['access']);
    assert.deepEqual(areasOf('AGENTS.md\n'), ['access']);
  });

  test('NUL-separated stdin works', () => {
    const found = areasOf('apps/client/src/components/DriverInfoMiniCard.tsx\0packages/api/src/services/wallet.service.ts\0');
    assert.ok(found.includes('money'));
  });

  test('a change with no sensitive area says so', () => {
    const r = run('docs/qa/bugs-rondas.md\n');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No sensitive area touched\./);
  });

  const cli = (cwd, ...args) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/review-areas.mjs'), ...args], { cwd, encoding: 'utf8' });

  test('an unknown flag fails closed and names the flag', () => {
    const r = cli(ROOT, '--stdn');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^review-areas: /);
    assert.match(r.stderr, /--stdn/);
  });

  test('an empty or dash-led base is refused and creates nothing', () => {
    for (const args of [['--base', ''], ['--base', '-x'], ['--base=-x'], ['--base=--output=leak']]) {
      const r = cli(ROOT, ...args);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.equal(r.status, 2, args.join(' '));
    }
    const stray = readdirSync(ROOT).filter((n) => n.startsWith('leak') || n.startsWith('-x'));
    assert.deepEqual(stray, []);
  });

  test('git mode with an empty range says no area', () => {
    const r = cli(ROOT, '--base', 'HEAD', '--head', 'HEAD');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No sensitive area touched\./);
  });

  test('CRLF input lines are handled', () => {
    const r = run('packages/api/src/services/wallet.service.ts\r\n', '--json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      JSON.parse(r.stdout).areas.map((a) => a.id),
      ['money'],
    );
  });

  describe('non-ASCII paths in git mode', () => {
    const repo = mkdtempSync(join(tmpdir(), 'review-areas-'));
    after(() => rmSync(repo, { recursive: true, force: true }));

    test('a file with an accent is read as it is, not quoted', () => {
      const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
      mkdirSync(join(repo, 'apps/client/app/wallet'), { recursive: true });
      writeFileSync(join(repo, 'apps/client/app/wallet/recarga-rápida.tsx'), 'x\n');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add');
      const r = cli(repo, '--base', 'HEAD~1', '--head', 'HEAD', '--json');
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        JSON.parse(r.stdout).areas.map((a) => a.id),
        ['money'],
      );
    });
  });
});
