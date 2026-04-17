import { useState, useEffect, useRef, useCallback } from 'react';
import { nearbyService } from '@tricigo/api';
import type { NearbyVehicle } from '@tricigo/types';

const POLL_INTERVAL_MS = 20_000;
const RADIUS_M = 5000;
const LIMIT = 50;

interface UseNearbyDriversArgs {
  /** Driver's current center (lat, lng). Poll pauses when null. */
  center: { lat: number; lng: number } | null;
  /** Gate — typically `isOnline && !hasActiveRide`. */
  enabled: boolean;
  /** Own driver_profile.id — excluded from results so the driver
   *  doesn't see themselves next to their own live marker. */
  myDriverProfileId: string | null;
}

/**
 * Polls `find_nearby_vehicles` to render peer drivers on the map.
 * Passes `vehicle_type = null` to include every service type.
 * Silent fail — map layer is cosmetic, not critical path.
 */
export function useNearbyDrivers({
  center,
  enabled,
  myDriverProfileId,
}: UseNearbyDriversArgs): NearbyVehicle[] {
  const [drivers, setDrivers] = useState<NearbyVehicle[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPeers = useCallback(async () => {
    if (!center) return;
    try {
      const all = await nearbyService.findNearbyVehicles({
        lat: center.lat,
        lng: center.lng,
        vehicleType: null,
        radiusM: RADIUS_M,
        limit: LIMIT,
      });
      const filtered = myDriverProfileId
        ? all.filter((v) => v.driver_profile_id !== myDriverProfileId)
        : all;
      setDrivers(filtered);
    } catch {
      // Cosmetic layer — keep previous drivers on failure
    }
  }, [center, myDriverProfileId]);

  useEffect(() => {
    if (!enabled || !center) {
      setDrivers([]);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchPeers();
    intervalRef.current = setInterval(fetchPeers, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, center, fetchPeers]);

  return drivers;
}
