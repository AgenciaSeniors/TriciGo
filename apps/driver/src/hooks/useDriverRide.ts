import { useEffect, useRef, useCallback } from 'react';
import { AppState } from 'react-native';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import { rideService, driverService, locationService, notificationService, presenceService } from '@tricigo/api';
import { triggerHaptic, playSound, logger } from '@tricigo/utils';
import { useDriverStore } from '@/stores/driver.store';
import { useDriverRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';
import { useLocationStore } from '@/stores/location.store';
import type { RideStatus, DriverAcceptedBroadcast, Vehicle } from '@tricigo/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

/** Cached vehicle info for broadcast — loaded once per session */
let cachedVehicle: Vehicle | null = null;

/** Next status in the ride FSM for driver actions. */
const NEXT_STATUS: Partial<Record<RideStatus, RideStatus>> = {
  accepted: 'driver_en_route',
  driver_en_route: 'arrived_at_pickup',
  arrived_at_pickup: 'in_progress',
  in_progress: 'arrived_at_destination',
  arrived_at_destination: 'completed',
};

/**
 * Initialize driver ride state on mount.
 * Checks for an active trip and restores state.
 */
export function useDriverRideInit() {
  const profile = useDriverStore((s) => s.profile);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  // BUG-219: select setActiveTrip via selector — without it, the destructure
  // re-subscribes to the entire store, so every state change rebuilds
  // setActiveTrip's reference, retriggers the useEffect below, calls
  // checkActive() again, and updates the store, looping infinitely. The
  // visible symptom was activeTrip flickering between truthy/null which
  // unmounted/remounted RideMapView (idle/active variants) repeatedly.
  const setActiveTrip = useDriverRideStore((s) => s.setActiveTrip);
  const channelRef = useRef<{ unsubscribe: () => void } | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isInitialized || !profile) return;

    let mounted = true;

    async function checkActive() {
      try {
        // Pre-cache vehicle info for broadcast on accept
        if (!cachedVehicle) {
          driverService.getVehicle(profile!.id).then((v) => {
            cachedVehicle = v;
          }).catch(() => { /* non-critical */ });
        }

        const trip = await driverService.getActiveTrip(profile!.id);
        if (!mounted) return;

        if (!trip) {
          const localTrip = useDriverRideStore.getState().activeTrip;
          // Don't clear a completed trip — let TripCompleteView show the earnings summary
          if (localTrip && localTrip.status !== 'completed') {
            logger.info('[Reconcile] Clearing stale local trip', { ride_id: localTrip.id });
            useDriverRideStore.getState().setActiveTrip(null);
          }
          logger.info('[Reconcile] Result', { had_local_trip: !!localTrip, server_trip: false, action: localTrip?.status === 'completed' ? 'kept_completed' : 'cleared' });
          return;
        }

        // If trip canceled, clear it. If completed, KEEP it so TripCompleteView can render.
        if (trip.status === 'canceled') {
          useDriverRideStore.getState().reset();
          return;
        }
        if (trip.status === 'completed') {
          // Don't reset — let TripCompleteView show the earnings summary
          useDriverRideStore.getState().setActiveTrip(trip);
          return;
        }

        setActiveTrip(trip);

        logger.info('[Reconcile] Result', {
          had_local_trip: !!useDriverRideStore.getState().activeTrip,
          server_trip: true,
          action: 'synced',
        });

        // Subscribe to trip updates (with dedup)
        if (activeChannelIdRef.current === trip.id) {
          logger.info('[Subscription] Dedup prevented', { ride_id: trip.id });
        } else {
          if (channelRef.current) {
            const old = channelRef.current;
            channelRef.current = null;
            old.unsubscribe();
          }
          activeChannelIdRef.current = trip.id;
          channelRef.current = rideService.subscribeToRide(trip.id, (ride) => {
            useDriverRideStore.getState().updateActiveTrip(ride);
          });
        }
      } catch (err: unknown) {
        // BUG-234: Supabase errors aren't Error instances — they're plain
        // objects with `.message`/`.code`/`.details`. Previously we got
        // "[object Object]" in logs which hid the real cause.
        let errorMsg: string;
        if (err instanceof Error) {
          errorMsg = err.message;
        } else if (err && typeof err === 'object') {
          const e = err as Record<string, unknown>;
          errorMsg = String(e.message ?? e.code ?? e.details ?? JSON.stringify(err));
        } else {
          errorMsg = String(err);
        }
        console.warn('[Reconcile] caught error:', errorMsg, err);

        const isNetworkError = errorMsg.includes('network') ||
          errorMsg.includes('timeout') ||
          errorMsg.includes('fetch') ||
          errorMsg.includes('Failed to fetch') ||
          (err instanceof Error && err.name === 'AbortError');

        const isAuthError = errorMsg.includes('JWT') ||
          errorMsg.includes('token') ||
          errorMsg.includes('401') ||
          errorMsg.includes('auth');

        if (isNetworkError) {
          logger.warn('[Reconcile] Network error, keeping local state', { error: errorMsg });
          // Retry in 30 seconds
          setTimeout(() => { if (mounted) checkActive(); }, 30_000);
        } else if (isAuthError) {
          logger.error('[Reconcile] Auth error', { error: errorMsg });
        } else {
          logger.error('[Reconcile] Server error', { error: errorMsg });
          // Only clear if we don't have a local trip
          const localTrip = useDriverRideStore.getState().activeTrip;
          if (localTrip) {
            logger.warn('[Reconcile] Keeping local trip despite server error');
          }
        }

        logger.info('[Reconcile] Result', {
          had_local_trip: !!useDriverRideStore.getState().activeTrip,
          server_trip: false,
          action: isNetworkError ? 'retry' : 'kept_local',
        });
      }
    }

    checkActive();

    // Bug 36: Re-check active trip when app returns from background
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mounted) checkActive();
    });

    // BUG-287 fix C — periodic reconcile while a trip is active so the
    // driver can react to server-side changes that don't go through
    // realtime (which is disabled per BUG-277). The most important
    // change to surface: gps_override_confirmed_at flipping from null
    // to a timestamp means the rider just tapped "Sí, lo veo" — we
    // toast the driver so they know to retry "Llegué". Without this
    // poll the driver would sit on the stale status and the rider's
    // confirmation was effectively invisible to them.
    let lastOverrideConfirmed: string | null = null;
    const pollInterval = setInterval(async () => {
      if (!mounted) return;
      const localTrip = useDriverRideStore.getState().activeTrip;
      if (!localTrip || !profile) return;
      // Only poll for trips that could be waiting on rider confirmation
      // (status pre-pickup or pre-dropoff). Skip when nothing to gate.
      const gateableStatus =
        localTrip.status === 'driver_en_route'
        || localTrip.status === 'in_progress';
      if (!gateableStatus) return;
      try {
        const fresh = await driverService.getActiveTrip(profile.id);
        if (!fresh || !mounted) return;
        const freshConfirmedAt =
          (fresh as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at ?? null;
        const localConfirmedAt =
          (localTrip as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at ?? null;
        // Update local store so the UI reflects the override fields
        if (freshConfirmedAt !== localConfirmedAt
          || (fresh as { gps_override_requested_at?: string | null }).gps_override_requested_at
              !== (localTrip as { gps_override_requested_at?: string | null }).gps_override_requested_at) {
          useDriverRideStore.getState().updateActiveTrip(fresh);
        }
        // Notify the driver exactly once when the rider confirms
        if (freshConfirmedAt && freshConfirmedAt !== lastOverrideConfirmed) {
          lastOverrideConfirmed = freshConfirmedAt;
          if (localConfirmedAt !== freshConfirmedAt) {
            triggerHaptic('success');
            const target = localTrip.status === 'driver_en_route' ? 'pickup' : 'destination';
            Toast.show({
              type: 'success',
              text1: i18next.t('driver:trip.rider_confirmed_arrival_title', {
                defaultValue: 'Pasajero confirmó',
              }),
              text2: i18next.t('driver:trip.rider_confirmed_arrival_sub', {
                defaultValue: target === 'pickup'
                  ? 'Tocá "Llegué" de nuevo para avanzar'
                  : 'Tocá "Llegué al destino" para completar',
                target,
              }),
              visibilityTime: 6000,
            });
          }
        }
      } catch { /* best-effort, retry next tick */ }
    }, 5_000);

    return () => {
      mounted = false;
      channelRef.current?.unsubscribe();
      activeChannelIdRef.current = null;
      appStateSub.remove();
      clearInterval(pollInterval);
    };
  }, [isInitialized, profile, setActiveTrip]);
}

