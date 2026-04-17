// ============================================================
// TriciGo — Location Buffer
// Buffers GPS points when offline and flushes when reconnected.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const BUFFER_KEY = '@tricigo/location-buffer';
const MAX_BUFFER_SIZE = 500; // ~80 min at 10s intervals
const PERSIST_DEBOUNCE_MS = 5000;
const BATCH_SIZE = 20;
const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 2;

export interface BufferedLocation {
  latitude: number;
  longitude: number;
  heading: number | null;
  speed: number | null;
  accuracy: number | null;
  timestamp: number;
  rideId: string | null;
  driverId: string;
}

let buffer: BufferedLocation[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

/**
 * Initialize the buffer from AsyncStorage.
 */
export async function initLocationBuffer(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const raw = await AsyncStorage.getItem(BUFFER_KEY);
    if (raw) {
      buffer = JSON.parse(raw);
    }
  } catch {
    buffer = [];
  }
}

/**
 * Add a location to the buffer.
 */
export function bufferLocation(loc: BufferedLocation): void {
  buffer.push(loc);

  // Cap buffer size — discard oldest
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(buffer.length - MAX_BUFFER_SIZE);
  }

  // Debounce persist to AsyncStorage
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistBuffer();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Get the number of buffered locations.
 */
export function getBufferCount(): number {
  return buffer.length;
}

/**
 * Flush buffered locations to the server.
 * Calls the provided sender function in batches.
 */
export async function flushBuffer(
  sendBatch: (locations: BufferedLocation[]) => Promise<void>,
): Promise<void> {
  if (buffer.length === 0) return;

  // Sort by timestamp ascending
  buffer.sort((a, b) => a.timestamp - b.timestamp);

  while (buffer.length > 0) {
    const batch = buffer.splice(0, BATCH_SIZE);
    let sent = false;

    for (let attempt = 0; attempt < MAX_RETRIES + 1; attempt++) {
      try {
        await sendBatch(batch);
        sent = true;
        break;
      } catch {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    if (!sent) {
      // All retries exhausted — put batch back and stop
      buffer.unshift(...batch);
      break;
    }
  }

  await persistBuffer();
}

async function persistBuffer(): Promise<void> {
  try {
    if (buffer.length === 0) {
      await AsyncStorage.removeItem(BUFFER_KEY);
    } else {
      await AsyncStorage.setItem(BUFFER_KEY, JSON.stringify(buffer));
    }
  } catch {
    // Best effort
  }
}
