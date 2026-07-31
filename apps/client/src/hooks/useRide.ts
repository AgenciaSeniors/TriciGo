import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState } from 'react-native';

import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { rideService, deliveryService, walletService, corporateService } from '@tricigo/api';
import { triggerHaptic, trackEvent, getErrorMessage, logger, mapLogger, deliveryVehicleToSlug, haversineDistance } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { recentAddressService } from '@/services/recentAddresses';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { shouldSendSearchHeartbeat } from '@/hooks/searchHeartbeat';
import { fireRideStatusEffects, muteCancelAnnouncementFor } from '@/hooks/rideStatusEffects';
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
    //
    // This watcher also carries the persistent-search HEARTBEAT (see below).
    let lastBeatAt = 0;

    const checkAndClearStale = async (): Promise<void> => {
      if (!mounted || !user?.id) return;
      const { activeRide: pinned, flowStep: fs } = useRideStore.getState();
      if (!pinned || fs === 'idle' || fs === 'completed') return;

      // Persistent-search heartbeat. `cleanup_orphan_searching_rides` cancels
      // any ride whose `searching_seen_at` went stale, so with no beat EVERY
      // ride that no driver accepts is killed at `searching_abandon_seconds`
      // (600s) while the rider is still watching the search screen — and the
      // next tap on "Cancelar" then hits `ride_already_closed`.
      //
      // The beat used to live in the 3s polling loop that confirmRide starts,
      // but that interval is owned by ReviewingView/SelectingView, and the
      // `setFlowStep('searching')` inside confirmRide unmounts them — their
      // cleanup cleared the interval before its first tick, so the beat never
      // fired even once. Prod bore that out: across 114 rides, not one real
      // ride ever had `searching_seen_at > created_at` (the only 3 rows that
      // do are seeded demo data, with day-long offsets). The web app never
      // had the bug — it beats from its own hook, useSearchingRide.
      //
      // It belongs here because useRideInit is mounted once in
      // app/_layout.tsx and outlives every view swap. Backgrounding the app
      // still suspends these timers, so a genuinely abandoned search is still
      // reaped — which is the point of the feature.
      if (shouldSendSearchHeartbeat(fs, lastBeatAt, Date.now())) {
        lastBeatAt = Date.now();
        // Fire-and-forget: touchSearchingRide swallows its own errors, and a
        // missed beat is harmless (the next one is 30s away).
        void rideService.touchSearchingRide(pinned.id);
      }

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
            // Fire while pinned.status is still the PREVIOUS status — the
            // store update below overwrites it.
            if (pinned.status !== 'completed') fireRideStatusEffects(pinned.status, final);
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
          // Say WHY the trip disappeared. Wiping the screen in silence is what
          // made a server-side cancellation look like the app losing the trip;
          // the rider was left to discover it by tapping "Cancelar" and getting
          // `ride_already_closed` back.
          if (final?.status === 'canceled' && pinned.status !== 'canceled') {
            fireRideStatusEffects(pinned.status, final);
          }
          useRideStore.getState().setFlowStep('idle');
          useRideStore.getState().setActiveRide(null);
          useRideStore.getState().setRideWithDriver(null);
          // Sticky-serviceType fix: also reset the draft so a system-canceled
          // mensajería order doesn't leave serviceType stuck on the next trip.
          useRideStore.getState().resetDraft();
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
          // Add-stop: the recalc trigger updates estimated_fare_cup /
          // estimated_distance_m / estimated_duration_s WITHOUT changing
          // status. Without detecting these, the new fare/ETA never reaches
          // the screen during in_progress (realtime is disabled, BUG-277).
          const estimatedChanged =
            (fresh as { estimated_fare_cup?: number | null }).estimated_fare_cup !==
              (pinned as { estimated_fare_cup?: number | null }).estimated_fare_cup
            || (fresh as { estimated_distance_m?: number | null }).estimated_distance_m !==
              (pinned as { estimated_distance_m?: number | null }).estimated_distance_m
            || (fresh as { estimated_duration_s?: number | null }).estimated_duration_s !==
              (pinned as { estimated_duration_s?: number | null }).estimated_duration_s;

          // Payment can flip pending→paid without touching status (the driver
          // confirms cash, or a wallet debit settles). Without this the
          // confirmation toast never fires.
          const prevPaymentStatus =
            (pinned as { payment_status?: string | null }).payment_status ?? null;
          const newPaymentStatus =
            (fresh as { payment_status?: string | null }).payment_status ?? null;
          const paymentStatusChanged = prevPaymentStatus !== newPaymentStatus;

          if (
            fresh.status !== pinned.status
            || fresh.driver_id !== pinned.driver_id
            || gpsReqChanged
            || gpsConfChanged
            || driverGpsStatusChanged
            || estimatedChanged
            || paymentStatusChanged
          ) {
            // eslint-disable-next-line no-console
            console.log('[Watcher] ride changed', {
              from: pinned.status,
              to: fresh.status,
              gps_req_changed: gpsReqChanged,
              gps_conf_changed: gpsConfChanged,
              driver_gps_status_changed: driverGpsStatusChanged,
              estimated_changed: estimatedChanged,
              payment_status_changed: paymentStatusChanged,
            });

            // Capture the previous status BEFORE the store update overwrites it.
            const prevStatus = pinned.status;
            useRideStore.getState().updateRideFromRealtime(fresh);

            // The rider's in-app feedback for this leg of the trip. Terminal
            // statuses (completed / canceled) never reach here — getActiveRide
            // filters them out — they are handled in the `!fresh` branch above.
            if (fresh.status !== prevStatus) {
              fireRideStatusEffects(prevStatus, fresh);
            }

            if (prevPaymentStatus === 'pending' && newPaymentStatus === 'paid') {
              triggerHaptic('success');
              Toast.show({
                type: 'success',
                text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
              });
              trackEvent('ride_payment_confirmed', { ride_id: fresh.id });
            }
          }
        } else {
          // The pinned id no longer matches the active ride — clear
          // eslint-disable-next-line no-console
          console.log('[Watcher] pinned ride id mismatch — clearing', { pinned_id: pinned.id, fresh_id: fresh.id });
          useRideStore.getState().setFlowStep('idle');
          useRideStore.getState().setActiveRide(null);
          useRideStore.getState().setRideWithDriver(null);
          // Sticky-serviceType fix: reset the draft on stale-state clear too.
          useRideStore.getState().resetDraft();
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
  // NOTE: there is deliberately no polling timer here any more. The ride
  // status poll, the search heartbeat and the rider's in-app feedback all
  // live in useRideInit's watcher, which is mounted once in app/_layout.tsx.
  // A timer created here would be owned by ReviewingView/SelectingView and
  // killed on their unmount — which is exactly how the old one died.
  const searchRetryCountRef = useRef(0);
  const searchStartTimeRef = useRef(0);

  const {
    draft,
    setFareEstimate,
    setActiveRide,
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

      // Mensajería se cobra al precio del VEHÍCULO elegido (alinea con la web):
      // el estimado primario (= fareEstimate singular que alimenta botón/ETA/cobro)
      // sale del vehículo, no del config plano de 'mensajeria'. allFareEstimates
      // igual guarda las 5 slugs (incl. 'mensajeria' plano) vía el loop de fondo.
      const primarySlug =
        draft.serviceType === 'mensajeria' && draft.delivery.deliveryVehicleType
          ? deliveryVehicleToSlug(draft.delivery.deliveryVehicleType)
          : draft.serviceType;

      const estimate = await rideService.getLocalFareEstimate({
        service_type: primarySlug,
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
      const otherSlugs = allSlugs.filter((s) => s !== primarySlug);
      const { setAllFareEstimates } = useRideStore.getState();
      // Seed with current estimate
      const estimates: Partial<Record<import('@tricigo/types').ServiceTypeSlug, import('@tricigo/types').FareEstimate>> = {
        [primarySlug]: estimate,
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
    const state = useRideStore.getState();
    const { promoCode, fareEstimate: fe, allFareEstimates, draft: d } = state;
    if (!promoCode.trim() || !user || validatingPromo) return;

    // The fare the user is LOOKING AT, not the primary estimate. SelectingView
    // renders `allFareEstimates[serviceType]`, so validating against
    // `fareEstimate` computed the percentage off a different service's fare
    // and previewed a discount the server would never apply.
    // Mensajería is priced by the chosen VEHICLE, same rule as
    // ride.store.setServiceType (BUG-213).
    const effSlug =
      d.serviceType === 'mensajeria' && d.delivery.deliveryVehicleType
        ? deliveryVehicleToSlug(d.delivery.deliveryVehicleType)
        : d.serviceType;
    const fareAmount =
      allFareEstimates?.[effSlug]?.estimated_fare_cup ?? fe?.estimated_fare_cup ?? 0;

    // With no estimate the RPC returns `valid: true, discount_amount: 0`
    // (fare × pct = 0) and the UI cheerfully announced "¡Descuento de 0
    // aplicado!". Ask for a destination first instead.
    if (fareAmount <= 0) {
      setPromoResult({
        valid: false,
        discountAmount: 0,
        error: i18next.t('rider:ride.promo_needs_estimate', {
          defaultValue: 'Elige destino y servicio para aplicar el código',
        }),
      });
      return;
    }

    setValidatingPromo(true);
    validatingPromoRef.current = true;
    try {
      const result = await rideService.validatePromoCode({
        code: promoCode.trim(),
        userId: user.id,
        fareAmount,
      });
      // The service returns the RAW error key ('already_used', 'first_ride_only',
      // …) — untranslated it rendered literally in ReviewingView. Map to copy.
      const errorMsgs: Record<string, string> = {
        invalid: i18next.t('rider:ride.promo_invalid'),
        expired: i18next.t('rider:ride.promo_error_expired', { defaultValue: 'Código expirado' }),
        max_uses: i18next.t('rider:ride.promo_error_max_uses', { defaultValue: 'Código agotado' }),
        already_used: i18next.t('rider:ride.promo_error_already_used', { defaultValue: 'Ya usaste este código' }),
        first_ride_only: i18next.t('rider:ride.promo_error_first_ride', { defaultValue: 'Solo válido para tu primer viaje' }),
      };
      setPromoResult({
        valid: result.valid,
        discountAmount: result.discountAmount,
        promotionId: result.promotion?.id,
        error: result.error ? (errorMsgs[result.error] ?? i18next.t('rider:ride.promo_invalid')) : undefined,
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
    // Mensajería (cargo): el precio = el del VEHÍCULO elegido, no el config plano.
    // El ride se despacha a ese vehículo (effectiveServiceType) y la tarifa
    // persistida/cobrada sale de su estimado (ya en allFareEstimates). Alinea con
    // la web (apps/web book/page: isMensajeria ? allEstimates[vehicle] : ...).
    const effectiveServiceType =
      d.serviceType === 'mensajeria' && d.delivery.deliveryVehicleType
        ? deliveryVehicleToSlug(d.delivery.deliveryVehicleType)
        : d.serviceType;
    const selectedFare = allFareEstimates?.[effectiveServiceType] ?? fareEstimate;
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
    if (d.paymentMethod === 'tricicoin' && selectedFare) {
      try {
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          const bal = await walletService.getBalance(userId);
          // Bug 26: Add 20% buffer to account for surge pricing changes since estimate
          if (bal.available < (selectedFare.estimated_fare_trc ?? 0) * 1.2) {
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
        // AUD-013 / BUG-073: monthly_budget_trc = 0 means UNLIMITED — the server trigger
        // (tg_rides_validate_corporate) only enforces budget when > 0, and web book/page.tsx
        // already guards with the same > 0 check. Without it, a default (0) budget computes a
        // negative remaining and blocks every corporate ride client-side.
        const monthlyBudget = freshAccount?.monthly_budget_trc ?? 0;
        if (monthlyBudget > 0) {
          const remainingBudget = monthlyBudget - (freshAccount?.current_month_spent ?? 0);
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
      // effectiveServiceType ya se computó arriba (junto a selectedFare) para que
      // mensajería persista/cobre la tarifa del vehículo elegido.
      // isDelivery must depend ONLY on serviceType. Since #419 the draft's
      // deliveryVehicleType defaults to 'moto' (always truthy), so a passenger
      // trip would otherwise be created as cargo. Mirrors apps/web book/page.tsx.
      const isDelivery = d.serviceType === 'mensajeria';

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
        // BUG-fare-audit B1/L2: pasar el breakdown del estimate snapshot a
        // createRide para que el RPC use los mismos rates al cobrar
        // (parity surge + pricing_rule_id + per_km/per_min). Si selectedFare
        // está incompleto, el RPC cae al fallback service_type_configs.
        base_fare_cup: selectedFare?.base_fare_cup,
        per_km_rate_cup: selectedFare?.per_km_rate_cup,
        per_minute_rate_cup: selectedFare?.per_minute_rate_cup,
        // BUG-fare-audit-followup Cambio 3: snapshotear min_fare para que
        // el RPC use el floor del estimate cuando aplica (pricing rule con
        // min_fare > service default).
        min_fare_cup: selectedFare?.min_fare_cup,
        surge_multiplier: selectedFare?.surge_multiplier,
        pricing_rule_id: selectedFare?.pricing_rule_id || undefined,
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
        // "Compartir viaje" — only for the tricycle. The server trigger
        // (00347) computes the discount; declared_passengers = seats the
        // rider occupies.
        share_ride: d.serviceType === 'triciclo_basico' ? d.shareRide : false,
        declared_passengers: d.shareRide && d.serviceType === 'triciclo_basico' ? d.passengerCount : undefined,
        // Mixed payment: forward the rider's wallet/cash split. Without this
        // the ride is stored with wallet_ratio=0 (server default) → the
        // wallet portion is 0, complete_ride_and_pay charges everything as
        // cash and never debits the rider wallet → the split is invisible in
        // both movements and the completed screen. Only send for 'mixed';
        // other methods ignore wallet_ratio server-side.
        wallet_ratio: d.paymentMethod === 'mixed' ? d.walletRatio : undefined,
      });

      // Bug 30: Save delivery details as blocking step — cancel ride if it fails.
      // Gate ONLY on serviceType (see isDelivery note above): deliveryVehicleType
      // is always truthy since #419, so passenger trips must not create details.
      if (d.serviceType === 'mensajeria') {
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
          // Cancel the orphaned ride so it doesn't exist without delivery metadata.
          // reason is the 3rd arg (cancelRide(rideId, _userId?, reason?)) — passing
          // it 2nd dropped it into the ignored userId slot (p_reason=null).
          let cancelOk = true;
          try {
            await rideService.cancelRide(ride.id, undefined, 'delivery_details_failed');
          } catch (cancelErr) {
            cancelOk = false;
            logger.error('Failed to cancel ride after delivery details error', { error: String(cancelErr) });
          }
          isSubmittingRef.current = false;
          pendingRequestIdRef.current = null;
          Toast.show({
            type: 'error',
            text1: i18next.t('rider:ride.delivery_details_failed_title', { defaultValue: 'Error al crear envío' }),
            // If BOTH the details save AND the cancel failed, a cargo ride may still
            // be live with no package info — tell the rider to check & cancel it.
            text2: cancelOk
              ? i18next.t('rider:ride.delivery_details_failed_msg', { defaultValue: 'No se pudieron guardar los detalles del envío. Intenta de nuevo.' })
              : i18next.t('rider:ride.delivery_orphan_check_rides', { defaultValue: 'No se pudo guardar el envío ni cancelar el viaje. Revisa "Mis viajes" y cancela el viaje si sigue activo.' }),
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
      // PR G — emit [MAP:ride] for correlation with map/route logs
      mapLogger.tripLifecycle({
        event: 'request',
        ride_id: ride.id,
        lat: d.pickup.location.latitude,
        lng: d.pickup.location.longitude,
        app: 'client',
      });

      // Search timeout — retry with "expanding search" before cancelling
      searchRetryCountRef.current = 0;
      searchStartTimeRef.current = Date.now();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      // Persistent search — the loop reschedules itself indefinitely
      // while flowStep === 'searching'. The search is NEVER auto-canceled:
      // for the first rounds it nudges an immediate re-dispatch with a
      // wider radius + reassures the rider; after that the server keeps
      // working on its own (retry cron every minute + the driver-online
      // trigger). The rider cancels manually if they no longer want it.
      const scheduleSearchTimeout = () => {
        timeoutRef.current = setTimeout(async () => {
          const { flowStep, activeRide: ar } = useRideStore.getState();
          if (flowStep !== 'searching' || !ar) return; // search ended → stop loop

          // Ride was accepted during the search → move to the active flow.
          if (ar.status !== 'searching') {
            useRideStore.getState().setFlowStep('active');
            return;
          }

          searchRetryCountRef.current += 1;

          // First rounds: reassure the rider. The server re-dispatches on its
          // own with a widening radius (retry_dispatch_expired_rides cron +
          // notify_driver_new_offer push). The old client-side retryMatchDrivers
          // only pushed to a findBestDrivers set that often had no ride_offer —
          // misleading and redundant, removed (ride-flow audit #18).
          if (searchRetryCountRef.current <= RIDE_CONFIG.SEARCH_RETRY_ROUNDS) {
            Toast.show({
              type: 'info',
              text1: i18next.t('rider:ride.expanding_search', {
                defaultValue: 'Ampliando la busqueda de conductores...',
              }),
              visibilityTime: 3000,
            });
          }

          // Keep searching — the loop never cancels the ride.
          scheduleSearchTimeout();
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
      } else if (errMsg.includes('ride_rate_limited')) {
        // F1 (00368): server-side throttle on ride creation. Friendly,
        // non-destructive — keep the user on 'selecting' so they can retry
        // in a moment without losing their pickup/dropoff.
        setFlowStep('selecting');
        Toast.show({
          type: 'info',
          text1: i18next.t('rider:ride.rate_limited_title', { defaultValue: 'Espera un momento' }),
          text2: i18next.t('rider:ride.rate_limited_msg', {
            defaultValue: 'Estás pidiendo viajes muy seguido. Prueba de nuevo en unos segundos.',
          }),
          visibilityTime: 5000,
        });
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
  }, [setActiveRide, setFlowStep, setLoading, setError, user?.id]);

  const cancelRide = useCallback(async (reason?: string) => {
    // QA 2026-05-13: ride got auto-canceled at insert — trace the caller.
    // eslint-disable-next-line no-console
    console.log('[QA-DEBUG cancelRide] CALLED', { reason, stack: new Error().stack?.split('\n').slice(1, 8).join('\n') });
    const { activeRide } = useRideStore.getState();
    if (!activeRide) return;

    setLoading(true);
    // Mute the watcher's "your trip was canceled" announcement for the next
    // few seconds — the rider asked for this one, and cancelRide reports the
    // outcome itself below. The watcher polls every 3s and would otherwise
    // race us to the news.
    muteCancelAnnouncementFor(15_000);
    try {
      const result = await rideService.cancelRide(activeRide.id, user?.id, reason);
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const impact = result?.ratingImpact;
      trackEvent('ride_canceled', {
        ride_id: activeRide.id,
        reason,
        rating_penalized: impact?.rating_penalized ?? false,
        stars_after: impact?.stars_after ?? null,
      });
      resetAll();

      // Cancelling no longer charges money — inform the rider about the
      // reputation impact instead (only when their rating actually moved).
      if (impact?.rating_penalized) {
        Toast.show({
          type: 'info',
          text1: i18next.t('rider:ride.cancel_title'),
          text2: typeof impact.stars_after === 'number'
            ? i18next.t('rider:ride.cancel_rating_dropped_to', {
                stars: impact.stars_after.toFixed(1),
                defaultValue: `Tu calificación bajó a ★${impact.stars_after.toFixed(1)}.`,
              })
            : i18next.t('rider:ride.cancel_rating_dropped', {
                defaultValue: 'Tu calificación bajó por cancelar tarde.',
              }),
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
