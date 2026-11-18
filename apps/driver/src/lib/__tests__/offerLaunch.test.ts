import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// AppState is a small fake: tests set currentState and fire 'change' events.
// vi.mock factories run before this file's top-level code, so the objects they
// hand out directly live in vi.hoisted. Values read inside callbacks can stay plain.
type Listener = (state: string) => void;
const { appState, platform } = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    platform: { OS: 'android' },
    appState: {
      currentState: 'background',
      listeners,
      addEventListener: (_type: string, l: (state: string) => void) => {
        listeners.add(l);
        return { remove: () => listeners.delete(l) };
      },
    },
  };
});
function fireAppState(state: string): void {
  appState.currentState = state;
  for (const l of [...appState.listeners] as Listener[]) l(state);
}
vi.mock('react-native', () => ({ Platform: platform, AppState: appState }));

let granted = true;
const bring = vi.fn();
vi.mock('../../../modules/driver-overlay', () => ({
  default: { canDrawOverlays: () => granted, bringAppToForeground: () => bring() },
}));

let maker = { manufacturer: 'samsung', brand: 'samsung', osVersion: '15' };
vi.mock('@/lib/device', () => ({ getDeviceMaker: () => maker }));

const reportLaunch = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@/lib/overlayReport', () => ({
  reportOverlayLaunch: (...a: unknown[]) => reportLaunch(...a),
  XIAOMI_OK_KEY: (u: string) => `@tricigo/xiaomi_popup_ok:${u}`,
}));

let user: { id: string } | null = { id: 'u1' };
vi.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: () => ({ user }) } }));

const setItem = vi.fn(async (..._a: unknown[]) => undefined);
const removeItem = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: (...a: unknown[]) => setItem(...a), removeItem: (...a: unknown[]) => removeItem(...a) },
}));

import { attemptOfferLaunch, resetOfferLaunchForTests } from '../offerLaunch';

describe('attemptOfferLaunch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    resetOfferLaunchForTests();
    appState.currentState = 'background';
    appState.listeners.clear();
    platform.OS = 'android';
    granted = true;
    maker = { manufacturer: 'samsung', brand: 'samsung', osVersion: '15' };
    user = { id: 'u1' };
    bring.mockReset();
    reportLaunch.mockClear();
    setItem.mockClear();
    removeItem.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips when the app is already in front', async () => {
    appState.currentState = 'active';
    expect(await attemptOfferLaunch('r1', 'push')).toBe('skipped');
    expect(bring).not.toHaveBeenCalled();
    expect(reportLaunch).not.toHaveBeenCalled();
  });

  it('skips on iOS', async () => {
    platform.OS = 'ios';
    expect(await attemptOfferLaunch('r1', 'push')).toBe('skipped');
    expect(bring).not.toHaveBeenCalled();
  });

  it('reports no_permission without the grant and does not launch', async () => {
    granted = false;
    expect(await attemptOfferLaunch('r1', 'push')).toBe('no_permission');
    expect(bring).not.toHaveBeenCalled();
    expect(reportLaunch).toHaveBeenCalledWith('no_permission');
  });

  it('resolves foreground when AppState turns active within 4 s', async () => {
    const p = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(1500);
    fireAppState('active');
    expect(await p).toBe('foreground');
    expect(bring).toHaveBeenCalledTimes(1);
    expect(reportLaunch).toHaveBeenCalledWith('foreground');
  });

  it('resolves not_foreground after 4 s', async () => {
    const p = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await p).toBe('not_foreground');
    expect(reportLaunch).toHaveBeenCalledWith('not_foreground');
    expect(appState.listeners.size).toBe(0);
  });

  it('launches and reports once when push and realtime fire for the same ride', async () => {
    const push = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    await push;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await attemptOfferLaunch('r1', 'realtime')).toBe('skipped');
    expect(bring).toHaveBeenCalledTimes(1);
    expect(reportLaunch).toHaveBeenCalledTimes(1);
  });

  it('skips the second path even while the first is still watching', async () => {
    const push = attemptOfferLaunch('r1', 'push');
    expect(await attemptOfferLaunch('r1', 'realtime')).toBe('skipped');
    await vi.advanceTimersByTimeAsync(4000);
    await push;
    expect(bring).toHaveBeenCalledTimes(1);
  });

  it('launches again for the same ride after 60 s', async () => {
    const first = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    await first;
    await vi.advanceTimersByTimeAsync(56_000);
    const second = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await second).toBe('not_foreground');
    expect(bring).toHaveBeenCalledTimes(2);
  });

  it('launches for a different ride right away', async () => {
    const first = attemptOfferLaunch('r1', 'push');
    const second = attemptOfferLaunch('r2', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([first, second]);
    expect(bring).toHaveBeenCalledTimes(2);
  });

  it('throttles 3 s when no ride id is known', async () => {
    const first = attemptOfferLaunch(null, 'push');
    expect(await attemptOfferLaunch(null, 'realtime')).toBe('skipped');
    await vi.advanceTimersByTimeAsync(4000);
    await first;
    const third = attemptOfferLaunch(null, 'push');
    await vi.advanceTimersByTimeAsync(4000);
    expect(await third).toBe('not_foreground');
    expect(bring).toHaveBeenCalledTimes(2);
  });

  it('marks the Xiaomi step done after a foreground launch on a Xiaomi phone, before reporting', async () => {
    maker = { manufacturer: 'Xiaomi', brand: 'Redmi', osVersion: '14' };
    const order: string[] = [];
    setItem.mockImplementationOnce(async () => {
      order.push('mark');
    });
    reportLaunch.mockImplementationOnce(async () => {
      order.push('report');
    });
    const p = attemptOfferLaunch('r1', 'push');
    fireAppState('active');
    await p;
    expect(setItem).toHaveBeenCalledWith('@tricigo/xiaomi_popup_ok:u1', 'true');
    expect(order).toEqual(['mark', 'report']);
  });

  it('does not mark the Xiaomi step on other phones', async () => {
    const p = attemptOfferLaunch('r1', 'push');
    fireAppState('active');
    await p;
    expect(setItem).not.toHaveBeenCalled();
  });

  it('never clears the Xiaomi flag on not_foreground', async () => {
    maker = { manufacturer: 'Xiaomi', brand: 'POCO', osVersion: '14' };
    const p = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    await p;
    expect(removeItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('still launches when no driver is signed in', async () => {
    user = null;
    maker = { manufacturer: 'Xiaomi', brand: 'Redmi', osVersion: '14' };
    const p = attemptOfferLaunch('r1', 'push');
    fireAppState('active');
    expect(await p).toBe('foreground');
    expect(bring).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('never throws when the launch call throws', async () => {
    bring.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const p = attemptOfferLaunch('r1', 'push');
    await vi.advanceTimersByTimeAsync(4000);
    await expect(p).resolves.toBe('not_foreground');
  });
});
