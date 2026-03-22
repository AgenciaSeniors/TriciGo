// ============================================================
// TriciGo — Mapbox Offline Constants
// Havana region bounds and pack configuration for offline maps.
// ============================================================

/** Havana offline region bounds [lng, lat] */
export const HAVANA_OFFLINE_BOUNDS = {
  ne: [-82.25, 23.20] as [number, number],
  sw: [-82.55, 22.95] as [number, number],
};

/** Offline pack identifier */
export const HAVANA_PACK_NAME = 'havana-primary';

/** Zoom range for offline tiles */
export const HAVANA_PACK_ZOOM = { minZoom: 12, maxZoom: 15 };

/** Mapbox style for offline pack */
export const MAPBOX_STYLE_URL = 'mapbox://styles/mapbox/streets-v12';

/** Refresh interval: 1 week */
export const PACK_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** AsyncStorage key for last sync timestamp */
export const OFFLINE_SYNC_KEY = '@tricigo/mapbox-offline-last-sync';
