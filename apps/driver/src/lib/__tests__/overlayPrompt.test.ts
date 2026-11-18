import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories run before this file's top-level code, so everything they
// hand out lives in vi.hoisted.
type Button = { text: string; style?: string; onPress?: () => void };
const h = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    platform: { OS: 'android' },
    listeners,
    appState: {
      currentState: 'active',
      addEventListener: (_t: string, l: (state: string) => void) => {
        listeners.add(l);
        return { remove: () => listeners.delete(l) };
      },
    },
    alerts: [] as { title: string; body: string; buttons: Button[] }[],
    store: new Map<string, string>(),
    storageThrows: false,
    granted: false,
    available: true,
    maker: { manufacturer: 'samsung', brand: 'samsung', osVersion: '15' },
    sendIntent: vi.fn(async (..._a: unknown[]) => undefined),
    openSettings: vi.fn(async () => undefined),
    openOverlaySettings: vi.fn(),
    reportStatus: vi.fn(async (..._a: unknown[]) => undefined),
  };
});

vi.mock('react-native', () => ({
  Platform: h.platform,
  AppState: h.appState,
  Alert: {
    alert: (title: string, body: string, buttons: Button[]) => {
      h.alerts.push({ title, body, buttons });
    },
  },
  Linking: {
    sendIntent: (...a: unknown[]) => h.sendIntent(...a),
    openSettings: () => h.openSettings(),
  },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      if (h.storageThrows) throw new Error('storage');
      return h.store.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => {
      if (h.storageThrows) throw new Error('storage');
      h.store.set(k, v);
    },
  },
}));
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../../modules/driver-overlay', () => ({
  default: {
    canDrawOverlays: () => h.granted,
    openOverlaySettings: () => h.openOverlaySettings(),
  },
  get isDriverOverlayAvailable() {
    return h.available;
  },
}));
vi.mock('@/lib/device', () => ({ getDeviceMaker: () => h.maker }));
vi.mock('@/lib/overlayReport', () => ({
  reportOverlayStatus: (...a: unknown[]) => h.reportStatus(...a),
  XIAOMI_OK_KEY: (u: string) => `@tricigo/xiaomi_popup_ok:${u}`,
}));

import { maybePromptOverlay, openXiaomiPermissions } from '../overlayPrompt';

const XIAOMI = { manufacturer: 'Xiaomi', brand: 'Redmi', osVersion: '14' };
function press(alertIndex: number, text: string): void {
  const button = h.alerts[alertIndex]!.buttons.find((b) => b.text === text);
  if (!button) throw new Error(`no button ${text}`);
  button.onPress?.();
}
function fireAppState(state: string): void {
  h.appState.currentState = state;
  for (const l of [...h.listeners]) l(state);
}

