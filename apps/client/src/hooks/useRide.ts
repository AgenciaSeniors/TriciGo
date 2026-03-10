import { useEffect, useRef, useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { rideService } from '@tricigo/api';
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
      setError(err instanceof Error ? err.message : 'Error al estimar tarifa');
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
    } catch {
      setPromoResult({ valid: false, discountAmount: 0, error: 'Error al validar código' });
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
      });

      setActiveRide(ride);
      setFlowStep('searching');

      // Subscribe to ride updates
      channelRef.current?.unsubscribe();
      channelRef.current = rideService.subscribeToRide(ride.id, async (updated) => {
        const store = useRideStore.getState();
        store.updateRideFromRealtime(updated);

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
          setError('No se encontró conductor. Intenta de nuevo.');
        }
      }, SEARCH_TIMEOUT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear viaje');
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
      resetAll();

      // Show penalty info if applicable
      if (penalty && penalty.penaltyAmount > 0) {
        const amount = (penalty.penaltyAmount / 100).toFixed(0);
        Alert.alert(
          'Cancelación',
          penalty.isBlocked
            ? `Se aplicó una penalización de ${amount} CUP. Has sido bloqueado temporalmente por cancelaciones excesivas.`
            : `Se aplicó una penalización de ${amount} CUP por cancelación.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cancelar');
    } finally {
      setLoading(false);
    }
  }, [user, setLoading, setError, resetAll]);

  return { requestEstimate, confirmRide, cancelRide, validatePromo, validatingPromo };
}
