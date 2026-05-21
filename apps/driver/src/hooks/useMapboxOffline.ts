// ============================================================
// TriciGo — Mapbox Offline Pack Hook (Client)
// Downloads Havana region tiles for offline map viewing.
// ============================================================

import { useEffect, useState, useRef } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HAVANA_OFFLINE_BOUNDS,
  HAVANA_PACK_NAME,
  HAVANA_PACK_ZOOM,
  MAPBOX_STYLE_URL,
  PACK_REFRESH_MS,
  OFFLINE_SYNC_KEY,
} from '@tricigo/utils/mapboxOffline';

let MapboxGL: any;
try {
  MapboxGL = require('@rnmapbox/maps').default;
} catch {
  MapboxGL = null;
}

interface OfflinePackState {
  progress: number; // 0-100
  isDownloading: boolean;
  error: string | null;
}

/**
 * Downloads and maintains the Havana offline map pack.
 * Checks once per app session; refreshes weekly.
 * Only runs on native platforms (not web).
 */
export function useMapboxOffline(): OfflinePackState {
  const [state, setState] = useState<OfflinePackState>({
    progress: 0,
    isDownloading: false,
    error: null,
  });
  const initiated = useRef(false);

  useEffect(() => {
    if (Platform.OS === 'web' || !MapboxGL || initiated.current) return;
    initiated.current = true;

    async function checkAndDownload() {
      try {
        // Check last sync
        const lastSync = await AsyncStorage.getItem(OFFLINE_SYNC_KEY);
        const lastSyncMs = lastSync ? parseInt(lastSync, 10) : 0;
        const now = Date.now();

        if (lastSyncMs > 0 && now - lastSyncMs < PACK_REFRESH_MS) {
          // Pack is fresh, skip
          return;
        }

        // Delete old pack if exists
        try {
          await MapboxGL.offlineManager.deletePack(HAVANA_PACK_NAME);
        } catch {
          // Ignore — pack might not exist
        }

        setState((s) => ({ ...s, isDownloading: true, error: null }));

        // Create offline pack
        await MapboxGL.offlineManager.createPack(
          {
            name: HAVANA_PACK_NAME,
            styleURL: MAPBOX_STYLE_URL,
            bounds: [HAVANA_OFFLINE_BOUNDS.ne, HAVANA_OFFLINE_BOUNDS.sw],
            minZoom: HAVANA_PACK_ZOOM.minZoom,
            maxZoom: HAVANA_PACK_ZOOM.maxZoom,
          },
          (pack: any, status: any) => {
            // Progress callback
            if (status && typeof status.percentage === 'number') {
              setState((s) => ({
                ...s,
                progress: Math.round(status.percentage),
              }));
            }
          },
          (pack: any, error: any) => {
            // Error callback
            if (error) {
              console.warn('[MapboxOffline] Pack error:', error);
              setState((s) => ({
                ...s,
                isDownloading: false,
                error: String(error.message ?? error),
              }));
            }
          },
        );

        // Mark sync time
        await AsyncStorage.setItem(OFFLINE_SYNC_KEY, String(Date.now()));
        setState({ progress: 100, isDownloading: false, error: null });
      } catch (err) {
        console.warn('[MapboxOffline] Failed to create pack:', err);
        setState((s) => ({
          ...s,
          isDownloading: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        }));
      }
    }

    checkAndDownload();
  }, []);

  return state;
}