describe('maybePromptOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    h.alerts.length = 0;
    h.store.clear();
    h.listeners.clear();
    h.storageThrows = false;
    h.granted = false;
    h.available = true;
    h.platform.OS = 'android';
    h.maker = { manufacturer: 'samsung', brand: 'samsung', osVersion: '15' };
    h.sendIntent.mockReset();
    h.openSettings.mockReset();
    h.openOverlaySettings.mockReset();
    h.reportStatus.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks a driver who said "Ahora no" under the old forever flag', async () => {
    h.store.set('@tricigo/overlay_prompt_shown', '1');
    expect(await maybePromptOverlay('u1')).toBe('overlay');
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]!.title).toBe('driver:overlay.prompt_title');
  });

  it('writes the overlay prompt time when shown, so it is quiet for 3 days', async () => {
    await maybePromptOverlay('u1');
    expect(h.store.get('@tricigo/overlay_prompt_at:u1')).toBe(String(Date.now()));
    expect(await maybePromptOverlay('u1')).toBe('none');
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
    expect(await maybePromptOverlay('u1')).toBe('overlay');
    expect(h.alerts).toHaveLength(2);
  });

  it('"Activar" opens the system screen for "Display over other apps"', async () => {
    await maybePromptOverlay('u1');
    press(0, 'driver:overlay.prompt_enable');
    expect(h.openOverlaySettings).toHaveBeenCalledTimes(1);
  });

  it('asks the Xiaomi step on a granted Xiaomi phone', async () => {
    h.granted = true;
    h.maker = XIAOMI;
    expect(await maybePromptOverlay('u1')).toBe('xiaomi');
    expect(h.alerts[0]!.title).toBe('driver:overlay.xiaomi_title');
    expect(h.store.get('@tricigo/xiaomi_prompt_at:u1')).toBe(String(Date.now()));
  });

  it('"Ya lo activé" stores the flag and reports the status', async () => {
    h.granted = true;
    h.maker = XIAOMI;
    await maybePromptOverlay('u1');
    press(0, 'driver:overlay.xiaomi_done');
    await vi.waitFor(() => expect(h.reportStatus).toHaveBeenCalledWith('u1'));
    expect(h.store.get('@tricigo/xiaomi_popup_ok:u1')).toBe('true');
    expect(await maybePromptOverlay('u1')).toBe('none');
  });

  it('"Abrir permisos" opens the MIUI permission editor for this app', async () => {
    h.granted = true;
    h.maker = XIAOMI;
    await maybePromptOverlay('u1');
    press(0, 'driver:overlay.xiaomi_open');
    await vi.waitFor(() =>
      expect(h.sendIntent).toHaveBeenCalledWith('miui.intent.action.APP_PERM_EDITOR', [
        { key: 'extra_pkgname', value: 'app.tricigo.driver' },
      ]),
    );
  });

  it('"Activar" chains the Xiaomi alert on return when the permission is now granted', async () => {
    h.maker = XIAOMI;
    await maybePromptOverlay('u1');
    press(0, 'driver:overlay.prompt_enable');
    fireAppState('background');
    h.granted = true;
    fireAppState('active');
    await vi.waitFor(() => expect(h.alerts).toHaveLength(2));
    expect(h.alerts[1]!.title).toBe('driver:overlay.xiaomi_title');
    expect(h.reportStatus).toHaveBeenCalledWith('u1');
    expect(h.listeners.size).toBe(0);
  });

  it('"Activar" on a non-Xiaomi phone only reports the new status on return', async () => {
    await maybePromptOverlay('u1');
    press(0, 'driver:overlay.prompt_enable');
    h.granted = true;
    fireAppState('active');
    await vi.waitFor(() => expect(h.reportStatus).toHaveBeenCalledWith('u1'));
    expect(h.alerts).toHaveLength(1);
  });

  it('shows nothing and returns none when storage throws', async () => {
    h.storageThrows = true;
    expect(await maybePromptOverlay('u1')).toBe('none');
    expect(h.alerts).toHaveLength(0);
  });

  it('shows nothing without the native module', async () => {
    h.available = false;
    expect(await maybePromptOverlay('u1')).toBe('none');
    expect(h.alerts).toHaveLength(0);
  });

  it('shows nothing on iOS', async () => {
    h.platform.OS = 'ios';
    expect(await maybePromptOverlay('u1')).toBe('none');
    expect(h.alerts).toHaveLength(0);
  });
});

describe('openXiaomiPermissions', () => {
  beforeEach(() => {
    h.sendIntent.mockReset();
    h.openSettings.mockReset();
  });

  it('opens the system app page when the MIUI intent is rejected', async () => {
    h.sendIntent.mockRejectedValueOnce(new Error('no activity'));
    await openXiaomiPermissions();
    expect(h.openSettings).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when both fail', async () => {
    h.sendIntent.mockRejectedValueOnce(new Error('no activity'));
    h.openSettings.mockRejectedValueOnce(new Error('no settings'));
    await expect(openXiaomiPermissions()).resolves.toBeUndefined();
  });
});
