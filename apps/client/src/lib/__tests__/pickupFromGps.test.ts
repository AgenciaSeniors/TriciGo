import { describe, expect, it, vi } from 'vitest';
import { startPickupFromGps, type LatLng, type PickupFromGpsDeps } from '../pickupFromGps';

// The first emulator round (2026-11-17) left the pickup of the service picker
// empty for good when the home screen had not finished locating the rider (a
// quick tap on a recent destination, or no GPS fix yet), and a new fix sent
// with the app open changed nothing. Tapping while the home screen was looking
// up the address left "Detectando dirección..." there instead. The picker now
// runs this while its pickup is pending.

const HAVANA: LatLng = { latitude: 23.13521, longitude: -82.35974 };
const DETECTING = 'Detectando dirección...';

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Pickup = { address: string; loc: LatLng } | null;

function fakeDeps(overrides: Partial<PickupFromGpsDeps> = {}, initial: Pickup = null) {
  let pickup: Pickup = initial;
  let onFix: ((loc: LatLng) => void) | null = null;
  const stopWatching = vi.fn(() => {
    onFix = null;
  });
  const deps: PickupFromGpsDeps = {
    pickupIsPending: () => pickup === null || pickup.address === DETECTING,
    pendingLocation: () => (pickup?.address === DETECTING ? pickup.loc : null),
    hasPermission: vi.fn(async () => true),
    lastKnown: vi.fn(async () => null),
    watchFirstFix: vi.fn((cb: (loc: LatLng) => void) => {
      onFix = cb;
      return stopWatching;
    }),
    reverseGeocode: vi.fn(async () => 'Calle Obispo, La Habana Vieja'),
    fill: vi.fn((address: string, loc: LatLng) => {
      pickup = { address, loc };
    }),
    setAddress: vi.fn((address: string) => {
      if (pickup) pickup = { ...pickup, address };
    }),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    deps,
    stopWatching,
    pickup: () => pickup,
    /** The rider choosing a pickup by hand. */
    choosePickup: (address: string, loc: LatLng = HAVANA) => {
      pickup = { address, loc };
    },
    /** A fix reaching the watch, as Android delivers it when the GPS gets one. */
    sendFix: (loc: LatLng) => onFix?.(loc),
  };
}

