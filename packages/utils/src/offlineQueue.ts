// ============================================================
// TriciGo — Standalone Offline Queue (packages/utils)
// A lightweight, AsyncStorage-backed queue for offline actions.
// Use this when you need a simple enqueue/process pattern without
// the full mutation registry from @tricigo/api.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

type QueuedAction = {
  id: string;
  action: string; // 'submitReview', 'updateStatus', 'recordLocation'
  params: Record<string, unknown>;
  createdAt: number;
  retries: number;
};

const QUEUE_KEY = '@tricigo/offline_queue';

export const offlineQueue = {
  async enqueue(action: string, params: Record<string, unknown>): Promise<void> {
    const queue = await this.getQueue();
    queue.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      action,
      params,
      createdAt: Date.now(),
      retries: 0,
    });
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  },

  async getQueue(): Promise<QueuedAction[]> {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  },

  async removeFromQueue(id: string): Promise<void> {
    const queue = await this.getQueue();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter(q => q.id !== id)));
  },

  async processQueue(
    handlers: Record<string, (params: Record<string, unknown>) => Promise<void>>,
  ): Promise<{ processed: number; failed: number }> {
    const queue = await this.getQueue();
    let processed = 0;
    let failed = 0;

    for (const item of queue) {
      const handler = handlers[item.action];
      if (!handler) {
        failed++;
        continue;
      }

      try {
        await handler(item.params);
        await this.removeFromQueue(item.id);
        processed++;
      } catch {
        // Increment retries, remove if too many
        item.retries++;
        if (item.retries >= 5) {
          await this.removeFromQueue(item.id);
          failed++;
        }
      }
    }

    // Save updated retries
    const remaining = await this.getQueue();
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    return { processed, failed };
  },

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(QUEUE_KEY);
  },
};
