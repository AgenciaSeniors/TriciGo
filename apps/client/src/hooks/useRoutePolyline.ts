import { useEffect, useState, useRef, useMemo } from 'react';
import { fetchRoute, fetchMultiStopRoute } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

export interface RoutePolylineResult {
  coordinates: GeoPoint[] | null;
  distanceM: number | null;
  durationS: number | null;
}

/**
 * Hook that fetches an OSRM route polyline between pickup and dropoff,
 * optionally passing through intermediate waypoints.
 * Returns coordinates + distance + duration from the route result.
 */
export function useRoutePolyline(
  pickup: GeoPoint | null | undefined,
  dropoff: GeoPoint | null | undefined,
  waypoints?: GeoPoint[],
): RoutePolylineResult {
  const [coordinates, setCoordinates] = useState<GeoPoint[] | null>(null);
  const [distanceM, setDistanceM] = useState<number | null>(null);
  const [durationS, setDurationS] = useState<number | null>(null);
  const cacheKeyRef = useRef<string>('');

  useEffect(() => {
    if (!pickup || !dropoff) {
      setCoordinates(null);
      setDistanceM(null);
      setDurationS(null);
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
        setDistanceM(result.distance_m);
        setDurationS(result.duration_s);
      } else {
        setCoordinates(null);
        setDistanceM(null);
        setDurationS(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  // BUG-071: Memoize waypoints by value (JSON.stringify) to prevent recalculation on reference changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickup?.latitude, pickup?.longitude, dropoff?.latitude, dropoff?.longitude, JSON.stringify(waypoints)]);

  return useMemo(() => ({ coordinates, distanceM, durationS }), [coordinates, distanceM, durationS]);
}
