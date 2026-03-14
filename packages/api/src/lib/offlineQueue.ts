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

let storage: StorageAdapter | null = null;
let queue: QueuedMutation[] = [];
let isProcessing = false;
let isOnline = true;

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
export function initOfflineQueue(storageAdapter: StorageAdapter) {
  storage = storageAdapter;
  loadQueue();
}

/**
 * Register a mutation handler that can be queued offline.
 */
export function registerOfflineMutation(
  action: string,
  handler: (...args: unknown[]) => Promise<unknown>,
) {
  handlers[action] = handler;
}

/**
 * Set online/offline status.
 */
export function setOnlineStatus(online: boolean) {
  const wasOffline = !isOnline;
  isOnline = online;
  if (online && wasOffline) {
    processQueue();
  }
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
  if (isProcessing || queue.length === 0 || !isOnline) return;

  isProcessing = true;
  const total = queue.length;
  let index = 0;

  while (queue.length > 0 && isOnline) {
    const mutation = queue[0]!;
    const handler = handlers[mutation.action];

    if (!handler) {
      // No handler, discard
      queue.shift();
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
      queue.shift();
      await saveQueue();
      notifyListeners();
    } catch (err) {
      if (isNetworkError(err)) {
        // Still offline, stop processing
        setOnlineStatus(false);
        break;
      }

      // Non-network error — retry up to MAX_RETRIES
      mutation.retries += 1;
      if (mutation.retries >= MAX_RETRIES) {
        console.warn(`[OfflineQueue] Discarding mutation after ${MAX_RETRIES} retries:`, mutation.action);
        queue.shift();
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
