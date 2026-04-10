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
 * Offset a coordinate by a random amount within the given radius.
 * Used to protect driver privacy during ride search — passengers
 * see an approximate position (~200 m) rather than exact location.
 *
 * @param lat  — latitude in degrees
 * @param lng  — longitude in degrees
 * @param radiusMeters — maximum offset (default 200 m)
 * @returns jittered { latitude, longitude }
 */
export function jitterLocation(
  lat: number,
  lng: number,
  radiusMeters = 200,
): GeoPoint {
  // Random angle in radians (0 – 2 PI)
  const angle = Math.random() * 2 * Math.PI;
  // Random distance between 50 % and 100 % of radius
  const dist = radiusMeters * (0.5 + Math.random() * 0.5);
  // 1 degree ≈ 111 320 m at the equator
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos((lat * Math.PI) / 180);

  return {
    latitude: lat + (dist * Math.sin(angle)) / metersPerDegreeLat,
    longitude: lng + (dist * Math.cos(angle)) / (metersPerDegreeLng || 1),
  };
}

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

/**
 * Project a point onto a polyline and return the position along the route.
 * Used for trip progress calculation (Uber-style progress bar).
 *
 * @param point  — current driver position
 * @param polyline — route geometry from OSRM/Mapbox
 * @returns segment index, projected point, and cumulative distance from route start
 */
export function projectPointOnPolyline(
  point: GeoPoint,
  polyline: GeoPoint[],
): { segmentIndex: number; projectedPoint: GeoPoint; distanceAlongRouteM: number } {
  if (polyline.length < 2) {
    return { segmentIndex: 0, projectedPoint: point, distanceAlongRouteM: 0 };
  }

  let bestDist = Infinity;
  let bestSegment = 0;
  let bestProjected: GeoPoint = polyline[0]!;
  let bestT = 0;

  // For each segment, find closest point on line segment to the given point
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;

    // Convert to approximate planar coords (meters) for projection
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const midLat = (a.latitude + b.latitude) / 2;
    const mPerDegLat = 111_320;
    const mPerDegLng = 111_320 * Math.cos(toRad(midLat));

    const ax = a.longitude * mPerDegLng;
    const ay = a.latitude * mPerDegLat;
    const bx = b.longitude * mPerDegLng;
    const by = b.latitude * mPerDegLat;
    const px = point.longitude * mPerDegLng;
    const py = point.latitude * mPerDegLat;

    // Compute parameter t = dot(AP, AB) / dot(AB, AB), clamped to [0, 1]
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const dotAB = abx * abx + aby * aby;

    let t = 0;
    if (dotAB > 0) {
      t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / dotAB));
    }

    // Projected point in planar coords
    const projX = ax + t * abx;
    const projY = ay + t * aby;

    // Distance from point to projected
    const dx = px - projX;
    const dy = py - projY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < bestDist) {
      bestDist = dist;
      bestSegment = i;
      bestT = t;
      bestProjected = {
        latitude: projY / mPerDegLat,
        longitude: projX / mPerDegLng,
      };
    }
  }

  // Calculate cumulative distance from route start to projected point
  let cumulativeM = 0;
  for (let i = 0; i < bestSegment; i++) {
    cumulativeM += haversineDistance(polyline[i]!, polyline[i + 1]!);
  }
  // Add partial segment distance
  cumulativeM += haversineDistance(polyline[bestSegment]!, bestProjected);

  return {
    segmentIndex: bestSegment,
    projectedPoint: bestProjected,
    distanceAlongRouteM: cumulativeM,
  };
}

/**
 * Average speeds in km/h per service type.
 * Calibrated for Cuban urban conditions:
 * - Narrow streets, potholes, long traffic lights
 * - Dense traffic in Havana center
 * - Triciclos limited to ~10-12 km/h actual
 */
export const AVG_SPEEDS: Record<ServiceTypeSlug, number> = {
  triciclo_basico: 10,
  triciclo_premium: 10,
  triciclo_cargo: 8,
  moto_standard: 22,
  auto_standard: 18,
  auto_confort: 20,
  mensajeria: 15,
};

