/**
 * usePopularLocations — Phase 2 N5.
 *
 * Polls the `get_popular_locations` RPC (migration 00083) for stable
 * historical pickup/dropoff clusters around the driver's current
 * position. Drives the optional "Hot pickup zones" map overlay
 * landed in N5.
 *
 * Different cadence from `useDemandHotspots`: the underlying
 * materialized view refreshes daily, so polling every 30 seconds
 * would be wasteful. We poll every 5 minutes — a fresh request only
 * matters when the driver moves significantly.
 *
 * Silent failure — this is a UX nicety, not critical path.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import type { PopularLocation } from '@tricigo/types';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 min — view refreshes daily
const RADIUS_M = 5000;
const LIMIT = 30;

interface UsePopularLocationsArgs {
  /** Driver's current center (lat, lng). */
  center: { lat: number; lng: number } | null;
  /** Master switch — typically tied to a user toggle in the UI. */
  enabled: boolean;
}

export function usePopularLocations({
  center,
  enabled,
}: UsePopularLocationsArgs): PopularLocation[] {
  const [locations, setLocations] = useState<PopularLocation[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLocations = useCallback(async () => {
    if (!center) return;
    try {
      const data = await rideService.getPopularLocations({
        lat: center.lat,
        lng: center.lng,
        radiusM: RADIUS_M,
        limit: LIMIT,
      });
      setLocations(data);
    } catch {
      // Silent — cosmetic layer
    }
  }, [center]);

  useEffect(() => {
    if (!enabled || !center) {
      setLocations([]);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchLocations();
    intervalRef.current = setInterval(fetchLocations, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, center, fetchLocations]);

  return locations;
}
