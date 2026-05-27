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
 *
 * sessionToken (recommended): when present, this token must be sent on every
 * Autocomplete call within a single user's typeahead session AND on the
 * subsequent Place Details call. Google then bills the entire session as
 * a single "Autocomplete - Per Session" SKU (~$2.83/1k) instead of
 * per-character ("Autocomplete - Per Request" ~$2.83/1k × N chars) +
 * Place Details ($5/1k). Caller is responsible for generating + reusing
 * the token across the lifetime of one search session.
 */
export async function googlePlacesAutocomplete(
  query: string,
  config: GooglePlacesConfig,
  proximity?: { latitude: number; longitude: number },
  limit: number = 10,
  sessionToken?: string,
): Promise<SearchBoxResult[]> {
  const url = 'https://places.googleapis.com/v1/places:autocomplete';

  const body: Record<string, unknown> = {
    input: query,
    languageCode: 'es',
    regionCode: 'CU',
  };

  if (sessionToken) {
    body.sessionToken = sessionToken;
  }

  // Google Places API (New) rejects requests that set BOTH locationBias and
  // locationRestriction with HTTP 400 INVALID_ARGUMENT:
  //   "At most one of location_bias or location_restriction must be set."
  //
  // Bug discovered 2026-05-25 — version 3 (and earlier) always set
  // locationRestriction to Cuba bbox + ALSO set locationBias when proximity
  // was provided, so every client search with GPS coords failed silently
  // (caught by EF, fallback to mapbox, no cache/counter increment).
  //
  // Resolution: when we know the user's GPS coords, prefer locationBias
  // (gives better relevance for nearby venues). When we don't, fall back to
  // locationRestriction with the full Cuba bbox. The post-fetch sanity check
  // below (lines ~165) still drops any result outside Cuba in case Google
  // bends the bias and returns something close to the border.
  if (proximity) {
    // Tier 1.6 R1 (2026-05-27) — radius 5km → 25km:
    //
    // 5km was too tight for national use across Cuba. The bug we were
    // chasing: a user in Vedado searching "Paladar X" in Playa (~10km
    // away) would see it ranked off the top-10 list because the strong
    // 5km bias buried far-but-relevant venues. 25km comfortably covers
    // Habana metro (Centro Habana → Playa, Vedado → Cojimar) and the
    // immediate surroundings of every major Cuban city (Santiago,
    // Camagüey, Holguín, etc.).
    //
    // locationBias is preference, not exclusion — Google will still
    // include faraway results (e.g. an exact-name match in another
    // province) but rank them below the biased zone. That's the right
    // trade-off for "search where I am".
    body.locationBias = {
      circle: {
        center: {
          latitude: proximity.latitude,
          longitude: proximity.longitude,
        },
        radius: 25000, // 25km — covers Cuban metropolitan areas
      },
    };
  } else {
    body.locationRestriction = {
      rectangle: config.cubaBbox ?? CUBA_BBOX,
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
        // sessionToken (when present) ties this Place Details lookup to the
        // same billable session as the preceding Autocomplete calls. Without
        // it, Google bills this as a standalone Place Details Basic call
        // ($5/1k) on top of any per-request Autocomplete charges.
        const detailsUrl = sessionToken
          ? `https://places.googleapis.com/v1/places/${placeId}?sessionToken=${encodeURIComponent(sessionToken)}`
          : `https://places.googleapis.com/v1/places/${placeId}`;
        const detailsResp = await fetch(
          detailsUrl,
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
    //
    // Tier 1.6 R5 (2026-05-27) — widened bounds with ±0.2° margin (~20km):
    //   - lat: 19.5/23.5 → 19.3/23.7
    //   - lng: -85.0/-74.0 → -85.2/-73.8
    //
    // Why: Google occasionally returns coords slightly outside the
    // canonical Cuba bbox for coastal venues (cayos on the edge,
    // marinas, coastal hotels). The previous strict bounds silently
    // dropped these legitimate Cuban places. The margin still keeps
    // results within the ocean/cayos around Cuba (no risk of bleeding
    // into Bahamas, Caymans, etc. as actual settlements there are
    // hundreds of km outside Cuba's coordinates).
    //
    // PR I (2026-05-25): log rejections so we notice when a real Cuban
    // venue is being silently dropped. Behaviour unchanged.
    if (d.lat < 19.3 || d.lat > 23.7 || d.lng < -85.2 || d.lng > -73.8) {
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
