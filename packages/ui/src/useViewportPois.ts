import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchPoisInViewport, mapLogger, formatBbox, type ViewportPoi } from '@tricigo/utils';

interface ViewportBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

interface UserCenter {
  latitude: number;
  longitude: number;
}

/**
 * Fetches POIs within the current map viewport, debounced on camera changes.
 * Mirrors the web BookingMap POI loading pattern with 20% bounds padding
 * and skip-if-still-within-last-bounds optimization.
 *
 * Pass `initialCenter` so the hook can prime POIs immediately (with bounds
 * synthesized from a ~0.02° box around that point) instead of waiting for
 * the first onMapIdle event from the map. Without this seed, on cold mount
 * the user may see a blank map for several seconds — or forever if the
 * Mapbox SDK never emits onMapIdle with valid visibleBounds (observed with
 * the new arch + 10.3.0 combo on Android).
 */
export function useViewportPois(initialCenter?: UserCenter | null) {
  const [pois, setPois] = useState<ViewportPoi[]>([]);
  const lastBoundsRef = useRef<ViewportBounds | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPois = useCallback((bounds: ViewportBounds, zoom: number) => {
    // Too zoomed out — clear POIs. The threshold matches the RPC's
    // lowest-zoom branch (00310 returns top-100 importance=1 at zoom
    // 8-10 for the "country/province overview" path). Below zoom 8 the
    // viewport spans more than Cuba itself — no point fetching.
    if (zoom < 8) {
      mapLogger.viewport({
        bbox: formatBbox(bounds),
        zoom: Math.floor(zoom),
        source: 'clear',
        reason: 'zoom_below_threshold',
      });
      setPois([]);
      lastBoundsRef.current = null;
      return;
    }

    // Pad bounds by 20% to avoid refetch on small pans
    const lngPad = (bounds.maxLng - bounds.minLng) * 0.2;
    const latPad = (bounds.maxLat - bounds.minLat) * 0.2;
    const padded: ViewportBounds = {
      minLng: bounds.minLng - lngPad,
      minLat: bounds.minLat - latPad,
      maxLng: bounds.maxLng + lngPad,
      maxLat: bounds.maxLat + latPad,
    };

    // Skip if still within last fetched padded bounds
    const last = lastBoundsRef.current;
    if (
      last &&
      bounds.minLng >= last.minLng &&
      bounds.minLat >= last.minLat &&
      bounds.maxLng <= last.maxLng &&
      bounds.maxLat <= last.maxLat
    ) {
      mapLogger.viewport({
        bbox: formatBbox(bounds),
        zoom: Math.floor(zoom),
        source: 'skipped',
        reason: 'inside_padded_bounds',
      });
      return;
    }

    // Cancel previous inflight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetchPoisInViewport(padded, zoom, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setPois(result);
      lastBoundsRef.current = padded;
      mapLogger.viewport({
        bbox: formatBbox(padded),
        zoom: Math.floor(zoom),
        count: result.length,
        source: 'pan',
      });
    }).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      mapLogger.viewport({
        bbox: formatBbox(padded),
        zoom: Math.floor(zoom),
        source: 'pan',
        error: String(err instanceof Error ? err.message : err),
      });
    });
  }, []);

  /** Call this from onRegionDidChange / onCameraChanged with debounce */
  const onCameraChanged = useCallback(
    (bounds: ViewportBounds, zoom: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => loadPois(bounds, zoom), 300);
    },
    [loadPois],
  );

  // Initial seed when we have a known user center: synthesize bounds from
  // a ~0.02° box (≈ 2 km square at La Habana's latitude) and zoom 14, then
  // fire loadPois directly. This guarantees POIs appear on cold mount even
  // when onMapIdle never emits a usable visibleBounds (intermittent on the
  // new arch + 10.3.0 combo). Re-runs only when initialCenter coords change
  // by more than ~0.005° (~500 m) to avoid thrashing on micro-updates.
  const lastSeedKeyRef = useRef<string>('');
  useEffect(() => {
    if (!initialCenter) return;
    const seedKey = `${initialCenter.latitude.toFixed(2)},${initialCenter.longitude.toFixed(2)}`;
    if (lastSeedKeyRef.current === seedKey) return;
    lastSeedKeyRef.current = seedKey;
    const HALF = 0.01; // ~1.1 km half-side at the equator, less near 23°N
    const seedBounds: ViewportBounds = {
      minLng: initialCenter.longitude - HALF,
      minLat: initialCenter.latitude - HALF,
      maxLng: initialCenter.longitude + HALF,
      maxLat: initialCenter.latitude + HALF,
    };
    mapLogger.viewport({
      bbox: formatBbox(seedBounds),
      zoom: 14,
      source: 'seed',
    });
    loadPois(seedBounds, 14);
  }, [initialCenter, loadPois]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { pois, onCameraChanged };
}
