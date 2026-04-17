import { useEffect, useRef, useState, useCallback } from 'react';
import { triggerHaptic, playSound } from '@tricigo/utils';
import { scheduleLocalNotification } from '@/services/push.service';
import i18next from 'i18next';

interface UseProximityAlertParams {
  /** Current ride ID — resets dedup refs when it changes */
  rideId: string | null;
  /** Current ride status */
  rideStatus: string | null;
  /** Real-time ETA in minutes (from useETA or Mapbox route) */
  etaMinutes: number | null;
  /** Driver name for notification body */
  driverName: string | null;
}

interface ProximityAlertState {
  showPickupBanner: boolean;
  showDropoffBanner: boolean;
  dismissPickupBanner: () => void;
  dismissDropoffBanner: () => void;
}

const PROXIMITY_ETA_THRESHOLD = 2; // minutes
const BANNER_AUTO_DISMISS_MS = 15_000;

/**
 * Client-side proximity detection hook.
 * Watches ETA and triggers local notification + haptic + in-app banner
 * when driver is within ~2 minutes of pickup or destination.
 *
 * Works alongside the server-side DB trigger (check_proximity_notification)
 * which sends push notifications. The server covers background cases;
 * this hook provides immediate in-app feedback.
 */
export function useProximityAlert({
  rideId,
  rideStatus,
  etaMinutes,
  driverName,
}: UseProximityAlertParams): ProximityAlertState {
  const [showPickupBanner, setShowPickupBanner] = useState(false);
  const [showDropoffBanner, setShowDropoffBanner] = useState(false);

  const pickupNotifiedRef = useRef(false);
  const dropoffNotifiedRef = useRef(false);
  const pickupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset dedup refs when ride changes
  useEffect(() => {
    pickupNotifiedRef.current = false;
    dropoffNotifiedRef.current = false;
    setShowPickupBanner(false);
    setShowDropoffBanner(false);
    if (pickupTimerRef.current) clearTimeout(pickupTimerRef.current);
    if (dropoffTimerRef.current) clearTimeout(dropoffTimerRef.current);
  }, [rideId]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pickupTimerRef.current) clearTimeout(pickupTimerRef.current);
      if (dropoffTimerRef.current) clearTimeout(dropoffTimerRef.current);
    };
  }, []);

  // Watch ETA for proximity triggers
  useEffect(() => {
    if (etaMinutes === null || etaMinutes <= 0 || !rideId) return;

    // ─── Pickup proximity: driver approaching passenger ───
    if (
      (rideStatus === 'accepted' || rideStatus === 'driver_en_route') &&
      etaMinutes <= PROXIMITY_ETA_THRESHOLD &&
      !pickupNotifiedRef.current
    ) {
      pickupNotifiedRef.current = true;
      triggerHaptic('medium');
      playSound('driver_arrived');
      scheduleLocalNotification(
        i18next.t('ride.driver_approaching_title', { ns: 'rider' }),
        i18next.t('ride.driver_approaching_body', { ns: 'rider', name: driverName ?? '' }),
      );
      setShowPickupBanner(true);

      // Auto-dismiss banner
      pickupTimerRef.current = setTimeout(() => {
        setShowPickupBanner(false);
      }, BANNER_AUTO_DISMISS_MS);
    }

    // ─── Dropoff proximity: approaching destination ───
    if (
      rideStatus === 'in_progress' &&
      etaMinutes <= PROXIMITY_ETA_THRESHOLD &&
      !dropoffNotifiedRef.current
    ) {
      dropoffNotifiedRef.current = true;
      triggerHaptic('medium');
      scheduleLocalNotification(
        i18next.t('ride.approaching_destination_title', { ns: 'rider' }),
        i18next.t('ride.approaching_destination_body', { ns: 'rider' }),
      );
      setShowDropoffBanner(true);

      // Auto-dismiss banner
      dropoffTimerRef.current = setTimeout(() => {
        setShowDropoffBanner(false);
      }, BANNER_AUTO_DISMISS_MS);
    }
  }, [etaMinutes, rideStatus, rideId, driverName]);

  const dismissPickupBanner = useCallback(() => {
    setShowPickupBanner(false);
    if (pickupTimerRef.current) {
      clearTimeout(pickupTimerRef.current);
      pickupTimerRef.current = null;
    }
  }, []);

  const dismissDropoffBanner = useCallback(() => {
    setShowDropoffBanner(false);
    if (dropoffTimerRef.current) {
      clearTimeout(dropoffTimerRef.current);
      dropoffTimerRef.current = null;
    }
  }, []);

  return {
    showPickupBanner,
    showDropoffBanner,
    dismissPickupBanner,
    dismissDropoffBanner,
  };
}
