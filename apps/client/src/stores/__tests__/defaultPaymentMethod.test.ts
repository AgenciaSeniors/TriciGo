import { describe, it, expect, beforeEach, vi } from 'vitest';

// R2-11 (QA round 2026-11-17): Settings said "Método de pago predeterminado:
// TriciCoin" and both rides of the day went out in cash. The draft started at
// 'cash' and nothing read `customer_profiles.default_payment_method`.

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: vi.fn(async () => 'id'),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock('@tricigo/utils', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  deliveryVehicleToSlug: (v: string) => v,
}));

import { useRideStore } from '@/stores/ride.store';
import type { Ride } from '@tricigo/types';

const INITIAL_STATE = useRideStore.getState();
const store = () => useRideStore.getState();

beforeEach(() => {
  useRideStore.setState(INITIAL_STATE, true);
});

describe('default payment method from Settings', () => {
  it('starts the trip with the method chosen in Settings', () => {
    store().applyDefaultPaymentMethod('tricicoin');
    expect(store().draft.paymentMethod).toBe('tricicoin');
  });

  it('keeps it for the next trip', () => {
    store().applyDefaultPaymentMethod('tricicoin');
    store().resetDraft();
    expect(store().draft.paymentMethod).toBe('tricicoin');
  });

  it('keeps a method the rider picked for this trip when the default loads later', () => {
    store().setPaymentMethod('mixed');
    store().applyDefaultPaymentMethod('tricicoin');
    expect(store().draft.paymentMethod).toBe('mixed');
  });

  it('goes back to the default on the next trip after a one-off pick', () => {
    store().applyDefaultPaymentMethod('tricicoin');
    store().setPaymentMethod('cash');
    store().resetDraft();
    expect(store().draft.paymentMethod).toBe('tricicoin');
  });

  it('uses it again after a canceled ride', () => {
    store().applyDefaultPaymentMethod('tricicoin');
    store().setPaymentMethod('cash');
    store().setActiveRide({ id: 'r1', status: 'searching' } as Ride);
    store().updateRideFromRealtime({ id: 'r1', status: 'canceled' } as Ride);
    expect(store().draft.paymentMethod).toBe('tricicoin');
  });

  it('uses it again after a completed ride', () => {
    store().applyDefaultPaymentMethod('mixed');
    store().setPaymentMethod('cash');
    store().resetAll();
    expect(store().draft.paymentMethod).toBe('mixed');
  });

  it('does not take a ride paid by a company off the company account', () => {
    store().setCorporateAccount('acc-1');
    store().applyDefaultPaymentMethod('tricicoin');
    expect(store().draft.paymentMethod).toBe('corporate');
  });

  it('falls back to cash for a value Settings cannot set', () => {
    store().applyDefaultPaymentMethod('corporate');
    expect(store().draft.paymentMethod).toBe('cash');
    store().applyDefaultPaymentMethod(undefined);
    expect(store().draft.paymentMethod).toBe('cash');
  });
});
