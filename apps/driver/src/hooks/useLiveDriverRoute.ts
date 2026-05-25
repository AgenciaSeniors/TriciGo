import { useEffect, useState, useRef } from 'react';
import { fetchRoute, haversineDistance, distanceToPolyline } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/**
 * BUG-279 (driver-side parity) — live OSRM route that refetches when the
 * driver deviates from the polyline.
 *
 * The driver app previously rendered a "legRoute" polyline computed by
 * `useRoutePolyline(driverLocation, target)` whose cache key was
 * `lat,lng-lat,lng`. The cache key changed every GPS sample (~1 Hz), so
 * either it spammed OSRM with one fetch per second, or — once OSRM rate-
 * limited — it stopped updating entirely. The displayed line stayed
 * glued to the original path while the driver took a different street.
 *
 * useLiveDriverRoute keeps a single fetched polyline cached and only
 * refetches when:
 *   • This is the first fetch (no polyline yet), OR
 *   • The driver is more than DEVIATION_M (25 m) from the cached polyline
 *     AND at least MIN_INTERVAL_MS (3 s) has passed since the last fetch
 *
 * This mirrors the client-side `useLiveDriverRoute` so the driver and
 * the rider see the SAME up-to-date route after a deviation.
 *
 * PR C of routing fixes (2026-05-25): the previous 50 m / 5 s thresholds
 * let drivers take a contraflow shortcut for ~half a block before the
 * route corrected. Tighter values catch the misroute faster so the
 * "Dirígete por X" instruction updates while it's still actionable.
 */

const DEVIATION_M = 25;
const MIN_INTERVAL_MS = 3_000;
const NEAR_TARGET_M = 50;

export function useLiveDriverRoute(
  driverPosition: GeoPoint | null,
  target: GeoPoint | null,
  enabled: boolean,
): GeoPoint[] | null {
  const [coordinates, setCoordinates] = useState<GeoPoint[] | null>(null);
  const lastFetchTimeRef = useRef(0);
  const currentRouteRef = useRef<GeoPoint[] | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Reset when disabled
  useEffect(() => {
    if (!enabled) {
      setCoordinates(null);
      currentRouteRef.current = null;
      lastFetchTimeRef.current = 0;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !driverPosition || !target) return;

    const distToTarget = haversineDistance(driverPosition, target);
    if (distToTarget < NEAR_TARGET_M) {
      setCoordinates(null);
      currentRouteRef.current = null;
      return;
    }

    if (inFlightRef.current) return;

    const now = Date.now();
    const sinceLastFetch = now - lastFetchTimeRef.current;
    const isFirstFetch = lastFetchTimeRef.current === 0;
    const currentRoute = currentRouteRef.current;

    let shouldFetch = false;
    let reason: 'first' | 'deviation' | 'stale-no-cache' | 'skip' = 'skip';
    let offRouteM = 0;

    if (isFirstFetch) {
      shouldFetch = true;
      reason = 'first';
    } else if (currentRoute && currentRoute.length >= 2) {
      offRouteM = distanceToPolyline(driverPosition, currentRoute);
      if (offRouteM > DEVIATION_M && sinceLastFetch >= MIN_INTERVAL_MS) {
        shouldFetch = true;
        reason = 'deviation';
      }
    } else if (sinceLastFetch >= MIN_INTERVAL_MS) {
      shouldFetch = true;
      reason = 'stale-no-cache';
    }

    if (!shouldFetch) return;

    // eslint-disable-next-line no-console
    console.log('[driver useLiveDriverRoute] refetch', {
      reason,
      off_m: Math.round(offRouteM),
      since_last_ms: sinceLastFetch,
      target: { lat: target.latitude.toFixed(5), lng: target.longitude.toFixed(5) },
    });

    let cancelled = false;
    inFlightRef.current = true;

    (async () => {
      const result = await fetchRoute(
        { lat: driverPosition.latitude, lng: driverPosition.longitude },
        { lat: target.latitude, lng: target.longitude },
      );

      if (cancelled || !mountedRef.current) {
        inFlightRef.current = false;
        return;
      }

      lastFetchTimeRef.current = Date.now();
      inFlightRef.current = false;

      if (result) {
        const coords = result.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
        currentRouteRef.current = coords;
        setCoordinates(coords);
        // eslint-disable-next-line no-console
        console.log('[driver useLiveDriverRoute] route updated', {
          points: coords.length,
          distance_m: result.distance_m,
        });
      }
    })();

    return () => { cancelled = true; };
  }, [
    enabled,
    driverPosition?.latitude,
    driverPosition?.longitude,
    target?.latitude,
    target?.longitude,
  ]);

  return coordinates;
}
