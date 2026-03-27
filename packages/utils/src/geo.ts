// ============================================================
// TriciGo — Geo Utilities
// Haversine distance, road estimates, and Havana location presets
// ============================================================

import type { ServiceTypeSlug } from '@tricigo/types';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface LocationPreset {
  label: string;
  address: string;
  latitude: number;
  longitude: number;
}

/**
 * Havana location presets for ride selection (no geocoding API).
 */
export const HAVANA_PRESETS: readonly LocationPreset[] = [
  { label: 'Hotel Nacional', address: 'Calle O esq. 21, Vedado', latitude: 23.1375, longitude: -82.3964 },
  { label: 'Capitolio', address: 'Paseo del Prado, Centro Habana', latitude: 23.1352, longitude: -82.3599 },
  { label: 'Plaza de la Catedral', address: 'Empedrado, Habana Vieja', latitude: 23.1407, longitude: -82.3505 },
  { label: 'Miramar Trade Center', address: '5ta Ave y 76, Miramar', latitude: 23.1170, longitude: -82.4268 },
  { label: 'Universidad de La Habana', address: 'Calle L, Vedado', latitude: 23.1367, longitude: -82.3838 },
  { label: 'Malecón', address: 'Malecón y Crespo', latitude: 23.1445, longitude: -82.3667 },
  { label: 'Parque Central', address: 'Paseo del Prado, Habana', latitude: 23.1370, longitude: -82.3590 },
  { label: 'Plaza de la Revolución', address: 'Plaza de la Revolución', latitude: 23.1210, longitude: -82.3826 },
] as const;

/** Center of Havana (used as default for Havana-specific features). */
export const HAVANA_CENTER: GeoPoint = { latitude: 23.1136, longitude: -82.3666 };

/** Center of Cuba (used as default map center for all-Cuba view). */
export const CUBA_CENTER: GeoPoint = { latitude: 21.5, longitude: -79.5 };

/** Default map zoom for Cuba-wide view */
export const CUBA_DEFAULT_ZOOM = 7;

/**
 * Haversine distance between two points in meters.
 */
