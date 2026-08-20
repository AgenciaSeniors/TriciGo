/** Longest wait worth spelling out; past this the exact number stops helping. */
const MAX_ETA_MIN = 60;

/**
 * Short ETA label for a vehicle callout on the map.
 *
 * Rounds UP: showing "1 min" for a 90-second wait reads as a broken promise,
 * while "2 min" that arrives early reads as a good surprise. Returns null
 * when there is no usable estimate — the caller then shows nothing rather
 * than a fabricated number.
 */
export function formatVehicleEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.ceil(seconds / 60);
  if (minutes > MAX_ETA_MIN) return `${MAX_ETA_MIN}+ min`;
  return `${minutes} min`;
}

/**
 * Fallback for a vehicle with no ETA (the RPC only computes one when a
 * pickup is set). Metres up to a kilometre, then one decimal — "2.5 km"
 * carries as much as anyone needs from a marker on a map.
 */
export function formatVehicleDistance(metres: number | null | undefined): string | null {
  if (metres == null || !Number.isFinite(metres) || metres < 0) return null;
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
