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
 *  - Every SEARCH_TIMEOUT_MS it advances a round counter so the UI can show
 *    "expanding search". The radius expansion + driver offers are server-side
 *    (retry_dispatch_expired_rides cron + notify_driver_new_offer push); the
 *    old client-side `retryMatchDrivers` pushed to drivers without a
 *    ride_offer — misleading and redundant, removed (ride-flow audit #18).
 *    The loop NEVER auto-cancels — the rider cancels manually.
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

    // Round counter for the "expanding search" UI. The actual radius
    // expansion + driver offers run server-side (retry_dispatch_expired_rides
    // cron); no client-side dispatch call (ride-flow audit #18).
    const retry = setInterval(() => {
      if (cancelled) return;
      roundRef.current += 1;
      setSearchRound(roundRef.current);
    }, RIDE_CONFIG.SEARCH_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      clearInterval(retry);
    };
  }, [rideId, active]);

  return { searchRound };
}
