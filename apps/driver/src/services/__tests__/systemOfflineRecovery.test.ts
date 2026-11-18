import { describe, it, expect, vi } from 'vitest';
import {
  createSystemOfflineRecovery,
  decideSystemOffline,
  internetCameBack,
  serverRowNeedsRecovery,
  BACKGROUND_RECONNECT_ATTEMPTS,
  BACKGROUND_RECONNECT_MAX_AGE_MS,
  type RecoveryDeps,
  type ServerOnlineState,
} from '../systemOfflineRecovery';

const ONLINE: ServerOnlineState = { is_online: true, auto_offline_at: null };
const BY_PERSON: ServerOnlineState = { is_online: false, auto_offline_at: null };
const BY_SYSTEM: ServerOnlineState = { is_online: false, auto_offline_at: '2026-11-01T05:05:00.398625+00:00' };

function deps(over: Partial<RecoveryDeps> = {}): RecoveryDeps & { [K in keyof RecoveryDeps]: ReturnType<typeof vi.fn> } {
  return {
    fetchServerState: vi.fn(async () => BY_SYSTEM),
    isAppActive: vi.fn(() => true),
    isBackgroundServiceRunning: vi.fn(async () => false),
    isOnShift: vi.fn(() => true),
    // 20 min after BY_SYSTEM's drop, on the server's clock.
    nowMs: vi.fn(() => Date.parse(BY_SYSTEM.auto_offline_at as string) + 20 * 60_000),
    blockedReason: vi.fn(async () => null),
    goOnline: vi.fn(async () => {}),
    onReconnected: vi.fn(),
    onShownOffline: vi.fn(),
    ...over,
  } as never;
}

describe('decideSystemOffline', () => {
  const none = new Set<string>();
  it('does nothing while the server has the driver online', () => {
    expect(decideSystemOffline(ONLINE, { appActive: true, attempted: none })).toBe('none');
  });
  it('accepts an offline a person made (the driver elsewhere, an admin, a block)', () => {
    expect(decideSystemOffline(BY_PERSON, { appActive: true, attempted: none })).toBe('show_offline');
  });
  it('reconnects an offline the system made, with the app on screen', () => {
    expect(decideSystemOffline(BY_SYSTEM, { appActive: true, attempted: none })).toBe('reconnect');
  });
  it('waits for the app to come to the foreground', () => {
    expect(decideSystemOffline(BY_SYSTEM, { appActive: false, attempted: none })).toBe('defer');
  });
  it('reconnects in the background while the background service keeps the app alive', () => {
    expect(
      decideSystemOffline(BY_SYSTEM, { appActive: false, backgroundServiceRunning: true, attempted: none }),
    ).toBe('reconnect');
  });
  it('without that service it still waits: a reconnect would be dropped again in 10 min', () => {
    expect(
      decideSystemOffline(BY_SYSTEM, { appActive: false, backgroundServiceRunning: false, attempted: none }),
    ).toBe('defer');
  });
  it('after giving up in the background it waits for the foreground', () => {
    const gaveUp = new Set([BY_SYSTEM.auto_offline_at as string]);
    expect(
      decideSystemOffline(BY_SYSTEM, {
        appActive: false,
        backgroundServiceRunning: true,
        attempted: none,
        backgroundGaveUp: gaveUp,
      }),
    ).toBe('defer');
    expect(
      decideSystemOffline(BY_SYSTEM, { appActive: true, attempted: none, backgroundGaveUp: gaveUp }),
    ).toBe('reconnect');
  });
  it('in the background only within the window: hours later it waits for the driver to open the app', () => {
    const dropMs = Date.parse(BY_SYSTEM.auto_offline_at as string);
    const ctx = { appActive: false, backgroundServiceRunning: true, attempted: none };
    expect(
      decideSystemOffline(BY_SYSTEM, { ...ctx, nowMs: dropMs + BACKGROUND_RECONNECT_MAX_AGE_MS - 1 }),
    ).toBe('reconnect');
    expect(
      decideSystemOffline(BY_SYSTEM, { ...ctx, nowMs: dropMs + BACKGROUND_RECONNECT_MAX_AGE_MS + 1 }),
    ).toBe('defer');
    // On screen there is no limit: the driver is looking.
    expect(
      decideSystemOffline(BY_SYSTEM, {
        appActive: true,
        attempted: none,
        nowMs: dropMs + 10 * BACKGROUND_RECONNECT_MAX_AGE_MS,
      }),
    ).toBe('reconnect');
  });
  it('never reconnects in the background someone a person took offline', () => {
    expect(
      decideSystemOffline(BY_PERSON, { appActive: false, backgroundServiceRunning: true, attempted: none }),
    ).toBe('show_offline');
  });
  it('tries once per drop: if it did not stick, it shows the driver offline', () => {
    const tried = new Set([BY_SYSTEM.auto_offline_at as string]);
    expect(decideSystemOffline(BY_SYSTEM, { appActive: true, attempted: tried })).toBe('show_offline');
  });
});

