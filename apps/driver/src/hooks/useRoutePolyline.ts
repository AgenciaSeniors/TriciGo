import { useEffect, useState, useRef } from 'react';
import { fetchRoute } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/**
 * Hook that fetches an OSRM route polyline between pickup and dropoff.
 * Returns an array of GeoPoints for react-native-maps Polyline, or null.
 */
export function useRoutePolyline(
  pickup: GeoPoint | null | undefined,
  dropoff: GeoPoint | null | undefined,
): GeoPoint[] | null {
  const [coordinates, setCoordinates] = useState<GeoPoint[] | null>(null);
  const cacheKeyRef = useRef<string>('');

  useEffect(() => {
    if (!pickup || !dropoff || pickup.latitude == null || pickup.longitude == null || dropoff.latitude == null || dropoff.longitude == null) {
      setCoordinates(null);
      cacheKeyRef.current = '';
      return;
    }

    // Cache key to avoid refetching same route
    const key = `${pickup.latitude},${pickup.longitude}-${dropoff.latitude},${dropoff.longitude}`;
    if (key === cacheKeyRef.current) return;

    let cancelled = false;

    (async () => {
      const result = await fetchRoute(
        { lat: pickup.latitude, lng: pickup.longitude },
        { lat: dropoff.latitude, lng: dropoff.longitude },
      );

      if (cancelled) return;

      if (result) {
        cacheKeyRef.current = key;
        // Convert [lat, lng] tuples to GeoPoint objects
        setCoordinates(
          result.coordinates.map(([lat, lng]) => ({ latitude: lat, longitude: lng })),
        );
      } else {
        setCoordinates(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude]);

  return coordinates;
}