/**
 * Estimate trip duration in seconds from road distance.
 * Only used as fallback when Mapbox/OSRM route fetch fails.
 * Includes 15% buffer for traffic lights, stops, and urban delays.
 */
export function estimateDuration(
  roadDistanceM: number,
  serviceType: ServiceTypeSlug,
): number {
  const speedKmh = AVG_SPEEDS[serviceType] ?? 10;
  const speedMs = (speedKmh * 1000) / 3600;
  const rawDuration = roadDistanceM / speedMs;
  // 15% buffer for traffic lights, stops, and urban delays
  const URBAN_DELAY_FACTOR = 1.15;
  return Math.round(rawDuration * URBAN_DELAY_FACTOR);
}

/**
 * Speed profiles (km/h) by distance tier for more accurate duration estimates.
 * - urban: dense city streets, traffic lights, narrow roads
 * - suburban: wider avenues, fewer stops, less congestion
 * - intercity: highways and main roads between cities
 * - null means vehicle type is not available for that tier (falls back to suburban)
 */
export const SPEED_PROFILES: Record<ServiceTypeSlug, { urban: number; suburban: number; intercity: number | null }> = {
  triciclo_basico:  { urban: 10, suburban: 12, intercity: null },
  triciclo_premium: { urban: 10, suburban: 12, intercity: null },
  triciclo_cargo:   { urban: 8,  suburban: 10, intercity: null },
  moto_standard:    { urban: 25, suburban: 40, intercity: 55 },
  auto_standard:    { urban: 20, suburban: 35, intercity: 50 },
  auto_confort:     { urban: 22, suburban: 38, intercity: 55 },
  mensajeria:       { urban: 15, suburban: 25, intercity: 40 },
};

/** Distance thresholds for speed tier blending */
const URBAN_THRESHOLD_M = 8_000;      // first 0-8 km at urban speed
const SUBURBAN_THRESHOLD_M = 35_000;  // next 8-35 km at suburban speed
const TRAFFIC_DELAY_FACTOR = 1.10;    // 10% buffer for stops, lights, congestion

/**
 * Calculate trip duration in seconds using tiered speed profiles.
 * Uses the REAL road distance from the routing API and splits it across
 * urban/suburban/intercity speed tiers for accurate estimates.
 *
 * Example (100 km, moto_standard):
 *   - First 8 km at 25 km/h (urban) = 1152s
 *   - Next 27 km at 40 km/h (suburban) = 2430s
 *   - Last 65 km at 55 km/h (intercity) = 4255s
 *   - Total: 7837s × 1.10 delay = 8621s (~144 min)
 */
export function calculateTripDuration(
  distanceM: number,
  serviceType: ServiceTypeSlug,
): number {
  if (distanceM <= 0) return 0;

  const profile = SPEED_PROFILES[serviceType] ?? SPEED_PROFILES.triciclo_basico;
  const urbanSpeedMs = (profile.urban * 1000) / 3600;
  const suburbanSpeedMs = (profile.suburban * 1000) / 3600;
  const intercitySpeed = profile.intercity ?? profile.suburban;
  const intercitySpeedMs = (intercitySpeed * 1000) / 3600;

  let totalSeconds = 0;
  let remaining = distanceM;

  // Tier 1: Urban (first 8 km)
  const urbanDist = Math.min(remaining, URBAN_THRESHOLD_M);
  totalSeconds += urbanDist / urbanSpeedMs;
  remaining -= urbanDist;

  // Tier 2: Suburban (8-35 km)
  if (remaining > 0) {
    const suburbanDist = Math.min(remaining, SUBURBAN_THRESHOLD_M - URBAN_THRESHOLD_M);
    totalSeconds += suburbanDist / suburbanSpeedMs;
    remaining -= suburbanDist;
  }

  // Tier 3: Intercity (35 km+)
  if (remaining > 0) {
    totalSeconds += remaining / intercitySpeedMs;
  }

  return Math.round(totalSeconds * TRAFFIC_DELAY_FACTOR);
}

