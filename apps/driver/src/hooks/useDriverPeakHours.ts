/**
 * useDriverPeakHours — Phase 2 N2.
 *
 * Lazy fetch of the driver's personal earnings × hour-of-week
 * histogram from the `get_driver_peak_hours_personal` RPC
 * (migration 00258).
 *
 * `days` defaults to 30; the call is one-shot per (driverId, days).
 * Returns `loading` so the consumer can render a skeleton while the
 * RPC resolves.
 */
import { useEffect, useState } from 'react';
import { driverService } from '@tricigo/api';
import type { DriverPeakHourCell } from '@tricigo/types';

interface UseDriverPeakHoursArgs {
  driverId: string | null | undefined;
  /** Lookback window in days; default 30. */
  days?: number;
  /** Master switch for the call. */
  enabled?: boolean;
}

interface UseDriverPeakHoursResult {
  data: DriverPeakHourCell[];
  loading: boolean;
}

export function useDriverPeakHours({
  driverId,
  days = 30,
  enabled = true,
}: UseDriverPeakHoursArgs): UseDriverPeakHoursResult {
  const [data, setData] = useState<DriverPeakHourCell[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !driverId) {
      setData([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    driverService
      .getPersonalPeakHours(driverId, days)
      .then((rows) => {
        if (cancelled) return;
        setData(rows);
      })
      .catch(() => {
        // Silent — section just won't render insights
        if (!cancelled) setData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, days, enabled]);

  return { data, loading };
}
