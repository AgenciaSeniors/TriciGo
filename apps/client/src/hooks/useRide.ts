import { useEffect, useRef, useCallback, useState } from 'react';
import { Alert } from 'react-native';
import i18next from 'i18next';
import Toast from 'react-native-toast-message';
import { rideService, deliveryService } from '@tricigo/api';
import { triggerHaptic, trackEvent, playSound } from '@tricigo/utils';
import { recentAddressService } from '@/services/recentAddresses';
import { invalidatePredictionCache } from '@/services/predictionCache';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import type { RealtimeChannel } from '@supabase/supabase-js';

const SEARCH_TIMEOUT_MS = 120_000; // 2 minutes

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
      } catch {
        // Silently fail — no active ride
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
    setError,
    setPromoResult,
    resetAll,
  } = useRideStore();
  const [validatingPromo, setValidatingPromo] = useState(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      channelRef.current?.unsubscribe();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const requestEstimate = useCallback(async () => {
    if (!draft.pickup || !draft.dropoff) return;

    setLoading(true);
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
      setError(err instanceof Error ? err.message : i18next.t('rider:common.error'));
    } finally {
      setLoading(false);
    }
  }, [draft, setFareEstimate, setFlowStep, setLoading, setError]);

  const validatePromo = useCallback(async () => {
    const { promoCode, fareEstimate: fe } = useRideStore.getState();
    if (!promoCode.trim() || !user) return;

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
      setValidatingPromo(false);
    }
  }, [user, setPromoResult]);

  const confirmRide = useCallback(async () => {
    const { draft: d, fareEstimate, promoResult } = useRideStore.getState();
    if (!d.pickup || !d.dropoff) return;

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
        } catch {
          // Best effort — ride is already created
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
        const store = useRideStore.getState();
        store.updateRideFromRealtime(updated);

        // Haptic + sound feedback on key status changes
        if (updated.status === 'accepted') {
          triggerHaptic('success');
          playSound('ride_accepted');
        }
        if (updated.status === 'arrived_at_pickup') {
          triggerHaptic('medium');
          playSound('driver_arrived');
        }
        if (updated.status === 'completed') {
          triggerHaptic('success');
          playSound('trip_completed');
          trackEvent('ride_completed', { ride_id: updated.id, service_type: updated.service_type });
          // Invalidate prediction cache so next load recalculates with new ride
          invalidatePredictionCache().catch(() => {});
        }

        // TropiPay payment confirmed via Realtime
        const prev = useRideStore.getState().activeRide;
        if (
          prev?.payment_status === 'pending' &&
          (updated as any).payment_status === 'paid'
        ) {
          triggerHaptic('success');
          Toast.show({
            type: 'success',
            text1: i18next.t('rider:payment.confirmed', { defaultValue: 'Pago confirmado' }),
          });
          trackEvent('ride_tropipay_paid', { ride_id: updated.id });
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
          try {
            await rideService.cancelRide(ar.id, user?.id, 'search_timeout');
          } catch {
            // Best effort
          }
          channelRef.current?.unsubscribe();
          channelRef.current = null;
          resetAll();
          setError(i18next.t('rider:ride.no_driver_found'));
        }
      }, SEARCH_TIMEOUT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18next.t('rider:common.error'));
      setFlowStep('reviewing');
    } finally {
      setLoading(false);
    }
  }, [setActiveRide, setFlowStep, setLoading, setError]);

  const cancelRide = useCallback(async (reason?: string) => {
    const { activeRide } = useRideStore.getState();
    if (!activeRide) return;

    setLoading(true);
    try {
      const penalty = await rideService.cancelRide(activeRide.id, user?.id, reason);
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      trackEvent('ride_canceled', { ride_id: activeRide.id, reason });
      resetAll();

      // Show penalty info if applicable
      if (penalty && penalty.penaltyAmount > 0) {
        const amount = (penalty.penaltyAmount / 100).toFixed(0);
        Alert.alert(
          i18next.t('rider:ride.cancel_title'),
          penalty.isBlocked
            ? `${i18next.t('rider:ride.cancel_penalty_applied', { amount })} ${i18next.t('rider:ride.cancel_blocked')}`
            : i18next.t('rider:ride.cancel_penalty_applied', { amount }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : i18next.t('rider:common.error'));
    } finally {
      setLoading(false);
    }
  }, [user, setLoading, setError, resetAll]);

  return { requestEstimate, confirmRide, cancelRide, validatePromo, validatingPromo };
}
