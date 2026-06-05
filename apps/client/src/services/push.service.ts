import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { getSupabaseClient, notificationService } from '@tricigo/api';

// Configure notification behavior. The newer NotificationBehavior
// interface requires shouldShowBanner / shouldShowList too, but we want
// to stay compatible with the older types installed — cast through
// `any` so both shapes compile.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }) as any,
});

export async function registerForPushNotifications(): Promise<string | null> {
  if (!Device.isDevice) {
    console.warn('Push notifications require a physical device');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
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
