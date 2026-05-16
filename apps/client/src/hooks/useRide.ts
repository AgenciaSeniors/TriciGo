import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState } from 'react-native';

import i18next from 'i18next';
import * as Notifications from 'expo-notifications';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rideService, deliveryService, trustedContactService, notificationService, walletService, corporateService } from '@tricigo/api';
import { triggerHaptic, trackEvent, playSound, getErrorMessage, logger, deliveryVehicleToSlug, haversineDistance } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { recentAddressService } from '@/services/recentAddresses';
import { invalidatePredictionCache } from '@/services/predictionCache';
import { scheduleLocalNotification } from '@/services/push.service';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
const SEARCH_TIMEOUT_MS = RIDE_CONFIG.SEARCH_TIMEOUT_MS;

/**
 * Initialize ride state on app mount.
 * Checks for an active ride and restores flow state.
 */
export function useRideInit() {
  const user = useAuthStore((s) => s.user);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  // BUG-219 (mirror of driver fix): destructure via per-key selectors so the
  // refs stay stable across store updates and don't retrigger checkActive
  // unnecessarily, which was causing activeRide to oscillate between values.
  const setActiveRide = useRideStore((s) => s.setActiveRide);
  const setRideWithDriver = useRideStore((s) => s.setRideWithDriver);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  // BUG-277: subscribeToRide is now a no-op that returns { unsubscribe }.
  // Use a minimal interface so the type stays correct without depending on
  // the full RealtimeChannel surface.
  const channelRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    if (!isInitialized || !user) return;

    let mounted = true;

    async function checkActive() {
      try {
        const active = await rideService.getActiveRide(user!.id);
        // BUG-220: clear stale local activeRide if server says no active ride.
        // This handles the case where the ride was canceled/completed
        // server-side but the realtime channel never delivered the UPDATE
        // event (CHANNEL_ERROR loop), leaving the customer stuck on the
        // "in-progress" UI with all pickup/dropoff inputs blocked.
        // BUG-257: but FIRST check if the pinned ride just completed —
        // we need to route the user to the rating screen, not just clear.
        if (!active && mounted) {
          const existing = useRideStore.getState().activeRide;
          if (existing) {
            const final = await rideService.getRideWithDriver(existing.id).catch(() => null);
            if (final?.status === 'completed' && mounted) {
              // eslint-disable-next-line no-console
              console.log('[useRideInit] ride completed since last check — routing to rating', { ride_id: existing.id });
              useRideStore.getState().updateRideFromRealtime(final);
              useRideStore.getState().setRideWithDriver(final);
              return;
            }
            // eslint-disable-next-line no-console
            console.log('[useRideInit] clearing stale local ride', {
              ride_id: existing.id,
              final_status: final?.status ?? 'not_found',
            });
            useRideStore.getState().setFlowStep('idle');
            useRideStore.getState().setActiveRide(null);
            useRideStore.getState().setRideWithDriver(null);
          }
          return;
        }
        if (!active || !mounted) return;

        // BUG-212 (9): the previous version set flowStep='searching'
        // whenever the DB read returned status='searching', and
        // overwrote the local activeRide unconditionally. This
        // produced a visible "looking for drivers" revert when the
        // hook re-ran AFTER a driver had already accepted — e.g. on
        // auth refresh or app foregrounded. The stale fetch
        // overwrote the realtime-updated state.
        //
        // Two guards:
        //   1. If the ride has a driver_id assigned, force
        //      flowStep='active' regardless of status (status may
        //      still be 'searching' for a moment between the realtime
        //      hop and the read replica catching up).
        //   2. Use updateRideFromRealtime when an activeRide is
        //      already in the store — its forward-only validation
        //      prevents a 'searching' from clobbering 'accepted'.
        const existing = useRideStore.getState().activeRide;
        if (existing && existing.id === active.id) {
          useRideStore.getState().updateRideFromRealtime(active);
        } else {
          setActiveRide(active);
        }

        const hasDriver = !!active.driver_id;
        if (active.status === 'searching' && !hasDriver) {
          setFlowStep('searching');
        } else if (active.status === 'completed') {
          setFlowStep('completed');
        } else if (active.status === 'canceled') {
          setFlowStep('idle');
        } else {
          setFlowStep('active');
        }

        // Subscribe to updates
        channelRef.current?.unsubscribe();
        // BUG-075: Wrap subscription in try-catch to prevent leaked null reference on error
        try {
          channelRef.current = rideService.subscribeToRide(active.id, (ride) => {
            useRideStore.getState().updateRideFromRealtime(ride);
          });
        } catch (subErr) {
          logger.error('Failed to subscribe to ride updates', { error: String(subErr), rideId: active.id });
        }

        // Load driver info if assigned
        if (active.driver_id) {
          const rwd = await rideService.getRideWithDriver(active.id);
          if (mounted && rwd) setRideWithDriver(rwd);
        }
      } catch (err) {
        logger.warn('No active ride or failed to check', { error: String(err) });
      }

      // F009: Check for pending review from a previous completed ride
      try {
        const pendingReviewId = await AsyncStorage.getItem('@tricigo/pending_review_ride_id');
        if (pendingReviewId && mounted) {
          const rwd = await rideService.getRideWithDriver(pendingReviewId);
          if (rwd && rwd.status === 'completed' && mounted) {
            setActiveRide(rwd);
            setRideWithDriver(rwd);
            setFlowStep('completed');
          } else {
            // Ride no longer exists or not completed — clean up
            await AsyncStorage.removeItem('@tricigo/pending_review_ride_id');
          }
        }
      } catch {
        // Best-effort: don't block app startup
      }
    }

    checkActive();

    // BUG-226 + BUG-247 (definitive fix for phantom rides):
    // Triple-layer freshness guarantee so the user is NEVER stuck in a
    // "locked input" state after a ride is canceled/completed.
    //
    //   Layer 1 — Aggressive polling: every 3s while pinned ride exists
    //             (was 10s — too slow when realtime channel is dead).
    //   Layer 2 — AppState foreground listener: re-check immediately when
    //             user brings the app to foreground (covers the case
    //             where ride got canceled while phone was in background).
    //   Layer 3 — Pre-render check on store mutation: any time the store
    //             mutation function runs and activeRide age > 30s without
    //             a recent DB confirmation, force a re-fetch.
    const checkAndClearStale = async (): Promise<void> => {
      if (!mounted || !user?.id) return;
      const { activeRide: pinned, flowStep: fs } = useRideStore.getState();
      if (!pinned || fs === 'idle' || fs === 'completed') return;
      try {
        const fresh = await rideService.getActiveRide(user.id);
        if (!fresh) {
          // BUG-257: getActiveRide filters by ACTIVE statuses only
          // (searching/accepted/.../in_progress/arrived_at_destination).
          // If our pinned ride is no longer in that list, it might have
          // just completed — in which case we MUST route the user to the
          // completion + rating screen, not just clear to idle. Fetch the
          // ride directly by id (no status filter) to find out.
          const final = await rideService.getRideWithDriver(pinned.id).catch(() => null);
          if (final?.status === 'completed') {
            // eslint-disable-next-line no-console
            console.log('[Watcher] ride completed — routing to rating', { ride_id: pinned.id });
            useRideStore.getState().updateRideFromRealtime(final);
            useRideStore.getState().setRideWithDriver(final);
            return;
          }
          // Canceled (by driver, dispatcher, or auto-cleanup) or
          // genuinely gone — clear local state.
          // eslint-disable-next-line no-console
          console.log('[Watcher] DB has no active ride — clearing stale local', {
            ride_id: pinned.id,
            final_status: final?.status ?? 'not_found',
          });
          useRideStore.getState().setFlowStep('idle');
          useRideStore.getState().setActiveRide(null);
          useRideStore.getState().setRideWithDriver(null);
        } else if (fresh.id === pinned.id) {
          // BUG-287 fix B — detect mid-trip column changes that don't touch
          // status/driver_id but DO drive UI (gps_override_requested_at
          // surfaces the rider confirmation modal; gps_override_confirmed_at
          // dismisses it). Without these checks the modal could lag up to 3 s
          // OR sit open indefinitely until status changed.
          const gpsReqChanged =
            (fresh as { gps_override_requested_at?: string | null }).gps_override_requested_at !==
            (pinned as { gps_override_requested_at?: string | null }).gps_override_requested_at;
          const gpsConfChanged =
            (fresh as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at !==
            (pinned as { gps_override_confirmed_at?: string | null }).gps_override_confirmed_at;
          const driverGpsStatusChanged =
            (fresh as { driver_gps_status?: string | null }).driver_gps_status !==
            (pinned as { driver_gps_status?: string | null }).driver_gps_status;

          if (
            fresh.status !== pinned.status
            || fresh.driver_id !== pinned.driver_id
            || gpsReqChanged
            || gpsConfChanged
            || driverGpsStatusChanged
          ) {
            // eslint-disable-next-line no-console
            console.log('[Watcher] ride changed', {
              from: pinned.status,
              to: fresh.status,
              gps_req_changed: gpsReqChanged,
              gps_conf_changed: gpsConfChanged,
              driver_gps_status_changed: driverGpsStatusChanged,
            });
            useRideStore.getState().updateRideFromRealtime(fresh);
          }
        } else {
          // The pinned id no longer matches the active ride — clear
          // eslint-disable-next-line no-console
          console.log('[Watcher] pinned ride id mismatch — clearing', { pinned_id: pinned.id, fresh_id: fresh.id });
          useRideStore.getState().setFlowStep('idle');
          useRideStore.getState().setActiveRide(null);
          useRideStore.getState().setRideWithDriver(null);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[Watcher] check failed', String(err));
      }
    };

    // Layer 1: aggressive 3s polling
    const watcherInterval = setInterval(checkAndClearStale, 3_000);

    // Layer 2: re-check on app foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mounted) {
        // Fire immediately when user returns to the app
        void checkAndClearStale();
      }
    });

    return () => {
      mounted = false;
      clearInterval(watcherInterval);
      appStateSub.remove();
      channelRef.current?.unsubscribe();
    };
  }, [isInitialized, user, setActiveRide, setRideWithDriver, setFlowStep]);
}

