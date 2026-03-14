import { useState, useEffect, useRef, useCallback } from 'react';
import { nearbyService } from '@tricigo/api';
import type { NearbyVehicle } from '@tricigo/types';

export function useNearbyVehicles(
  lat: number | null | undefined,
  lng: number | null | undefined,
) {
  const [vehicles, setVehicles] = useState<NearbyVehicle[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const channelRef = useRef<any>(null);

  const fetchNearby = useCallback(async () => {
    if (lat == null || lng == null) return;
    try {
      const result = await nearbyService.findNearbyVehicles({
        lat, lng, radiusM: 5000, limit: 30,
      });
      setVehicles(result);
    } catch { /* non-critical */ }
  }, [lat, lng]);

  useEffect(() => {
    if (lat == null || lng == null) {
      setVehicles([]);
      return;
    }

    fetchNearby();
    intervalRef.current = setInterval(fetchNearby, 15000);

    // Subscribe to realtime for instant position updates
    channelRef.current?.unsubscribe();
    channelRef.current = nearbyService.subscribeToDriverPositions((payload) => {
      if (!payload.is_online) {
        setVehicles(prev => prev.filter(v => v.driver_profile_id !== payload.driver_profile_id));
        return;
      }
      setVehicles(prev => {
        const idx = prev.findIndex(v => v.driver_profile_id === payload.driver_profile_id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], latitude: payload.latitude, longitude: payload.longitude, heading: payload.heading } as NearbyVehicle;
          return updated;
        }
        return prev;
      });
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      channelRef.current?.unsubscribe();
    };
  }, [lat, lng, fetchNearby]);

  return vehicles;
}
