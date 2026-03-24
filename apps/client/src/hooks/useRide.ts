import { useEffect, useRef, useCallback, useState } from 'react';

import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import { rideService, deliveryService, trustedContactService, notificationService } from '@tricigo/api';
import { triggerHaptic, trackEvent, playSound, getErrorMessage, logger } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { recentAddressService } from '@/services/recentAddresses';
import { invalidatePredictionCache } from '@/services/predictionCache';
import { scheduleLocalNotification } from '@/services/push.service';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import type { RealtimeChannel } from '@supabase/supabase-js';

const SEARCH_TIMEOUT_MS = RIDE_CONFIG.SEARCH_TIMEOUT_MS;

/**
 * Initialize ride state on app mount.
 * Checks for an active ride and restores flow state.
 */
export function useRideInit() {
  const user = useAuthStore((s) => s.user);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const { setActiveRide, setRideWithDriver, setFlowStep } = useRideStore();
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    if (!isInitialized || !user) return;

    let mounted = true;

    async function checkActive() {
      try {
        const active = await rideService.getActiveRide(user!.id);
        if (!active || !mounted) return;

        setActiveRide(active);

        if (active.status === 'searching') {
          setFlowStep('searching');
        } else {
          setFlowStep('active');
        }

        // Subscribe to updates
        channelRef.current?.unsubscribe();
        channelRef.current = rideService.subscribeToRide(active.id, (ride) => {
          useRideStore.getState().updateRideFromRealtime(ride);
        });

        // Load driver info if assigned
        if (active.driver_id) {
          const rwd = await rideService.getRideWithDriver(active.id);
          if (mounted && rwd) setRideWithDriver(rwd);
        }
      } catch (err) {
        logger.warn('No active ride or failed to check', { error: String(err) });
      }
    }

    checkActive();

    return () => {
      mounted = false;
      channelRef.current?.unsubscribe();
    };
  }, [isInitialized, user, setActiveRide, setRideWithDriver, setFlowStep]);
}

/**
 * Ride actions for the customer flow.
 */
