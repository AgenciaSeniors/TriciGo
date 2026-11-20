import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeCacheKey, googlePlacesAutocomplete } from './google.ts';

// QA round 3 (2026-11-20):
//   R3-04: "Vedado" came back as "Vedado, Havana, Cuba". The autocomplete call
//          asked for Spanish but the Place Details call, where the address
//          comes from, did not.
//   R3-05: picking "Vedado" stopped asking the rider to confirm the point,
//          because the result kept only Google's FIRST type, and Google moved
//          `geocode` ahead of `sublocality_level_1` for that place.

interface FakePlace {
  placeId: string;
  mainText: string;
  types: string[];
  address: string;
  lat?: number;
  lng?: number;
}

function stubGoogle(places: FakePlace[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('places:autocomplete')) {
      return new Response(
        JSON.stringify({
          suggestions: places.map((p) => ({
            placePrediction: {
              placeId: p.placeId,
              text: { text: p.mainText },
              structuredFormat: { mainText: { text: p.mainText }, secondaryText: { text: 'La Habana' } },
              types: p.types,
            },
          })),
        }),
        { status: 200 },
      );
    }
    const place = places.find((p) => url.includes(`/places/${p.placeId}`));
    if (!place) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({
        location: { latitude: place.lat ?? 23.1366, longitude: place.lng ?? -82.3923 },
        formattedAddress: place.address,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const CONFIG = { apiKey: 'test-key' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('googlePlacesAutocomplete', () => {
  it('asks Place Details for Spanish, so the address is not in English', async () => {
    const calls = stubGoogle([
      { placeId: 'vedado', mainText: 'Vedado', types: ['geocode'], address: 'Vedado, La Habana, Cuba' },
    ]);

    await googlePlacesAutocomplete('vedado', CONFIG, undefined, 5, 'tok-1');

    const details = calls.find((u) => u.includes('/places/vedado'));
    expect(details).toBeDefined();
    const params = new URL(details!).searchParams;
    expect(params.get('languageCode')).toBe('es');
    expect(params.get('regionCode')).toBe('CU');
    expect(params.get('sessionToken')).toBe('tok-1');
  });

  it('asks for Spanish without a session token too', async () => {
    const calls = stubGoogle([
      { placeId: 'vedado', mainText: 'Vedado', types: ['geocode'], address: 'Vedado, La Habana, Cuba' },
    ]);

    await googlePlacesAutocomplete('vedado', CONFIG);

    const details = calls.find((u) => u.includes('/places/vedado'));
    const params = new URL(details!).searchParams;
    expect(params.get('languageCode')).toBe('es');
    expect(params.has('sessionToken')).toBe(false);
  });

  it('marks a neighbourhood as a zone even when Google lists `geocode` first', async () => {
    stubGoogle([
      {
        placeId: 'vedado',
        mainText: 'Vedado',
        types: ['geocode', 'political', 'sublocality', 'sublocality_level_1'],
        address: 'Vedado, La Habana, Cuba',
      },
    ]);

    const [r] = await googlePlacesAutocomplete('vedado', CONFIG);

    expect(r?.matchedCategory).toBe('sublocality');
  });

  it('keeps the first type for a specific place', async () => {
    stubGoogle([
      {
        placeId: 'coppelia',
        mainText: 'Coppelia',
        types: ['ice_cream_shop', 'food', 'point_of_interest', 'establishment'],
        address: 'Calle 23 y L, La Habana, Cuba',
      },
    ]);

    const [r] = await googlePlacesAutocomplete('coppelia', CONFIG);

    expect(r?.matchedCategory).toBe('ice_cream_shop');
  });

  it('keeps a locality as a zone', async () => {
    stubGoogle([
      {
        placeId: 'plaza',
        mainText: 'Plaza de la Revolución',
        types: ['locality', 'political'],
        address: 'Plaza de la Revolución, La Habana, Cuba',
      },
    ]);

    const [r] = await googlePlacesAutocomplete('plaza', CONFIG);

    expect(r?.matchedCategory).toBe('locality');
  });

  it('returns null when Google gives no types', async () => {
    stubGoogle([{ placeId: 'x', mainText: 'X', types: [], address: 'X, La Habana, Cuba' }]);

    const [r] = await googlePlacesAutocomplete('x', CONFIG);

    expect(r?.matchedCategory).toBeNull();
  });
});

describe('computeCacheKey', () => {
  async function sha256(s: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('does not reuse the entries cached before the Spanish and zone fixes', async () => {
    const { hash } = await computeCacheKey('Vedado', { latitude: 23.1352, longitude: -82.3597 });

    expect(hash).not.toBe(await sha256('vedado|23.14,-82.36'));
  });

  it('is still the same key for the same query and rounded position', async () => {
    const a = await computeCacheKey('Vedado ', { latitude: 23.1352, longitude: -82.3597 });
    const b = await computeCacheKey('vedado', { latitude: 23.1371, longitude: -82.3601 });

    expect(a.hash).toBe(b.hash);
    expect(a.proximityKey).toBe('23.14,-82.36');
  });
});
