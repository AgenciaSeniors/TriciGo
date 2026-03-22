import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { fetchRoute, haversineDistance, estimateRoadDistance } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/** Average speed fallback: 20 km/h for Havana urban traffic */
const FALLBACK_SPEED_MS = (20 * 1000) / 3600;

/** Minimum interval between OSRM recalculations (ms) */
const THROTTLE_MS = 30_000;

/** Minimum driver movement (meters) before triggering recalculation */
const MIN_MOVE_M = 50;

export interface ETAResult {
  /** ETA in minutes, null if unknown */
  etaMinutes: number | null;
  /** Whether we're currently recalculating */
  isCalculating: boolean;
}

interface UseETAParams {
  /** Current driver position from real-time tracking */
  driverLocation: GeoPoint | null;
  /** Pickup coordinates */
  pickupLocation: { latitude: number; longitude: number } | null;
  /** Dropoff coordinates */
  dropoffLocation: { latitude: number; longitude: number } | null;
  /** Current ride status */
  rideStatus: string | null;
  /** Static estimate from ride (fallback) */
  estimatedDurationS?: number | null;
}

/**
 * Hook that calculates real-time ETA using OSRM routing.
 * Throttled to max 1 request per 30s and only when driver moves > 50m.
 * Falls back to haversine-based estimate if OSRM fails.
 */
export function useETA({
  driverLocation,
  pickupLocation,
  dropoffLocation,
  rideStatus,
  estimatedDurationS,
}: UseETAParams): ETAResult {
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const lastCalcRef = useRef(0);
  const lastDriverPosRef = useRef<GeoPoint | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const calculateETA = useCallback(async () => {
    if (!driverLocation) return;

    // Determine destination based on status
    let destination: { latitude: number; longitude: number } | null = null;

    if (rideStatus === 'accepted' || rideStatus === 'driver_en_route') {
      destination = pickupLocation;
    } else if (rideStatus === 'in_progress') {
      destination = dropoffLocation;
    } else if (rideStatus === 'arrived_at_pickup') {
      // Driver already at pickup — ETA is 0
      setEtaMinutes(0);
      return;
    } else {
      // Completed/canceled/etc — no ETA needed
      setEtaMinutes(null);
      return;
    }

    if (!destination) return;

    // Throttle: skip if last calc was < THROTTLE_MS ago
    const now = Date.now();
    if (now - lastCalcRef.current < THROTTLE_MS) return;

    // Skip if driver hasn't moved enough
    if (lastDriverPosRef.current) {
      const moved = haversineDistance(lastDriverPosRef.current, driverLocation);
      if (moved < MIN_MOVE_M && lastCalcRef.current > 0) return;
    }

    lastCalcRef.current = now;
    lastDriverPosRef.current = driverLocation;
    setIsCalculating(true);

    try {
      const route = await fetchRoute(
        { lat: driverLocation.latitude, lng: driverLocation.longitude },
        { lat: destination.latitude, lng: destination.longitude },
      );

      if (!mountedRef.current) return;

      if (route) {
        setEtaMinutes(Math.max(1, Math.round(route.duration_s / 60)));
      } else {
        // Fallback: haversine + road factor + average speed
        const straight = haversineDistance(driverLocation, destination);
        const road = estimateRoadDistance(straight);
        const seconds = road / FALLBACK_SPEED_MS;
        setEtaMinutes(Math.max(1, Math.round(seconds / 60)));
      }
    } catch {
      if (!mountedRef.current) return;
      // Fallback on error
      const straight = haversineDistance(driverLocation, destination);
      const road = estimateRoadDistance(straight);
      const seconds = road / FALLBACK_SPEED_MS;
      setEtaMinutes(Math.max(1, Math.round(seconds / 60)));
    } finally {
      if (mountedRef.current) setIsCalculating(false);
    }
  }, [driverLocation, pickupLocation, dropoffLocation, rideStatus]);

  // Calculate on mount and when dependencies change
  useEffect(() => {
    // Set initial estimate from ride data if available
    if (etaMinutes === null && estimatedDurationS) {
      setEtaMinutes(Math.max(1, Math.round(estimatedDurationS / 60)));
    }

    calculateETA();
  }, [calculateETA, estimatedDurationS]);

  return useMemo(() => ({ etaMinutes, isCalculating }), [etaMinutes, isCalculating]);
}