export function haversineDistance(from: GeoPoint, to: GeoPoint): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const lat1 = toRad(from.latitude);
  const lat2 = toRad(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Estimate road distance from straight-line distance.
 * Urban areas typically have a 1.3x factor.
 */
export function estimateRoadDistance(straightLineM: number): number {
  return straightLineM * 1.3;
}

/** Average speeds in km/h per service type. */
const AVG_SPEEDS: Record<ServiceTypeSlug, number> = {
  triciclo_basico: 15,
  triciclo_premium: 15,
  triciclo_cargo: 12,
  moto_standard: 30,
  auto_standard: 25,
  auto_confort: 25,
  mensajeria: 20,
};

/**
 * Estimate trip duration in seconds from road distance.
 */
export function estimateDuration(
  roadDistanceM: number,
  serviceType: ServiceTypeSlug,
): number {
  const speedKmh = AVG_SPEEDS[serviceType] ?? 15;
  const speedMs = (speedKmh * 1000) / 3600;
  return Math.round(roadDistanceM / speedMs);
}

/**
 * Format a Nominatim address into a Cuban-style street address.
 * Example outputs:
 * - "Calle 23 #302 e/ 2 y 4, Vedado"
 * - "Obispo e/ Mercaderes y San Ignacio, Habana Vieja"
 * - "Calle L, Vedado"
 */
export function formatCubanAddress(address: {
  road?: string;
  suburb?: string;
  city?: string;
  city_district?: string;
  neighbourhood?: string;
  house_number?: string;
  // Nominatim sometimes provides these for intersections
  'addr:street'?: string;
  display_name?: string;
}): string {
  const parts: string[] = [];

  // Road + house number
  if (address.road) {
    let road = address.road;
    if (address.house_number) {
      road += ` #${address.house_number}`;
    }
    parts.push(road);
  }

  // Neighborhood / suburb — prefer suburb (barrio)
  const area = address.suburb || address.neighbourhood || address.city_district;
  if (area && area !== address.road) {
    parts.push(area);
  }

  // If we only got a neighborhood with no road, use it as the main part
  if (parts.length === 0 && area) {
    parts.push(area);
  }

  return parts.join(', ');
}

/**
 * Find the nearest HAVANA_PRESET to a given coordinate.
 * Returns the preset if within `thresholdM` meters, otherwise null.
 */
export function findNearestPreset(
  point: GeoPoint,
  thresholdM = 500,
): LocationPreset | null {
  let nearest: LocationPreset | null = null;
  let minDist = Infinity;

  for (const preset of HAVANA_PRESETS) {
    const dist = haversineDistance(point, {
      latitude: preset.latitude,
      longitude: preset.longitude,
    });
    if (dist < minDist) {
      minDist = dist;
      nearest = preset;
    }
  }

  return minDist <= thresholdM ? nearest : null;
}

// ============================================================
// OSRM Routing + Nominatim Geocoding (shared across all apps)
// ============================================================

/* ─── Types ─── */

export interface RouteResult {
  /** Array of [lat, lng] pairs for polyline rendering */
  coordinates: [number, number][];
  /** Route distance in meters */
  distance_m: number;
  /** Route duration in seconds */
  duration_s: number;
}

/** A single navigation step from OSRM */
export interface NavigationStep {
  /** Distance of this step in meters */
  distance_m: number;
  /** Duration of this step in seconds */
  duration_s: number;
  /** Street name */
  name: string;
  /** Maneuver type (turn, depart, arrive, continue, etc.) */
  maneuver_type: string;
  /** Maneuver modifier (left, right, straight, etc.) */
  maneuver_modifier: string;
  /** Maneuver location [lat, lng] */
  maneuver_location: [number, number];
  /** Step geometry as [lat, lng] pairs */
  geometry: [number, number][];
}

/** Route result with turn-by-turn navigation steps */
export interface NavigationRouteResult extends RouteResult {
  /** Turn-by-turn steps */
  steps: NavigationStep[];
}

export interface AddressSearchResult {
  /** Formatted address string */
  address: string;
  /** Latitude */
  latitude: number;
  /** Longitude */
  longitude: number;
  /** Display name from Nominatim */
  displayName: string;
}

/* ─── Nominatim throttle ─── */

const NOMINATIM_MIN_INTERVAL_MS = 1100; // >1s to respect Nominatim rate limit
let lastNominatimCall = 0;

async function throttledFetch(url: string, headers?: Record<string, string>): Promise<Response> {
  const now = Date.now();
  const wait = NOMINATIM_MIN_INTERVAL_MS - (now - lastNominatimCall);
  if (wait > 0) {
    await new Promise<void>((r) => setTimeout(r, wait));
  }
  lastNominatimCall = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

const NOMINATIM_HEADERS: Record<string, string> = {
  'User-Agent': 'TriciGo/1.0 (https://tricigo.com)',
};

/** Cuba bounding box for Nominatim search (SW lng, SW lat, NE lng, NE lat) */
const CUBA_VIEWBOX = '-85.0,19.5,-74.0,23.5';

/* ─── OSRM Routing ─── */

/**
 * Fetch route via Mapbox Directions API (primary) with OSRM fallback.
 * Mapbox provides traffic-aware routing and more accurate ETAs.
 */
export async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  // Try Mapbox first (traffic-aware, better accuracy)
  const mapboxResult = await fetchRouteMapbox(from, to);
  if (mapboxResult) return mapboxResult;

  // Fallback to OSRM (free, no auth)
  return fetchRouteOSRM(from, to);
}

/**
 * Fetch route via Mapbox Directions API.
 * Requires EXPO_PUBLIC_MAPBOX_TOKEN or NEXT_PUBLIC_MAPBOX_TOKEN env var.
 */
export async function fetchRouteMapbox(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return null;

    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson&access_token=${token}`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;

    const coordinates: [number, number][] = route.geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number],
    );

    return {
      coordinates,
      distance_m: Math.round(route.distance),
      duration_s: Math.round(route.duration),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch route via OSRM public API (fallback, no auth needed).
 */
export async function fetchRouteOSRM(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;

    const coordinates: [number, number][] = route.geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number],
    );

    return {
      coordinates,
      distance_m: route.distance,
      duration_s: route.duration,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch route with multiple waypoints using OSRM.
 * Points should be in order: [origin, waypoint1, waypoint2, ..., destination]
 */
export async function fetchMultiStopRoute(
  points: { lat: number; lng: number }[],
): Promise<RouteResult | null> {
  if (points.length < 2) return null;

  const coordStr = points
    .map((p) => `${p.lng},${p.lat}`)
    .join(';');

  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      routes?: Array<{
        geometry: { coordinates: number[][] };
        distance: number;
        duration: number;
      }>;
    };
    const route = data.routes?.[0];
    if (!route) return null;

    return {
      coordinates: route.geometry.coordinates.map(
        (c: number[]) => [c[1], c[0]] as [number, number],
      ),
      distance_m: Math.round(route.distance),
      duration_s: Math.round(route.duration),
    };
  } catch {
    return null;
  }
}

/* ─── OSRM Navigation Route (with steps) ─── */

/**
 * Fetch a driving route with turn-by-turn navigation steps using OSRM.
 * Returns the route geometry, distance, duration, and step-by-step instructions.
 */
export async function fetchNavigationRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<NavigationRouteResult | null> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.lng},${from.lat};${to.lng},${to.lat}` +
      `?overview=full&geometries=geojson&steps=true`;

    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    const route = data?.routes?.[0];
    if (!route) return null;

    // GeoJSON coordinates are [lng, lat] — convert to [lat, lng]
    const coordinates: [number, number][] = route.geometry.coordinates.map(
      (c: [number, number]) => [c[1], c[0]] as [number, number],
    );

    // Parse steps from all legs
    const steps: NavigationStep[] = [];
    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const stepCoords: [number, number][] = (step.geometry?.coordinates ?? []).map(
          (c: [number, number]) => [c[1], c[0]] as [number, number],
        );
        steps.push({
          distance_m: step.distance ?? 0,
          duration_s: step.duration ?? 0,
          name: step.name ?? '',
          maneuver_type: step.maneuver?.type ?? '',
          maneuver_modifier: step.maneuver?.modifier ?? '',
          maneuver_location: step.maneuver?.location
            ? [step.maneuver.location[1], step.maneuver.location[0]]
            : [0, 0],
          geometry: stepCoords,
        });
      }
    }

    return {
      coordinates,
      distance_m: route.distance,
      duration_s: route.duration,
      steps,
    };
  } catch {
    return null;
  }
}

