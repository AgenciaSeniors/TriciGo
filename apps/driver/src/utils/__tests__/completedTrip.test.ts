import { describe, it, expect } from 'vitest';
import type { Ride } from '@tricigo/types';
import { withServerCompletion } from '../completedTrip';

// Only the fields the merge reads or keeps; the rest of a Ride does not matter here.
const local = {
  id: 'r-1',
  status: 'in_progress',
  payment_method: 'tricicoin',
  estimated_fare_cup: 2000,
  final_fare_cup: null,
  cash_amount_cup: null,
  wallet_amount_cup: null,
  wait_time_charge_cup: 0,
  actual_distance_m: null,
  actual_duration_s: null,
  completed_at: null,
  pickup_address: 'Calle 23 e/ L y M',
} as unknown as Ride;

describe('withServerCompletion (a completion the app did not make, e.g. support finished the ride)', () => {
  it('takes the charge from the ride row, so the screen shows the real fare and the cash to collect', () => {
    const row: Partial<Ride> = {
      status: 'completed',
      final_fare_cup: 2970,
      payment_method: 'mixed',
      cash_amount_cup: 970,
      wallet_amount_cup: 2000,
      wait_time_charge_cup: 184,
      actual_distance_m: 4300,
      actual_duration_s: 900,
      completed_at: '2026-10-12T12:30:00Z',
    };
    expect(withServerCompletion(local, row)).toMatchObject({
      id: 'r-1',
      status: 'completed',
      final_fare_cup: 2970,
      payment_method: 'mixed',
      cash_amount_cup: 970,
      wallet_amount_cup: 2000,
      wait_time_charge_cup: 184,
      actual_distance_m: 4300,
      actual_duration_s: 900,
      completed_at: '2026-10-12T12:30:00Z',
      pickup_address: 'Calle 23 e/ L y M',
    });
  });

  it('keeps the values on screen for what the row does not have', () => {
    const got = withServerCompletion(local, { final_fare_cup: 2970, cash_amount_cup: null });
    expect(got.status).toBe('completed');
    expect(got.final_fare_cup).toBe(2970);
    expect(got.payment_method).toBe('tricicoin');
    expect(got.cash_amount_cup).toBeNull();
    expect(got.wait_time_charge_cup).toBe(0);
  });

  it('marks the trip completed even when the row could not be read', () => {
    expect(withServerCompletion(local, null)).toEqual({ ...local, status: 'completed' });
  });
});
