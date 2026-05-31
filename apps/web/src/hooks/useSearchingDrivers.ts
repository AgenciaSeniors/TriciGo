'use client';

import { useEffect, useRef, useState } from 'react';
import { presenceService } from '@tricigo/api';
import type { SearchingDriverPresence, DriverAcceptedBroadcast } from '@tricigo/types';

/**
 * Web port of the mobile client's `useSearchingDrivers`. While the ride is
 * `searching`, subscribes to the `ride-search:<rideId>` Presence channel so the
 * rider sees which drivers are reviewing the request, and receives the fast
 * `driver_accepted` broadcast to transition immediately (before the 3s poll).
 *
 * Best-effort: Realtime presence is unreliable on Cuban networks (BUG-277), so
 * status polling remains the source of truth — this only enriches the UI.
 */
export function useSearchingDrivers(
  rideId: string | null | undefined,
  active: boolean,
  onAccepted?: (data: DriverAcceptedBroadcast) => void,
): { drivers: SearchingDriverPresence[] } {
  const [drivers, setDrivers] = useState<SearchingDriverPresence[]>([]);
  const onAcceptedRef = useRef(onAccepted);
  onAcceptedRef.current = onAccepted;

  useEffect(() => {
    if (!rideId || !active) {
      setDrivers([]);
      return;
    }
    presenceService.subscribeToSearchingDrivers(
      rideId,
      (d) => setDrivers(d),
      (data) => { onAcceptedRef.current?.(data); },
    );
    return () => {
      presenceService.leaveRideSearch(rideId);
      setDrivers([]);
    };
  }, [rideId, active]);

  return { drivers };
}
