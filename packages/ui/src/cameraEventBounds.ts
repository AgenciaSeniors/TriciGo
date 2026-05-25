// ============================================================
// cameraEventBounds — extract viewport bounds + zoom from an
// @rnmapbox/maps onCameraChanged / onMapIdle event with multiple
// fallbacks. Centralised so the 3+ map components don't each have
// to maintain their own try/catch swallowing.
//
// Why this exists (PR D, 2026-05-25): the previous inline
// implementation across RideMapView (client + driver) and
// ConfirmLocationScreen was:
//
//   try {
//     const visibleBounds = event.properties?.visibleBounds;
//     if (visibleBounds && visibleBounds.length === 2) {
//       onCameraChanged({...}, zoom);
//     }
//     // ← no else — silent no-op when visibleBounds is missing
//   } catch {}  // ← swallows ALL errors silently
//
// @rnmapbox/maps v10.3.0 on the new arch does NOT always include
// visibleBounds on every onCameraChanged event — particularly
// mid-pan it sometimes only delivers the center coordinate +
// zoomLevel, never visibleBounds. The handler silently no-op'd,
// the POI hook never received a new bbox, and the user perceived
// "POIs only appear in Habana centro, even when I pan elsewhere".
//
// This helper:
//   1. Tries `event.properties.visibleBounds` (the normal path).
//   2. Falls back to `event.properties.bounds` (some SDK versions
//      use this property name instead).
//   3. Synthesises a bbox from the centre + zoomLevel as a last
//      resort so we never silently drop an event. The synthesised
//      bbox is approximate but good enough to trigger a POI refetch
//      that will be corrected on the next event that DOES carry
//      proper bounds (typically onMapIdle when the camera settles).
//
// Returns null only when there is no usable geometry on the event
// at all (e.g., on initial mount before the camera is positioned).
// In that case we log a warn so QA can see in Metro logs why a
// refetch was skipped.
// ============================================================

export interface ViewportBoundsBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface CameraEventBoundsResult {
  bounds: ViewportBoundsBox;
  zoom: number;
}

import { mapLogger } from '@tricigo/utils';

// Approximate degrees-per-pixel ratio at zoom 0 at the equator
// (256 pixel tile spans 360°). Decreases by half each zoom level.
const DEGREES_PER_TILE_Z0 = 360;
// Fallback assumes a ~360×640 dp viewport (typical phone in portrait).
const FALLBACK_VIEWPORT_TILES_W = 1.4;
const FALLBACK_VIEWPORT_TILES_H = 2.5;

/**
 * Resolve viewport bounds + zoom from a Mapbox camera event with
 * multi-level fallback. Returns null only when there is no usable
 * geometry at all (caller can skip the refetch in that case).
 *
 * Logs a console.warn whenever we fall back to the synthesised bbox
 * so flaky SDK behaviour is visible in Metro logs without changing
 * user-facing UX.
 */
export function extractBoundsFromCameraEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any,
): CameraEventBoundsResult | null {
  if (!event) return null;

  const props = event.properties ?? {};
  const zoom: number =
    typeof props.zoomLevel === 'number' ? props.zoomLevel : 13;

  // Path 1: visibleBounds (most common, both onMapIdle and onCameraChanged)
  // Shape: [[neLng, neLat], [swLng, swLat]]
  const visibleBounds = props.visibleBounds;
  if (Array.isArray(visibleBounds) && visibleBounds.length === 2) {
    const [ne, sw] = visibleBounds;
    if (
      Array.isArray(ne) && ne.length === 2 &&
      Array.isArray(sw) && sw.length === 2 &&
      Number.isFinite(ne[0]) && Number.isFinite(ne[1]) &&
      Number.isFinite(sw[0]) && Number.isFinite(sw[1])
    ) {
      return {
        bounds: {
          minLng: sw[0],
          minLat: sw[1],
          maxLng: ne[0],
          maxLat: ne[1],
        },
        zoom,
      };
    }
  }

  // Path 2: bounds alias (some Mapbox SDK builds expose this name)
  const altBounds = props.bounds;
  if (Array.isArray(altBounds) && altBounds.length === 2) {
    const [ne, sw] = altBounds;
    if (
      Array.isArray(ne) && Array.isArray(sw) &&
      Number.isFinite(ne[0]) && Number.isFinite(sw[0])
    ) {
      return {
        bounds: {
          minLng: sw[0],
          minLat: sw[1],
          maxLng: ne[0],
          maxLat: ne[1],
        },
        zoom,
      };
    }
  }

  // Path 3: synthesise from centre + zoom. Geometry comes from
  // event.geometry (GeoJSON Point at the camera centre).
  const geom = event.geometry;
  const centre = geom && geom.type === 'Point' && Array.isArray(geom.coordinates)
    ? geom.coordinates
    : null;
  if (
    Array.isArray(centre) && centre.length === 2 &&
    Number.isFinite(centre[0]) && Number.isFinite(centre[1])
  ) {
    const [cLng, cLat] = centre;
    // Approximate half-width / half-height in degrees at this zoom.
    // tilesAcross = viewport / tileSize. At zoom Z, one tile spans
    // 360/2^Z degrees of longitude (latitude scales by cos lat).
    const degPerTile = DEGREES_PER_TILE_Z0 / Math.pow(2, Math.max(0, zoom));
    const halfLng = (FALLBACK_VIEWPORT_TILES_W * degPerTile) / 2;
    const halfLat = halfLng * (FALLBACK_VIEWPORT_TILES_H / FALLBACK_VIEWPORT_TILES_W)
      * Math.cos((cLat * Math.PI) / 180);
    const bounds = {
      minLng: cLng - halfLng,
      minLat: cLat - halfLat,
      maxLng: cLng + halfLng,
      maxLat: cLat + halfLat,
    };
    mapLogger.viewport({
      bbox: `${bounds.minLng.toFixed(3)},${bounds.minLat.toFixed(3)},${bounds.maxLng.toFixed(3)},${bounds.maxLat.toFixed(3)}`,
      zoom: Math.floor(zoom),
      source: 'pan',
      reason: 'synthesised_from_centre',
    });
    return { bounds, zoom };
  }

  // PR G follow-up (2026-05-25): the no_geometry branch fires constantly
  // during Mapbox SDK transitions (cold mount, fly-to animations, pinch
  // gestures) — those events arrive without visibleBounds AND without a
  // centre coordinate because the camera hasn't finished animating yet.
  // It's not actionable for the consumer (no bbox = no refetch possible)
  // and floods the log to the point of hiding real events. Silent return
  // — visibleBounds_missing path (one above) still logs because it IS
  // actionable (synthesised bbox triggers a refetch).
  return null;
}