/** Assumed average speed (km/h) of Mapbox/OSRM driving profile in urban Havana */
const MAPBOX_URBAN_AVG_KMH = 25;

/**
 * Adjust a raw car-based ETA (from Mapbox Matrix API) for a specific vehicle type.
 * Since pickup ETAs are short urban routes, uses the urban speed tier only.
 */
export function adjustETAForVehicle(
  rawDurationS: number,
  serviceType: ServiceTypeSlug,
): number {
  if (rawDurationS <= 0) return 0;
  const profile = SPEED_PROFILES[serviceType] ?? SPEED_PROFILES.triciclo_basico;
  const ratio = MAPBOX_URBAN_AVG_KMH / profile.urban;
  return Math.round(rawDurationS * ratio);
}

/**
 * Assumed average speed (km/h) of the Mapbox/OSRM "driving" profile.
 * Based on typical urban routing results for Havana (~30 km/h).
 * @deprecated Use calculateTripDuration() instead for accurate tiered duration.
 */
const ROUTING_API_ASSUMED_SPEED_KMH = 30;

/**
 * Adjust a route duration returned by a car-based routing API
 * to account for the actual average speed of a given vehicle type.
 * @deprecated Use calculateTripDuration(distanceM, serviceType) instead.
 */
export function adjustRouteDuration(
  routeDurationS: number,
  serviceType: ServiceTypeSlug,
): number {
  const vehicleSpeedKmh = AVG_SPEEDS[serviceType] ?? 10;
  const ratio = ROUTING_API_ASSUMED_SPEED_KMH / vehicleSpeedKmh;
  return Math.round(routeDurationS * ratio);
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
  const timeoutId = setTimeout(() => controller.abort(), 3000);
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

/* ─── Shared Mapbox Token Helper ─── */

function getMapboxToken(): string {
  return (typeof process !== 'undefined' && (
    process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
    process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
  )) || '';
}

/* ─── Geo Metadata (road, municipality, province, POI) ─── */

interface GeoMetadata {
  road: string;
  municipality: string;
  province: string;
  poiName: string;
}

/**
 * Strip common province prefixes: "provincia de La Habana" → "La Habana"
 * "Provincia de Santiago de Cuba" → "Santiago de Cuba"
 */
function cleanProvinceName(name: string): string {
  return name.replace(/^[Pp]rovincia\s+de\s+/i, '');
}

/**
 * Fetch address metadata from Mapbox Geocoding v6 reverse.
 * ~50-100ms, no throttle. Primary metadata source.
 */
async function fetchMetadataMapbox(lat: number, lng: number): Promise<GeoMetadata | null> {
  const token = getMapboxToken();
  if (!token) return null;

  const url =
    `https://api.mapbox.com/search/geocode/v6/reverse` +
    `?longitude=${lng}&latitude=${lat}&language=es&types=address,street&limit=1` +
    `&access_token=${token}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const feature = data?.features?.[0];
    if (!feature) return null;

    const props = feature.properties || {};
    const ctx = props.context || {};

    // Road name: street context > address street_name > feature name
    const road = ctx.street?.name || ctx.address?.street_name || '';
    // Municipality: locality (barrio/municipio) > place (city)
    const municipality = ctx.locality?.name || ctx.neighborhood?.name || ctx.place?.name || '';
    // Province: region, strip "provincia de" prefix
    const province = cleanProvinceName(ctx.region?.name || '');

    return { road, municipality, province, poiName: '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch address metadata from Nominatim reverse geocode.
 * ~200ms + 1.1s throttle. Fallback when Mapbox is unavailable.
 */
async function fetchMetadataNominatim(lat: number, lng: number): Promise<GeoMetadata | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es&zoom=18`;
  try {
    const res = await throttledFetch(url, NOMINATIM_HEADERS);
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data?.address || {};
    return {
      road: addr.road || addr.pedestrian || addr.footway || '',
      municipality: addr.city_district || addr.suburb || addr.neighbourhood || '',
      province: cleanProvinceName(addr.state || ''),
      poiName: data?.name || addr.amenity || addr.building || addr.tourism || addr.leisure || '',
    };
  } catch {
    return null;
  }
}

/* ─── OSRM Routing ─── */

/** Route cache: avoids re-fetching the same route within 5 minutes. */
const routeCache = new Map<string, { result: RouteResult; ts: number }>();
const ROUTE_CACHE_TTL = 5 * 60 * 1000; // 5 min
const ROUTE_CACHE_MAX = 30;

function routeCacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }): string {
  // ~50m precision: same intersection pair → cache hit
  return `${(from.lat ?? 0).toFixed(4)},${(from.lng ?? 0).toFixed(4)}_${(to.lat ?? 0).toFixed(4)},${(to.lng ?? 0).toFixed(4)}`;
}

