import { describe, it, expect } from 'vitest';

import { shouldSendSearchHeartbeat, SEARCH_HEARTBEAT_MS } from '../searchHeartbeat';

describe('shouldSendSearchHeartbeat', () => {
  // The regression this guards: the rider app never sent this beat at all, so
  // `searching_seen_at` stayed frozen at `created_at` and every ride nobody
  // accepted was reaped at 600s WHILE the rider was still watching the search
  // screen. Their next tap on "Cancelar" then hit `ride_already_closed`.
  it('beats on the first tick of a search', () => {
    expect(shouldSendSearchHeartbeat('searching', 0, 1_000_000)).toBe(true);
  });

  // Cadence matters: every beat is an UPDATE on `rides` recorded by the
  // ALL-COLUMNS `audit_rides` trigger, and the watcher ticks every 3s.
  it('does not beat again before the interval elapses', () => {
    const now = 1_000_000;
    expect(shouldSendSearchHeartbeat('searching', now - (SEARCH_HEARTBEAT_MS - 1), now)).toBe(false);
  });

  it('beats again once the interval has elapsed', () => {
    const now = 1_000_000;
    expect(shouldSendSearchHeartbeat('searching', now - SEARCH_HEARTBEAT_MS, now)).toBe(true);
  });

  // Nothing to keep alive once a driver is on the way — and the reaper only
  // looks at `searching` rides, so a beat here would be a pointless write.
  it.each(['idle', 'selecting', 'reviewing', 'active', 'completed'])(
    'never beats while flowStep is %s',
    (flowStep) => {
      expect(shouldSendSearchHeartbeat(flowStep, 0, 1_000_000)).toBe(false);
    },
  );
});
