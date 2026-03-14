import { useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { fetchRoute, haversineDistance, estimateRoadDistance } from '@tricigo/utils';
import type { GeoPoint } from '@tricigo/utils';

/** Average speed fallback: 20 km/h for Havana urban traffic */
const FALLBACK_SPEED_MS = (20 * 1000) / 3600;

/** Minimum interval between OSRM recalculations (ms) */
const THROTTLE_MS = 30_000;

/** Minimum movement (meters) before triggering recalculation */
const MIN_MOVE_M = 50;

export interface DriverETAResult {
  /** ETA in minutes, null if unknown */
  etaMinutes: number | null;
  /** Whether we're currently recalculating */
  isCalculating: boolean;
}

interface UseDriverETAParams {
  /** Pickup coordinates */
  pickupLocation: { latitude: number; longitude: number } | null;
  /** Dropoff coordinates */
  dropoffLocation: { latitude: number; longitude: number } | null;
  /** Current ride status */
  rideStatus: string | null;
}

/**
 * Hook that calculates ETA for the driver using their own GPS position.
 * Uses OSRM routing with haversine fallback, throttled to 1 request per 30s.
 */
export function useDriverETA({
  pickupLocation,
  dropoffLocation,
  rideStatus,
}: UseDriverETAParams): DriverETAResult {
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const lastCalcRef = useRef(0);
  const lastPosRef = useRef<GeoPoint | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const calculateETA = useCallback(async () => {
    // Determine destination based on status
    let destination: { latitude: number; longitude: number } | null = null;

    if (rideStatus === 'accepted' || rideStatus === 'driver_en_route') {
      destination = pickupLocation;
    } else if (rideStatus === 'in_progress') {
      destination = dropoffLocation;
    } else if (rideStatus === 'arrived_at_pickup') {
      setEtaMinutes(0);
      return;
    } else {
      setEtaMinutes(null);
      return;
    }

    if (!destination) return;

    // Get current position from GPS
    let currentPos: GeoPoint;
    try {
      const loc = await Location.getLastKnownPositionAsync();
      if (!loc) return;
      currentPos = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    } catch {
      return;
    }

    // Throttle
    const now = Date.now();
    if (now - lastCalcRef.current < THROTTLE_MS) return;

    // Skip if haven't moved enough
    if (lastPosRef.current) {
      const moved = haversineDistance(lastPosRef.current, currentPos);
      if (moved < MIN_MOVE_M && lastCalcRef.current > 0) return;
    }

    lastCalcRef.current = now;
    lastPosRef.current = currentPos;
    setIsCalculating(true);

    try {
      const route = await fetchRoute(
        { lat: currentPos.latitude, lng: currentPos.longitude },
        { lat: destination.latitude, lng: destination.longitude },
      );

      if (!mountedRef.current) return;

      if (route) {
        setEtaMinutes(Math.max(1, Math.round(route.duration_s / 60)));
      } else {
        const straight = haversineDistance(currentPos, destination);
        const road = estimateRoadDistance(straight);
        setEtaMinutes(Math.max(1, Math.round((road / FALLBACK_SPEED_MS) / 60)));
      }
    } catch {
      if (!mountedRef.current) return;
      const straight = haversineDistance(currentPos, destination);
      const road = estimateRoadDistance(straight);
      setEtaMinutes(Math.max(1, Math.round((road / FALLBACK_SPEED_MS) / 60)));
    } finally {
      if (mountedRef.current) setIsCalculating(false);
    }
  }, [pickupLocation, dropoffLocation, rideStatus]);

  // Recalculate periodically while trip is active
  useEffect(() => {
    if (!rideStatus || rideStatus === 'completed' || rideStatus === 'canceled') return;

    calculateETA();

    const interval = setInterval(calculateETA, THROTTLE_MS);
    return () => clearInterval(interval);
  }, [calculateETA, rideStatus]);

  return { etaMinutes, isCalculating };
}
