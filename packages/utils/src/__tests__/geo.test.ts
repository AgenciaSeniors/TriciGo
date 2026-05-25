import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  haversineDistance,
  estimateRoadDistance,
  estimateDuration,
  calculateTripDuration,
  adjustETAForVehicle,
  HAVANA_PRESETS,
  HAVANA_CENTER,
  fetchRoute,
  clearRouteCache,
  smoothHeading,
  HEADING_SMOOTHING_ALPHA,
  importPoiFromSearch,
  dedupeSearchResults,
  searchAddressGoogle,
  type SearchBoxResult,
} from '../geo';

describe('haversineDistance', () => {
  it('calculates distance between Capitolio and Hotel Nacional (~3.8km)', () => {
    const capitolio = HAVANA_PRESETS.find((p) => p.label === 'Capitolio')!;
    const hotelNacional = HAVANA_PRESETS.find((p) => p.label === 'Hotel Nacional')!;
    const distance = haversineDistance(
      { latitude: capitolio.latitude, longitude: capitolio.longitude },
      { latitude: hotelNacional.latitude, longitude: hotelNacional.longitude },
    );
    // ~3.8 km straight-line distance
    expect(distance).toBeGreaterThan(3000);
    expect(distance).toBeLessThan(5000);
  });

  it('returns 0 for identical points', () => {
    const distance = haversineDistance(HAVANA_CENTER, HAVANA_CENTER);
    expect(distance).toBe(0);
  });

  it('calculates short distance between Parque Central and Capitolio (~200m)', () => {
    const parque = HAVANA_PRESETS.find((p) => p.label === 'Parque Central')!;
    const capitolio = HAVANA_PRESETS.find((p) => p.label === 'Capitolio')!;
    const distance = haversineDistance(
      { latitude: parque.latitude, longitude: parque.longitude },
      { latitude: capitolio.latitude, longitude: capitolio.longitude },
    );
    expect(distance).toBeGreaterThan(50);
    expect(distance).toBeLessThan(500);
  });
});

describe('estimateRoadDistance', () => {
  it('applies 1.3x urban factor', () => {
    expect(estimateRoadDistance(1000)).toBe(1300);
  });

  it('handles zero', () => {
    expect(estimateRoadDistance(0)).toBe(0);
  });

  it('handles large distances', () => {
    expect(estimateRoadDistance(10000)).toBe(13000);
  });
});

describe('estimateDuration', () => {
  it('estimates triciclo duration (~538s for 1300m at 10km/h)', () => {
    const duration = estimateDuration(1300, 'triciclo_basico');
    // 1300m at 10km/h = 1300 / 2.778 m/s = 468s × 1.15 = 538
    expect(duration).toBe(538);
  });

  it('estimates moto duration (~245s for 1300m at 22km/h)', () => {
    const duration = estimateDuration(1300, 'moto_standard');
    // 1300m at 22km/h = 1300 / 6.111 m/s = 212.7s × 1.15 = 245
    expect(duration).toBe(245);
  });

  it('estimates auto duration (~299s for 1300m at 18km/h)', () => {
    const duration = estimateDuration(1300, 'auto_standard');
    // 1300m at 18km/h = 1300 / 5.0 m/s = 260s × 1.15 = 299
    expect(duration).toBe(299);
  });

  it('returns 0 for zero distance', () => {
    expect(estimateDuration(0, 'triciclo_basico')).toBe(0);
  });
});

