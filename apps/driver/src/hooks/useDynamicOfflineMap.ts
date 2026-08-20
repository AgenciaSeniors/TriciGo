// ============================================================
// TriciGo Driver — Dynamic offline map packs
//
// Replaces the old Havana-only useMapboxOffline. As the driver moves,
// resolves the current ~0.12° grid cell (server RPC, clipped to street
// extent) and downloads it as a Mapbox offline pack on demand, keeping
// total downloaded tiles under Mapbox's ~6000/device ceiling via an
// LRU-by-tile-budget eviction. Best-effort: any failure falls back to
// online / ambient cache. Runs only on native dev/real builds.
// ============================================================

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nearbyService, getOnlineStatus } from '@tricigo/api';
import {
  MAP_STYLE_NAV_NIGHT,
  estimatePackTileCount,
  planEviction,
  shouldReresolve,
  packNeedsRefresh,
  OFFLINE_PACK_MIN_ZOOM,
  OFFLINE_PACK_MAX_ZOOM,
  OFFLINE_MAX_TILES,
  type OfflinePackMeta,
  type LatLng,
} from '@tricigo/utils';
import { useLocationStore } from '@/stores/location.store';

const META_KEY = '@tricigo/offline-pack-meta';
const POLL_MS = 30_000;

/**
 * The style these packs must hold: the one the driver's map actually draws.
 * `ActiveTripMap` and the idle home map both pass `darkStyle`, so both render
 * navigation-night-v1 — and those are the two screens a driver sits on with no
 * signal. (The only light-v11 map left is the 180px thumbnail in trip history,
 * a screen about trips that already ended.)
 *
 * Nothing carries over between the two styles. Mapbox serves a style's
 * `composite` from one endpoint named after its tileset list, and light-v11's
 * list carries mapbox-bathymetry-v2 where navigation-night-v1's does not:
 *   /v4/mapbox-streets-v8,mapbox-terrain-v2,mapbox-bathymetry-v2/{z}/{x}/{y}
 *   /v4/mapbox-streets-v8,mapbox-terrain-v2/{z}/{x}/{y}
 * Different URL, different cache key — a light-v11 pack serves this map zero
 * tiles, however much of mapbox-streets-v8 it happens to contain. (Glyphs are
 * the one shared resource: same font URLs, same six stacks.)
 */
const DRIVER_MAP_STYLE = MAP_STYLE_NAV_NIGHT;

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

async function loadMeta(): Promise<Record<string, OfflinePackMeta>> {
  try {
    const raw = await AsyncStorage.getItem(META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, OfflinePackMeta>) : {};
  } catch {
    return {};
  }
}

async function saveMeta(meta: Record<string, OfflinePackMeta>): Promise<void> {
  try {
    await AsyncStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* best-effort */
  }
}

async function ensurePack(region: {
  cellKey: string;
  ne: [number, number];
  sw: [number, number];
}): Promise<void> {
  const meta = await loadMeta();
  const now = Date.now();

  const existing = await MapboxGL.offlineManager.getPack(region.cellKey).catch(() => null);
  if (existing) {
    if (!packNeedsRefresh(meta[region.cellKey], DRIVER_MAP_STYLE)) {
      meta[region.cellKey] = {
        tiles: meta[region.cellKey]?.tiles ?? 0,
        lastUsedAt: now,
        styleURL: DRIVER_MAP_STYLE,
      };
      await saveMeta(meta);
      return;
    }
    // Downloaded for a different style: these tiles are the wrong data.
    // Falling through re-downloads them for the style in use now. This is
    // also what clears the light-v11 packs already sitting on drivers'
    // phones, which no screen they use could read.
    console.log('[OfflineMap] style changed — refreshing pack', region.cellKey);
    await MapboxGL.offlineManager.deletePack(region.cellKey).catch(() => {});
    delete meta[region.cellKey];
  }

  const tiles = estimatePackTileCount(
    { ne: region.ne, sw: region.sw },
    DRIVER_MAP_STYLE,
    OFFLINE_PACK_MIN_ZOOM,
    OFFLINE_PACK_MAX_ZOOM,
  );

  console.log('[OfflineMap] createPack', region.cellKey, `~${tiles} tiles (z${OFFLINE_PACK_MIN_ZOOM}-${OFFLINE_PACK_MAX_ZOOM})`);
  await MapboxGL.offlineManager.createPack({
    name: region.cellKey,
    styleURL: DRIVER_MAP_STYLE,
    bounds: [region.ne, region.sw],
    minZoom: OFFLINE_PACK_MIN_ZOOM,
    maxZoom: OFFLINE_PACK_MAX_ZOOM,
  });
  meta[region.cellKey] = { tiles, lastUsedAt: now, styleURL: DRIVER_MAP_STYLE };

  // Stay under Mapbox's per-device tile ceiling. Never evict the cell we
  // just downloaded (it's where the driver is right now).
  const toDelete = planEviction(meta, OFFLINE_MAX_TILES, [region.cellKey]);
  for (const key of toDelete) {
    console.log('[OfflineMap] evict LRU pack', key);
    await MapboxGL.offlineManager.deletePack(key).catch(() => {});
    delete meta[key];
  }
  await saveMeta(meta);
}

/**
 * Mount once at app root. Polls the driver's location and keeps the
 * offline pack for the current grid cell downloaded.
 */
export function useDynamicOfflineMap(): void {
  const lastPointRef = useRef<LatLng | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    // Native-only real feature (not a dev/demo toggle): runs in dev, demo
    // and prod. Where there is no Cuban street data the RPC returns null
    // and we no-op, so running everywhere is harmless.
    if (Platform.OS === 'web' || !MapboxGL) {
      return;
    }
    let cancelled = false;

    const tick = async () => {
      if (cancelled || busyRef.current || !getOnlineStatus()) return;
      const { latitude, longitude } = useLocationStore.getState();
      if (latitude == null || longitude == null) return;
      const current: LatLng = { lat: latitude, lng: longitude };
      if (!shouldReresolve(lastPointRef.current, current)) return;

      busyRef.current = true;
      try {
        const region = await nearbyService.getOfflineRegionForPoint(latitude, longitude);
        // Mark resolved regardless of result so we don't hammer the RPC
        // while sitting in a streetless cell.
        lastPointRef.current = current;
        if (region) {
          console.log('[OfflineMap] region', region.cellKey, 'ensuring pack');
          await ensurePack(region);
        } else {
          console.log('[OfflineMap] no street data near', latitude.toFixed(4), longitude.toFixed(4), '— no pack');
        }
      } catch (e) {
        console.log('[OfflineMap] resolve failed (best-effort):', String((e as Error)?.message ?? e));
      } finally {
        busyRef.current = false;
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
}
