import { beforeEach, describe, expect, it, vi } from 'vitest';

// QA round 3 (2026-11-20):
//   R3-06: coming back to the app wiped every notification it had posted.
//          expo-notifications 55.0.18 turns setBadgeCountAsync(0) into
//          NotificationManager.cancelAll() on Android (BadgeHelper.kt).
//   R3-07: the 'rides' channel only existed after the next cold start when
//          the permission was granted mid-session, so ride notifications fell
//          back to "Miscellaneous".

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
const setBadgeCountAsync = vi.fn(async () => true);
const setNotificationChannelAsync = vi.fn(async () => null);

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: (...a: unknown[]) => setBadgeCountAsync(...(a as [])),
  setNotificationChannelAsync: (...a: unknown[]) => setNotificationChannelAsync(...(a as [])),
  AndroidImportance: { HIGH: 4 },
}));

import { clearAppBadge, ensureAndroidRidesChannel } from '../appNotifications';

beforeEach(() => {
  vi.clearAllMocks();
  platform.OS = 'android';
});

describe('clearAppBadge', () => {
  it('leaves the notifications alone on Android', async () => {
    await clearAppBadge();
    expect(setBadgeCountAsync).not.toHaveBeenCalled();
  });

  it('clears the icon badge on iOS', async () => {
    platform.OS = 'ios';
    await clearAppBadge();
    expect(setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  it('never throws when the badge call fails', async () => {
    platform.OS = 'ios';
    setBadgeCountAsync.mockRejectedValueOnce(new Error('no badge'));
    await expect(clearAppBadge()).resolves.toBeUndefined();
  });
});

describe('ensureAndroidRidesChannel', () => {
  it('creates the high-importance rides channel on Android', async () => {
    await ensureAndroidRidesChannel();
    expect(setNotificationChannelAsync).toHaveBeenCalledWith(
      'rides',
      expect.objectContaining({ importance: 4, vibrationPattern: [0, 250, 250, 250] }),
    );
  });

  it('names the channel in Spanish, as Android Settings shows it', async () => {
    await ensureAndroidRidesChannel();
    expect(setNotificationChannelAsync).toHaveBeenCalledWith('rides', expect.objectContaining({ name: 'Viajes' }));
  });

  it('does nothing on iOS', async () => {
    platform.OS = 'ios';
    await ensureAndroidRidesChannel();
    expect(setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