/**
 * Ride actions for the customer flow.
 */
export function useRideActions() {
  const user = useAuthStore((s) => s.user);
  // BUG-277: subscribeToRide is now a no-op that returns { unsubscribe }.
  // Use a minimal interface so the type stays correct without depending on
  // the full RealtimeChannel surface.
  const channelRef = useRef<{ unsubscribe: () => void } | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BUG-217: polling fallback timer (every 5s while flowStep='searching')
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchRetryCountRef = useRef(0);
  const searchStartTimeRef = useRef(0);

  const {
    draft,
    setFareEstimate,
    setActiveRide,
    setRideWithDriver,
    setFlowStep,
    setLoading,
    setFareEstimating,
    setError,
    setPromoResult,
    resetAll,
  } = useRideStore();
  // Bug 24: Use both useState (for UI re-renders) and a ref (for async access in confirmRide)
  const [validatingPromo, setValidatingPromo] = useState(false);
  const validatingPromoRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      channelRef.current?.unsubscribe();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    };
  }, []);

  const requestEstimate = useCallback(async () => {
    if (!draft.pickup || !draft.dropoff) return;

    // Validate coordinates are finite before estimation
    if (!Number.isFinite(draft.pickup?.location?.latitude) ||
        !Number.isFinite(draft.pickup?.location?.longitude) ||
        !Number.isFinite(draft.dropoff?.location?.latitude) ||
        !Number.isFinite(draft.dropoff?.location?.longitude)) {
      Toast.show({ type: 'error', text1: 'Ubicación inválida', text2: 'Selecciona la recogida y destino de nuevo' });
      return;
    }

    // Bug 8: Validate pickup ≠ dropoff (min 200m).
    // QA 2026-05-13: was using `await import('@tricigo/utils')` which
    // hung silently in --no-dev --minify bundles (workspace packages don't
    // dynamic-import cleanly when minified). haversineDistance is now
    // statically imported at the top, so this is a sync call.
    const dist = haversineDistance(draft.pickup.location, draft.dropoff.location);
    if (dist < RIDE_CONFIG.MIN_DISTANCE_M) {
      Toast.show({
        type: 'info',
        text1: i18next.t('rider:ride.too_close_title', { defaultValue: 'Destino muy cercano' }),
        text2: i18next.t('rider:ride.too_close_msg', { defaultValue: 'El destino está a menos de 200m del punto de recogida. Selecciona un destino más lejano.' }),
      });
      return;
    }

    // Bug 22: Clear stale promo result on re-estimate so it doesn't carry over
    setPromoResult(null);

    setFareEstimating(true);
    setError(null);
    try {
      const validWaypoints = draft.waypoints
        .filter((w) => w.location !== null && w.address !== '')
        .map((w) => ({ lat: w.location!.latitude, lng: w.location!.longitude }));

      const estimate = await rideService.getLocalFareEstimate({
        service_type: draft.serviceType,
        pickup_lat: draft.pickup.location.latitude,
        pickup_lng: draft.pickup.location.longitude,
        dropoff_lat: draft.dropoff.location.latitude,
        dropoff_lng: draft.dropoff.location.longitude,
        waypoints: validWaypoints.length > 0 ? validWaypoints : undefined,
      });
      setFareEstimate(estimate);
      // Auto-estimate stays on 'selecting' — inline prices, no ReviewingView transition

      // Estimate other service types in background for comparison UI
      const allSlugs: import('@tricigo/types').ServiceTypeSlug[] = ['moto_standard', 'triciclo_basico', 'auto_standard', 'auto_confort', 'mensajeria'];
      const otherSlugs = allSlugs.filter((s) => s !== draft.serviceType);
      const { setAllFareEstimates } = useRideStore.getState();
      // Seed with current estimate
      const estimates: Partial<Record<import('@tricigo/types').ServiceTypeSlug, import('@tricigo/types').FareEstimate>> = {
        [draft.serviceType]: estimate,
      };
      setAllFareEstimates({ ...estimates });
      // Fire background estimates
      Promise.allSettled(
        otherSlugs.map((slug) =>
          rideService.getLocalFareEstimate({
            service_type: slug,
            pickup_lat: draft.pickup!.location.latitude,
            pickup_lng: draft.pickup!.location.longitude,
            dropoff_lat: draft.dropoff!.location.latitude,
            dropoff_lng: draft.dropoff!.location.longitude,
            waypoints: validWaypoints.length > 0 ? validWaypoints : undefined,
          }).then((est) => {
            estimates[slug] = est;
            setAllFareEstimates({ ...estimates });
          })
        )
      ).catch(() => {});
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setFareEstimating(false);
    }
  }, [draft, setFareEstimate, setFlowStep, setFareEstimating, setError]);

  const validatePromo = useCallback(async () => {
    const { promoCode, fareEstimate: fe } = useRideStore.getState();
    if (!promoCode.trim() || !user || validatingPromo) return;

    setValidatingPromo(true);
    validatingPromoRef.current = true;
    try {
      const result = await rideService.validatePromoCode({
        code: promoCode.trim(),
        userId: user.id,
        fareAmount: fe?.estimated_fare_cup ?? 0,
      });
      setPromoResult({
        valid: result.valid,
        discountAmount: result.discountAmount,
        promotionId: result.promotion?.id,
        error: result.error,
      });
      if (result.valid) {
        trackEvent('promo_applied', { code: promoCode.trim(), discount: result.discountAmount });
      }
    } catch {
      setPromoResult({ valid: false, discountAmount: 0, error: i18next.t('rider:ride.promo_invalid') });
    } finally {
      setValidatingPromo(false);
      validatingPromoRef.current = false;
    }
  }, [user, validatingPromo, setPromoResult]);

  // Synchronous flag to prevent double-submission (state updates are async)
  const isSubmittingRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);

  const confirmRide = useCallback(async () => {
    if (isSubmittingRef.current) {
      Toast.show({ type: 'info', text1: i18next.t('rider:ride.processing', { defaultValue: 'Procesando tu solicitud...' }) });
      return;
    }
    if (pendingRequestIdRef.current !== null) return; // Request already in flight

    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    pendingRequestIdRef.current = requestId;
    isSubmittingRef.current = true;

    // X1.3: Reject stale fare estimates (>5 min)
    const estimatedAt = useRideStore.getState().fareEstimatedAt;
    if (!estimatedAt || Date.now() - estimatedAt > RIDE_CONFIG.FARE_ESTIMATE_TTL_MS) {
      Toast.show({ type: 'error', text1: i18next.t('errors.estimate_expired') });
      useRideStore.getState().setFareEstimate(null);
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      return;
    }

    const { draft: d, fareEstimate, allFareEstimates, promoResult } = useRideStore.getState();
    // BUG-213 (Issue A post-v1.1.14): defense-in-depth. The store action
    // setServiceType already syncs fareEstimate from allFareEstimates,
    // but if the user selected a vehicle whose background-fetched
    // estimate hadn't arrived yet, fareEstimate may still be from the
    // previous service_type. Read from the per-slug map first; fall
    // back to the singular estimate only if the slug-specific one is
    // missing. This guarantees the persisted ride row matches the
    // service_type the user actually selected.
    const selectedFare = allFareEstimates?.[d.serviceType] ?? fareEstimate;
    if (!d.pickup || !d.dropoff) {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      Toast.show({
        type: 'error',
        text1: i18next.t('rider:ride.missing_locations_title', { defaultValue: 'Falta recogida o destino' }),
        text2: i18next.t('rider:ride.missing_locations_msg', { defaultValue: 'Selecciona ambos puntos antes de solicitar el viaje.' }),
      });
      return;
    }

    // Bug 25: Validate minimum distance in confirmRide (guards deep-link bypass).
    // QA 2026-05-13: was `await import('@tricigo/utils')` which hung silently in
    // --no-dev --minify bundles, breaking the entire Solicitar tap. Now static.
    const confirmDist = haversineDistance(d.pickup.location, d.dropoff.location);
    if (confirmDist < RIDE_CONFIG.MIN_DISTANCE_M) {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      Toast.show({
        type: 'info',
        text1: i18next.t('rider:ride.too_close_title', { defaultValue: 'Destino muy cercano' }),
        text2: i18next.t('rider:ride.too_close_msg', { defaultValue: 'El destino está a menos de 200m del punto de recogida. Selecciona un destino más lejano.' }),
      });
      return;
    }

    // Bug 12 + Bug 24: Block confirm while promo is validating (use ref for async accuracy)
    if (validatingPromoRef.current) {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      Toast.show({ type: 'info', text1: i18next.t('rider:ride.wait_promo', { defaultValue: 'Espera, validando código...' }) });
      return;
    }

    // Bug 9: Validate TRC balance before booking
    if (d.paymentMethod === 'tricicoin' && fareEstimate) {
      try {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          const bal = await walletService.getBalance(userId);
          // Bug 26: Add 20% buffer to account for surge pricing changes since estimate
          if (bal.available < (fareEstimate.estimated_fare_trc ?? 0) * 1.2) {
            isSubmittingRef.current = false;
            pendingRequestIdRef.current = null;
            Toast.show({
              type: 'error',
              text1: i18next.t('rider:ride.insufficient_balance_title', { defaultValue: 'Saldo insuficiente' }),
              text2: i18next.t('rider:ride.insufficient_balance_msg', { defaultValue: 'No tienes suficiente TriciCoin para este viaje. Recarga tu wallet o cambia a efectivo.' }),
            });
            return;
          }
        }
      } catch (balErr) {
        logger.warn('Balance check failed', { error: String(balErr) });
        isSubmittingRef.current = false;
        pendingRequestIdRef.current = null;
        Toast.show({
          type: 'error',
          text1: i18next.t('rider:ride.balance_check_failed_title', { defaultValue: 'Error de verificación' }),
          text2: i18next.t('rider:ride.balance_check_failed_msg', { defaultValue: 'No se pudo verificar tu saldo. Intenta de nuevo o cambia a efectivo.' }),
        });
        return;
      }
    }

    // Validate mixed payment wallet balance
    if (d.paymentMethod === 'mixed' && fareEstimate) {
      try {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          const walletPart = fareEstimate.estimated_fare_cup * (d.walletRatio ?? 0.5);
          const bal = await walletService.getBalance(userId);
          if (bal.available < walletPart * 1.2) {
            isSubmittingRef.current = false;
            pendingRequestIdRef.current = null;
            Toast.show({
              type: 'error',
              text1: i18next.t('rider:ride.insufficient_balance_mixed_title', { defaultValue: 'Saldo insuficiente' }),
              text2: i18next.t('rider:ride.insufficient_balance_mixed_msg', { defaultValue: 'No tienes suficiente saldo para la parte wallet del pago mixto. Ajusta el porcentaje o recarga tu wallet.' }),
            });
            return;
          }
        }
      } catch (balErr) {
        logger.warn('Mixed balance check failed', { error: String(balErr) });
        isSubmittingRef.current = false;
        pendingRequestIdRef.current = null;
        Toast.show({
          type: 'error',
          text1: i18next.t('rider:ride.balance_check_failed_title', { defaultValue: 'Error de verificación' }),
          text2: i18next.t('rider:ride.balance_check_failed_msg', { defaultValue: 'No se pudo verificar tu saldo. Intenta de nuevo o cambia a efectivo.' }),
        });
        return;
      }
    }

    // BUG-073: For corporate rides, re-fetch budget to account for pending rides
    if (d.paymentMethod === 'corporate' && d.corporateAccountId && fareEstimate) {
      try {
        // Bugfix: method is `getAccount`, not `getAccountDetails` —
        // same return shape (CorporateAccount).
        const freshAccount = await corporateService.getAccount(d.corporateAccountId);
        const remainingBudget = (freshAccount?.monthly_budget_trc ?? 0) - (freshAccount?.current_month_spent ?? 0);
        if (remainingBudget < (fareEstimate.estimated_fare_trc ?? 0)) {
          isSubmittingRef.current = false;
          pendingRequestIdRef.current = null;
          Toast.show({
            type: 'error',
            text1: i18next.t('rider:corporate.budget_exceeded_title', { defaultValue: 'Presupuesto insuficiente' }),
            text2: i18next.t('rider:corporate.budget_exceeded_msg', { defaultValue: 'El presupuesto corporativo disponible no cubre este viaje.' }),
          });
          return;
        }
      } catch (corpErr) {
        logger.warn('Corporate budget re-check failed', { error: String(corpErr) });
        // Allow ride to proceed — server will enforce budget limits
      }
    }

    // BUG-074: Validate scheduled ride is at least 15 minutes in the future
    const MIN_ADVANCE_MS = 15 * 60 * 1000;
    if (d.scheduledAt && d.scheduledAt.getTime() < Date.now() + MIN_ADVANCE_MS) {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      Toast.show({
        type: 'error',
        text1: i18next.t('rider:ride.schedule_too_soon_title', { defaultValue: 'Hora muy cercana' }),
        text2: i18next.t('rider:ride.schedule_too_soon_msg', { defaultValue: 'Programa el viaje con al menos 15 minutos de antelación.' }),
      });
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // For delivery, use the vehicle type's service slug for fare calculation
      const effectiveServiceType =
        d.serviceType === 'mensajeria' && d.delivery.deliveryVehicleType
          ? deliveryVehicleToSlug(d.delivery.deliveryVehicleType)
          : d.serviceType;

      const isDelivery = d.serviceType === 'mensajeria' || !!d.delivery.deliveryVehicleType;

      const ride = await rideService.createRide({
        service_type: effectiveServiceType,
        ride_mode: isDelivery ? 'cargo' : 'passenger',
        payment_method: d.paymentMethod,
        pickup_latitude: d.pickup.location.latitude,
        pickup_longitude: d.pickup.location.longitude,
        pickup_address: d.pickup.address,
        dropoff_latitude: d.dropoff.location.latitude,
        dropoff_longitude: d.dropoff.location.longitude,
        dropoff_address: d.dropoff.address,
        estimated_fare_cup: selectedFare?.estimated_fare_cup,
        estimated_distance_m: selectedFare?.estimated_distance_m,
        estimated_duration_s: selectedFare?.estimated_duration_s,
        promo_code_id: promoResult?.valid ? promoResult.promotionId : undefined,
        // BUG-068: Validate discount is non-negative before sending
        discount_amount_cup: promoResult?.valid ? Math.max(0, promoResult.discountAmount ?? 0) : undefined,
        scheduled_at: d.scheduledAt ? d.scheduledAt.toISOString() : undefined,
        waypoints: (() => {
          const valid = d.waypoints.filter((wp) => wp.location !== null && wp.address !== '');
          return valid.length > 0
            ? valid.map((wp, i) => ({
                sort_order: i + 1,
                latitude: wp.location!.latitude,
                longitude: wp.location!.longitude,
                address: wp.address,
              }))
            : undefined;
        })(),
        corporate_account_id: d.corporateAccountId ?? undefined,
        insurance_selected: d.insuranceSelected,
        insurance_premium_cup: d.insuranceSelected ? (selectedFare?.insurance_premium_cup ?? 0) : 0,
        rider_preferences: Object.keys(d.ridePreferences).length > 0 ? d.ridePreferences : undefined,
      });

      // Bug 30: Save delivery details as blocking step — cancel ride if it fails
      if (d.serviceType === 'mensajeria' || d.delivery.deliveryVehicleType) {
        try {
          await deliveryService.createDeliveryDetails({
            ride_id: ride.id,
            package_description: d.delivery.packageDescription || 'Delivery',
            recipient_name: d.delivery.recipientName,
            recipient_phone: d.delivery.recipientPhone,
            estimated_weight_kg: d.delivery.estimatedWeightKg
              ? parseFloat(d.delivery.estimatedWeightKg)
              : undefined,
            special_instructions: d.delivery.specialInstructions || undefined,
            package_category: d.delivery.packageCategory ?? undefined,
            package_length_cm: d.delivery.packageLengthCm
              ? parseInt(d.delivery.packageLengthCm, 10)
              : undefined,
            package_width_cm: d.delivery.packageWidthCm
              ? parseInt(d.delivery.packageWidthCm, 10)
              : undefined,
            package_height_cm: d.delivery.packageHeightCm
              ? parseInt(d.delivery.packageHeightCm, 10)
              : undefined,
            client_accompanies: d.delivery.clientAccompanies,
            delivery_vehicle_type: d.delivery.deliveryVehicleType ?? undefined,
          });
        } catch (err) {
          logger.error('Delivery details creation failed — cancelling ride', { error: String(err), rideId: ride.id });
          // Cancel the orphaned ride so it doesn't exist without delivery metadata
          try {
            await rideService.cancelRide(ride.id, 'delivery_details_failed');
          } catch (cancelErr) {
            logger.error('Failed to cancel ride after delivery details error', { error: String(cancelErr) });
          }
          isSubmittingRef.current = false;
          pendingRequestIdRef.current = null;
          Toast.show({
            type: 'error',
            text1: i18next.t('rider:ride.delivery_details_failed_title', { defaultValue: 'Error al crear envío' }),
            text2: i18next.t('rider:ride.delivery_details_failed_msg', { defaultValue: 'No se pudieron guardar los detalles del envío. Intenta de nuevo.' }),
          });
          setLoading(false);
          return;
        }
      }

      // Save pickup & dropoff as recent addresses (fire-and-forget)
      recentAddressService.add(d.pickup.address, d.pickup.location.latitude, d.pickup.location.longitude).catch(() => {});
      recentAddressService.add(d.dropoff.address, d.dropoff.location.latitude, d.dropoff.location.longitude).catch(() => {});

      setActiveRide(ride);
      setFlowStep('searching');
      trackEvent('ride_requested', {
        ride_id: ride.id,
        service_type: d.serviceType,
        payment_method: d.paymentMethod,
        has_promo: !!promoResult?.valid,
      });

      // BUG-217 / BUG-220 / BUG-277: polling fallback. With realtime DISABLED
      // (BUG-277), polling is now the ONLY mechanism that delivers ride
      // status updates to the customer. We poll every 3s while ANY local
      // ride is pinned in store — covers searching→accepted, the entire
      // accepted→completed lifecycle, and canceled-by-driver / completed-by-
      // driver transitions that would otherwise leave the client stuck on
      // a phantom active ride.
      //
      // Side effects that the old realtime callback fired (haptics, sounds,
      // toasts, push notifications, analytics) are now triggered here on
      // status transitions detected via prevStatusRef.
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
      let prevPolledStatus: string | null = null;
      let prevPolledPaymentStatus: string | null = null;
      pollingTimerRef.current = setInterval(async () => {
        try {
          const { flowStep, activeRide: pinnedRide } = useRideStore.getState();
          if (!pinnedRide || flowStep === 'idle' || flowStep === 'completed') return;
          const fresh = await rideService.getActiveRide(user!.id);
          if (!fresh) {
            // getActiveRide filters out canceled/completed. If it returns
            // null while we have a pinned ride, that ride is no longer
            // active server-side. Clear the stale local state so the
            // customer can request a new ride.
            // eslint-disable-next-line no-console
            console.log('[Polling] no active ride server-side — clearing stale', { ride_id: pinnedRide.id });
            useRideStore.getState().setFlowStep('idle');
            useRideStore.getState().setActiveRide(null);
            useRideStore.getState().setRideWithDriver(null);
            return;
          }
          if (fresh.id !== pinnedRide.id) return;

          const newStatus = fresh.status;
          const newPaymentStatus = (fresh as { payment_status?: string }).payment_status ?? null;
          const transitioned = prevPolledStatus !== null && prevPolledStatus !== newStatus;
          const paymentJustConfirmed =
            prevPolledPaymentStatus === 'pending' && newPaymentStatus === 'paid';

          // eslint-disable-next-line no-console
          console.log('[Polling] ride state', {
            ride_id: fresh.id,
            status: newStatus,
            prev: prevPolledStatus,
            driver_id: fresh.driver_id,
          });
          useRideStore.getState().updateRideFromRealtime(fresh);

          // Fire side effects on status transitions (was in subscribeToRide
          // callback before BUG-277). Only fire when prev is non-null and
          // different — first poll establishes baseline.
          if (transitioned) {
            if (newStatus === 'accepted') {
              triggerHaptic('success');
              playSound('ride_accepted');
              Toast.show({ type: 'success', text1: i18next.t('ride.driver_assigned', { ns: 'rider' }) });
              scheduleLocalNotification(
                i18next.t('ride.driver_assigned', { ns: 'rider' }),
                i18next.t('ride.driver_assigned_body', { ns: 'rider' }),
              );
              // Load driver info on accept
              if (fresh.driver_id) {
                rideService.getRideWithDriver(fresh.id).then((rwd) => {
                  if (rwd) useRideStore.getState().setRideWithDriver(rwd);
                }).catch(() => {});
              }
            }
            if (newStatus === 'driver_en_route' && prevPolledStatus === 'accepted') {
              triggerHaptic('light');
            }
            if (newStatus === 'arrived_at_pickup') {
              triggerHaptic('success');
              setTimeout(() => triggerHaptic('medium'), 300);
              setTimeout(() => triggerHaptic('light'), 600);
              playSound('driver_arrived');
              scheduleLocalNotification(
                i18next.t('ride.driver_arrived_banner', { ns: 'rider' }),
                '',
              );
            }
            if (newStatus === 'in_progress' && prevPolledStatus === 'arrived_at_pickup') {
              triggerHaptic('medium');
              playSound('ride_accepted');
              scheduleLocalNotification(
                i18next.t('ride.trip_started_notif', { ns: 'rider' }),
                i18next.t('ride.trip_started_body', { ns: 'rider' }),
              );
            }
            if (newStatus === 'arrived_at_destination') {
              triggerHaptic('success');
              playSound('destination_arrived');
              scheduleLocalNotification(
                i18next.t('ride.arrived_at_destination_title', { ns: 'rider' }),
                i18next.t('ride.arrived_at_destination_body', { ns: 'rider' }),
              );
            }
            if (newStatus === 'completed') {
              triggerHaptic('success');
              playSound('trip_completed');
              trackEvent('ride_completed', { ride_id: fresh.id, service_type: fresh.service_type });
              scheduleLocalNotification(
                i18next.t('ride.trip_completed_notif', { ns: 'rider' }),
                '',
              );
              invalidatePredictionCache().catch(() => {});

              const fare = fresh.final_fare_cup ?? fresh.final_fare_trc;
              if (fare && fare > 0) {
                const methodKey = `ride.payment_method_${fresh.payment_method ?? 'cash'}`;
                Toast.show({
                  type: 'success',
                  text1: i18next.t('ride.payment_confirmed_title', { ns: 'rider' }),
                  text2: i18next.t('ride.payment_confirmed_body', {
                    ns: 'rider',
                    amount: fare,
                    method: i18next.t(methodKey, { ns: 'rider', defaultValue: fresh.payment_method ?? 'cash' }),
                  }),
                  visibilityTime: 5000,
                });
              }
            }
            if (newStatus === 'canceled') {
              triggerHaptic('error');
              if (prevPolledStatus === 'in_progress') {
                Toast.show({
                  type: 'error',
                  text1: i18next.t('rider:ride.trip_interrupted_title', { defaultValue: 'Viaje interrumpido' }),
                  text2: i18next.t('rider:ride.trip_interrupted_msg', { defaultValue: 'El viaje fue interrumpido. Contacta a soporte si necesitas ayuda.' }),
                });
              } else {
                Toast.show({
                  type: 'error',
                  text1: i18next.t('rider:ride.driver_canceled_title', { defaultValue: 'Viaje cancelado' }),
                  text2: i18next.t('rider:ride.driver_canceled_msg', { defaultValue: 'El conductor canceló el viaje. Puedes buscar otro conductor.' }),
                });
              }
              scheduleLocalNotification(
                i18next.t('ride.driver_canceled_notif', { ns: 'rider' }),
                '',
              );
            }
          }
          if (paymentJustConfirmed) {
            triggerHaptic('success');
            Toast.show({
              type: 'success',
              text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
            });
            trackEvent('ride_payment_confirmed', { ride_id: fresh.id });
          }

          prevPolledStatus = newStatus;
          prevPolledPaymentStatus = newPaymentStatus;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[Polling] failed', String(e));
        }
      }, 3000);

      // Subscribe to ride updates
      channelRef.current?.unsubscribe();
      // BUG-075: Wrap subscription in try-catch to prevent leaked null reference on error
      try {
      channelRef.current = rideService.subscribeToRide(ride.id, async (updated) => {
        try {
        // Capture previous state BEFORE updating store
        const prevRide = useRideStore.getState().activeRide;

        const store = useRideStore.getState();
        store.updateRideFromRealtime(updated);

        // Haptic + sound feedback on key status changes
        if (updated.status === 'accepted') {
          triggerHaptic('success');
          playSound('ride_accepted');
          Toast.show({ type: 'success', text1: i18next.t('ride.driver_assigned', { ns: 'rider' }) });
          scheduleLocalNotification(
            i18next.t('ride.driver_assigned', { ns: 'rider' }),
            i18next.t('ride.driver_assigned_body', { ns: 'rider' }),
          );
        }
        if (updated.status === 'driver_en_route' && prevRide?.status === 'accepted') {
          triggerHaptic('light');
        }
        if (updated.status === 'arrived_at_pickup') {
          triggerHaptic('success');
          setTimeout(() => triggerHaptic('medium'), 300);
          setTimeout(() => triggerHaptic('light'), 600);
          playSound('driver_arrived');
          scheduleLocalNotification(
            i18next.t('ride.driver_arrived_banner', { ns: 'rider' }),
            '',
          );
        }
        if (updated.status === 'in_progress' && prevRide?.status === 'arrived_at_pickup') {
          triggerHaptic('medium');
          playSound('ride_accepted');
          scheduleLocalNotification(
            i18next.t('ride.trip_started_notif', { ns: 'rider' }),
            i18next.t('ride.trip_started_body', { ns: 'rider' }),
          );
        }
        if (updated.status === 'arrived_at_destination') {
          triggerHaptic('success');
          playSound('destination_arrived');
          scheduleLocalNotification(
            i18next.t('ride.arrived_at_destination_title', { ns: 'rider' }),
            i18next.t('ride.arrived_at_destination_body', { ns: 'rider' }),
          );
        }
        if (updated.status === 'completed') {
          triggerHaptic('success');
          playSound('trip_completed');
          trackEvent('ride_completed', { ride_id: updated.id, service_type: updated.service_type });
          scheduleLocalNotification(
            i18next.t('ride.trip_completed_notif', { ns: 'rider' }),
            '',
          );
          // Invalidate prediction cache so next load recalculates with new ride
          invalidatePredictionCache().catch(() => {});

          // Payment confirmation toast
          const fare = updated.final_fare_cup ?? updated.final_fare_trc;
          if (fare && fare > 0) {
            const methodKey = `ride.payment_method_${updated.payment_method ?? 'cash'}`;
            Toast.show({
              type: 'success',
              text1: i18next.t('ride.payment_confirmed_title', { ns: 'rider' }),
              text2: i18next.t('ride.payment_confirmed_body', {
                ns: 'rider',
                amount: fare,
                method: i18next.t(methodKey, { ns: 'rider', defaultValue: updated.payment_method ?? 'cash' }),
              }),
              visibilityTime: 5000,
            });
          }

          // Schedule rating reminder 5 min after completion
          Notifications.scheduleNotificationAsync({
            content: {
              title: i18next.t('ride.rate_reminder_title', { ns: 'rider' }),
              body: i18next.t('ride.rate_reminder_body', { ns: 'rider' }),
              data: { type: 'ride', ride_id: updated.id, action: 'rate' },
              // Omit sound (null isn't accepted) — same silent behavior.
            },
            trigger: { seconds: 300, type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL },
          }).then((reminderId) => {
            useRideStore.getState().setRatingReminderId(reminderId);
          }).catch(() => {});

          // Notify auto-share trusted contacts that the trip ended safely (fire-and-forget)
          const currentUserId = useAuthStore.getState().user?.id;
          const currentUserName = useAuthStore.getState().user?.full_name ?? 'Tu contacto';
          if (currentUserId) {
            trustedContactService.getAutoShareContacts(currentUserId).then((contacts) => {
              if (contacts.length > 0) {
                notificationService.notifyTrustedContacts({
                  contacts: contacts.map((c) => ({ name: c.name, phone: c.phone })),
                  message: `\u2705 ${currentUserName} lleg\u00f3 a su destino de forma segura.`,
                  eventType: 'trip_completed_safe',
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }

        // Payment confirmed via Realtime
        if (
          prevRide?.payment_status === 'pending' &&
          (updated as any).payment_status === 'paid'
        ) {
          triggerHaptic('success');
          Toast.show({
            type: 'success',
            text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
          });
          trackEvent('ride_payment_confirmed', { ride_id: updated.id });
        }

        // Bug 10 + Bug 27: Show contextual alert when ride is cancelled
        if (updated.status === 'canceled' && prevRide?.status !== 'canceled') {
          triggerHaptic('error');
          if (prevRide?.status === 'in_progress') {
            // Bug 27: Different message when cancellation happens mid-trip
            Toast.show({
              type: 'error',
              text1: i18next.t('rider:ride.trip_interrupted_title', { defaultValue: 'Viaje interrumpido' }),
              text2: i18next.t('rider:ride.trip_interrupted_msg', { defaultValue: 'El viaje fue interrumpido. Contacta a soporte si necesitas ayuda.' }),
            });
          } else {
            Toast.show({
              type: 'error',
              text1: i18next.t('rider:ride.driver_canceled_title', { defaultValue: 'Viaje cancelado' }),
              text2: i18next.t('rider:ride.driver_canceled_msg', { defaultValue: 'El conductor canceló el viaje. Puedes buscar otro conductor.' }),
            });
          }
          scheduleLocalNotification(
            i18next.t('ride.driver_canceled_notif', { ns: 'rider' }),
            '',
          );
        }

        // When driver accepts, load driver info
        if (updated.status === 'accepted' && updated.driver_id) {
          try {
            const rwd = await rideService.getRideWithDriver(updated.id);
            if (rwd) useRideStore.getState().setRideWithDriver(rwd);
          } catch {
            // Will retry on next update
          }
        }
        } catch (cbErr) {
          logger.error('Realtime callback error', { error: String(cbErr), rideId: updated.id });
        }
      });
      } catch (subErr) {
        logger.error('Failed to subscribe to ride updates', { error: String(subErr), rideId: ride.id });
      }

      // Search timeout — retry with "expanding search" before cancelling
      searchRetryCountRef.current = 0;
      searchStartTimeRef.current = Date.now();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      const scheduleSearchTimeout = () => {
        timeoutRef.current = setTimeout(async () => {
          const { flowStep, activeRide: ar } = useRideStore.getState();
          if (flowStep !== 'searching' || !ar) return;

          // Check if ride was accepted during search
          if (ar.status !== 'searching') {
            useRideStore.getState().setFlowStep('active');
            return;
          }

          searchRetryCountRef.current += 1;
          const totalElapsed = Date.now() - searchStartTimeRef.current;

          // If under max total time and still have retry rounds, show "expanding" toast and retry
          if (
            searchRetryCountRef.current <= RIDE_CONFIG.SEARCH_RETRY_ROUNDS &&
            totalElapsed < RIDE_CONFIG.SEARCH_MAX_TOTAL_MS
          ) {
            Toast.show({
              type: 'info',
              text1: i18next.t('rider:ride.expanding_search', {
                defaultValue: 'Ampliando la busqueda de conductores...',
              }),
              visibilityTime: 3000,
            });
            // F001: Re-trigger matching with expanded radius (counter already incremented)
            const radius = RIDE_CONFIG.SEARCH_RADIUS_PROGRESSION[searchRetryCountRef.current - 1] ?? 12000;
            try {
              await rideService.retryMatchDrivers(ar.id, radius);
            } catch {
              // Best-effort — don't block retry scheduling
            }
            // Schedule next timeout round
            scheduleSearchTimeout();
            return;
          }

          // Max retries exhausted — cancel the ride
          try {
            await rideService.cancelRide(ar.id, user?.id, 'search_timeout');
          } catch {
            // Best effort
          }
          channelRef.current?.unsubscribe();
          channelRef.current = null;
          resetAll();
          Toast.show({
            type: 'error',
            text1: i18next.t('rider:ride.no_driver_found', {
              defaultValue: 'No se encontro conductor disponible',
            }),
          });
        }, SEARCH_TIMEOUT_MS);
      };

      scheduleSearchTimeout();
    } catch (err) {
      logger.error('confirmRide failed', {
        error: String(err),
        stack: (err as Error)?.stack,
        name: (err as Error)?.name,
      });
      const errMsg = getErrorMessage(err);

      // BUG-253 (Capa 4.3): the DB-level trigger
      // `enforce_one_active_ride_per_customer` raises with this exact
      // string when the customer already has an active ride. Recover by
      // re-syncing local state from the server — the user's previous
      // ride is real and pinned correctly. Don't drop them back to
      // 'selecting' (that would lose context).
      if (errMsg.includes('customer_has_active_ride')) {
        try {
          const existing = await rideService.getActiveRide(user?.id ?? '');
          if (existing) {
            useRideStore.getState().setActiveRide(existing);
            const hasDriver = !!existing.driver_id;
            useRideStore.getState().setFlowStep(
              !hasDriver && existing.status === 'searching' ? 'searching' : 'active',
            );
            if (hasDriver) {
              const rwd = await rideService.getRideWithDriver(existing.id);
              if (rwd) useRideStore.getState().setRideWithDriver(rwd);
            }
            Toast.show({
              type: 'info',
              text1: i18next.t('rider:ride.has_active_ride_title', { defaultValue: 'Ya tienes un viaje activo' }),
              text2: i18next.t('rider:ride.has_active_ride_msg', {
                defaultValue: 'Te llevamos al viaje en curso. Cancélalo si quieres pedir uno nuevo.',
              }),
              visibilityTime: 5000,
            });
          } else {
            // No active ride server-side — race condition, state self-healed
            Toast.show({
              type: 'error',
              text1: i18next.t('rider:ride.request_failed_title', { defaultValue: 'No se pudo solicitar el viaje' }),
              text2: i18next.t('rider:common.try_again', { defaultValue: 'Intenta de nuevo' }),
            });
            setFlowStep('selecting');
          }
        } catch {
          setFlowStep('selecting');
        }
      } else {
        setError(errMsg);
        setFlowStep('selecting');
        Toast.show({
          type: 'error',
          text1: i18next.t('rider:ride.request_failed_title', { defaultValue: 'No se pudo solicitar el viaje' }),
          text2: errMsg,
        });
      }
    } finally {
      setLoading(false);
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
    }
  }, [setActiveRide, setFlowStep, setLoading, setError, setRideWithDriver, user?.id]);

  const cancelRide = useCallback(async (reason?: string) => {
    // QA 2026-05-13: ride got auto-canceled at insert — trace the caller.
    // eslint-disable-next-line no-console
    console.log('[QA-DEBUG cancelRide] CALLED', { reason, stack: new Error().stack?.split('\n').slice(1, 8).join('\n') });
    const { activeRide } = useRideStore.getState();
    if (!activeRide) return;

    setLoading(true);
    try {
      const result = await rideService.cancelRide(activeRide.id, user?.id, reason);
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      trackEvent('ride_canceled', {
        ride_id: activeRide.id,
        reason,
        cancellation_fee: result?.cancellationFee?.fee_cup ?? 0,
      });
      resetAll();

      // Build alert message with both fee and penalty info
      const messages: string[] = [];

      // State-based cancellation fee (fee_cup is in whole CUP pesos, not centavos)
      if (result?.cancellationFee && !result.cancellationFee.is_free) {
        messages.push(
          i18next.t('rider:ride.cancel_fee_charged', { amount: result.cancellationFee.fee_cup }),
        );
      }

      // Progressive penalty (penaltyAmount is in whole CUP pesos)
      if (result && result.penaltyAmount > 0) {
        messages.push(
          i18next.t('rider:ride.cancel_penalty_applied', { amount: result.penaltyAmount }),
        );
      }

      if (result?.isBlocked) {
        messages.push(i18next.t('rider:ride.cancel_blocked'));
      }

      if (messages.length > 0) {
        Toast.show({
          type: 'success',
          text1: i18next.t('rider:ride.cancel_title'),
          text2: messages.join(' '),
        });
      }
    } catch (err) {
      // If the ride is already closed on the server (auto-canceled by search timeout
      // or manually closed from another session), treat it as a successful cancel:
      // client state is out of sync and resetting is the right recovery.
      const msg = getErrorMessage(err);
      if (msg.includes('ride_already_closed') || msg.includes('already_closed')) {
        channelRef.current?.unsubscribe();
        channelRef.current = null;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        resetAll();
        Toast.show({
          type: 'info',
          text1: i18next.t('rider:ride.already_closed_title', { defaultValue: 'El viaje ya se había cerrado' }),
          text2: i18next.t('rider:ride.already_closed_msg', { defaultValue: 'Se canceló automáticamente porque no se encontró conductor.' }),
        });
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [user, setLoading, setError, resetAll]);

  return { requestEstimate, confirmRide, cancelRide, validatePromo, validatingPromo };
}
