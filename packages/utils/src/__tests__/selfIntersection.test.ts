import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSelfIntersectionLabel, searchStreetsSupabase } from '../geo';

// R3-09 (QA round 3, 2026-11-20): "23 y 12" listed "12 · 12 e/ Calle 12".
// OSM names the same street "12" on one segment and "Calle 12" on the next,
// so `street_intersections` has rows where a street "crosses" itself, and
// search_streets can pick one as the street's representative.

describe('isSelfIntersectionLabel', () => {
  it('flags a street that crosses itself under another prefix', () => {
    expect(isSelfIntersectionLabel('12 e/ Calle 12')).toBe(true);
    expect(isSelfIntersectionLabel('Calle 23 e/ 23')).toBe(true);
    expect(isSelfIntersectionLabel('Avenida 31 e/ Ave. 31')).toBe(true);
  });

  it('flags it through an alias in parentheses, with or without accents', () => {
    expect(isSelfIntersectionLabel('Padre Varela (Belascoaín) e/ Belascoain')).toBe(true);
  });

  it('ignores the municipality and province after the comma', () => {
    expect(isSelfIntersectionLabel('12 e/ Calle 12, Plaza de la Revolución, La Habana')).toBe(true);
  });

  it('keeps a real corner', () => {
    expect(isSelfIntersectionLabel('12 e/ Zapata')).toBe(false);
    expect(isSelfIntersectionLabel('198 (Calle 12) e/ 397 (Calle 1)')).toBe(false);
    expect(isSelfIntersectionLabel('23-B e/ 23A')).toBe(false);
    expect(isSelfIntersectionLabel('Calle 12 e/ Calle 23 y Calle 21')).toBe(false);
  });

  it('keeps anything that is not a corner', () => {
    expect(isSelfIntersectionLabel('Calle 12')).toBe(false);
    expect(isSelfIntersectionLabel('')).toBe(false);
  });
});

describe('searchStreetsSupabase', () => {
  beforeEach(() => {
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('drops the rows where a street crosses itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { name: '12', address: '12 e/ Calle 12', municipality: 'Plaza de la Revolución', province: 'La Habana', latitude: 23.14, longitude: -82.39 },
      { name: 'Calle 12', address: 'Calle 12 e/ Zapata', municipality: 'Plaza de la Revolución', province: 'La Habana', latitude: 23.13, longitude: -82.4 },
    ]), { status: 200 })));

    const results = await searchStreetsSupabase('12', null, 5);

    expect(results.map((r) => r.place_name)).toEqual(['Calle 12']);
  });
});
