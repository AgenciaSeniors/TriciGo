import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { getSupabaseClient, notificationService } from '@tricigo/api';

// NOTE: this module deliberately no longer calls setNotificationHandler.
//
// It used to, and because `setNotificationHandler` REPLACES the global
// handler rather than adding one, the last module evaluated won. The
// root layout imports `@/providers/app-providers` (which pulls in
// hooks/useNotifications) at line 25 and this file at line 38, so THIS
// handler overwrote the one in useNotifications — and this one only
// gated `ride_offer_launch`. It consulted neither the master
// notifications toggle nor the per-category preferences, so foreground
// presentation ignored every notification setting the user had chosen.
//
// The single handler now lives in `src/hooks/useNotifications.ts`, which
// is always loaded: `app-providers.tsx` mounts `useNotificationSetup()`
// at the app root. Keep it that way — do not reintroduce a handler here,
// or the preferences silently stop being enforced again.

/**
 * `promptIfNeeded` gates the OS permission dialog and defaults to FALSE.
 * Android 13+ shows the POST_NOTIFICATIONS dialog exactly once per install:
 * a denial there is permanent, recoverable only through system Settings.
 * The root layout calls this on mount with no session of any kind, so the
 * dialog used to fire the first time the app was ever opened — before the
 * passenger had signed up or seen a single screen — and three quarters of
 * them denied it for good. Only a caller that has already explained the
 * value (the soft-ask sheet, the settings toggle) may pass true; everyone
 * else registers the token when permission happens to be granted already.
 */
export async function registerForPushNotifications(
  opts?: { promptIfNeeded?: boolean },
): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn('Push notifications require a physical device');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    // Never burn the one-shot OS prompt from an unattended code path.
    if (!opts?.promptIfNeeded) return null;
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  if (Platform.OS === 'android') {
    // `sound: null` means "use the default ringtone for this channel".
    // expo-notifications' types want `boolean | 'default' | string`, so
    // omit the key to get the same behavior without the type mismatch.
    await Notifications.setNotificationChannelAsync('rides', {
      name: 'Ride updates',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  try {
    // Pass projectId explicitly so token minting never relies on
    // autodetect (can break in bare/prebuild dev-client contexts).
    const token = (await Notifications.getExpoPushTokenAsync({
      projectId: Constants.expoConfig?.extra?.eas?.projectId,
    })).data;
    // Save to user_devices table via notificationService
    const supabase = getSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await notificationService.registerPushToken(user.id, token, Platform.OS);
    }
    return token;
  } catch (error) {
    console.warn('Failed to get push token:', error);
    return null;
  }
}

export async function scheduleLocalNotification(title: string, body: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      // Omit sound instead of passing null — same muted behavior,
      // satisfies the NotificationContentInput type.
      ...(Platform.OS === 'android' ? { channelId: 'rides' } : {}),
    },
    trigger: null, // immediate
  });
}
