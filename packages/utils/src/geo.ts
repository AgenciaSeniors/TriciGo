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

/**
 * Location presets for major Cuban cities outside Havana.
 */
export const CUBA_CITY_PRESETS: readonly LocationPreset[] = [
  // Santiago de Cuba
  { label: 'Parque Céspedes', address: 'Parque Céspedes, Santiago de Cuba', latitude: 20.0217, longitude: -75.8295 },
  { label: 'Hotel Casa Granda', address: 'Heredia 201, Santiago de Cuba', latitude: 20.0215, longitude: -75.8289 },
  // Camagüey
  { label: 'Plaza del Carmen', address: 'Plaza del Carmen, Camagüey', latitude: 21.3808, longitude: -77.9170 },
  // Holguín
  { label: 'Plaza de la Marqueta', address: 'Calle Frexes, Holguín', latitude: 20.8872, longitude: -76.2630 },
  // Trinidad
  { label: 'Plaza Mayor', address: 'Plaza Mayor, Trinidad', latitude: 21.8024, longitude: -79.9841 },
  // Varadero
  { label: 'Hotel Internacional', address: 'Avenida 1ra, Varadero', latitude: 23.1547, longitude: -81.2480 },
  // Cienfuegos
  { label: 'Parque Martí', address: 'Parque José Martí, Cienfuegos', latitude: 22.1461, longitude: -80.4530 },
  // Santa Clara
  { label: 'Monumento Che Guevara', address: 'Plaza de la Revolución, Santa Clara', latitude: 22.4025, longitude: -79.9720 },
  // Pinar del Río
  { label: 'Centro Histórico', address: 'Calle Martí, Pinar del Río', latitude: 22.4175, longitude: -83.6978 },
  // Matanzas
  { label: 'Parque de la Libertad', address: 'Parque de la Libertad, Matanzas', latitude: 23.0411, longitude: -81.5775 },
] as const;

