import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Native modules and the store are mocked so the React Native runtime is never
// loaded; only reportAppOpen (the hook's body, lifted out) is exercised.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: vi.fn() }));

const getDeviceInfo = vi.fn(async () => ({
  device_id: 'install-1',
  platform: 'android',
  model: 'Pixel',
  os_version: '15',
  app_version: '1.7.4',
}));
vi.mock('@/lib/device', () => ({ getDeviceInfo: () => getDeviceInfo() }));

const reportAppOpenRpc = vi.fn(async (..._args: unknown[]) => 'recorded');
vi.mock('@tricigo/api', () => ({
  deviceService: { reportAppOpen: (...a: unknown[]) => reportAppOpenRpc(...a) },
}));

import { reportAppOpen, resetAppOpenReportsForTests } from '../useReportAppOpen';

const HOUR = 60 * 60 * 1000;

describe('reportAppOpen (client)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
    resetAppOpenReportsForTests();
    reportAppOpenRpc.mockReset();
    reportAppOpenRpc.mockResolvedValue('recorded');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the client app, this install and its version', async () => {
    await reportAppOpen('u-1');

    expect(reportAppOpenRpc).toHaveBeenCalledTimes(1);
    expect(reportAppOpenRpc).toHaveBeenCalledWith({
      app: 'client',
      device_id: 'install-1',
      app_version: '1.7.4',
      platform: 'android',
    });
  });

  it('does not report again within 6 hours, and does after', async () => {
    await reportAppOpen('u-1');
    vi.setSystemTime(Date.now() + 5 * HOUR);
    await reportAppOpen('u-1');
    expect(reportAppOpenRpc).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1 * HOUR);
    await reportAppOpen('u-1');
    expect(reportAppOpenRpc).toHaveBeenCalledTimes(2);
  });

  it('reports right away for another account', async () => {
    await reportAppOpen('u-1');
    await reportAppOpen('u-2');
    expect(reportAppOpenRpc).toHaveBeenCalledTimes(2);
  });

  it('retries on the next call after a failure, without throwing', async () => {
    reportAppOpenRpc.mockRejectedValueOnce(new Error('network down'));

    await expect(reportAppOpen('u-1')).resolves.toBeUndefined();
    await reportAppOpen('u-1');

    expect(reportAppOpenRpc).toHaveBeenCalledTimes(2);
  });

  it('stops until the app restarts once the server says the function does not exist', async () => {
    reportAppOpenRpc.mockResolvedValueOnce('unavailable');

    await reportAppOpen('u-1');
    vi.setSystemTime(Date.now() + 24 * HOUR);
    await reportAppOpen('u-1');
    await reportAppOpen('u-2');

    expect(reportAppOpenRpc).toHaveBeenCalledTimes(1);
  });
});
