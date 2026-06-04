import { describe, it, expect } from 'vitest';
import {
  SEARCH_DEBOUNCE_MS,
  normalizeAddressLabel,
  proximityBucket,
  scoreSearchResult,
  rankSearchResults,
  searchResultCap,
  searchResultEmoji,
  shouldEnrichResult,
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

describe('searchResultEmoji', () => {
  it('uses the tricigo category emoji when the category is known', () => {
    expect(searchResultEmoji({ tricigoCategory: 'hotel' })).toBe('🏨');
  });

  it('falls back to a name keyword when the category is "other" (Capitolio Nacional → monument)', () => {
    expect(
      searchResultEmoji({ tricigoCategory: 'other', category: 'other', place_name: 'Capitolio Nacional' }),
    ).toBe('🏛️');
  });

  it('gives a road emoji to a plain street and a cross emoji to "X e/ Y"', () => {
    expect(searchResultEmoji({ category: 'street', address: 'Neptuno' })).toBe('🛣️');
    expect(searchResultEmoji({ category: 'street', address: 'Belascoaín e/ San José' })).toBe('🔀');
  });

  it('maps a raw provider category when tricigo is other (public_transport → bus)', () => {
    expect(
      searchResultEmoji({ tricigoCategory: 'other', category: 'public_transport', place_name: 'P-12' }),
    ).toBe('🚌');
  });

  it('maps a raw landmark category to a monument', () => {
    expect(
      searchResultEmoji({ tricigoCategory: 'other', category: 'landmark_and_historical_building', place_name: 'X' }),
    ).toBe('🏛️');
  });

  it('returns the generic pin only when there is no category signal at all', () => {
    expect(searchResultEmoji({ place_name: 'Lugar X', category: '', address: 'una direccion cualquiera' })).toBe('📍');
  });

  it('keeps a POI category emoji when its Cuban address contains "e/" (not the cross-street icon)', () => {
    expect(
      searchResultEmoji({
        tricigoCategory: 'other',
        category: 'opera_and_ballet',
        place_name: 'Teatro Lírico Nacional de Cuba',
        address: 'Zulueta #253 e/ Animas y Neptuno',
      }),
    ).toBe('🎭');
  });

  it('still returns the cross-street icon for a bare "X e/ Y" address with no POI/category signal', () => {
    expect(searchResultEmoji({ address: 'Belascoaín e/ San Lázaro y Ánimas' })).toBe('🔀');
  });
});

describe('shouldEnrichResult', () => {
  // Bug 1b: the background cross-street enrichment rewrites a result's
  // coordinates to a fuzzy intersection point. It must run ONLY for pure
  // street rows, never for POIs — a POI carries a `displayName` but its
  // `.address` is the street line (e.g. "Calle Heredia, …"), which starts
  // with a street prefix and would wrongly pass the prefix heuristic alone.
  it('skips a POI even when its street-style address starts with "Calle"', () => {
    expect(
      shouldEnrichResult({ displayName: 'Hotel Casagranda', address: 'Calle Heredia, Santiago de Cuba' }),
    ).toBe(false);
  });

  it('enriches a pure street row (no POI name) so it snaps to the exact intersection', () => {
    expect(shouldEnrichResult({ address: 'Calle 23' })).toBe(true);
  });

  it('does not enrich an address that already carries cross-streets', () => {
    expect(shouldEnrichResult({ address: 'Reina e/ Galiano y Águila' })).toBe(false);
  });

  it('does not enrich a bare POI name that has no street prefix', () => {
    expect(shouldEnrichResult({ displayName: 'Capitolio', address: 'Capitolio Nacional' })).toBe(false);
  });
});
