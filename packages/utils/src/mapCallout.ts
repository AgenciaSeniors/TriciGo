import { estimateRoadDistance } from './geo';

/** Longest wait worth spelling out; past this the exact number stops helping. */
const MAX_ETA_MIN = 60;

/** Average city speed used across the client for driver-to-pickup estimates. */
const CITY_SPEED_KMH = 20;

/**
 * Minutes for a vehicle `distanceM` away (straight line) to reach the rider.
 *
 * `find_nearby_vehicles` returns position and nothing else — no ETA, no road
 * distance — so this is derived client-side from the haversine distance, the
 * same way the vehicle picker has always done it. Kept here so the three
 * call sites agree instead of each carrying its own copy of the arithmetic.
 */
export function estimateVehicleEtaMinutes(distanceM: number | null | undefined): number | null {
  if (distanceM == null || !Number.isFinite(distanceM) || distanceM < 0) return null;
  const roadKm = estimateRoadDistance(distanceM) / 1000;
  // Floor of 1: a vehicle on the corner still has to turn and pull up.
  return Math.max(1, Math.round((roadKm / CITY_SPEED_KMH) * 60));
}

/**
 * Short ETA label for a vehicle callout on the map. Returns null when there
 * is no usable estimate — the caller then shows nothing rather than a
 * fabricated number.
 */
export function formatVehicleEtaMinutes(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes > MAX_ETA_MIN) return `${MAX_ETA_MIN}+ min`;
  return `${Math.round(minutes)} min`;
}

/**
 * Fallback label when an ETA can't be derived (no pickup set, so there is no
 * point to measure from). Metres up to a kilometre, then one decimal —
 * "2.5 km" carries as much as anyone needs from a marker on a map.
 */
export function formatVehicleDistance(metres: number | null | undefined): string | null {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return null;
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
