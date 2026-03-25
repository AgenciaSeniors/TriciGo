import { useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import { rideService, driverService, locationService, notificationService } from '@tricigo/api';
import { triggerHaptic, playSound, logger } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';
import type { RideStatus } from '@tricigo/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/** Next status in the ride FSM for driver actions. */
const NEXT_STATUS: Partial<Record<RideStatus, RideStatus>> = {
  accepted: 'driver_en_route',
  driver_en_route: 'arrived_at_pickup',
  arrived_at_pickup: 'in_progress',
  in_progress: 'completed',
};

/**
 * Initialize driver ride state on mount.
 * Checks for an active trip and restores state.
 */
export function useDriverRideInit() {
  const profile = useDriverStore((s) => s.profile);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const { setActiveTrip } = useDriverRideStore();
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!isInitialized || !profile) return;

    let mounted = true;

    async function checkActive() {
      try {
        const trip = await driverService.getActiveTrip(profile!.id);
        if (!mounted) return;

        if (!trip) {
          const localTrip = useDriverRideStore.getState().activeTrip;
          if (localTrip) {
            logger.info('[Reconcile] Clearing stale local trip', { ride_id: localTrip.id });
            useDriverRideStore.getState().clearActiveTrip?.() || useDriverRideStore.getState().setActiveTrip?.(null);
          }
          logger.info('[Reconcile] Result', { had_local_trip: !!localTrip, server_trip: false, action: 'cleared' });
          return;
        }

        // If trip already completed/canceled, don't set as active
        if (trip.status === 'completed' || trip.status === 'canceled') {
          useDriverRideStore.getState().reset();
          return;
        }

        setActiveTrip(trip);

        logger.info('[Reconcile] Result', {
          had_local_trip: !!useDriverRideStore.getState().activeTrip,
          server_trip: true,
          action: 'synced',
        });

        // Subscribe to trip updates
        if (channelRef.current) {
          const old = channelRef.current;
          channelRef.current = null;
          old.unsubscribe();
        }
        channelRef.current = rideService.subscribeToRide(trip.id, (ride) => {
          useDriverRideStore.getState().updateActiveTrip(ride);
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        const isNetworkError = errorMsg.includes('network') ||
          errorMsg.includes('timeout') ||
          errorMsg.includes('fetch') ||
          errorMsg.includes('Failed to fetch') ||
          (err instanceof Error && err.name === 'AbortError');

        const isAuthError = errorMsg.includes('JWT') ||
          errorMsg.includes('token') ||
          errorMsg.includes('401') ||
          errorMsg.includes('auth');

        if (isNetworkError) {
          logger.warn('[Reconcile] Network error, keeping local state', { error: errorMsg });
          // Retry in 30 seconds
          setTimeout(() => { if (mounted) checkActive(); }, 30_000);
        } else if (isAuthError) {
          logger.error('[Reconcile] Auth error', { error: errorMsg });
        } else {
          logger.error('[Reconcile] Server error', { error: errorMsg });
          // Only clear if we don't have a local trip
          const localTrip = useDriverRideStore.getState().activeTrip;
          if (localTrip) {
            logger.warn('[Reconcile] Keeping local trip despite server error');
          }
        }

        logger.info('[Reconcile] Result', {
          had_local_trip: !!useDriverRideStore.getState().activeTrip,
          server_trip: false,
          action: isNetworkError ? 'retry' : 'kept_local',
        });
      }
    }

    checkActive();

    // Bug 36: Re-check active trip when app returns from background
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mounted) checkActive();
    });

    return () => {
      mounted = false;
      channelRef.current?.unsubscribe();
      appStateSub.remove();
    };
  }, [isInitialized, profile, setActiveTrip]);
}

/**
 * Manage incoming ride requests subscription.
 */
export function useIncomingRequests(isOnline: boolean) {
  const { addRequest, removeRequest, removeStaleRequests, clearRequests } = useDriverRideStore();
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Periodically remove stale requests (>30s old)
  useEffect(() => {
    const cleanup = setInterval(() => removeStaleRequests(), 15_000);
    return () => clearInterval(cleanup);
  }, [removeStaleRequests]);

  useEffect(() => {
    if (!isOnline) {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      clearRequests();
      return;
    }

    // Fetch existing searching rides
    rideService.getSearchingRides().then((rides) => {
      for (const ride of rides) {
        addRequest(ride);
      }
    }).catch((err) => console.warn('[DriverRide] Failed to fetch rides:', err));

    // Subscribe to new rides
    channelRef.current = rideService.subscribeToNewRides(
      // On INSERT (new searching ride)
      (ride) => {
        addRequest(ride);
        triggerHaptic('warning');
        playSound('new_request');
      },
      // On UPDATE (ride status changed)
      (ride) => {
        if (ride.status !== 'searching') {
          removeRequest(ride.id);
        }
      },
    );

    // Fallback polling every 30s in case realtime disconnects silently
    const pollInterval = setInterval(async () => {
      try {
        const rides = await rideService.getSearchingRides();
        for (const ride of rides) addRequest(ride);
      } catch { /* best-effort fallback */ }
    }, 30000);

    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      clearInterval(pollInterval);
    };
  }, [isOnline, addRequest, removeRequest, clearRequests]);
}

/**
 * Driver ride actions: accept, advance status, cancel.
 */
