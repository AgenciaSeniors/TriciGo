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
  MAP_STYLE_LIGHT,
  estimateTileCount,
  planEviction,
  shouldReresolve,
  OFFLINE_PACK_MIN_ZOOM,
  OFFLINE_PACK_MAX_ZOOM,
  OFFLINE_MAX_TILES,
  type OfflinePackMeta,
  type LatLng,
} from '@tricigo/utils';
import { useLocationStore } from '@/stores/location.store';

const META_KEY = '@tricigo/offline-pack-meta';
const POLL_MS = 30_000;

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
    meta[region.cellKey] = { tiles: meta[region.cellKey]?.tiles ?? 0, lastUsedAt: now };
    await saveMeta(meta);
    return;
  }

  const tiles = estimateTileCount(
    { ne: region.ne, sw: region.sw },
    OFFLINE_PACK_MIN_ZOOM,
    OFFLINE_PACK_MAX_ZOOM,
  );

  await MapboxGL.offlineManager.createPack({
    name: region.cellKey,
    styleURL: MAP_STYLE_LIGHT,
    bounds: [region.ne, region.sw],
    minZoom: OFFLINE_PACK_MIN_ZOOM,
    maxZoom: OFFLINE_PACK_MAX_ZOOM,
  });
  meta[region.cellKey] = { tiles, lastUsedAt: now };

  // Stay under Mapbox's per-device tile ceiling. Never evict the cell we
  // just downloaded (it's where the driver is right now).
  const toDelete = planEviction(meta, OFFLINE_MAX_TILES, [region.cellKey]);
  for (const key of toDelete) {
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
    if (Platform.OS === 'web' || !MapboxGL || process.env.EXPO_PUBLIC_DEMO_MODE === 'true') {
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
        if (region) await ensurePack(region);
      } catch {
        /* best-effort — map falls back to online/ambient cache */
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
