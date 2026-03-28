import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AddressSearchResult } from '@tricigo/utils';

const CACHE_KEY = '@tricigo/geocode_cache';
const MAX_ENTRIES = 100;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  results: AddressSearchResult[];
  timestamp: number;
}

type CacheMap = Record<string, CacheEntry>;

let memoryCache: CacheMap | null = null;

/** Normalize a query string for cache key */
function normalizeKey(query: string): string {
  return query.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Load cache from AsyncStorage into memory */
async function loadCache(): Promise<CacheMap> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    memoryCache = raw ? JSON.parse(raw) : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache!;
}

/** Persist memory cache to AsyncStorage */
async function persistCache(): Promise<void> {
  if (!memoryCache) return;
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache));
  } catch { /* silent */ }
}

/** Get cached results for a query. Returns null on cache miss or expired entry. */
export async function getCachedResults(query: string): Promise<AddressSearchResult[] | null> {
  const cache = await loadCache();
  const key = normalizeKey(query);
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    delete cache[key];
    return null;
  }
  return entry.results;
}

/** Store results in cache for a query. Evicts oldest entries if over limit. */
export async function setCachedResults(query: string, results: AddressSearchResult[]): Promise<void> {
  if (results.length === 0) return; // don't cache empty results
  const cache = await loadCache();
  const key = normalizeKey(query);

  cache[key] = { results, timestamp: Date.now() };

  // Evict oldest entries if over limit
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys.sort((a, b) => (cache[a]?.timestamp ?? 0) - (cache[b]?.timestamp ?? 0));
    const toRemove = sorted.slice(0, keys.length - MAX_ENTRIES);
    for (const k of toRemove) delete cache[k];
  }

  await persistCache();
}

/** Clear all cached geocode results */
export async function clearGeocodeCache(): Promise<void> {
  memoryCache = {};
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch { /* silent */ }
}
