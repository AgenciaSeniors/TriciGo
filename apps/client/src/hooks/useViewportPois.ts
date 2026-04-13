import { useState, useRef, useCallback, useEffect } from 'react';
import { fetchPoisInViewport, type ViewportPoi } from '@tricigo/utils';

interface ViewportBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * Fetches POIs within the current map viewport, debounced on camera changes.
 * Mirrors the web BookingMap POI loading pattern with 20% bounds padding
 * and skip-if-still-within-last-bounds optimization.
 */
export function useViewportPois() {
  const [pois, setPois] = useState<ViewportPoi[]>([]);
  const lastBoundsRef = useRef<ViewportBounds | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPois = useCallback((bounds: ViewportBounds, zoom: number) => {
    // Too zoomed out — clear POIs
    if (zoom < 10) {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { pois, onCameraChanged };
}
