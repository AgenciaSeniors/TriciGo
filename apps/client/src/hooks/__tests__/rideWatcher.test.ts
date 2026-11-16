import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real ride store runs; only native modules, the network and the feedback
// effects (toasts, sounds) are mocked, so these tests see exactly what the
// rider's screen would: which ride is in the store and which step is shown.

let appStateListener: ((state: string) => void) | null = null;
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn((_event: string, fn: (state: string) => void) => {
      appStateListener = fn;
      return { remove: vi.fn(() => { appStateListener = null; }) };
    }),
  },
}));

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: vi.fn(async () => 'id') }));
vi.mock('react-native-toast-message', () => ({ default: { show: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock('@tricigo/utils', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  triggerHaptic: vi.fn(),
  trackEvent: vi.fn(),
  deliveryVehicleToSlug: (v: string) => v,
  RIDE_CONFIG: { MAX_WAYPOINTS: 3 },
}));

const fireRideStatusEffects = vi.fn();
vi.mock('@/hooks/rideStatusEffects', () => ({
  fireRideStatusEffects: (...a: unknown[]) => fireRideStatusEffects(...a),
}));

const getActiveRide = vi.fn();
const getRideWithDriver = vi.fn();
const touchSearchingRide = vi.fn(async () => undefined);
vi.mock('@tricigo/api', () => ({
  rideService: {
    getActiveRide: (...a: unknown[]) => getActiveRide(...a),
    getRideWithDriver: (...a: unknown[]) => getRideWithDriver(...a),
    subscribeToRide: () => ({ unsubscribe: () => undefined }),
    touchSearchingRide: (...a: unknown[]) => touchSearchingRide(...(a as [])),
  },
}));

import { useRideStore } from '@/stores/ride.store';
import { startRideWatcher } from '../rideWatcher';
import type { Ride } from '@tricigo/types';

const INITIAL_STATE = useRideStore.getState();

const NETWORK_ERROR = new TypeError('Network request failed');

function makeRide(over: Partial<Ride> = {}): Ride {
  return {
    id: 'ride-1',
    customer_id: 'rider-1',
    status: 'accepted',
    driver_id: 'driver-1',
    service_type: 'triciclo_basico',
    payment_method: 'cash',
    estimated_fare_cup: 1500,
    estimated_fare_trc: 1500,
    ...over,
  } as unknown as Ride;
}

function withDriver(ride: Ride) {
  return { ...ride, driver_name: 'Chofer de prueba', vehicle_plate: 'P123456' };
}

/** Lets the watcher's pending promises settle without moving the clock. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

let stop: (() => void) | null = null;

describe('startRideWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T15:44:00Z'));
    useRideStore.setState(INITIAL_STATE, true);
    getActiveRide.mockReset();
    getRideWithDriver.mockReset();
    fireRideStatusEffects.mockReset();
    appStateListener = null;
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it('recovers the active ride on startup', async () => {
    const ride = makeRide();
    getActiveRide.mockResolvedValue(ride);
    getRideWithDriver.mockResolvedValue(withDriver(ride));

    stop = startRideWatcher('rider-1');
    await settle();

    expect(useRideStore.getState().activeRide?.id).toBe('ride-1');
    expect(useRideStore.getState().flowStep).toBe('active');
    expect(useRideStore.getState().rideWithDriver?.id).toBe('ride-1');
  });

  // 2026-11-16, iPhone on ETECSA data: the first requests after a cold start
  // never reached the server, and the ride never came back.
  it('recovers the active ride when the startup lookup fails', async () => {
    const ride = makeRide({ status: 'driver_en_route' });
    getActiveRide.mockRejectedValueOnce(NETWORK_ERROR).mockResolvedValue(ride);
    getRideWithDriver.mockResolvedValue(withDriver(ride));

    stop = startRideWatcher('rider-1');
    await settle();
    expect(useRideStore.getState().activeRide).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(useRideStore.getState().activeRide?.id).toBe('ride-1');
    expect(useRideStore.getState().flowStep).toBe('active');
    expect(useRideStore.getState().rideWithDriver?.id).toBe('ride-1');
  });

  it('retries a failed startup lookup within a few seconds', async () => {
    getActiveRide.mockRejectedValueOnce(NETWORK_ERROR).mockResolvedValue(null);

    stop = startRideWatcher('rider-1');
    await settle();
    await vi.advanceTimersByTimeAsync(7_000);

    expect(getActiveRide).toHaveBeenCalledTimes(2);
  });

  it('looks for an active ride when the app comes back to the foreground, with none in memory', async () => {
    const ride = makeRide({ status: 'in_progress' });
    getActiveRide.mockRejectedValueOnce(NETWORK_ERROR).mockResolvedValue(ride);
    getRideWithDriver.mockResolvedValue(withDriver(ride));

    stop = startRideWatcher('rider-1');
    await settle();
    expect(useRideStore.getState().activeRide).toBeNull();

    appStateListener?.('active');
    await settle();

    expect(useRideStore.getState().activeRide?.id).toBe('ride-1');
    expect(useRideStore.getState().flowStep).toBe('active');
  });

  it('with no ride in memory, checks every 20 seconds or so, not every 3', async () => {
    getActiveRide.mockResolvedValue(null);

    stop = startRideWatcher('rider-1');
    await settle();
    expect(getActiveRide).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getActiveRide).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getActiveRide).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(35_000);
    expect(getActiveRide).toHaveBeenCalledTimes(3);
  });

  it('picks up a ride the driver accepted while the app had none in memory', async () => {
    // e.g. the rider opened the app before the ride existed on this device
    // (asked for it from the web), or the startup lookup answered before an
    // accept that was still in flight.
    const ride = makeRide({ status: 'accepted' });
    getActiveRide.mockResolvedValueOnce(null).mockResolvedValue(ride);
    getRideWithDriver.mockResolvedValue(withDriver(ride));

    stop = startRideWatcher('rider-1');
    await settle();
    expect(useRideStore.getState().activeRide).toBeNull();

    await vi.advanceTimersByTimeAsync(25_000);

    expect(useRideStore.getState().activeRide?.id).toBe('ride-1');
    expect(useRideStore.getState().flowStep).toBe('active');
  });

  it('does not look for a ride while the rider is creating one', async () => {
    getActiveRide.mockResolvedValue(null);

    stop = startRideWatcher('rider-1');
    await settle();
    useRideStore.getState().setFlowStep('reviewing');
    useRideStore.getState().setLoading(true);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(getActiveRide).toHaveBeenCalledTimes(1);
  });

  it('drops a lookup whose answer arrives after the rider started a ride', async () => {
    const stale = makeRide({ id: 'ride-old', status: 'searching', driver_id: null });
    let answer: (r: Ride | null) => void = () => undefined;
    getActiveRide
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise<Ride | null>((resolve) => { answer = resolve; }));

    stop = startRideWatcher('rider-1');
    await settle();
    await vi.advanceTimersByTimeAsync(21_000); // the idle lookup is now in flight

    const mine = makeRide({ id: 'ride-new', status: 'searching', driver_id: null });
    useRideStore.getState().setActiveRide(mine);
    useRideStore.getState().setFlowStep('searching');

    answer(stale);
    await settle();

    expect(useRideStore.getState().activeRide?.id).toBe('ride-new');
  });

  it('loads the driver details if they failed to load with the ride', async () => {
    const ride = makeRide({ status: 'driver_en_route' });
    getActiveRide.mockResolvedValue(ride);
    getRideWithDriver.mockRejectedValueOnce(NETWORK_ERROR).mockResolvedValue(withDriver(ride));

    stop = startRideWatcher('rider-1');
    await settle();
    expect(useRideStore.getState().activeRide?.id).toBe('ride-1');
    expect(useRideStore.getState().rideWithDriver).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(useRideStore.getState().rideWithDriver?.id).toBe('ride-1');
  });

  it('stops looking once stopped', async () => {
    getActiveRide.mockResolvedValue(null);

    stop = startRideWatcher('rider-1');
    await settle();
    stop();
    stop = null;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getActiveRide).toHaveBeenCalledTimes(1);
  });
});
