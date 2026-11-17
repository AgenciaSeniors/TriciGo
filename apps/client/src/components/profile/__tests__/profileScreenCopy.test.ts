import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@tricigo/i18n';
import { bootI18n } from '../../../lib/i18nStartup';

// The QA round of 2026-11-17 saw Profile mix languages with the phone in
// English: "Saved locations" and "ACCOUNT" in English, "Modo oscuro" and
// "SEGURIDAD" in Spanish. Those keys existed in no locale, so every language
// showed the Spanish defaultValue. Every key the screen uses has to exist in
// es, en and pt.

const LANGUAGES = ['es', 'en', 'pt'] as const;

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

/** Literal `t('key', { ns: '…' })` calls, with the namespace they resolve in. */
function usedKeys(code: string, defaultNs: string): { ns: string; key: string }[] {
  return [...code.matchAll(/\bt\(\s*(['"])([^'"]+)\1\s*(?:,\s*\{([^}]*)\})?/g)].map((m) => ({
    ns: m[3]?.match(/\bns:\s*['"](\w+)['"]/)?.[1] ?? defaultNs,
    key: m[2],
  }));
}

function missing(keys: { ns: string; key: string }[]): string[] {
  return LANGUAGES.flatMap((lng) =>
    keys
      .filter(({ ns, key }) => typeof i18n.getResource(lng, ns, key) !== 'string')
      .map(({ ns, key }) => `${lng} ${ns}:${key}`),
  );
}

const screen = source('../../../../app/(tabs)/profile.tsx');
// Phones render NativeProfileScreen. WebProfileScreen is the Expo web build,
// which is not published.
const nativeScreen = screen.slice(
  screen.indexOf('function NativeProfileScreen'),
  screen.indexOf('export default function ProfileScreen'),
);

beforeAll(() => {
  bootI18n();
});

describe('Profile screen copy', () => {
  it('reads every literal key the screen uses', () => {
    const keys = usedKeys(nativeScreen, 'common').map(({ ns, key }) => `${ns}:${key}`);
    // Guards the extraction itself: an empty list would pass any check.
    expect(keys).toEqual(
      expect.arrayContaining(['common:profile.dark_mode', 'common:profile.section_safety', 'rider:recurring.title']),
    );
  });

  it('has every key of the screen in es, en and pt', () => {
    expect(missing(usedKeys(nativeScreen, 'common'))).toEqual([]);
  });

  it('has every key of the e-mail confirmation row in es, en and pt', () => {
    expect(missing(usedKeys(source('../../EmailConfirmRow.tsx'), 'common'))).toEqual([]);
  });

  it('has the tier badge of every level in es, en and pt', () => {
    const levels = ['bronce', 'plata', 'oro', 'platino', 'diamante'];
    expect(missing(levels.map((level) => ({ ns: 'common', key: `profile.level_${level}` })))).toEqual([]);
  });
});
