// ============================================================
// TriciGo Admin — live-map marker sizing
//
// Leaflet divIcons are FIXED PIXEL size: they do not scale with zoom.
// A 38px vehicle badge that reads well on a street-level view covers
// several kilometres at province zoom, which is what "los marcadores no
// respetan el tamaño del mapa" meant. So we pick a size tier per zoom
// level and rebuild the icon when the tier changes.
//
// The vehicle never disappears — even the smallest tier keeps the
// silhouette plus the state-colored ring, so the color coding survives
// at country zoom.
//
// Pure module (no `leaflet` import) so page.tsx can import it
// statically; the marker itself must stay behind next/dynamic ssr:false.
// ============================================================

export interface MarkerSize {
  /** Outer badge diameter in px (border-box). */
  badge: number;
  /** Vehicle image edge in px. */
  vehicle: number;
  /** Ring thickness in px — the state color lives here. */
  border: number;
}

/** Leaflet zoom → marker size tier. Tiers (not a continuous formula) so
    the icon is rebuilt a handful of times, not on every zoom step. */
export function markerSizeForZoom(zoom: number): MarkerSize {
  if (zoom >= 16) return { badge: 44, vehicle: 30, border: 3 }; // calle
  if (zoom >= 14) return { badge: 38, vehicle: 26, border: 3 }; // barrio
  if (zoom >= 12) return { badge: 30, vehicle: 20, border: 3 }; // ciudad
  if (zoom >= 10) return { badge: 24, vehicle: 15, border: 2 }; // provincia
  return { badge: 18, vehicle: 11, border: 2 };                 // país
}
