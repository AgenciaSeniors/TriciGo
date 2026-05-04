/**
 * useNearDropoffPulse — extracted from DriverTripView for PR-A.
 *
 * DE-2.2: detects when the driver is within 80m of the dropoff during
 * in_progress (and there is no pending waypoint). When proximity is
 * first detected:
 *   - sets `nearDropoff = true`
 *   - fires a single light haptic
 *   - emits `driver_near_dropoff` validation event (once per ride)
 *
 * Also exposes a 1.0–1.05 pulse `Animated.Value` that loops while
 * nearDropoff is true; the parent uses it to scale the "Finalizar
 * viaje" CTA so the driver sees a subtle prompt the moment they're
 * near.
 *
 * Behavior preserved verbatim from inline version.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { trackValidationEvent } from '@tricigo/api';
import { triggerHaptic, haversineDistance } from '@tricigo/utils';

interface UseNearDropoffPulseArgs {
  rideId: string | null | undefined;
  status: string | null | undefined;
  dropoffLocation: { latitude: number; longitude: number } | null | undefined;
  driverLocation: { latitude: number; longitude: number } | null;
  /** When a waypoint is still pending, dropoff proximity is irrelevant. */
  hasPendingWaypoint: boolean;
}

interface UseNearDropoffPulseResult {
  nearDropoff: boolean;
  pulseAnim: Animated.Value;
}

export function useNearDropoffPulse({
  rideId,
  status,
  dropoffLocation,
  driverLocation,
  hasPendingWaypoint,
}: UseNearDropoffPulseArgs): UseNearDropoffPulseResult {
  const [nearDropoff, setNearDropoff] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const trackedRef = useRef(false);
  const prevRef = useRef(false);

  // Proximity detection
  useEffect(() => {
    if (status !== 'in_progress' || !driverLocation || hasPendingWaypoint) {
      setNearDropoff(false);
      return;
    }

    // HF-3: Guard against null dropoff coordinates
    if (!dropoffLocation?.latitude || !dropoffLocation?.longitude) {
      setNearDropoff(false);
      return;
    }

    const dist = haversineDistance(driverLocation, dropoffLocation);

    if (dist < 80) {
      setNearDropoff(true);
      if (!prevRef.current) {
        prevRef.current = true;
        triggerHaptic('light');
      }
      if (!trackedRef.current && rideId) {
        trackedRef.current = true;
        trackValidationEvent('driver_near_dropoff', {
          distance_m: Math.round(dist),
        }, rideId);
      }
    } else {
      setNearDropoff(false);
      prevRef.current = false;
      trackedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverLocation?.latitude, driverLocation?.longitude, status, hasPendingWaypoint]);

  // Pulse animation while near dropoff
  useEffect(() => {
    if (nearDropoff) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulseAnim.setValue(1);
    }
  }, [nearDropoff, pulseAnim]);

  return { nearDropoff, pulseAnim };
}