/**
 * Fetch route via Mapbox Directions API (primary) with OSRM fallback.
 * Mapbox provides traffic-aware routing and more accurate ETAs.
 * Results are cached for 5 minutes to avoid redundant API calls.
 */
export async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  // Check cache first
  const key = routeCacheKey(from, to);
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) return cached.result;

  // Try Mapbox first (traffic-aware, better accuracy)
  const mapboxResult = await fetchRouteMapbox(from, to);
  if (mapboxResult) {
    if (routeCache.size >= ROUTE_CACHE_MAX) {
      const oldest = routeCache.keys().next().value;
      if (oldest) routeCache.delete(oldest);
    }
    routeCache.set(key, { result: mapboxResult, ts: Date.now() });
    return mapboxResult;
  }

  // Fallback to OSRM (free, no auth)
  const osrmResult = await fetchRouteOSRM(from, to);
  if (osrmResult) {
    if (routeCache.size >= ROUTE_CACHE_MAX) {
      const oldest = routeCache.keys().next().value;
      if (oldest) routeCache.delete(oldest);
    }
    routeCache.set(key, { result: osrmResult, ts: Date.now() });
  }
  return osrmResult;
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

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
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

    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
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
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
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
 * All inputs are (lat, lng). We convert to approximate meters BEFORE
 * computing the perpendicular projection so N-S and E-W distances
 * are weighted equally.
 */
function pointToSegmentDistanceM(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  // Convert to meters relative to point P so the projection is isotropic
  const cosLat = Math.cos(px * Math.PI / 180);
  const mPerDegLat = 111000;
  const mPerDegLng = 111000 * cosLat;

  // P in meters (origin)
  const pmx = 0, pmy = 0;
  // A in meters relative to P
  const amx = (ax - px) * mPerDegLat;
  const amy = (ay - py) * mPerDegLng;
  // B in meters relative to P
  const bmx = (bx - px) * mPerDegLat;
  const bmy = (by - py) * mPerDegLng;

  const dx = bmx - amx;
  const dy = bmy - amy;
  if (dx === 0 && dy === 0) {
    return Math.sqrt(amx * amx + amy * amy);
  }
  let t = ((pmx - amx) * dx + (pmy - amy) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const cx = amx + t * dx;
  const cy = amy + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

/**
 * Minimum distance from a point to a way (polyline) in meters.
 */
function minDistToWay(lat: number, lng: number, geom: Array<{ lat: number; lon: number }>): number {
  let min = Infinity;
  for (let i = 0; i < geom.length - 1; i++) {
    const d = pointToSegmentDistanceM(lat, lng, geom[i]!.lat, geom[i]!.lon, geom[i + 1]!.lat, geom[i + 1]!.lon);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Lookup pre-computed cross-streets from Supabase (instant, ~5-10ms).
 * Returns null if table is empty or no match within radius.
 */
export async function lookupCrossStreetsSupabase(
  lat: number,
  lng: number,
): Promise<{ mainStreet: string; crossStreets: string[]; municipality?: string; province?: string } | null> {
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
    if (!supabaseUrl || !supabaseKey) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/get_nearest_cross_streets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_lat: lat, p_lng: lng, p_radius_m: 150 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data) || data.length === 0) return null;

    const row = data[0];
    if (!row.main_street) return null;

    return {
      mainStreet: row.main_street,
      crossStreets: row.cross_streets || [],
      municipality: row.municipality || undefined,
      province: row.province || undefined,
    };
  } catch {
    return null; // Fallback to Overpass
  }
}

/**
 * Find the nearest named POI from Supabase cuba_pois table (~5-10ms).
 * Only returns user-recognizable POIs (shops, hotels, restaurants, etc.)
 * within 30m radius. Returns null if no POI nearby.
 */
async function lookupNearestPoi(
  lat: number,
  lng: number,
): Promise<string | null> {
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
    if (!supabaseUrl || !supabaseKey) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/nearest_poi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ p_lat: lat, p_lng: lng, p_radius_m: 30 }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data) || data.length === 0) return null;

    return data[0].name || null;
  } catch {
    return null;
  }
}

