import { describe, it, expect, beforeEach, vi } from 'vitest';

// Create a fresh in-memory storage for each test
function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  };
}

// Import fresh module for each test to reset module-level state
async function loadFreshModule() {
  vi.resetModules();
  return await import('../offlineQueue');
}

describe('offlineQueue', () => {
  let mod: Awaited<ReturnType<typeof loadFreshModule>>;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(async () => {
    mod = await loadFreshModule();
    storage = createMockStorage();
    await mod.initOfflineQueue(storage);
  });

  describe('initOfflineQueue + registerOfflineMutation', () => {
    it('registers a handler that can be executed', async () => {
      const handler = vi.fn(async () => 'ok');
      mod.registerOfflineMutation('test.action', handler);

      const result = await mod.executeOrQueue('test.action', 'arg1');
      expect(result.executed).toBe(true);
      expect(result.result).toBe('ok');
      expect(handler).toHaveBeenCalledWith('arg1');
    });

    it('throws for unregistered actions', async () => {
      await expect(mod.executeOrQueue('unknown.action')).rejects.toThrow(
        'No handler registered for action: unknown.action',
      );
    });
  });

  describe('executeOrQueue when online', () => {
    it('executes immediately and returns result', async () => {
      const handler = vi.fn(async (x: unknown) => Number(x) * 2);
      mod.registerOfflineMutation('double', handler);

      const result = await mod.executeOrQueue('double', 5);
      expect(result.executed).toBe(true);
      expect(result.result).toBe(10);
      expect(mod.getPendingCount()).toBe(0);
    });
  });

  describe('executeOrQueue when offline', () => {
    it('queues mutation and increments pending count', async () => {
      const handler = vi.fn(async () => {});
      mod.registerOfflineMutation('my.action', handler);
      mod.setOnlineStatus(false);

      const result = await mod.executeOrQueue('my.action', 'data');
      expect(result.executed).toBe(false);
      expect(mod.getPendingCount()).toBe(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it('queues multiple mutations', async () => {
      const handler = vi.fn(async () => {});
      mod.registerOfflineMutation('multi', handler);
      mod.setOnlineStatus(false);

      await mod.executeOrQueue('multi', 'a');
      await mod.executeOrQueue('multi', 'b');
      await mod.executeOrQueue('multi', 'c');
      expect(mod.getPendingCount()).toBe(3);
    });
  });

  describe('setOnlineStatus', () => {
    it('processes queue when coming back online', async () => {
      const handler = vi.fn(async () => {});
      mod.registerOfflineMutation('queued', handler);
      mod.setOnlineStatus(false);

      await mod.executeOrQueue('queued', 'x');
      await mod.executeOrQueue('queued', 'y');
      expect(mod.getPendingCount()).toBe(2);

      // Come back online — triggers processQueue
      mod.setOnlineStatus(true);
      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(mod.getPendingCount()).toBe(0);
    });

    it('replays a persisted queue after an online app restart', async () => {
      const fresh = await loadFreshModule();
      const persistedStorage = createMockStorage();
      persistedStorage._store.set(
        '@tricigo/offline-queue',
        JSON.stringify([
          {
            id: 'persisted-1',
            action: 'ride.complete',
            params: [{ rideId: 'ride-1' }],
            timestamp: 1,
            retries: 0,
          },
        ]),
      );
      const handler = vi.fn(async () => {});

      fresh.initOfflineQueue(persistedStorage);
      fresh.registerOfflineMutation('ride.complete', handler);
      // NetInfo commonly reports `true` on startup while the module already
      // defaults to online. That stable state must still flush persisted work.
      fresh.setOnlineStatus(true);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

      expect(handler).toHaveBeenCalledWith({ rideId: 'ride-1' });
      expect(fresh.getPendingCount()).toBe(0);
    });

    it('keeps a persisted mutation whose handler is not registered yet', async () => {
      // The replay now starts as soon as the queue loads, which can win the race
      // against handler registration (lazy import, slow bundle). A mutation the
      // app cannot execute *yet* must survive until its handler shows up.
      const fresh = await loadFreshModule();
      const persistedStorage = createMockStorage();
      persistedStorage._store.set(
        '@tricigo/offline-queue',
        JSON.stringify([
          {
            id: 'persisted-1',
            action: 'ride.complete',
            params: [{ rideId: 'ride-1' }],
            timestamp: 1,
            retries: 0,
          },
        ]),
      );

      await fresh.initOfflineQueue(persistedStorage);
      await new Promise((r) => setTimeout(r, 20));
      expect(fresh.getPendingCount()).toBe(1);

      const handler = vi.fn(async () => {});
      fresh.registerOfflineMutation('ride.complete', handler);
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(fresh.getPendingCount()).toBe(0);
    });
  });

  describe('network error handling', () => {
    it('auto-queues on network error during online execution', async () => {
      const handler = vi.fn(async () => {
        throw new Error('network request failed');
      });
      mod.registerOfflineMutation('net.fail', handler);

      const result = await mod.executeOrQueue('net.fail', 'data');
      expect(result.executed).toBe(false);
      expect(mod.getOnlineStatus()).toBe(false);
      expect(mod.getPendingCount()).toBe(1);
    });

    it('rethrows non-network errors', async () => {
      const handler = vi.fn(async () => {
        throw new Error('validation failed');
      });
      mod.registerOfflineMutation('val.fail', handler);

      await expect(mod.executeOrQueue('val.fail')).rejects.toThrow('validation failed');
      expect(mod.getOnlineStatus()).toBe(true);
      expect(mod.getPendingCount()).toBe(0);
    });

    it('does not burn the retry budget on online signals that arrive back to back', async () => {
      // NetInfo re-fires with isConnected === true on every transport change
      // (wifi <-> cellular, isInternetReachable flips). Replaying the queue on
      // each of those is correct; charging a retry for each is not — three
      // events in a second would silently drop the mutation.
      const handler = vi.fn(async () => {
        throw new Error('Internal server error');
      });
      mod.registerOfflineMutation('incident.sos', handler);

      mod.setOnlineStatus(false);
      await mod.executeOrQueue('incident.sos', { rideId: 'ride-1' });
      expect(mod.getPendingCount()).toBe(1);

      for (let i = 0; i < 4; i++) {
        mod.setOnlineStatus(true);
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mod.getPendingCount()).toBe(1);
    });
  });

  describe('getOnlineStatus', () => {
    it('defaults to true', () => {
      expect(mod.getOnlineStatus()).toBe(true);
    });

    it('reflects setOnlineStatus calls', () => {
      mod.setOnlineStatus(false);
      expect(mod.getOnlineStatus()).toBe(false);
      mod.setOnlineStatus(true);
      expect(mod.getOnlineStatus()).toBe(true);
    });
  });

  describe('storage persistence', () => {
    it('saves queue to storage when mutations are queued', async () => {
      const handler = vi.fn(async () => {});
      mod.registerOfflineMutation('persist', handler);
      mod.setOnlineStatus(false);

      await mod.executeOrQueue('persist', 'data');
      expect(storage.setItem).toHaveBeenCalled();
      const savedData = storage._store.get('@tricigo/offline-queue');
      expect(savedData).toBeDefined();
      const parsed = JSON.parse(savedData!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].action).toBe('persist');
    });

    it('does not overwrite a new mutation while the persisted queue is loading', async () => {
      const fresh = await loadFreshModule();
      let releaseLoad!: (value: string) => void;
      const delayedStorage = createMockStorage();
      delayedStorage.getItem.mockImplementation(
        () => new Promise<string>((resolve) => { releaseLoad = resolve; }),
      );
      const persisted = JSON.stringify([
        {
          id: 'persisted-1',
          action: 'persist',
          params: ['old'],
          timestamp: 1,
          retries: 0,
        },
      ]);
      fresh.registerOfflineMutation('persist', vi.fn(async () => {}));
      fresh.initOfflineQueue(delayedStorage);
      fresh.setOnlineStatus(false);

      const enqueue = fresh.executeOrQueue('persist', 'new');
      releaseLoad(persisted);
      await enqueue;

      expect(fresh.getPendingMutations().map((mutation) => mutation.params[0])).toEqual([
        'old',
        'new',
      ]);
      const saved = delayedStorage.setItem.mock.calls.at(-1)?.[1];
      expect(JSON.parse(saved ?? '[]')).toHaveLength(2);
    });
  });
});
