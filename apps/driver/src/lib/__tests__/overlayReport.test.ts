import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Native modules, storage and the store are mocked so the React Native runtime
// is never loaded; only the reporting logic is exercised.
// vi.mock factories run before this file's top-level code, so shared state lives in vi.hoisted.
const h = vi.hoisted(() => ({
  platform: { OS: 'android' },
  user: { id: 'u1' } as { id: string } | null,
  store: new Map<string, string>(),
  granted: true,
}));
const reportDriverOverlay = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 'recorded'));

vi.mock('react-native', () => ({ Platform: h.platform }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: { getState: () => ({ user: h.user }) } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async (k: string) => h.store.get(k) ?? null },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.8.0' } } }));
vi.mock('../../../modules/driver-overlay', () => ({
  default: { canDrawOverlays: () => h.granted },
  isDriverOverlayAvailable: true,
}));
vi.mock('@/lib/device', () => ({
  getOrCreateDeviceId: async () => 'install-1',
  getDeviceMaker: () => ({ manufacturer: 'Xiaomi', brand: 'Redmi', osVersion: '14' }),
}));
vi.mock('@tricigo/api', () => ({
  deviceService: { reportDriverOverlay: (...a: unknown[]) => reportDriverOverlay(...a) },
}));

import {
  XIAOMI_OK_KEY,
  reportOverlayLaunch,
  reportOverlayStatus,
  resetOverlayReportsForTests,
} from '../overlayReport';

const HOUR = 60 * 60 * 1000;

describe('overlay reports (driver)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
    resetOverlayReportsForTests();
    reportDriverOverlay.mockReset();
    reportDriverOverlay.mockResolvedValue('recorded');
    h.store.clear();
    h.user = { id: 'u1' };
    h.granted = true;
    h.platform.OS = 'android';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the per-user Xiaomi key', () => {
    expect(XIAOMI_OK_KEY('u1')).toBe('@tricigo/xiaomi_popup_ok:u1');
  });

  it('sends nothing when no driver is signed in', async () => {
    h.user = null;
    await reportOverlayLaunch('foreground');
    expect(reportDriverOverlay).not.toHaveBeenCalled();
  });

  it('sends nothing on iOS, where the app cannot open itself', async () => {
    h.platform.OS = 'ios';
    await reportOverlayLaunch('foreground');
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).not.toHaveBeenCalled();
  });

  it('sends the launch result with the status fields', async () => {
    h.store.set('@tricigo/xiaomi_popup_ok:u1', 'true');
    await reportOverlayLaunch('foreground');
    expect(reportDriverOverlay).toHaveBeenCalledWith({
      device_id: 'install-1',
      manufacturer: 'Xiaomi',
      brand: 'Redmi',
      os_version: '14',
      app_version: '1.8.0',
      module_available: true,
      overlay_granted: true,
      xiaomi_ok: true,
      launch_result: 'foreground',
    });
  });

  it('stops calling after the server answers unavailable', async () => {
    reportDriverOverlay.mockResolvedValueOnce('unavailable');
    await reportOverlayLaunch('foreground');
    await reportOverlayLaunch('not_foreground');
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown error', async () => {
    reportDriverOverlay.mockRejectedValueOnce(new Error('offline'));
    await expect(reportOverlayLaunch('foreground')).resolves.toBeUndefined();
    await expect(reportOverlayStatus('u1')).resolves.toBeUndefined();
  });

  it('status: sends once, then again only when the grant changes or 6 hours pass', async () => {
    await reportOverlayStatus('u1');
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(1);
    expect(reportDriverOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ launch_result: null }));

    h.granted = false;
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(2);
    expect(reportDriverOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ overlay_granted: false }));

    vi.advanceTimersByTime(6 * HOUR - 1);
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(3);
  });

  it('status: a failed send is retried on the next call', async () => {
    reportDriverOverlay.mockRejectedValueOnce(new Error('offline'));
    await reportOverlayStatus('u1');
    await reportOverlayStatus('u1');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(2);
  });

  it('status: another account on the same phone is its own report', async () => {
    await reportOverlayStatus('u1');
    await reportOverlayStatus('u2');
    expect(reportDriverOverlay).toHaveBeenCalledTimes(2);
  });
});
