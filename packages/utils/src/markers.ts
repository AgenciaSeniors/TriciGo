// ============================================================
// TriciGo — Vehicle marker rotation utilities
//
// BUG-295: per-vehicle-type rotation offset (degrees) that compensates
// for marker assets drawn with non-standard "front pointing" convention.
//
// Convention: marker PNGs SHOULD be drawn with the front of the vehicle
// pointing UP (north / 0°). Code then applies `rotate: bearingDeg` to
// align the nose with direction of travel.
//
// Exception: `triciclo.png` is drawn with the driver/handlebar (= front
// of the vehicle, direction of motion) pointing DOWN (south / 180°),
// while the cargo box / passenger compartment occupies the upper half
// of the image. Until the asset is re-exported with the conventional
// orientation we compensate by adding 180° at render time. This makes
// the marker visually face the same direction as the route polyline
// underneath it.
//
// Other vehicle markers (auto_clasico, moto, confort) are correctly
// drawn with their front pointing up — their offset is 0.
//
// Mensajería is excluded from rotation entirely via the consumer-side
// `NON_ROTATING_MARKERS` set; it doesn't need an offset because it's
// never rotated.
//
// Future: if `triciclo.png` is re-exported pointing up, delete the
// triciclo entry from VEHICLE_MARKER_ROTATION_OFFSET_DEG (and note
// the asset fix in the changelog).
// ============================================================

/** Per vehicle-type rotation offset in degrees. */
export const VEHICLE_MARKER_ROTATION_OFFSET_DEG: Record<string, number> = {
  // BUG-295: triciclo PNG drawn pointing south (driver/handlebar at
  // bottom of image, cargo box at top). Add 180° so the rendered
  // rotation aligns with the bearing of motion.
  triciclo: 180,
};

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
