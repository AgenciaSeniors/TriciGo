import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS,
  normalizeAddressLabel,
  proximityBucket,
  scoreSearchResult,
  rankSearchResults,
  searchResultCap,
  type ScorableResult,
} from '../addressSearch';

// User standing at the Capitolio, Havana.
const HAVANA = { latitude: 23.1357, longitude: -82.3666 };
// Same name, ~500 km east in Camagüey.
const CAMAGUEY = { latitude: 21.3808, longitude: -77.9169 };
// A few hundred metres from the user.
const NEAR = { latitude: 23.134, longitude: -82.365 };

function result(partial: Partial<ScorableResult>): ScorableResult {
  return {
    place_name: 'Resultado',
    latitude: HAVANA.latitude,
    longitude: HAVANA.longitude,
    source: 'google',
    specificity: 1,
    ...partial,
  };
}

describe('SEARCH_DEBOUNCE_MS', () => {
  it('is a single unified 300ms value', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300);
  });
});

describe('normalizeAddressLabel', () => {
  it('flips "official (alias)" into "alias (official)" so the Cuban alias leads', () => {
    expect(normalizeAddressLabel('Padre Varela (Belascoaín)')).toBe('Belascoaín (Padre Varela)');
  });

  it('leaves a plain street name untouched', () => {
    expect(normalizeAddressLabel('Calle 23')).toBe('Calle 23');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(normalizeAddressLabel('')).toBe('');
  });
});

describe('proximityBucket', () => {
  it('buckets distances the same way the backend search_streets does', () => {
    expect(proximityBucket(1_000)).toBe(0); // <= 25 km
    expect(proximityBucket(50_000)).toBe(1); // <= 100 km
    expect(proximityBucket(200_000)).toBe(2); // <= 300 km
    expect(proximityBucket(400_000)).toBe(3); // > 300 km
  });
});

describe('scoreSearchResult', () => {
  it('ranks an exact name match above a mere substring match', () => {
    const exact = scoreSearchResult(result({ place_name: 'Reina' }), 'reina', HAVANA);
    const substring = scoreSearchResult(result({ place_name: 'Avenida Reina Victoria' }), 'reina', HAVANA);
    expect(exact).toBeGreaterThan(substring);
  });

  it('accent-folds the query so "belascoain" matches "Belascoaín"', () => {
    const accented = scoreSearchResult(result({ place_name: 'Belascoaín' }), 'belascoain', HAVANA);
    const unrelated = scoreSearchResult(result({ place_name: 'Galiano' }), 'belascoain', HAVANA);
    expect(accented).toBeGreaterThan(unrelated);
  });
});

describe('rankSearchResults', () => {
  it('puts a nearby result above a far one even when the far one has a stronger text match', () => {
    const farExact = result({
      place_name: 'Reina',
      latitude: CAMAGUEY.latitude,
      longitude: CAMAGUEY.longitude,
      source: 'google',
    });
    const nearWeak = result({
      place_name: 'Avenida Reina Victoria',
      latitude: NEAR.latitude,
      longitude: NEAR.longitude,
      source: 'supabase',
    });

    const ranked = rankSearchResults([farExact, nearWeak], 'reina', HAVANA);

    expect(ranked[0]).toBe(nearWeak);
    expect(ranked[1]).toBe(farExact);
  });

  it('within the same proximity bucket, the better text match wins', () => {
    const nearExact = result({ place_name: 'Reina', latitude: NEAR.latitude, longitude: NEAR.longitude });
    const nearWeak = result({
      place_name: 'Avenida Reina Victoria',
      latitude: HAVANA.latitude,
      longitude: HAVANA.longitude,
    });

    const ranked = rankSearchResults([nearWeak, nearExact], 'reina', HAVANA);

    expect(ranked[0]).toBe(nearExact);
  });

  it('does not mutate the input array', () => {
    const a = result({ place_name: 'A' });
    const b = result({ place_name: 'B' });
    const input = [a, b];
    rankSearchResults(input, 'a', HAVANA);
    expect(input).toEqual([a, b]);
  });
});

describe('searchResultCap', () => {
  it('returns a wider cap for multi-word queries (more specific intent)', () => {
    expect(searchResultCap('hotel nacional habana')).toBe(8);
  });

  it('returns a tighter cap for short queries to cut noise', () => {
    expect(searchResultCap('rei')).toBe(6);
  });
});

// ~1 km north of the user — a place they ride to often.
const FREQUENT = { latitude: 23.1447, longitude: -82.3666 };

describe('rankSearchResults with a frequent-zone prior', () => {
  it('nudges a result near a frequent zone above an otherwise-equal one', () => {
    const nearFreq = result({ place_name: 'Cafe X', latitude: FREQUENT.latitude, longitude: FREQUENT.longitude });
    const notFreq = result({ place_name: 'Cafe X', latitude: HAVANA.latitude, longitude: HAVANA.longitude });

    const ranked = rankSearchResults([notFreq, nearFreq], 'cafe x', HAVANA, [FREQUENT]);

    expect(ranked[0]).toBe(nearFreq);
  });

  it('does not let the frequent-zone nudge beat a clearly better text match', () => {
    const freqWeak = result({ place_name: 'Avenida Reina Victoria', latitude: FREQUENT.latitude, longitude: FREQUENT.longitude });
    const exactNoFreq = result({ place_name: 'Reina', latitude: HAVANA.latitude, longitude: HAVANA.longitude });

    const ranked = rankSearchResults([freqWeak, exactNoFreq], 'reina', HAVANA, [FREQUENT]);

    expect(ranked[0]).toBe(exactNoFreq);
  });
});