describe('startPickupFromGps', () => {
  it('fills the pickup from the last known fix', async () => {
    const f = fakeDeps({ lastKnown: vi.fn(async () => HAVANA) });
    startPickupFromGps(f.deps);
    await settle();

    expect(f.pickup()).toEqual({ address: 'Calle Obispo, La Habana Vieja', loc: HAVANA });
    expect(f.deps.watchFirstFix).not.toHaveBeenCalled();
  });

  it('waits for the first fix when the phone has none yet', async () => {
    const f = fakeDeps();
    startPickupFromGps(f.deps);
    await settle();
    expect(f.pickup()).toBeNull();
    expect(f.deps.watchFirstFix).toHaveBeenCalledTimes(1);

    f.sendFix(HAVANA);
    await settle();

    expect(f.pickup()?.address).toBe('Calle Obispo, La Habana Vieja');
    expect(f.stopWatching).toHaveBeenCalled();
  });

  it('finishes a pickup the home screen left at "Detectando dirección..."', async () => {
    const f = fakeDeps({}, { address: DETECTING, loc: HAVANA });
    startPickupFromGps(f.deps);
    await settle();

    expect(f.pickup()).toEqual({ address: 'Calle Obispo, La Habana Vieja', loc: HAVANA });
    // Only the address: setting the whole pickup again would drop the fare
    // estimate the picker already has for that point.
    expect(f.deps.setAddress).toHaveBeenCalledWith('Calle Obispo, La Habana Vieja');
    expect(f.deps.fill).not.toHaveBeenCalled();
    expect(f.deps.hasPermission).not.toHaveBeenCalled();
    expect(f.deps.watchFirstFix).not.toHaveBeenCalled();
  });

  it('does not put the old address on a pending pin the rider dragged', async () => {
    let answer: (address: string | null) => void = () => {};
    const reverseGeocode = vi.fn(
      () => new Promise<string | null>((resolve) => { answer = resolve; }),
    );
    const f = fakeDeps({ reverseGeocode }, { address: DETECTING, loc: HAVANA });
    startPickupFromGps(f.deps);
    await settle();

    // Dragging moves the point at once; its label follows on its own.
    f.choosePickup(DETECTING, { latitude: 23.14301, longitude: -82.38097 });
    answer('Calle Obispo, La Habana Vieja');
    await settle();

    expect(f.deps.setAddress).not.toHaveBeenCalled();
    expect(f.pickup()?.address).toBe(DETECTING);
  });

  it('does nothing when the pickup is already set', async () => {
    const f = fakeDeps({}, { address: 'Hotel Nacional', loc: HAVANA });
    startPickupFromGps(f.deps);
    await settle();

    expect(f.deps.hasPermission).not.toHaveBeenCalled();
    expect(f.deps.reverseGeocode).not.toHaveBeenCalled();
    expect(f.deps.fill).not.toHaveBeenCalled();
  });

  it('uses the coordinates when the address cannot be found', async () => {
    const reverseGeocode = vi.fn(async () => null);
    const f = fakeDeps({ lastKnown: vi.fn(async () => HAVANA), reverseGeocode });
    startPickupFromGps(f.deps);
    await settle();

    expect(reverseGeocode).toHaveBeenCalledTimes(3);
    expect(f.deps.sleep).toHaveBeenCalledTimes(2);
    expect(f.pickup()?.address).toBe('23.13521, -82.35974');
  });

  it('keeps going when one geocode attempt fails', async () => {
    const reverseGeocode = vi
      .fn<(loc: LatLng) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce('Calle 23, Vedado');
    const f = fakeDeps({ lastKnown: vi.fn(async () => HAVANA), reverseGeocode });
    startPickupFromGps(f.deps);
    await settle();

    expect(f.pickup()?.address).toBe('Calle 23, Vedado');
  });

  it('waits for a fix when the last known position cannot be read', async () => {
    const f = fakeDeps({ lastKnown: vi.fn(async () => Promise.reject(new Error('unavailable'))) });
    startPickupFromGps(f.deps);
    await settle();
    expect(f.deps.watchFirstFix).toHaveBeenCalledTimes(1);

    f.sendFix(HAVANA);
    await settle();

    expect(f.pickup()?.loc).toEqual(HAVANA);
  });

  it('does nothing without location permission', async () => {
    const f = fakeDeps({ hasPermission: vi.fn(async () => false) });
    startPickupFromGps(f.deps);
    await settle();

    expect(f.deps.lastKnown).not.toHaveBeenCalled();
    expect(f.deps.watchFirstFix).not.toHaveBeenCalled();
    expect(f.pickup()).toBeNull();
  });

  it('leaves a pickup the rider chose while the GPS was still looking', async () => {
    const f = fakeDeps();
    startPickupFromGps(f.deps);
    await settle();

    f.choosePickup('Hotel Nacional');
    f.sendFix(HAVANA);
    await settle();

    expect(f.pickup()?.address).toBe('Hotel Nacional');
    expect(f.deps.fill).not.toHaveBeenCalled();
  });

  it('leaves a pickup the rider chose while the address was being looked up', async () => {
    let answer: (address: string | null) => void = () => {};
    const reverseGeocode = vi.fn(
      () => new Promise<string | null>((resolve) => { answer = resolve; }),
    );
    const f = fakeDeps({ lastKnown: vi.fn(async () => HAVANA), reverseGeocode });
    startPickupFromGps(f.deps);
    await settle();

    f.choosePickup('Hotel Nacional');
    answer('Calle Obispo, La Habana Vieja');
    await settle();

    expect(f.pickup()?.address).toBe('Hotel Nacional');
    expect(f.deps.fill).not.toHaveBeenCalled();
  });

  it('stops listening when stopped, and ignores a fix that comes after', async () => {
    const f = fakeDeps();
    const stop = startPickupFromGps(f.deps);
    await settle();

    stop();
    expect(f.stopWatching).toHaveBeenCalled();
    f.sendFix(HAVANA);
    await settle();

    expect(f.deps.fill).not.toHaveBeenCalled();
  });

  it('does not start the watch when stopped before it would', async () => {
    const f = fakeDeps();
    const stop = startPickupFromGps(f.deps);
    stop();
    await settle();

    expect(f.deps.watchFirstFix).not.toHaveBeenCalled();
    expect(f.deps.fill).not.toHaveBeenCalled();
  });

  it('stops the watch when the fix arrives while it is being set up', async () => {
    const stopWatching = vi.fn();
    const f = fakeDeps({
      watchFirstFix: vi.fn((cb: (loc: LatLng) => void) => {
        cb(HAVANA);
        return stopWatching;
      }),
    });
    startPickupFromGps(f.deps);
    await settle();

    expect(stopWatching).toHaveBeenCalled();
    expect(f.pickup()?.loc).toEqual(HAVANA);
  });
});
