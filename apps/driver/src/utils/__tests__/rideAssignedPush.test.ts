import { describe, it, expect, vi } from 'vitest';
import { emitRideAssignedPush, isRideAssignedPush, onRideAssignedPush } from '../rideAssignedPush';

describe('isRideAssignedPush', () => {
  it('recognizes support assigning a ride by data.event (send-push overwrites data.type)', () => {
    expect(isRideAssignedPush({ type: 'system', event: 'ride_assigned', ride_id: 'r-1' })).toBe(true);
  });

  it('ignores every other push', () => {
    expect(isRideAssignedPush({ type: 'system' })).toBe(false);
    expect(isRideAssignedPush({ type: 'ride_offer', ride_id: 'r-1' })).toBe(false);
    expect(isRideAssignedPush({ type: 'system', event: 'support_help' })).toBe(false);
    expect(isRideAssignedPush(undefined)).toBe(false);
    expect(isRideAssignedPush(null)).toBe(false);
  });
});

describe('onRideAssignedPush / emitRideAssignedPush', () => {
  it('calls every listener until it unsubscribes', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onRideAssignedPush(a);
    const offB = onRideAssignedPush(b);

    emitRideAssignedPush();
    offA();
    emitRideAssignedPush();
    offB();
    emitRideAssignedPush();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps calling the others when one listener throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const offBad = onRideAssignedPush(bad);
    const offGood = onRideAssignedPush(good);

    expect(() => emitRideAssignedPush()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);

    offBad();
    offGood();
  });
});
