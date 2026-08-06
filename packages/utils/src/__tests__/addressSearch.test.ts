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
  historyMatchesQuery,
  isProviderStreetResult,
  filterProviderStreetsByLocalAnchor,
  LOCAL_STREET_TRUST_RADIUS_M,
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

describe('historyMatchesQuery', () => {
  // Realistic recents for a Havana rider. Almost every Cuban address
  // contains "Calle", which is exactly what made the old plain
  // fuzzyMatch(query, fullAddress) flood the list.
  const RECENTS = [
    'Calle 23 e/ L y M, Plaza de la Revolución, La Habana',
    'Avenida de los Presidentes e/ 25 y 27, Plaza de la Revolución',
    'Calzada de Infanta e/ Neptuno y San Miguel, Centro Habana',
    'Calle 10 e/ 3ra y 5ta, Playa, La Habana',
    'Hotel Nacional de Cuba, Calle O e/ 21 y 23, Vedado',
  ];

  it('does not let a generic address word match an address that merely contains it', () => {
    // The old plain fuzzyMatch(query, fullAddress) matched 4 of these 5 on
    // "cal" — including "Hotel Nacional de Cuba, Calle O …", which contains
    // "Calle" halfway through. A generic word now only reaches addresses that
    // literally BEGIN with what was typed, so that one drops out.
    expect(historyMatchesQuery('cal', 'Hotel Nacional de Cuba, Calle O e/ 21 y 23, Vedado')).toBe(false);
    expect(historyMatchesQuery('calle', 'Hotel Nacional de Cuba, Calle O e/ 21 y 23, Vedado')).toBe(false);
    // And it never reaches an address with no "cal" at the front at all.
    expect(historyMatchesQuery('cal', RECENTS[1]!)).toBe(false);

    // Net effect on the realistic set: fewer rows compete for the slots.
    expect(RECENTS.filter((r) => historyMatchesQuery('cal', r)).length).toBeLessThan(4);
  });

  it('still matches when the query carries something distinctive', () => {
    expect(historyMatchesQuery('calle 23', RECENTS[0]!)).toBe(true);
    expect(historyMatchesQuery('23', RECENTS[0]!)).toBe(true);
    expect(historyMatchesQuery('presidentes', RECENTS[1]!)).toBe(true);
    expect(historyMatchesQuery('infanta', RECENTS[2]!)).toBe(true);
    expect(historyMatchesQuery('nacional', RECENTS[4]!)).toBe(true);
  });

  it('matches a generic-only query when the address literally starts with it', () => {
    // "calle 10" is generic+distinctive, but a bare "calzada" should still
    // reach an address that begins with it rather than one that merely
    // mentions it further along.
    expect(historyMatchesQuery('calzada', 'Calzada de Infanta e/ Neptuno')).toBe(true);
    expect(historyMatchesQuery('calzada', 'Calle 5 e/ Calzada y A, Vedado')).toBe(false);
  });

  it('tolerates missing accents and typos on the distinctive part', () => {
    expect(historyMatchesQuery('revolucion', RECENTS[0]!)).toBe(true);
    expect(historyMatchesQuery('presidenes', RECENTS[1]!)).toBe(true);
  });

  it('ignores empty and whitespace queries', () => {
    expect(historyMatchesQuery('', RECENTS[0]!)).toBe(false);
    expect(historyMatchesQuery('   ', RECENTS[0]!)).toBe(false);
  });
});

