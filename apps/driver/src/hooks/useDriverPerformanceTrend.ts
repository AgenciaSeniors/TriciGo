/**
 * useDriverPerformanceTrend — Phase 2 N3 deep.
 *
 * Lazy-fetch wrapper around `driverService.getPerformanceTrend()`
 * (RPC `get_driver_performance_trend`, migration 00260).
 *
 * Returns one row per day in the window — including zero-rows for
 * days with no activity. Tolerates the RPC being absent in prod
 * (00260 not yet applied) by silently returning an empty array.
 */
import { useEffect, useState } from 'react';
import { driverService } from '@tricigo/api';
import type { DriverPerformanceTrendDay } from '@tricigo/types';

interface UseDriverPerformanceTrendArgs {
  driverId: string | null;
  days?: number;
}

interface UseDriverPerformanceTrendResult {
  trend: DriverPerformanceTrendDay[];
  loading: boolean;
}

export function useDriverPerformanceTrend({
  driverId,
  days = 30,
}: UseDriverPerformanceTrendArgs): UseDriverPerformanceTrendResult {
  const [trend, setTrend] = useState<DriverPerformanceTrendDay[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!driverId) {
      setTrend([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    driverService
      .getPerformanceTrend(driverId, days)
      .then((data) => {
        if (!cancelled) setTrend(data);
      })
      .catch(() => {
        // Silent fallback — handled inside the service for the
        // common 00260-not-applied case; for any other transient
        // error we'd rather show "no data" than a hard failure.
        if (!cancelled) setTrend([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, days]);

  return { trend, loading };
}
