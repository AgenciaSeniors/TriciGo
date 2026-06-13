/**
 * Centralized Mapbox token + presence guard for the web map components.
 *
 * Ride-flow audit #13: every web map did
 * `mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? ''`, so a
 * missing/misconfigured token rendered a silent gray canvas — no hint to the
 * user (or to us) that the map was broken. Centralize the read here and expose
 * `HAS_MAPBOX_TOKEN` so each map can short-circuit to a visible fallback
 * instead of failing silently. Production ships a valid token; this only
 * guards against misconfiguration, but a clear message beats a blank map.
 */
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

export const HAS_MAPBOX_TOKEN = MAPBOX_TOKEN.trim().length > 0;
