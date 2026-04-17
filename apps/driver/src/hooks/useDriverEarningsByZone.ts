import { useEffect, useState } from 'react';
import { walletService } from '@tricigo/api';
import type { DriverEarningsByZone } from '@tricigo/types';

interface UseDriverEarningsByZoneArgs {
  driverId: string | null;
  start: Date | null;
  end: Date | null;
  enabled: boolean;
}

/**
 * Fetches the top 5 zones by driver earnings for a date range.
 * Single fetch per (driverId, start, end) — no polling (data is
 * historical for the selected period, not live).
 * See migration 00128 for the `get_driver_earnings_by_zone` RPC.
 */
export function useDriverEarningsByZone({
  driverId,
  start,
  end,
  enabled,
}: UseDriverEarningsByZoneArgs): {
  data: DriverEarningsByZone[];
  loading: boolean;
} {
  const [data, setData] = useState<DriverEarningsByZone[]>([]);
  const [loading, setLoading] = useState(false);

  const startKey = start?.toISOString() ?? null;
  const endKey = end?.toISOString() ?? null;

  useEffect(() => {
    if (!enabled || !driverId || !start || !end) {
      setData([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    walletService
      .getDriverEarningsByZone({ driverId, start, end })
      .then((rows) => {
        if (!cancelled) setData(rows);
      })
      .catch(() => {
        if (!cancelled) setData([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, driverId, startKey, endKey]);

  return { data, loading };
}
