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
  moto_standard: 30,
  auto_standard: 25,
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
