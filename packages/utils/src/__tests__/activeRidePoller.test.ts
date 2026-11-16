import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_RIDE_POLL_MS,
  ACTIVE_RIDE_RETRY_MS,
  isLiveActiveRide,
  startActiveRidePoller,
  type ActiveRideLike,
  type PollerWakeSignals,
} from '../activeRidePoller';

const NOW = Date.parse('2026-11-16T15:44:00Z');

function ride(overrides: Partial<ActiveRideLike> = {}): ActiveRideLike {
  return { id: 'ride-1', status: 'driver_en_route', is_scheduled: false, scheduled_at: null, ...overrides };
}

/** A tab whose visibility the test flips, like document.visibilityState. */
function fakeTab(visible = true) {
  let isVisible = visible;
  let wake: (() => void) | null = null;
  const signals: PollerWakeSignals = {
    isVisible: () => isVisible,
    subscribe: (cb) => {
      wake = cb;
      return () => { wake = null; };
    },
  };
  return {
    signals,
    hide() { isVisible = false; },
    show() { isVisible = true; wake?.(); },
    /** The network came back (window 'online'). */
    online() { wake?.(); },
    get subscribed() { return wake !== null; },
  };
}

/** Let the awaited lookup settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('startActiveRidePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks up the active ride as soon as it starts and reports it', async () => {
    const fetchActiveRide = vi.fn().mockResolvedValue(ride());
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: fakeTab().signals });
    await flush();

    expect(fetchActiveRide).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(ride());
    stop();
  });

  it('when the first lookup fails it asks again 5 s later and then shows the ride', async () => {
    // 2026-11-16: on ETECSA data the first requests after opening never reached the
    // server. A single lookup that fails must not be the end of it.
    const fetchActiveRide = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(ride());
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: fakeTab().signals });
    await flush();
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_RETRY_MS - 1);
    expect(fetchActiveRide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();

    expect(fetchActiveRide).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(ride());
    stop();
  });

  it('a failed lookup keeps the ride on screen instead of dropping it', async () => {
    const fetchActiveRide = vi.fn()
      .mockResolvedValueOnce(ride())
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(ride({ status: 'arrived_at_pickup' }));
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: fakeTab().signals });
    await flush();

    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalledWith(null);

    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_RETRY_MS);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(ride({ status: 'arrived_at_pickup' }));
    stop();
  });

  it('keeps asking every 20 s and reports when the ride is over', async () => {
    const fetchActiveRide = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ride({ status: 'searching' }))
      .mockResolvedValueOnce(null);
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: fakeTab().signals });
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(null);

    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(ride({ status: 'searching' }));

    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(null);
    stop();
  });

  it('does not ask while the tab is hidden and asks at once when it comes back', async () => {
    const tab = fakeTab();
    const fetchActiveRide = vi.fn().mockResolvedValue(null);
    const stop = startActiveRidePoller({ fetchActiveRide, onChange: vi.fn(), signals: tab.signals });
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(1);

    tab.hide();
    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS * 5);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(1);

    tab.show();
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(2);

    // And back to the regular rhythm from there, not twice.
    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(3);
    stop();
  });

  it('a page opened in a background tab waits until it is shown', async () => {
    const tab = fakeTab(false);
    const fetchActiveRide = vi.fn().mockResolvedValue(ride());
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: tab.signals });
    await flush();
    expect(fetchActiveRide).not.toHaveBeenCalled();

    tab.show();
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(ride());
    stop();
  });

  it('asks again right away when the network comes back after a failure', async () => {
    const tab = fakeTab();
    const fetchActiveRide = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(ride());
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: tab.signals });
    await flush();

    tab.online();
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(ride());
    stop();
  });

  it('a wake while a lookup is in flight does not send a second request', async () => {
    const tab = fakeTab();
    let answer: (r: ActiveRideLike | null) => void = () => {};
    const fetchActiveRide = vi.fn(() => new Promise<ActiveRideLike | null>((resolve) => { answer = resolve; }));
    const stop = startActiveRidePoller({ fetchActiveRide, onChange: vi.fn(), signals: tab.signals });
    await flush();

    tab.show();
    tab.online();
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(1);

    answer(null);
    await flush();
    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS);
    await flush();
    expect(fetchActiveRide).toHaveBeenCalledTimes(2);
    stop();
  });

  it('after stop it sends nothing more and ignores an answer that arrives late', async () => {
    const tab = fakeTab();
    let answer: (r: ActiveRideLike | null) => void = () => {};
    const fetchActiveRide = vi.fn(() => new Promise<ActiveRideLike | null>((resolve) => { answer = resolve; }));
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: tab.signals });
    await flush();

    stop();
    expect(tab.subscribed).toBe(false);
    answer(ride());
    await flush();
    await vi.advanceTimersByTimeAsync(ACTIVE_RIDE_POLL_MS * 3);
    await flush();

    expect(onChange).not.toHaveBeenCalled();
    expect(fetchActiveRide).toHaveBeenCalledTimes(1);
  });

  it('a ride booked for later is not shown as a ride in progress', async () => {
    const later = ride({ status: 'searching', is_scheduled: true, scheduled_at: '2026-11-17T12:00:00Z' });
    const fetchActiveRide = vi.fn().mockResolvedValue(later);
    const onChange = vi.fn();
    const stop = startActiveRidePoller({ fetchActiveRide, onChange, signals: fakeTab().signals });
    await flush();

    expect(onChange).toHaveBeenLastCalledWith(null);
    stop();
  });
});

describe('isLiveActiveRide', () => {
  it('a ride on now is live', () => {
    expect(isLiveActiveRide(ride({ status: 'searching' }), NOW)).toBe(true);
    expect(isLiveActiveRide(ride({ status: 'in_progress' }), NOW)).toBe(true);
  });

  it('a scheduled ride still waiting for its time is not', () => {
    expect(isLiveActiveRide(
      ride({ status: 'searching', is_scheduled: true, scheduled_at: '2026-11-16T18:00:00Z' }),
      NOW,
    )).toBe(false);
  });

  it('a scheduled ride whose time has come, or that a driver took, is', () => {
    expect(isLiveActiveRide(
      ride({ status: 'searching', is_scheduled: true, scheduled_at: '2026-11-16T15:40:00Z' }),
      NOW,
    )).toBe(true);
    expect(isLiveActiveRide(
      ride({ status: 'accepted', is_scheduled: true, scheduled_at: '2026-11-16T18:00:00Z' }),
      NOW,
    )).toBe(true);
  });
});
