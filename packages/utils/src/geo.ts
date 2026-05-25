// ============================================================
// TriciGo — Geo Utilities
// Haversine distance, road estimates, and Havana location presets
// ============================================================

import type { ServiceTypeSlug } from '@tricigo/types';
// PR G — categorised debug logger; see packages/utils/src/mapLogger.ts.
import { mapLogger, formatBbox } from './mapLogger';

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
  if (!from || !to ||
      !Number.isFinite(from.latitude) || !Number.isFinite(from.longitude) ||
      !Number.isFinite(to.latitude) || !Number.isFinite(to.longitude)) {
    return 0;
  }
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
 * Perpendicular distance from a point to a polyline (meters).
 * Returns the shortest distance from the point to any segment of the line.
 * Used for "is the driver still on the planned route?" checks (BUG-279):
 * if the result exceeds a threshold (~50 m), the driver has deviated and
 * the polyline should be re-fetched from the new origin.
 *
 * Returns Infinity if the polyline has fewer than 2 points.
 */
export function distanceToPolyline(point: GeoPoint, polyline: GeoPoint[]): number {
  if (polyline.length < 2) return Infinity;
  const projection = projectPointOnPolyline(point, polyline);
  return haversineDistance(point, projection.projectedPoint);
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
 * Initial spherical bearing from `from` to `to` in degrees
 * (0=N, 90=E, 180=S, 270=W).
 *
 * Promoted from `apps/driver/src/hooks/useDriverLocation.ts` (BUG-267 v3)
 * so client RideMapView can reuse it for snap-to-road bearing (BUG-293).
 * The old copy in useDriverLocation took `(lat1, lng1, lat2, lng2)` positional
 * args; this exported version takes GeoPoint objects for consistency with
 * the other geo helpers (haversineDistance, projectPointOnPolyline, etc).
 */
export function bearingBetween(from: GeoPoint, to: GeoPoint): number {
  if (!from || !to) return 0;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dLambda = toRad(to.longitude - from.longitude);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Default smoothing factor for heading EMA. Lower = more inertia (smoother
 * but laggier on real turns); higher = more responsive (snappier but
 * noisier). 0.4 is calibrated for 1 Hz GPS updates in Cuban urban driving.
 */
// BUG-marker-lag (verified on-device with live console.log instrumentation
// on 2026-05-24): alpha=0.4 + DOUBLE EMA application (useDriverLocation
// hook + RideMapView component) produced 5-8s of visible lag in sharp
// turns — driver going NNW (338°) → ENE (72°), real heading was already
// 72° but renderized marker was still showing 10° for ~7 seconds.
// Raised to 0.7 so that:
//   - small jitter (≤5°) still softens (visually similar)
//   - medium changes (10-45°) converge in ~3 iters (3s) instead of 7
// Combined with the new snap-to-target branch in `smoothHeading` for
// large deltas (>45°), the perceptible lag drops to <1s.
export const HEADING_SMOOTHING_ALPHA = 0.7;

/**
 * Exponential moving average for heading angle, handling the 359° → 1°
 * wrap case via signed shortest-path delta.
 *
 * Used to dampen:
 *   - GPS heading jitter on slow / stationary drivers
 *   - Noise from short-distance bearing calcs (a bearing between two
 *     coords 2m apart has ±20° noise at typical urban GPS accuracy of
 *     5-10m — EMA smooths that into a stable signal).
 *   - Discrete jumps when `snapDriverToRoute` switches segments along a
 *     curved polyline (each segment has a fixed bearing; the jump
 *     between consecutive segments is visible as a "tick" in the marker
 *     rotation without smoothing).
 *
 * Promoted from `apps/driver/src/hooks/useDriverLocation.ts` (BUG-267 v3)
 * so RideMapView (driver + client) can reuse it to smooth `snapDriverToRoute`
 * bearings between segment changes (BUG-298).
 *
 * @param raw   incoming heading in degrees [0, 360)
 * @param prev  previous smoothed heading, or null for first sample
 * @param alpha smoothing factor in (0, 1]; defaults to `HEADING_SMOOTHING_ALPHA`
 * @returns smoothed heading in degrees [0, 360)
 */
export function smoothHeading(
  raw: number,
  prev: number | null,
  alpha: number = HEADING_SMOOTHING_ALPHA,
): number {
  if (prev === null || !Number.isFinite(prev)) return raw;
  let delta = raw - prev;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  // BUG-marker-lag: when the change is large (>45° in a single iter),
  // the driver clearly took a sharp turn — snap directly to the target
  // instead of interpolating across 7+ iterations. This eliminates the
  // visible "marker pointing wrong way" lag during sharp turns without
  // affecting the smoothness of small GPS jitter (≤45° still uses EMA).
  // Threshold 45° rationale: a 4-way intersection turn is 90°, so 45°
  // catches it cleanly; lane drift / GPS noise rarely exceeds 30°.
  if (Math.abs(delta) > 45) return raw;
  return (prev + alpha * delta + 360) % 360;
}

/**
 * BUG-293: snap a driver position to the nearest point on a route polyline
 * and return that segment's bearing.
 *
 * Used by client RideMapView (rider sees the driver) and driver RideMapView
 * (driver sees their own marker) so the vehicle icon visually tracks the
 * actual road, even when GPS drifts off-road. Common causes of drift:
 *   - Lockito Journey emits linear interpolation between journey points
 *     without following street geometry (mock GPS for QA).
 *   - Real GPS in dense urban areas under tree cover, near tall buildings,
 *     or in tunnels can be 10-30m off the real position.
 *   - Cuban GPS units, especially older Android devices, often have
 *     5-15m of static drift on stationary positions.
 *
 * The snap is purely display-side: `ride_location_events.{latitude,longitude}`
 * still stores the raw GPS for audit/analytics.
 *
 * If the driver is more than `maxDriftM` away from the polyline they have
 * genuinely departed the route (detour, reroute pending) — return `null`
 * so the caller falls back to the raw GPS coord (don't lie about where
 * the driver is when they really are elsewhere).
 */
export function snapDriverToRoute(
  driver: GeoPoint,
  polyline: GeoPoint[] | null | undefined,
  maxDriftM: number = 30,
): { latitude: number; longitude: number; bearing: number } | null {
  if (!polyline || polyline.length < 2) return null;
  if (!driver || !Number.isFinite(driver.latitude) || !Number.isFinite(driver.longitude)) return null;
  const proj = projectPointOnPolyline(driver, polyline);
  const drift = haversineDistance(driver, proj.projectedPoint);
  if (drift > maxDriftM) return null;
  const a = polyline[proj.segmentIndex]!;
  const b = polyline[proj.segmentIndex + 1] ?? a;
  return {
    latitude: proj.projectedPoint.latitude,
    longitude: proj.projectedPoint.longitude,
    bearing: bearingBetween(a, b),
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
  /**
   * Display label for the row. When set and different from `address` it
   * means the result is a POI with both a name (this field) AND a street
   * address (`address`); the dropdown renders two-line "Name / Address"
   * for that case. When omitted, the row is a plain street/intersection
   * and the dropdown renders single-line `address` only.
   */
  displayName?: string;
  /**
   * `tricigo_category` of the underlying POI when it came from
   * `search_pois_smart`. The dropdown uses this to pick a category
   * emoji icon. Optional — undefined for street rows and Mapbox
   * fallback rows.
   */
  tricigoCategory?: string | null;
  /**
   * PR 4b: original `SearchBoxResult` carried through from the
   * unified search call so the selection handler can fire-and-forget
   * `importPoiFromSearch` for Google-sourced rows. Always undefined
   * for Supabase/POI/street rows (already in cuba_pois) and for
   * cached/manual entries — those paths skip the import.
   */
  _src?: SearchBoxResult;
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

/** Returns true if the given lat/lng is within Cuba's geographic bounding box */
function isInCubaBox(lat: number, lng: number): boolean {
  return lat >= 19.5 && lat <= 23.5 && lng >= -85.0 && lng <= -74.0;
}

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

    // Validate result is geographically close to query point (<500m)
    const geom = feature.geometry;
    if (geom?.type === 'Point' && geom.coordinates) {
      const [resLng, resLat] = geom.coordinates;
      const distM = haversineDistance({ latitude: lat, longitude: lng }, { latitude: resLat, longitude: resLng });
      if (distM > 500) return null; // Result too far — discard
    }

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

/** Route cache: avoids re-fetching the same route within the TTL window. */
const routeCache = new Map<string, { result: RouteResult; ts: number }>();
// 30 min covers a single ride lifecycle (quote → pickup → active → complete)
// without re-fetching, since traffic in Cuba doesn't shift fast enough to
// invalidate a route polyline within that window.
const ROUTE_CACHE_TTL = 30 * 60 * 1000;
const ROUTE_CACHE_MAX = 500;

function routeCacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }): string {
  // ~1m precision (toFixed(5)). The previous setting was toFixed(3) (~110m
  // precision) which intentionally collapsed pickup points within the same
  // block — but that same collapse silently returned a STALE route when
  // the user switched the destination to a nearby POI (e.g. "Hospital
  // Hermanos Ameijeiras" → "Hotel Bruzón" in Centro Habana, ~80m apart).
  // The cached route from the first destination would come back, and so
  // would the fare estimate (since `getLocalFareEstimate` calls
  // `fetchRoute` for distance/duration). Result: changing the destination
  // appeared to do nothing.
  //
  // POI coords from `cuba_pois` are stable to the meter, saved locations
  // are stable, and GPS jitter on pickup is well below the 30-min TTL
  // anyway — so the lost cache hits from tighter precision are negligible
  // compared to the correctness fix.
  return `${(from.lat ?? 0).toFixed(5)},${(from.lng ?? 0).toFixed(5)}_${(to.lat ?? 0).toFixed(5)},${(to.lng ?? 0).toFixed(5)}`;
}

/**
 * Clear the in-memory route cache. Call this when the user explicitly
 * resets a ride draft (cancel, reset) or when you want to force the next
 * `fetchRoute` to hit OSRM/Mapbox fresh. Defense-in-depth on top of the
 * 1m-precision cache key.
 */
export function clearRouteCache(): void {
  const sizeBefore = routeCache.size;
  routeCache.clear();
  mapLogger.route({ event: 'cache_clear', endpoint: 'cache' });
  // Hint to QA: log size so we know whether the clear actually had impact.
  if (sizeBefore > 0 && typeof console !== 'undefined') {
    console.log('[clearRouteCache] cleared', sizeBefore, 'entries');
  }
}

/**
 * Fetch route via Mapbox Directions (primary) with OSRM public infra as a
 * free fallback when Mapbox is unreachable, unconfigured, or returns no
 * route.
 *
 * Order rationale (changed in PR C of routing fixes, 2026-05-25):
 *   OSRM public uses stock OSM data. Cuba's OSM coverage of one-way
 *   streets is incomplete — drivers reported the OSRM route taking them
 *   contra-flow on streets where the road signage clearly marks one
 *   direction. Mapbox Directions uses a proprietary data layer (OSM +
 *   HERE + manual corrections) that's significantly better-curated for
 *   Cuba, and the 30-min route cache keeps the marginal cost under
 *   ~$15/mo at 500 rides/day. OSRM remains as a hot fallback so a
 *   Mapbox outage or missing token doesn't kill the app entirely.
 */
export async function fetchRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): Promise<RouteResult | null> {
  const fromStr = `${from.lat.toFixed(4)},${from.lng.toFixed(4)}`;
  const toStr = `${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const key = routeCacheKey(from, to);
  const cached = routeCache.get(key);
  if (cached && Date.now() - cached.ts < ROUTE_CACHE_TTL) {
    mapLogger.route({
      event: 'cache_hit',
      endpoint: 'cache',
      distance_m: cached.result?.distance_m,
      duration_s: cached.result?.duration_s,
      from: fromStr,
      to: toStr,
    });
    return cached.result;
  }

  // Try Mapbox first (better Cuba one-way coverage)
  mapLogger.route({ event: 'fetch_start', endpoint: 'mapbox', from: fromStr, to: toStr });
  const startMapbox = Date.now();
  const mapboxResult = await fetchRouteMapbox(from, to);
  if (mapboxResult) {
    mapLogger.route({
      event: 'fetch_ok',
      endpoint: 'mapbox',
      latency_ms: Date.now() - startMapbox,
      distance_m: mapboxResult.distance_m,
      duration_s: mapboxResult.duration_s,
      from: fromStr,
      to: toStr,
    });
    if (routeCache.size >= ROUTE_CACHE_MAX) {
      const oldest = routeCache.keys().next().value;
      if (oldest) routeCache.delete(oldest);
    }
    routeCache.set(key, { result: mapboxResult, ts: Date.now() });
    return mapboxResult;
  }

  // Fallback to OSRM if Mapbox failed (no token, network, etc.)
  mapLogger.route({ event: 'fetch_start', endpoint: 'osrm', from: fromStr, to: toStr });
  const startOsrm = Date.now();
  const osrmResult = await fetchRouteOSRM(from, to);
  if (osrmResult) {
    mapLogger.route({
      event: 'fetch_ok',
      endpoint: 'osrm',
      latency_ms: Date.now() - startOsrm,
      distance_m: osrmResult.distance_m,
      duration_s: osrmResult.duration_s,
      from: fromStr,
      to: toStr,
    });
    if (routeCache.size >= ROUTE_CACHE_MAX) {
      const oldest = routeCache.keys().next().value;
      if (oldest) routeCache.delete(oldest);
    }
    routeCache.set(key, { result: osrmResult, ts: Date.now() });
  } else {
    mapLogger.route({
      event: 'fail',
      endpoint: 'unified',
      from: fromStr,
      to: toStr,
      error: 'both mapbox and osrm returned null',
    });
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
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
    const _ctrl = new AbortController();
    const _t = setTimeout(() => _ctrl.abort(), 4000);
    const res = await fetch(url, { signal: _ctrl.signal });
    clearTimeout(_t);
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

    const _ctrl2 = new AbortController();
    const _t2 = setTimeout(() => _ctrl2.abort(), 10000);
    const res = await fetch(url, { signal: _ctrl2.signal });
    clearTimeout(_t2);
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

    const _ctrl3 = new AbortController();
    const _t3 = setTimeout(() => _ctrl3.abort(), 10000);
    const res = await fetch(url, { signal: _ctrl3.signal });
    clearTimeout(_t3);
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
 * Cache for `lookupNearestPoi`. POIs at a given location don't move; we
 * quantize input coords to a ~50m cell so a dragged pin that lands within
 * the same cell as a previous query reuses the result. TTL 24h covers the
 * case of admin edits or sync runs adding/closing POIs without holding
 * onto stale data forever.
 *
 * Bounded at NEAREST_POI_CACHE_MAX entries, evicted oldest-first when
 * full so a long session of pin dragging doesn't grow memory unbounded.
 *
 * BUG-292: cache now stores both name AND distance_m so the consumer
 * (reverseGeocode) can decide whether to include the POI in the
 * address text based on proximity, not just existence.
 */
interface NearestPoi {
  name: string;
  distance_m: number;
}
const nearestPoiCache = new Map<string, { value: NearestPoi | null; ts: number }>();
const NEAREST_POI_CACHE_TTL = 24 * 60 * 60 * 1000;
const NEAREST_POI_CACHE_MAX = 1000;

/** Quantize a lat/lng to a ~50m grid cell for cache keys. */
function quantizeCell(lat: number, lng: number): string {
  // 1e-3 degrees ≈ 111 m; 1e-4 ≈ 11 m. Round to 4 decimals for ~11m
  // resolution then divide by 5 → ~55m cells (close enough to 50m).
  const cellLat = Math.round(lat * 10000 / 5);
  const cellLng = Math.round(lng * 10000 / 5);
  return `${cellLat},${cellLng}`;
}

/**
 * Find the nearest named POI from Supabase cuba_pois table (~5-10ms uncached,
 * 0ms on cache hit). Only returns user-recognizable POIs (shops, hotels,
 * restaurants, etc.) within 30m radius. Returns null if no POI nearby.
 *
 * BUG-292: returns BOTH name and distance_m (was returning just name).
 * `reverseGeocode` uses `distance_m` to decide whether to include the POI
 * in the final address text — the RPC `nearest_poi` has always returned
 * the column (see `supabase/migrations/00264_restore_dropped_geo_rpcs.sql:114`)
 * but we were discarding it, so any POI within 30m was being prefixed to
 * the address even when the pin clearly landed on the street.
 */
async function lookupNearestPoi(
  lat: number,
  lng: number,
): Promise<NearestPoi | null> {
  // Cache lookup: quantize to 50m cell so close pins share results
  const cacheKey = quantizeCell(lat, lng);
  const cached = nearestPoiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NEAREST_POI_CACHE_TTL) {
    return cached.value;
  }

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

    // 00264: nearest_poi was dropped in 00207's "dead RPC" sweep but the
    // helper kept calling it (404s in console). The newer
    // lookup_nearest_poi (00248) is NOT a transparent replacement: its
    // category whitelist drops healthcare, sport, craft, aeroway and
    // emergency — so hospitals, gyms, fire stations etc. would no
    // longer surface as POI labels in reverse geocoding. 00264 restores
    // the original nearest_poi function so we can keep using it here.
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
    const first = data && Array.isArray(data) && data.length > 0 ? data[0] : null;
    // PostgREST sometimes serialises numerics as strings — coerce + validate.
    const rawDist = first ? Number(first.distance_m) : NaN;
    const value: NearestPoi | null = (first && first.name && Number.isFinite(rawDist))
      ? { name: first.name as string, distance_m: rawDist }
      : null;

    // Evict oldest entry if cache is full (insertion-order LRU)
    if (nearestPoiCache.size >= NEAREST_POI_CACHE_MAX) {
      const oldest = nearestPoiCache.keys().next().value;
      if (oldest !== undefined) nearestPoiCache.delete(oldest);
    }
    nearestPoiCache.set(cacheKey, { value, ts: Date.now() });

    return value;
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

  // PARTIAL: "X entre Y" or "X e/ Y" (user still typing, waiting for " y Z")
  m = query.match(/^(.+?)\s+entre\s+(.+)$/i);
  if (m) return { main: m[1]!.trim(), cross1: m[2]!.trim(), partial: 'waiting_cross2' };
  m = query.match(/^(.+?)\s+e\/\s*(.+)$/i);
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
 * Top-level cache for `reverseGeocode`. Keyed by ~50m cell so a dragged
 * pin that wobbles within the same cell skips the whole pipeline (Supabase
 * cross-streets + Mapbox metadata + nearest POI + Overpass fallback).
 * TTL 24h is short enough to pick up admin POI edits the next session and
 * long enough to absorb the chatter of a single ride confirmation flow.
 *
 * Note: the sub-functions (`lookupCrossStreetsSupabase`, `lookupNearestPoi`,
 * Mapbox metadata) each have their own caches at finer granularity, but
 * caching the merged final string saves the merge cost too.
 */
const reverseGeocodeCache = new Map<string, { result: string | null; ts: number }>();
const REVERSE_GEOCODE_CACHE_TTL = 24 * 60 * 60 * 1000;
const REVERSE_GEOCODE_CACHE_MAX = 1000;

/**
 * BUG-292 — POI proximity threshold for address-text inclusion.
 *
 * The `nearest_poi` RPC returns POIs within a 30m radius (radio del RPC
 * configurado en línea ~1218). Pero un usuario que arrastra la pin en
 * `ConfirmLocationScreen` típicamente NO quiere ver "Capitolio Nacional,
 * Calle Brasil" cuando marcó la calle Brasil enfrente del Capitolio.
 *
 * Solo incluimos el nombre del POI en el texto de address si el centro
 * de la pin está MUY cerca (≤15m). Para distancias entre 15-30m, el
 * RPC sigue devolviendo el POI pero acá lo descartamos: el usuario
 * apuntó a la calle, no al POI.
 *
 * Tuning notes (validado QA Round 3):
 *  - 10m: muy estricto, requiere estar literal en la puerta del POI.
 *  - 15m: balanceado, captura entrance + acera adyacente.            ← actual
 *  - 20m: permisivo, captura POIs grandes (Capitolio = ~80m de largo,
 *         estadios). Subir si en QA aparecen falsos negativos.
 */
const POI_INCLUSION_THRESHOLD_M = 15;

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
 *
 * Cached in-memory for 24h keyed on a ~50m grid cell (see
 * `reverseGeocodeCache`). Subsequent drags within the same cell return
 * instantly with zero network — important on Cuban networks where each
 * full pipeline call costs ~150ms and ~5KB.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  // Validate coordinates are finite numbers
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  // Cache lookup
  const cacheKey = quantizeCell(lat, lng);
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < REVERSE_GEOCODE_CACHE_TTL) {
    return cached.result;
  }

  // Wrap every successful resolution path so the merged label gets memoized
  // in the cache before being returned. The four exit points (cross-streets,
  // Overpass, metadata-only, and the catch-all null) all funnel through here.
  const cacheAndReturn = (result: string | null): string | null => {
    if (reverseGeocodeCache.size >= REVERSE_GEOCODE_CACHE_MAX) {
      const oldest = reverseGeocodeCache.keys().next().value;
      if (oldest !== undefined) reverseGeocodeCache.delete(oldest);
    }
    reverseGeocodeCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  };

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
    // BUG-292: only include the Supabase nearest POI if it's within the
    // proximity threshold. Distance comes precomputed from the RPC
    // (ST_Distance on geography — exact, not approximate). If the POI is
    // farther than the threshold we fall back to Mapbox's `poiName`
    // (which is already heuristic-ranked by Mapbox, not radius-based).
    const supabasePoiName =
      nearestPoi && nearestPoi.distance_m <= POI_INCLUSION_THRESHOLD_M
        ? nearestPoi.name
        : '';
    const poiName = supabasePoiName || metadata?.poiName || '';

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
      return cacheAndReturn(buildEnrichedAddress(streetPart, poiName, muni, prov));
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
        return cacheAndReturn(buildEnrichedAddress(streetPart, poiName, municipality, province));
      }
    } catch { /* fall through to metadata-only */ }

    // 4. Last resort: road name from Mapbox/Nominatim only (no cross-streets)
    if (!metadata || !road) return cacheAndReturn(null);

    return cacheAndReturn(buildEnrichedAddress(road, poiName, municipality, province));
  } catch {
    return cacheAndReturn(null);
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
    const _ctrl4 = new AbortController();
    const _t4 = setTimeout(() => _ctrl4.abort(), 5000);
    const res = await fetch(url, { signal: _ctrl4.signal });
    clearTimeout(_t4);
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
 * Geocoding cache. Addresses don't change, so keeping autocomplete results
 * for ~7 days is safe. The previous implementation had no cache at all and
 * fired one Mapbox request per keystroke → at TriciGo volume that was the
 * single biggest line on the Mapbox bill (~$225/mo at 500 rides/day).
 *
 * Key normalization: lowercase + trim + collapse whitespace. Proximity is
 * rounded to ~11km (toFixed(1)) so the same query nearby reuses the result;
 * the search results are typed enough that exact-meter precision isn't
 * needed to keep them relevant.
 */
const geocodeCache = new Map<string, { results: AddressSearchResult[]; ts: number }>();
const GEOCODE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const GEOCODE_CACHE_MAX = 500;

function geocodeCacheKey(
  query: string,
  proximity: { latitude: number; longitude: number } | null,
  limit: number,
): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const prox = proximity
    ? `${proximity.latitude.toFixed(1)},${proximity.longitude.toFixed(1)}`
    : 'none';
  return `${normalized}|${prox}|${limit}`;
}

/**
 * Search for addresses using Mapbox Geocoding v6 API.
 * Faster (~200ms) and better POI coverage than Nominatim. No rate limit.
 *
 * Cached in-memory for 7 days (see `geocodeCache` above). The cache is
 * keyed on normalized query + rounded proximity + limit, so identical
 * autocomplete queries (very common: same user typing "calle 23" twice
 * within a session, or two riders looking up "habana vieja") cost zero
 * Mapbox requests after the first hit.
 */
export async function searchAddressMapbox(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  limit = 5,
): Promise<AddressSearchResult[]> {
  // Cache lookup
  const key = geocodeCacheKey(query, proximity, limit);
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.ts < GEOCODE_CACHE_TTL) return cached.results;

  try {
    const token =
      (typeof process !== 'undefined' && (
        process.env?.EXPO_PUBLIC_MAPBOX_TOKEN ??
        process.env?.NEXT_PUBLIC_MAPBOX_TOKEN
      )) || '';
    if (!token) return [];

    const inCuba = proximity ? isInCubaBox(proximity.latitude, proximity.longitude) : true;
    const params = new URLSearchParams({
      q: query,
      language: 'es',
      limit: String(limit),
      access_token: token,
    });
    if (inCuba) {
      params.set('country', 'cu');
    }
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

    const results = features.map((f: Record<string, unknown>) => {
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

    // Only cache positive results — caching `[]` would freeze a one-off
    // transient failure (network blip, Mapbox 5xx) into a 7-day "no
    // results" answer for a query that's actually valid. The trade-off
    // is that genuinely empty queries re-request, but those are rare
    // (users don't typically retype the same misspelling) and cheap
    // (Mapbox returns 200 with [] fast).
    if (results.length > 0) {
      if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
        const oldest = geocodeCache.keys().next().value;
        if (oldest) geocodeCache.delete(oldest);
      }
      geocodeCache.set(key, { results, ts: Date.now() });
    }

    return results;
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
  source: 'searchbox' | 'nominatim' | 'overpass' | 'supabase' | 'google' | 'mapbox';
  specificity: number; // 0-1: 1 = unique named POI, 0 = generic
  /**
   * Smart-search metadata (only populated when the row came from
   * `search_pois_smart`). The cliente uses these to:
   *   - Pick a category emoji icon
   *   - Suppress unrelated street results when the user typed a
   *     category keyword (e.g. typing "Bar" should not return streets
   *     starting with "Bar*")
   */
  matchedCategory?: string | null;       // tricigo_category detected from query
  matchReason?: 'name_exact' | 'name_prefix' | 'name_substring' | 'category_only';
  tricigoCategory?: string | null;       // category of the actual row
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
 * Map a `tricigo_category` value (returned by `search_pois_smart`) to
 * an emoji icon. Used by the search dropdown and the on-map POI layer
 * to render category at a glance \u2014 emoji renders the same on Android,
 * iOS and the web admin panel without bundling extra icon fonts.
 *
 * Falls back to a generic pin when the category is unknown / null.
 */
export function tricigoCategoryEmoji(category?: string | null): string {
  switch (category) {
    case 'hospital':    return '\ud83c\udfe5';
    case 'pharmacy':    return '\ud83d\udc8a';
    case 'school':      return '\ud83c\udfeb';
    case 'gov':         return '\ud83c\udfdb\ufe0f';
    case 'hotel':       return '\ud83c\udfe8';
    case 'restaurant':  return '\ud83c\udf7d\ufe0f';
    case 'paladar':     return '\ud83c\udf74';
    case 'cafe':        return '\u2615';
    case 'bar':         return '\ud83c\udf7a';
    case 'supermarket': return '\ud83d\uded2';
    case 'shop':        return '\ud83d\udecd\ufe0f';
    case 'bank':        return '\ud83c\udfe6';
    case 'atm':         return '\ud83c\udfe7';
    case 'gas_station': return '\u26fd';
    case 'museum':      return '\ud83d\uddbc\ufe0f';
    case 'park':        return '\ud83c\udf33';
    case 'beach':       return '\ud83c\udfd6\ufe0f';
    case 'embassy':     return '\ud83d\udec2';
    case 'religion':    return '\u26ea';
    case 'transport':   return '\ud83d\ude8c';
    default:            return '\ud83d\udccd';
  }
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

// ============================================================
// PR 4 of POI parity — Google Places search + unified orchestrator
//
// `searchAddressGoogle` proxies through the Edge Function so the API key
// stays server-side. The EF handles caching (30d), budget capping (1000
// calls/day), and graceful fallback to Mapbox when Google is unavailable
// or unconfigured.
//
// `searchAddressUnified` is the new entry point callers should use:
// it tries Google first, then Mapbox SearchBox as fallback. Each result
// carries its `source` so the UI can render proper attribution.
// ============================================================

// Structural shape matching the @supabase/supabase-js Client.functions.invoke
// signature. We use a loose `body: any` so callers can pass any JSON
// payload without forcing them to convert to FormData / string first
// (Supabase's strict body type union doesn't help us).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface SupabaseClientLike {
  functions: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoke: (name: string, opts: { body?: any }) => PromiseLike<{
      data: unknown;
      error: { message: string } | null;
    }>;
  };
}

/**
 * Calls the search-places-google Edge Function. Returns:
 *   - SearchBoxResult[] with source='google' on success
 *   - [] when the EF says fallback OR when proxy errors
 *
 * Caller (searchAddressUnified) interprets [] as a cue to try Mapbox.
 *
 * The EF responds with a JSON body containing data + (optional) fallback
 * indicator. We surface the data to the caller and silently honour the
 * fallback hint by returning [].
 */
export async function searchAddressGoogle(
  query: string,
  supabase: SupabaseClientLike | null,
  proximity: { latitude: number; longitude: number } | null = null,
  signal?: AbortSignal,
  limit = 10,
): Promise<SearchBoxResult[]> {
  if (!supabase || !query || query.trim().length < 2) return [];
  // signal-aware short-circuit: if caller already aborted, don't fire
  if (signal?.aborted) return [];

  try {
    const { data, error } = await supabase.functions.invoke('search-places-google', {
      body: {
        query: query.trim(),
        proximity: proximity ?? undefined,
        limit,
      },
    });

    if (error) {
      // EF failure — caller will fall back to Mapbox
      return [];
    }

    const payload = data as {
      data?: Array<Partial<SearchBoxResult> & { latitude?: number; longitude?: number }>;
      fallback?: 'mapbox';
      reason?: string;
    } | null;

    if (!payload || !Array.isArray(payload.data) || payload.fallback) {
      return [];
    }

    return payload.data
      .filter((r) => typeof r.latitude === 'number' && typeof r.longitude === 'number')
      .map((r) => ({
        address: r.address ?? '',
        latitude: r.latitude as number,
        longitude: r.longitude as number,
        place_name: r.place_name ?? r.address ?? '',
        full_address: r.address ?? '',
        category: r.matchedCategory ?? '',
        source: 'google' as const,
        specificity: typeof r.specificity === 'number' ? r.specificity : 0.95,
        matchedCategory: r.matchedCategory ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * Unified address search — Google first, Mapbox SearchBox as fallback.
 * This is the function new callers should use; legacy callers can keep
 * using `searchAddressSearchBox` directly if they don't want Google.
 *
 * Pass `supabase=null` to skip the Google attempt entirely (useful for
 * apps without a configured Supabase client at the search site, or for
 * graceful degradation).
 */
export async function searchAddressUnified(
  query: string,
  supabase: SupabaseClientLike | null,
  proximity: { latitude: number; longitude: number } | null = null,
  signal?: AbortSignal,
  limit = 10,
): Promise<SearchBoxResult[]> {
  // Try Google first — it has the best Cuban coverage for the long-tail
  // of mypimes / paladares / kioscos that aren't in OSM/Mapbox.
  mapLogger.search({ query, provider: 'google', count: 0, stage: 'fire' });
  const startGoogle = Date.now();
  const googleResults = supabase
    ? await searchAddressGoogle(query, supabase, proximity, signal, limit)
    : [];
  mapLogger.search({
    query,
    provider: 'google',
    count: googleResults.length,
    latency_ms: Date.now() - startGoogle,
    stage: 'resolve',
  });
  if (googleResults.length > 0) return googleResults;

  // Fallback to Mapbox SearchBox (the existing implementation)
  mapLogger.search({ query, provider: 'mapbox', count: 0, stage: 'fire', fallback: true });
  const startMapbox = Date.now();
  const mapboxResults = await searchAddressSearchBox(query, proximity, signal, limit);
  mapLogger.search({
    query,
    provider: 'mapbox',
    count: mapboxResults.length,
    latency_ms: Date.now() - startMapbox,
    stage: 'resolve',
    fallback: true,
  });
  // Re-tag mapbox results so the UI shows the right attribution
  return mapboxResults.map((r) => ({ ...r, source: 'mapbox' as const }));
}

// ============================================================
// PR 4b — Mapbox-backed POI growth on search-select
//
// Background fire-and-forget. After a user SELECTS a Google search
// result, we look the same place up on Mapbox SearchBox and persist
// it to cuba_pois (source='mapbox') via the import-mapbox-poi Edge
// Function. Google Maps Platform TOS forbids storing/displaying
// Google data; Mapbox SearchBox explicitly allows it — so the map
// can show the pin to every other user without any Google
// attribution.
//
// This function NEVER throws and NEVER blocks the UX. Skips when
// the result is already from Mapbox or Supabase (nothing to import).
// ============================================================
/**
 * Fire-and-forget. Triggers Mapbox lookup for the just-selected
 * search result and persists it to cuba_pois (source='mapbox') if
 * not already present. Resolves immediately on caller side; the
 * actual Edge Function call happens async. Never rejects.
 *
 * Skipped when:
 *  - `supabase` is null (no client available at the call site)
 *  - `result.source === 'mapbox'` (already from Mapbox)
 *  - `result.source === 'supabase'` (already in cuba_pois)
 */
export async function importPoiFromSearch(
  result: SearchBoxResult,
  supabase: SupabaseClientLike | null,
): Promise<void> {
  if (!supabase) return;
  if (result.source === 'mapbox' || result.source === 'supabase') return;
  if (!result.place_name || !result.latitude || !result.longitude) return;

  const start = Date.now();
  mapLogger.poiSubmit({
    event: 'submit',
    name: result.place_name,
    lat: result.latitude,
    lng: result.longitude,
    app: 'client',
  });
  try {
    const { data, error } = await supabase.functions.invoke('import-mapbox-poi', {
      body: {
        query: result.place_name,
        proximity: { lat: result.latitude, lng: result.longitude },
        google_result: {
          place_name: result.place_name,
          address: result.address ?? result.full_address ?? '',
          latitude: result.latitude,
          longitude: result.longitude,
        },
      },
    });
    if (error) {
      mapLogger.poiSubmit({
        event: 'reject',
        name: result.place_name,
        lat: result.latitude,
        lng: result.longitude,
        app: 'client',
        latency_ms: Date.now() - start,
        reject_reason: 'ef_invoke_error',
        error: String(error.message ?? error),
      });
      return;
    }
    const payload = (data ?? {}) as { imported?: boolean; mapbox_found?: boolean; reason?: string };
    mapLogger.poiSubmit({
      event: payload.imported ? 'success' : 'reject',
      name: result.place_name,
      lat: result.latitude,
      lng: result.longitude,
      app: 'client',
      latency_ms: Date.now() - start,
      reject_reason: payload.imported ? undefined : payload.reason ?? 'unknown',
    });
  } catch (err) {
    // Silent — fire-and-forget. Visibility via EF logs.
    mapLogger.poiSubmit({
      event: 'reject',
      name: result.place_name,
      lat: result.latitude,
      lng: result.longitude,
      app: 'client',
      latency_ms: Date.now() - start,
      reject_reason: 'throw',
      error: String(err instanceof Error ? err.message : err),
    });
  }
}

// ============================================================
// PR F (2026-05-25) — dedupeSearchResults
//
// When the search dropdown surfaces results from BOTH Google Places
// (via searchAddressUnified) AND cuba_pois (searchPoisSupabase), we
// need to drop the duplicates so the user doesn't see two rows for
// the same place. Google goes first (the user explicitly chose this
// ordering on 2026-05-25 after the airport bug); cuba_pois rows that
// match a Google result are silently dropped.
//
// Match criteria (either is sufficient to call it a dupe):
//   - coordinate distance <= COORD_DEDUP_RADIUS_M (≈ 100 m)
//   - normalized name token overlap >= NAME_DEDUP_THRESHOLD (≈ 0.7)
//
// The function is intentionally generic — it takes a primary array
// (the side that wins on conflict) and a secondary array (the side
// that gets filtered). Returns the secondary array minus dupes,
// in original order so the caller can concatenate [primary, ...kept].
// ============================================================

const COORD_DEDUP_RADIUS_M = 100;
const NAME_DEDUP_THRESHOLD = 0.7;

function normalizeForDedup(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 1);
}

function tokenOverlapRatio(a: string, b: string): number {
  const ta = new Set(normalizeForDedup(a));
  const tb = new Set(normalizeForDedup(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  ta.forEach((t) => { if (tb.has(t)) hits++; });
  return hits / Math.max(ta.size, tb.size);
}

/**
 * Drop entries from `secondary` that duplicate any entry in `primary`.
 * A "duplicate" matches either by coordinate proximity (<=100 m) OR
 * by name token overlap (>=0.7). Returns the surviving secondary
 * entries in their original order.
 *
 * Used by AddressSearchInput / AddressSearchBar / AddressAutocomplete
 * to suppress cuba_pois rows that already appear in Google search
 * results above them.
 */
export function dedupeSearchResults<T extends {
  latitude: number;
  longitude: number;
  place_name?: string;
  address?: string;
}>(
  primary: ReadonlyArray<T>,
  secondary: ReadonlyArray<T>,
): T[] {
  if (primary.length === 0 || secondary.length === 0) return [...secondary];

  const survivors = secondary.filter((sec) => {
    for (const pri of primary) {
      // Coord-distance check
      const meters = haversineDistance(
        { latitude: sec.latitude, longitude: sec.longitude },
        { latitude: pri.latitude, longitude: pri.longitude },
      );
      if (meters <= COORD_DEDUP_RADIUS_M) {
        // Coordinates match — also do a quick name sanity check so we
        // don't dedupe a cafe and a bank that happen to be on the same
        // street corner. If names are completely unrelated keep both.
        const nameA = sec.place_name ?? sec.address ?? '';
        const nameB = pri.place_name ?? pri.address ?? '';
        if (tokenOverlapRatio(nameA, nameB) >= 0.3) return false;
      }
      // Pure name match (works when one source lacks precise coords)
      const nameA = sec.place_name ?? sec.address ?? '';
      const nameB = pri.place_name ?? pri.address ?? '';
      if (tokenOverlapRatio(nameA, nameB) >= NAME_DEDUP_THRESHOLD) {
        // Names strongly match — also require proximity (< 5 km) to
        // avoid deduping "Bar El Rincón" in Habana vs Santiago.
        const meters = haversineDistance(
          { latitude: sec.latitude, longitude: sec.longitude },
          { latitude: pri.latitude, longitude: pri.longitude },
        );
        if (meters <= 5000) return false;
      }
    }
    return true;
  });

  const droppedCount = secondary.length - survivors.length;
  if (droppedCount > 0) {
    // Surface dedupe activity so QA can confirm Google → cuba_pois
    // overlap suppression actually fires (PR F regression guard).
    mapLogger.search({
      query: '<dedupe>',
      provider: 'cuba_pois',
      count: survivors.length,
      deduped: droppedCount,
    });
  }
  return survivors;
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
 * In-memory cache for `searchPoisSupabase`. Same shape as the Mapbox
 * geocode cache — keyed on normalized query + rounded proximity + limit.
 * TTL 24h is shorter than the address cache (7d) because POIs can be
 * edited by admin or deactivated by the monthly sync more frequently
 * than street names change.
 */
const poisSearchCache = new Map<string, { results: SearchBoxResult[]; ts: number }>();
const POIS_SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000;
const POIS_SEARCH_CACHE_MAX = 300;

function poisSearchCacheKey(
  query: string,
  proximity: { latitude: number; longitude: number } | null,
  limit: number,
): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const prox = proximity
    ? `${proximity.latitude.toFixed(1)},${proximity.longitude.toFixed(1)}`
    : 'none';
  return `${normalized}|${prox}|${limit}`;
}

/**
 * Search Cuba POIs from Supabase database.
 * Uses PostGIS spatial search + pg_trgm trigram similarity.
 * Much faster than Overpass (~50ms vs 2-10s) and handles ANY query.
 *
 * Cached in-memory for 24h. Same query within ~11km reuses the result.
 * Saves bandwidth on repetitive autocomplete sessions ("ho" → "hos" →
 * "hosp" each return the same superset; the cache key normalizes the
 * stem so 80%+ of intra-session queries are cache hits).
 */
export async function searchPoisSupabase(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  limit = 10,
  externalSignal?: AbortSignal,
): Promise<SearchBoxResult[]> {
  // Cache lookup
  const cacheKey = poisSearchCacheKey(query, proximity, limit);
  const cached = poisSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < POIS_SEARCH_CACHE_TTL) {
    return cached.results;
  }

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
    // search_pois_smart (migration 00255) supersedes the legacy search_pois:
    //   - Detects category intent via Spanish/Cuban-vernacular keyword
    //     dictionary (longest-prefix match on `cuba_search_keywords`).
    //   - Mixes name matches (cross-category) with category-only matches.
    //   - Sinks generic-name placeholders ("Bar", "Restaurante" alone)
    //     to the bottom server-side, so we don't have to re-rank here.
    //   - Returns `matched_category`, `match_reason`, `tricigo_category`
    //     which the cliente uses to suppress unrelated streets.
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/search_pois_smart`, {
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

    const results: SearchBoxResult[] = data.map((r: Record<string, unknown>) => {
      const name = (r.name as string) || '';
      const matchReason = r.match_reason as SearchBoxResult['matchReason'];
      // The smart RPC already orders generic-name placeholders to the
      // bottom, but we still need a per-row `specificity` for callers
      // that do their own merge logic. Treat name_exact + category-only
      // matches against a detected category keyword as low-specificity
      // (they are the OSM "Bar"/"Restaurante" placeholder rows).
      let specificity = computeSpecificity(name);
      if (matchReason === 'name_exact' && r.matched_category) {
        specificity = Math.min(specificity, 0.2);
      } else if (matchReason === 'category_only') {
        // Real category match with a proper name — high signal.
        specificity = Math.max(specificity, 0.8);
      }
      return {
        address: [r.address, r.municipality, r.province].filter(Boolean).join(', ') || name,
        latitude: r.latitude as number,
        longitude: r.longitude as number,
        place_name: name,
        full_address: [r.address, r.municipality, r.province].filter(Boolean).join(', '),
        category: (r.subcategory as string) || (r.category as string) || '',
        source: 'supabase' as const,
        specificity,
        matchedCategory: (r.matched_category as string | null) ?? null,
        matchReason,
        tricigoCategory: (r.tricigo_category as string | null) ?? null,
      };
    });

    // Populate cache (LRU eviction when full)
    if (poisSearchCache.size >= POIS_SEARCH_CACHE_MAX) {
      const oldest = poisSearchCache.keys().next().value;
      if (oldest !== undefined) poisSearchCache.delete(oldest);
    }
    poisSearchCache.set(cacheKey, { results, ts: Date.now() });

    return results;
  } catch {
    return [];
  }
}

/**
 * Search street names in the street_intersections table.
 * Returns streets matching the query with their closest intersection, sorted by relevance + proximity.
 */
export async function searchStreetsSupabase(
  query: string,
  proximity: { latitude: number; longitude: number } | null = null,
  limit = 10,
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
    if (!supabaseUrl || !supabaseKey || query.length < 2) return [];

    const lat = proximity?.latitude ?? 23.1136;
    const lng = proximity?.longitude ?? -82.3666;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/search_streets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ query, lat, lng, max_results: limit }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data.map((r: Record<string, unknown>) => ({
      address: [r.address, r.municipality, r.province].filter(Boolean).join(', '),
      latitude: r.latitude as number,
      longitude: r.longitude as number,
      place_name: r.name as string,
      full_address: [r.address, r.municipality, r.province].filter(Boolean).join(', '),
      category: 'street',
      source: 'supabase' as const,
      specificity: computeSpecificity(r.name as string),
    }));
  } catch {
    return [];
  }
}

