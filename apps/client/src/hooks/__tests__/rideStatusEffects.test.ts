import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every native/module dependency is mocked with a factory so the real React
// Native runtime is never loaded — mirrors apps/driver/src/hooks/__tests__.

// `t` returns the key so assertions read as "which message did the rider get".
vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

const scheduleNotificationAsync = vi.fn(async () => 'reminder-id');
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...a: unknown[]) => scheduleNotificationAsync(...(a as [])),
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

const toastShow = vi.fn();
vi.mock('react-native-toast-message', () => ({
  default: { show: (...a: unknown[]) => toastShow(...(a as [])) },
}));

const getRideWithDriver = vi.fn(async () => null);
vi.mock('@tricigo/api', () => ({
  rideService: {
    getRideWithDriver: (...a: unknown[]) => getRideWithDriver(...(a as [])),
  },
}));

const triggerHaptic = vi.fn();
const trackEvent = vi.fn();
const playSound = vi.fn();
vi.mock('@tricigo/utils', () => ({
  triggerHaptic: (...a: unknown[]) => triggerHaptic(...(a as [])),
  trackEvent: (...a: unknown[]) => trackEvent(...(a as [])),
  playSound: (...a: unknown[]) => playSound(...(a as [])),
}));

const invalidatePredictionCache = vi.fn(async () => undefined);
vi.mock('@/services/predictionCache', () => ({
  invalidatePredictionCache: () => invalidatePredictionCache(),
}));

const scheduleLocalNotification = vi.fn();
vi.mock('@/services/push.service', () => ({
  scheduleLocalNotification: (...a: unknown[]) => scheduleLocalNotification(...(a as [])),
}));

const setRideWithDriver = vi.fn();
const setRatingReminderId = vi.fn();
vi.mock('@/stores/ride.store', () => ({
  useRideStore: {
    getState: () => ({ setRideWithDriver, setRatingReminderId }),
  },
}));

import { fireRideStatusEffects, muteCancelAnnouncementFor } from '../rideStatusEffects';
import type { Ride } from '@tricigo/types';

function makeRide(over: Partial<Ride> = {}): Ride {
  return {
    id: 'ride-1',
    status: 'searching',
    driver_id: null,
    cancellation_reason: null,
    service_type: 'triciclo_basico',
    payment_method: 'cash',
    final_fare_cup: null,
    final_fare_trc: null,
    ...over,
  } as unknown as Ride;
}

/** Text of the toast the rider actually saw. */
function lastToast(): { type?: string; text1?: string; text2?: string } | undefined {
  const call = toastShow.mock.calls.at(-1);
  return call?.[0] as { type?: string; text1?: string; text2?: string } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the "rider is cancelling right now" mute between tests. Passing 0
  // sets the deadline to now, and `now < now` is false.
  muteCancelAnnouncementFor(0);
});

describe('fireRideStatusEffects — driver assigned', () => {
  // This is the feedback that was dead for months: both copies of it lived in
  // code that could never execute, so the rider only ever got the server push.
  it('plays the accept sound, toasts, and notifies', () => {
    fireRideStatusEffects('searching', makeRide({ status: 'accepted', driver_id: 'drv-1' }));

    expect(playSound).toHaveBeenCalledWith('ride_accepted');
    expect(triggerHaptic).toHaveBeenCalledWith('success');
    expect(lastToast()?.text1).toBe('ride.driver_assigned');
    expect(scheduleLocalNotification).toHaveBeenCalled();
  });

  // Without this the active-trip card renders an empty shell: no name, no
  // photo, no plate. The old dead polling did this fetch; nothing replaced it.
  it('loads the driver details so the trip card can render them', () => {
    fireRideStatusEffects('searching', makeRide({ status: 'accepted', driver_id: 'drv-1' }));
    expect(getRideWithDriver).toHaveBeenCalledWith('ride-1');
  });
});

describe('fireRideStatusEffects — cancellation wording', () => {
  // THE reported bug. The search reaper (cleanup_orphan_searching_rides) kills
  // any ride nobody accepted after searching_abandon_seconds. That used to
  // clear the screen in silence, so the rider believed the app ate their trip
  // and their next tap on "Cancelar" hit `ride_already_closed`.
  it('explains a search that timed out, and does not blame a driver', () => {
    fireRideStatusEffects(
      'searching',
      makeRide({ status: 'canceled', cancellation_reason: 'searching_abandoned' }),
    );

    const toast = lastToast();
    expect(toast?.type).toBe('info');
    expect(toast?.text1).toBe('rider:ride.search_expired_title');
    expect(toast?.text2).toBe('rider:ride.search_expired_msg');
    expect(toast?.text2).not.toBe('rider:ride.driver_canceled_msg');
    // The rider should also find out if the phone was in their pocket.
    expect(scheduleLocalNotification).toHaveBeenCalled();
  });

  // An admin/dispatcher cancel has no driver to blame. Saying "the driver
  // cancelled" would be a plain lie, and these toasts now actually reach users.
  it('stays neutral when no driver was ever assigned', () => {
    fireRideStatusEffects('searching', makeRide({ status: 'canceled', driver_id: null }));

    expect(lastToast()?.text2).toBe('rider:ride.canceled_generic_msg');
    expect(lastToast()?.text2).not.toBe('rider:ride.driver_canceled_msg');
  });

  it('blames the driver only when there actually was one', () => {
    fireRideStatusEffects('accepted', makeRide({ status: 'canceled', driver_id: 'drv-1' }));
    expect(lastToast()?.text2).toBe('rider:ride.driver_canceled_msg');
  });

  it('uses the mid-trip wording when the ride was already under way', () => {
    fireRideStatusEffects('in_progress', makeRide({ status: 'canceled', driver_id: 'drv-1' }));
    expect(lastToast()?.text1).toBe('rider:ride.trip_interrupted_title');
  });

  // The watcher polls every 3s and would otherwise race the rider's own
  // cancel, announcing "your trip was cancelled" for something they just did.
  it('says nothing while the rider is cancelling the trip themselves', () => {
    muteCancelAnnouncementFor(15_000);

    fireRideStatusEffects(
      'searching',
      makeRide({ status: 'canceled', cancellation_reason: 'searching_abandoned' }),
    );

    expect(toastShow).not.toHaveBeenCalled();
    expect(triggerHaptic).not.toHaveBeenCalled();
  });
});

describe('fireRideStatusEffects — completed', () => {
  it('celebrates, records the event and schedules the rating reminder', () => {
    fireRideStatusEffects('in_progress', makeRide({ status: 'completed', final_fare_cup: 2200 }));

    expect(playSound).toHaveBeenCalledWith('trip_completed');
    expect(trackEvent).toHaveBeenCalledWith(
      'ride_completed',
      expect.objectContaining({ ride_id: 'ride-1' }),
    );
    expect(scheduleNotificationAsync).toHaveBeenCalled();
    expect(invalidatePredictionCache).toHaveBeenCalled();
  });

  it('shows what was charged when there is a final fare', () => {
    fireRideStatusEffects('in_progress', makeRide({ status: 'completed', final_fare_cup: 2200 }));
    expect(lastToast()?.text1).toBe('ride.payment_confirmed_title');
  });

  // A zero/absent fare means nothing was charged — inventing a receipt toast
  // for it would confuse the rider.
  it('shows no payment toast when there is no fare', () => {
    fireRideStatusEffects('in_progress', makeRide({ status: 'completed', final_fare_cup: 0 }));
    expect(toastShow).not.toHaveBeenCalled();
  });
});
