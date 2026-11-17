/** A Mapbox coordinate: [longitude, latitude]. */
export type LngLat = [number, number];

/** Narrowest side of a box the map is asked to fit: about 450 m in Havana. */
export const MIN_BOUNDS_SPAN_DEG = 0.004;

/**
 * Bounding box of the coordinates, for the map camera to fit.
 *
 * Each side is at least MIN_BOUNDS_SPAN_DEG wide, around its centre. A single
 * point (the destination while the pickup is still missing) used to give a box
 * with no area, and Mapbox fitted it at its deepest zoom, 25.5, which draws an
 * all-gray map; the camera's maxZoomLevel did not stop it.
 */
export function computeBounds(coords: LngLat[]): { ne: LngLat; sw: LngLat } | null {
  const validCoords = coords.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
  if (validCoords.length === 0) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of validCoords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  [minLng, maxLng] = atLeastMinSpan(minLng, maxLng);
  [minLat, maxLat] = atLeastMinSpan(minLat, maxLat);
  return { ne: [maxLng, maxLat], sw: [minLng, minLat] };
}

function atLeastMinSpan(min: number, max: number): [number, number] {
  if (max - min >= MIN_BOUNDS_SPAN_DEG) return [min, max];
  const mid = (min + max) / 2;
  return [mid - MIN_BOUNDS_SPAN_DEG / 2, mid + MIN_BOUNDS_SPAN_DEG / 2];
}
