/**
 * Rider trip-feedback effects: haptics, sounds, toasts, local notifications
 * and analytics for one ride status transition.
 *
 * Extracted from useRide.ts so this logic is reachable by tests: apps/client
 * has no React renderer, so anything that only exists inside a hook body is
 * untestable. These are plain functions on purpose.
 */
import i18next from 'i18next';
import * as Notifications from 'expo-notifications';
import Toast from 'react-native-toast-message';
import { rideService } from '@tricigo/api';
import { triggerHaptic, trackEvent, playSound } from '@tricigo/utils';
import { invalidatePredictionCache } from '@/services/predictionCache';
import { scheduleLocalNotification } from '@/services/push.service';
import { useRideStore } from '@/stores/ride.store';
import type { Ride } from '@tricigo/types';


/**
 * Set while the rider's OWN cancel is in flight, so the watcher below does
 * not also announce the cancellation the rider just asked for. Expires on
 * its own — never cleared — so a failed cancel can't wedge it permanently.
 */
let riderCancelInFlightUntil = 0;

/** Mute the watcher's cancellation announcement for the next `ms`. */
export function muteCancelAnnouncementFor(ms: number): void {
  riderCancelInFlightUntil = Date.now() + ms;
}

/** True while the rider's own cancel is still in flight. */
export function isRiderCancelInFlight(now: number = Date.now()): boolean {
  return now < riderCancelInFlightUntil;
}

/**
 * The rider's in-app trip feedback for one status transition: haptics,
 * sounds, toasts, local notifications and analytics.
 *
 * There used to be TWO copies of this, and NEITHER could ever run:
 *   - one inside the 3s interval `confirmRide` starts, stored on a ref owned
 *     by ReviewingView/SelectingView — and `confirmRide` itself unmounts
 *     those via `setFlowStep('searching')`, so their cleanup cleared the
 *     interval before its first tick;
 *   - one inside the `subscribeToRide` callback, which has been a documented
 *     no-op since BUG-277 (realtime was removed to free OkHttp sockets).
 *
 * So the passenger got NO in-app feedback for the entire trip — no "driver
 * assigned" sound, no arrival buzz, no payment toast — only the server push
 * from `trg_push_ride_status`. Both dead copies are gone; this is the single
 * live one, driven by useRideInit's 3s watcher. Keep it that way: a second
 * caller means every rider gets every toast twice.
 */