describe('calculateTripDuration', () => {
  it('returns 0 for zero distance', () => {
    expect(calculateTripDuration(0, 'moto_standard')).toBe(0);
  });

  it('uses urban speed only for short routes (<8km)', () => {
    // 3000m, moto urban = 25 km/h = 6.944 m/s
    // 3000 / 6.944 = 432s × 1.10 = 475.2 → 475
    const duration = calculateTripDuration(3000, 'moto_standard');
    expect(duration).toBe(475);
  });

  it('blends urban + suburban for mid-range routes (8-35km)', () => {
    // 15000m, auto: urban 20 km/h, suburban 35 km/h
    // First 8000m at 5.556 m/s = 1440s
    // Next 7000m at 9.722 m/s = 720s
    // Total = 2160s × 1.10 = 2376
    const duration = calculateTripDuration(15000, 'auto_standard');
    expect(duration).toBe(2376);
  });

  it('uses all three tiers for long intercity routes', () => {
    // 100000m, moto: urban 25, suburban 40, intercity 55
    // First 8000m at 6.944 m/s = 1152s
    // Next 27000m at 11.111 m/s = 2430s
    // Last 65000m at 15.278 m/s = 4254.5s
    // Total = 7836.5s × 1.10 = 8620.2 → 8620
    const duration = calculateTripDuration(100000, 'moto_standard');
    expect(duration).toBe(8620);
  });

  it('falls back to suburban speed for triciclo intercity', () => {
    // 50000m, triciclo: urban 10, suburban 12, intercity null → uses 12
    // First 8000m at 2.778 m/s = 2880s
    // Next 27000m at 3.333 m/s = 8100s
    // Last 15000m at 3.333 m/s = 4500s (fallback to suburban)
    // Total = 15480s × 1.10 = 17028
    const duration = calculateTripDuration(50000, 'triciclo_basico');
    expect(duration).toBe(17028);
  });
});

describe('adjustETAForVehicle', () => {
  it('returns 0 for zero input', () => {
    expect(adjustETAForVehicle(0, 'moto_standard')).toBe(0);
  });

  it('slows down triciclo ETA (25/10 = 2.5x)', () => {
    // raw 300s × (25 / 10) = 750
    expect(adjustETAForVehicle(300, 'triciclo_basico')).toBe(750);
  });

  it('keeps moto ETA unchanged (25/25 = 1.0x)', () => {
    // raw 300s × (25 / 25) = 300
    expect(adjustETAForVehicle(300, 'moto_standard')).toBe(300);
  });

  it('slightly slows auto ETA (25/20 = 1.25x)', () => {
    // raw 300s × (25 / 20) = 375
    expect(adjustETAForVehicle(300, 'auto_standard')).toBe(375);
  });
});

