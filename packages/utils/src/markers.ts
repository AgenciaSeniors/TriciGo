// ============================================================
// TriciGo — Vehicle marker rotation utilities
//
// Convention: ALL marker PNGs are drawn with the front of the vehicle
// pointing UP (north / 0°). Code then applies `rotate: bearingDeg` to
// align the nose with direction of travel. No per-vehicle offsets are
// needed for the standard fleet (`triciclo`, `auto_clasico`, `moto`,
// `confort`).
//
// History (BUG-295 → resolved): `triciclo.png` was originally drawn
// pointing east (90°), which broke the convention and caused a visible
// "marker faces wrong way" bug during in-progress trips. The PNG asset
// was re-exported pointing north (rotated 90° CCW) and the prior
// `triciclo: 180` offset entry removed in this same change. Future
// non-standard assets can be compensated by adding an entry here.
//
// Mensajería is excluded from rotation entirely via the consumer-side
// `NON_ROTATING_MARKERS` set; it doesn't need an offset because it's
// never rotated.
// ============================================================

/**
 * Per vehicle-type rotation offset in degrees. Empty by default —
 * all stock fleet assets follow the "point UP" convention.
 *
 * Add an entry here ONLY if a new asset is delivered in a non-standard
 * orientation AND can't be re-exported. Adding offsets is technical
 * debt; prefer fixing the asset itself.
 */
export const VEHICLE_MARKER_ROTATION_OFFSET_DEG: Record<string, number> = {};

/**
 * Returns the rotation offset (in degrees) to apply for a given
 * vehicle type. Returns 0 for unknown types or types that don't
 * need compensation.
 *
 * Usage:
 *   const offset = vehicleMarkerRotationOffset(vehicleType);
 *   const finalRotation = (bearingDeg + offset) % 360;
 *   <View style={{ transform: [{ rotate: `${finalRotation}deg` }] }} />
 */
export function vehicleMarkerRotationOffset(
  vehicleType: string | undefined | null,
): number {
  if (!vehicleType) return 0;
  return VEHICLE_MARKER_ROTATION_OFFSET_DEG[vehicleType] ?? 0;
}