export function useDriverRideActions() {
  const profile = useDriverStore((s) => s.profile);
  const user = useAuthStore((s) => s.user);
  const { setActiveTrip, removeRequest, reset } = useDriverRideStore();
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      channelRef.current?.unsubscribe();
    };
  }, []);

  const completingRef = useRef(false);

  const acceptRide = useCallback(async (rideId: string) => {
    if (!profile || profile.status !== 'approved') return;
    // Bug 22: Block accept while completing previous ride
    if (completingRef.current) {
      Toast.show({ type: 'info', text1: i18next.t('driver:common.completing_ride', { defaultValue: 'Completando viaje anterior...' }) });
      return;
    }

    try {
      const ride = await driverService.acceptRideWithEligibility(rideId, profile.id);
      setActiveTrip(ride);
      removeRequest(rideId);
      triggerHaptic('success');
      playSound('ride_accepted');

      // Clean up previous subscription before creating new one
      if (channelRef.current) {
        const oldChannel = channelRef.current;
        channelRef.current = null;
        oldChannel.unsubscribe();
      }
      channelRef.current = rideService.subscribeToRide(ride.id, (updated) => {
        useDriverRideStore.getState().updateActiveTrip(updated);
      });
    } catch {
      Toast.show({ type: 'error', text1: i18next.t('driver:common.ride_already_accepted') });
      removeRequest(rideId);
    }
  }, [profile, setActiveTrip, removeRequest]);

  const advanceStatus = useCallback(async () => {
    if (completingRef.current) return; // Prevent double execution
    const { activeTrip } = useDriverRideStore.getState();
    if (!activeTrip || !profile) return;

    const nextStatus = NEXT_STATUS[activeTrip.status];
    if (!nextStatus) {
      console.warn('[DriverRide] No valid next status for:', activeTrip.status);
      return;
    }

    try {
      if (nextStatus === 'completed') {
        completingRef.current = true;
        // Calculate actual duration from pickup_at
        const pickupTime = activeTrip.pickup_at
          ? new Date(activeTrip.pickup_at).getTime()
          : activeTrip.accepted_at
            ? new Date(activeTrip.accepted_at).getTime()
            : Date.now() - 60000;
        const actualDurationS = Math.round((Date.now() - pickupTime) / 1000);

        // Calculate distance from GPS trail, fall back to estimate
        let actualDistanceM = activeTrip.estimated_distance_m;
        let gpsPointCount = 0;
        try {
          const distResult = await locationService.calculateRideDistance(activeTrip.id);
          gpsPointCount = distResult.point_count ?? 0;
          if (gpsPointCount >= 2) {
            actualDistanceM = distResult.distance_m;
          }
        } catch {
          // Fall back to estimated distance
        }

        // Warn if GPS trail is suspiciously short (possible fraud or GPS issue)
        const estimatedM = activeTrip.estimated_distance_m ?? 0;
        if (gpsPointCount < 10 && estimatedM > 0 && actualDistanceM < estimatedM * 0.5) {
          console.warn(`[DriverRide] Low GPS quality: ${gpsPointCount} points, actual=${actualDistanceM}m vs estimated=${estimatedM}m`);
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.low_gps_warning', { defaultValue: 'GPS limitado — la tarifa se ajustará automáticamente' }),
          });
        }

        // Retry logic — trip completion is critical and must survive transient failures
        let result: Awaited<ReturnType<typeof driverService.completeRide>> | undefined;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await driverService.completeRide({
              rideId: activeTrip.id,
              driverId: profile.id,
              actualDistanceM,
              actualDurationS,
            });
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < 3) {
              await new Promise<void>((r) => setTimeout(r, attempt * 2000));
            }
          }
        }
        if (!result) throw lastErr;

        triggerHaptic('success');
        playSound('trip_completed');

        // Send receipt email to passenger (non-blocking)
        notificationService.sendRideReceipt(activeTrip.id, activeTrip.customer_id)
          .catch((err) => console.warn('[Receipt] email failed:', err));

        useDriverRideStore.getState().updateActiveTrip({
          ...activeTrip,
          status: 'completed',
          final_fare_cup: result.final_fare_cup,
          actual_distance_m: actualDistanceM,
          actual_duration_s: actualDurationS,
          share_token: result.share_token,
          completed_at: new Date().toISOString(),
        });
      } else {
        await driverService.updateRideStatus(activeTrip.id, nextStatus);
        useDriverRideStore.getState().updateActiveTrip({
          ...activeTrip,
          status: nextStatus,
        });
      }
    } catch (err) {
      Toast.show({ type: 'error', text1: i18next.t('driver:trip.status_update_failed') });
    } finally {
      completingRef.current = false;
    }
  }, [profile]);

  const cancelTrip = useCallback(async (reason?: string) => {
    const { activeTrip } = useDriverRideStore.getState();
    if (!activeTrip) return;

    try {
      await rideService.cancelRide(activeTrip.id, user?.id, reason);
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      reset();
    } catch {
      Toast.show({ type: 'error', text1: i18next.t('driver:trip.cancel_failed') });
    }
  }, [user, reset]);

  const clearCompletedTrip = useCallback(() => {
    channelRef.current?.unsubscribe();
    channelRef.current = null;
    useDriverRideStore.getState().setActiveTrip(null);
  }, []);

  return { acceptRide, advanceStatus, cancelTrip, clearCompletedTrip };
}
