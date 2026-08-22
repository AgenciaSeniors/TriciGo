// ============================================================
// TriciGo — Destination Prediction Cache
// Caches computed predictions in AsyncStorage for offline use.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PredictedDestination } from '@tricigo/utils';

// v2 (2026-08-21): key bumped to orphan every cached pre-00571 result —
// the old RPC suggested bare neighbourhoods, and the 24 h TTL would have
// kept showing them a full day after the server stopped producing them.
const CACHE_KEY = '@tricigo/destination-predictions-v2';

interface PredictionCacheEntry {
  predictions: PredictedDestination[];
  computedAt: number;
  rideCount: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cached predictions. Returns null if cache is stale or ride count changed.
 */
export async function getCachedPredictions(
  currentRideCount: number,
): Promise<PredictedDestination[] | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry: PredictionCacheEntry = JSON.parse(raw);

    const isExpired = Date.now() - entry.computedAt > CACHE_TTL_MS;
    const rideCountChanged = entry.rideCount !== currentRideCount;

    if (isExpired || rideCountChanged) return null;

    return entry.predictions;
  } catch {
    return null;
  }
}

/**
 * Save predictions to cache.
 */
export async function cachePredictions(
  predictions: PredictedDestination[],
  rideCount: number,
): Promise<void> {
  try {
    const entry: PredictionCacheEntry = {
      predictions,
      computedAt: Date.now(),
      rideCount,
    };
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Best effort
  }
}

/**
 * Invalidate prediction cache (e.g., after a ride completes).
 */
export async function invalidatePredictionCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Best effort
  }
}
