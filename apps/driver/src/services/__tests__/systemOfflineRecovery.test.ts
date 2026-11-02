import { describe, it, expect, vi } from 'vitest';
import {
  createSystemOfflineRecovery,
  decideSystemOffline,
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
