// ============================================================
// TriciGo — the accept preflight must never outlive the offer
//
// Offers live `offer_ttl_seconds` (60s in prod). `acceptRideWithEligibility`
// runs a courtesy pre-filter (`check_accept_ride_eligibility`) before the
// call that actually takes the ride (`accept_ride_v2`). That pre-filter used
// to be awaited with no ceiling, so on a stalled socket it could hold the
// accept past the end of the window: the driver's tap died with the card and
// no request ever reached the server.
//
// Measured in prod (driver 438528b0, 2026-08-14): two offers received, both
// cards shown and expired in his hand, ZERO accept_ride_v2 attempts logged —
// and accept_ride_v2 logs every outcome, success included.
//
// The pre-filter only catches drivers admins flagged as financially
// ineligible; accept_ride_v2 owns the authoritative gate. So when the
// pre-filter can't answer in time, the correct behaviour is to go ahead.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();

function chainable(terminalValue: { data: unknown; error: unknown } = { data: null, error: null }) {
  const obj: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = () => obj;
  obj.select = vi.fn(self);
  obj.eq = vi.fn(self);
  obj.single = vi.fn().mockResolvedValue(terminalValue);
  obj.maybeSingle = vi.fn().mockResolvedValue(terminalValue);
  obj.then = vi.fn((resolve: (v: unknown) => void) => resolve(terminalValue));
  return obj;
}

const RIDE_ROW = {
  id: 'ride-1',
  customer_id: 'cust-1',
  ride_mode: 'passenger',
  pickup_lat: 23.1, pickup_lng: -82.3,
  dropoff_lat: 23.2, dropoff_lng: -82.4,
};

vi.mock('../client', () => ({
  getSupabaseClient: () => ({
    from: vi.fn(() => chainable({ data: RIDE_ROW, error: null })),
    rpc: mockRpc,
  }),
}));

vi.mock('@tricigo/utils', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./_storage-upload', () => ({ uploadFileFromUri: vi.fn() }));
vi.mock('../services/notification.service', () => ({
  notificationService: { notifyUser: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/exchange-rate.service', () => ({ exchangeRateService: {} }));

const { driverService, ACCEPT_PREFLIGHT_TIMEOUT_MS } = await import('../services/driver.service');

describe('accept preflight ceiling', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the ride even when the eligibility pre-filter never answers', async () => {
    mockRpc.mockImplementation((fn: string) => {
      // The stalled socket: this promise is never going to settle.
      if (fn === 'check_accept_ride_eligibility') return new Promise(() => {});
      if (fn === 'accept_ride_v2') return Promise.resolve({ data: { success: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    });

    const promise = driverService.acceptRideWithEligibility('ride-1', 'driver-1');
    await vi.advanceTimersByTimeAsync(ACCEPT_PREFLIGHT_TIMEOUT_MS + 50);
    const ride = await promise;

    expect(ride.id).toBe('ride-1');
    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).toContain('accept_ride_v2');
  });

  it('still blocks the flagged driver when the pre-filter answers in time', async () => {
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'check_accept_ride_eligibility') return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: { success: true }, error: null });
    });

    await expect(driverService.acceptRideWithEligibility('ride-1', 'driver-1'))
      .rejects.toThrow(/saldo negativo/);

    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).not.toContain('accept_ride_v2');
  });

  it('does not wait on the pre-filter longer than the ceiling', async () => {
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'check_accept_ride_eligibility') return new Promise(() => {});
      return Promise.resolve({ data: { success: true }, error: null });
    });

    let settled = false;
    const promise = driverService.acceptRideWithEligibility('ride-1', 'driver-1')
      .then(() => { settled = true; });

    // One tick short of the ceiling: still waiting.
    await vi.advanceTimersByTimeAsync(ACCEPT_PREFLIGHT_TIMEOUT_MS - 100);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    await promise;
    expect(settled).toBe(true);
  });
});
