import { useEffect, useState, useRef } from 'react';
import * as Location from 'expo-location';
import { driverService, locationService } from '@tricigo/api';

interface LocationState {
  latitude: number;
  longitude: number;
  heading: number | null;
}

export function useDriverLocationTracking(
  driverId: string | null,
  isOnline: boolean,
  activeRideId: string | null,
) {
  const [location, setLocation] = useState<LocationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    if (!driverId || !isOnline) {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      return;
    }

    let cancelled = false;

    async function startTracking() {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('location_denied');
          return;
        }

        subscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            distanceInterval: 30,
            timeInterval: 10000,
          },
          (loc) => {
            if (cancelled) return;
            const pos: LocationState = {
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              heading: loc.coords.heading ?? null,
            };
            setLocation(pos);

            // Update driver profile location
            driverService
              .updateLocation(driverId!, pos.latitude, pos.longitude, pos.heading ?? undefined)
              .catch(() => { /* best-effort: location broadcast */ });

            // Record ride location if active trip
            if (activeRideId) {
              locationService
                .recordRideLocation({
                  ride_id: activeRideId,
                  driver_id: driverId!,
                  latitude: pos.latitude,
                  longitude: pos.longitude,
                  heading: pos.heading ?? undefined,
                  speed: loc.coords.speed ?? undefined,
                })
                .catch(() => { /* best-effort: GPS trail recording */ });
            }
          },
        );
      } catch {
        if (!cancelled) setError('location_error');
      }
    }

    startTracking();

    return () => {
      cancelled = true;
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
    };
  }, [driverId, isOnline, activeRideId]);

  return { location, error };
}
