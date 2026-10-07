import { describe, it, expect, vi } from 'vitest';
import {
  ASSIGNED_RIDE_NOTICE_DEDUP_MS,
  emitRideAssignedPush,
  isRideAssignedPush,
  onRideAssignedPush,
  shouldAnnounceAssignedRide,
} from '../rideAssignedPush';

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

describe('shouldAnnounceAssignedRide', () => {
  const NOW = 1_000_000;
  // Server said "no active trip" last time, the store holds nothing, the driver did not try to
  // accept this ride, no recent notice: a reconcile just loaded a ride support assigned.
  const base = {
    previousServerTripId: null as string | null | undefined,
    heldTripId: null as string | null,
    loadedTripId: 'r-2',
    driverTriedToAccept: false,
    lastNoticeAt: 0,
    now: NOW,
  };

  it('announces a ride a reconcile loaded that the app did not have', () => {
    expect(shouldAnnounceAssignedRide(base)).toBe(true);
  });

  it('announces it over the completed-trip screen (the store holds the finished ride)', () => {
    expect(shouldAnnounceAssignedRide({ ...base, heldTripId: 'r-1' })).toBe(true);
  });

  it('stays quiet on the first answer of the process: that is restoring a trip after a restart', () => {
    expect(shouldAnnounceAssignedRide({ ...base, previousServerTripId: undefined })).toBe(false);
  });

  it('stays quiet when the server already reported this ride, or the store already has it', () => {
    expect(shouldAnnounceAssignedRide({ ...base, previousServerTripId: 'r-2' })).toBe(false);
    expect(shouldAnnounceAssignedRide({ ...base, heldTripId: 'r-2' })).toBe(false);
  });

  it('stays quiet for a ride the driver accepted here', () => {
    // The reconcile landed before the accept's reply, or the reply was lost after the server took
    // the ride: support did not assign it.
    expect(shouldAnnounceAssignedRide({ ...base, driverTriedToAccept: true })).toBe(false);
  });

  it('gives one notice for overlapping reconciles (push received, then tapped)', () => {
    expect(shouldAnnounceAssignedRide({ ...base, lastNoticeAt: NOW - ASSIGNED_RIDE_NOTICE_DEDUP_MS + 1 })).toBe(false);
    expect(shouldAnnounceAssignedRide({ ...base, lastNoticeAt: NOW - ASSIGNED_RIDE_NOTICE_DEDUP_MS })).toBe(true);
  });
});
