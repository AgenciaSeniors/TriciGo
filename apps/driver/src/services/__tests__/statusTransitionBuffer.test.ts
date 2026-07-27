import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocked with a factory so the real React Native module is never loaded.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    removeItem: vi.fn(async (k: string) => { store.delete(k); }),
  },
}));

import {
  initStatusTransitionBuffer,
  bufferTransition,
  flushTransitions,
  getPendingTransitionCount,
  hasPendingTransition,
  __resetStatusTransitionBuffer,
} from '../statusTransitionBuffer';
import type { BufferedTransition, FlushVerdict } from '../statusTransitionBuffer';

const KEY = '@tricigo/status-transition-buffer';

// Timestamps must be realistic: the buffer drops anything older than 12h, so a
// fixture at epoch 1000 is silently discarded before the sender ever sees it.
function tap(over: Partial<BufferedTransition> = {}): BufferedTransition {
  return {
    rideId: 'ride-1',
    status: 'arrived_at_destination',
    driverLat: 23.08,
    driverLng: -82.37,
    timestamp: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  store.clear();
  __resetStatusTransitionBuffer();
});

describe('bufferTransition', () => {
  it('queues a tap and persists it immediately', async () => {
    await bufferTransition(tap());
    expect(getPendingTransitionCount()).toBe(1);
    expect(hasPendingTransition('ride-1')).toBe(true);
    // Persisted synchronously with the call, not on a debounce: the app can be
    // killed at any moment while the driver is out of coverage, and losing the
    // tap is what stranded ride 409513b3.
    expect(JSON.parse(store.get(KEY)!)).toHaveLength(1);
  });

  it('keeps only the newest tap per ride', async () => {
    await bufferTransition(tap({ status: 'arrived_at_pickup', timestamp: Date.now() - 2000 }));
    await bufferTransition(tap({ status: 'in_progress', timestamp: Date.now() - 1000 }));
    expect(getPendingTransitionCount()).toBe(1);
    expect(JSON.parse(store.get(KEY)!)[0].status).toBe('in_progress');
  });

  it('keeps taps for different rides side by side', async () => {
    await bufferTransition(tap({ rideId: 'a' }));
    await bufferTransition(tap({ rideId: 'b' }));
    expect(getPendingTransitionCount()).toBe(2);
    expect(hasPendingTransition('a')).toBe(true);
    expect(hasPendingTransition('b')).toBe(true);
  });
});

describe('initStatusTransitionBuffer', () => {
  it('restores a queue left behind by a previous app launch', async () => {
    store.set(KEY, JSON.stringify([tap()]));
    await initStatusTransitionBuffer();
    expect(getPendingTransitionCount()).toBe(1);
  });

  it('starts empty rather than throwing on corrupt storage', async () => {
    store.set(KEY, 'not json');
    await initStatusTransitionBuffer();
    expect(getPendingTransitionCount()).toBe(0);
  });
});

describe('flushTransitions', () => {
  it('replays the tap and clears it once applied', async () => {
    await bufferTransition(tap());
    const send = vi.fn(async (): Promise<FlushVerdict> => 'applied');
    await flushTransitions(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getPendingTransitionCount()).toBe(0);
    expect(store.has(KEY)).toBe(false);
  });

  it('replays the coordinates from the tap, not from now', async () => {
    await bufferTransition(tap({ driverLat: 23.08, driverLng: -82.37 }));
    const seen: BufferedTransition[] = [];
    await flushTransitions(async (t) => { seen.push(t); return 'applied'; });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.driverLat).toBe(23.08);
    expect(seen[0]?.driverLng).toBe(-82.37);
  });

  it('replays oldest first', async () => {
    await bufferTransition(tap({ rideId: 'b', timestamp: Date.now() - 1000 }));
    await bufferTransition(tap({ rideId: 'a', timestamp: Date.now() - 2000 }));
    const order: string[] = [];
    await flushTransitions(async (t) => { order.push(t.rideId); return 'applied'; });
    expect(order).toEqual(['a', 'b']);
  });

  it('keeps everything queued while still offline', async () => {
    await bufferTransition(tap({ rideId: 'a', timestamp: Date.now() - 2000 }));
    await bufferTransition(tap({ rideId: 'b', timestamp: Date.now() - 1000 }));
    await flushTransitions(async () => 'retry');
    expect(getPendingTransitionCount()).toBe(2);
  });

  it('stops at the first retry instead of burning the rest', async () => {
    await bufferTransition(tap({ rideId: 'a', timestamp: Date.now() - 2000 }));
    await bufferTransition(tap({ rideId: 'b', timestamp: Date.now() - 1000 }));
    const send = vi.fn(async (): Promise<FlushVerdict> => 'retry');
    await flushTransitions(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // The reason isNetworkError exists: a decision the server already made must
  // not be replayed forever.
  it('drops a transition the server rejected', async () => {
    await bufferTransition(tap());
    await flushTransitions(async () => 'permanent_failure');
    expect(getPendingTransitionCount()).toBe(0);
  });

  it('treats a thrown sender as retry rather than losing the tap', async () => {
    await bufferTransition(tap());
    await flushTransitions(async () => { throw new Error('boom'); });
    expect(getPendingTransitionCount()).toBe(1);
  });

  it('does nothing when the queue is empty', async () => {
    const send = vi.fn(async (): Promise<FlushVerdict> => 'applied');
    await flushTransitions(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('drops transitions too old to be worth replaying', async () => {
    await bufferTransition(tap({ timestamp: Date.now() - 13 * 60 * 60 * 1000 }));
    const send = vi.fn(async (): Promise<FlushVerdict> => 'applied');
    await flushTransitions(send);
    expect(send).not.toHaveBeenCalled();
    expect(getPendingTransitionCount()).toBe(0);
  });

  it('does not run two flushes at once', async () => {
    await bufferTransition(tap());
    let started = 0;
    const send = async (): Promise<FlushVerdict> => {
      started++;
      await new Promise((r) => setTimeout(r, 10));
      return 'applied';
    };
    // The periodic 15s retry and the NetInfo listener can fire together; without
    // the guard both would replay the same tap.
    await Promise.all([flushTransitions(send), flushTransitions(send)]);
    expect(started).toBe(1);
  });
});