export function fireRideStatusEffects(prevStatus: string | null | undefined, ride: Ride): void {
  const status = ride.status;

  if (status === 'accepted') {
    triggerHaptic('success');
    playSound('ride_accepted');
    Toast.show({ type: 'success', text1: i18next.t('ride.driver_assigned', { ns: 'rider' }) });
    scheduleLocalNotification(
      i18next.t('ride.driver_assigned', { ns: 'rider' }),
      i18next.t('ride.driver_assigned_body', { ns: 'rider' }),
    );
    // Pull the driver's details so the active-trip card can render name,
    // photo, plate and rating instead of an empty shell.
    if (ride.driver_id) {
      rideService.getRideWithDriver(ride.id).then((rwd) => {
        if (rwd) useRideStore.getState().setRideWithDriver(rwd);
      }).catch(() => { /* retried on the next watcher tick */ });
    }
  }

  if (status === 'driver_en_route' && prevStatus === 'accepted') {
    triggerHaptic('light');
  }

  if (status === 'arrived_at_pickup') {
    triggerHaptic('success');
    setTimeout(() => triggerHaptic('medium'), 300);
    setTimeout(() => triggerHaptic('light'), 600);
    playSound('driver_arrived');
    scheduleLocalNotification(i18next.t('ride.driver_arrived_banner', { ns: 'rider' }), '');
  }

  if (status === 'in_progress' && prevStatus === 'arrived_at_pickup') {
    triggerHaptic('medium');
    playSound('ride_accepted');
    scheduleLocalNotification(
      i18next.t('ride.trip_started_notif', { ns: 'rider' }),
      i18next.t('ride.trip_started_body', { ns: 'rider' }),
    );
  }

  if (status === 'arrived_at_destination') {
    triggerHaptic('success');
    playSound('destination_arrived');
    scheduleLocalNotification(
      i18next.t('ride.arrived_at_destination_title', { ns: 'rider' }),
      i18next.t('ride.arrived_at_destination_body', { ns: 'rider' }),
    );
  }

  if (status === 'completed') {
    triggerHaptic('success');
    playSound('trip_completed');
    trackEvent('ride_completed', { ride_id: ride.id, service_type: ride.service_type });
    scheduleLocalNotification(i18next.t('ride.trip_completed_notif', { ns: 'rider' }), '');
    invalidatePredictionCache().catch(() => {});

    const fare = ride.final_fare_cup ?? ride.final_fare_trc;
    if (fare && fare > 0) {
      const methodKey = `ride.payment_method_${ride.payment_method ?? 'cash'}`;
      Toast.show({
        type: 'success',
        text1: i18next.t('ride.payment_confirmed_title', { ns: 'rider' }),
        text2: i18next.t('ride.payment_confirmed_body', {
          ns: 'rider',
          amount: fare,
          method: i18next.t(methodKey, { ns: 'rider', defaultValue: ride.payment_method ?? 'cash' }),
        }),
        visibilityTime: 5000,
      });
    }

    // Rating reminder 5 min out. resetAll() cancels it if the rider rates first.
    Notifications.scheduleNotificationAsync({
      content: {
        title: i18next.t('ride.rate_reminder_title', { ns: 'rider' }),
        body: i18next.t('ride.rate_reminder_body', { ns: 'rider' }),
        data: { type: 'ride', ride_id: ride.id, action: 'rate' },
      },
      trigger: { seconds: 300, type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL },
    }).then((reminderId) => {
      useRideStore.getState().setRatingReminderId(reminderId);
    }).catch(() => {});
  }

  if (status === 'canceled') {
    // The rider's own cancel already reports itself (rating impact toast in
    // cancelRide) — don't tell them their trip "was canceled" twice.
    if (isRiderCancelInFlight()) return;

    triggerHaptic('error');

    if (ride.cancellation_reason === 'searching_abandoned') {
      // `cleanup_orphan_searching_rides` reaped the search server-side. This
      // used to clear the screen in complete silence, which is exactly what
      // made riders think the app had swallowed their trip — and then their
      // next tap on "Cancelar" hit `ride_already_closed`.
      Toast.show({
        type: 'info',
        text1: i18next.t('rider:ride.search_expired_title', { defaultValue: 'No encontramos conductor' }),
        text2: i18next.t('rider:ride.search_expired_msg', { defaultValue: 'Nadie tomó tu viaje esta vez. Puedes pedirlo de nuevo.' }),
        visibilityTime: 6000,
      });
      scheduleLocalNotification(
        i18next.t('rider:ride.search_expired_title', { defaultValue: 'No encontramos conductor' }),
        i18next.t('rider:ride.search_expired_msg', { defaultValue: 'Nadie tomó tu viaje esta vez. Puedes pedirlo de nuevo.' }),
      );
      return;
    }

    if (prevStatus === 'in_progress') {
      Toast.show({
        type: 'error',
        text1: i18next.t('rider:ride.trip_interrupted_title', { defaultValue: 'Viaje interrumpido' }),
        text2: i18next.t('rider:ride.trip_interrupted_msg', { defaultValue: 'El viaje fue interrumpido. Contacta a soporte si necesitas ayuda.' }),
      });
    } else if (!ride.driver_id) {
      // No driver was ever assigned, so blaming one would be a lie. This is
      // the admin/dispatcher cancel path. Now that these toasts actually
      // fire, a wrong attribution would reach real riders.
      Toast.show({
        type: 'error',
        text1: i18next.t('rider:ride.driver_canceled_title', { defaultValue: 'Viaje cancelado' }),
        text2: i18next.t('rider:ride.canceled_generic_msg', { defaultValue: 'Tu viaje fue cancelado. Puedes pedir otro cuando quieras.' }),
      });
    } else {
      Toast.show({
        type: 'error',
        text1: i18next.t('rider:ride.driver_canceled_title', { defaultValue: 'Viaje cancelado' }),
        text2: i18next.t('rider:ride.driver_canceled_msg', { defaultValue: 'El conductor canceló el viaje. Puedes buscar otro conductor.' }),
      });
    }
    scheduleLocalNotification(i18next.t('ride.driver_canceled_notif', { ns: 'rider' }), '');
  }
}
