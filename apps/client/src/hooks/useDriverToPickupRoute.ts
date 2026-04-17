import { useEffect, useState, useRef } from 'react';
import { fetchRoute, haversineDistance } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/** Minimum interval between route recalculations (ms) */
const THROTTLE_MS = 30_000;
/** Minimum driver movement (meters) before triggering recalculation */
const MIN_MOVE_M = 100;
/** Skip route fetch if driver is very close to pickup */
const NEAR_PICKUP_M = 50;

/**
 * Hook that fetches a live-updating route from the driver's current
 * position to the pickup location. Only active during accepted/driver_en_route.
 * Throttled: max 1 fetch per 30s AND 100m minimum movement.
 */
export function useDriverToPickupRoute(
  driverPosition: GeoPoint | null,
  pickupLocation: GeoPoint | null,
  rideStatus: string | null,
): GeoPoint[] | null {
  const [coordinates, setCoordinates] = useState<GeoPoint[] | null>(null);
  const lastFetchTimeRef = useRef(0);
  const lastFetchPosRef = useRef<GeoPoint | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Clear route when status is not en-route to pickup
  useEffect(() => {
    if (rideStatus !== 'accepted' && rideStatus !== 'driver_en_route') {
      setCoordinates(null);
      lastFetchTimeRef.current = 0;
      lastFetchPosRef.current = null;
    }
  }, [rideStatus]);

  // Fetch route when driver moves enough and enough time has passed
  useEffect(() => {
    if (!driverPosition || !pickupLocation) return;
    if (rideStatus !== 'accepted' && rideStatus !== 'driver_en_route') return;

    // Skip if driver is very close to pickup
    const distToPickup = haversineDistance(driverPosition, pickupLocation);
    if (distToPickup < NEAR_PICKUP_M) {
      setCoordinates(null);
      return;
    }

    // Throttle: skip if last fetch was < THROTTLE_MS ago
    const now = Date.now();
    if (now - lastFetchTimeRef.current < THROTTLE_MS && lastFetchTimeRef.current > 0) return;

    // Skip if driver hasn't moved enough since last fetch
    if (lastFetchPosRef.current) {
      const moved = haversineDistance(lastFetchPosRef.current, driverPosition);
      if (moved < MIN_MOVE_M && lastFetchTimeRef.current > 0) return;
    }

    let cancelled = false;

    (async () => {
      const result = await fetchRoute(
        { lat: driverPosition.latitude, lng: driverPosition.longitude },
        { lat: pickupLocation.latitude, lng: pickupLocation.longitude },
      );

      if (cancelled || !mountedRef.current) return;

      lastFetchTimeRef.current = Date.now();
      lastFetchPosRef.current = driverPosition;

      if (result) {
        setCoordinates(
          result.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [driverPosition?.latitude, driverPosition?.longitude, pickupLocation?.latitude, pickupLocation?.longitude, rideStatus]);

  return coordinates;
}
