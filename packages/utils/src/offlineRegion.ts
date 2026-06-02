// ============================================================
// TriciGo — Dynamic offline map regions
//
// Pure helpers for the dynamic offline-map feature: snap a GPS point
// to a fixed grid cell, estimate how many Mapbox tiles a cell pack
// would cost, and pick which packs to evict to stay under Mapbox's
// hard per-device tile ceiling (~6000). No React, no Mapbox, no I/O —
// the per-app `useDynamicOfflineMap` hook wires this to
// offlineManager + AsyncStorage.
//
// Why a grid (not municipalities): street_intersections.municipality
// is dirty (500 distinct values, NULLs, spans 0.00°–0.55°), so it
// can't key clean packs. A uniform grid gives stable dedup keys and a
// predictable tile budget.
// ============================================================

/** Grid cell size in degrees (~13 km at Cuban latitudes). */
export const OFFLINE_GRID_DEG = 0.12;
/** Stay under Mapbox's ~6000 tiles/device hard limit (ToS-protected). */
export const OFFLINE_MAX_TILES = 5500;
/** Pack zoom range. z16 ≈ street detail; z17-18 (pickup) falls to ambient cache. */
export const OFFLINE_PACK_MIN_ZOOM = 10;
export const OFFLINE_PACK_MAX_ZOOM = 16;
/** Re-resolve the region (call the RPC) only after moving this far. */
export const OFFLINE_RERESOLVE_M = 5000;

/** Mapbox-style bounds: [lng, lat] corners. */
export interface RegionBounds {
  ne: [number, number]; // [lng, lat]
  sw: [number, number]; // [lng, lat]
}

/** Per-pack metadata persisted for LRU budgeting. */
export interface OfflinePackMeta {
  tiles: number;
  lastUsedAt: number; // epoch ms
}

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Stable key for the grid cell containing the point. Two points in the
 * same cell yield the same key (natural dedup).
 */
export function gridCellKey(lat: number, lng: number, gridDeg: number = OFFLINE_GRID_DEG): string {
  const latIdx = Math.floor(lat / gridDeg);
  const lngIdx = Math.floor(lng / gridDeg);
  return `cell_${latIdx}_${lngIdx}`;
}

/** Full bounds of the grid cell containing the point. */
export function cellBounds(lat: number, lng: number, gridDeg: number = OFFLINE_GRID_DEG): RegionBounds {
  const latIdx = Math.floor(lat / gridDeg);
  const lngIdx = Math.floor(lng / gridDeg);
  const swLat = latIdx * gridDeg;
  const swLng = lngIdx * gridDeg;
  return {
    sw: [swLng, swLat],
    ne: [swLng + gridDeg, swLat + gridDeg],
  };
}

/** Slippy-map tile X index for a longitude at zoom z. */
function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

/** Slippy-map tile Y index for a latitude at zoom z (y grows southward). */
function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  );
}

/**
 * Estimate the number of vector tiles a pack covering `bounds` across
 * [minZoom, maxZoom] would download. Used to budget against Mapbox's
 * per-device ceiling before creating a pack.
 */
export function estimateTileCount(
  bounds: RegionBounds,
  minZoom: number = OFFLINE_PACK_MIN_ZOOM,
  maxZoom: number = OFFLINE_PACK_MAX_ZOOM,
): number {
  const [minLng, minLat] = bounds.sw;
  const [maxLng, maxLat] = bounds.ne;
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const xCount = Math.abs(lngToTileX(maxLng, z) - lngToTileX(minLng, z)) + 1;
    // North latitude → smaller Y; south → larger Y. Span = south - north.
    const yCount = Math.abs(latToTileY(minLat, z) - latToTileY(maxLat, z)) + 1;
    total += xCount * yCount;
  }
  return total;
}

/**
 * Decide which packs to evict so the total tile count stays within
 * `budgetTiles`. Evicts least-recently-used first. `keepKeys` are never
 * evicted (e.g. the cell the user is currently in). Returns the pack
 * keys to delete.
 */
export function planEviction(
  meta: Record<string, OfflinePackMeta>,
  budgetTiles: number = OFFLINE_MAX_TILES,
  keepKeys: string[] = [],
): string[] {
  const keep = new Set(keepKeys);
  const entries = Object.entries(meta);
  let total = entries.reduce((sum, [, m]) => sum + (m.tiles || 0), 0);
  if (total <= budgetTiles) return [];

  // Oldest first; protected keys sink to the end so they're evicted last.
  const evictable = entries
    .filter(([k]) => !keep.has(k))
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

  const toDelete: string[] = [];
  for (const [key, m] of evictable) {
    if (total <= budgetTiles) break;
    toDelete.push(key);
    total -= m.tiles || 0;
  }
  return toDelete;
}

/** Equirectangular distance in meters (fine at city scale). */
function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/**
 * Whether to re-resolve the region (i.e. call the RPC again). True on
 * the first fix, when the point crosses into a different grid cell, or
 * after moving more than OFFLINE_RERESOLVE_M. Avoids spamming the RPC
 * on every 1 Hz GPS tick.
 */
export function shouldReresolve(
  lastPoint: LatLng | null,
  current: LatLng,
  gridDeg: number = OFFLINE_GRID_DEG,
): boolean {
  if (!lastPoint) return true;
  if (gridCellKey(lastPoint.lat, lastPoint.lng, gridDeg) !== gridCellKey(current.lat, current.lng, gridDeg)) {
    return true;
  }
  return distanceM(lastPoint, current) > OFFLINE_RERESOLVE_M;
}
