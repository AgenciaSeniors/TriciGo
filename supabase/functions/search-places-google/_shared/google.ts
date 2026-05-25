// ============================================================
// search-places-google / _shared / google.ts
//
// Thin client for the Google Places Autocomplete (New) API. Normalizes
// the response into our SearchBoxResult shape so the EF can drop in
// alongside Mapbox SearchBox results in the unified search pipeline.
//
// API docs: https://developers.google.com/maps/documentation/places/web-service/place-autocomplete
//
// Why "New" (v1) vs the legacy autocomplete:
//   - Pricing model: session-based — better for our use case where the
//     user types ~5-10 chars before selecting
//   - Returns lat/lng INLINE in the autocomplete response (legacy required
//     a separate Place Details call → 2× the cost)
//   - Modern REST instead of legacy XML/JSON-P
// ============================================================

export interface SearchBoxResult {
  latitude: number;
  longitude: number;
  address: string;
  place_name: string;
  specificity?: number;       // 0-1, derived from result confidence
  matchedCategory?: string | null;
  source: 'google' | 'mapbox' | 'supabase';
  external_place_id?: string; // Google place_id, retained indefinitely per TOS
}

export interface GooglePlacesConfig {
  apiKey: string;
  /** Cuba bbox restriction: only return Cuban places */
  cubaBbox?: {
    low: { latitude: number; longitude: number };
    high: { latitude: number; longitude: number };
  };
}

/**
 * Default Cuba bbox: roughly Pinar del Río → Guantánamo + Isla de la
 * Juventud. Same bbox we use for OSM extracts.
 */
export const CUBA_BBOX = {
  low: { latitude: 19.5, longitude: -85.0 },
  high: { latitude: 23.5, longitude: -74.0 },
};

/**
 * Calls Google Places Autocomplete (New) API and returns normalized results.
 * Throws on network errors or non-2xx HTTP responses (caller handles fallback).
 *
 * Restricts to Cuba via `locationRestriction` so we don't pay for global
 * results we'll never use (and to align with our user base).
 */
export async function googlePlacesAutocomplete(
  query: string,
  config: GooglePlacesConfig,
  proximity?: { latitude: number; longitude: number },
  limit: number = 10,
): Promise<SearchBoxResult[]> {
  const url = 'https://places.googleapis.com/v1/places:autocomplete';

  const body: Record<string, unknown> = {
    input: query,
    languageCode: 'es',
    regionCode: 'CU',
    locationRestriction: {
      rectangle: config.cubaBbox ?? CUBA_BBOX,
    },
  };

  // Bias by proximity if known (improves relevance for nearby venues)
  if (proximity) {
    body.locationBias = {
      circle: {
        center: {
          latitude: proximity.latitude,
          longitude: proximity.longitude,
        },
        radius: 5000, // 5km — typical urban search radius
      },
    };
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.apiKey,
      // Field mask: ask only for fields we need (cheaper billing tier)
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Google Places API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: {
          mainText?: { text?: string };
          secondaryText?: { text?: string };
        };
        types?: string[];
      };
    }>;
  };

  // The Autocomplete (New) response does NOT include coordinates directly
  // — to get lat/lng we need to call Place Details for each. To keep
  // costs down, we batch the top N picks via Places (New) "Place Details"
  // with just the location field.
  const suggestions = (data.suggestions ?? []).slice(0, limit);
  if (suggestions.length === 0) return [];

  // Fetch details (lat/lng) for each in parallel. Field mask limits to
  // just `location` so this stays in the cheap "Basic" tier.
  //
  // PR I (2026-05-25): "Hotel Boutique Malecon 663" not appearing in search.
  // Place Details previously failed silently — a placeId returned by
  // Autocomplete that hits a transient 429/5xx on the details call was
  // dropped as `null` with no record of which placeId or why. We now log
  // each failure (`[search-places-google] place_details_fail`) so QA can
  // correlate "Google found this name" vs "it disappeared from UI".
  // Behaviour is unchanged — still returns null on fail.
  const details = await Promise.all(
    suggestions.map(async (sug) => {
      const placeId = sug.placePrediction?.placeId;
      const mainText = sug.placePrediction?.structuredFormat?.mainText?.text ?? '';
      if (!placeId) {
        console.warn('[search-places-google] place_details_skip reason=no_place_id mainText=%s', mainText);
        return null;
      }
      try {
        const detailsResp = await fetch(
          `https://places.googleapis.com/v1/places/${placeId}`,
          {
            headers: {
              'X-Goog-Api-Key': config.apiKey,
              'X-Goog-FieldMask': 'location,formattedAddress',
            },
          },
        );
        if (!detailsResp.ok) {
          const errBody = await detailsResp.text().catch(() => '');
          console.warn(
            '[search-places-google] place_details_fail placeId=%s status=%d mainText=%s err=%s',
            placeId, detailsResp.status, mainText, errBody.slice(0, 200),
          );
          return null;
        }
        const d = await detailsResp.json() as {
          location?: { latitude?: number; longitude?: number };
          formattedAddress?: string;
        };
        if (!d.location?.latitude || !d.location?.longitude) {
          console.warn(
            '[search-places-google] place_details_fail placeId=%s reason=no_location mainText=%s',
            placeId, mainText,
          );
          return null;
        }
        return {
          placeId,
          lat: d.location.latitude,
          lng: d.location.longitude,
          formattedAddress: d.formattedAddress ?? '',
          mainText,
          secondaryText: sug.placePrediction?.structuredFormat?.secondaryText?.text ?? '',
          types: sug.placePrediction?.types ?? [],
        };
      } catch (e) {
        console.warn(
          '[search-places-google] place_details_throw placeId=%s mainText=%s err=%s',
          placeId, mainText, String(e instanceof Error ? e.message : e),
        );
        return null;
      }
    }),
  );

  const results: SearchBoxResult[] = [];
  for (const d of details) {
    if (!d) continue;
    // Sanity: confirm within Cuba bbox (Google may bend the restriction).
    // PR I (2026-05-25): log rejections so we notice when a real Cuban
    // venue (e.g. coastal hotel in a cayo on the bbox edge) is being
    // silently dropped. Behaviour unchanged.
    if (d.lat < 19.5 || d.lat > 23.5 || d.lng < -85.0 || d.lng > -74.0) {
      console.warn(
        '[search-places-google] bbox_reject placeId=%s mainText=%s lat=%f lng=%f',
        d.placeId, d.mainText, d.lat, d.lng,
      );
      continue;
    }

    results.push({
      latitude: d.lat,
      longitude: d.lng,
      address: d.formattedAddress,
      place_name: d.mainText || d.formattedAddress,
      specificity: 0.95, // Google results are high-confidence by default
      matchedCategory: d.types[0] ?? null,
      source: 'google',
      external_place_id: d.placeId,
    });
  }

  return results;
}

/**
 * Compute a cache key from query + optional proximity. Proximity is
 * rounded to 2 decimals (~1km) so we don't fragment the cache on tiny
 * GPS jitters.
 */
export async function computeCacheKey(
  query: string,
  proximity: { latitude: number; longitude: number } | null,
): Promise<{ hash: string; proximityKey: string | null }> {
  const normalizedQuery = query.trim().toLowerCase();
  const proximityKey = proximity
    ? `${proximity.latitude.toFixed(2)},${proximity.longitude.toFixed(2)}`
    : null;
  const input = `${normalizedQuery}|${proximityKey ?? ''}`;
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { hash, proximityKey };
}