describe('slot budget for the mobile dropdown', () => {
  // Mirrors the merge in AddressSearchInput.mergedResults: history tiers
  // (priority 1-3) are capped so search results (priority 4) always keep at
  // least 4 of the visible slots. Kept here because the rule is what the
  // measurement was about, and the component itself is not unit-testable.
  const HISTORY_SLOTS = 2;
  function applyBudget<T extends { priority: number }>(deduped: T[], cap: number): T[] {
    const history = deduped.filter((d) => d.priority < 4);
    const search = deduped.filter((d) => d.priority === 4);
    const visible = search.length > 0 ? [...history.slice(0, HISTORY_SLOTS), ...search] : history;
    return visible.slice(0, cap);
  }

  it('leaves at least 4 slots for search results when history floods', () => {
    const deduped = [
      ...Array.from({ length: 5 }, (_, i) => ({ priority: 3, id: `recent${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ priority: 4, id: `search${i}` })),
    ];
    const visible = applyBudget(deduped, 6);
    expect(visible.filter((v) => v.priority === 4).length).toBeGreaterThanOrEqual(4);
    expect(visible.filter((v) => v.priority < 4).length).toBe(HISTORY_SLOTS);
  });

  it('keeps history first so a frequent destination stays reachable', () => {
    const deduped = [
      { priority: 1, id: 'pred' },
      { priority: 3, id: 'recent' },
      { priority: 4, id: 'search' },
    ];
    expect(applyBudget(deduped, 6).map((v) => v.id)).toEqual(['pred', 'recent', 'search']);
  });

  it('shows the full history when there are no search results', () => {
    const deduped = Array.from({ length: 5 }, (_, i) => ({ priority: 3, id: `recent${i}` }));
    expect(applyBudget(deduped, 6)).toHaveLength(5);
  });
});

describe('isProviderStreetResult', () => {
  // Measured against prod (40 common Havana street names through the Google
  // EF): Google returns the WRONG street for 19/40 — "Calle 23" → "Calle 230"
  // 13 km away, "Calle G" → "Calle Gertrudis", "Calle 1" → "Calle 100" — and
  // mis-pins most of the rest. The local street DB row is a real surveyed
  // corner, so for STREET rows the local coordinate must win the dedupe.
  it('flags external street/geocode rows', () => {
    expect(isProviderStreetResult({ source: 'google', matchedCategory: 'route' })).toBe(true);
    expect(isProviderStreetResult({ source: 'google', matchedCategory: 'geocode' })).toBe(true);
    expect(isProviderStreetResult({ source: 'mapbox', matchedCategory: 'street_address' })).toBe(true);
  });

  it('flags an external row with no distinct name (address-only result)', () => {
    expect(isProviderStreetResult({ source: 'google', place_name: '', address: 'Padre Varela, La Habana' })).toBe(true);
    expect(isProviderStreetResult({ source: 'google', place_name: 'Neptuno', address: 'Neptuno' })).toBe(true);
  });

  it('does NOT flag external venues — Google stays authoritative for POIs', () => {
    expect(isProviderStreetResult({
      source: 'google', matchedCategory: 'establishment',
      place_name: 'Hotel Nacional de Cuba', address: 'Calle O, La Habana',
    })).toBe(false);
    expect(isProviderStreetResult({
      source: 'google', matchedCategory: 'bed_and_breakfast',
      place_name: 'B&B San Lazaro', address: '556 San Lazaro',
    })).toBe(false);
  });

  it('never flags local rows regardless of shape', () => {
    expect(isProviderStreetResult({ source: 'supabase', matchedCategory: 'route' })).toBe(false);
    expect(isProviderStreetResult({ source: 'supabase', place_name: '', address: 'Belascoaín' })).toBe(false);
  });
});

describe('searchResultEmoji — Google street types read as streets, not as a bare pin', () => {
  // searchAddressUnified maps Google's matchedCategory into `category`, so a
  // Google street row arrives with category 'route' | 'geocode' |
  // 'street_address' | 'intersection'. Measured against the real mapping:
  // those four are exactly the types where mapExternalCategoryToTricigo
  // returns null, and none of them match RAW_CATEGORY_EMOJI — so before this
  // they fell through every branch to 📍.
  it('gives Google street rows the street emoji', () => {
    expect(searchResultEmoji({ category: 'route', place_name: 'Calle 230', address: 'C. 230, La Habana' })).toBe('🛣️');
    expect(searchResultEmoji({ category: 'geocode', place_name: 'Calle 23', address: 'Calle 23, La Habana' })).toBe('🛣️');
    expect(searchResultEmoji({ category: 'street_address', address: 'San Lázaro 123' })).toBe('🛣️');
  });

  it('a street row with a Cuban cross-street address still reads 🔀', () => {
    expect(searchResultEmoji({ category: 'intersection', address: 'Calle 23 e/ L y M' })).toBe('🔀');
  });

  it('leaves local rows and Google venues exactly as they were', () => {
    // Local street row — unchanged path.
    expect(searchResultEmoji({ category: 'street', address: 'Belascoaín' })).toBe('🛣️');
    // Google venues already resolved via tricigoCategory (lodging -> hotel,
    // restaurant -> restaurant, park -> park, store -> shop). Verified against
    // mapExternalCategoryToTricigo; the street branch must not shadow them.
    expect(searchResultEmoji({ tricigoCategory: 'hotel', category: 'lodging', address: 'x' })).toBe('🏨');
    expect(searchResultEmoji({ tricigoCategory: 'restaurant', category: 'restaurant', address: 'x' })).toBe('🍽️');
    // Generic Google types keep falling back to the Spanish name keyword.
    expect(searchResultEmoji({ category: 'establishment', place_name: 'Museo de la Revolución', address: 'Refugio' })).toBe('🖼️');
    expect(searchResultEmoji({ category: 'point_of_interest', place_name: 'Zzz', address: 'Zzz' })).toBe('📍');
  });
});

describe('filterProviderStreetsByLocalAnchor', () => {
  // Real coordinates from the prod cache measurement:
  //   Calle 23  (local, Vedado):    23.1370, -82.3830
  //   Calle 230 (Google, Nuevo Vedado, its "answer" for "Calle 23"): 23.0902, -82.4852
  //   ~13 km apart.
  const localCalle23 = { latitude: 23.1370, longitude: -82.3830 };
  const googleCalle230 = { latitude: 23.0902, longitude: -82.4852 };
  // A Google row that agrees with the local anchor (~250 m).
  const googleAgrees = { latitude: 23.1387, longitude: -82.3812 };

  it('drops external street rows that land far from the local anchor', () => {
    const kept = filterProviderStreetsByLocalAnchor([googleCalle230], localCalle23);
    expect(kept).toHaveLength(0);
  });

  it('keeps external street rows that agree with the local anchor', () => {
    const kept = filterProviderStreetsByLocalAnchor([googleAgrees], localCalle23);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(googleAgrees);
  });

  it('passes everything through when the local RPC returned nothing', () => {
    // A brand-new street the local street DB does not know: Google is the
    // only signal available, must not be suppressed.
    const kept = filterProviderStreetsByLocalAnchor([googleCalle230, googleAgrees], null);
    expect(kept).toEqual([googleCalle230, googleAgrees]);
  });

  it('empty input returns empty', () => {
    expect(filterProviderStreetsByLocalAnchor([], localCalle23)).toEqual([]);
  });

  it('the trust radius is 3 km', () => {
    // Documents the constant so a future edit is a deliberate choice.
    expect(LOCAL_STREET_TRUST_RADIUS_M).toBe(3000);
  });
});
