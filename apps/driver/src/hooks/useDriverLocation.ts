import { useEffect, useState, useRef } from 'react';
import { Alert } from 'react-native';
import * as Location from 'expo-location';
import { driverService, locationService, getOnlineStatus } from '@tricigo/api';
import { smoothHeading } from '@tricigo/utils';
import {
  initLocationBuffer,
  bufferLocation,
  flushBuffer,
} from '@/services/locationBuffer';
import type { BufferedLocation } from '@/services/locationBuffer';
import {
  startBgLocationTracking,
  stopBgLocationTracking,
} from '@/services/locationBackgroundTask';
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
// bearing recomputation: ignore micro-movements so GPS noise on a stationary
// driver doesn't produce random bearings. BUG-267 v3 dropped the threshold
// from 5m to 2m (1m for mocks) — see heading logic below.
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

// BUG-298: `smoothHeading` + `HEADING_SMOOTHING_ALPHA` moved to
// `packages/utils/src/geo.ts` so RideMapView (driver + client) can reuse
// the same EMA when smoothing bearings from `snapDriverToRoute` between
// polyline segments. Imported above from `@tricigo/utils`.

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
  // BUG-267 v3: last smoothed heading we uploaded. Used (a) to feed the EMA
  // filter on the next sample, and (b) to preserve bearing while a mock
  // provider is paused on the same coord (Lockito Journey emits the same
  // lat/lng with heading=0 between segments → without this we'd snap back
  // to north each pause).
  const smoothedHeadingRef = useRef<number | null>(null);
  // BUG-Store-Readiness-Driver (W8): track whether we've already shown the
  // background-location prominent disclosure this session so we don't spam
  // it on every effect re-run. Google's policy is that the disclosure must
  // appear at least once before the system prompt; re-asking on the same
  // session would be annoying without adding compliance value.
  const bgDisclosureShownRef = useRef(false);

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

        // Request background location when driver has active ride.
        //
        // BUG-Store-Readiness-Driver (W8): Google Play User Data Policy
        // requires a "prominent disclosure" — an in-app explanation
        // shown BEFORE the OS permission prompt — for apps requesting
        // ACCESS_BACKGROUND_LOCATION. The disclosure must:
        //   1. Appear before the system prompt (not after, not behind a
        //      settings menu).
        //   2. Use the words "ubicación" (location) and "background" /
        //      "siempre" (always).
        //   3. Name the specific feature that needs background access.
        //   4. Have an explicit "Allow" CTA that triggers the prompt.
        //
        // If we skip this and just call requestBackgroundPermissionsAsync
        // directly, Play Console rejects the AAB during the Background
        // Location declaration review.
        //
        // Implementation: first check if we already have the permission
        // (no disclosure needed if already granted). If not, show an
        // Alert.alert as the disclosure (Alert is OK — Google's policy
        // is about content + ordering, not chrome). User taps "Permitir"
        // → we trigger the system prompt; "Más tarde" → we skip this
        // ride's background tracking and fall back to foreground-only
        // updates (rider may see the marker freeze when driver minimizes
        // the app, but the trip can still complete).
        if (activeRideId) {
          const current = await Location.getBackgroundPermissionsAsync().catch(
            () => ({ status: 'undetermined' as const }),
          );
          if (current.status === 'granted') {
            console.log('[Location] Background permission already granted');
          } else if (!bgDisclosureShownRef.current) {
            bgDisclosureShownRef.current = true;
            const accepted = await new Promise<boolean>((resolve) => {
              Alert.alert(
                'Compartir ubicación durante el viaje',
                'TriciGo Conductor necesita acceso a tu ubicación en segundo plano (opción "Siempre" / "Always") mientras tenés un viaje activo, para que el pasajero pueda verte llegar en tiempo real aunque la app esté minimizada o la pantalla apagada. Sin este permiso, el pasajero pierde tu posición cuando salís de la app.',
                [
                  {
                    text: 'Más tarde',
                    style: 'cancel',
                    onPress: () => resolve(false),
                  },
                  {
                    text: 'Permitir',
                    onPress: () => resolve(true),
                  },
                ],
                { cancelable: false },
              );
            });
            if (accepted) {
              const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync().catch(
                () => ({ status: 'denied' as const }),
              );
              if (bgStatus === 'granted') {
                console.log('[Location] Background permission granted after disclosure');
              } else {
                console.log('[Location] Background permission denied at system prompt');
              }
            } else {
              console.log('[Location] Driver dismissed background disclosure');
            }
          }

          // FD1: if background permission is granted (either just-granted
          // above, or pre-existing from a prior ride), start the real
          // background TaskManager task. It runs inside an Android
          // foreground service / iOS UIBackgroundModes=location and keeps
          // receiving location callbacks even when the driver minimizes
          // the app, switches to another app, or turns the screen off.
          //
          // Without this, the foreground-only watchPositionAsync below
          // freezes the moment the app loses focus on Android — which
          // breaks the promise that the passenger sees the driver's
          // marker moving in real time during the active ride.
          //
          // Idempotent: startBgLocationTracking checks if the task is
          // already running and only updates the persisted ctx.
          const finalBgStatus = await Location.getBackgroundPermissionsAsync().catch(
            () => ({ status: 'undetermined' as const }),
          );
          if (finalBgStatus.status === 'granted' && driverId) {
            try {
              await startBgLocationTracking({
                driverId,
                rideId: activeRideId,
              });
              console.log('[Location] Started background task for ride', activeRideId);
            } catch (bgStartErr) {
              console.warn('[Location] Failed to start background task:', bgStartErr);
              // Fall through — foreground watchPositionAsync below still runs.
            }
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

            // BUG-267 v3: heading source hierarchy with EMA smoothing +
            // mock-provider awareness.
            //
            // History:
            //  - v1 used coords.heading directly → 0° during pickup waits.
            //  - v2 added bearing-from-deltas fallback with 5m threshold →
            //    fixed real-GPS driving but broke for Lockito Journey paused
            //    on a coord (moveDist=0 → fallback skipped → 0° again).
            //  - v3 (this version): drop threshold to 2m (1m if mocked),
            //    detect loc.mocked on Android, preserve the previously
            //    smoothed heading when mocked-and-stationary, and EMA-smooth
            //    the final value to dampen short-distance bearing noise.
            const rawHeading = loc.coords.heading;
            // expo-location surfaces loc.mocked on Android when GPS came from
            // a mock provider (Lockito, joystick apps). iOS has no equivalent
            // and the property is undefined — defaults to "not mocked".
            const isMocked =
              (loc as unknown as { mocked?: boolean }).mocked === true;
            const previousHeading =
              smoothedHeadingRef.current ?? useLocationStore.getState().heading;
            const isValidRaw =
              typeof rawHeading === 'number' &&
              Number.isFinite(rawHeading) &&
              rawHeading > 0 && // exclude 0 (Lockito) and negatives (Android)
              rawHeading <= 360;

            const last = lastCoordRef.current;
            const moveDist = last
              ? distanceMeters(
                  last.lat,
                  last.lng,
                  loc.coords.latitude,
                  loc.coords.longitude,
                )
              : 0;
            const moveThreshold = isMocked ? 1 : 2; // metres

            let nextHeading: number | null;
            if (isValidRaw) {
              nextHeading = rawHeading;
            } else if (last && moveDist >= moveThreshold) {
              nextHeading = bearingBetween(
                last.lat,
                last.lng,
                loc.coords.latitude,
                loc.coords.longitude,
              );
            } else {
              // Preserve the previously smoothed bearing. Critical for
              // mock providers like Lockito Journey that pause on the
              // same coord (moveDist=0) — without this we'd snap to 0/north
              // every pause and the marker would visibly "jump" upright.
              nextHeading = previousHeading;
            }

            const heading =
              nextHeading != null
                ? smoothHeading(nextHeading, smoothedHeadingRef.current)
                : null;
            if (heading != null) {
              smoothedHeadingRef.current = heading;
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
                    heading:
                      pos.heading != null ? Math.round(pos.heading) : null,
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
      // FD1: stop the background TaskManager task when the effect
      // re-runs with a different activeRideId / driverId / isOnline, or
      // when the hook unmounts. This is what frees the Android foreground
      // service notification and stops draining battery once the ride
      // is over (or the driver goes offline).
      //
      // Safe to call even when the task isn't running — stopBgLocationTracking
      // checks `isTaskRegisteredAsync` internally before issuing a stop.
      stopBgLocationTracking().catch((e) => {
        console.warn('[Location] stopBgLocationTracking failed:', e);
      });
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
