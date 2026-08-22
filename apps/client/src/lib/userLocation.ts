// ============================================================
// TriciGo — rider location helpers
//
// Unlike the driver app, the client has no global location store: views
// hand the last known position to each other through AsyncStorage. These
// helpers are that contract in one place.
// ============================================================

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

export const LAST_KNOWN_LOCATION_KEY = 'last_known_location';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Read the cached position. Returns null when absent, malformed, or
 *  carrying non-finite coordinates. */
export async function readCachedLocation(): Promise<LatLng | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_KNOWN_LOCATION_KEY);
    if (!raw) return null;
    const { latitude, longitude } = JSON.parse(raw);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

/** Persist a position for other views and future cold starts. Best-effort. */
export async function cacheLocation(loc: LatLng): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_KNOWN_LOCATION_KEY, JSON.stringify(loc));
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve a fresh position, cheapest source first: the OS last-known fix
 * (instant when any app touched GPS recently), then an actual fix. The
 * result is written to the cache.
 *
 * Does NOT prompt for permission — callers that need the prompt request it
 * themselves so they control the UX around a denial.
 */
export async function getFreshPosition(
  accuracy: Location.Accuracy = Location.Accuracy.Balanced,
): Promise<LatLng | null> {
  try {
    let pos = await Location.getLastKnownPositionAsync();
    if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy });
    if (!pos) return null;
    const { latitude, longitude } = pos.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const loc = { latitude, longitude };
    void cacheLocation(loc);
    return loc;
  } catch {
    return null;
  }
}

/**
 * BUG-282 — two-stage map centering as [lng, lat], ready for Mapbox.
 *
 * Stage 1 reads the cache so the map opens on the right city in the first
 * frame; stage 2 overrides it with a real fix. Stage 2 is what saves a
 * first-ever install (empty cache) or a rider who changed cities from
 * opening at the demo/Havana fallback.
 *
 * Assumes permission was already granted elsewhere: it only reads the
 * status, never prompts.
 */
export function useTwoStageUserCenter(enabled: boolean): [number, number] | null {
  const [center, setCenter] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Stage 1 — cache (instant, no GPS hardware wait)
    void readCachedLocation().then((cached) => {
      if (cancelled || !cached) return;
      setCenter([cached.longitude, cached.latitude]);
    });

    // Stage 2 — real fix (overrides the cache once it lands)
    void (async () => {
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (cancelled || perm?.status !== 'granted') return;
      const fresh = await getFreshPosition();
      if (cancelled || !fresh) return;
      setCenter([fresh.longitude, fresh.latitude]);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return center;
}
