// ============================================================
// TriciGo — Offline Queue
// Queues failed mutations when offline and replays them
// when connectivity is restored.
// ============================================================

export type QueuedMutation = {
  id: string;
  action: string;
  params: unknown[];
  timestamp: number;
  retries: number;
  /** Epoch ms before which this mutation must not be retried. */
  nextAttemptAt?: number;
};

export type ProcessingStatus = {
  isProcessing: boolean;
  currentAction: string | null;
  currentIndex: number;
  total: number;
};

type StorageAdapter = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

const QUEUE_KEY = '@tricigo/offline-queue';
const MAX_RETRIES = 3;
// The queue is replayed on every online signal, not just on an offline->online
// transition, so a mutation must serve a backoff between attempts. Without it a
// burst of NetInfo events drains MAX_RETRIES in a second and drops the work.
const RETRY_BACKOFF_MS = 30_000;

let storage: StorageAdapter | null = null;
let queue: QueuedMutation[] = [];
let isProcessing = false;
let isOnline = true;
let initialization: Promise<void> = Promise.resolve();

// Registry of mutation handlers
const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

// Event emitter for queue changes
type QueueChangeCallback = (queue: QueuedMutation[], status: ProcessingStatus) => void;
const listeners: Set<QueueChangeCallback> = new Set();

let processingStatus: ProcessingStatus = {
  isProcessing: false,
  currentAction: null,
  currentIndex: 0,
  total: 0,
};

function notifyListeners() {
  const snapshot = [...queue];
  const statusSnapshot = { ...processingStatus };
  for (const cb of listeners) {
    try { cb(snapshot, statusSnapshot); } catch { /* ignore */ }
  }
}

/**
 * Initialize the offline queue with a storage adapter.
 */
export function initOfflineQueue(storageAdapter: StorageAdapter): Promise<void> {
  storage = storageAdapter;
  initialization = loadQueue();
  void initialization.then(() => {
    notifyListeners();
    if (isOnline) void processQueue();
  });
  return initialization;
}

/**
 * Register a mutation handler that can be queued offline.
 */
export function registerOfflineMutation(
  action: string,
  handler: (...args: unknown[]) => Promise<unknown>,
) {
  handlers[action] = handler;
  if (isOnline) void processQueue();
}

/**
 * Set online/offline status.
 */
export function setOnlineStatus(online: boolean) {
  isOnline = online;
  if (online) void processQueue();
}

/**
 * Get current online status.
 */
export function getOnlineStatus(): boolean {
  return isOnline;
}

/**
 * Get count of pending mutations.
 */
export function getPendingCount(): number {
  return queue.length;
}

/**
 * Get a snapshot of all pending mutations.
 */
export function getPendingMutations(): QueuedMutation[] {
  return [...queue];
}

/**
 * Get current processing status.
 */
export function getProcessingStatus(): ProcessingStatus {
  return { ...processingStatus };
}

/**
 * Subscribe to queue changes. Returns unsubscribe function.
 */
export function onQueueChange(callback: QueueChangeCallback): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

/**
 * Execute a mutation, or queue it if offline.
 * Returns true if executed immediately, false if queued.
 */
export async function executeOrQueue(
  action: string,
  ...params: unknown[]
): Promise<{ executed: boolean; result?: unknown }> {
  const handler = handlers[action];
  if (!handler) {
    throw new Error(`No handler registered for action: ${action}`);
  }

  // Never mutate the in-memory queue until its persisted state is loaded.
  // Otherwise a late load can overwrite work enqueued during app startup.
  await initialization;

  if (isOnline) {
    try {
      const result = await handler(...params);
      return { executed: true, result };
    } catch (err) {
      // If it's a network error, queue it
      if (isNetworkError(err)) {
        setOnlineStatus(false);
        await enqueue(action, params);
        return { executed: false };
      }
      throw err;
    }
  } else {
    await enqueue(action, params);
    return { executed: false };
  }
}

async function enqueue(action: string, params: unknown[]) {
  const mutation: QueuedMutation = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action,
    params,
    timestamp: Date.now(),
    retries: 0,
  };
  queue.push(mutation);
  await saveQueue();
  notifyListeners();
}

async function processQueue() {
  await initialization;
  if (isProcessing || queue.length === 0 || !isOnline) return;

  isProcessing = true;
  const total = queue.length;
  let index = 0;
  let cursor = 0;

  while (cursor < queue.length && isOnline) {
    const mutation = queue[cursor]!;
    const handler = handlers[mutation.action];

    if (!handler) {
      // Handlers are registered during startup and the replay can win that
      // race. Skip — never discard — so the mutation survives until its
      // handler lands and registerOfflineMutation replays the queue.
      cursor++;
      continue;
    }

    if (mutation.nextAttemptAt && mutation.nextAttemptAt > Date.now()) {
      cursor++;
      continue;
    }

    // Update processing status
    index++;
    processingStatus = {
      isProcessing: true,
      currentAction: mutation.action,
      currentIndex: index,
      total,
    };
    notifyListeners();

    try {
      await handler(...mutation.params);
      queue.splice(cursor, 1);
      await saveQueue();
      notifyListeners();
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline, stop processing
        setOnlineStatus(false);
        break;
      }

      // Non-network error — retry up to MAX_RETRIES, spaced by a backoff so
      // repeated online signals cannot exhaust the budget in one burst.
      mutation.retries += 1;
      if (mutation.retries >= MAX_RETRIES) {
        console.warn(`[OfflineQueue] Discarding mutation after ${MAX_RETRIES} retries:`, mutation.action);
        queue.splice(cursor, 1);
      } else {
        mutation.nextAttemptAt =
          Date.now() + RETRY_BACKOFF_MS * 2 ** (mutation.retries - 1);
      }
      await saveQueue();
      notifyListeners();
      break;
    }
  }

  isProcessing = false;
  processingStatus = { isProcessing: false, currentAction: null, currentIndex: 0, total: 0 };
  notifyListeners();
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('timeout') ||
      msg.includes('offline') ||
      msg.includes('econnrefused')
    );
  }
  return false;
}

async function loadQueue() {
  if (!storage) return;
  try {
    const raw = await storage.getItem(QUEUE_KEY);
    if (raw) {
      queue = JSON.parse(raw);
    }
  } catch {
    queue = [];
  }
}

async function saveQueue() {
  if (!storage) return;
  try {
    await storage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Best effort
  }
}
