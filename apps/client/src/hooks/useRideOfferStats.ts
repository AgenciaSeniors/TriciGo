import { useState, useEffect, useRef, useCallback } from 'react';
import { rideService } from '@tricigo/api';
import type { RideOfferStats } from '@tricigo/types';

const POLL_INTERVAL_MS = 3_000;

interface UseRideOfferStatsArgs {
  rideId: string | null;
  /** Typically `ride.status === 'searching'`. Hook pauses otherwise. */
  enabled: boolean;
}

/**
 * Polls `get_ride_offer_stats` (migration 00127) every 3 seconds to
 * surface driver-count and dispatch-round progress on the rider's
 * SearchingView. Silent failure (falls back to previous snapshot).
 *
 * Not realtime because the interesting state transitions are coarse
 * (round rollover, count changes) and the RPC is an aggregate — the
 * churn from subscribing per-offer would cost more than it saves.
 */
export function useRideOfferStats({
  rideId,
  enabled,
}: UseRideOfferStatsArgs): RideOfferStats | null {
  const [stats, setStats] = useState<RideOfferStats | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    if (!rideId) return;
    try {
      const data = await rideService.getRideOfferStats(rideId);
      setStats(data);
    } catch {
      // Silent: keep previous snapshot
    }
  }, [rideId]);

  useEffect(() => {
    if (!enabled || !rideId) {
      setStats(null);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchStats();
    intervalRef.current = setInterval(fetchStats, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [enabled, rideId, fetchStats]);

  return stats;
}