/**
 * Manage incoming ride requests subscription.
 */
export function useIncomingRequests(isOnline: boolean) {
  // BUG-219: same fix as useDriverRideInit — destructure via selectors so
  // these refs stay stable across store updates and don't retrigger the
  // useEffects below.
  const addRequest = useDriverRideStore((s) => s.addRequest);
  const removeRequest = useDriverRideStore((s) => s.removeRequest);
  const removeStaleRequests = useDriverRideStore((s) => s.removeStaleRequests);
  const clearRequests = useDriverRideStore((s) => s.clearRequests);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Periodically remove stale requests (>30s old) and notify driver
  useEffect(() => {
    const cleanup = setInterval(() => {
      const before = useDriverRideStore.getState().incomingRequests.length;
      removeStaleRequests();
      const after = useDriverRideStore.getState().incomingRequests.length;
      if (after < before) {
        Toast.show({
          type: 'info',
          text1: i18next.t('driver:requests.expired', { defaultValue: 'Oferta expirada' }),
          visibilityTime: 2000,
        });
      }
    }, 15_000);
    return () => clearInterval(cleanup);
  }, [removeStaleRequests]);

  useEffect(() => {
    if (!isOnline) {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      clearRequests();
      return;
    }

    // Fetch existing searching rides
    rideService.getSearchingRides().then((rides) => {
      for (const ride of rides) {
        addRequest(ride);
      }
    }).catch((err) => console.warn('[DriverRide] Failed to fetch rides:', err));

    // Subscribe to new rides
    channelRef.current = rideService.subscribeToNewRides(
      // On INSERT (new searching ride)
      (ride) => {
        addRequest(ride);
        triggerHaptic('warning');
        playSound('new_request');
      },
      // On UPDATE (ride status changed)
      (ride) => {
        if (ride.status !== 'searching') {
          removeRequest(ride.id);
        }
      },
    );

    // Fallback polling every 30s in case realtime disconnects silently
    const pollInterval = setInterval(async () => {
      try {
        const rides = await rideService.getSearchingRides();
        for (const ride of rides) addRequest(ride);
      } catch { /* best-effort fallback */ }
    }, 30000);

    return () => {
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      clearInterval(pollInterval);
    };
  }, [isOnline, addRequest, removeRequest, clearRequests]);
}