describe('HAVANA_PRESETS', () => {
  it('contains 8 presets', () => {
    expect(HAVANA_PRESETS).toHaveLength(8);
  });

  it('all presets are within Havana bounding box', () => {
    // Havana bounding box: lat 23.0–23.2, lng -82.5–-82.3
    for (const preset of HAVANA_PRESETS) {
      expect(preset.latitude).toBeGreaterThan(23.0);
      expect(preset.latitude).toBeLessThan(23.2);
      expect(preset.longitude).toBeGreaterThan(-82.5);
      expect(preset.longitude).toBeLessThan(-82.3);
    }
  });

  it('all presets have label and address', () => {
    for (const preset of HAVANA_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.address.length).toBeGreaterThan(0);
    }
  });

  it('all presets have unique labels', () => {
    const labels = HAVANA_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('HAVANA_CENTER', () => {
  it('is within Havana', () => {
    expect(HAVANA_CENTER.latitude).toBeGreaterThan(23.0);
    expect(HAVANA_CENTER.latitude).toBeLessThan(23.2);
    expect(HAVANA_CENTER.longitude).toBeGreaterThan(-82.5);
    expect(HAVANA_CENTER.longitude).toBeLessThan(-82.3);
  });
});

/**
 * Regression test for the "stale route on dropoff change" bug:
 * the user reported that going casa → trabajo, then changing trabajo
 * to a nearby hotel (~80m away in Centro Habana), produced the SAME
 * route polyline + the SAME fare estimate. Root cause: routeCacheKey
 * quantized to ~110m precision (toFixed(3)), so the second fetchRoute
 * hit the first cached route. Fix: tighten to ~1m (toFixed(5)).
 *
 * This test mocks the network and asserts that two destinations within
 * ~80m produce two distinct cache entries (= two network calls).
 */
describe('routeCache invalidation on close-by destinations', () => {
  beforeEach(() => {
    clearRouteCache();
    vi.restoreAllMocks();
  });

  it('does NOT collide cache keys for destinations ~60m apart', async () => {
    // These coords intentionally land in the SAME toFixed(3) bucket
    // ("23.140,-82.365") but in DIFFERENT toFixed(5) buckets — the
    // exact failure mode of the original bug. Destination 2 is ~60m
    // from destination 1, well within a Habana city block.
    const trabajo = { lat: 23.1400, lng: -82.3650 };
    const hotel   = { lat: 23.1404, lng: -82.3654 };
    const casa    = { lat: 23.1345, lng: -82.3821 };

    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      // Return distinct routes per destination so a cache hit would
      // surface as the wrong distance/duration.
      const isTrabajo = u.includes(`${trabajo.lng},${trabajo.lat}`);
      return new Response(
        JSON.stringify({
          routes: [{
            geometry: { coordinates: [[casa.lng, casa.lat], isTrabajo ? [trabajo.lng, trabajo.lat] : [hotel.lng, hotel.lat]] },
            distance: isTrabajo ? 1234 : 1888,
            duration: isTrabajo ? 200 : 280,
          }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const route1 = await fetchRoute(casa, trabajo);
    const route2 = await fetchRoute(casa, hotel);

    expect(route1?.distance_m).toBe(1234);
    expect(route2?.distance_m).toBe(1888);              // ← would FAIL if cached
    expect(fetchSpy).toHaveBeenCalledTimes(2);          // both calls must hit network
  });

  it('DOES reuse cache for the exact same destination', async () => {
    const dest = { lat: 23.14045, lng: -82.36488 };
    const casa = { lat: 23.13452, lng: -82.38215 };

    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ routes: [{ geometry: { coordinates: [[casa.lng, casa.lat], [dest.lng, dest.lat]] }, distance: 1888, duration: 280 }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRoute(casa, dest);
    await fetchRoute(casa, dest);

    expect(fetchSpy).toHaveBeenCalledTimes(1);          // second call hits cache
  });

  it('clearRouteCache forces a re-fetch even for identical coords', async () => {
    const dest = { lat: 23.14045, lng: -82.36488 };
    const casa = { lat: 23.13452, lng: -82.38215 };

    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ routes: [{ geometry: { coordinates: [[casa.lng, casa.lat], [dest.lng, dest.lat]] }, distance: 1888, duration: 280 }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchRoute(casa, dest);
    clearRouteCache();
    await fetchRoute(casa, dest);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('smoothHeading (BUG-298 + BUG-marker-lag)', () => {
  it('returns the raw value when prev is null (first sample)', () => {
    expect(smoothHeading(45, null)).toBe(45);
    expect(smoothHeading(0, null)).toBe(0);
    expect(smoothHeading(359, null)).toBe(359);
  });

  it('returns the raw value when prev is NaN or non-finite', () => {
    expect(smoothHeading(90, NaN)).toBe(90);
    expect(smoothHeading(90, Infinity)).toBe(90);
  });

  // BUG-marker-lag: NEW behaviour — large deltas (>45°) snap to the
  // target instead of being EMA-interpolated. Verified on-device that
  // 5-8s of "marker pointing wrong way" was caused by EMA + double
  // smoothing dragging large turns out over 7+ iterations.
  describe('snap-to-target for large deltas (>45°)', () => {
    it('snaps directly when driver makes a sharp 90° turn', () => {
      // Driver was going north (0°), suddenly turns east (90°). Delta=90 > 45.
      expect(smoothHeading(90, 0)).toBe(90);
    });

    it('snaps directly for a sharp left turn (E → N via shortest path)', () => {
      // From 90° to 350° the shortest delta is -100° (CCW). |delta|>45 → snap.
      expect(smoothHeading(350, 90)).toBe(350);
    });

    it('snaps when delta is exactly 46° (just over threshold)', () => {
      expect(smoothHeading(46, 0)).toBe(46);
    });

    it('snaps for the real-world bug case: NNW (338°) → ENE (72°)', () => {
      // Reproduces the case captured in live logs on 2026-05-24.
      // Shortest path: +94° CW. Above 45° threshold → snap.
      expect(smoothHeading(72, 338)).toBe(72);
    });
  });

  describe('EMA smoothing for small deltas (≤45°) with default alpha=0.7', () => {
    it('uses HEADING_SMOOTHING_ALPHA by default', () => {
      // raw=40, prev=0, delta=40 (≤45) → EMA: 0 + 0.7*40 = 28
      expect(smoothHeading(40, 0)).toBeCloseTo(28, 5);
    });

    it('snaps at exactly 45° boundary (delta=45 is NOT > 45, so EMA)', () => {
      // 0 + 0.7*45 = 31.5
      expect(smoothHeading(45, 0)).toBeCloseTo(31.5, 5);
    });

    it('respects an explicit alpha argument', () => {
      // Small delta, custom alpha.
      expect(smoothHeading(30, 0, 0.5)).toBeCloseTo(15, 5);
      expect(smoothHeading(30, 0, 1.0)).toBeCloseTo(30, 5);
      expect(smoothHeading(30, 0, 0)).toBeCloseTo(0, 5);
    });
  });

  describe('shortest-path wrap-around', () => {
    it('takes the short way around the 350→10 wrap with EMA (delta=+20)', () => {
      // From 350° to 10° delta=+20 (CW, ≤45) → EMA: 350 + 0.7*20 = 364 → 4
      expect(smoothHeading(10, 350)).toBeCloseTo(4, 5);
    });

    it('takes the short way around the 10→350 wrap with EMA (delta=-20)', () => {
      // From 10° to 350° delta=-20 (CCW, ≤45) → EMA: 10 + 0.7*(-20) = -4 → 356
      expect(smoothHeading(350, 10)).toBeCloseTo(356, 5);
    });

    it('snaps when wrap-around delta exceeds 45° (e.g. 10° → 280°)', () => {
      // Shortest path: -90° CCW. Above 45° threshold → snap.
      expect(smoothHeading(280, 10)).toBe(280);
    });
  });

  it('keeps the result in [0, 360)', () => {
    let h: number | null = null;
    for (const raw of [10, 350, 5, 355, 0, 359]) {
      h = smoothHeading(raw, h);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('converges fast on a sustained small change (alpha=0.7)', () => {
    // Simulate a small 30° drift sustained: prev=0, raw=30 each iter.
    // Each step closes 70% of the remaining gap.
    //   1: 21.0   2: 27.3   3: 29.19   4: 29.757   5: 29.927
    let h: number | null = 0;
    for (let i = 0; i < 3; i++) {
      h = smoothHeading(30, h);
    }
    // After 3 iters: 30 - 0.3^3 * 30 = 30 - 0.81 = 29.19
    expect(h!).toBeCloseTo(29.19, 2);
  });

  it('exports HEADING_SMOOTHING_ALPHA = 0.7 (BUG-marker-lag tuned)', () => {
    expect(HEADING_SMOOTHING_ALPHA).toBe(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────
// PR 4b — importPoiFromSearch fire-and-forget behaviour
// ─────────────────────────────────────────────────────────────────
describe('importPoiFromSearch (PR 4b)', () => {
  const baseResult: SearchBoxResult = {
    address: 'Concordia 418, La Habana',
    latitude: 23.1366,
    longitude: -82.3608,
    place_name: 'La Guarida',
    full_address: 'Concordia 418, La Habana',
    category: 'restaurant',
    source: 'google',
    specificity: 0.95,
  };

  function makeSupabaseStub() {
    const invoke = vi.fn(async () => ({ data: null, error: null }));
    return {
      client: { functions: { invoke } },
      invoke,
    };
  }

  it('skips invoke when supabase is null', async () => {
    // Should resolve silently — nothing to assert other than no throw.
    await expect(importPoiFromSearch(baseResult, null)).resolves.toBeUndefined();
  });

  it('skips invoke when result.source is mapbox', async () => {
    const stub = makeSupabaseStub();
    await importPoiFromSearch({ ...baseResult, source: 'mapbox' }, stub.client);
    expect(stub.invoke).not.toHaveBeenCalled();
  });

  it('skips invoke when result.source is supabase (already in cuba_pois)', async () => {
    const stub = makeSupabaseStub();
    await importPoiFromSearch({ ...baseResult, source: 'supabase' }, stub.client);
    expect(stub.invoke).not.toHaveBeenCalled();
  });

  it('invokes import-mapbox-poi with Google result payload', async () => {
    const stub = makeSupabaseStub();
    await importPoiFromSearch(baseResult, stub.client);
    expect(stub.invoke).toHaveBeenCalledTimes(1);
    expect(stub.invoke).toHaveBeenCalledWith(
      'import-mapbox-poi',
      expect.objectContaining({
        body: expect.objectContaining({
          query: 'La Guarida',
          proximity: { lat: 23.1366, lng: -82.3608 },
          google_result: expect.objectContaining({
            place_name: 'La Guarida',
            address: 'Concordia 418, La Habana',
            latitude: 23.1366,
            longitude: -82.3608,
          }),
        }),
      }),
    );
  });

  it('never throws when invoke rejects (fire-and-forget contract)', async () => {
    const failingClient = {
      functions: {
        invoke: vi.fn(async () => {
          throw new Error('network down');
        }),
      },
    };
    // Silence the console.warn the function emits on failure
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(importPoiFromSearch(baseResult, failingClient)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('skips invoke when place_name or coordinates are missing', async () => {
    const stub = makeSupabaseStub();
    await importPoiFromSearch({ ...baseResult, place_name: '' }, stub.client);
    await importPoiFromSearch({ ...baseResult, latitude: 0 }, stub.client);
    await importPoiFromSearch({ ...baseResult, longitude: 0 }, stub.client);
    expect(stub.invoke).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// PR C — fetchRoute fallback order (Mapbox primary, OSRM fallback)
// ─────────────────────────────────────────────────────────────────
describe('fetchRoute fallback order (PR C)', () => {
  // The Mapbox helper bails out when no token is in env. Stub one so
  // the Mapbox path is reachable in tests.
  const ORIGINAL_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
  beforeEach(() => {
    clearRouteCache();
    vi.restoreAllMocks();
    process.env.EXPO_PUBLIC_MAPBOX_TOKEN = 'pk.test';
  });
  afterEach(() => {
    process.env.EXPO_PUBLIC_MAPBOX_TOKEN = ORIGINAL_TOKEN;
  });

  function makeRouteResponse(distance: number, duration: number) {
    return new Response(
      JSON.stringify({
        routes: [{
          geometry: { coordinates: [[-82.36, 23.13], [-82.35, 23.14]] },
          distance,
          duration,
        }],
      }),
      { status: 200 },
    );
  }

  it('calls Mapbox FIRST and returns its result; OSRM never called', async () => {
    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('api.mapbox.com/directions')) {
        return makeRouteResponse(1234, 200);
      }
      if (u.includes('router.project-osrm.org')) {
        return makeRouteResponse(9999, 999);
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchRoute({ lat: 23.13, lng: -82.36 }, { lat: 23.14, lng: -82.35 });

    expect(result?.distance_m).toBe(1234); // Mapbox value, not OSRM 9999
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('api.mapbox.com/directions'))).toBe(true);
    expect(calls.some((u) => u.includes('router.project-osrm.org'))).toBe(false);
  });

  it('falls back to OSRM when Mapbox returns no route', async () => {
    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('api.mapbox.com/directions')) {
        return new Response(JSON.stringify({ routes: [] }), { status: 200 });
      }
      if (u.includes('router.project-osrm.org')) {
        return makeRouteResponse(2222, 220);
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchRoute({ lat: 23.13, lng: -82.36 }, { lat: 23.14, lng: -82.35 });

    expect(result?.distance_m).toBe(2222); // OSRM value
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('api.mapbox.com/directions'))).toBe(true);
    expect(calls.some((u) => u.includes('router.project-osrm.org'))).toBe(true);
  });

  it('falls back to OSRM when Mapbox HTTP request fails', async () => {
    const fetchSpy = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('api.mapbox.com/directions')) {
        return new Response('rate limited', { status: 429 });
      }
      if (u.includes('router.project-osrm.org')) {
        return makeRouteResponse(3333, 300);
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchRoute({ lat: 23.13, lng: -82.36 }, { lat: 23.14, lng: -82.35 });

    expect(result?.distance_m).toBe(3333); // OSRM rescued the call
  });

  it('returns null when both Mapbox and OSRM fail', async () => {
    const fetchSpy = vi.fn(async () => new Response('upstream down', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchRoute({ lat: 23.13, lng: -82.36 }, { lat: 23.14, lng: -82.35 });

    expect(result).toBeNull();
    // Confirm BOTH providers were exercised (defence-in-depth).
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('api.mapbox.com/directions'))).toBe(true);
    expect(calls.some((u) => u.includes('router.project-osrm.org'))).toBe(true);
  });
});

// ============================================================
// PR I (2026-05-25) — dedupeSearchResults regression guard
//
// Surfaced by the "Hotel Boutique Malecon 663" bug. The dedupe is
// supposed to drop cuba_pois rows that duplicate Google rows, NOT
// drop the venue the user is looking for. These tests pin down the
// edge cases so future tweaks to NAME_DEDUP_THRESHOLD or
// COORD_DEDUP_RADIUS_M don't silently break search visibility.
// ============================================================
describe('dedupeSearchResults', () => {
  // Helper to build a minimal SearchBoxResult.
  function mkResult(
    place_name: string,
    latitude: number,
    longitude: number,
  ): SearchBoxResult {
    return {
      address: place_name,
      latitude,
      longitude,
      place_name,
      full_address: place_name,
      category: '',
      source: 'google',
      specificity: 0.95,
      matchedCategory: null,
    };
  }

  it('returns secondary intact when primary is empty', () => {
    const primary: SearchBoxResult[] = [];
    const secondary = [mkResult('Hotel X', 23.13, -82.36)];
    expect(dedupeSearchResults(primary, secondary)).toEqual(secondary);
  });

  it('returns secondary intact when secondary is empty', () => {
    const primary = [mkResult('Hotel X', 23.13, -82.36)];
    const secondary: SearchBoxResult[] = [];
    expect(dedupeSearchResults(primary, secondary)).toEqual([]);
  });

  it('drops secondary entry that matches primary by both coord (<100m) and name', () => {
    const primary = [mkResult('Hotel Boutique Malecon 663', 23.140, -82.371)];
    const secondary = [
      mkResult('Hotel Boutique Malecon 663', 23.1401, -82.3711), // ~15m away, same name
    ];
    expect(dedupeSearchResults(primary, secondary)).toEqual([]);
  });

  it('KEEPS secondary entry that shares coord with primary but has unrelated name', () => {
    // Regression: a cafe and a bank on the same street corner should
    // not be deduped. Coord matches but names share zero tokens.
    const primary = [mkResult('Banco Metropolitano', 23.140, -82.371)];
    const secondary = [mkResult('Cafe Imperial', 23.1401, -82.3711)];
    const survivors = dedupeSearchResults(primary, secondary);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.place_name).toBe('Cafe Imperial');
  });

  it('drops secondary entry with strong name match within 5km even if not coord-close', () => {
    // Same hotel listed twice by different providers with coords ~200m
    // apart due to geocoder jitter. Name overlap is 100% → dedupe.
    const primary = [mkResult('Hotel Boutique Malecon 663', 23.140, -82.371)];
    const secondary = [
      mkResult('Hotel Boutique Malecon 663', 23.142, -82.369), // ~280m away, same name
    ];
    expect(dedupeSearchResults(primary, secondary)).toEqual([]);
  });

  it('KEEPS hotel with same name in a different city (>5km)', () => {
    // "Hotel Inglaterra" exists in both Habana and Cienfuegos. They
    // should both surface, not be merged.
    const primary = [mkResult('Hotel Inglaterra', 23.137, -82.359)]; // Habana
    const secondary = [
      mkResult('Hotel Inglaterra', 22.146, -80.439), // Cienfuegos ~280km
    ];
    const survivors = dedupeSearchResults(primary, secondary);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.latitude).toBeCloseTo(22.146, 2);
  });

  it('preserves original ordering of survivors', () => {
    const primary = [mkResult('Hotel A', 23.10, -82.30)];
    const secondary = [
      mkResult('Restaurant X', 23.20, -82.40),
      mkResult('Hotel A', 23.10, -82.30), // dropped
      mkResult('Cafe Y', 23.30, -82.50),
      mkResult('Bar Z', 23.40, -82.60),
    ];
    const survivors = dedupeSearchResults(primary, secondary);
    expect(survivors.map((s) => s.place_name)).toEqual([
      'Restaurant X', 'Cafe Y', 'Bar Z',
    ]);
  });

  it('handles diacritics: "Malecón" matches "Malecon"', () => {
    const primary = [mkResult('Hotel Boutique Malecón 663', 23.140, -82.371)];
    const secondary = [
      mkResult('Hotel Boutique Malecon 663', 23.1401, -82.3711),
    ];
    expect(dedupeSearchResults(primary, secondary)).toEqual([]);
  });
});

// ============================================================
// PR I (2026-05-25) — searchAddressGoogle frontend caller
//
// These tests validate the geo.ts wrapper around the EF. The EF
// itself (Deno) is verified by manual smoke + EF logs.
// ============================================================
describe('searchAddressGoogle', () => {
  function mkSupabase(invokeImpl: (name: string, opts: { body?: unknown }) => Promise<{ data: unknown; error: { message: string } | null }>) {
    return {
      functions: { invoke: invokeImpl },
    };
  }

  it('returns [] when query is too short (avoids wasting EF call)', async () => {
    const invokeSpy = vi.fn();
    const supabase = mkSupabase(invokeSpy);
    const out = await searchAddressGoogle('a', supabase);
    expect(out).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('returns [] when supabase client is null', async () => {
    const out = await searchAddressGoogle('hotel boutique malecon 663', null);
    expect(out).toEqual([]);
  });

  it('returns [] when EF responds with fallback hint (caller falls back to Mapbox)', async () => {
    const supabase = mkSupabase(async () => ({
      data: { data: [], fallback: 'mapbox', reason: 'budget_cap' },
      error: null,
    }));
    const out = await searchAddressGoogle('hotel x', supabase);
    expect(out).toEqual([]);
  });

  it('returns [] on EF transport error', async () => {
    const supabase = mkSupabase(async () => ({
      data: null,
      error: { message: 'network' },
    }));
    const out = await searchAddressGoogle('hotel x', supabase);
    expect(out).toEqual([]);
  });

  it('maps valid EF response to SearchBoxResult[] with source=google', async () => {
    const supabase = mkSupabase(async () => ({
      data: {
        data: [
          {
            address: 'Malecón 663, Habana',
            latitude: 23.1408,
            longitude: -82.3712,
            place_name: 'Hotel Boutique Malecon 663',
            matchedCategory: 'lodging',
            specificity: 0.95,
          },
        ],
      },
      error: null,
    }));
    const out = await searchAddressGoogle('hotel boutique malecon 663', supabase);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('google');
    expect(out[0]!.place_name).toBe('Hotel Boutique Malecon 663');
    expect(out[0]!.latitude).toBeCloseTo(23.1408, 4);
  });

  it('drops entries without numeric lat/lng (defensive: simulates Place Details fail upstream)', async () => {
    // If the EF managed to return a payload but a row is missing
    // coordinates (e.g. Place Details failed inside the EF and the
    // EF's filter didn't catch it), the frontend filter must drop
    // the bad row but keep the good one.
    const supabase = mkSupabase(async () => ({
      data: {
        data: [
          { place_name: 'Hotel A', address: 'X', latitude: 23.1, longitude: -82.3 },
          { place_name: 'Hotel B', address: 'Y' /* no lat/lng */ },
          { place_name: 'Hotel C', address: 'Z', latitude: 23.2, longitude: -82.4 },
        ],
      },
      error: null,
    }));
    const out = await searchAddressGoogle('hotel', supabase);
    expect(out.map((r) => r.place_name)).toEqual(['Hotel A', 'Hotel C']);
  });

  it('returns [] when caller signal is already aborted (no wasted call)', async () => {
    const invokeSpy = vi.fn();
    const supabase = mkSupabase(invokeSpy);
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await searchAddressGoogle('hotel x', supabase, null, ctrl.signal);
    expect(out).toEqual([]);
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