/** All presets: Havana + rest of Cuba */
export const ALL_PRESETS: readonly LocationPreset[] = [...HAVANA_PRESETS, ...CUBA_CITY_PRESETS];

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

  for (const preset of ALL_PRESETS) {
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
  // Set timestamp BEFORE awaiting to prevent concurrent calls from bypassing throttle
  lastNominatimCall = now + Math.max(wait, 0);
  if (wait > 0) {
    await new Promise<void>((r) => setTimeout(r, wait));
  }
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

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

/* ─── ETA Matrix: multiple origins → single destination ─── */

/**
 * Calculate ETAs from multiple vehicle positions to a single pickup point.
 * Uses OSRM Table API (free, no auth) with Mapbox Matrix API as primary.
 * Returns array of { duration_s, distance_m } in same order as origins.
 */
export async function fetchETAsToPickup(
  origins: { lat: number; lng: number }[],
  destination: { lat: number; lng: number },
): Promise<Array<{ duration_s: number; distance_m: number } | null>> {
  if (origins.length === 0) return [];

  // Try Mapbox Matrix API first
  const mapboxResult = await fetchETAsMapbox(origins, destination);
  if (mapboxResult) return mapboxResult;

  // Fallback to OSRM Table API
  return fetchETAsOSRM(origins, destination);
}

async function fetchETAsMapbox(
  origins: { lat: number; lng: number }[],
  destination: { lat: number; lng: number },
): Promise<Array<{ duration_s: number; distance_m: number } | null> | null> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return null;

    // Coordinates: all origins + destination (last)
    const coords = origins.map((o) => `${o.lng},${o.lat}`).join(';') + `;${destination.lng},${destination.lat}`;
    const destIdx = origins.length; // index of destination
    const sourceIdxs = origins.map((_, i) => i).join(';');

    const url =
      `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}` +
      `?sources=${sourceIdxs}&destinations=${destIdx}&annotations=duration,distance&access_token=${token}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;

    const data = await res.json();
    if (data.code !== 'Ok') return null;

    return origins.map((_, i) => {
      const dur = data.durations?.[i]?.[0];
      const dist = data.distances?.[i]?.[0];
      if (dur == null || dist == null) return null;
      return { duration_s: Math.round(dur), distance_m: Math.round(dist) };
    });
  } catch {
    return null;
  }
}

async function fetchETAsOSRM(
  origins: { lat: number; lng: number }[],
  destination: { lat: number; lng: number },
): Promise<Array<{ duration_s: number; distance_m: number } | null>> {
  try {
    // OSRM Table API: all origins + destination
    const coords = origins.map((o) => `${o.lng},${o.lat}`).join(';') + `;${destination.lng},${destination.lat}`;
    const destIdx = origins.length;
    const sourceIdxs = origins.map((_, i) => i).join(';');

    const url =
      `https://router.project-osrm.org/table/v1/driving/${coords}` +
      `?sources=${sourceIdxs}&destinations=${destIdx}&annotations=duration,distance`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return origins.map(() => null);

    const data = await res.json();
    if (data.code !== 'Ok') return origins.map(() => null);

    return origins.map((_, i) => {
      const dur = data.durations?.[i]?.[0];
      const dist = data.distances?.[i]?.[0];
      if (dur == null || dist == null) return null;
      return { duration_s: Math.round(dur), distance_m: Math.round(dist) };
    });
  } catch {
    return origins.map(() => null);
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
const crossStreetCache = new Map<string, { streets: string[]; main?: string; ts: number }>();
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

async function queryOverpassRace(query: string): Promise<{ elements?: Array<{ tags?: { name?: string }; center?: { lat: number; lon: number }; lat?: number; lon?: number; geometry?: Array<{ lat: number; lon: number }> }> }> {
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
 * Distance from a point to a line segment (in approximate meters).
 * Used to determine which street the user actually tapped on.
 */
function pointToSegmentDistanceM(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    const dlat = (px - ax) * 111000;
    const dlng = (py - ay) * 111000 * Math.cos(px * Math.PI / 180);
    return Math.sqrt(dlat * dlat + dlng * dlng);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const dlat = (px - cx) * 111000;
  const dlng = (py - cy) * 111000 * Math.cos(px * Math.PI / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

/**
 * Minimum distance from a point to a way (polyline) in meters.
 */
function minDistToWay(lat: number, lng: number, geom: Array<{ lat: number; lon: number }>): number {
  let min = Infinity;
  for (let i = 0; i < geom.length - 1; i++) {
    const d = pointToSegmentDistanceM(lat, lng, geom[i].lat, geom[i].lon, geom[i + 1].lat, geom[i + 1].lon);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Find the nearest street + cross streets using Overpass geometry.
 * Uses `out body geom` to get full way geometries, then calculates
 * which way is geometrically closest to the tap point = main street.
 * Other nearby ways with different names = cross streets.
 */
async function findNearestStreetAndCross(
  lat: number,
  lng: number,
): Promise<{ mainStreet: string; crossStreets: string[] } | null> {
  // Check cache
  const key = crossCacheKey(lat, lng);
  const cached = crossStreetCache.get(key);
  if (cached && cached.main && Date.now() - cached.ts < CROSS_CACHE_TTL) {
    return { mainStreet: cached.main, crossStreets: cached.streets };
  }

  const query = `[out:json][timeout:3];way(around:75,${lat},${lng})["highway"]["name"];out body geom;`;

  try {
    const data = await queryOverpassRace(query);
    if (!data?.elements?.length) return null;

    // Calculate distance from tap point to each way's geometry
    const waysWithDist = data.elements
      .filter(el => el.tags?.name && el.geometry && el.geometry.length >= 2)
      .map(el => ({
        name: el.tags!.name!,
        dist: minDistToWay(lat, lng, el.geometry!),
      }))
      .sort((a, b) => a.dist - b.dist);

    if (!waysWithDist.length) return null;

    // Closest way = main street
    const mainStreet = waysWithDist[0].name;

    // Other ways with different names = cross streets (max 2, unique)
    const crossStreets = waysWithDist
      .filter(w => w.name.toLowerCase() !== mainStreet.toLowerCase())
      .map(w => w.name)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 2);

    // Cache
    if (crossStreetCache.size >= CROSS_CACHE_MAX) {
      const oldest = crossStreetCache.keys().next().value;
      if (oldest) crossStreetCache.delete(oldest);
    }
    crossStreetCache.set(key, { main: mainStreet, streets: crossStreets, ts: Date.now() });

    return { mainStreet, crossStreets };
  } catch {
    return null;
  }
}

/**
 * Legacy: Find cross streets near a coordinate (used as fallback).
 */
async function findCrossStreets(
  lat: number,
  lng: number,
  mainRoad: string,
): Promise<string[]> {
  const key = crossCacheKey(lat, lng);
  const cached = crossStreetCache.get(key);
  if (cached && Date.now() - cached.ts < CROSS_CACHE_TTL) {
    return cached.streets;
  }
  const query = `[out:json][timeout:3];way(around:75,${lat},${lng})["highway"]["name"];out tags;`;
  try {
    const data = await queryOverpassRace(query);
    const mainLower = mainRoad.toLowerCase();
    const roads = (data.elements || [])
      .map((el) => el.tags?.name)
      .filter((name): name is string => !!name && name.toLowerCase() !== mainLower);
    const streets = [...new Set(roads)].slice(0, 2);
    if (crossStreetCache.size >= CROSS_CACHE_MAX) {
      const oldest = crossStreetCache.keys().next().value;
      if (oldest) crossStreetCache.delete(oldest);
    }
    crossStreetCache.set(key, { main: mainRoad, streets, ts: Date.now() });
    return streets;
  } catch {
    return [];
  }
}

/* ─── Nominatim Reverse Geocoding ─── */

/**
 * Build a full enriched address string with optional POI, municipality, and province.
 * Pattern: "POI, street, municipality, province" — deduplicates and strips trailing commas.
 */
function buildEnrichedAddress(
  streetPart: string,
  poiName: string,
  municipality: string,
  province: string,
): string {
  const parts: string[] = [];

  // Add POI if it differs from the street part (avoid "Calle X, Calle X")
  if (poiName && !streetPart.includes(poiName) && poiName !== streetPart) {
    parts.push(poiName);
  }

  parts.push(streetPart);

  if (municipality) parts.push(municipality);
  if (province) parts.push(province);

  return parts.join(', ');
}

/**
 * Reverse geocode coordinates to a Cuban-style street address.
 * PRIMARY: Uses Overpass with geometry to find the NEAREST street (not Nominatim).
 * This fixes the bug where Nominatim returns a parallel street instead of the closest one.
 * Enriched with POI name, municipality, and province from Nominatim.
 * Format: "Hotel Inglaterra, Paseo de Martí, La Habana Vieja, La Habana"
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    // 1. Nominatim reverse (fast, ~200ms) — runs in parallel with Overpass
    const nomUrl =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es&zoom=18`;
    const nomPromise = throttledFetch(nomUrl, NOMINATIM_HEADERS)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

    // 2. Overpass geometry-based cross-streets (slower, 1-5s) — race with a timeout
    const overpassPromise = findNearestStreetAndCross(lat, lng).catch(() => null);
    let overpassTimer: ReturnType<typeof setTimeout>;
    const overpassWithTimeout = Promise.race([
      overpassPromise.then(r => { clearTimeout(overpassTimer); return r; }),
      new Promise<null>(resolve => { overpassTimer = setTimeout(() => resolve(null), 3000); }),
    ]);

    // Wait for Nominatim first (fast), then check if Overpass finished
    const nomData = await nomPromise;

    // Extract metadata from Nominatim
    const address = nomData?.address || {};
    const municipality = address.city_district || address.suburb || address.neighbourhood || '';
    const province = address.state || '';
    const poiName = nomData?.name || address.amenity || address.building || address.tourism || address.leisure || '';
    const mainRoad = address.road || address.pedestrian || address.footway || '';

    // Try Overpass result (may already be done or will finish within timeout)
    const overpassResult = await overpassWithTimeout;

    if (overpassResult) {
      const { mainStreet, crossStreets } = overpassResult;
      let streetPart = mainStreet;
      if (crossStreets.length >= 2) {
        streetPart = `${mainStreet} e/ ${crossStreets[0]} y ${crossStreets[1]}`;
      } else if (crossStreets.length === 1) {
        streetPart = `${mainStreet} y ${crossStreets[0]}`;
      }
      return buildEnrichedAddress(streetPart, poiName, municipality, province);
    }

    // 3. FALLBACK: Nominatim road + Overpass cross-streets (legacy, also with timeout)
    if (!nomData?.address) return null;

    if (mainRoad) {
      try {
        let crossTimer: ReturnType<typeof setTimeout>;
        const crossStreets = await Promise.race([
          findCrossStreets(lat, lng, mainRoad).then(r => { clearTimeout(crossTimer); return r; }),
          new Promise<string[]>(resolve => { crossTimer = setTimeout(() => resolve([]), 2000); }),
        ]);
        let streetPart = mainRoad;
        if (crossStreets.length >= 2) {
          streetPart = `${mainRoad} e/ ${crossStreets[0]} y ${crossStreets[1]}`;
        } else if (crossStreets.length === 1) {
          streetPart = `${mainRoad} y ${crossStreets[0]}`;
        }
        return buildEnrichedAddress(streetPart, poiName, municipality, province);
      } catch { /* fallback below */ }
    }

    const formatted = formatCubanAddress(nomData.address);
    if (!formatted) return null;
    return buildEnrichedAddress(formatted, poiName, municipality, province);
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

/**
 * Snap a point to the nearest drivable road using Mapbox Directions API.
 * Always returns snapped coordinates (unlike suggestPickupPoint which has a 50m threshold).
 */
export async function snapToNearestRoad(
  lat: number,
  lng: number,
): Promise<{ latitude: number; longitude: number; distanceMoved: number; address: string | null }> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return { latitude: lat, longitude: lng, distanceMoved: 0, address: null };

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${lng},${lat};${lng + 0.001},${lat + 0.001}?access_token=${token}&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { latitude: lat, longitude: lng, distanceMoved: 0, address: null };
    const data = await res.json();
    const waypoint = data?.waypoints?.[0];
    if (!waypoint) return { latitude: lat, longitude: lng, distanceMoved: 0, address: null };

    const [snappedLng, snappedLat] = waypoint.location;
    const distanceMoved = haversineDistance(
      { latitude: lat, longitude: lng },
      { latitude: snappedLat, longitude: snappedLng },
    );

    const address = distanceMoved > 10 ? await reverseGeocode(snappedLat, snappedLng) : null;

    return {
      latitude: snappedLat,
      longitude: snappedLng,
      distanceMoved,
      address,
    };
  } catch {
    return { latitude: lat, longitude: lng, distanceMoved: 0, address: null };
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
    // Make regex accent-tolerant for Overpass: replace vowels with '.' wildcard
    // "Cadiz" → "C.d.z" matches "Cádiz"; "Suarez" → "S..r.z" matches "Suárez"
    // Only replaces vowels (not consonants) to keep regex specific enough
    const esc = (s: string) => s
      .replace(/[\\"/]/g, '')
      .replace(/[();\[\]~^$*+?{}|]/g, '') // Strip Overpass QL / regex metacharacters
      .replace(/[aáàâãä]/gi, '.')
      .replace(/[eéèêë]/gi, '.')
      .replace(/[iíìîï]/gi, '.')
      .replace(/[oóòôõö]/gi, '.')
      .replace(/[uúùûü]/gi, '.')
      .replace(/ñ/gi, '.');

    // For short street names (1-2 chars like "L", "M"), prefix with "Calle "
    // because in OSM Cuba, single-letter streets are named "Calle L", "Calle M", etc.
    const nameFilter = (s: string) => {
      const clean = s.replace(/"/g, '');
      if (clean.length <= 2) return `["name"~"(Calle |^)${clean}$",i]`;
      return `["name"~"${esc(s)}",i]`;
    };

    // Build ONE combined Overpass query that finds intersections with BOTH cross streets
    const mainF = nameFilter(mainStreet);
    const cross1F = nameFilter(crossStreet1);

    let query: string;
    if (crossStreet2) {
      const cross2F = nameFilter(crossStreet2);
      query = `[out:json][timeout:5];`
        + `way${mainF}["highway"](around:3000,${lat},${lng})->.main;`
        + `way${cross1F}["highway"](around:3000,${lat},${lng})->.c1;`
        + `way${cross2F}["highway"](around:3000,${lat},${lng})->.c2;`
        + `(node(w.main)(w.c1);node(w.main)(w.c2););out;`;
    } else {
      query = `[out:json][timeout:5];`
        + `way${mainF}["highway"](around:3000,${lat},${lng})->.main;`
        + `way${cross1F}["highway"](around:3000,${lat},${lng})->.c1;`
        + `node(w.main)(w.c1);out;`;
    }

    const data = await Promise.race([
      queryOverpassRace(query).catch(() => null),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
    ]);

    // Fallback: If Overpass fails to find shared nodes, try Nominatim forward geocoding
    if (!data?.elements?.length) {
      try {
        const fullAddr = crossStreet2
          ? `${mainStreet} y ${crossStreet1}, Cuba`
          : `${mainStreet} y ${crossStreet1}, Cuba`;
        const nomUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(fullAddr)}&format=json&countrycodes=cu&limit=3&viewbox=${lng - 0.05},${lat - 0.05},${lng + 0.05},${lat + 0.05}&bounded=1`;
        const nomRes = await throttledFetch(nomUrl, { 'Accept-Language': 'es' });
        if (nomRes.ok) {
          const nomData = await nomRes.json();
          if (nomData?.length > 0) {
            const best = nomData[0];
            const bLat = parseFloat(best.lat);
            const bLng = parseFloat(best.lon);
            if (isFinite(bLat) && isFinite(bLng)) {
              const address = crossStreet2
                ? `${mainStreet} e/ ${crossStreet1} y ${crossStreet2}`
                : `${mainStreet} y ${crossStreet1}`;
              return { address, latitude: bLat, longitude: bLng };
            }
          }
        }
      } catch { /* continue to return null */ }
      return null;
    }

    // All returned nodes are intersections of main with either cross1 or cross2
    // We need to figure out which node belongs to which intersection
    // Strategy: find the node closest to the map center for each cross street
    // Since we can't distinguish nodes from the combined output, we use position:
    // - If we have 2+ nodes, the most separated ones are likely the two different intersections
    const nodes = data.elements.filter(n => n.lat != null && n.lon != null);
    if (!nodes.length) return null;

    let point1: { lat: number; lon: number };
    let point2: { lat: number; lon: number } | null = null;

    if (nodes.length === 1) {
      point1 = { lat: nodes[0].lat!, lon: nodes[0].lon! };
    } else if (crossStreet2 && nodes.length >= 2) {
      // With 2 cross streets, we expect 2 intersection groups
      // Sort by distance from map center, take the 2 most different positions
      const sorted = nodes
        .map(n => ({ lat: n.lat!, lon: n.lon! }))
        .sort((a, b) => {
          const da = haversineDistance({ latitude: lat, longitude: lng }, { latitude: a.lat, longitude: a.lon });
          const db = haversineDistance({ latitude: lat, longitude: lng }, { latitude: b.lat, longitude: b.lon });
          return da - db;
        });
      point1 = sorted[0];
      // Find the node that is farthest from point1 (= the other intersection)
      let maxDist = 0;
      point2 = sorted[1];
      for (const n of sorted.slice(1)) {
        const d = haversineDistance({ latitude: point1.lat, longitude: point1.lon }, { latitude: n.lat, longitude: n.lon });
        if (d > maxDist) { maxDist = d; point2 = n; }
      }
    } else {
      // Just take the closest node
      point1 = { lat: nodes[0].lat!, lon: nodes[0].lon! };
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

/* ─── Address Validation ─── */

/**
 * Validate that a pickup location is near a drivable road.
 * Returns { valid: true } if within 200m of a road, or { valid: false, suggested } with a snapped point.
 */
export async function validatePickupLocation(
  lat: number,
  lng: number,
): Promise<{ valid: boolean; suggestedAddress?: string; suggestedLocation?: GeoPoint }> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return { valid: true };

    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${lng},${lat};${lng + 0.0001},${lat + 0.0001}?access_token=${token}&geometries=geojson&overview=false`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) return { valid: true };
    const data = await resp.json();
    const waypoint = data?.waypoints?.[0];
    if (!waypoint) return { valid: true };

    const [snappedLng, snappedLat] = waypoint.location;
    const distanceToRoad = haversineDistance(
      { latitude: lat, longitude: lng },
      { latitude: snappedLat, longitude: snappedLng },
    );

    if (distanceToRoad <= 200) return { valid: true };

    const address = await reverseGeocode(snappedLat, snappedLng);
    return {
      valid: false,
      suggestedAddress: address ?? `${snappedLat.toFixed(5)}, ${snappedLng.toFixed(5)}`,
      suggestedLocation: { latitude: snappedLat, longitude: snappedLng },
    };
  } catch {
    return { valid: true };
  }
}

/* ─── Mapbox Geocoding v6 (Primary Forward Search) ─── */

/**
 * Search for addresses using Mapbox Geocoding v6 API.
 * Faster (~200ms) and better POI coverage than Nominatim. No rate limit.
 */
export async function searchAddressMapbox(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  limit = 5,
): Promise<AddressSearchResult[]> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return [];

    const params = new URLSearchParams({
      q: query,
      country: 'cu',
      language: 'es',
      limit: String(limit),
      access_token: token,
    });
    if (proximity) {
      params.set('proximity', `${proximity.longitude},${proximity.latitude}`);
    }

    const url = `https://api.mapbox.com/search/geocode/v6/forward?${params}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    const features = data?.features;
    if (!Array.isArray(features)) return [];

    return features.map((f: Record<string, unknown>) => {
      const props = f.properties as Record<string, unknown> | undefined;
      const geom = f.geometry as { coordinates: [number, number] } | undefined;
      const address = (props?.full_address as string) || (props?.name as string) || '';
      const [lng, lat] = geom?.coordinates ?? [0, 0];
      return {
        address,
        latitude: lat,
        longitude: lng,
        displayName: address,
      };
    });
  } catch {
    return [];
  }
}

/* ─── Forward Geocoding (Mapbox primary → Nominatim fallback) ─── */

/**
 * Search for addresses in Cuba. Tries Mapbox Geocoding v6 first (faster, better POI),
 * falls back to Nominatim if Mapbox fails or returns no results.
 */
export async function searchAddress(
  query: string,
  limit = 5,
  proximity: { latitude: number; longitude: number } | null = null,
): Promise<AddressSearchResult[]> {
  if (!query || query.trim().length < 2) return [];

  // Try Mapbox first (faster, no rate limit)
  const mapboxResults = await searchAddressMapbox(query, proximity, limit);
  if (mapboxResults.length > 0) return mapboxResults;

  // Fallback to Nominatim
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
    }).filter(r => isFinite(r.latitude) && isFinite(r.longitude));
  } catch {
    return [];
  }
}

/* ─── Mapbox Search Box API (Best POI Names) ─── */

export interface SearchBoxResult {
  address: string;
  latitude: number;
  longitude: number;
  place_name: string;
  full_address: string;
  category?: string;
  source: 'searchbox' | 'nominatim' | 'overpass' | 'supabase';
  specificity: number; // 0-1: 1 = unique named POI, 0 = generic
}

/** Known generic category words — results matching ONLY these get low specificity */
const GENERIC_POI_WORDS = new Set([
  'universidad', 'hospital', 'parque', 'hotel', 'restaurante', 'iglesia',
  'museo', 'mercado', 'estacion', 'terminal', 'escuela', 'farmacia',
  'clinica', 'policlinico', 'tienda', 'cafeteria', 'bar', 'banco',
  'gasolinera', 'parada', 'cementerio', 'biblioteca', 'teatro', 'cine',
]);

/**
 * Compute specificity score for a POI result.
 * 1.0 = has a unique proper name, 0.2 = generic category only.
 */
export function computeSpecificity(placeName: string): number {
  const normalized = placeName.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (GENERIC_POI_WORDS.has(normalized)) return 0.2;
  const firstWord = normalized.split(/[\s,]+/)[0] ?? '';
  if (GENERIC_POI_WORDS.has(firstWord) && normalized.length > firstWord.length + 2) return 0.8;
  return 1.0;
}

/**
 * Search using Mapbox Search Box API — returns real POI names.
 * e.g., "Hospital Hermanos Ameijeiras" instead of just "Hospital".
 */
export async function searchAddressSearchBox(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  signal?: AbortSignal,
  limit = 10,
): Promise<SearchBoxResult[]> {
  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return [];

    const params = new URLSearchParams({
      q: query,
      country: 'cu',
      language: 'es',
      limit: String(limit),
      access_token: token,
      types: 'poi,address,street,place,neighborhood',
    });
    if (proximity) {
      params.set('proximity', `${proximity.longitude},${proximity.latitude}`);
    }

    const url = `https://api.mapbox.com/search/searchbox/v1/forward?${params}`;
    const controller = signal ? undefined : new AbortController();
    const effectiveSignal = signal ?? controller?.signal;
    const timeout = controller ? setTimeout(() => controller.abort(), 5000) : undefined;
    const res = await fetch(url, effectiveSignal ? { signal: effectiveSignal } : undefined);
    if (timeout) clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    const features = data?.features;
    if (!Array.isArray(features)) return [];

    return features.map((f: Record<string, unknown>) => {
      const props = f.properties as Record<string, unknown> | undefined;
      const geom = f.geometry as { coordinates: [number, number] } | undefined;
      const name = (props?.name as string) || '';
      const fullAddr = (props?.full_address as string) || (props?.place_formatted as string) || '';
      const poiCategory = (props?.poi_category as string[])
        ?? ((props?.poi_category_ids as string[]) || []);
      const category = Array.isArray(poiCategory) && poiCategory.length > 0
        ? poiCategory[0] : (props?.feature_type as string) || '';
      const [lng, lat] = geom?.coordinates ?? [0, 0];

      return {
        address: fullAddr || name,
        latitude: lat,
        longitude: lng,
        place_name: name,
        full_address: fullAddr,
        category: typeof category === 'string' ? category : '',
        source: 'searchbox' as const,
        specificity: computeSpecificity(name),
      };
    });
  } catch {
    return [];
  }
}

/** OSM tag mappings for POI category searches */
const OVERPASS_POI_TAGS: Record<string, string> = {
  hotel: '["tourism"="hotel"]',
  hostal: '["tourism"~"guest_house|hostel"]',
  restaurante: '["amenity"~"restaurant|fast_food|cafe"]',
  restaurant: '["amenity"~"restaurant|fast_food|cafe"]',
  cafe: '["amenity"="cafe"]',
  cafeteria: '["amenity"~"cafe|fast_food"]',
  bar: '["amenity"="bar"]',
  universidad: '["amenity"~"university|college"]',
  escuela: '["amenity"="school"]',
  hospital: '["amenity"~"hospital|clinic"]',
  clinica: '["amenity"~"clinic|hospital"]',
  policlinico: '["amenity"~"clinic|hospital"]',
  farmacia: '["amenity"="pharmacy"]',
  museo: '["tourism"="museum"]',
  iglesia: '["amenity"="place_of_worship"]',
  parque: '["leisure"="park"]',
  mercado: '["shop"~"supermarket|convenience|mall"]',
  tienda: '["shop"~"supermarket|convenience|department_store"]',
  banco: '["amenity"="bank"]',
  gasolinera: '["amenity"="fuel"]',
  teatro: '["amenity"="theatre"]',
  cine: '["amenity"="cinema"]',
  biblioteca: '["amenity"="library"]',
  terminal: '["amenity"="bus_station"]',
  estacion: '["amenity"~"bus_station|ferry_terminal"]',
  embajada: '["amenity"="embassy"]',
  aeropuerto: '["aeroway"="aerodrome"]',
  gimnasio: '["leisure"~"fitness_centre|sports_centre"]',
  piscina: '["leisure"="swimming_pool"]',
  playa: '["natural"="beach"]',
};

const OVERPASS_MIRRORS_GEO = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * Search OpenStreetMap POIs via Overpass API.
 * Returns named POIs matching the query within radius of proximity.
 */
export async function searchOverpassPOI(
  query: string,
  proximity: { latitude: number; longitude: number },
  limit = 8,
): Promise<SearchBoxResult[]> {
  try {
    const normalized = query.toLowerCase().trim()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = normalized.split(/\s+/);

    // Find matching OSM tag filter from query words
    let tagFilter = '';
    for (const word of words) {
      if (OVERPASS_POI_TAGS[word]) {
        tagFilter = OVERPASS_POI_TAGS[word]!;
        break;
      }
    }

    const { latitude: lat, longitude: lng } = proximity;
    const radius = 20000; // 20km search radius

    // Escape query for Overpass regex — strip QL metacharacters to prevent injection
    const escOverpass = (s: string) => s
      .replace(/[\\"/]/g, '')
      .replace(/[();\[\]~^$*+?{}|]/g, '')
      .replace(/[aáàâãä]/gi, '.')
      .replace(/[eéèêë]/gi, '.')
      .replace(/[iíìîï]/gi, '.')
      .replace(/[oóòôõö]/gi, '.')
      .replace(/[uúùûü]/gi, '.')
      .replace(/ñ/gi, '.');
    const escaped = escOverpass(normalized);

    let overpassQuery: string;
    if (tagFilter) {
      // Tag search + name search union: covers both tagged POIs and name matches
      const nameWords = words.filter(w => !OVERPASS_POI_TAGS[w]).map(escOverpass);
      const nameFilter = nameWords.length > 0
        ? `["name"~"${nameWords.join('|')}",i]`
        : '["name"]';
      // Union: tag-filtered POIs + any POI with query word in name
      overpassQuery = `[out:json][timeout:6];(node${tagFilter}${nameFilter}(around:${radius},${lat},${lng});way${tagFilter}${nameFilter}(around:${radius},${lat},${lng});node["name"~"${escaped}",i](around:${radius},${lat},${lng});way["name"~"${escaped}",i](around:${radius},${lat},${lng}););out center ${limit};`;
    } else {
      // Generic name search: find any named POI matching query
      overpassQuery = `[out:json][timeout:6];(node["name"~"${escaped}",i](around:${radius},${lat},${lng});way["name"~"${escaped}",i](around:${radius},${lat},${lng}););out center ${limit};`;
    }

    const encoded = encodeURIComponent(overpassQuery);
    const abortCtrl = new AbortController();
    const fetchTimeout = setTimeout(() => abortCtrl.abort(), 10000);
    let res: any;
    try {
      res = await Promise.any(
        OVERPASS_MIRRORS_GEO.map(m =>
          fetch(`${m}?data=${encoded}`, { signal: abortCtrl.signal }).then(r => {
            if (!r.ok) throw new Error('fail');
            return r.json();
          })
        ),
      );
    } finally {
      clearTimeout(fetchTimeout);
    }

    if (!res?.elements?.length) return [];

    return res.elements
      .filter((el: any) => el.tags?.name)
      .map((el: any) => {
        const elLat = el.lat ?? el.center?.lat ?? 0;
        const elLng = el.lon ?? el.center?.lon ?? 0;
        const name = el.tags.name;
        const street = el.tags['addr:street'] || '';
        const housenumber = el.tags['addr:housenumber'] || '';
        const suburb = el.tags['addr:suburb'] || el.tags['addr:neighbourhood'] || '';
        const addr = [street, housenumber, suburb].filter(Boolean).join(', ') || '';

        // Build category from OSM tags
        const category = el.tags.amenity || el.tags.tourism || el.tags.shop || el.tags.leisure || '';

        return {
          address: addr || name,
          latitude: elLat,
          longitude: elLng,
          place_name: name,
          full_address: addr,
          category,
          source: 'overpass' as const,
          specificity: computeSpecificity(name),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Search Cuba POIs from Supabase database.
 * Uses PostGIS spatial search + pg_trgm trigram similarity.
 * Much faster than Overpass (~50ms vs 2-10s) and handles ANY query.
 */
export async function searchPoisSupabase(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  limit = 10,
  externalSignal?: AbortSignal,
): Promise<SearchBoxResult[]> {
  try {
    const supabaseUrl =
      (typeof process !== 'undefined' && (
        process.env?.NEXT_PUBLIC_SUPABASE_URL ??
        process.env?.EXPO_PUBLIC_SUPABASE_URL
      )) || '';
    const supabaseKey =
      (typeof process !== 'undefined' && (
        process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY
      )) || '';
    if (!supabaseUrl || !supabaseKey) return [];

    const lat = proximity?.latitude ?? 23.1136;
    const lng = proximity?.longitude ?? -82.3666;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    // Abort internal controller when external signal fires
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timeout); return []; }
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/search_pois`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ query, lat, lng, radius_m: 30000, max_results: limit }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((r: Record<string, unknown>) => ({
      address: [r.address, r.neighborhood, r.city].filter(Boolean).join(', ') || (r.name as string),
      latitude: r.latitude as number,
      longitude: r.longitude as number,
      place_name: r.name as string,
      full_address: [r.address, r.neighborhood, r.city].filter(Boolean).join(', '),
      category: (r.subcategory as string) || (r.category as string) || '',
      source: 'supabase' as const,
      specificity: computeSpecificity(r.name as string),
    }));
  } catch {
    return [];
  }
}

/* ─── Viewport-Based POI Fetching ─── */

export interface ViewportPoi {
  id: number;
  name: string;
  category: string;
  subcategory: string;
  lat: number;
  lng: number;
  address: string | null;
  importance: number;
}

export async function fetchPoisInViewport(
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  zoom: number,
  signal?: AbortSignal,
): Promise<ViewportPoi[]> {
  try {
    const supabaseUrl =
      (typeof process !== 'undefined' && (
        process.env?.NEXT_PUBLIC_SUPABASE_URL ??
        process.env?.EXPO_PUBLIC_SUPABASE_URL
      )) || '';
    const supabaseKey =
      (typeof process !== 'undefined' && (
        process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
        process.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY
      )) || '';
    if (!supabaseUrl || !supabaseKey) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    if (signal) {
      if (signal.aborted) { clearTimeout(timeout); return []; }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/pois_in_viewport`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        min_lng: bounds.minLng,
        min_lat: bounds.minLat,
        max_lng: bounds.maxLng,
        max_lat: bounds.maxLat,
        zoom_level: Math.floor(zoom),
        max_results: 1500,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data as ViewportPoi[];
  } catch {
    return [];
  }
}
