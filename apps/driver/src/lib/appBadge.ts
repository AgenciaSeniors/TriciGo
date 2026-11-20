import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Clear the app icon badge without touching the notifications themselves.
 *
 * Android: expo-notifications 55.0.18 turns setBadgeCountAsync(0) into
 * NotificationManager.cancelAll() (BadgeHelper.kt), so calling it every time
 * the app came to the front wiped the driver's notifications, offers included
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
