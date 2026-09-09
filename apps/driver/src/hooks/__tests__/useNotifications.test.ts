import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every native module is mocked with a factory so the real React Native
// runtime is never loaded — mirrors src/services/__tests__.
const permissions = { status: 'undetermined' as string, canAskAgain: true };
const requestPermissionsAsync = vi.fn(async () => ({ ...permissions }));
const getPermissionsAsync = vi.fn(async () => ({ ...permissions }));
const getExpoPushTokenAsync = vi.fn(async () => ({ data: 'ExponentPushToken[test]' }));
const setNotificationChannelAsync = vi.fn(async () => undefined);

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => getPermissionsAsync(...(a as [])),
  requestPermissionsAsync: (...a: unknown[]) => requestPermissionsAsync(...(a as [])),
  getExpoPushTokenAsync: (...a: unknown[]) => getExpoPushTokenAsync(...(a as [])),
  setNotificationChannelAsync: (...a: unknown[]) => setNotificationChannelAsync(...(a as [])),
  setNotificationHandler: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponseAsync: vi.fn(async () => null),
  setBadgeCountAsync: vi.fn(async () => undefined),
  AndroidImportance: { HIGH: 4 },
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

const registerPushToken = vi.fn(async () => undefined);
const recordPushRegistration = vi.fn(async () => undefined);
vi.mock('@tricigo/api', () => ({
  notificationService: {
    registerPushToken: (...a: unknown[]) => registerPushToken(...(a as [])),
    removePushToken: vi.fn(async () => undefined),
    recordPushRegistration: (...a: unknown[]) => recordPushRegistration(...(a as [])),
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

vi.mock('expo-router', () => ({ router: { push: vi.fn(), replace: vi.fn() } }));

import { registerPushTokenForUser } from '../useNotifications';

describe('registerPushTokenForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.status = 'undetermined';
    permissions.canAskAgain = true;
  });

  // The regression this guards: the OS permission dialog used to fire from
  // the root provider seconds after login, before the driver had seen a
  // single ride offer. Android 13+ shows it exactly once per install, so
  // those denials were permanent — two thirds of approved drivers ended up
  // unreachable by push. Any unattended caller must stay silent.
  it('does NOT prompt when permission is undetermined and promptIfNeeded is unset', async () => {
    const result = await registerPushTokenForUser('user-1');

    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toBe('denied');
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  it('prompts only when the caller explicitly opts in', async () => {
    permissions.status = 'undetermined';
    requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: false });

    const result = await registerPushTokenForUser('user-1', { promptIfNeeded: true });

    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(result).toBe('registered');
    expect(registerPushToken).toHaveBeenCalledWith('user-1', 'ExponentPushToken[test]', 'android');
  });

  it('registers without prompting when permission was already granted', async () => {
    permissions.status = 'granted';

    const result = await registerPushTokenForUser('user-1');

    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(result).toBe('registered');
    expect(registerPushToken).toHaveBeenCalledTimes(1);
  });

  it('reports denied — without registering — when the user refuses the prompt', async () => {
    permissions.status = 'undetermined';
    requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });

    const result = await registerPushTokenForUser('user-1', { promptIfNeeded: true });

    expect(result).toBe('denied');
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  // The Android channel must exist before any gate: a device whose 'rides'
  // channel is missing stays silent even after permission is re-enabled.
  it('creates the Android rides channel even when it will not prompt', async () => {
    await registerPushTokenForUser('user-1');

    expect(setNotificationChannelAsync).toHaveBeenCalledWith('rides', expect.anything());
  });
});

// `user_devices` can only ever record a SUCCESS, so on the server a driver who
// refused the permission, one nobody ever asked, and one whose token minting
// threw are the same thing: no row. 74 % of the people who used TriciGo in the
// last month were in that bucket with no way to tell which. These assertions
// are the whole point of the instrumentation.
describe('registerPushTokenForUser — telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.status = 'undetermined';
    permissions.canAskAgain = true;
  });

  it('reports never_asked when it stays silent rather than burning the prompt', async () => {
    await registerPushTokenForUser('user-1');

    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', app: 'driver', outcome: 'never_asked' }),
    );
  });

  it('reports blocked when the OS will never prompt again', async () => {
    permissions.status = 'denied';
    permissions.canAskAgain = false;

    await registerPushTokenForUser('user-1');

    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'blocked' }),
    );
  });

  it('reports denied when the driver refuses a prompt that could come back', async () => {
    permissions.status = 'denied';

    await registerPushTokenForUser('user-1', { promptIfNeeded: true });

    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied' }),
    );
  });

  it('reports registered once the token is stored', async () => {
    permissions.status = 'granted';

    await registerPushTokenForUser('user-1');

    expect(registerPushToken).toHaveBeenCalled();
    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'registered', platform: 'android' }),
    );
  });

  it('reports error with the reason when minting the token throws', async () => {
    permissions.status = 'granted';
    getExpoPushTokenAsync.mockRejectedValueOnce(new Error('projectId missing'));

    const result = await registerPushTokenForUser('user-1');

    expect(result).toBe('error');
    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'error', detail: 'projectId missing' }),
    );
  });

  it('still registers when the telemetry write itself blows up', async () => {
    // The measurement must never be able to change what it measures.
    permissions.status = 'granted';
    recordPushRegistration.mockImplementationOnce(() => {
      throw new Error('telemetry exploded');
    });

    await expect(registerPushTokenForUser('user-1')).resolves.toBe('registered');
  });
});
