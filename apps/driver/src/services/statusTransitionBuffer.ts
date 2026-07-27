// ============================================================
// TriciGo — Status Transition Buffer
// Buffers ride status taps that fail for network reasons and replays
// them when connectivity returns.
// ============================================================
//
// Why this exists: GPS breadcrumbs already survive an outage (BUG-273 v2,
// locationBuffer.ts) but the status tap — the one action the driver actually
// needs — was a live RPC with no buffer. A driver who reached the dropoff with
// no data lost the tap entirely, and by the time the network came back the
// proximity gate rejected them for having driven away. Past the bypass radius
// there is no path at all, so the trip was stuck for good (ride 409513b3,
// 2026-07-27).
//
// The server-side half (migration 00520) accepts the ride's own GPS trail as
// proof of arrival, which rescues drivers on any build. This buffer is the
// client half: it preserves the *moment* of the tap, so the replay carries the
// coordinates the driver actually had when they pressed the button instead of
// wherever they happen to be minutes later.

import AsyncStorage from '@react-native-async-storage/async-storage';

const BUFFER_KEY = '@tricigo/status-transition-buffer';
const MAX_BUFFER_SIZE = 20;
// A transition older than this is not worth replaying — the trip is long over
// one way or another, and the server would reject the FSM jump anyway.
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface BufferedTransition {
  rideId: string;
  status: string;
  driverLat: number | null;
  driverLng: number | null;
  /** Epoch ms of the tap, not of the replay. */
  timestamp: number;
}

/**
 * What the flush sender reports back, so the buffer knows whether an entry is
 * worth keeping. A business rejection (already past this status, too far with
 * no trail, forbidden) must be dropped — retrying it forever would spin.
 */
export type FlushVerdict = 'applied' | 'permanent_failure' | 'retry';

let buffer: BufferedTransition[] = [];
let initialized = false;
let flushing = false;

export async function initStatusTransitionBuffer(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    const raw = await AsyncStorage.getItem(BUFFER_KEY);
    if (raw) buffer = JSON.parse(raw);
  } catch {
    buffer = [];
  }
}

/**
 * Queue a transition whose RPC failed for network reasons.
 *
 * Persists immediately rather than on a debounce like locationBuffer: a status
 * tap is a single irreplaceable event, and the app can be killed at any moment
 * while the driver is out of coverage. Losing one dropped GPS sample is
 * invisible; losing the tap strands the trip.
 */
export async function bufferTransition(t: BufferedTransition): Promise<void> {
  // One pending transition per ride — the newest tap wins. Without this, a
  // driver tapping repeatedly while offline would queue duplicates that replay
  // as invalid FSM jumps.
  buffer = buffer.filter((b) => b.rideId !== t.rideId);
  buffer.push(t);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer = buffer.slice(buffer.length - MAX_BUFFER_SIZE);
  }
  await persistBuffer();
}

export function getPendingTransitionCount(): number {
  return buffer.length;
}

export function hasPendingTransition(rideId: string): boolean {
  return buffer.some((b) => b.rideId === rideId);
}

/**
 * Replay buffered transitions oldest-first.
 *
 * Entries are dropped on 'applied' and on 'permanent_failure'; only 'retry'
 * (still no network) keeps them queued.
 */
export async function flushTransitions(
  send: (t: BufferedTransition) => Promise<FlushVerdict>,
): Promise<void> {
  if (buffer.length === 0 || flushing) return;
  flushing = true;
  try {
    const now = Date.now();
    const expired = buffer.filter((t) => now - t.timestamp > MAX_AGE_MS);
    if (expired.length > 0) {
      buffer = buffer.filter((t) => now - t.timestamp <= MAX_AGE_MS);
    }

    const pending = [...buffer].sort((a, b) => a.timestamp - b.timestamp);
    for (const t of pending) {
      let verdict: FlushVerdict;
      try {
        verdict = await send(t);
      } catch {
        verdict = 'retry';
      }
      if (verdict === 'retry') break; // still offline — keep the rest queued
      buffer = buffer.filter((b) => b !== t);
    }
    await persistBuffer();
  } finally {
    flushing = false;
  }
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

/** Test seam — resets module state between cases. */
export function __resetStatusTransitionBuffer(): void {
  buffer = [];
  initialized = false;
  flushing = false;
}
