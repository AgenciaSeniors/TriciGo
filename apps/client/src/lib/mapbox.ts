// ============================================================
// TriciGo — Mapbox bootstrap (single source of truth)
//
// The native module is loaded through require() on first use instead of a
// top-level import: a module-level import can take down the whole JS
// context when the native side fails to link, and every map screen would
// go with it.
// ============================================================

import { Platform } from 'react-native';
import { getMapFallbackCoordLngLat } from '@/config/demo';

let _MapboxGL: unknown = undefined;

/** Lazily require @rnmapbox/maps. Returns null when unavailable (web, or a
 *  build where the native module failed to link). Result is cached. */
export function getMapboxGL(): any {
  if (_MapboxGL !== undefined) return _MapboxGL;
  try {
    _MapboxGL = require('@rnmapbox/maps').default;
  } catch {
    _MapboxGL = null;
  }
  return _MapboxGL;
}

let _tokenApplied = false;

/**
 * Apply the Mapbox access token before any MapView mounts.
 *
 * Called from the app root at module load AND again from a useEffect, plus
 * once more from each map component's module scope. Release builds have
 * been seen losing the race between the root side-effect and a native
 * MapView mounting, so the redundancy is deliberate — the guard keeps the
 * repeats free.
 *
 * @param force re-apply even if a previous call already succeeded (used by
 *              the root retry, which cannot know whether the first attempt
 *              ran before or after the native module was ready).
 */
export function ensureMapboxToken(force = false): void {
  if (Platform.OS === 'web') return;
  if (_tokenApplied && !force) return;
  const M = getMapboxGL();
  if (!M) return;
  try {
    M.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '');
    // BUG-216: setWellKnownTileServer removed (deprecated; the tile server
    // is auto-detected from the access token) — it was pure log noise.
    if (typeof M.setTelemetryEnabled === 'function') M.setTelemetryEnabled(false);
    _tokenApplied = true;
  } catch {
    // A later call (root useEffect / next component mount) picks it up.
  }
}

// Map fallback; Havana in prod, configurable for demo (see config/demo.ts).
const FALLBACK_CENTER: [number, number] = getMapFallbackCoordLngLat();

/**
 * Convert a {latitude, longitude} point to Mapbox's [lng, lat] order.
 *
 * A non-finite coordinate falls back to the configured map center rather
 * than reaching Mapbox: NaN silently breaks the camera and poisons every
 * bounds computation downstream (see the poisoned-recent-address incident
 * fixed in #941).
 */
export function toLngLat(p: { latitude: number; longitude: number } | null | undefined): [number, number] {
  const lng = Number.isFinite(p?.longitude) ? (p as { longitude: number }).longitude : FALLBACK_CENTER[0];
  const lat = Number.isFinite(p?.latitude) ? (p as { latitude: number }).latitude : FALLBACK_CENTER[1];
  return [lng, lat];
}