/* ─── Cross-Street Detection via Overpass API ─── */

// In-memory cache for cross-street results (streets don't change)
const crossStreetCache = new Map<string, { streets: string[]; ts: number }>();
const CROSS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const CROSS_CACHE_MAX = 200;

function crossCacheKey(lat: number, lng: number): string {
  // Round to ~11m precision — same block = same cross streets
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

// Overpass API mirrors — race for fastest response
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function queryOverpassRace(query: string): Promise<{ elements?: Array<{ tags?: { name?: string }; center?: { lat: number; lon: number }; lat?: number; lon?: number }> }> {
  const encoded = encodeURIComponent(query);
  const controller = new AbortController();

  const promises = OVERPASS_MIRRORS.map((mirror) =>
    fetch(`${mirror}?data=${encoded}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TriciGo/1.0 (https://tricigo.com)' },
    }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
  );

  try {
    // Promise.any resolves with the FIRST successful response
    const result = await Promise.any(promises);
    controller.abort(); // Cancel slower mirror
    return result;
  } catch {
    // All mirrors failed
    return { elements: [] };
  }
}

/**
 * Find cross streets near a coordinate using the Overpass API.
 * Uses in-memory cache + mirror racing for reliability and speed.
 * Returns up to 2 street names that are different from the main road.
 */
async function findCrossStreets(
  lat: number,
  lng: number,
  mainRoad: string,
): Promise<string[]> {
  // 1. Check cache first (instant)
  const key = crossCacheKey(lat, lng);
  const cached = crossStreetCache.get(key);
  if (cached && Date.now() - cached.ts < CROSS_CACHE_TTL) {
    return cached.streets;
  }

  // 2. Query Overpass — reduced radius (30m) + 3s server timeout for speed
  // 75m radius covers typical Havana city blocks (80-100m wide)
  const query = `[out:json][timeout:3];way(around:75,${lat},${lng})["highway"]["name"];out tags;`;

  try {
    const data = await queryOverpassRace(query);

    // Extract unique road names that aren't the main road
    const mainLower = mainRoad.toLowerCase();
    const roads = (data.elements || [])
      .map((el) => el.tags?.name)
      .filter((name): name is string =>
        !!name && name.toLowerCase() !== mainLower,
      );

    const streets = [...new Set(roads)].slice(0, 2);

    // 3. Cache result (evict oldest if full)
    if (crossStreetCache.size >= CROSS_CACHE_MAX) {
      const oldest = crossStreetCache.keys().next().value;
      if (oldest) crossStreetCache.delete(oldest);
    }
    crossStreetCache.set(key, { streets, ts: Date.now() });

    return streets;
  } catch {
    return [];
  }
}

/* ─── Nominatim Reverse Geocoding ─── */

/**
 * Reverse geocode coordinates to a Cuban-style street address.
 * Uses Nominatim for the main road, then Overpass API for cross streets.
 * Format: "Cruz del Padre e/ Velázquez y Carballo"
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es&zoom=18`;

    const res = await throttledFetch(url, NOMINATIM_HEADERS);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.address) return null;

    const mainRoad = data.address.road;
    const area = data.address.suburb || data.address.neighbourhood || data.address.city_district || '';

    // If we have a main road, try to find cross streets
    if (mainRoad) {
      try {
        const crossStreets = await findCrossStreets(lat, lng, mainRoad);
        if (crossStreets.length >= 2) {
          // Full Cuban format: "Cruz del Padre e/ Velázquez y Carballo"
          const base = data.address.house_number
            ? `${mainRoad} #${data.address.house_number}`
            : mainRoad;
          return `${base} e/ ${crossStreets[0]} y ${crossStreets[1]}`;
        }
        if (crossStreets.length === 1) {
          const base = data.address.house_number
            ? `${mainRoad} #${data.address.house_number}`
            : mainRoad;
          return area
            ? `${base} y ${crossStreets[0]}, ${area}`
            : `${base} y ${crossStreets[0]}`;
        }
      } catch {
        // Both Overpass mirrors failed — use Nominatim address only
      }
    }

    // Fallback: basic format without cross streets
    const formatted = formatCubanAddress(data.address);
    return formatted || null;
  } catch {
    return null;
  }
}

/* ─── Predictive Pickup Optimization ─── */

/**
 * Suggest an optimized pickup point near a major intersection.
 * Snaps the user's location to the nearest road point
 * using the Mapbox Directions API.
 * Returns null if snapping fails or the snapped point is within 50m (already on road).
 */
export async function suggestPickupPoint(
  lat: number,
  lng: number,
): Promise<{ latitude: number; longitude: number; address: string } | null> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return null;

    // Use Mapbox Directions to snap to nearest road
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${lng},${lat};${lng + 0.001},${lat + 0.001}?access_token=${token}&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const waypoint = data?.waypoints?.[0];
    if (!waypoint) return null;

    const [snappedLng, snappedLat] = waypoint.location;

    // Check distance between original and snapped point
    const distanceM = haversineDistance(
      { latitude: lat, longitude: lng },
      { latitude: snappedLat, longitude: snappedLng },
    );

    // Only suggest if >50m from road (user is far from a drivable road)
    if (distanceM <= 50) return null;

    // Get address for the snapped point
    const address = await reverseGeocode(snappedLat, snappedLng);

    return {
      latitude: snappedLat,
      longitude: snappedLng,
      address: address || `${snappedLat.toFixed(4)}, ${snappedLng.toFixed(4)}`,
    };
  } catch {
    return null;
  }
}