/**
 * Clear all in-memory POI / reverse-geocode caches.
 *
 * Useful during QA when you want the next search to hit Supabase instead
 * of returning a memoized result. Not needed in production — TTLs handle
 * staleness and LRU caps memory.
 */
export function clearPoiCaches(): void {
  nearestPoiCache.clear();
  reverseGeocodeCache.clear();
  poisSearchCache.clear();
}

/* ─── Viewport-Based POI Fetching ─── */

export interface ViewportPoi {
  id: number;
  name: string;
  category: string;
  subcategory: string;
  /**
   * Unified TriciGo category — always present for rows synced after
   * migration 00248. Older OSM rows may have null. The cliente map
   * uses this to pick a category emoji (`tricigoCategoryEmoji`).
   */
  tricigo_category: string | null;
  lat: number;
  lng: number;
  address: string | null;
  importance: number;
  /** True when an admin curated this row in the panel. */
  is_admin: boolean;
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

    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[fetchPoisInViewport] non-OK response', {
        status: res.status,
        bounds,
        zoom: Math.floor(zoom),
      });
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      // eslint-disable-next-line no-console
      console.warn('[fetchPoisInViewport] response is not an array', { data });
      return [];
    }
    // eslint-disable-next-line no-console
    console.log('[fetchPoisInViewport] OK', {
      count: data.length,
      zoom: Math.floor(zoom),
    });
    return data as ViewportPoi[];
  } catch (err) {
    // Aborted requests are intentional (next call cancels the previous one);
    // don't pollute logs with them. Anything else surfaces as a warn so the
    // empty-array silent failure mode is no longer invisible.
    const e = err as { name?: string; message?: string } | undefined;
    if (e?.name !== 'AbortError') {
      // eslint-disable-next-line no-console
      console.warn(
        '[fetchPoisInViewport] threw',
        e?.name ?? 'Error',
        e?.message ?? String(err),
      );
    }
    return [];
  }
}
