import { useState, useEffect, useRef, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import type { DemandHotspot } from '@tricigo/types';

const POLL_INTERVAL_MS = 30_000;
const RADIUS_M = 5000;

interface UseDemandHotspotsArgs {
  /** Driver's current center (lat, lng). */
  center: { lat: number; lng: number } | null;
  /** Gate — typically `isOnline && !hasActiveRide`. */
  enabled: boolean;
}

/**
 * Polls `get_demand_hotspots` RPC (migration 00125) and returns
 * the top 8 demand zones around the driver's current position.
 * Intensity (0..1) drives the pulse color in HotspotPulseMarker.
 * Silent failure — this is a UX nicety, not critical path.
 */
export function useDemandHotspots({
  center,
  enabled,
}: UseDemandHotspotsArgs): DemandHotspot[] {
  const [hotspots, setHotspots] = useState<DemandHotspot[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHotspots = useCallback(async () => {
    if (!center) return;
    try {
      const data = await rideService.getDemandHotspots({
        lat: center.lat,
        lng: center.lng,
        radiusM: RADIUS_M,
      });
      setHotspots(data);
    } catch {
      // Silent — cosmetic layer
    }
  }, [center]);

  useEffect(() => {
    if (!enabled || !center) {
      setHotspots([]);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchHotspots();
    intervalRef.current = setInterval(fetchHotspots, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, center, fetchHotspots]);

  return hotspots;
}
