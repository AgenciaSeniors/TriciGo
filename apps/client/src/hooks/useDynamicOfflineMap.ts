// ============================================================
// TriciGo Client — Dynamic offline map packs
//
// Replaces the old Havana-only useMapboxOffline. Resolves the current
// ~0.12° grid cell (server RPC, clipped to street extent) for the rider's
// location and downloads it as a Mapbox offline pack on demand, keeping
// total tiles under Mapbox's ~6000/device ceiling via LRU-by-tile-budget.
// Best-effort: any failure falls back to online / ambient cache. Native
// dev/real builds only.
//
// Location source: the rider app keeps `last_known_location` in
// AsyncStorage (set by the home/booking map screens) — no global location
// store exists here, unlike the driver app.
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

const META_KEY = '@tricigo/offline-pack-meta';
const LAST_LOCATION_KEY = 'last_known_location';
const POLL_MS = 45_000;

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

async function readLastLocation(): Promise<LatLng | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const { latitude, longitude } = JSON.parse(raw);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { lat: latitude, lng: longitude };
    }
    return null;
  } catch {
    return null;
  }
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

  const toDelete = planEviction(meta, OFFLINE_MAX_TILES, [region.cellKey]);
  for (const key of toDelete) {
    await MapboxGL.offlineManager.deletePack(key).catch(() => {});
    delete meta[key];
  }
  await saveMeta(meta);
}

/**
 * Mount once at app root. Polls the rider's last known location and keeps
 * the offline pack for the current grid cell downloaded.
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
      const current = await readLastLocation();
      if (!current) return;
      if (!shouldReresolve(lastPointRef.current, current)) return;

      busyRef.current = true;
      try {
        const region = await nearbyService.getOfflineRegionForPoint(current.lat, current.lng);
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