/**
 * Driver ride actions: accept, advance status, cancel.
 */
export function useDriverRideActions() {
  const profile = useDriverStore((s) => s.profile);
  const user = useAuthStore((s) => s.user);
  // BUG-219: stable refs via per-key selectors (see useDriverRideInit).
  const setActiveTrip = useDriverRideStore((s) => s.setActiveTrip);
  const removeRequest = useDriverRideStore((s) => s.removeRequest);
  const reset = useDriverRideStore((s) => s.reset);
  const channelRef = useRef<{ unsubscribe: () => void } | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      channelRef.current?.unsubscribe();
      activeChannelIdRef.current = null;
    };
  }, []);

  const completingRef = useRef(false);

  const acceptingRef = useRef(false);

  const acceptRide = useCallback(async (rideId: string) => {
    if (!profile || profile.status !== 'approved') return;
    // Bug 22: Block accept while completing previous ride
    if (completingRef.current) {
      Toast.show({ type: 'info', text1: i18next.t('driver:common.completing_ride', { defaultValue: 'Completando viaje anterior...' }) });
      return;
    }
    // BUG-005 fix: Prevent double-tap race condition
    if (acceptingRef.current) return;
    acceptingRef.current = true;

    try {
      // 1. RPC call FIRST — database determines who wins the race
      const ride = await driverService.acceptRideWithEligibility(rideId, profile.id);

      // 2. Only broadcast AFTER DB confirms success (BUG-005 fix)
      const user = useAuthStore.getState().user;
      const loc = useLocationStore.getState();
      if (user && loc.latitude && loc.longitude) {
        const broadcastData: DriverAcceptedBroadcast = {
          type: 'driver_accepted',
          driverId: profile.id,
          name: user.full_name,
          avatarUrl: user.avatar_url,
          vehicleType: cachedVehicle?.type ?? '',
          rating: profile.rating_avg,
          location: { latitude: loc.latitude, longitude: loc.longitude },
          vehicleMake: cachedVehicle?.make ?? null,
          vehicleModel: cachedVehicle?.model ?? null,
          vehicleColor: cachedVehicle?.color ?? null,
          vehiclePlate: cachedVehicle?.plate_number ?? null,
        };
        presenceService.broadcastDriverAccepted(rideId, broadcastData);
      }
      setActiveTrip(ride);
      removeRequest(rideId);
      triggerHaptic('success');
      playSound('ride_accepted');

      // Clean up previous subscription before creating new one (with dedup)
      if (activeChannelIdRef.current === ride.id) {
        logger.info('[Subscription] Dedup prevented', { ride_id: ride.id });
      } else {
        if (channelRef.current) {
          const oldChannel = channelRef.current;
          channelRef.current = null;
          oldChannel.unsubscribe();
        }
        activeChannelIdRef.current = ride.id;
        channelRef.current = rideService.subscribeToRide(ride.id, (updated) => {
          useDriverRideStore.getState().updateActiveTrip(updated);
        });
      }
    } catch (err: unknown) {
      // Extract a useful error code from whatever shape the error has.
      // Supabase postgrest errors are plain objects (not Error instances) with
      // shape { code, message, details, hint }. RPC business errors thrown from
      // driver.service.ts are Error with .message = server error code.
      const rawMsg = err instanceof Error ? err.message : (
        (err as { code?: string; message?: string })?.code
        ?? (err as { message?: string })?.message
        ?? String(err)
      );
      const errorMessages: Record<string, { title: string; subtitle?: string; type: 'error' | 'info' }> = {
        ride_already_taken: {
          title: i18next.t('driver:common.ride_already_accepted'),
          type: 'info',
        },
        offer_not_found_or_expired: {
          title: i18next.t('driver:common.offer_expired', { defaultValue: 'La oferta expiró' }),
          subtitle: i18next.t('driver:common.offer_expired_sub', { defaultValue: 'Esperá la próxima oferta.' }),
          type: 'info',
        },
        ride_not_found: {
          title: i18next.t('driver:common.ride_not_found', { defaultValue: 'Viaje no disponible' }),
          type: 'error',
        },
        driver_not_online: {
          title: i18next.t('driver:common.driver_not_online', { defaultValue: 'Debes estar en línea para aceptar viajes' }),
          type: 'error',
        },
        driver_stale_heartbeat: {
          title: i18next.t('driver:common.driver_stale_heartbeat', { defaultValue: 'Conexión perdida. Verificá tu internet.' }),
          type: 'error',
        },
        driver_has_active_ride: {
          title: i18next.t('driver:common.driver_has_active_ride', { defaultValue: 'Ya tenés un viaje activo' }),
          type: 'error',
        },
        driver_not_found: {
          title: i18next.t('driver:common.driver_not_found_profile', { defaultValue: 'Perfil de conductor no encontrado' }),
          type: 'error',
        },
        service_config_missing: {
          title: i18next.t('driver:common.service_config_missing', { defaultValue: 'Servicio temporalmente no disponible' }),
          subtitle: i18next.t('driver:common.service_config_missing_sub', { defaultValue: 'Intentá con otra oferta en unos segundos.' }),
          type: 'error',
        },
        unauthorized: {
          title: i18next.t('driver:common.unauthorized', { defaultValue: 'Sesión inválida' }),
          type: 'error',
        },
        unauthenticated: {
          title: i18next.t('driver:common.unauthorized', { defaultValue: 'Sesión inválida' }),
          type: 'error',
        },
        insufficient_balance: {
          title: i18next.t('driver:common.insufficient_balance', {
            defaultValue: 'Saldo insuficiente para aceptar',
          }),
          subtitle: i18next.t('driver:common.insufficient_balance_sub', {
            defaultValue: 'Recargá tu billetera antes de aceptar este viaje.',
          }),
          type: 'error',
        },
      };
      const entry = errorMessages[rawMsg];
      // Enrich insufficient_balance subtitle with the actual numbers so the
      // driver sees exactly how much they need. We read the payload the
      // service stashed on the Error instance (driver.service.ts).
      if (entry && rawMsg === 'insufficient_balance') {
        const payload = (err as { rpcPayload?: { balance_trc?: number; required_trc?: number } })
          ?.rpcPayload;
        const bal = payload?.balance_trc;
        const req = payload?.required_trc;
        if (typeof bal === 'number' && typeof req === 'number') {
          entry.subtitle = i18next.t('driver:common.insufficient_balance_detail', {
            defaultValue: 'Necesitás {{req}} TRC. Tu saldo actual: {{bal}} TRC.',
            req,
            bal,
          });
        }
      }
      if (entry) {
        Toast.show({ type: entry.type, text1: entry.title, text2: entry.subtitle });
      } else {
        // Unknown error — do NOT fall back to "ride_already_accepted".
        // Surface the real reason so drivers aren't misled when the RPC
        // never even fired (e.g. RLS denied a pre-RPC SELECT, network error).
        Toast.show({
          type: 'error',
          text1: i18next.t('driver:common.accept_failed', { defaultValue: 'No se pudo aceptar el viaje' }),
          text2: rawMsg ? String(rawMsg).slice(0, 120) : undefined,
        });
        logger.error('[Accept] unknown failure', { ride_id: rideId, raw: rawMsg, err: String(err) });
      }
      removeRequest(rideId);
    } finally {
      acceptingRef.current = false;
    }
  }, [profile, setActiveTrip, removeRequest]);

  const advanceStatus = useCallback(async () => {
    if (completingRef.current) return; // Prevent double execution
    const { activeTrip } = useDriverRideStore.getState();
    if (!activeTrip || !profile) return;

    const nextStatus = NEXT_STATUS[activeTrip.status];
    if (!nextStatus) {
      console.warn('[DriverRide] No valid next status for:', activeTrip.status);
      return;
    }

    // Immediate visual feedback — loading spinner on button
    useDriverRideStore.getState().setIsAdvancing(true);

    try {
      if (nextStatus === 'completed') {
        completingRef.current = true;
        // Calculate actual duration from pickup_at
        const pickupTime = activeTrip.pickup_at
          ? new Date(activeTrip.pickup_at).getTime()
          : activeTrip.accepted_at
            ? new Date(activeTrip.accepted_at).getTime()
            : Date.now() - 60000;
        const actualDurationS = Math.round((Date.now() - pickupTime) / 1000);

        // Calculate distance from GPS trail, fall back to estimate
        let actualDistanceM = activeTrip.estimated_distance_m;
        let gpsPointCount = 0;
        try {
          const distResult = await locationService.calculateRideDistance(activeTrip.id);
          gpsPointCount = distResult.point_count ?? 0;
          if (gpsPointCount >= 2) {
            actualDistanceM = distResult.distance_m;
          }
        } catch {
          // Fall back to estimated distance
        }

        // BUG-291: defensive sanity clamp on the GPS-derived distance.
        // Until the SQL-side fixes ship (calculate_ride_distance currently
        // sums haversine across NULL/0,0 points which produces multi-thousand-km
        // garbage when a single sample is corrupt; complete_ride_and_pay
        // applies no cap on actual_distance_m), an absurd value would flow
        // straight into the fare formula. QA Round 2 produced 24,619 km on a
        // 2km Vedado trip and charged the customer 1,440 CUP. Clamp to
        // estimated × 1.5 with an absolute 100km ceiling (Cuba is ~1,200 km
        // long; a single ride does not realistically exceed 100km in-app).
        // Result: even if the GPS / SQL fails, the rider and driver see
        // sensible numbers and the driver still gets credit for the trip.
        const estimatedM = activeTrip.estimated_distance_m ?? 0;
        const HARD_DISTANCE_CEILING_M = 100_000; // 100 km
        const sanityCap = estimatedM > 0
          ? Math.min(estimatedM * 1.5, HARD_DISTANCE_CEILING_M)
          : HARD_DISTANCE_CEILING_M;
        if (actualDistanceM > sanityCap) {
          console.warn(
            `[DriverRide] GPS distance ${actualDistanceM}m exceeds sanity cap ${sanityCap}m (estimated ${estimatedM}m) — clamping`,
          );
          // Prefer the estimate when it's available; otherwise the ceiling.
          actualDistanceM = estimatedM > 0 ? estimatedM : sanityCap;
        }

        // Warn if GPS trail is suspiciously sparse per-km (possible fraud or GPS issue)
        const distanceKm = actualDistanceM / 1000;
        const pointsPerKm = distanceKm > 0 ? gpsPointCount / distanceKm : 0;
        if (pointsPerKm < 3 && estimatedM > 0 && actualDistanceM < estimatedM * 0.5) {
          console.warn(`[DriverRide] Low GPS quality: ${gpsPointCount} points, actual=${actualDistanceM}m vs estimated=${estimatedM}m`);
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.low_gps_warning', { defaultValue: 'GPS limitado — la tarifa se ajustará automáticamente' }),
          });
        }

        // Retry logic — trip completion is critical and must survive transient failures.
        // BUG-263: idempotency — if a previous attempt actually succeeded server-side
        // but the response was lost in the network, the next retry will hit the
        // "Ride cannot be completed (current: completed)" guard. That's not a real
        // failure — the trip is already paid. Recover by fetching the completed
        // row and treating it as success.
        let result: Awaited<ReturnType<typeof driverService.completeRide>> | undefined;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await driverService.completeRide({
              rideId: activeTrip.id,
              driverId: profile.id,
              actualDistanceM,
              actualDurationS,
            });
            break;
          } catch (err) {
            lastErr = err;
            const msg = String((err as { message?: string })?.message ?? err);
            // BUG-263: idempotent recovery from "already completed"
            if (/cannot be completed.*current.*completed/i.test(msg)) {
              try {
                const fresh = await rideService.getRideWithDriver(activeTrip.id);
                if (fresh?.status === 'completed' && fresh.final_fare_cup) {
                  // BUG-fare-audit-followup: enriquecer el reconstruct con el
                  // snapshot final del `ride_pricing_snapshots` para que
                  // commission_amount + driver_earnings + surge salgan reales
                  // (antes quedaban 0/1 y la UI mostraba ganancias incorrectas
                  // cuando el RPC ya había completado pero la respuesta no
                  // llegó al cliente). Best-effort: si el fetch falla, caemos
                  // al fallback ?? 0.
                  let snapCommission = 0;
                  let snapSurge: number | null = null;
                  let snapPricingRuleId: string | null = null;
                  try {
                    const snap = await rideService.getPricingSnapshot(activeTrip.id);
                    if (snap) {
                      snapCommission = snap.commission_amount ?? 0;
                      snapSurge = snap.surge_multiplier ?? null;
                      snapPricingRuleId = snap.pricing_rule_id ?? null;
                    }
                  } catch { /* best-effort */ }
                  const finalFare = fresh.final_fare_cup;
                  // Cast via unknown porque la reconstrucción no puede
                  // conocer quota_balance_after post-hoc (sale del RPC
                  // en el happy path); el shape recovered es suficiente
                  // para los consumers (TripCompleteView, navigation a
                  // ride/[id]) pero TS no puede probarlo en una sola
                  // pasada.
                  result = {
                    final_fare_cup: finalFare,
                    final_fare_trc: fresh.final_fare_trc ?? 0,
                    final_fare_usd: fresh.final_fare_usd ?? 0,
                    exchange_rate_usd_cup: fresh.exchange_rate_usd_cup ?? 1,
                    commission_amount: snapCommission,
                    driver_earnings: finalFare - snapCommission,
                    payment_method: fresh.payment_method ?? 'cash',
                    share_token: fresh.share_token ?? '',
                    surge_multiplier: snapSurge ?? fresh.surge_multiplier ?? 1,
                    driver_custom_rate_cup: fresh.driver_custom_rate_cup ?? null,
                    payment_status: fresh.payment_status ?? 'not_applicable',
                    quota_deduction_amount: fresh.quota_deduction_amount ?? 0,
                    quota_balance_after: 0,
                    // PR #147 fields exposed by complete_ride_and_pay return.
                    wait_time_charge_cup: fresh.wait_time_charge_cup ?? 0,
                    pricing_rule_id: snapPricingRuleId,
                    estimate_snapshot_present: null,
                    // Preexisting 00247 field — línea 615 abajo lo lee para
                    // mostrar el modal de justificación de distancia exceso.
                    // Antes quedaba undefined y el modal nunca aparecía si
                    // caíamos en este recovery path.
                    excess_distance_uncharged_m: fresh.excess_distance_uncharged_m ?? 0,
                  } as unknown as Awaited<ReturnType<typeof driverService.completeRide>>;
                  break;
                }
              } catch { /* fall through to retry */ }
            }
            if (attempt < 3) {
              await new Promise<void>((r) => setTimeout(r, attempt * 2000));
            }
          }
        }
        if (!result) throw lastErr;

        triggerHaptic('success');
        playSound('trip_completed');

        // Send receipt email to passenger (non-blocking)
        notificationService.sendRideReceipt(activeTrip.id, activeTrip.customer_id)
          .catch((err) => console.warn('[Receipt] email failed:', err));

        useDriverRideStore.getState().updateActiveTrip({
          ...activeTrip,
          status: 'completed',
          final_fare_cup: result.final_fare_cup,
          actual_distance_m: actualDistanceM,
          actual_duration_s: actualDurationS,
          // BUG-222: surface excess meters so TripCompleteView can show
          // the justification modal when the driver exceeded 1.3× estimate.
          excess_distance_uncharged_m: result.excess_distance_uncharged_m ?? 0,
          share_token: result.share_token,
          completed_at: new Date().toISOString(),
        });
      } else {
        // BUG-244: send driver GPS coords for proximity gate when transitioning
        // to arrived_at_pickup or arrived_at_destination. Other transitions
        // (driver_en_route, in_progress) pass without geo check.
        const needsGeoCheck = nextStatus === 'arrived_at_pickup' || nextStatus === 'arrived_at_destination';
        const driverLat = useLocationStore.getState().latitude;
        const driverLng = useLocationStore.getState().longitude;
        const result = await driverService.updateRideStatus(activeTrip.id, nextStatus, {
          driverLat: needsGeoCheck ? driverLat ?? undefined : undefined,
          driverLng: needsGeoCheck ? driverLng ?? undefined : undefined,
        });
        // If gated by proximity, the backend stored gps_override_requested_at
        // and is awaiting rider confirmation. Show driver a waiting state.
        if (result?.gated && result.reason === 'pending_rider_confirmation') {
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.awaiting_rider_confirm', { defaultValue: 'Esperando al pasajero' }),
            text2: i18next.t('driver:trip.awaiting_rider_confirm_sub', {
              defaultValue: `Estás a ${result.distance_m}m. Le pedimos al pasajero que confirme.`,
              distance: result.distance_m ?? 0,
            }),
            visibilityTime: 4000,
          });
          // Don't update local trip status — wait for rider confirmation
          completingRef.current = false;
          useDriverRideStore.getState().setIsAdvancing(false);
          return;
        }
        // Surface no_gps_validation usage to driver
        if (result?.no_gps_validation) {
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.no_gps_used', { defaultValue: 'Avance sin GPS registrado' }),
            text2: i18next.t('driver:trip.no_gps_remaining', {
              defaultValue: `Te quedan ${result.no_gps_remaining ?? 0} usos esta semana.`,
              remaining: result.no_gps_remaining ?? 0,
            }),
            visibilityTime: 4000,
          });
        }
        useDriverRideStore.getState().updateActiveTrip({
          ...activeTrip,
          status: nextStatus,
        });
        // UX: confirm the status change with haptic + a context-specific toast.
        // Previously only the final "completed" step had feedback — drivers
        // had no cue whether their tap registered, especially at
        // arrived_at_pickup / in_progress which matter operationally
        // (passenger has arrived; trip is now metered).
        triggerHaptic('success');
        if (nextStatus === 'arrived_at_pickup') {
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.arrived_pickup_title', { defaultValue: 'Llegaste al pasajero' }),
            text2: i18next.t('driver:trip.arrived_pickup_sub', { defaultValue: 'Esperá al pasajero y tocá "Iniciar viaje"' }),
            visibilityTime: 2500,
          });
        } else if (nextStatus === 'in_progress') {
          Toast.show({
            type: 'success',
            text1: i18next.t('driver:trip.started_title', { defaultValue: 'Viaje iniciado' }),
            visibilityTime: 1500,
          });
        } else if (nextStatus === 'arrived_at_destination') {
          Toast.show({
            type: 'info',
            text1: i18next.t('driver:trip.at_dest_title', { defaultValue: 'Llegaste al destino' }),
            text2: i18next.t('driver:trip.at_dest_sub', { defaultValue: 'Tocá "Finalizar viaje" para cobrar' }),
            visibilityTime: 2500,
          });
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[DriverRide] advanceStatus failed', { error: errMsg, nextStatus });
      Toast.show({
        type: 'error',
        text1: i18next.t('driver:trip.status_update_failed'),
        text2: errMsg,
      });
    } finally {
      completingRef.current = false;
      useDriverRideStore.getState().setIsAdvancing(false);
    }
  }, [profile]);

  const cancelTrip = useCallback(async (reason?: string) => {
    const { activeTrip } = useDriverRideStore.getState();
    if (!activeTrip) return;

    try {
      await rideService.cancelRide(activeTrip.id, user?.id, reason);
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      activeChannelIdRef.current = null;
      reset();
    } catch {
      Toast.show({ type: 'error', text1: i18next.t('driver:trip.cancel_failed') });
    }
  }, [user, reset]);

  const clearCompletedTrip = useCallback(() => {
    channelRef.current?.unsubscribe();
    channelRef.current = null;
    activeChannelIdRef.current = null;
    useDriverRideStore.getState().setActiveTrip(null);
  }, []);

  const isAdvancing = useDriverRideStore((s) => s.isAdvancing);

  return { acceptRide, advanceStatus, cancelTrip, clearCompletedTrip, isAdvancing };
}
