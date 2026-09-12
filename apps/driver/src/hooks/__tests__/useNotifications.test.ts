import { describe, it, expect, beforeEach, vi } from 'vitest';

// The hook captures the proxy URL in a module-level const, so it has to exist
// before the module is evaluated. vi.hoisted runs ahead of the import graph.
const PROXY_URL = vi.hoisted(() => {
  const url = 'https://example.test/functions/v1/expo-proxy/';
  process.env.EXPO_PUBLIC_EXPO_TOKEN_PROXY_URL = url;
  return url;
});

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

import { PUSH_TOKEN_MAX_ATTEMPTS } from '@tricigo/utils';
import { registerPushTokenForUser } from '../useNotifications';

/**
 * Run a registration with timers faked, so the retry backoff costs no wall
 * clock. Without this the tests that exhaust the attempts really sleep for the
 * whole budget each.
 */
async function registerWithoutWaiting(userId: string) {
  vi.useFakeTimers();
  try {
    const pending = registerPushTokenForUser(userId);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

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
    // Restore up front, not as cleanup at the end of each test: a failing
    // assertion skips trailing cleanup, and a leaked mockRejectedValue then
    // fails the NEXT test for a reason that has nothing to do with it.
    getExpoPushTokenAsync.mockReset();
    getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[test]' });
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

  it('gives up and reports error when every attempt at minting the token throws', async () => {
    permissions.status = 'granted';
    // mockRejectedValue, not ...Once: with the retry loop a single rejection
    // would be recovered on attempt 2 and this would pass while asserting the
    // opposite of what it claims.
    getExpoPushTokenAsync.mockRejectedValue(
      Object.assign(new Error('403 Forbidden'), { code: 'ERR_NOTIFICATIONS_SERVER_ERROR' }),
    );

    const result = await registerWithoutWaiting('user-1');

    expect(result).toBe('error');
    // +1: after the direct attempts are exhausted it tries the proxy once,
    // which the blanket mockRejectedValue also fails.
    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(PUSH_TOKEN_MAX_ATTEMPTS + 1);
    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'error',
        detail: '[ERR_NOTIFICATIONS_SERVER_ERROR] 403 Forbidden',
      }),
    );
  });

  it('recovers when the Expo round-trip fails once and then works', async () => {
    // The Cuban 403 is partial and intermittent — this is the case the retry
    // exists for, and the only one that turns a lost token into a kept one.
    permissions.status = 'granted';
    getExpoPushTokenAsync.mockRejectedValueOnce(
      Object.assign(new Error('403 Forbidden'), { code: 'ERR_NOTIFICATIONS_SERVER_ERROR' }),
    );

    const result = await registerWithoutWaiting('user-1');

    expect(result).toBe('registered');
    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(2);
    expect(registerPushToken).toHaveBeenCalled();
  });

  it('does not waste attempts on a misconfiguration no retry can fix', async () => {
    permissions.status = 'granted';
    getExpoPushTokenAsync.mockRejectedValue(
      Object.assign(new Error('No "projectId" found'), {
        code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
      }),
    );

    const result = await registerPushTokenForUser('user-1');

    expect(result).toBe('error');
    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });

  it('never reports a failed round-trip as denied', async () => {
    // 'denied' makes the settings screen turn the switch off and tell the user
    // to open system Settings — useless, and actively misleading, when the
    // real cause is a network block.
    permissions.status = 'granted';
    getExpoPushTokenAsync.mockRejectedValue(new Error('network down'));

    await expect(registerWithoutWaiting('user-1')).resolves.not.toBe('denied');
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

// The retry from #1000 assumed the Cuban 403 was intermittent. Measured
// 2026-09-12: 9 of the 10 drivers hitting it had NEVER held a token, so it is
// persistent per device/network and no number of attempts helps. These tests
// cover the thing that actually rescues them.
describe('registerPushTokenForUser — proxy fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.status = 'granted';
    permissions.canAskAgain = true;
    getExpoPushTokenAsync.mockReset();
  });

  const cuban403 = () =>
    Object.assign(new Error('403 Forbidden'), { code: 'ERR_NOTIFICATIONS_SERVER_ERROR' });

  it('mints through the proxy once the direct attempts are exhausted', async () => {
    getExpoPushTokenAsync.mockImplementation(async (opts?: { baseUrl?: string }) => {
      if (opts?.baseUrl) return { data: 'ExponentPushToken[viaproxy]' };
      throw cuban403();
    });

    const result = await registerWithoutWaiting('user-1');

    expect(result).toBe('registered');
    expect(registerPushToken).toHaveBeenCalledWith('user-1', 'ExponentPushToken[viaproxy]', 'android');
    // The proxy URL must be handed over verbatim, trailing slash included:
    // getExpoPushTokenAsync concatenates `${baseUrl}push/getExpoPushToken`.
    expect(getExpoPushTokenAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: PROXY_URL }),
    );
  });

  // Without this the rescue is invisible and we cannot tell whether the proxy
  // is doing anything at all once it ships.
  it('records via=proxy so the rescue can be counted', async () => {
    getExpoPushTokenAsync.mockImplementation(async (opts?: { baseUrl?: string }) => {
      if (opts?.baseUrl) return { data: 'ExponentPushToken[viaproxy]' };
      throw cuban403();
    });

    await registerWithoutWaiting('user-1');

    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'registered', detail: 'via=proxy' }),
    );
  });

  it('leaves the happy path untouched — no proxy call, no lost auto-refresh', async () => {
    // Passing baseUrl makes expo-notifications skip its device-token refresh
    // loop. Anyone for whom Expo works directly must never pay that price.
    getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[direct]' });

    const result = await registerPushTokenForUser('user-1');

    expect(result).toBe('registered');
    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    expect(getExpoPushTokenAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: expect.anything() }),
    );
    expect(recordPushRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'registered', detail: 'via=direct' }),
    );
  });

  it('still reports error — never denied — when the proxy fails too', async () => {
    // 'denied' makes the settings screen turn the switch off and send the user
    // to system Settings, where there is nothing to fix.
    getExpoPushTokenAsync.mockRejectedValue(cuban403());

    const result = await registerWithoutWaiting('user-1');

    expect(result).toBe('error');
    expect(registerPushToken).not.toHaveBeenCalled();
  });

  it('does not waste a proxy round trip on a misconfiguration', async () => {
    getExpoPushTokenAsync.mockRejectedValue(
      Object.assign(new Error('No "projectId" found'), {
        code: 'ERR_NOTIFICATIONS_NO_EXPERIENCE_ID',
      }),
    );

    const result = await registerPushTokenForUser('user-1');

    expect(result).toBe('error');
    expect(getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });
});
