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

/** Center of Havana (used as default driver location). */
export const HAVANA_CENTER: GeoPoint = { latitude: 23.1136, longitude: -82.3666 };

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
 * Format a Nominatim address into a Havana-style street address.
 * Example output: "Calle 23, Vedado" or "Obispo #302, Habana Vieja".
 */
export function formatHavanaAddress(address: {
  road?: string;
  suburb?: string;
  city?: string;
  city_district?: string;
  neighbourhood?: string;
  house_number?: string;
}): string {
  const parts: string[] = [];

  // Road + house number
  if (address.road) {
    const road = address.house_number
      ? `${address.road} #${address.house_number}`
      : address.road;
    parts.push(road);
  }

  // Neighborhood / suburb — prefer suburb (barrio)
  const area = address.suburb || address.neighbourhood || address.city_district;
  if (area) {
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

/** Havana bounding box for Nominatim search (SW lng, SW lat, NE lng, NE lat) */
const HAVANA_VIEWBOX = '-82.55,22.95,-82.25,23.20';

/* ─── OSRM Routing ─── */

/**
 * Fetch a driving route between two points using the OSRM public API.
 * Returns the route geometry (lat/lng pairs) + distance/duration,
 * or null if the request fails.
 */
export async function fetchRoute(
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

    // GeoJSON coordinates are [lng, lat] — convert to [lat, lng]
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

/* ─── Nominatim Reverse Geocoding ─── */

/**
 * Reverse geocode coordinates to a human-readable address using Nominatim.
 * Formats the result with `formatHavanaAddress()`.
 * Returns null if the request fails.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}&format=json&addressdetails=1&accept-language=es`;

    const res = await throttledFetch(url, NOMINATIM_HEADERS);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.address) return null;

    const formatted = formatHavanaAddress(data.address);
    return formatted || null;
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
      viewbox: HAVANA_VIEWBOX,
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
        ? formatHavanaAddress(item.address as Parameters<typeof formatHavanaAddress>[0])
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
