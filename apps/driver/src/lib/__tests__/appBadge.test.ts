import { beforeEach, describe, expect, it, vi } from 'vitest';

// R3-06 (QA round 3, 2026-11-20): coming back to the app wiped every
// notification it had posted, ride offers included. expo-notifications
// 55.0.18 turns setBadgeCountAsync(0) into NotificationManager.cancelAll()
// on Android (BadgeHelper.kt).

const platform = vi.hoisted(() => ({ OS: 'android' as string }));
const setBadgeCountAsync = vi.fn(async () => true);

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-notifications', () => ({
  setBadgeCountAsync: (...a: unknown[]) => setBadgeCountAsync(...(a as [])),
}));

import { clearAppBadge } from '../appBadge';

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