export function useRideActions() {
  const user = useAuthStore((s) => s.user);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Bug 8: Validate pickup ≠ dropoff (min 200m)
    const { haversineDistance } = await import('@tricigo/utils');
    const dist = haversineDistance(draft.pickup.location, draft.dropoff.location);
    if (dist < RIDE_CONFIG.MIN_DISTANCE_M) {
      Toast.show({
        type: 'info',
        text1: i18next.t('rider:ride.too_close_title', { defaultValue: 'Destino muy cercano' }),
        text2: i18next.t('rider:ride.too_close_msg', { defaultValue: 'El destino está a menos de 200m del punto de recogida. Selecciona un destino más lejano.' }),
      });
      return;
    }

    setFareEstimating(true);
    setError(null);
    try {
      const estimate = await rideService.getLocalFareEstimate({
        service_type: draft.serviceType,
        pickup_lat: draft.pickup.location.latitude,
        pickup_lng: draft.pickup.location.longitude,
        dropoff_lat: draft.dropoff.location.latitude,
        dropoff_lng: draft.dropoff.location.longitude,
      });
      setFareEstimate(estimate);
      setFlowStep('reviewing');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setFareEstimating(false);
    }
  }, [draft, setFareEstimate, setFlowStep, setFareEstimating, setError]);

  const validatePromo = useCallback(async () => {
    const { promoCode, fareEstimate: fe } = useRideStore.getState();
    if (!promoCode.trim() || !user || validatingPromoRef.current) return;

    validatingPromoRef.current = true;
    setValidatingPromo(true);
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
      validatingPromoRef.current = false;
      setValidatingPromo(false);
    }
  }, [user, setPromoResult]);

  // Synchronous flag to prevent double-submission (state updates are async)
  const isSubmittingRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);

  const confirmRide = useCallback(async () => {
    if (isSubmittingRef.current) return; // Block double-tap
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

    const { draft: d, fareEstimate, promoResult, validatingPromo } = useRideStore.getState();
    if (!d.pickup || !d.dropoff) { isSubmittingRef.current = false; pendingRequestIdRef.current = null; return; }

    // Bug 12: Block confirm while promo is validating
    if (validatingPromo) {
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
      Toast.show({ type: 'info', text1: i18next.t('rider:ride.wait_promo', { defaultValue: 'Espera, validando código...' }) });
      return;
    }

    // Bug 9: Validate TRC balance before booking
    if (d.paymentMethod === 'tricicoin' && fareEstimate) {
      try {
        const { walletService } = await import('@tricigo/api');
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          const bal = await walletService.getBalance(userId);
          if (bal.available < (fareEstimate.estimated_fare_trc ?? 0)) {
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

    setLoading(true);
    setError(null);
    try {
      const ride = await rideService.createRide({
        service_type: d.serviceType,
        payment_method: d.paymentMethod,
        pickup_latitude: d.pickup.location.latitude,
        pickup_longitude: d.pickup.location.longitude,
        pickup_address: d.pickup.address,
        dropoff_latitude: d.dropoff.location.latitude,
        dropoff_longitude: d.dropoff.location.longitude,
        dropoff_address: d.dropoff.address,
        estimated_fare_cup: fareEstimate?.estimated_fare_cup,
        estimated_distance_m: fareEstimate?.estimated_distance_m,
        estimated_duration_s: fareEstimate?.estimated_duration_s,
        promo_code_id: promoResult?.valid ? promoResult.promotionId : undefined,
        discount_amount_cup: promoResult?.valid ? promoResult.discountAmount : undefined,
        scheduled_at: d.scheduledAt ? d.scheduledAt.toISOString() : undefined,
        waypoints: d.waypoints.length > 0
          ? d.waypoints.map((wp, i) => ({
              sort_order: i + 1,
              latitude: wp.location.latitude,
              longitude: wp.location.longitude,
              address: wp.address,
            }))
          : undefined,
        corporate_account_id: d.corporateAccountId ?? undefined,
        insurance_selected: d.insuranceSelected,
        insurance_premium_cup: d.insuranceSelected ? (fareEstimate?.insurance_premium_cup ?? 0) : 0,
        rider_preferences: Object.keys(d.ridePreferences).length > 0 ? d.ridePreferences : undefined,
      });

      // Save delivery details if mensajeria
      if (d.serviceType === 'mensajeria' && d.delivery.packageDescription.trim()) {
        try {
          await deliveryService.createDeliveryDetails({
            ride_id: ride.id,
            package_description: d.delivery.packageDescription,
            recipient_name: d.delivery.recipientName,
            recipient_phone: d.delivery.recipientPhone,
            estimated_weight_kg: d.delivery.estimatedWeightKg
              ? parseFloat(d.delivery.estimatedWeightKg)
              : undefined,
            special_instructions: d.delivery.specialInstructions || undefined,
          });
        } catch (err) {
          logger.error('Delivery notification failed', { error: String(err) });
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

      // Subscribe to ride updates
      channelRef.current?.unsubscribe();
      channelRef.current = rideService.subscribeToRide(ride.id, async (updated) => {
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
          triggerHaptic('heavy');
          playSound('driver_arrived');
          scheduleLocalNotification(
            i18next.t('ride.driver_arrived_banner', { ns: 'rider' }),
            '',
          );
        }
        if (updated.status === 'in_progress' && prevRide?.status === 'arrived_at_pickup') {
          triggerHaptic('medium');
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

        // TropiPay payment confirmed via Realtime (use prevRide captured before update)
        if (
          prevRide?.payment_status === 'pending' &&
          (updated as any).payment_status === 'paid'
        ) {
          triggerHaptic('success');
          Toast.show({
            type: 'success',
            text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
          });
          trackEvent('ride_tropipay_paid', { ride_id: updated.id });
        }

        // Bug 10: Show alert when driver cancels the ride
        if (updated.status === 'canceled' && prevRide?.status !== 'canceled') {
          triggerHaptic('error');
          Toast.show({
            type: 'error',
            text1: i18next.t('rider:ride.driver_canceled_title', { defaultValue: 'Viaje cancelado' }),
            text2: i18next.t('rider:ride.driver_canceled_msg', { defaultValue: 'El conductor canceló el viaje. Puedes buscar otro conductor.' }),
          });
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
      });

      // Search timeout — actually cancel the ride
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(async () => {
        const { flowStep, activeRide: ar } = useRideStore.getState();
        if (flowStep === 'searching' && ar) {
          // X1.2: Check if ride was accepted during search before resetting
          const currentRide = useRideStore.getState().activeRide;
          if (currentRide && currentRide.status !== 'searching') {
            // Ride was accepted during search — don't reset!
            useRideStore.getState().setFlowStep('active');
            return;
          }

          try {
            await rideService.cancelRide(ar.id, user?.id, 'search_timeout');
          } catch {
            // Best effort
          }
          channelRef.current?.unsubscribe();
          channelRef.current = null;
          const noDriverMsg = i18next.t('rider:ride.no_driver_found');
          resetAll();
          // Show Toast instead of state error (resetAll sets flowStep to 'idle'
          // where state error is not visible)
          Toast.show({
            type: 'error',
            text1: noDriverMsg,
          });
        }
      }, SEARCH_TIMEOUT_MS);
    } catch (err) {
      setError(getErrorMessage(err));
      setFlowStep('reviewing');
    } finally {
      setLoading(false);
      isSubmittingRef.current = false;
      pendingRequestIdRef.current = null;
    }
  }, [setActiveRide, setFlowStep, setLoading, setError]);

  const cancelRide = useCallback(async (reason?: string) => {
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
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [user, setLoading, setError, resetAll]);

  return { requestEstimate, confirmRide, cancelRide, validatePromo, validatingPromo };
}
