import { useState, useEffect, useRef, useCallback } from 'react';
import { nearbyService } from '@tricigo/api';
import type { NearbyVehicle } from '@tricigo/types';

export function useNearbyVehicles(
  lat: number | null | undefined,
  lng: number | null | undefined,
) {
  const [vehicles, setVehicles] = useState<NearbyVehicle[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchNearby = useCallback(async () => {
    if (lat == null || lng == null) {
      if (__DEV__) console.log('[useNearbyVehicles] skip — no pickup lat/lng');
      return;
    }
    try {
      const result = await nearbyService.findNearbyVehicles({
        lat, lng, radiusM: 5000, limit: 30,
      });
      if (__DEV__) console.log('[useNearbyVehicles] fetched', { count: result.length, first: result[0] });
      setVehicles(result);
    } catch (err) {
      console.warn('[useNearbyVehicles] failed', String(err));
    }
  }, [lat, lng]);

  useEffect(() => {
    if (lat == null || lng == null) {
      setVehicles([]);
      return;
    }

    // Polling only. Riders cannot read other drivers' driver_profiles rows
    // (RLS: own row or admin), so a postgres_changes subscription on that
    // table never delivered a position here and only cost the database work.
    fetchNearby();
    intervalRef.current = setInterval(fetchNearby, 15000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [lat, lng, fetchNearby]);

  return vehicles;
}
