import { useEffect, useState, useRef } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { driverService, locationService, getOnlineStatus } from '@tricigo/api';
import {
  initLocationBuffer,
  bufferLocation,
  flushBuffer,
} from '@/services/locationBuffer';
import type { BufferedLocation } from '@/services/locationBuffer';
import NetInfo from '@react-native-community/netinfo';
import { useLocationStore } from '@/stores/location.store';

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
  const driverIdRef = useRef(driverId);
  const activeRideIdRef = useRef(activeRideId);

  // Keep refs in sync for use inside NetInfo listener
  useEffect(() => { driverIdRef.current = driverId; }, [driverId]);
  useEffect(() => { activeRideIdRef.current = activeRideId; }, [activeRideId]);

  // Initialize location buffer once
  useEffect(() => {
    initLocationBuffer().catch(() => {});
  }, []);

  // Flush buffer when connectivity is restored
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected && driverIdRef.current) {
        flushBuffer(async (batch: BufferedLocation[]) => {
          // Only flush ride locations via bulk insert
          const rideLocations = batch.filter((b) => b.rideId != null);
          if (rideLocations.length > 0) {
            await locationService.bulkRecordRideLocations(
              rideLocations.map((b) => ({
                ride_id: b.rideId!,
                driver_id: b.driverId,
                latitude: b.latitude,
                longitude: b.longitude,
                heading: b.heading ?? undefined,
                speed: b.speed ?? undefined,
                recorded_at: new Date(b.timestamp).toISOString(),
              })),
            );
          }
        }).catch(() => { /* best effort */ });
      }
    });
    return unsubscribe;
  }, []);

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
          // Alert driver that GPS is required for rides
          Alert.alert(
            'Ubicación requerida',
            'Debes permitir el acceso a tu ubicación para recibir viajes. Activa la ubicación en la configuración de tu dispositivo.',
            [{ text: 'Entendido' }],
          );
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

            // Share location globally for in-app navigation
            useLocationStore.getState().setLocation(pos.latitude, pos.longitude, pos.heading);

            const online = getOnlineStatus();

            if (online) {
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
            } else {
              // Offline — buffer the location for later flush
              bufferLocation({
                latitude: pos.latitude,
                longitude: pos.longitude,
                heading: pos.heading,
                speed: loc.coords.speed ?? null,
                timestamp: Date.now(),
                rideId: activeRideId,
                driverId: driverId!,
              });
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
