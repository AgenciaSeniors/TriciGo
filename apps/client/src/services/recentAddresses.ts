// ============================================================
// Recent Addresses Service
// Persists last 10 selected addresses in AsyncStorage
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import { haversineDistance } from '@tricigo/utils';

const STORAGE_KEY = '@tricigo/recent_addresses';
const MAX_ENTRIES = 10;
/** Two addresses within 50 m are considered the same place */
const DEDUP_THRESHOLD_M = 50;

export interface RecentAddress {
  address: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * Get all recent addresses (most-recent first).
 */
async function getAll(): Promise<RecentAddress[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Add an address to the recent list.
 * - Deduplicates by proximity (50 m threshold)
 * - Prepends (most recent first)
 * - Trims to MAX_ENTRIES
 * Returns the updated list.
 */
async function add(
  address: string,
  latitude: number,
  longitude: number,
): Promise<RecentAddress[]> {
  const current = await getAll();

  // Remove any existing entry within DEDUP_THRESHOLD_M
  const filtered = current.filter(
    (entry) =>
      haversineDistance(
        { latitude: entry.latitude, longitude: entry.longitude },
        { latitude, longitude },
      ) > DEDUP_THRESHOLD_M,
  );

  const entry: RecentAddress = {
    address,
    latitude,
    longitude,
    timestamp: Date.now(),
  };

  const updated = [entry, ...filtered].slice(0, MAX_ENTRIES);

  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Silently ignore write failures — not critical
  }

  return updated;
}

/**
 * Clear all recent addresses.
 */
async function clear(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silently ignore
  }
}

export const recentAddressService = { getAll, add, clear };
