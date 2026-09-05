// ============================================================
// TriciGo — Pure helpers for the pin picker and the draggable markers.
//
// No React, no Mapbox: everything here is unit-tested and shared by
// ConfirmLocationScreen (pin confidence, opening zoom) and RideMapView
// (long-press vs. marker-drag disambiguation, drag-origin reconciliation).
// ============================================================

import type { StructuredAddress } from './geo';

/** How much the reverse geocode actually knows about the point under the pin. */
export type PinConfidence = 'exact' | 'near' | 'none';

/**
 * Map the reverse-geocode layer that produced the address to a confidence the
 * rider can see. Measured in prod: 13 % of dropoffs were a bare zone ("Cerro,
 * La Habana") because the picker rendered `municipality, province` exactly
 * like a real street address when no street was found within 200 m.
 */
export function pinConfidence(source: StructuredAddress['source'] | null | undefined): PinConfidence {
  switch (source) {
    case 'cross_streets':
    case 'overpass':
    case 'road':
      return 'exact';
    case 'nearest_street':
      return 'near';
    default:
      return 'none';
  }
}

/** Opening zoom for the picker: close when adjusting/confirming an existing
 *  point (the rider needs to read the street under the tip), wider when
 *  starting from scratch. */
export function pickerZoomFor(seeded: boolean): 15 | 17 {
  return seeded ? 17 : 15;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Whether a screen point lands within `radiusPx` of any projected marker.
 * Used to let a long-press on a marker start a DRAG instead of opening the
 * pin picker at that spot. Markers that could not be projected are skipped.
 */
export function isNearScreenPoint(
  p: ScreenPoint,
  markers: ReadonlyArray<ScreenPoint | null | undefined>,
  radiusPx = 40,
): boolean {
  for (const m of markers) {
    if (!m) continue;
    const dx = m.x - p.x;
    const dy = m.y - p.y;
    if (Math.sqrt(dx * dx + dy * dy) <= radiusPx) return true;
  }
  return false;
}

/** Coordinate equality within `eps` degrees (1e-6 ≈ 11 cm). Both null → equal. */
export function coordsEqual(
  a: { latitude: number; longitude: number } | null | undefined,
  b: { latitude: number; longitude: number } | null | undefined,
  eps = 1e-6,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(a.latitude - b.latitude) <= eps && Math.abs(a.longitude - b.longitude) <= eps;
}
