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

/** A row is usable only if its coordinate is real: not null, not NaN, not ±Infinity. */
function hasFiniteCoords(r: unknown): r is RecentAddress {
  return (
    typeof r === 'object' && r !== null &&
    Number.isFinite((r as RecentAddress).latitude) &&
    Number.isFinite((r as RecentAddress).longitude)
  );
}

/**
 * Get all recent addresses (most-recent first). Rows with non-finite
 * coordinates (NaN / null / Infinity) are silently dropped — a bad row would
 * either crash the map on render or freeze it at (0, 0). This also self-heals
 * storage: the sanitised list is written back so the bad row does not persist.
 */
async function getAll(): Promise<RecentAddress[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const clean = parsed.filter(hasFiniteCoords);
    if (clean.length !== parsed.length) {
      // Self-heal: rewrite storage without the poisoned rows.
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(clean)).catch(() => {});
    }
    return clean;
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
  // Reject non-finite coordinates at the door. Cross-street SUGGESTIONS carry
  // { latitude: NaN, longitude: NaN, needsResolution: true } on purpose (see
  // AddressSearchInput), and if one of those slipped into a callsite it would
  // poison the recents list forever — haversineDistance(_, NaN) = NaN, and
  // `NaN > 50` is false, so the dedupe would never remove it.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return getAll();
  }

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