/**
 * Lookup intersection coordinates by street names from Supabase (~5ms).
 * Uses pre-computed street_intersections table instead of slow Overpass (~1-5s).
 * Returns null if no matching intersection found.
 */
export async function lookupIntersectionPoint(
  mainStreet: string,
  crossStreet1: string,
  crossStreet2?: string,
  proximity?: { latitude: number; longitude: number },
): Promise<{ address: string; latitude: number; longitude: number } | null> {
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
    if (!supabaseUrl || !supabaseKey) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/find_intersection_point`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        p_main: mainStreet,
        p_cross1: crossStreet1,
        p_cross2: crossStreet2 || null,
        p_lat: proximity?.latitude ?? 23.1136,
        p_lng: proximity?.longitude ?? -82.3666,
        p_radius_m: 5000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data) || data.length === 0) return null;

    const row = data[0];
    if (!row.latitude || !row.longitude) return null;

    return {
      address: row.address || `${mainStreet} y ${crossStreet1}`,
      latitude: row.latitude,
      longitude: row.longitude,
    };
  } catch {
    return null;
  }
}

/* ─── Cuban Address Parsing ─── */

export interface CubanParsed {
  main: string;
  cross1: string;
  cross2?: string;
  partial?: 'waiting_cross1' | 'waiting_cross2';
}

/**
 * Parse a Cuban-format address query into structured parts.
 * Supports "e/" and "entre" separators.
 *
 * Examples:
 *   "Castillo e/ Fernandina y Pila"  → { main: "Castillo", cross1: "Fernandina", cross2: "Pila" }
 *   "Reina entre Campanario y Lealtad" → { main: "Reina", cross1: "Campanario", cross2: "Lealtad" }
 *   "Castillo e/ "                    → { main: "Castillo", cross1: "", partial: "waiting_cross1" }
 *   "Reina entre Campanario"          → { main: "Reina", cross1: "Campanario", partial: "waiting_cross2" }
 */
export function parseCubanAddress(query: string): CubanParsed | null {
  let m: RegExpMatchArray | null;

  // COMPLETE: "X entre Y y Z" or "X e/ Y y Z"
  m = query.match(/^(.+?)\s+entre\s+(.+?)\s+y\s+(.+)$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), cross2: m[3]!.trim() };
  m = query.match(/^(.+?)\s+e\/\s*(.+?)\s+y\s+(.+)$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), cross2: m[3]!.trim() };

  // PARTIAL: "X entre Y y " or "X e/ Y y " (about to type cross2)
  m = query.match(/^(.+?)\s+entre\s+(.+?)\s+y\s*$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), partial: 'waiting_cross2' };
  m = query.match(/^(.+?)\s+e\/\s*(.+?)\s+y\s*$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), partial: 'waiting_cross2' };

  // PARTIAL: "X entre Y" (user still typing, waiting for " y Z")
  m = query.match(/^(.+?)\s+entre\s+(.+)$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), partial: 'waiting_cross2' };

  // PARTIAL: "X entre " or "X e/ " (waiting for cross1)
  m = query.match(/^(.+?)\s+entre\s*$/i);
  if (m) return { main: m[1]!.trim(), cross1: '', partial: 'waiting_cross1' };
  m = query.match(/^(.+?)\s+e\/\s*$/i);
  if (m) return { main: m[1]!.trim(), cross1: '', partial: 'waiting_cross1' };

  return null;
}

/**
 * Suggest cross-streets for a main street from Supabase (~5ms).
 * Uses pre-computed street_intersections table.
 * Replaces slow Overpass-based suggestCrossStreets() (~1-5s).
 */
export async function suggestCrossStreetsSupabase(
  mainStreet: string,
  proximity?: { latitude: number; longitude: number },
): Promise<string[]> {
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
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/suggest_cross_streets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        p_main: mainStreet,
        p_lat: proximity?.latitude ?? 23.1136,
        p_lng: proximity?.longitude ?? -82.3666,
        p_radius_m: 3000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data)) return [];

    return data.map((r: { cross_street: string }) => r.cross_street).filter(Boolean);
  } catch {
    return [];
  }
}

/* ─── Cross-street enrichment for search results ─── */

const STREET_PREFIXES = /^(calle|avenida|ave?\.?|calzada|callejón|paseo|carretera|autopista|boulevard|blvd|camino|sendero|pasaje)\s/i;

/**
 * Returns true if the address looks like a generic street (safe to enrich with cross-streets).
 * Returns false for named POIs (hotels, airports, restaurants) to avoid losing the name.
 */
export function isGenericStreetAddress(address: string): boolean {
  const trimmed = address.trim();
  if (STREET_PREFIXES.test(trimmed)) return true;
  if (trimmed.includes(' e/ ') || trimmed.includes(' entre ')) return false;
  if (/^\d+\s/.test(trimmed)) return true;
  return false;
}

/**
 * Fast enrichment: lookup cross-streets from Supabase (~5-10ms) and format as Cuban address.
 * Returns address string AND corrected coordinates (from intersection lookup).
 * Returns null if no cross-streets found (outside coverage, rural area, etc.).
 * Use this instead of full reverseGeocode() when you only need cross-street enrichment.
 */
export async function enrichWithCrossStreets(
  lat: number,
  lng: number,
): Promise<{ address: string; latitude: number; longitude: number } | null> {
  const result = await lookupCrossStreetsSupabase(lat, lng);
  if (!result || result.crossStreets.length === 0) return null;
  const { mainStreet, crossStreets, municipality, province } = result;
  let streetPart = mainStreet;
  if (crossStreets.length >= 2) {
    streetPart = `${mainStreet} e/ ${crossStreets[0]} y ${crossStreets[1]}`;
  } else if (crossStreets.length === 1) {
    streetPart = `${mainStreet} y ${crossStreets[0]}`;
  }
  const parts = [streetPart];
  if (municipality) parts.push(municipality);
  if (province && province !== municipality) parts.push(province);
  const address = parts.join(', ');

  // Resolve exact intersection coordinates from Supabase (~5ms)
  const intersection = await lookupIntersectionPoint(
    mainStreet,
    crossStreets[0] ?? '',
    crossStreets[1],
    { latitude: lat, longitude: lng },
  ).catch(() => null);

  return {
    address,
    latitude: intersection?.latitude ?? lat,
    longitude: intersection?.longitude ?? lng,
  };
}

/**
 * Get the dominant bearing (angle in degrees) of a way's geometry near a point.
 * Used to determine if two streets are crossing (perpendicular) vs parallel.
 */
function wayBearingNear(
  lat: number,
  lng: number,
  geom: Array<{ lat: number; lon: number }>,
): number {
  // Find the segment closest to the point
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < geom.length - 1; i++) {
    const d = pointToSegmentDistanceM(lat, lng, geom[i]!.lat, geom[i]!.lon, geom[i + 1]!.lat, geom[i + 1]!.lon);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  const cosLat = Math.cos(lat * Math.PI / 180);
  const dlat = (geom[bestIdx + 1]!.lat - geom[bestIdx]!.lat);
  const dlng = (geom[bestIdx + 1]!.lon - geom[bestIdx]!.lon) * cosLat;
  return Math.atan2(dlng, dlat) * 180 / Math.PI;
}

/**
 * Check if two bearings are "crossing" (angle difference > 25 degrees).
 * Bearings can be 0-360 or -180-180; we normalize the difference.
 */
function isCrossingAngle(bearing1: number, bearing2: number): boolean {
  let diff = Math.abs(bearing1 - bearing2) % 180;
  if (diff > 90) diff = 180 - diff;
  return diff > 25; // > 25° means they cross, not parallel
}

/**
 * Find the nearest street + cross streets using Overpass geometry.
 * Uses `out body geom` to get full way geometries, then calculates
 * which way is geometrically closest to the tap point = main street.
 * Cross streets must actually CROSS the main street (not be parallel).
 */
async function findNearestStreetAndCross(
  lat: number,
  lng: number,
): Promise<{ mainStreet: string; crossStreets: string[]; municipality?: string; province?: string } | null> {
  // 1. Check in-memory cache (0ms)
  const key = crossCacheKey(lat, lng);
  const cached = crossStreetCache.get(key);
  if (cached && cached.main && Date.now() - cached.ts < CROSS_CACHE_TTL) {
    return { mainStreet: cached.main, crossStreets: cached.streets };
  }

  // 2. Check Supabase pre-computed table (5-10ms)
  try {
    const supabaseResult = await lookupCrossStreetsSupabase(lat, lng);
    if (supabaseResult && supabaseResult.crossStreets.length > 0) {
      // Cache the Supabase result locally
      if (crossStreetCache.size >= CROSS_CACHE_MAX) {
        const oldest = crossStreetCache.keys().next().value;
        if (oldest) crossStreetCache.delete(oldest);
      }
      crossStreetCache.set(key, { main: supabaseResult.mainStreet, streets: supabaseResult.crossStreets, ts: Date.now() });
      return supabaseResult;
    }
  } catch { /* fallback to Overpass */ }

  // 3. Overpass fallback for areas not in pre-computed table (1-6s)
  const query = `[out:json][timeout:5];way(around:120,${lat},${lng})["highway"]["name"];out body geom;`;

  try {
    const data = await queryOverpassRace(query);
    if (!data?.elements?.length) return null;

    // Calculate distance and bearing from tap point to each way's geometry
    const waysWithInfo = data.elements
      .filter(el => el.tags?.name && el.geometry && el.geometry.length >= 2)
      .map(el => ({
        name: el.tags!.name!,
        dist: minDistToWay(lat, lng, el.geometry!),
        bearing: wayBearingNear(lat, lng, el.geometry!),
        geom: el.geometry!,
      }))
      .sort((a, b) => a.dist - b.dist);

    if (!waysWithInfo.length) return null;

    // Closest way = main street
    const mainWay = waysWithInfo[0]!;
    const mainStreet = mainWay.name;

    // Cross streets: different name AND crossing angle (not parallel)
    // First try strict crossing angle, then fall back to any different name
    const crossStreets: string[] = [];
    const seen = new Set<string>([mainStreet.toLowerCase()]);

    // Pass 1: Streets that truly cross (angle > 25°)
    for (const w of waysWithInfo) {
      if (crossStreets.length >= 2) break;
      const nameLower = w.name.toLowerCase();
      if (seen.has(nameLower)) continue;
      if (isCrossingAngle(mainWay.bearing, w.bearing)) {
        crossStreets.push(w.name);
        seen.add(nameLower);
      }
    }

    // Pass 2: If we still need more, accept any different name within 80m
    if (crossStreets.length < 2) {
      for (const w of waysWithInfo) {
        if (crossStreets.length >= 2) break;
        const nameLower = w.name.toLowerCase();
        if (seen.has(nameLower)) continue;
        if (w.dist <= 80) {
          crossStreets.push(w.name);
          seen.add(nameLower);
        }
      }
    }

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
  const query = `[out:json][timeout:5];way(around:120,${lat},${lng})["highway"]["name"];out tags;`;
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
 * Pattern: "street e/ cross1 y cross2, municipality, province"
 * POI is only included when we DON'T have cross-streets (i.e. the address is on a POI, not a street).
 * When cross-streets are present, the street address is specific enough — POI name is noise.
 */
function buildEnrichedAddress(
  streetPart: string,
  poiName: string,
  municipality: string,
  province: string,
): string {
  const parts: string[] = [];
  const hasCrossStreets = streetPart.includes(' e/ ') || streetPart.includes(' entre ');

  // Always include POI name when available (before street address)
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
 *
 * Pipeline (parallel):
 *   Supabase pre-computed cross-streets (~5-10ms)       ─┐
 *   Mapbox metadata (~50-100ms, Nominatim fallback)     ─┤── merge → address
 *   Supabase nearest POI (~5-10ms)                      ─┤
 *   Overpass fallback (only if Supabase misses, 1-6s)   ─┘
 *
 * Format: "Calle Principal e/ Cruz1 y Cruz2, Municipio, Provincia"
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    // 1. Run Supabase cross-streets + Mapbox metadata + POI lookup in parallel
    //    Mapbox: ~50-100ms | Supabase cross-streets: ~5-10ms | Supabase POI: ~5-10ms
    const [supabaseResult, metadata, nearestPoi] = await Promise.all([
      lookupCrossStreetsSupabase(lat, lng).catch(() => null),
      fetchMetadataMapbox(lat, lng)
        .then(r => r || fetchMetadataNominatim(lat, lng))
        .catch(() => null),
      lookupNearestPoi(lat, lng).catch(() => null),
    ]);

    const road = metadata?.road || '';
    const municipality = metadata?.municipality || '';
    const province = metadata?.province || '';
    const poiName = nearestPoi || metadata?.poiName || '';

    // 2. If Supabase has cross-streets, use them (instant path, ~100ms total)
    if (supabaseResult && supabaseResult.crossStreets.length > 0) {
      const { mainStreet, crossStreets } = supabaseResult;
      // Prefer Supabase admin data, fall back to Mapbox/Nominatim metadata
      const muni = supabaseResult.municipality || municipality;
      const prov = supabaseResult.province || province;

      let streetPart = mainStreet;
      if (crossStreets.length >= 2) {
        streetPart = `${mainStreet} e/ ${crossStreets[0]} y ${crossStreets[1]}`;
      } else if (crossStreets.length === 1) {
        streetPart = `${mainStreet} y ${crossStreets[0]}`;
      }
      return buildEnrichedAddress(streetPart, poiName, muni, prov);
    }

    // 3. Overpass fallback (for streets not in pre-computed table, 1-6s)
    try {
      let overpassTimer: ReturnType<typeof setTimeout>;
      const overpassResult = await Promise.race([
        findNearestStreetAndCross(lat, lng).then(r => { clearTimeout(overpassTimer); return r; }),
        new Promise<null>(resolve => { overpassTimer = setTimeout(() => resolve(null), 6000); }),
      ]);

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
    } catch { /* fall through to metadata-only */ }

    // 4. Last resort: road name from Mapbox/Nominatim only (no cross-streets)
    if (!metadata || !road) return null;

    return buildEnrichedAddress(road, poiName, municipality, province);
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
      point1 = { lat: nodes[0]!.lat!, lon: nodes[0]!.lon! };
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
      point1 = sorted[0]!;
      // Find the node that is farthest from point1 (= the other intersection)
      let maxDist = 0;
      point2 = sorted[1] ?? null;
      for (const n of sorted.slice(1)) {
        const d = haversineDistance({ latitude: point1.lat, longitude: point1.lon }, { latitude: n.lat, longitude: n.lon });
        if (d > maxDist) { maxDist = d; point2 = n; }
      }
    } else {
      // Just take the closest node
      point1 = { lat: nodes[0]!.lat!, lon: nodes[0]!.lon! };
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
