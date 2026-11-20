import { beforeEach, describe, expect, it, vi } from 'vitest';

// R3-07 (QA round 3, 2026-11-20): the 'rides' channel was only created by
// registerForPushNotifications, which stops before it when there is no
// permission yet. A rider who granted notifications mid-session went through
// registerPushTokenForUser, which never created the channel, so ride
// notifications fell back to "Miscellaneous" until the next cold start.

const permissions = { status: 'undetermined' as string, canAskAgain: true, granted: false };
const setNotificationChannelAsync = vi.fn(async () => null);

vi.mock('expo-notifications', () => ({
  getPermissionsAsync: vi.fn(async () => ({ ...permissions })),
  requestPermissionsAsync: vi.fn(async () => ({ ...permissions })),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[test]' })),
  setNotificationChannelAsync: (...a: unknown[]) => setNotificationChannelAsync(...(a as [])),
  setNotificationHandler: vi.fn(),
  setBadgeCountAsync: vi.fn(async () => true),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponseAsync: vi.fn(async () => null),
  AndroidImportance: { HIGH: 4 },
}));
vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
vi.mock('@tricigo/api', () => ({
  notificationService: {
    registerPushToken: vi.fn(async () => undefined),
    removePushToken: vi.fn(async () => undefined),
    recordPushRegistration: vi.fn(async () => undefined),
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
vi.mock('@/utils/fleetPush', () => ({ fleetUpdateRoute: vi.fn(() => null) }));
vi.mock('@/utils/supportPanel', () => ({ openSupportPanelLink: vi.fn() }));

import { registerPushTokenForUser } from '../useNotifications';

beforeEach(() => {
  vi.clearAllMocks();
  permissions.status = 'undetermined';
  permissions.granted = false;
});

describe('registerPushTokenForUser', () => {
  it('creates the Android rides channel even when it will not prompt', async () => {
    await expect(registerPushTokenForUser('u1')).resolves.toBe('denied');
    expect(setNotificationChannelAsync).toHaveBeenCalledWith('rides', expect.objectContaining({ importance: 4 }));
  });

  it('creates it when the rider grants the permission from the app', async () => {
    permissions.status = 'granted';
    permissions.granted = true;
    await registerPushTokenForUser('u1', { promptIfNeeded: true });
    expect(setNotificationChannelAsync).toHaveBeenCalledWith('rides', expect.anything());
  });
});
