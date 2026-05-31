'use client';

import { useEffect, useRef, useState } from 'react';
import { rideService } from '@tricigo/api';
import { RIDE_CONFIG } from '@tricigo/utils';

const HEARTBEAT_MS = 10_000;

/**
 * Web port of the mobile client's persistent driver-search loop
 * (apps/client/src/hooks/useRide.ts). While the ride is `searching`:
 *  - Heartbeat `touchSearchingRide` keeps the search alive server-side
 *    (cleanup_orphan_searching_rides only cancels rides whose heartbeat
 *    went stale).
 *  - Every SEARCH_TIMEOUT_MS, for the first SEARCH_RETRY_ROUNDS rounds,
 *    widen the dispatch radius (SEARCH_RADIUS_PROGRESSION 8km→12km) via
 *    `retryMatchDrivers`. The loop NEVER auto-cancels — the rider cancels
 *    manually; the server re-dispatches on its own regardless.
 *
 * Returns the current retry round so the UI can show "expanding search".
 */
export function useSearchingRide(rideId: string | null | undefined, active: boolean): { searchRound: number } {
  const [searchRound, setSearchRound] = useState(0);
  const roundRef = useRef(0);

  useEffect(() => {
    if (!rideId || !active) {
      roundRef.current = 0;
      setSearchRound(0);
      return;
    }
    let cancelled = false;

    // Heartbeat (fire one immediately, then on an interval).
    rideService.touchSearchingRide(rideId).catch(() => {});
    const heartbeat = setInterval(() => {
      rideService.touchSearchingRide(rideId).catch(() => {});
    }, HEARTBEAT_MS);

    // Radius-expansion loop.
    const retry = setInterval(async () => {
      if (cancelled) return;
      roundRef.current += 1;
      if (roundRef.current <= RIDE_CONFIG.SEARCH_RETRY_ROUNDS) {
        const radius = RIDE_CONFIG.SEARCH_RADIUS_PROGRESSION[roundRef.current - 1] ?? 12000;
        try {
          await rideService.retryMatchDrivers(rideId, radius);
        } catch {
          // Best-effort — the server keeps dispatching regardless.
        }
      }
      if (!cancelled) setSearchRound(roundRef.current);
    }, RIDE_CONFIG.SEARCH_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      clearInterval(retry);
    };
  }, [rideId, active]);

  return { searchRound };
}
