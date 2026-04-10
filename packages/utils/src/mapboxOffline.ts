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
export { MAP_STYLE_LIGHT as MAPBOX_STYLE_URL } from './mapStyles';

/** Refresh interval: 1 week */
export const PACK_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** AsyncStorage key for last sync timestamp */
export const OFFLINE_SYNC_KEY = '@tricigo/mapbox-offline-last-sync';

/** Multi-city offline pack configurations for Cuba */
export const CUBAN_CITY_PACKS: Array<{
  name: string;
  label: string;
  bounds: { ne: [number, number]; sw: [number, number] };
  zoom: { minZoom: number; maxZoom: number };
}> = [
  {
    name: 'havana',
    label: 'La Habana',
    bounds: HAVANA_OFFLINE_BOUNDS,
    zoom: HAVANA_PACK_ZOOM,
  },
  {
    name: 'santiago',
    label: 'Santiago de Cuba',
    bounds: { ne: [-75.75, 20.08], sw: [-75.88, 19.98] },
    zoom: { minZoom: 12, maxZoom: 16 },
  },
  {
    name: 'camaguey',
    label: 'Camagüey',
    bounds: { ne: [-77.87, 21.42], sw: [-77.95, 21.35] },
    zoom: { minZoom: 12, maxZoom: 16 },
  },
  {
    name: 'santa-clara',
    label: 'Santa Clara',
    bounds: { ne: [-79.92, 22.44], sw: [-80.00, 22.38] },
    zoom: { minZoom: 12, maxZoom: 16 },
  },
  {
    name: 'holguin',
    label: 'Holguín',
    bounds: { ne: [-76.22, 20.80], sw: [-76.30, 20.74] },
    zoom: { minZoom: 12, maxZoom: 16 },
  },
  {
    name: 'varadero',
    label: 'Varadero',
    bounds: { ne: [-81.08, 23.18], sw: [-81.30, 23.10] },
    zoom: { minZoom: 12, maxZoom: 16 },
  },
];
