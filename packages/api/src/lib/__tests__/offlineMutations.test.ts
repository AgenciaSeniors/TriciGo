import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the service modules so registering handlers has no real side effects.
const completeRide = vi.fn(async () => ({ final_fare_cup: 1000 }));
const cancelRide = vi.fn(async () => {});
vi.mock('../../services/driver.service', () => ({ driverService: { completeRide } }));
vi.mock('../../services/ride.service', () => ({ rideService: { cancelRide } }));
vi.mock('../../services/review.service', () => ({ reviewService: { submitReview: vi.fn() } }));
vi.mock('../../services/incident.service', () => ({ incidentService: { createSOSReport: vi.fn() } }));
vi.mock('../../services/support.service', () => ({ supportService: { createTicket: vi.fn() } }));

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

async function loadFresh() {
  vi.resetModules();
  const queue = await import('../offlineQueue');
  const mutations = await import('../offlineMutations');
  return { queue, mutations };
}

describe('offlineMutations — ride.complete (G2)', () => {
  let queue: Awaited<ReturnType<typeof loadFresh>>['queue'];
  let mutations: Awaited<ReturnType<typeof loadFresh>>['mutations'];

  beforeEach(async () => {
    completeRide.mockClear();
    ({ queue, mutations } = await loadFresh());
    queue.initOfflineQueue(createMockStorage());
    await new Promise((r) => setTimeout(r, 10));
    mutations.registerAllOfflineMutations();
  });

  it('registers ride.complete and routes to driverService.completeRide', async () => {
    const params = { rideId: 'r1', driverId: 'd1', actualDistanceM: 2000, actualDurationS: 600 };
    const result = await queue.executeOrQueue('ride.complete', params);
    expect(result.executed).toBe(true);
    expect(completeRide).toHaveBeenCalledWith(params);
  });

  it('queues the completion when offline and replays it on reconnect', async () => {
    const params = { rideId: 'r2', driverId: 'd1', actualDistanceM: 1500, actualDurationS: 500 };
    queue.setOnlineStatus(false);

    const queued = await queue.executeOrQueue('ride.complete', params);
    expect(queued.executed).toBe(false);
    expect(completeRide).not.toHaveBeenCalled();
    expect(queue.getPendingCount()).toBe(1);

    // Reconnect → queue flushes → completion posts exactly once.
    queue.setOnlineStatus(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(completeRide).toHaveBeenCalledTimes(1);
    expect(completeRide).toHaveBeenCalledWith(params);
    expect(queue.getPendingCount()).toBe(0);
  });
});
