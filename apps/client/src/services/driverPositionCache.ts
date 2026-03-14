// ============================================================
// TriciGo — Driver Position Cache
// Caches the last known driver position for offline resilience.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_KEY = '@tricigo/driver-position-cache';

export interface CachedPosition {
  rideId: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  timestamp: number;
}

/**
 * Cache the driver's current position for an active ride.
 */
export async function cacheDriverPosition(data: CachedPosition): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Best effort
  }
}

/**
 * Get the cached driver position for a specific ride.
 * Returns null if no cache exists or if the ride ID doesn't match.
 */
export async function getCachedDriverPosition(
  rideId: string,
): Promise<CachedPosition | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached: CachedPosition = JSON.parse(raw);
    if (cached.rideId !== rideId) return null;
    return cached;
  } catch {
    return null;
  }
}

/**
 * Clear the cached driver position (after ride completes/cancels).
 */
export async function clearDriverPositionCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Best effort
  }
}
