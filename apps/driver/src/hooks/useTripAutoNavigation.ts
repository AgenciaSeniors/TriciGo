/**
 * useTripAutoNavigation — extracted from DriverTripView for PR-A.
 *
 * Encapsulates the side-effects that auto-drive the in-app turn-by-turn
 * navigation across a trip:
 *   1. Auto-start to the PICKUP when a ride is just accepted / driver_en_route.
 *   2. Auto-start the CONTINUOUS trip nav (dropoff, threading through the
 *      pending passenger stops) when the trip flips to in_progress.
 *   3. Re-thread the active trip nav whenever the pending-stop list changes
 *      (the passenger added a stop, or the driver departed one) — via
 *      inAppNav.updateNavWaypoints, WITHOUT restarting navigation.
 *
 * Effects 1 & 2 are gated by:
 *   - Driver location available (no point trying to nav without GPS)
 *   - Navigation not already running / loading
 *   - A per-ride latch (autoStartedRef / autoRetargetedRef) so the effect
 *     doesn't re-fire on every render. The latches reset when activeTrip.id
 *     changes (a new ride should trigger a fresh auto-start).
 */
import { useEffect, useRef } from 'react';
import type { GeoPoint } from '@tricigo/utils';

interface InAppNavigation {
  isNavigating: boolean;
  isLoading: boolean;
  startNavigation: (target: GeoPoint, waypoints?: GeoPoint[]) => void;
  updateNavWaypoints: (waypoints: GeoPoint[]) => void;
}

interface UseTripAutoNavigationArgs {
  rideId: string | null | undefined;
  status: string | null | undefined;
  pickupLocation: GeoPoint | null;
  dropoffLocation: GeoPoint | null;
  /**
   * Pending passenger stops (not yet departed), in visit order. Threaded into
   * the trip-phase navigation so the voice guides driver → stops → dropoff.
   */
  pendingWaypoints: GeoPoint[];
  driverLocation: GeoPoint | null;
  inAppNav: InAppNavigation;
}

export function useTripAutoNavigation({
  rideId,
  status,
  pickupLocation,
  dropoffLocation,
  pendingWaypoints,
  driverLocation,
  inAppNav,
}: UseTripAutoNavigationArgs) {
  const autoStartedRef = useRef(false);
  const autoRetargetedRef = useRef(false);

  // Reset both latches when the active ride changes.
  useEffect(() => {
    autoStartedRef.current = false;
    autoRetargetedRef.current = false;
  }, [rideId]);

  // Auto-start to pickup on accepted / driver_en_route.
  useEffect(() => {
    if (!rideId || !driverLocation) return;
    if (inAppNav.isNavigating || inAppNav.isLoading) return;
    if (autoStartedRef.current) return;

    if ((status === 'accepted' || status === 'driver_en_route') && pickupLocation) {
      autoStartedRef.current = true;
      inAppNav.startNavigation(pickupLocation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId, status, !!driverLocation, inAppNav.isNavigating, inAppNav.isLoading]);

  // Auto-start the CONTINUOUS trip nav when the trip begins: navigate to the
  // dropoff THROUGH the pending stops (one route, driver → stops → dropoff).
  // With no stops this is a plain single-destination nav (identical to before).
  useEffect(() => {
    if (!rideId || status !== 'in_progress' || !driverLocation) return;
    if (inAppNav.isNavigating || inAppNav.isLoading) return;
    if (autoRetargetedRef.current) return;

    if (dropoffLocation) {
      autoRetargetedRef.current = true;
      inAppNav.startNavigation(dropoffLocation, pendingWaypoints);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, !!driverLocation, inAppNav.isNavigating, inAppNav.isLoading]);

  // Re-thread the active trip nav when the pending-stop list changes (the
  // passenger added a stop, or the driver departed one). No-op (deduped inside
  // updateNavWaypoints) when the list is unchanged.
  const pendingKey = pendingWaypoints.map((w) => `${w.latitude},${w.longitude}`).join('|');
  useEffect(() => {
    if (status !== 'in_progress' || !inAppNav.isNavigating) return;
    inAppNav.updateNavWaypoints(pendingWaypoints);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, status, inAppNav.isNavigating]);
}