/* ─── Cuban Intersection Search ─── */

/**
 * Find the EXACT intersection point of two streets using shared OSM nodes.
 * In OpenStreetMap, when two streets cross, they share a NODE at the intersection.
 * This queries for nodes that belong to BOTH ways = the real intersection point.
 */
export async function findIntersection(
  mainStreet: string,
  crossStreet1: string,
  crossStreet2?: string,
  proximity?: { latitude: number; longitude: number },
): Promise<{ address: string; latitude: number; longitude: number } | null> {
  try {
    const lat = proximity?.latitude || 23.1136;
    const lng = proximity?.longitude || -82.3666;
    const esc = (s: string) => s.replace(/[\\"/]/g, '');

    // Helper: find the shared node between two named streets
    async function findSharedNode(street1: string, street2: string): Promise<{ lat: number; lon: number } | null> {
      // Query: find nodes that belong to BOTH street1 ways AND street2 ways
      const q = `[out:json][timeout:5];way["name"~"${esc(street1)}",i]["highway"](around:3000,${lat},${lng})->.a;way["name"~"${esc(street2)}",i]["highway"](around:3000,${lat},${lng})->.b;node(w.a)(w.b);out;`;

      const data = await queryOverpassRace(q);
      if (!data?.elements?.length) return null;

      // Pick the shared node closest to the user's map center
      let best: { lat: number; lon: number } | null = null;
      let bestDist = Infinity;
      for (const node of data.elements) {
        if (node.lat == null || node.lon == null) continue;
        const d = haversineDistance(
          { latitude: lat, longitude: lng },
          { latitude: node.lat, longitude: node.lon },
        );
        if (d < bestDist) {
          bestDist = d;
          best = { lat: node.lat, lon: node.lon };
        }
      }
      return best;
    }

    // Find intersection: main × cross1
    // If cross2 exists, run BOTH queries in parallel for speed
    let point1: { lat: number; lon: number } | null;
    let point2: { lat: number; lon: number } | null = null;

    if (crossStreet2) {
      const [p1, p2] = await Promise.all([
        findSharedNode(mainStreet, crossStreet1),
        findSharedNode(mainStreet, crossStreet2),
      ]);
      point1 = p1;
      point2 = p2;
    } else {
      point1 = await findSharedNode(mainStreet, crossStreet1);
    }

    if (!point1) return null;

    // Final coordinates: midpoint between two intersections, or the single intersection
    const finalLat = point2 ? (point1.lat + point2.lat) / 2 : point1.lat;
    const finalLng = point2 ? (point1.lon + point2.lon) / 2 : point1.lon;

    const address = crossStreet2
      ? `${mainStreet} e/ ${crossStreet1} y ${crossStreet2}`
      : `${mainStreet} y ${crossStreet1}`;

    return { address, latitude: finalLat, longitude: finalLng };
  } catch {
    return null;
  }
}

/* ─── Nominatim Forward Geocoding (Address Search) ─── */

/**
 * Search for addresses in Havana using Nominatim forward geocoding.
 * Results are bounded to the Havana area via viewbox.
 * Returns up to `limit` results, or empty array on failure.
 */
export async function searchAddress(
  query: string,
  limit = 5,
): Promise<AddressSearchResult[]> {
  if (!query || query.trim().length < 2) return [];

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      limit: String(limit),
      viewbox: CUBA_VIEWBOX,
      bounded: '1',
      'accept-language': 'es',
    });

    const url = `https://nominatim.openstreetmap.org/search?${params}`;
    const res = await throttledFetch(url, NOMINATIM_HEADERS);
    if (!res.ok) return [];

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((item: Record<string, unknown>) => {
      const displayName = (item.display_name as string) ?? '';
      const formatted = item.address
        ? formatCubanAddress(item.address as Parameters<typeof formatCubanAddress>[0])
        : displayName;

      return {
        address: formatted || displayName,
        latitude: parseFloat(item.lat as string),
        longitude: parseFloat(item.lon as string),
        displayName,
      };
    });
  } catch {
    return [];
  }
}
