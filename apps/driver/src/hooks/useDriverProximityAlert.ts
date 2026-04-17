import { useEffect, useRef } from 'react';
import { triggerHaptic, haversineDistance } from '@tricigo/utils';
import { useLocationStore } from '@/stores/location.store';
import type { GeoPoint } from '@tricigo/utils';

const PROXIMITY_DISTANCE_M = 500; // 500m — driver is very close

/**
 * Driver-side proximity alert.
 * Fires a haptic pulse when the driver is within ~500m of the pickup point.
 * The server-side push notification covers the actual notification delivery;
 * this hook provides immediate tactile feedback when the app is open.
 */
export function useDriverProximityAlert(
  pickupLocation: GeoPoint | null,
  rideStatus: string | null,
) {
  const notifiedRef = useRef(false);
  const rideStatusRef = useRef(rideStatus);
  rideStatusRef.current = rideStatus;

  const lat = useLocationStore((s) => s.latitude);
  const lng = useLocationStore((s) => s.longitude);

  // Reset when ride changes (pickup location changes)
  useEffect(() => {
    notifiedRef.current = false;
  }, [pickupLocation?.latitude, pickupLocation?.longitude]);

  useEffect(() => {
    if (!pickupLocation || lat === null || lng === null) return;
    if (rideStatusRef.current !== 'accepted' && rideStatusRef.current !== 'driver_en_route') return;
    if (notifiedRef.current) return;

    const distance = haversineDistance(
      { latitude: lat, longitude: lng },
      pickupLocation,
    );

    if (distance < PROXIMITY_DISTANCE_M) {
      notifiedRef.current = true;
      triggerHaptic('medium');
    }
  }, [lat, lng, pickupLocation]);
}
