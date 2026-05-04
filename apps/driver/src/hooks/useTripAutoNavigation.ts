/**
 * useTripAutoNavigation — extracted from DriverTripView for PR-A.
 *
 * Encapsulates two side-effects that were entangled in the parent:
 *   1. Auto-start in-app navigation when a ride is just accepted /
 *      driver_en_route. Target: pickup location.
 *   2. Auto-retarget to the next waypoint (or dropoff) when the trip
 *      flips to in_progress.
 *
 * Both effects are gated by:
 *   - Driver location available (no point trying to nav without GPS)
 *   - Navigation not already running / loading
 *   - A per-ride latch (autoStartedRef / autoRetargetedRef) so the
 *     effect doesn't re-fire on every render.
 *
 * The latches reset whenever `activeTrip.id` changes (a new ride should
 * trigger a fresh auto-start).
 *
 * Behavior preserved verbatim from inline version.
 */
import { useEffect, useRef } from 'react';

interface InAppNavigation {
  isNavigating: boolean;
  isLoading: boolean;
  startNavigation: (target: { latitude: number; longitude: number }) => void;
}

interface UseTripAutoNavigationArgs {
  rideId: string | null | undefined;
  status: string | null | undefined;
  pickupLocation: { latitude: number; longitude: number } | null;
  dropoffLocation: { latitude: number; longitude: number } | null;
  /** Next incomplete waypoint (not yet departed). Used during in_progress. */
  nextWaypoint: {
    id: string;
    latitude: number;
    longitude: number;
    arrived_at?: string | null;
  } | null;
  driverLocation: { latitude: number; longitude: number } | null;
  inAppNav: InAppNavigation;
}

export function useTripAutoNavigation({
  rideId,
  status,
  pickupLocation,
  dropoffLocation,
  nextWaypoint,
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

  // Auto-retarget to next waypoint or dropoff when trip starts.
  useEffect(() => {
    if (!rideId || status !== 'in_progress' || !driverLocation) return;
    if (inAppNav.isNavigating || inAppNav.isLoading) return;
    if (autoRetargetedRef.current) return;

    const target = (nextWaypoint && !nextWaypoint.arrived_at)
      ? { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude }
      : dropoffLocation;

    if (target) {
      autoRetargetedRef.current = true;
      inAppNav.startNavigation(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, !!driverLocation, inAppNav.isNavigating, inAppNav.isLoading, nextWaypoint?.id]);
}
