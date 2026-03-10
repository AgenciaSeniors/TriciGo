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
    mod.initOfflineQueue(storage);
    // Wait a tick for loadQueue to finish
    await new Promise((r) => setTimeout(r, 10));
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
  });
});
