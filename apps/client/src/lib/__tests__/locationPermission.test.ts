import { beforeEach, describe, expect, it, vi } from 'vitest';

// R3-06 (QA round 3, 2026-11-20): the home screen asked for the location
// permission every time it mounted, even with it already granted. Android
// opens and closes its permission activity in half a second, the app counts
// that as leaving and coming back, and the foreground handler ran again.

const getForegroundPermissionsAsync = vi.fn();
const requestForegroundPermissionsAsync = vi.fn();

vi.mock('expo-location', () => ({
  getForegroundPermissionsAsync: (...a: unknown[]) => getForegroundPermissionsAsync(...(a as [])),
  requestForegroundPermissionsAsync: (...a: unknown[]) => requestForegroundPermissionsAsync(...(a as [])),
}));

import { ensureForegroundLocationPermission } from '../locationPermission';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureForegroundLocationPermission', () => {
  it('does not ask again when the permission is already granted', async () => {
    getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await expect(ensureForegroundLocationPermission()).resolves.toBe('granted');
    expect(requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('asks when it has not been granted yet', async () => {
    getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await expect(ensureForegroundLocationPermission()).resolves.toBe('granted');
    expect(requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('reports a denial', async () => {
    getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true });
    requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });

    await expect(ensureForegroundLocationPermission()).resolves.toBe('denied');
  });

  it('still asks when reading the current state fails', async () => {
    getForegroundPermissionsAsync.mockRejectedValue(new Error('boom'));
    requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });

    await expect(ensureForegroundLocationPermission()).resolves.toBe('granted');
  });
});
