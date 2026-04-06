// ============================================================
// TriciGo — useSearchingDrivers
// Subscribes to Supabase Presence to track which drivers are
// reviewing the passenger's ride request in real-time.
// ============================================================

import { useEffect, useRef } from 'react';
import { presenceService } from '@tricigo/api';
import { logger } from '@tricigo/utils';
import { useRideStore } from '@/stores/ride.store';
import type { SearchingDriverPresence, DriverAcceptedBroadcast } from '@tricigo/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/** Duration of the accept animation in ms */
const ACCEPT_ANIMATION_DURATION = 2000;

/**
 * Safety timeout: if the broadcast arrives but the DB status
 * never changes to 'accepted' within this window, dismiss the
 * accept animation and resume the searching state.
 * This handles the race condition where a driver broadcasts
 * acceptance but loses the row-lock to another driver.
 */
const ACCEPT_SAFETY_TIMEOUT = 5000;

/**
 * Subscribe to the ride-search Presence channel.
 *
 * Returns live `searchingDrivers`, `acceptedDriver`, and
 * `isAcceptAnimating` from the Zustand store.
 *
 * Pass `rideId = null` to disable the subscription.
 */
export function useSearchingDrivers(rideId: string | null) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchingDrivers = useRideStore((s) => s.searchingDrivers);
  const acceptedDriver = useRideStore((s) => s.acceptedDriverBroadcast);
  const isAcceptAnimating = useRideStore((s) => s.isAcceptAnimating);

  useEffect(() => {
    if (!rideId) return;

    const {
      setSearchingDrivers,
      setAcceptedDriver,
      setAcceptAnimating,
    } = useRideStore.getState();

    const handleSync = (drivers: SearchingDriverPresence[]) => {
      setSearchingDrivers(drivers);
      logger.info('[SearchPresence] sync', {
        rideId,
        driverCount: drivers.length,
        driverIds: drivers.map((d) => d.driverId),
      });
    };

    const handleAccepted = (data: DriverAcceptedBroadcast) => {
      logger.info('[SearchPresence] driver_accepted broadcast', {
        rideId,
        driverId: data.driverId,
        name: data.name,
      });

      setAcceptedDriver(data);
      setAcceptAnimating(true);

      // End animation after duration
      timerRef.current = setTimeout(() => {
        setAcceptAnimating(false);
      }, ACCEPT_ANIMATION_DURATION);

      // Safety: if ride status hasn't changed to 'accepted' within
      // ACCEPT_SAFETY_TIMEOUT, the broadcast was from a losing driver.
      // Dismiss and continue searching.
      safetyTimerRef.current = setTimeout(() => {
        const currentRide = useRideStore.getState().activeRide;
        if (currentRide && currentRide.status === 'searching') {
          logger.warn('[SearchPresence] Safety timeout: DB status still searching, dismissing accept', {
            rideId,
            broadcastDriverId: data.driverId,
          });
          setAcceptedDriver(null);
          setAcceptAnimating(false);
        }
      }, ACCEPT_SAFETY_TIMEOUT);
    };

    channelRef.current = presenceService.subscribeToSearchingDrivers(
      rideId,
      handleSync,
      handleAccepted,
    );

    return () => {
      presenceService.unsubscribeSearch(rideId);
      channelRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      // Clear state on unmount
      const store = useRideStore.getState();
      store.clearSearchState();
    };
  }, [rideId]);

  return {
    searchingDrivers,
    acceptedDriver,
    isAcceptAnimating,
    driverCount: searchingDrivers.length,
  };
}