describe('createSystemOfflineRecovery', () => {
  it('reconnects a zombie driver with the app on screen', async () => {
    const d = deps();
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('reconnect');
    expect(d.goOnline).toHaveBeenCalledTimes(1);
    expect(d.onReconnected).toHaveBeenCalledTimes(1);
    expect(d.onShownOffline).not.toHaveBeenCalled();
  });

  it('uses the state it is given instead of reading it again', async () => {
    const d = deps();
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate(ONLINE)).toBe('none');
    expect(d.fetchServerState).not.toHaveBeenCalled();
    expect(d.goOnline).not.toHaveBeenCalled();
  });

  it('does nothing when the server state cannot be read', async () => {
    const d = deps({ fetchServerState: vi.fn(async () => null) });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('none');
    expect(d.goOnline).not.toHaveBeenCalled();
    expect(d.onShownOffline).not.toHaveBeenCalled();
  });

  it('never reconnects someone a person took offline', async () => {
    const d = deps({ fetchServerState: vi.fn(async () => BY_PERSON) });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('show_offline');
    expect(d.goOnline).not.toHaveBeenCalled();
    expect(d.onShownOffline).toHaveBeenCalledWith('offline', undefined);
  });

  it('in the background it remembers, and reconnects on the next foreground', async () => {
    let active = false;
    const d = deps({ isAppActive: vi.fn(() => active) });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('defer');
    expect(r.hasPending()).toBe(true);
    expect(d.goOnline).not.toHaveBeenCalled();

    active = true;
    expect(await r.evaluate()).toBe('reconnect');
    expect(r.hasPending()).toBe(false);
    expect(d.goOnline).toHaveBeenCalledTimes(1);
  });

  it('tries once per drop', async () => {
    const d = deps();
    const r = createSystemOfflineRecovery(d);
    await r.evaluate();
    // The write "succeeded" but the server still has the same drop (a blocked account).
    expect(await r.evaluate()).toBe('show_offline');
    expect(d.goOnline).toHaveBeenCalledTimes(1);

    // A later drop is a new chance.
    const later = { ...BY_SYSTEM, auto_offline_at: '2026-11-01T09:00:00+00:00' };
    expect(await r.evaluate(later)).toBe('reconnect');
    expect(d.goOnline).toHaveBeenCalledTimes(2);
  });

  it('does not reconnect when something the driver must fix is missing', async () => {
    const d = deps({ blockedReason: vi.fn(async () => 'location_permission') });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('show_offline');
    expect(d.goOnline).not.toHaveBeenCalled();
    expect(d.onShownOffline).toHaveBeenCalledWith('blocked', 'location_permission');
  });

  it('shows the driver offline when going online fails', async () => {
    const d = deps({ goOnline: vi.fn(async () => { throw new Error('driver_has_no_active_vehicle_for_online'); }) });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('show_offline');
    expect(d.onReconnected).not.toHaveBeenCalled();
    expect(d.onShownOffline).toHaveBeenCalledWith('failed', 'driver_has_no_active_vehicle_for_online');
  });

  it('the signal comes back with the phone in the pocket: reconnects with no tap', async () => {
    const d = deps({
      isAppActive: vi.fn(() => false),
      isBackgroundServiceRunning: vi.fn(async () => true),
    });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('reconnect');
    expect(d.goOnline).toHaveBeenCalledTimes(1);
    expect(d.onReconnected).toHaveBeenCalledTimes(1);
    expect(r.hasPending()).toBe(false);
  });

  it('only asks about the background service when the app is not on screen', async () => {
    const d = deps();
    const r = createSystemOfflineRecovery(d);
    await r.evaluate();
    expect(d.isBackgroundServiceRunning).not.toHaveBeenCalled();
  });

  it('a failed write in the background keeps the shift and tries again on the next trigger', async () => {
    let fail = true;
    const d = deps({
      isAppActive: vi.fn(() => false),
      isBackgroundServiceRunning: vi.fn(async () => true),
      goOnline: vi.fn(async () => {
        if (fail) throw new Error('Network request failed');
      }),
    });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('defer');
    // The network is flaky right after it comes back: never end the shift for that.
    expect(d.onShownOffline).not.toHaveBeenCalled();
    expect(r.hasPending()).toBe(true);

    fail = false;
    expect(await r.evaluate()).toBe('reconnect');
    expect(d.goOnline).toHaveBeenCalledTimes(2);
    expect(d.onShownOffline).not.toHaveBeenCalled();
  });

  it(`gives up in the background after ${BACKGROUND_RECONNECT_ATTEMPTS} failed writes and waits for the foreground`, async () => {
    let active = false;
    const d = deps({
      isAppActive: vi.fn(() => active),
      isBackgroundServiceRunning: vi.fn(async () => true),
      goOnline: vi.fn(async () => {
        throw new Error('driver_has_no_active_vehicle_for_online');
      }),
    });
    const r = createSystemOfflineRecovery(d);
    for (let i = 0; i < BACKGROUND_RECONNECT_ATTEMPTS; i++) {
      expect(await r.evaluate()).toBe('defer');
    }
    // No more writes while it stays in the background.
    expect(await r.evaluate()).toBe('defer');
    expect(d.goOnline).toHaveBeenCalledTimes(BACKGROUND_RECONNECT_ATTEMPTS);
    expect(d.onShownOffline).not.toHaveBeenCalled();

    // On screen, the existing rule applies: one attempt, then tell the driver.
    active = true;
    expect(await r.evaluate()).toBe('show_offline');
    expect(d.goOnline).toHaveBeenCalledTimes(BACKGROUND_RECONNECT_ATTEMPTS + 1);
    expect(d.onShownOffline).toHaveBeenCalledWith('failed', 'driver_has_no_active_vehicle_for_online');
  });

  it('never reconnects after the driver tapped Desconectar, even with a drop still pending', async () => {
    // The system dropped the driver while the app still showed "En línea" (the
    // store keeps the shift), and he tapped Desconectar: is_online was already
    // false on the server, so auto_offline_at stays. The app's shift decides.
    let active = false;
    let onShift = true;
    const d = deps({ isAppActive: vi.fn(() => active), isOnShift: vi.fn(() => onShift) });
    const r = createSystemOfflineRecovery(d);
    expect(await r.evaluate()).toBe('defer');
    expect(r.hasPending()).toBe(true);

    onShift = false; // Desconectar
    active = true;
    expect(await r.evaluate()).toBe('none');
    expect(r.hasPending()).toBe(false);
    expect(d.goOnline).not.toHaveBeenCalled();
    expect(d.onShownOffline).not.toHaveBeenCalled();
  });

  it('idle() lets the Desconectar toggle wait for a reconnect that is already writing', async () => {
    // The toggle awaits idle() before its own write, so the driver's write
    // always lands after the recovery's and the shift ends where he chose.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const d = deps({ goOnline: vi.fn(() => gate) });
    const r = createSystemOfflineRecovery(d);
    const run = r.evaluate();
    let idle = false;
    const waited = r.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await run;
    await waited;
    expect(idle).toBe(true);
    // Nothing in flight: resolves right away, also after a run that threw.
    await expect(r.idle()).resolves.toBeUndefined();
  });

  it('idle() resolves even when the run in flight failed', async () => {
    const d = deps({ fetchServerState: vi.fn(async () => { throw new Error('boom'); }) });
    const r = createSystemOfflineRecovery(d);
    const run = r.evaluate().catch(() => 'threw');
    await expect(r.idle()).resolves.toBeUndefined();
    await run;
  });

  it('two triggers at once reconnect once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const d = deps({ goOnline: vi.fn(() => gate) });
    const r = createSystemOfflineRecovery(d);
    const a = r.evaluate();
    const b = r.evaluate();
    release();
    await Promise.all([a, b]);
    expect(d.goOnline).toHaveBeenCalledTimes(1);
  });
});

