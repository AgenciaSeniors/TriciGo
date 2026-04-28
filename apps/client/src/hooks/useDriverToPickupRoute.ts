import { useEffect, useState, useRef } from 'react';
import { fetchRoute, haversineDistance, distanceToPolyline } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/**
 * BUG-279 — live driver route with deviation detection.
 *
 * Old behavior (BUG): the polyline only refetched on a 30-second throttle
 * AND a 100 m minimum movement gate. When the driver took a parallel
 * street or made an unexpected turn, the line stayed glued to the original
 * route until the timer ticked. The user sees a marker "off the line".
 *
 * New behavior:
 *   1. Refetch IMMEDIATELY when the driver is more than DEVIATION_M from
 *      the current polyline (i.e. they took a different street).
 *   2. Light min-interval (MIN_INTERVAL_MS) only to avoid hammering OSRM
 *      while the driver moves along the existing route — once the route
 *      is correct, we don't need to refetch.
 *   3. Skip the fetch entirely when the driver is within NEAR_TARGET_M
 *      of the destination (e.g. arriving — the line would be useless).
 */

/** Re-fetch immediately when driver is this many meters off the current polyline. */
const DEVIATION_M = 50;
/** Minimum time between fetches when driver is on-route (just to avoid spam). */
const MIN_INTERVAL_MS = 5_000;
/** Skip route fetch if driver is very close to the target. */
const NEAR_TARGET_M = 50;

/**
 * Live OSRM route from the driver to a target (pickup or dropoff),
 * automatically refetched when the driver deviates more than ~50 m
 * from the previous polyline.
 *
 * Pass `enabled=false` to clear and not fetch (e.g. when status is not
 * appropriate for showing this route).
 */
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

  // Clear route when disabled
  useEffect(() => {
    if (!enabled) {
      setCoordinates(null);
      currentRouteRef.current = null;
      lastFetchTimeRef.current = 0;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !driverPosition || !target) return;

    // Skip if already very close to target
    const distToTarget = haversineDistance(driverPosition, target);
    if (distToTarget < NEAR_TARGET_M) {
      setCoordinates(null);
      currentRouteRef.current = null;
      return;
    }

    // Skip if a fetch is already in flight (avoid duplicate concurrent OSRM calls)
    if (inFlightRef.current) return;

    const now = Date.now();
    const sinceLastFetch = now - lastFetchTimeRef.current;
    const isFirstFetch = lastFetchTimeRef.current === 0;
    const currentRoute = currentRouteRef.current;

    // Decide whether to refetch:
    //   - First fetch: yes
    //   - Driver deviated > DEVIATION_M from current polyline: yes (unless we just fetched < MIN_INTERVAL_MS ago)
    //   - Otherwise: no (the existing route is still valid)
    let shouldFetch = false;

    if (isFirstFetch) {
      shouldFetch = true;
    } else if (currentRoute && currentRoute.length >= 2) {
      const offRouteM = distanceToPolyline(driverPosition, currentRoute);
      if (offRouteM > DEVIATION_M && sinceLastFetch >= MIN_INTERVAL_MS) {
        shouldFetch = true;
      }
    } else if (sinceLastFetch >= MIN_INTERVAL_MS) {
      // No current polyline cached but it's been a while — try again
      shouldFetch = true;
    }

    if (!shouldFetch) return;

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
      }
    })();

    return () => {
      cancelled = true;
      // NOTE: we don't reset inFlightRef here — the in-flight promise will
      // settle and clear it. Resetting to false would let a 2nd fetch start
      // and we want to keep just one outstanding.
    };
  }, [
    enabled,
    driverPosition?.latitude,
    driverPosition?.longitude,
    target?.latitude,
    target?.longitude,
  ]);

  return coordinates;
}

/**
 * @deprecated Use `useLiveDriverRoute` instead. Kept as a thin wrapper for
 * backward compatibility with existing callers in RideActiveView.
 */
export function useDriverToPickupRoute(
  driverPosition: GeoPoint | null,
  pickupLocation: GeoPoint | null,
  rideStatus: string | null,
): GeoPoint[] | null {
  return useLiveDriverRoute(
    driverPosition,
    pickupLocation,
    rideStatus === 'accepted' || rideStatus === 'driver_en_route',
  );
}
