import { useEffect, useRef, useMemo, useState } from 'react';
import { projectPointOnPolyline, formatArrivalTime } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/** Minimum interval between recalculations (ms) */
const THROTTLE_MS = 5_000;

interface UseTripProgressParams {
  driverLocation: GeoPoint | null;
  routeCoordinates: GeoPoint[] | null;
  totalDistanceM: number | null;
  etaMinutes: number | null;
  rideStatus: string | null;
}

interface TripProgressResult {
  progressPercent: number;
  distanceRemainingM: number;
  distanceRemainingKm: string;
  etaMinutes: number | null;
  arrivalTime: string | null;
  isActive: boolean;
}

const INACTIVE_RESULT: TripProgressResult = {
  progressPercent: 0,
  distanceRemainingM: 0,
  distanceRemainingKm: '0.0',
  etaMinutes: null,
  arrivalTime: null,
  isActive: false,
};

/**
 * Calculates trip progress by projecting the driver's current position
 * onto the route polyline. Progress is monotonic (never decreases).
 *
 * Only active when rideStatus is 'in_progress' or 'arrived_at_destination'.
 */
export function useTripProgress({
  driverLocation,
  routeCoordinates,
  totalDistanceM,
  etaMinutes,
  rideStatus,
}: UseTripProgressParams): TripProgressResult {
  const isActive = rideStatus === 'in_progress' || rideStatus === 'arrived_at_destination';

  const [progress, setProgress] = useState({
    progressPercent: 0,
    distanceRemainingM: 0,
  });

  const lastCalcRef = useRef(0);
  const maxProgressRef = useRef(0);

  // Reset monotonic tracker when ride becomes inactive
  useEffect(() => {
    if (!isActive) {
      maxProgressRef.current = 0;
      setProgress({ progressPercent: 0, distanceRemainingM: 0 });
    }
  }, [isActive]);

  // Recalculate progress when driver moves (throttled)
  useEffect(() => {
    if (!isActive) return;

    // Force 100% when arrived at destination
    if (rideStatus === 'arrived_at_destination') {
      maxProgressRef.current = 100;
      setProgress({ progressPercent: 100, distanceRemainingM: 0 });
      return;
    }

    if (!driverLocation || !routeCoordinates || routeCoordinates.length < 2 || !totalDistanceM) {
      return;
    }

    // Throttle recalculation
    const now = Date.now();
    if (now - lastCalcRef.current < THROTTLE_MS) return;
    lastCalcRef.current = now;

    const { distanceAlongRouteM } = projectPointOnPolyline(driverLocation, routeCoordinates);

    const rawPercent = Math.min(100, (distanceAlongRouteM / totalDistanceM) * 100);

    // Monotonic: never decrease
    const clampedPercent = Math.max(rawPercent, maxProgressRef.current);
    maxProgressRef.current = clampedPercent;

    const remaining = Math.max(0, totalDistanceM - distanceAlongRouteM);

    setProgress({
      progressPercent: Math.round(clampedPercent * 10) / 10,
      distanceRemainingM: remaining,
    });
  }, [isActive, driverLocation, routeCoordinates, totalDistanceM, rideStatus]);

  return useMemo<TripProgressResult>(() => {
    if (!isActive) return INACTIVE_RESULT;

    const remainingKm = progress.distanceRemainingM / 1000;

    // Scale ETA proportionally to remaining progress
    let scaledEta: number | null = null;
    if (etaMinutes != null && progress.progressPercent < 100) {
      const remainingFraction = 1 - progress.progressPercent / 100;
      scaledEta = Math.max(1, Math.round(etaMinutes * remainingFraction));
    } else if (progress.progressPercent >= 100) {
      scaledEta = 0;
    }

    return {
      progressPercent: progress.progressPercent,
      distanceRemainingM: progress.distanceRemainingM,
      distanceRemainingKm: remainingKm.toFixed(1),
      etaMinutes: scaledEta,
      arrivalTime: scaledEta != null && scaledEta > 0 ? formatArrivalTime(scaledEta) : null,
      isActive: true,
    };
  }, [isActive, progress, etaMinutes]);
}
