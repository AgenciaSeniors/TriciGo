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

// Bearing between two lat/lng pairs in degrees (0=N, 90=E, 180=S, 270=W).
// Spherical-law-of-cosines fallback for when expo-location's coords.heading
// is unreliable (Lockito Journey emits 0, Android sometimes -1, indoor GPS
// has no compass lock). Computed from two consecutive coords whenever the
// hardware reading isn't trustworthy.
function bearingBetween(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lng2 - lng1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}

// Haversine distance in meters between two lat/lng pairs. Used to gate the
// bearing recomputation: ignore movements <5m so GPS noise on a stationary
// driver doesn't produce random bearings.
function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
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
  const lastHeartbeatRef = useRef<number | null>(null);
  // BUG-273: throttle GPS uploads to 1/sec regardless of how fast the OS
  // fires the watchPositionAsync callback (it can fire 5+x/sec at high
  // distanceInterval+timeInterval combinations).
  const lastUploadRef = useRef<number | null>(null);
  // Last coord we processed in the watcher, used to compute a bearing fallback
  // when coords.heading from expo-location is 0/null/-1 (Lockito Journey,
  // Android stationary, etc). Without this, the driver marker never rotates
  // and the camera stays north-up despite followMode being on.
  const lastCoordRef = useRef<{ lat: number; lng: number } | null>(null);

  // Keep refs in sync for use inside NetInfo listener
  useEffect(() => { driverIdRef.current = driverId; }, [driverId]);
  useEffect(() => { activeRideIdRef.current = activeRideId; }, [activeRideId]);

  // Initialize location buffer once
  useEffect(() => {
    initLocationBuffer().catch(() => {});
  }, []);

  // Flush buffer when connectivity is restored OR every 5 seconds.
  // BUG-273 v2: NetInfo only fires when connectivity STATE changes
  // (e.g. wifi off → on). On Cuban / Brazilian networks where the
  // connection stays "online" but individual POSTs fail, NetInfo never
  // triggers, so the buffer would grow forever and the rider's marker
  // would freeze. The 5-second periodic flush retries the buffer
  // unconditionally — if the network is healthy now, samples drain.
  useEffect(() => {
    const flushFn = (batch: BufferedLocation[]) => {
      const rideLocations = batch.filter((b) => b.rideId != null);
      if (rideLocations.length === 0) return Promise.resolve();
      return locationService.bulkRecordRideLocations(
        rideLocations.map((b) => ({
          ride_id: b.rideId!,
          driver_id: b.driverId,
          latitude: b.latitude,
          longitude: b.longitude,
          heading: b.heading ?? undefined,
          speed: b.speed ?? undefined,
          accuracy: b.accuracy,
          recorded_at: new Date(b.timestamp).toISOString(),
        })),
      );
    };

    const tryFlush = () => {
      if (!driverIdRef.current) return;
      flushBuffer(flushFn).catch(() => { /* best effort */ });
    };

    const netUnsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) tryFlush();
    });

    // Periodic retry every 5s — catches blips that NetInfo doesn't see.
    const interval = setInterval(tryFlush, 5_000);

    return () => {
      netUnsubscribe();
      clearInterval(interval);
    };
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
          Alert.alert(
            'Ubicación requerida',
            'Debes permitir el acceso a tu ubicación para recibir viajes. Activa la ubicación en la configuración de tu dispositivo.',
            [{ text: 'Entendido' }],
          );
          return;
        }

        // Request background location when driver has active ride
        if (activeRideId) {
          const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' as const }));
          if (bgStatus === 'granted') {
            console.log('[Location] Background permission granted for active ride');
          }
        }

        // BUG-256: live-tracking extreme. Push GPS sampling to 1s/3m for
        // active rides so the rider sees the marker move continuously.
        // Combined with client-side dead-reckoning (useAnimatedPosition v2),
        // this delivers a true real-time experience. Idle stays conservative
        // to preserve battery.
        const isActiveTrip = !!activeRideId;

        // Post an INITIAL location fix immediately so the server has a
        // fresh current_location even if the driver doesn't move.
        // watchPositionAsync only invokes its callback when the user
        // moves >distanceInterval, so without this seed the rider's
        // find_best_drivers RPC may filter out a stationary driver
        // whose current_location was stale (last update from a previous
        // session). Affects:
        //   - Real drivers waiting at a corner without moving
        //   - QA with Lockito fixed-point (no movement)
        //   - Drivers who reconnect after being offline in another city
        try {
          // Relaxed filters: matches _layout.tsx's bootstrap reader so we
          // accept the same OS-cached fix it does. Tight filters (1 min /
          // 200 m) reject Lockito's mock provider and stationary drivers
          // whose only fix is from before they parked.
          const initial =
            (await Location.getLastKnownPositionAsync({
              maxAge: 60 * 60 * 1000, // 1 hour
              requiredAccuracy: 1000, // 1 km
            }).catch(() => null)) ??
            (await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Lowest,
            }).catch(() => null));
          if (initial && !cancelled && getOnlineStatus()) {
            const initPos: LocationState = {
              latitude: initial.coords.latitude,
              longitude: initial.coords.longitude,
              heading: initial.coords.heading ?? 0,
            };
            setLocation(initPos);
            useLocationStore.getState().setLocation(
              initPos.latitude,
              initPos.longitude,
              initPos.heading,
            );
            await driverService.updateDriverPosition({
              driverId: driverId!,
              latitude: initPos.latitude,
              longitude: initPos.longitude,
              heading: initPos.heading ?? undefined,
              rideId: activeRideId ?? undefined,
            });
            lastUploadRef.current = Date.now();
            console.log('[GPS upload] initial fix posted', {
              lat: initPos.latitude.toFixed(5),
              lng: initPos.longitude.toFixed(5),
            });
          }
        } catch (err) {
          console.warn(
            '[GPS upload] initial fix failed (will rely on watchPositionAsync)',
            String((err as { message?: string })?.message ?? err),
          );
        }

        subscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            // 3m / 1s during active trip — perceptually instant.
            distanceInterval: isActiveTrip ? 3 : 30,
            timeInterval: isActiveTrip ? 1000 : 10000,
          },
          (loc) => {
            if (cancelled) return;
            // Ignore stale locations older than 90s (30s was too aggressive for slow traffic)
            const locationAge = Date.now() - loc.timestamp;
            if (locationAge > 90000) return;

            // BUG-267 v2: expo-location's coords.heading is unreliable on
            // stationary devices (Android -1, iOS null) AND on Lockito mock
            // providers (Journey/joystick emit 0 regardless of direction).
            // We keep the previous logic of preserving last known when the
            // hardware reading is invalid, but ADD a bearing-from-deltas
            // fallback: if we moved >5m since the last sample, compute the
            // bearing between the two coords ourselves. That gives us
            // accurate heading-up rotation even without compass-grade GPS.
            const rawHeading = loc.coords.heading;
            const previousHeading = useLocationStore.getState().heading;
            const isValidRaw =
              typeof rawHeading === 'number' &&
              Number.isFinite(rawHeading) &&
              rawHeading > 0 && // exclude 0 (Lockito) and negatives (Android)
              rawHeading <= 360;

            let heading: number | null;
            if (isValidRaw) {
              heading = rawHeading;
            } else {
              const last = lastCoordRef.current;
              if (
                last &&
                distanceMeters(
                  last.lat,
                  last.lng,
                  loc.coords.latitude,
                  loc.coords.longitude,
                ) > 5
              ) {
                heading = bearingBetween(
                  last.lat,
                  last.lng,
                  loc.coords.latitude,
                  loc.coords.longitude,
                );
              } else {
                heading = previousHeading;
              }
            }
            lastCoordRef.current = {
              lat: loc.coords.latitude,
              lng: loc.coords.longitude,
            };

            const pos: LocationState = {
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
              heading,
            };
            setLocation(pos);

            // Share location globally for in-app navigation
            useLocationStore.getState().setLocation(pos.latitude, pos.longitude, pos.heading);

            const online = getOnlineStatus();

            if (online) {
              // BUG-273 — Throttle GPS uploads to AT MOST 1 per second.
              //
              // Root cause confirmed in Foz network test: every GPS callback
              // (which fires every ~0.2 s at highway speed because of
              // distanceInterval:3m) was firing 2 POSTs in parallel — 10
              // POSTs/sec. React Native's fetch concurrency saturates and
              // most calls die with "Network request failed". Throttling
              // to 1/sec drops the load 10x and matches the rider's poll
              // cadence (no need to send more often than the rider can read).
              const nowMs = Date.now();
              const sinceLastUpload = nowMs - (lastUploadRef.current ?? 0);
              if (sinceLastUpload < 1000) {
                return; // skip this callback — we already uploaded recently
              }
              lastUploadRef.current = nowMs;

              // BUG-275: ONE atomic RPC instead of TWO separate POSTs.
              // Halves the per-second request rate seen by Cloudflare/
              // Supabase, eliminates the "every other sample fails" pattern.
              driverService
                .updateDriverPosition({
                  driverId: driverId!,
                  latitude: pos.latitude,
                  longitude: pos.longitude,
                  heading: pos.heading ?? undefined,
                  speed: loc.coords.speed ?? undefined,
                  rideId: activeRideId ?? undefined,
                })
                .then(() => {
                  console.log('[GPS upload] updateDriverPosition OK', {
                    lat: pos.latitude.toFixed(5),
                    lng: pos.longitude.toFixed(5),
                    has_ride: !!activeRideId,
                  });
                })
                .catch((err) => {
                  console.warn('[GPS upload] updateDriverPosition FAILED', String((err as { message?: string })?.message ?? err));
                  if (activeRideId) {
                    // Buffer the sample for later flush via 5-second
                    // periodic retry (BUG-273 v2). The bulk endpoint will
                    // re-insert into ride_location_events when network recovers.
                    bufferLocation({
                      latitude: pos.latitude,
                      longitude: pos.longitude,
                      heading: pos.heading,
                      speed: loc.coords.speed ?? null,
                      accuracy: loc.coords.accuracy ?? null,
                      timestamp: Date.now(),
                      rideId: activeRideId,
                      driverId: driverId!,
                    });
                  }
                });

              // F604: Send heartbeat every 60s (throttled by lastHeartbeat ref)
              if (!lastHeartbeatRef.current || nowMs - lastHeartbeatRef.current > 60_000) {
                lastHeartbeatRef.current = nowMs;
                driverService.sendHeartbeat(driverId!).catch((err) => {
                  console.warn('[GPS upload] sendHeartbeat failed', String((err as { message?: string })?.message ?? err));
                });
              }
            } else {
              // Offline — buffer the location for later flush
              bufferLocation({
                latitude: pos.latitude,
                longitude: pos.longitude,
                heading: pos.heading,
                speed: loc.coords.speed ?? null,
                accuracy: loc.coords.accuracy ?? null,
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

  // BUG-224: heartbeat on its own timer (not tied to GPS callbacks).
  // The cron `auto-offline-stale-drivers` marks drivers offline after 10
  // min of silence. Previously the heartbeat lived inside the GPS
  // subscription callback — when Android throttled GPS (app backgrounded,
  // phone still, battery saver) the heartbeat lapsed and the driver got
  // auto-offlined even though the user hadn't toggled anything.
  useEffect(() => {
    if (!driverId || !isOnline) return;
    // Send one immediately when going online so the cron clock resets.
    driverService.sendHeartbeat(driverId).catch(() => {});
    const interval = setInterval(() => {
      driverService.sendHeartbeat(driverId).catch(() => {});
    }, 60_000); // every minute — well under the 10 min stale threshold
    return () => clearInterval(interval);
  }, [driverId, isOnline]);

  return { location, error };
}
