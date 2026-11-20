import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Clear the app icon badge without touching the notifications themselves.
 *
 * Android: expo-notifications 55.0.18 turns setBadgeCountAsync(0) into
 * NotificationManager.cancelAll() (BadgeHelper.kt), so calling it every time
 * the app came to the front wiped the notifications the rider had not seen yet
 * (QA R3-06). Android launchers draw the badge from the notifications, so
 * there is nothing to clear there. iOS 16+ clears only the number.
 */
export async function clearAppBadge(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    // A badge that stays on is not worth an error.
  }
}

/**
 * Android: create the high-importance 'rides' channel the server and the local
 * ride notifications use. Needs no permission and is idempotent, so it runs
 * before any permission check: when the rider granted notifications during
 * the session, the channel did not exist until the next cold start and ride
 * notifications fell back to "Miscellaneous" (QA R3-07). Mirrors the driver's
 * ensureAndroidRidesChannel (apps/driver/src/hooks/useNotifications.ts).
 */
export async function ensureAndroidRidesChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // `sound` omitted on purpose: it means "the channel's default ringtone".
  await Notifications.setNotificationChannelAsync('rides', {
    name: 'Viajes',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });
}
