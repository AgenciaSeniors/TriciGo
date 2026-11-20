import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@tricigo/i18n';
import { bootI18n } from '../../lib/i18nStartup';

// Copy found by the emulator test round of 2026-11-17 (docs/qa/bugs-rondas.md).
// Most of it was a key that existed in no locale file, so English and
// Portuguese showed the Spanish defaultValue (R2-12 on the home screen,
// R2-02 and R2-05 on cancellations).

const LANGUAGES = ['es', 'en', 'pt'] as const;

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

function between(code: string, start: string, end?: string): string {
  const from = code.indexOf(start);
  if (from < 0) throw new Error(`"${start}" not found`);
  const to = end ? code.indexOf(end, from) : code.length;
  if (to < 0) throw new Error(`"${end}" not found`);
  return code.slice(from, to);
}

/** Literal `t('key', { ns: '…' })` calls, with the namespace they resolve in. */
function usedKeys(code: string, defaultNs: string): { ns: string; key: string }[] {
  return [...code.matchAll(/\bt\(\s*(['"])([^'"]+)\1\s*(?:,\s*\{([^}]*)\})?/g)].flatMap((m) => {
    const raw = m[2];
    if (!raw) return [];
    const [prefix, rest] = raw.split(':');
    if (rest) return [{ ns: prefix!, key: rest }];
    return [{ ns: m[3]?.match(/\bns:\s*['"](\w+)['"]/)?.[1] ?? defaultNs, key: raw }];
  });
}

/** A key counts when it exists as is or with i18next plural suffixes. */
function exists(lng: string, ns: string, key: string): boolean {
  return ['', '_one', '_other'].some((suffix) => typeof i18n.getResource(lng, ns, key + suffix) === 'string');
}

function missing(keys: { ns: string; key: string }[]): string[] {
  return LANGUAGES.flatMap((lng) =>
    keys.filter(({ ns, key }) => !exists(lng, ns, key)).map(({ ns, key }) => `${lng} ${ns}:${key}`),
  );
}

function tr(lng: string, key: string, options?: Record<string, unknown>): string {
  return i18n.getFixedT(lng, 'rider')(key, options) as string;
}

const home = source('../../../app/(tabs)/index.tsx');
const idleView = between(home, 'function IdleView', 'function isValidCoordinate');
const searchingView = between(home, 'function SearchingView', 'export default function HomeScreen');

beforeAll(() => {
  bootI18n();
});

describe('home screen copy (R2-12)', () => {
  it('reads the keys of the home screen', () => {
    const keys = usedKeys(idleView, 'rider').map(({ ns, key }) => `${ns}:${key}`);
    // Guards the extraction itself: an empty list would pass any check.
    expect(keys).toEqual(
      expect.arrayContaining(['rider:home.balance_label', 'rider:home.where_to_cuban', 'rider:home.recents_label']),
    );
  });

  it('has every key of the home screen in es, en and pt', () => {
    expect(missing(usedKeys(idleView, 'rider'))).toEqual([]);
  });

  it('counts active drivers in singular and plural', () => {
    expect(tr('es', 'home.drivers_active_short', { count: 1 })).toBe('1 conductor activo');
    expect(tr('es', 'home.drivers_active_short', { count: 4 })).toBe('4 conductores activos');
    expect(tr('en', 'home.drivers_active_short', { count: 1 })).toBe('1 active driver');
  });

  it('reads the weather chip in the language of the app', () => {
    expect(tr('en', 'home.weather_a11y', { temp: 29, city: 'La Habana' })).toBe('29 degrees, La Habana');
    expect(tr('pt', 'home.weather_a11y_no_city', { temp: 29 })).toBe('29 graus');
  });
});

describe('searching screen copy (R2-02, R2-03)', () => {
  it('has every key of the searching screen in es, en and pt', () => {
    expect(missing(usedKeys(searchingView, 'rider'))).toEqual([]);
  });

  it('labels the first step with a word that fits a quarter of a small phone', () => {
    for (const lng of LANGUAGES) {
      expect(tr(lng, 'ride.step_searching').length).toBeLessThanOrEqual(9);
    }
  });

  it('does not warn about a cancellation fee that no longer exists', () => {
    for (const lng of LANGUAGES) {
      const msg = tr(lng, 'ride.cancel_search_msg').toLowerCase();
      expect(msg).not.toMatch(/tarifa|fee|taxa|cobr|charge/);
    }
  });
});

describe('cancellation copy (R2-04, R2-05)', () => {
  it('has every key of the cancel sheet in es, en and pt', () => {
    expect(missing(usedKeys(source('../CancelRideSheet.tsx'), 'rider'))).toEqual([]);
  });

  it('does not give a reason for "no penalty" that may be false', () => {
    for (const lng of LANGUAGES) {
      expect(tr(lng, 'ride.cancel_no_penalty')).not.toMatch(/\(|primera|first|primeiro/i);
    }
  });

  it('has every key of the cancellation notices in es, en and pt', () => {
    expect(missing(usedKeys(source('../../hooks/rideStatusEffects.ts'), 'rider'))).toEqual([]);
  });
});

describe('screen reader copy (R2-14)', () => {
  it('says how many stars each rating star is worth', () => {
    expect(tr('es', 'ride.rate_stars', { count: 1 })).toBe('1 estrella');
    expect(tr('es', 'ride.rate_stars', { count: 5 })).toBe('5 estrellas');
    expect(tr('en', 'ride.rate_stars', { count: 1 })).toBe('1 star');
    expect(tr('pt', 'ride.rate_stars', { count: 3 })).toBe('3 estrelas');
  });
});