describe('serverRowNeedsRecovery', () => {
  const ON = { id: 'd1', is_online: true, auto_offline_at: null };
  const SYS = { id: 'd1', is_online: false, auto_offline_at: '2026-11-17T22:35:00Z' };
  const PER = { id: 'd1', is_online: false, auto_offline_at: null };

  it('a system drop arriving while the app is on shift (the store kept the shift)', () => {
    expect(
      serverRowNeedsRecovery({ profile: SYS, isOnline: true }, { profile: ON, isOnline: true }, 'd1'),
    ).toBe(true);
  });
  it('an offline that ended the shift (a person did it): the recovery confirms it', () => {
    expect(
      serverRowNeedsRecovery({ profile: PER, isOnline: false }, { profile: ON, isOnline: true }, 'd1'),
    ).toBe(true);
  });
  it('ignores the driver\'s own toggle: same row, only the shift changed', () => {
    expect(
      serverRowNeedsRecovery({ profile: ON, isOnline: false }, { profile: ON, isOnline: true }, 'd1'),
    ).toBe(false);
  });
  it('ignores rows that say online, rows of another driver, and an app that is off shift', () => {
    expect(serverRowNeedsRecovery({ profile: ON, isOnline: true }, { profile: SYS, isOnline: true }, 'd1')).toBe(false);
    expect(serverRowNeedsRecovery({ profile: SYS, isOnline: true }, { profile: ON, isOnline: true }, 'd2')).toBe(false);
    expect(serverRowNeedsRecovery({ profile: SYS, isOnline: false }, { profile: PER, isOnline: false }, 'd1')).toBe(false);
  });
});

describe('internetCameBack', () => {
  const down = { isConnected: false, isInternetReachable: false };
  const noInternet = { isConnected: true, isInternetReachable: false };
  const up = { isConnected: true, isInternetReachable: true };
  const unknown = { isConnected: true, isInternetReachable: null };

  it('fires when the network or the internet comes back', () => {
    expect(internetCameBack(down, up)).toBe(true);
    // Common in Cuba: still on the network, but with no internet. Coming back counts.
    expect(internetCameBack(noInternet, up)).toBe(true);
    expect(internetCameBack(down, unknown)).toBe(true);
  });
  it('does not fire for the first reading or while nothing changed', () => {
    expect(internetCameBack(null, up)).toBe(false);
    expect(internetCameBack(up, up)).toBe(false);
    expect(internetCameBack(unknown, up)).toBe(false);
  });
  it('does not fire when the connection is lost', () => {
    expect(internetCameBack(up, noInternet)).toBe(false);
    expect(internetCameBack(up, down)).toBe(false);
  });
});
