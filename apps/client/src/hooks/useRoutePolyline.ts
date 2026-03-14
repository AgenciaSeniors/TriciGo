import { useEffect, useState, useRef } from 'react';
import { fetchRoute, fetchMultiStopRoute } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/**
 * Hook that fetches an OSRM route polyline between pickup and dropoff,
 * optionally passing through intermediate waypoints.
 * Returns an array of GeoPoints for react-native-maps Polyline, or null.
 */
export function useRoutePolyline(
  pickup: GeoPoint | null | undefined,
  dropoff: GeoPoint | null | undefined,
  waypoints?: GeoPoint[],
): GeoPoint[] | null {
  const [coordinates, setCoordinates] = useState<GeoPoint[] | null>(null);
  const cacheKeyRef = useRef<string>('');

  useEffect(() => {
    if (!pickup || !dropoff) {
      setCoordinates(null);
      cacheKeyRef.current = '';
      return;
    }

    const wpKey = waypoints?.map(w => `${w.latitude},${w.longitude}`).join('|') ?? '';
    const key = `${pickup.latitude},${pickup.longitude}-${wpKey}-${dropoff.latitude},${dropoff.longitude}`;
    if (key === cacheKeyRef.current) return;

    let cancelled = false;

    (async () => {
      let result: { coordinates: [number, number][]; distance_m: number; duration_s: number } | null = null;

      if (waypoints && waypoints.length > 0) {
        const points = [
          { lat: pickup.latitude, lng: pickup.longitude },
          ...waypoints.map(w => ({ lat: w.latitude, lng: w.longitude })),
          { lat: dropoff.latitude, lng: dropoff.longitude },
        ];
        result = await fetchMultiStopRoute(points);
      } else {
        result = await fetchRoute(
          { lat: pickup.latitude, lng: pickup.longitude },
          { lat: dropoff.latitude, lng: dropoff.longitude },
        );
      }

      if (cancelled) return;

      if (result) {
        cacheKeyRef.current = key;
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
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude, waypoints]);

  return coordinates;
}
